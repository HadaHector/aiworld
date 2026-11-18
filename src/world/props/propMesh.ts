import { Effect, Material, Matrix, Mesh, MultiMaterial, type AbstractMesh, ShaderMaterial, SubMesh, Vector2, Vector3, VertexData, type Scene } from "@babylonjs/core";
import { LIT_SHADING_GLSL, LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS } from "../materials/litShading";
import { DITHER_GLSL, type BuildingMaterial } from "../buildings/buildingMesh";
import { placedAxes } from "../buildings/buildingCollision";
import type { BuildingModel } from "../buildings/buildingTypes";

/*
 * Props' own shader and materials (PROP_RENDERING.md, step 2): a prop is drawn apart from the
 * buildings - one material per building material it uses, its parts of each one sub-mesh - so a
 * prop's material is bound alone rather than held in the buildings' array. For now each material
 * still reads its texture from the buildings' arrays (a layer of them: nothing baked twice); step 4
 * gives the materials only props use textures of their own.
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
uniform sampler2D lightmap;
#endif

// The material: its texture (a layer of an array - negative for a plain colour), metres to a repeat,
// how much it shines, how far it gives its own light, how far the daylight shows through it, and the
// lamp behind it (black for none) - as a building material's.
uniform sampler2DArray colorArray;
uniform sampler2DArray normalArray;
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

void main() {
  if (fadeRange.y > 0.0) {
    float fade = clamp((length(vPositionFromCamera) - fadeRange.x) / max(fadeRange.y - fadeRange.x, 0.001), 0.0, 1.0);
    if (fade > 0.0 && dither4(gl_FragCoord.xy) < fade) discard;
  }
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float side = dot(vNormal, viewDir) < 0.0 ? -1.0 : 1.0;
  vec3 n = normalize(vNormal) * side;
  vec3 albedo = vColor;
  float roughness = 0.85;
  vec3 surfaceNormal = n;
  if (layer >= 0.0) {
    vec3 at = vec3(vUV / size, layer);
    vec4 texel = texture(colorArray, at);
    albedo *= texel.rgb;
    roughness = texel.a;
    vec3 bump = texture(normalArray, at).xyz * 2.0 - 1.0;
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
  vec4 baked = texture(lightmap, vLightUv);
  own = baked.rgb + baked.a * daylightColor;
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

/** The props' materials: one per building material, made when a prop first uses it, and a plain
 *  colour's for parts with none; and each set of them a prop uses together, as one MultiMaterial. */
export interface PropMaterials {
  /** The material a prop's parts of `id` are drawn with (null: plain colour). */
  material: (id: string | null) => ShaderMaterial;
  /** The materials of a prop's sub-meshes, in their order. */
  multi: (ids: readonly (string | null)[]) => MultiMaterial;
}

export function createPropMaterials(scene: Scene, building: BuildingMaterial): PropMaterials {
  Effect.ShadersStore["propVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["propFragmentShader"] = FRAGMENT_SHADER;
  const byId = new Map(building.definitions.map((def, i) => [def.id, { def, layer: i }]));
  const materials = new Map<string, ShaderMaterial>();
  const multis = new Map<string, MultiMaterial>();

  function material(id: string | null): ShaderMaterial {
    const key = id ?? "";
    const known = materials.get(key);
    if (known) return known;
    const found = id === null ? undefined : byId.get(id);
    const shader = new ShaderMaterial(`prop:${id ?? "plain"}`, scene, "prop", {
      attributes: ["position", "normal", "btangent", "uv", "color"],
      uniforms: ["world", "view", "projection", "layer", "size", "shine", "glow", "daylight", "lamp", "fadeRange", ...LIT_SHADING_UNIFORMS],
      samplers: ["colorArray", "normalArray", ...LIT_SHADING_SAMPLERS],
    });
    shader.setTexture("colorArray", building.colorArray);
    shader.setTexture("normalArray", building.normalArray);
    // An unknown id draws as a plain colour, as the building shader draws one (layer -1).
    shader.setFloat("layer", found ? found.layer : -1);
    shader.setVector2("size", new Vector2(found?.def.size[0] ?? 1, found?.def.size[1] ?? 1));
    shader.setFloat("shine", found?.def.shine ?? 0);
    shader.setFloat("glow", found?.def.glow ?? 0);
    shader.setFloat("daylight", found?.def.daylight ?? 0);
    const lamp = found?.def.lamp ?? [0, 0, 0];
    shader.setVector3("lamp", new Vector3(lamp[0], lamp[1], lamp[2]));
    shader.backFaceCulling = true;
    shader.sideOrientation = Material.ClockWiseSideOrientation;
    building.litShading.register(shader);
    // Each mesh's fade, bound as it is drawn (see setMeshFade).
    shader.onBindObservable.add((mesh) => {
      const effect = shader.getEffect();
      if (!effect) return;
      const fade = (mesh.metadata as { fade?: [number, number] } | null)?.fade;
      effect.setFloat2("fadeRange", fade ? fade[0] : 0, fade ? fade[1] : 0);
    });
    materials.set(key, shader);
    return shader;
  }

  function multi(ids: readonly (string | null)[]): MultiMaterial {
    const key = ids.map((id) => id ?? "").join("|");
    const known = multis.get(key);
    if (known) return known;
    const made = new MultiMaterial(`props:${key}`, scene);
    made.subMaterials = ids.map(material);
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
): AbstractMesh {
  let mesh: AbstractMesh;
  if (key === null) mesh = buildPropGeometry(scene, name, model, materials);
  else {
    let source = cache.get(key);
    if (!source || source.isDisposed()) {
      source = buildPropGeometry(scene, `prop:${key}`, model, materials);
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

function buildPropGeometry(scene: Scene, name: string, model: BuildingModel, materials: PropMaterials): Mesh {
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

  const vertices = model.positions.length / 3;
  mesh.subMeshes = [];
  ranges.forEach((range, i) => new SubMesh(i, 0, vertices, range.start, range.count, mesh));
  mesh.material = materials.multi(slots.map((slot) => (slot < 0 ? null : model.materials[slot])));
  // Drawn from the GPU's copy alone, as a building is - its sub-meshes' bounds taken first.
  mesh.geometry?.clearCachedData();
  return mesh;
}
