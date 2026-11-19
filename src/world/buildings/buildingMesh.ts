import { Constants, Effect, InstancedMesh, Material, Mesh, type AbstractMesh, RawTexture, RawTexture2DArray, ShaderMaterial, Texture, VertexData, type Scene } from "@babylonjs/core";
import { LIT_SHADING_GLSL, LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS, type LitShading } from "../materials/litShading";
import { TEXTURE_RESOLUTION } from "../materials/textureGen";
import { bakeMaterialTextures } from "../materials/textureBakePool";
import type { BuildingMaterialDef, BuildingModel } from "./buildingTypes";
import { halfTexels, type Lightmap } from "../lighting/lightBake";

/** How many building materials one shader can draw - the size of its per-material uniform arrays. */
export const MAX_BUILDING_MATERIALS = 32;

/** A 4x4 ordered dither: each pixel's threshold, 0-1, so a fade drops an even pattern of them - for
 *  a fragment shader's `fadeRange` (see PROP_RENDERING.md). */
export const DITHER_GLSL = `
float dither4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i.x + i.y * 4] + 0.5) / 16.0;
}
`;

/** Reads a building or prop material's normal texture, laid out as a surface (see textureGen.ts's
 *  TextureLayout): its bump, and its roughness in blue. */
export const SURFACE_GLSL = `
// A surface texture (PROP_RENDERING.md: the "surface" layout): the normal's x and y in red and
// green, z rebuilt from them; roughness in blue; height in alpha.
vec3 surfaceBump(vec4 surface) {
  vec2 xy = surface.xy * 2.0 - 1.0;
  return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}
`;

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec3 btangent;
in vec2 uv;
in float layer;
in vec4 color;
in vec2 lightUv;

uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;

out vec3 vNormal;
out vec3 vTangent;
out vec2 vUV;
flat out int vLayer;
out vec3 vColor;
out vec3 vWorldPosition;
out vec3 vPositionFromCamera;
out vec2 vLightUv;

