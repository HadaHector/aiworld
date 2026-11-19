import { Effect, Material, Matrix, Mesh, MultiMaterial, RawTexture, type AbstractMesh, type BaseTexture, ShaderMaterial, SubMesh, Vector2, Vector3, VertexData, type Scene } from "@babylonjs/core";
import { LIT_SHADING_GLSL, LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS } from "../materials/litShading";
import { DITHER_GLSL, SURFACE_GLSL, keepsBuildingCpuCopies, type BuildingMaterial } from "../buildings/buildingMesh";
import { placedAxes } from "../buildings/buildingCollision";
import type { BuildingModel } from "../buildings/buildingTypes";

/*
 * Props' own shader and materials (PROP_RENDERING.md, step 2): a prop is drawn apart from the
 * buildings - one material per building material it uses, its parts of each one sub-mesh - so a
 * prop's material is bound alone rather than held in the buildings' array. A material only props are
 * made of (`propsOnly`) has a texture of its own; any other reads its layer of the buildings' array
 * (nothing baked twice).
 *
 * Instanced: a prop's mesh is its model as it was made, in its own space, placed by its world matrix -
 * so every prop of the same prop and variant (a prop has a few, its `variants`) is an instance of one
 * mesh, drawn together.
 */

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec3 btangent;
in vec2 uv;
in vec4 color;
#ifdef INSTANCES
in vec4 world0;
in vec4 world1;
in vec4 world2;
in vec4 world3;
#else
uniform mat4 world;
#endif
#ifdef LIGHTMAP
in vec2 lightUv;
out vec2 vLightUv;
#endif

uniform mat4 view;
uniform mat4 projection;

out vec3 vNormal;
out vec3 vTangent;
out vec2 vUV;
out vec3 vColor;
out vec3 vWorldPosition;
out vec3 vPositionFromCamera;

void main() {
#ifdef INSTANCES
  mat4 finalWorld = mat4(world0, world1, world2, world3);
#else
  mat4 finalWorld = world;
#endif
  vec4 worldPosition = finalWorld * vec4(position, 1.0);
  gl_Position = projection * view * worldPosition;
  vNormal = normalize((finalWorld * vec4(normal, 0.0)).xyz);
  vTangent = normalize((finalWorld * vec4(btangent, 0.0)).xyz);
  vUV = uv;
  vColor = color.rgb;
  vWorldPosition = worldPosition.xyz;
  vPositionFromCamera = (view * worldPosition).xyz;
#ifdef LIGHTMAP
  vLightUv = lightUv;
#endif
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;
${LIT_SHADING_GLSL}

in vec3 vNormal;
in vec3 vTangent;
in vec2 vUV;
in vec3 vColor;
in vec3 vWorldPosition;
in vec3 vPositionFromCamera;
#ifdef LIGHTMAP
in vec2 vLightUv;
// Its model's own lights, baked with the model it stands in (see LIGHTS.md) - off till they are.
uniform sampler2D lightmap;
uniform float lightmapOn;
#endif

// The material: its texture - its own (OWN_TEXTURE: one only props are made of), else a layer of the
// buildings' array (negative for a plain colour) - metres to a repeat, how much it shines, how far it
// gives its own light, how far the daylight shows through it, and the lamp behind it (black for
// none) - as a building material's.
#ifdef OWN_TEXTURE
uniform sampler2D colorTexture;
uniform sampler2D normalTexture;
#else
uniform sampler2DArray colorArray;
uniform sampler2DArray normalArray;
#endif
uniform float layer;
uniform vec2 size;
uniform float shine;
uniform float glow;
uniform float daylight;
uniform vec3 lamp;
// Where it fades out (metres from the camera: begins, gone); (0, 0) never.
uniform vec2 fadeRange;

out vec4 outColor;
${DITHER_GLSL}
${SURFACE_GLSL}

vec4 colorAt(vec2 uv) {
#ifdef OWN_TEXTURE
  return texture(colorTexture, uv);
#else
  return texture(colorArray, vec3(uv, layer));
#endif
}

vec4 surfaceAt(vec2 uv) {
#ifdef OWN_TEXTURE
  return texture(normalTexture, uv);
#else
  return texture(normalArray, vec3(uv, layer));
#endif
}

void main() {
  if (fadeRange.y > 0.0) {
    float fade = clamp((length(vPositionFromCamera) - fadeRange.x) / max(fadeRange.y - fadeRange.x, 0.001), 0.0, 1.0);
    if (fade > 0.0 && dither4(gl_FragCoord.xy) < fade) discard;
  }
#if defined(CUTOUT) && defined(OWN_TEXTURE)
  // Cut out by its mask (the colour's alpha). Mipmapping averages a hole's edge away with distance,
  // so the threshold eases with the mip level - as the leaves' does - or a fringe thins to nothing.
  {
    vec2 uv = vUV / size;
    vec2 texel = uv * vec2(textureSize(colorTexture, 0));
    float lod = max(0.0, 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))));
    if (texture(colorTexture, uv).a * (1.0 + 0.3 * lod) < 0.5) discard;
  }
