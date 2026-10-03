import { Effect, Mesh, RawTexture2DArray, ShaderMaterial, Texture, VertexData, type Scene } from "@babylonjs/core";
import { LIT_SHADING_GLSL, LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS, type LitShading } from "../materials/litShading";
import { TEXTURE_RESOLUTION } from "../materials/textureGen";
import { bakeMaterialTextures } from "../materials/textureBakePool";
import type { BuildingMaterialDef, BuildingModel } from "./buildingTypes";

/** How many building materials one shader can draw - the size of its per-material uniform arrays. */
export const MAX_BUILDING_MATERIALS = 32;

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec3 btangent;
in vec2 uv;
in float layer;
in vec4 color;

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

uniform sampler2DArray colorArray;
uniform sampler2DArray normalArray;
// Per material: metres to a repeat (across, up), and how much it shines.
uniform vec2 sizes[${MAX_BUILDING_MATERIALS}];
uniform float shines[${MAX_BUILDING_MATERIALS}];

out vec4 outColor;

void main() {
  // Sheets seen from both sides face the viewer. Judged by the normal, not by which way the
  // triangle happens to be wound: a face's normal is the truth about which way it looks.
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float side = dot(vNormal, viewDir) < 0.0 ? -1.0 : 1.0;
  vec3 n = normalize(vNormal) * side;
  vec3 albedo = vColor;
  float roughness = 0.85;
  float shine = 0.0;
  vec3 surfaceNormal = n;
  if (vLayer >= 0) {
    vec3 at = vec3(vUV / sizes[vLayer], float(vLayer));
    vec4 texel = texture(colorArray, at);
    albedo *= texel.rgb;
    roughness = texel.a;
    shine = shines[vLayer];
    // The texture's own bumps: its u along the face's tangent, its v along normal x tangent.
    vec3 bump = texture(normalArray, at).xyz * 2.0 - 1.0;
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
  vec3 lit = albedo * (diffuse * lightColor * shadow + ambientColor * ambientIntensity)
    + vec3(specular) * lightColor * lightIntensity * shadow
    + sky * fresnel * shine;
  outColor = vec4(applyFog(lit, length(vPositionFromCamera)), 1.0);
}
`;

/** The building materials, baked: colour+roughness and normal+height, one layer each, in the order
 *  of the definitions given. */
export interface BuildingTextures {
  materials: BuildingMaterialDef[];
  colorBuffer: Uint8Array;
  normalBuffer: Uint8Array;
}

/** Bakes building materials' textures - through the same baker, cache and workers as the ground's. */
export async function bakeBuildingTextures(seed: number, materials: BuildingMaterialDef[]): Promise<BuildingTextures> {
  const layerBytes = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;
  const colorBuffer = new Uint8Array(layerBytes * Math.max(1, materials.length));
  const normalBuffer = new Uint8Array(layerBytes * Math.max(1, materials.length));
  await bakeMaterialTextures(
    materials.map((def) => ({ id: `building-${def.id}`, texture: def.texture })),
    seed,
    colorBuffer,
    normalBuffer,
  );
  return { materials, colorBuffer, normalBuffer };
}

/** The shader buildings are drawn with, over baked building materials, and which layer each of
 *  them is. */
export interface BuildingMaterial {
  material: ShaderMaterial;
  layerOf: Map<string, number>;
}

/**
 * Buildings' shader: each face its material's texture - tiled by the material's size, bumped by
 * its normal map, shining as much as it shines - times its tint, lit and shadowed through the
 * shared lighting like everything else. A face with no material is its tint alone.
 */
export function createBuildingMaterial(scene: Scene, litShading: LitShading, textures: BuildingTextures): BuildingMaterial {
  Effect.ShadersStore["texturedBuildingVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["texturedBuildingFragmentShader"] = FRAGMENT_SHADER;
  const { materials } = textures;
  if (materials.length > MAX_BUILDING_MATERIALS) throw new Error(`${materials.length} building materials; at most ${MAX_BUILDING_MATERIALS} fit`);
  const layers = Math.max(1, materials.length);
  const colorArray = RawTexture2DArray.CreateRGBATexture(textures.colorBuffer, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, layers, scene, true, false);
  const normalArray = RawTexture2DArray.CreateRGBATexture(textures.normalBuffer, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, layers, scene, true, false);
  for (const texture of [colorArray, normalArray]) {
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 8;
  }

  const material = new ShaderMaterial("texturedBuilding", scene, "texturedBuilding", {
    attributes: ["position", "normal", "btangent", "uv", "layer", "color"],
    uniforms: ["world", "view", "projection", "sizes", "shines", ...LIT_SHADING_UNIFORMS],
    samplers: ["colorArray", "normalArray", ...LIT_SHADING_SAMPLERS],
  });
  material.setTexture("colorArray", colorArray);
  material.setTexture("normalArray", normalArray);
  const sizes = new Array<number>(MAX_BUILDING_MATERIALS * 2).fill(1);
  const shines = new Array<number>(MAX_BUILDING_MATERIALS).fill(0);
  materials.forEach((def, i) => {
    sizes[i * 2] = def.size[0];
    sizes[i * 2 + 1] = def.size[1];
    shines[i] = def.shine;
  });
  material.setArray2("sizes", sizes);
  material.setFloats("shines", shines);
  material.backFaceCulling = false;
  litShading.register(material);
  return { material, layerOf: new Map(materials.map((def, i) => [def.id, i])) };
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
  indices: number[];
}

export function emptyGeometry(): BuildingGeometry {
  return { positions: [], normals: [], tangents: [], uvs: [], colors: [], layers: [], indices: [] };
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
  for (const index of model.indices) into.indices.push(base + index);
}

/** A mesh of building geometry, drawn with `material`. */
export function createBuildingMesh(scene: Scene, name: string, geometry: BuildingGeometry, material: BuildingMaterial): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = geometry.positions;
  data.normals = geometry.normals;
  data.uvs = geometry.uvs;
  data.colors = geometry.colors;
  data.indices = geometry.indices;
  data.applyToMesh(mesh);
  mesh.setVerticesData("btangent", geometry.tangents, false, 3);
  mesh.setVerticesData("layer", geometry.layers, false, 1);
  mesh.material = material.material;
  mesh.isPickable = false;
  return mesh;
}