void main() {
  vec4 worldPosition = world * vec4(position, 1.0);
  gl_Position = projection * view * worldPosition;
  vNormal = normalize((world * vec4(normal, 0.0)).xyz);
  vTangent = normalize((world * vec4(btangent, 0.0)).xyz);
  vUV = uv;
  vLayer = int(floor(layer + 0.5));
  vColor = color.rgb;
  vWorldPosition = worldPosition.xyz;
  vPositionFromCamera = (view * worldPosition).xyz;
  vLightUv = lightUv;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;
${LIT_SHADING_GLSL}

in vec3 vNormal;
in vec3 vTangent;
in vec2 vUV;
flat in int vLayer;
in vec3 vColor;
in vec3 vWorldPosition;
in vec3 vPositionFromCamera;
in vec2 vLightUv;

uniform sampler2DArray colorArray;
uniform sampler2DArray normalArray;
// Per material: metres to a repeat (across, up), and how much it shines.
uniform vec2 sizes[${MAX_BUILDING_MATERIALS}];
uniform float shines[${MAX_BUILDING_MATERIALS}];
// Per material: how far it gives its own light (a flame) rather than taking the scene's.
uniform float glows[${MAX_BUILDING_MATERIALS}];
// Per material: how far it is drawn with the daylight through it (a pane seen from inside).
uniform float daylights[${MAX_BUILDING_MATERIALS}];
// Per material: the lamp it glows with as the day fails (a lit window seen from outside), or black.
uniform vec3 lamps[${MAX_BUILDING_MATERIALS}];
// The house's own lights, baked (see LIGHTS.md): their light in their colours, and the strength of
// the daylight its windows let in - lit by the sky as it is now. Off for a mesh with none.
uniform sampler2D lightmap;
uniform float lightmapOn;
// Where it fades out (metres from the camera: begins, gone) - a prop as small as it is drawn near
// (see PROP_RENDERING.md); (0, 0) for a mesh that never fades.
uniform vec2 fadeRange;

out vec4 outColor;
${DITHER_GLSL}
${SURFACE_GLSL}

void main() {
  // Faded out with distance: dropped pixel by pixel, before anything is sampled. Opaque - nothing
  // blends, nothing is sorted.
  if (fadeRange.y > 0.0) {
    float fade = clamp((length(vPositionFromCamera) - fadeRange.x) / max(fadeRange.y - fadeRange.x, 0.001), 0.0, 1.0);
    if (fade > 0.0 && dither4(gl_FragCoord.xy) < fade) discard;
  }
  // Sheets seen from both sides face the viewer. Judged by the normal, not by which way the
  // triangle happens to be wound: a face's normal is the truth about which way it looks.
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float side = dot(vNormal, viewDir) < 0.0 ? -1.0 : 1.0;
  vec3 n = normalize(vNormal) * side;
  vec3 albedo = vColor;
  float roughness = 0.85;
  float shine = 0.0;
  float glow = 0.0;
  float through = 0.0;
  vec3 lamp = vec3(0.0);
  vec3 surfaceNormal = n;
  if (vLayer >= 0) {
    vec3 at = vec3(vUV / sizes[vLayer], float(vLayer));
    vec4 texel = texture(colorArray, at);
    vec4 surface = texture(normalArray, at);
    albedo *= texel.rgb;
    roughness = surface.b;
    shine = shines[vLayer];
    glow = glows[vLayer];
    through = daylights[vLayer];
    lamp = lamps[vLayer];
    // The texture's own bumps: its u along the face's tangent, its v along normal x tangent.
    vec3 bump = surfaceBump(surface);
    vec3 t = normalize(vTangent - n * dot(vTangent, n));
    vec3 b = cross(n, t) * side;
    surfaceNormal = normalize(t * bump.x + b * bump.y + n * bump.z);
  }

  vec3 lightDir = normalize(lightDirection);
  float diffuse = max(dot(surfaceNormal, lightDir), 0.0) * lightIntensity;
  // A highlight as tight as the surface is smooth, and as strong as the material shines; and the
  // sky, mirrored more the flatter the angle (Schlick), for a shiny one - glass reads as glass.
  float gloss = 1.0 - roughness;
  float shininess = mix(8.0, 600.0, gloss * gloss);
  float ndh = max(dot(surfaceNormal, normalize(viewDir + lightDir)), 0.0);
  float specular = pow(ndh, shininess) * (shininess + 8.0) / 25.13 * shine * max(dot(surfaceNormal, lightDir), 0.0);
  float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(surfaceNormal, viewDir), 0.0), 5.0);
  vec3 sky = ambientColor * ambientIntensity * 1.6 + lightColor * lightIntensity * 0.15;

  float shadow = computeShadow(vWorldPosition, n, vPositionFromCamera.z);
  // The daylight through a window: the sky's fill, and some of the sun's or moon's strength (not
  // its direction - it has come in through the glass and spread).
  vec3 daylight = ambientColor * ambientIntensity + lightColor * lightIntensity * 0.5;
  vec3 own = vec3(0.0);
  if (lightmapOn > 0.5) {
    vec4 baked = texture(lightmap, vLightUv);
    own = baked.rgb + baked.a * daylight;
  }
  vec3 lit = albedo * (diffuse * lightColor * shadow + ambientColor * ambientIntensity + own)
    + vec3(specular) * lightColor * lightIntensity * shadow
    + sky * fresnel * shine;
  lit = mix(lit, albedo, glow);
  lit = mix(lit, albedo * daylight, through);
  // A lamp behind it, showing as the daylight it would be drowned in fails: from dusk to dawn, and on
  // a dark enough day.
  if (lamp != vec3(0.0)) {
    float dark = 1.0 - smoothstep(0.3, 0.65, dot(daylight, vec3(0.3, 0.59, 0.11)));
    lit = mix(lit, lamp, dark);
  }
  outColor = vec4(applyFog(lit, length(vPositionFromCamera)), 1.0);
}
`;

/** The building materials, baked: colour+roughness and normal+height, one layer each - those in the
 *  buildings' array first, then those only props are made of (`propsOnly`), each group in the order
 *  of the definitions given; `materials` in that order. */
export interface BuildingTextures {
  materials: BuildingMaterialDef[];
  colorBuffer: Uint8Array;
  normalBuffer: Uint8Array;
  /** Each material's average colour, 0-1, in the same order - what the map draws it as. */
  averageColors: [number, number, number][];
}

/** Bakes building materials' textures - through the same baker, cache and workers as the ground's. */
export async function bakeBuildingTextures(seed: number, given: BuildingMaterialDef[]): Promise<BuildingTextures> {
  const materials = [...given.filter((def) => !def.propsOnly), ...given.filter((def) => def.propsOnly)];
  const layerBytes = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;
  const colorBuffer = new Uint8Array(layerBytes * Math.max(1, materials.length));
  const normalBuffer = new Uint8Array(layerBytes * Math.max(1, materials.length));
  const { averageColors } = await bakeMaterialTextures(
    materials.map((def) => ({ id: `building-${def.id}`, texture: def.texture, layout: "surface" as const })),
    seed,
    colorBuffer,
    normalBuffer,
  );
  return { materials, colorBuffer, normalBuffer, averageColors };
}

/** The shader buildings are drawn with, over baked building materials, and which layer each of
 *  them is. */
export interface BuildingMaterial {
  material: ShaderMaterial;
  layerOf: Map<string, number>;
  /** Whether a building material casts shadow from a house's own lights - a flame or a lit pane
   *  does not: the light comes from inside it. And the same by bake layer. */
  casts: (material: string | null) => boolean;
  castsByLayer: boolean[];
  /** Every material's layer for the light bake (bakeLayerOf): the array's layers, then one more for
   *  each material only props are made of - so a candle's flame, not in the array, still lets its
   *  light through. castsByLayer covers them all. */
  bakeLayerOf: Map<string, number>;
  /** What the props' materials are made from (see props/propMesh.ts): the array, for one in it; a
   *  plain texture of its own, at its textureSize, for one only props are made of. */
  colorArray: RawTexture2DArray;
  normalArray: RawTexture2DArray;
  ownTextures: Map<string, { color: RawTexture; normal: RawTexture }>;
  /** Every building material, in the array or not. */
  definitions: BuildingMaterialDef[];
  litShading: LitShading;
}

/**
 * Buildings' shader: each face its material's texture - tiled by the material's size, bumped by
 * its normal map, shining as much as it shines - times its tint, lit and shadowed through the
 * shared lighting like everything else. A face with no material is its tint alone.
 */
export function createBuildingMaterial(scene: Scene, litShading: LitShading, textures: BuildingTextures): BuildingMaterial {
  Effect.ShadersStore["texturedBuildingVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["texturedBuildingFragmentShader"] = FRAGMENT_SHADER;
  const all = textures.materials;
  // The array holds the buildings' materials; those only props are made of come after, apart.
  const materials = all.filter((def) => !def.propsOnly);
  if (materials.length > MAX_BUILDING_MATERIALS) throw new Error(`${materials.length} building materials (not counting the ${all.length - materials.length} only props are made of); at most ${MAX_BUILDING_MATERIALS} fit`);
  const layers = Math.max(1, materials.length);
  const layerBytes = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;
  const colorArray = RawTexture2DArray.CreateRGBATexture(textures.colorBuffer.subarray(0, layers * layerBytes), TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, layers, scene, true, false);
  const normalArray = RawTexture2DArray.CreateRGBATexture(textures.normalBuffer.subarray(0, layers * layerBytes), TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, layers, scene, true, false);
  colorArray.name = "buildingColors";
  normalArray.name = "buildingNormals";
  for (const texture of [colorArray, normalArray]) {
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 8;
  }

  const material = new ShaderMaterial("texturedBuilding", scene, "texturedBuilding", {
    attributes: ["position", "normal", "btangent", "uv", "layer", "color", "lightUv"],
    uniforms: ["world", "view", "projection", "sizes", "shines", "glows", "daylights", "lamps", "lightmapOn", "fadeRange", ...LIT_SHADING_UNIFORMS],
    samplers: ["colorArray", "normalArray", "lightmap", ...LIT_SHADING_SAMPLERS],
  });
  material.setTexture("colorArray", colorArray);
  material.setTexture("normalArray", normalArray);
  const sizes = new Array<number>(MAX_BUILDING_MATERIALS * 2).fill(1);
  const shines = new Array<number>(MAX_BUILDING_MATERIALS).fill(0);
  const glows = new Array<number>(MAX_BUILDING_MATERIALS).fill(0);
  const daylights = new Array<number>(MAX_BUILDING_MATERIALS).fill(0);
  const lamps = new Array<number>(MAX_BUILDING_MATERIALS * 3).fill(0);
  materials.forEach((def, i) => {
    if (def.lamp) lamps.splice(i * 3, 3, ...def.lamp);
    sizes[i * 2] = def.size[0];
    sizes[i * 2 + 1] = def.size[1];
    shines[i] = def.shine;
    glows[i] = def.glow;
    daylights[i] = def.daylight;
  });
  material.setArray2("sizes", sizes);
  material.setFloats("shines", shines);
  material.setFloats("glows", glows);
  material.setFloats("daylights", daylights);
  material.setArray3("lamps", lamps);
  // One side only, the back faces culled: every face is wound counter-clockwise seen from the side it
  // faces (see ModelBuilder.fan) - in the model's own right-handed sense, which Babylon's left-handed
  // view sees as clockwise.
  material.backFaceCulling = true;
  material.sideOrientation = Material.ClockWiseSideOrientation;
  litShading.register(material);
  // Each mesh its own lightmap, bound as it is drawn - one shader for lit and unlit houses alike.
  const none = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene, false);
  none.name = "noLightmap";
  material.setTexture("lightmap", none);
  material.onBindObservable.add((mesh) => {
    const effect = material.getEffect();
    if (!effect) return;
    const metadata = mesh.metadata as { lightmap?: MeshLightmap; fade?: [number, number] } | null;
    const own = metadata?.lightmap;
    effect.setFloat("lightmapOn", own ? 1 : 0);
    effect.setTexture("lightmap", own?.texture ?? none);
    const fade = metadata?.fade;
    effect.setFloat2("fadeRange", fade ? fade[0] : 0, fade ? fade[1] : 0);
  });
  // Each material only props are made of: a plain texture of its own (no array), shrunk to its size.
  const ownTextures = new Map<string, { color: RawTexture; normal: RawTexture }>();
  all.forEach((def, i) => {
    if (!def.propsOnly) return;
    const at = i * layerBytes;
    const size = def.textureSize;
    const make = (buffer: Uint8Array, normal: boolean, name: string): RawTexture => {
      const texels = shrinkTexels(buffer.subarray(at, at + layerBytes), TEXTURE_RESOLUTION, size, normal);
      const texture = RawTexture.CreateRGBATexture(texels, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
      texture.name = name;
      texture.wrapU = Texture.WRAP_ADDRESSMODE;
      texture.wrapV = Texture.WRAP_ADDRESSMODE;
      texture.anisotropicFilteringLevel = 8;
      // Its repeat, for what reads it through its texture matrix (the sun's shadow pass, cutting a
      // cut-out's holes) - the props' shader works its repeat out itself.
      texture.uScale = 1 / def.size[0];
      texture.vScale = 1 / def.size[1];
      return texture;
    };
    ownTextures.set(def.id, { color: make(textures.colorBuffer, false, `propColors:${def.id}`), normal: make(textures.normalBuffer, true, `propNormals:${def.id}`) });
  });
  // What lets a house's own light through: a flame (its light is from inside it), a cut-out (holes).
  const glowing = new Set(all.filter((def) => def.glow > 0 || def.cutout).map((def) => def.id));
  const bakeOrder = [...materials, ...all.filter((def) => def.propsOnly)];
  return {
    material,
    layerOf: new Map(materials.map((def, i) => [def.id, i])),
    casts: (id) => id === null || !glowing.has(id),
    castsByLayer: bakeOrder.map((def) => !glowing.has(def.id)),
    bakeLayerOf: new Map(bakeOrder.map((def, i) => [def.id, i])),
    colorArray,
    normalArray,
    ownTextures,
    definitions: all,
    litShading,
  };
}

/** A square RGBA tile shrunk from `from` to `to` pixels a side by averaging - a surface normal
 *  texture's normals (x, y in red and green, z rebuilt) averaged and set back to unit length, its
 *  roughness (blue) and height (alpha) averaged. Tileable stays tileable. */
function shrinkTexels(texels: Uint8Array, from: number, to: number, normal: boolean): Uint8Array {
  if (to >= from) return texels.slice();
  const step = from / to;
  const out = new Uint8Array(to * to * 4);
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      const sum = [0, 0, 0, 0];
      const vector = [0, 0, 0];
      for (let dy = 0; dy < step; dy++) {
        const row = (y * step + dy) * from;
        for (let dx = 0; dx < step; dx++) {
          const i = (row + x * step + dx) * 4;
          sum[0] += texels[i];
          sum[1] += texels[i + 1];
          sum[2] += texels[i + 2];
          sum[3] += texels[i + 3];
          if (normal) {
            const nx = texels[i] / 127.5 - 1;
            const ny = texels[i + 1] / 127.5 - 1;
            vector[0] += nx;
            vector[1] += ny;
            vector[2] += Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
          }
        }
      }
      const n = step * step;
      const o = (y * to + x) * 4;
      if (normal) {
        const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
        out[o] = Math.round((vector[0] / length + 1) * 127.5);
        out[o + 1] = Math.round((vector[1] / length + 1) * 127.5);
        out[o + 2] = Math.round(sum[2] / n);
      } else for (let c = 0; c < 3; c++) out[o + c] = Math.round(sum[c] / n);
      out[o + 3] = Math.round(sum[3] / n);
    }
  }
  return out;
}

/** Geometry in the form the building shader draws: what BuildingModel holds, with each vertex's
 *  material slot turned into its layer. */
export interface BuildingGeometry {
  positions: number[];
  normals: number[];
  tangents: number[];
  uvs: number[];
  colors: number[];
  layers: number[];
  /** Where on its lightmap each vertex is (see lighting/lightBake.ts) - 0 where it has none. */
  lightUvs: number[];
  indices: number[];
}

export function emptyGeometry(): BuildingGeometry {
  return { positions: [], normals: [], tangents: [], uvs: [], colors: [], layers: [], lightUvs: [], indices: [] };
}

/** A mesh's baked light: its lightmap as a texture. */
interface MeshLightmap {
  texture: RawTexture;
}

/**
 * A baked lightmap laid onto a mesh: its texels as the mesh's lightmap, and - given `uvs`, where a
 * bake came back after the mesh was made - each vertex's place on it. The mesh must be one model's
 * (its vertices the model's, in order).
 */
export function applyLightmap(scene: Scene, mesh: Mesh, baked: { width: number; height: number; half: Uint16Array; uvs?: Float32Array }): void {
  if (baked.uvs) mesh.setVerticesData("lightUv", baked.uvs, false, 2);
  const texture = RawTexture.CreateRGBATexture(baked.half, baked.width, baked.height, scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
  texture.name = "houseLightmap";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  const previous = (mesh.metadata as { lightmap?: MeshLightmap } | null)?.lightmap;
  previous?.texture.dispose();
  const own: MeshLightmap = { texture };
  mesh.metadata = { ...(mesh.metadata ?? {}), lightmap: own };
  if (!previous) mesh.onDisposeObservable.add(() => (mesh.metadata as { lightmap?: MeshLightmap } | null)?.lightmap?.texture.dispose());
}

/** The lightmap `from` has laid on another mesh baked with it (a house's furniture), `uvs` its
 *  vertices' places on it - the same texture, freed with `from`. */
export function shareLightmap(from: Mesh, to: Mesh, uvs: Float32Array): void {
  const own = (from.metadata as { lightmap?: MeshLightmap } | null)?.lightmap;
  if (!own) return;
  to.setVerticesData("lightUv", uvs, false, 2);
  to.metadata = { ...(to.metadata ?? {}), lightmap: own };
}

/** Has a mesh drawn with the building or props' shader fade out from `start` to `end` metres from
 *  the camera (dithered, see PROP_RENDERING.md) - or never, with `null`. An instance fades as its
 *  source does: the fade is set on that, for all of them (they are the same, so the same size). */
export function setMeshFade(mesh: AbstractMesh, fade: { start: number; end: number } | null): void {
  const target = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  target.metadata = { ...(target.metadata ?? {}), fade: fade ? [fade.start, fade.end] : undefined };
}

/**
 * Appends a model to `into`, each vertex moved by `place` (position, then a direction: the same
 * turn without the move) - so many buildings can be merged into one mesh.
 */
export function appendModel(
  into: BuildingGeometry,
  model: BuildingModel,
  layerOf: Map<string, number>,
  place: (x: number, y: number, z: number, direction: boolean) => [number, number, number],
  lightUvs?: Float32Array,
): void {
  const base = into.positions.length / 3;
  const layerOfSlot = model.materials.map((id) => layerOf.get(id) ?? -1);
  const p = model.positions;
  const n = model.normals;
  const t = model.tangents;
  for (let i = 0; i < p.length; i += 3) {
    into.positions.push(...place(p[i], p[i + 1], p[i + 2], false));
    into.normals.push(...place(n[i], n[i + 1], n[i + 2], true));
    into.tangents.push(...place(t[i], t[i + 1], t[i + 2], true));
  }
  for (const value of model.uvs) into.uvs.push(value);
  for (const value of model.colors) into.colors.push(value);
  for (const slot of model.materialSlots) into.layers.push(slot < 0 ? -1 : layerOfSlot[slot]);
  if (lightUvs) for (const value of lightUvs) into.lightUvs.push(value);
  else for (let i = 0; i < p.length / 3; i++) into.lightUvs.push(0, 0);
  for (const index of model.indices) into.indices.push(base + index);
}

/** Whether building meshes keep Babylon's CPU copy of their vertices - only for the workbench's shots
 *  (SHOTS.md), whose report reads them back. */
let keepCpuCopies = false;
export function keepBuildingCpuCopies(keep: boolean): void {
  keepCpuCopies = keep;
}
export function keepsBuildingCpuCopies(): boolean {
  return keepCpuCopies;
}

/** A mesh of building geometry, drawn with `material` - lit by its own baked lights, where it has a
 *  `lightmap` (its geometry laid with that lightmap's `uvs`). */
export function createBuildingMesh(scene: Scene, name: string, geometry: BuildingGeometry, material: BuildingMaterial, lightmap?: Lightmap): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = new Float32Array(geometry.positions);
  data.normals = new Float32Array(geometry.normals);
  data.uvs = new Float32Array(geometry.uvs);
  data.colors = new Float32Array(geometry.colors);
  data.indices = new Uint32Array(geometry.indices);
  data.applyToMesh(mesh);
  mesh.setVerticesData("btangent", new Float32Array(geometry.tangents), false, 3);
  mesh.setVerticesData("layer", new Float32Array(geometry.layers), false, 1);
  mesh.setVerticesData("lightUv", new Float32Array(geometry.lightUvs), false, 2);
  // Drawn from the GPU's copy alone: nothing picks, collides with or reads back a building's mesh,
  // and Babylon's CPU copy of every building's vertices was most of the full world's heap.
  if (!keepCpuCopies) mesh.geometry?.clearCachedData();
  if (lightmap) applyLightmap(scene, mesh, { width: lightmap.width, height: lightmap.height, half: halfTexels(lightmap.texels) });
  mesh.material = material.material;
  mesh.isPickable = false;
  return mesh;
}