#endif
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float side = dot(vNormal, viewDir) < 0.0 ? -1.0 : 1.0;
  vec3 n = normalize(vNormal) * side;
  vec3 albedo = vColor;
  float roughness = 0.85;
  vec3 surfaceNormal = n;
  if (layer >= 0.0) {
    vec2 at = vUV / size;
    vec4 texel = colorAt(at);
    vec4 surface = surfaceAt(at);
    albedo *= texel.rgb;
    roughness = surface.b;
    vec3 bump = surfaceBump(surface);
    vec3 t = normalize(vTangent - n * dot(vTangent, n));
    vec3 b = cross(n, t) * side;
    surfaceNormal = normalize(t * bump.x + b * bump.y + n * bump.z);
  }

  vec3 lightDir = normalize(lightDirection);
  float diffuse = max(dot(surfaceNormal, lightDir), 0.0) * lightIntensity;
  float gloss = 1.0 - roughness;
  float shininess = mix(8.0, 600.0, gloss * gloss);
  float ndh = max(dot(surfaceNormal, normalize(viewDir + lightDir)), 0.0);
  float specular = pow(ndh, shininess) * (shininess + 8.0) / 25.13 * shine * max(dot(surfaceNormal, lightDir), 0.0);
  float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(surfaceNormal, viewDir), 0.0), 5.0);
  vec3 sky = ambientColor * ambientIntensity * 1.6 + lightColor * lightIntensity * 0.15;

  float shadow = computeShadow(vWorldPosition, n, vPositionFromCamera.z);
  vec3 daylightColor = ambientColor * ambientIntensity + lightColor * lightIntensity * 0.5;
  vec3 own = vec3(0.0);
#ifdef LIGHTMAP
  if (lightmapOn > 0.5) {
    vec4 baked = texture(lightmap, vLightUv);
    own = baked.rgb + baked.a * daylightColor;
  }
#endif
  vec3 lit = albedo * (diffuse * lightColor * shadow + ambientColor * ambientIntensity + own)
    + vec3(specular) * lightColor * lightIntensity * shadow
    + sky * fresnel * shine;
  lit = mix(lit, albedo, glow);
  lit = mix(lit, albedo * daylightColor, daylight);
  if (lamp != vec3(0.0)) {
    float dark = 1.0 - smoothstep(0.3, 0.65, dot(daylightColor, vec3(0.3, 0.59, 0.11)));
    lit = mix(lit, lamp, dark);
  }
  outColor = vec4(applyFog(lit, length(vPositionFromCamera)), 1.0);
}
`;

/**
 * A cut-out's material: its holes cut out of its sun shadow too. Babylon's shadow pass alpha-tests
 * with whatever texture a material hands it here, which a plain ShaderMaterial never does (the trees'
 * leaf material does the same).
 */
class CutoutMaterial extends ShaderMaterial {
  alphaTexture: BaseTexture | null = null;

  override getAlphaTestTexture(): BaseTexture | null {
    return this.alphaTexture;
  }
}

/** The props' materials: one per building material, made when a prop first uses it, and a plain
 *  colour's for parts with none - each in two kinds, lit only by the world, or also by a lightmap
 *  of its own (`lit`: furniture, a prop with lights); and each set of them a prop uses together, as
 *  one MultiMaterial. */
export interface PropMaterials {
  /** The material a prop's parts of `id` are drawn with (null: plain colour). */
  material: (id: string | null, lit: boolean) => ShaderMaterial;
  /** The materials of a prop's sub-meshes, in their order. */
  multi: (ids: readonly (string | null)[], lit: boolean) => MultiMaterial;
}

/** One set of props' materials for each set of building materials (they share its textures). */
const propMaterialsOf = new WeakMap<BuildingMaterial, PropMaterials>();

/** The props' materials over `building`'s textures - made once for it, shared by all that draw props. */
export function propMaterialsFor(scene: Scene, building: BuildingMaterial): PropMaterials {
  let made = propMaterialsOf.get(building);
  if (!made) propMaterialsOf.set(building, (made = createPropMaterials(scene, building)));
  return made;
}

function createPropMaterials(scene: Scene, building: BuildingMaterial): PropMaterials {
  Effect.ShadersStore["propVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["propFragmentShader"] = FRAGMENT_SHADER;
  const defOf = new Map(building.definitions.map((def) => [def.id, def]));
  const materials = new Map<string, ShaderMaterial>();
  const multis = new Map<string, MultiMaterial>();
  const noLightmap = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene, false);
  noLightmap.name = "noLightmap";

  function material(id: string | null, lit: boolean): ShaderMaterial {
    const key = `${id ?? ""}${lit ? ":lit" : ""}`;
    const known = materials.get(key);
    if (known) return known;
    const def = id === null ? undefined : defOf.get(id);
    // Its texture: its own, for one only props are made of; else its layer of the buildings' array.
    const own = id === null ? undefined : building.ownTextures.get(id);
    const arrayLayer = id === null ? undefined : building.layerOf.get(id);
    const layer = own ? 0 : (arrayLayer ?? -1);
    const cutout = !!own && !!def?.cutout;
    const options = {
      attributes: ["position", "normal", "btangent", "uv", "color", ...(lit ? ["lightUv"] : [])],
      uniforms: ["world", "view", "projection", "layer", "size", "shine", "glow", "daylight", "lamp", "fadeRange", ...(lit ? ["lightmapOn"] : []), ...LIT_SHADING_UNIFORMS],
      samplers: [...(own ? ["colorTexture", "normalTexture"] : ["colorArray", "normalArray"]), ...(lit ? ["lightmap"] : []), ...LIT_SHADING_SAMPLERS],
      defines: [...(lit ? ["LIGHTMAP"] : []), ...(own ? ["OWN_TEXTURE"] : []), ...(cutout ? ["CUTOUT"] : [])],
      needAlphaTesting: cutout,
    };
    const name = `prop:${id ?? "plain"}${lit ? ":lit" : ""}`;
    const shader = cutout ? new CutoutMaterial(name, scene, "prop", options) : new ShaderMaterial(name, scene, "prop", options);
    if (own) {
      shader.setTexture("colorTexture", own.color);
      shader.setTexture("normalTexture", own.normal);
    } else {
      shader.setTexture("colorArray", building.colorArray);
      shader.setTexture("normalArray", building.normalArray);
    }
    // A cut-out's sun shadow is cut by the same mask: Babylon's shadow pass alpha-tests with this
    // texture, through its texture matrix (its repeat).
    if (shader instanceof CutoutMaterial) shader.alphaTexture = own!.color;
    // An unknown id draws as a plain colour, as the building shader draws one (layer -1).
    shader.setFloat("layer", layer);
    shader.setVector2("size", new Vector2(def?.size[0] ?? 1, def?.size[1] ?? 1));
    shader.setFloat("shine", def?.shine ?? 0);
    shader.setFloat("glow", def?.glow ?? 0);
    shader.setFloat("daylight", def?.daylight ?? 0);
    const lamp = def?.lamp ?? [0, 0, 0];
    shader.setVector3("lamp", new Vector3(lamp[0], lamp[1], lamp[2]));
    // A cut-out is a sheet seen from both sides (lit as the side it is seen from - see `side`).
    shader.backFaceCulling = !cutout;
    shader.sideOrientation = Material.ClockWiseSideOrientation;
    building.litShading.register(shader);
    if (lit) shader.setTexture("lightmap", noLightmap);
    // Each mesh's fade (see setMeshFade) and, lit, its lightmap (see applyLightmap), bound as it is drawn.
    shader.onBindObservable.add((mesh) => {
      const effect = shader.getEffect();
      if (!effect) return;
      const metadata = mesh.metadata as { fade?: [number, number]; lightmap?: { texture: RawTexture } } | null;
      const fade = metadata?.fade;
      effect.setFloat2("fadeRange", fade ? fade[0] : 0, fade ? fade[1] : 0);
      if (lit) {
        const map = metadata?.lightmap;
        effect.setFloat("lightmapOn", map ? 1 : 0);
        effect.setTexture("lightmap", map?.texture ?? noLightmap);
      }
    });
    materials.set(key, shader);
    return shader;
  }

  function multi(ids: readonly (string | null)[], lit: boolean): MultiMaterial {
    const key = `${ids.map((id) => id ?? "").join("|")}${lit ? ":lit" : ""}`;
    const known = multis.get(key);
    if (known) return known;
    const made = new MultiMaterial(`props:${key}`, scene);
    made.subMaterials = ids.map((id) => material(id, lit));
    multis.set(key, made);
    return made;
  }

  return { material, multi };
}

/** Each prop's mesh once, by its key (its prop, variant and detail): hidden itself, every one set
 *  down an instance of it. */
export type PropGeometryCache = Map<string, Mesh>;

/**
 * A prop's mesh: its model in its own space, its faces sorted into one sub-mesh per material, placed
 * by its world matrix (its front turned to (frontX, frontZ), tipped to its up, at (x, y, z)). With a
 * `key`, an instance of the one mesh every prop of that key shares (made from the first one's model,
 * kept hidden in `cache`) - one draw for all of them that are shown, per material; without one, a
 * mesh of its own (a wall's stretch).
 */
export function createPropMesh(
  scene: Scene,
  name: string,
  model: BuildingModel,
  placed: { x: number; y: number; z: number; frontX: number; frontZ: number; up?: [number, number, number] },
  materials: PropMaterials,
  key: string | null,
  cache: PropGeometryCache,
  lit = false,
): AbstractMesh {
  let mesh: AbstractMesh;
  // One lit by its own lightmap is never shared: the lightmap is laid on its own vertices.
  if (key === null || lit) mesh = buildPropGeometry(scene, name, model, materials, lit);
  else {
    let source = cache.get(key);
    if (!source || source.isDisposed()) {
      source = buildPropGeometry(scene, `prop:${key}`, model, materials, false);
      // Never drawn itself - only its instances are.
      source.isVisible = false;
      source.isPickable = false;
      cache.set(key, source);
    }
    mesh = source.createInstance(name);
  }
  const a = placedAxes(placed);
  // Babylon's matrices take a row vector: a point's x, y and z run along the model's axes as placed.
  const world = Matrix.FromValues(a.x.x, a.x.y, a.x.z, 0, a.y.x, a.y.y, a.y.z, 0, a.z.x, a.z.y, a.z.z, 0, placed.x, placed.y, placed.z, 1);
  mesh.freezeWorldMatrix(world, true);
  mesh.isPickable = false;
  return mesh;
}

function buildPropGeometry(scene: Scene, name: string, model: BuildingModel, materials: PropMaterials, lit: boolean): Mesh {
  // The faces by what they are made of: a face is its first corner's material.
  const bySlot = new Map<number, number[]>();
  const I = model.indices;
  for (let t = 0; t < I.length; t += 3) {
    const slot = model.materialSlots[I[t]];
    let list = bySlot.get(slot);
    if (!list) bySlot.set(slot, (list = []));
    list.push(I[t], I[t + 1], I[t + 2]);
  }
  const slots = [...bySlot.keys()].sort((p, q) => p - q);
  const indices = new Uint32Array(I.length);
  const ranges: { start: number; count: number }[] = [];
  let at = 0;
  for (const slot of slots) {
    const list = bySlot.get(slot)!;
    indices.set(list, at);
    ranges.push({ start: at, count: list.length });
    at += list.length;
  }

  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = new Float32Array(model.positions);
  data.normals = new Float32Array(model.normals);
  data.uvs = new Float32Array(model.uvs);
  data.colors = new Float32Array(model.colors);
  data.indices = indices;
  data.applyToMesh(mesh);
  mesh.setVerticesData("btangent", new Float32Array(model.tangents), false, 3);
  // Where on its lightmap each vertex is - nowhere till its light is baked (see applyLightmap).
  if (lit) mesh.setVerticesData("lightUv", new Float32Array((model.positions.length / 3) * 2), false, 2);

  const vertices = model.positions.length / 3;
  mesh.subMeshes = [];
  ranges.forEach((range, i) => new SubMesh(i, 0, vertices, range.start, range.count, mesh));
  mesh.material = materials.multi(slots.map((slot) => (slot < 0 ? null : model.materials[slot])), lit);
  // Drawn from the GPU's copy alone, as a building is - its sub-meshes' bounds taken first (the
  // workbench's shots keep it, to read back).
  if (!keepsBuildingCpuCopies()) mesh.geometry?.clearCachedData();
  return mesh;
}
