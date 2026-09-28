import { Color3, Constants, Effect, RawTexture, RawTexture2DArray, ShaderMaterial, StandardMaterial, Texture, type Material, type Scene } from "@babylonjs/core";
import type { AreaWeight } from "../cells/areaField";
import type { SunLighting } from "../lighting/sunLighting";
import { LIT_SHADING_GLSL, LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS, createLitShading, type LitShading } from "./litShading";
import { MATERIALS_PER_TRIANGLE, createMaterialBlender, type MaterialBlender } from "./materialBlend";
import type { WorldContent } from "../content/worldContent";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import type { MaterialDef } from "./materialTypes";
import { TEXTURE_RESOLUTION, type TextureDef } from "./textureGen";
import { applyColorMatrix, materialMatrix } from "./colorAdjust";
import { WATER_ALPHA, WATER_DEEP_COLOR, WATER_SHALLOW_COLOR, WATER_TINT_FULL_DEPTH } from "../terrain/ocean";
import { bakeMaterialTextures } from "./textureBakePool";

// World units per texture repeat. The terrain shader derives texture coordinates straight from
// world-space position (see VERTEX_SHADER's vUV) rather than each chunk's own 0..1 mesh UV, so
// this has no divisibility constraint against CHUNK_SIZE any more and no per-chunk UV to keep in
// phase - two chunks agree on a shared boundary vertex's texture coordinate because they compute
// it from the literal same world position, not from two independently-built 0..1 UV spaces that
// merely *should* line up. That was the actual fix for the chunk-border seams this replaced: the
// old per-chunk-UV scheme was tileable in theory (integer uScale) but still exposed real seams in
// practice. 25 spreads each material's baked detail - cracks, ripples, leaf clusters - across a
// bigger stretch of ground before it repeats, so the pattern reads as a large-scale surface
// feature instead of an obviously-tiled close-up texture.
//
// 50 rather than 25 now that textures bake at 1024 instead of 256: at 25/256 a tile was 0.098 world
// units per texel, and 50/1024 is 0.049 - so this spends the extra resolution on BOTH a 2x sharper
// surface and a repeat that comes round half as often. Tiling repetition is the main artifact left
// on large flat ground (the seam itself is gone), and it is purely a function of this number, so
// this is the dial to turn if the pattern still reads as a grid.
const TEXTURE_WORLD_TILE_SIZE = 50;

// The close-up pass samples each material again a material's own `detail.scale` times smaller, and
// turned by this much so its repeat does not line up with the main one's; the broad pass samples it
// this many times larger, heavily blurred, so the main texture's 50 m repeat is shaded by a pattern
// that repeats every few hundred metres instead. Neither costs memory: both are the same texture.
const DETAIL_ROTATION = 0.61;
const BROAD_SCALE = 0.137;
const BROAD_ROTATION = -0.93;
const BROAD_STRENGTH = 0.35;

// Height-based blending between a triangle's materials (see the shader's heightShare): how much a
// material's own surface height (0-1, baked into its normal map's alpha) adds to its weight, and
// how far below the strongest a material may be and still show at all. The depth is the softness:
// smaller makes sharper edges where two materials meet.
const HEIGHT_BLEND = 0.8;
const HEIGHT_BLEND_DEPTH = 0.4;

export { MATERIALS_PER_TRIANGLE } from "./materialBlend";

export interface MaterialLibrary {
  /** The single shader material every terrain chunk uses - blends MATERIALS_PER_TRIANGLE materials
   *  per triangle (see terrainMesh.ts), so no MultiMaterial/SubMesh split is needed any more. */
  terrainMaterial: ShaderMaterial;
  /** Every material's weight at one point, keyed by material index and summing to 1. Every area
   *  with a say there contributes its own base and layers, scaled by that area's share. */
  buildMaterialBlend: (worldX: number, worldZ: number, context: Record<string, number>, areaWeights: AreaWeight[]) => Map<number, number>;
  /** Legacy single-winner resolution (highest-weight layer overall, thresholded) - kept only for
   *  the debug map, which renders one flat color per sample point and has no use for a blend. */
  resolveMaterialIndex: (worldX: number, worldZ: number, context: Record<string, number>, biome: BiomeDefinition) => number;
  /** A representative swatch (the midpoint of its procedural texture's two colors) for a resolved
   *  material index - used by the debug map, which draws to a 2D canvas and has no Babylon
   *  Material/Texture of its own to sample from. */
  getMaterialColor: (materialIndex: number) => Color3;
  /** Every material's average baked colour, by index - what grass roots fade from. */
  averageColors: [number, number, number][];
  /** A biome's own base material's swatch, with no overlay layers evaluated - what the debug
   *  map's coarse World view shows, since resolving overlays isn't worth it at that zoom level. */
  getBiomeBaseColor: (biome: BiomeDefinition) => Color3;
  /** Every deduplicated material's baked color+roughness and normal-map pixels (RGBA,
   *  TEXTURE_RESOLUTION² each), for the texture browser dev tool - views into the same buffers
   *  uploaded to the GPU, not a fresh render. */
  listMaterialTextures: () => MaterialTexturePreview[];
  /** Stops the terrain fragment shader from sampling the shadow map at all - the companion half of
   *  SunLighting.setShadowsEnabled, which stops the map being rendered into in the first place. */
  setShadowsEnabled: (enabled: boolean) => void;
  /** The material on terrain's shadow-only meshes (see terrainMesh.ts). Never drawn: the shadow
   *  generator uses its own depth shader and only reads render state from it - face culling, and
   *  fill mode, which is why it is not terrainMaterial: switching that to wireframe would otherwise
   *  turn the terrain's shadows into wireframe too. */
  shadowCasterMaterial: Material;
  /** Draws the terrain as wireframe - a debug view for judging mesh density and level of detail. */
  setWireframe: (enabled: boolean) => void;
  /** The shared light/shadow/fog feed - other world shaders (grass) register with it to be lit
   *  exactly like the terrain. */
  litShading: LitShading;
  /** Which materials the ground is made of where - also what chunk builds read. */
  blender: MaterialBlender;
}

export interface MaterialTexturePreview {
  id: string;
  name: string;
  colorPixels: Uint8Array;
  normalPixels: Uint8Array;
}

// The shininess a material's roughness (0 smooth - 1 matte) maps into, geometrically - so the
// glossy end, a wet stone, is a tight bright glint and the matte end a broad faint sheen - and the
// strength of the lot. The highlight is energy-normalised Blinn-Phong with a Schlick Fresnel term
// (see the fragment shader), so how bright a highlight is follows from how tight it is, and
// looking towards the sun across a glossy surface brings up a sheen. Roughness is a material's
// own business (its texture's `roughness` output): rock faces, wet stone, sand and grass blades
// are glossy, soil and grit matte.
const SPECULAR_MIN_SHININESS = 6.0;
const SPECULAR_MAX_SHININESS = 400.0;
const SPECULAR_INTENSITY = 1.3;
// How much a fully glossy surface's reflectance rises above a plain dielectric's 4%.
const SPECULAR_GLOSS_REFLECTANCE = 0.35;

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec4 matIndices;
in vec4 matWeights;

uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
uniform float tileScale;

out vec2 vUV;
out vec3 vNormal;
out vec3 vWorldPosition;
// The fragment's position in camera space. Its .z is what picks a shadow cascade (the same
// forward-depth Babylon's own shadow-receiving shaders key cascade selection on, not radial
// distance from the camera) and its length is distance-from-camera for fog - one varying serving
// both, rather than computing either separately in the fragment from vWorldPosition/cameraPosition.
out vec3 vPositionFromCamera;
// Material layer indices for this triangle. Every vertex of a triangle carries the same indices in
// the same order (they are its owner vertex's - see terrainMesh.ts), so flat is not correcting a
// disagreement here; it just avoids interpolating integers that are already identical.
flat out vec4 vMatIndices;
out vec4 vMatWeights;

void main() {
  vec4 worldPosition = world * vec4(position, 1.0);
  gl_Position = projection * view * worldPosition;
  vNormal = normalize((world * vec4(normal, 0.0)).xyz);
  vWorldPosition = worldPosition.xyz;
  vPositionFromCamera = (view * worldPosition).xyz;
  // Texture coordinates come straight from world-space position, not the mesh's own 0..1 UV - see
  // TEXTURE_WORLD_TILE_SIZE's comment for why (this is what makes chunk boundaries seamless).
  vUV = worldPosition.xz * tileScale;
  vMatIndices = matIndices;
  vMatWeights = matWeights;
}
`;

// The vec4 components the fragment shader actually samples - one per blended material.
const materialSlots = ["x", "y", "z", "w"].slice(0, MATERIALS_PER_TRIANGLE);

/**
 * Texels per material in the material table (see materialTable): its texture layer and detail, its
 * texture's average colour, and the three columns of its colour matrix.
 */
const TABLE_WIDTH = 5;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;
${LIT_SHADING_GLSL}

in vec2 vUV;
in vec3 vNormal;
in vec3 vWorldPosition;
in vec3 vPositionFromCamera;
flat in vec4 vMatIndices;
in vec4 vMatWeights;

uniform sampler2DArray materialAtlas;
uniform sampler2DArray normalAtlas;
uniform float waterLevel;
uniform float specularMinShininess;
uniform float specularMaxShininess;
uniform float specularIntensity;
// One row per material, ${TABLE_WIDTH} texels: (texture layer, detail scale, detail strength, -), the
// texture's own average colour, then the colour matrix's three columns. A texture rather than
// uniform arrays so the number of materials is not capped by how many uniforms a GPU has.
uniform highp sampler2D materialTable;

out vec4 outColor;

const mat2 DETAIL_TURN = mat2(${Math.cos(DETAIL_ROTATION).toFixed(5)}, ${Math.sin(DETAIL_ROTATION).toFixed(5)}, ${(-Math.sin(DETAIL_ROTATION)).toFixed(5)}, ${Math.cos(DETAIL_ROTATION).toFixed(5)});
const mat2 BROAD_TURN = mat2(${Math.cos(BROAD_ROTATION).toFixed(5)}, ${Math.sin(BROAD_ROTATION).toFixed(5)}, ${(-Math.sin(BROAD_ROTATION)).toFixed(5)}, ${Math.cos(BROAD_ROTATION).toFixed(5)});

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

/**
 * One material at this pixel. Its texture three times over: as authored; again at the material's
 * detail scale, whose light and dark (relative to the material's average) deepen the authored
 * colour and whose bumps add to the authored ones - so a 1 m feature of the texture turns up again
 * as 14 cm grain; and once more hugely enlarged and blurred, for slow patches of lighter and darker
 * ground that do not repeat with the 50 m tile. Far off, the close-up sample reaches its smallest
 * mip, which is the average colour, and so fades out by itself.
 *
 * Then recoloured by the material's colour matrix (colorAdjust.ts) - the last step, so the detail
 * passes compare the texture with its own average as baked, whatever the material makes of it.
 */
void sampleMaterial(float material, out vec4 color, out vec3 tilt, out float height) {
  int index = int(material + 0.5);
  vec4 entry = texelFetch(materialTable, ivec2(0, index), 0);
  float layer = entry.x;
  vec2 detail = entry.yz;
  float mean = max(luma(texelFetch(materialTable, ivec2(1, index), 0).rgb), 0.03);
  mat3 adjust = mat3(
    texelFetch(materialTable, ivec2(2, index), 0).rgb,
    texelFetch(materialTable, ivec2(3, index), 0).rgb,
    texelFetch(materialTable, ivec2(4, index), 0).rgb
  );

  vec4 base = texture(materialAtlas, vec3(vUV, layer));
  vec4 baseNormal = texture(normalAtlas, vec3(vUV, layer));

  vec2 fineUV = DETAIL_TURN * vUV * detail.x;
  vec3 fine = texture(materialAtlas, vec3(fineUV, layer)).rgb;
  vec3 fineNormal = texture(normalAtlas, vec3(fineUV, layer)).rgb * 2.0 - 1.0;
  float fineShade = mix(1.0, clamp(luma(fine) / mean, 0.35, 1.9), detail.y);

  vec3 broad = texture(materialAtlas, vec3(BROAD_TURN * vUV * ${BROAD_SCALE.toFixed(4)}, layer), 4.0).rgb;
  float broadShade = mix(1.0, clamp(luma(broad) / mean, 0.5, 1.6), ${BROAD_STRENGTH.toFixed(3)});

  color = vec4(max(adjust * (base.rgb * fineShade * broadShade), 0.0), base.a);
  // The close-up normal is in its own turned texture space; turned back, its tilt adds to the
  // authored one's.
  vec3 authored = baseNormal.rgb * 2.0 - 1.0;
  tilt = vec3(authored.xy + (transpose(DETAIL_TURN) * fineNormal.xy) * detail.y, authored.z);
  height = baseNormal.a;
}

/**
 * How much of the pixel a material gets: its weight, raised by how high its own surface stands
 * here, and only materials within HEIGHT_BLEND_DEPTH of the highest take part. So where two meet,
 * the one standing proud wins its high points first - pebbles come through the sand before the
 * sand gives way, leaves lie on the grass rather than fading into it, snow fills the rock's
 * hollows first - instead of the two cross-fading into a smear. A material's height counts for
 * less as its weight falls to nothing, so one that is not really here never shows through.
 */
float heightShare(float weight, float height) {
  return weight + height * ${HEIGHT_BLEND.toFixed(3)} * min(1.0, weight * 6.0);
}

void main() {
  vec3 n = normalize(vNormal);

  ${materialSlots.map((c, i) => `vec4 color${i}; vec3 tilt${i}; float height${i};
  sampleMaterial(vMatIndices.${c}, color${i}, tilt${i}, height${i});
  float share${i} = heightShare(vMatWeights.${c}, height${i});`).join("\n  ")}
  float lowest = max(${materialSlots.map((_, i) => `share${i}`).reduce((a, b) => `max(${a}, ${b})`)}, 0.0) - ${HEIGHT_BLEND_DEPTH.toFixed(3)};
  ${materialSlots.map((_, i) => `float blend${i} = max(share${i} - lowest, 0.0);`).join("\n  ")}
  float total = ${materialSlots.map((_, i) => `blend${i}`).join(" + ")};
  vec4 albedo = (${materialSlots.map((_, i) => `color${i} * blend${i}`).join(" + ")}) / total;
  vec3 tangentNormal = normalize(${materialSlots.map((_, i) => `tilt${i} * blend${i}`).join(" + ")});

  // Screen-space-derivative TBN (no authored per-vertex tangents needed) - standard technique for
  // bump-mapping a surface, like terrain, that never got its own tangent vertex attribute.
  vec3 dp1 = dFdx(vWorldPosition);
  vec3 dp2 = dFdy(vWorldPosition);
  vec2 duv1 = dFdx(vUV);
  vec2 duv2 = dFdy(vUV);
  vec3 dp2perp = cross(dp2, n);
  vec3 dp1perp = cross(n, dp1);
  vec3 tangent = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 bitangent = dp2perp * duv1.y + dp1perp * duv2.y;
  float invMax = inversesqrt(max(dot(tangent, tangent), dot(bitangent, bitangent)));
  mat3 tbn = mat3(tangent * invMax, bitangent * invMax, n);
  vec3 worldNormal = normalize(tbn * tangentNormal);

  vec3 lightDir = normalize(lightDirection);
  float ndl = dot(worldNormal, lightDir) * 0.5 + 0.5;
  float diffuse = ndl * lightIntensity;

  float roughness = albedo.a;
  float gloss = 1.0 - roughness;
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 halfVec = normalize(viewDir + lightDir);
  float ndh = max(dot(worldNormal, halfVec), 0.0);
  float shininess = exp2(mix(log2(specularMaxShininess), log2(specularMinShininess), roughness));
  // Normalised, so a tighter highlight is a brighter one rather than the same light in less area.
  float normalisation = (shininess + 8.0) / 25.13;
  // Schlick Fresnel, rising towards grazing - scaled by gloss, because a matte surface's own
  // roughness shadows the grazing light a glossy one reflects. The base reflectance is not a plain
  // dielectric's 4% but rises with gloss, to about a third on a wet stone: artistic, a sheen of
  // wax on a leaf or of water on a pebble, since at 4% nothing at this scale would ever glint.
  float reflectance = 0.04 + ${SPECULAR_GLOSS_REFLECTANCE.toFixed(3)} * gloss * gloss;
  float fresnel = reflectance + (1.0 - reflectance) * pow(1.0 - max(dot(viewDir, halfVec), 0.0), 5.0) * gloss * gloss;
  float facing = max(dot(worldNormal, lightDir), 0.0);
  float specular = normalisation * pow(ndh, shininess) * fresnel * facing * specularIntensity;

  // Shadow darkens the light itself, not the surface it lands on - a shadowed patch of sand is
  // still sand, just lit by the sky rather than the sun, which is what SHADOW_DARKNESS's floor is
  // standing in for (see computeShadow).
  float shadow = computeShadow(vWorldPosition, worldNormal, vPositionFromCamera.z);
  // Ambient is not shadowed - it is sky-fill, not a beam the sun caster could block, and reaches a
  // shadowed patch exactly as it reaches a lit one. Without this, night terrain (a dim moon,
  // frequently in the 0-intensity instant right at moonrise/moonset) would read as pure black,
  // since - unlike trees and ocean's StandardMaterial, which pick up the scene's HemisphericLight
  // automatically - this shader has no light of its own besides lightColor/lightIntensity.
  vec3 ambient = albedo.rgb * ambientColor * ambientIntensity;
  vec3 lit = albedo.rgb * diffuse * lightColor * shadow + vec3(specular) * lightColor * lightIntensity * shadow + ambient;

  // The water's body colour, painted onto ground below the waterline rather than by the water plane
  // (which can't know how deep the water under a pixel is - see ocean.ts's WATER_ALPHA). Ramps from
  // nothing at the shoreline to full strength at WATER_TINT_FULL_DEPTH, so the edge of the water
  // fades out instead of ending in a hard line.
  float waterDepth = waterLevel - vWorldPosition.y;
  if (waterDepth > 0.0) {
    float sunUp = max(normalize(lightDirection).y, 0.0);
    vec3 waterBody = mix(vec3(${WATER_DEEP_COLOR.map((c) => c.toFixed(3)).join(", ")}), vec3(${WATER_SHALLOW_COLOR.map((c) => c.toFixed(3)).join(", ")}), 0.4 + 0.3 * sunUp);
    vec3 waterLit = waterBody * (ambientColor * ambientIntensity + lightColor * lightIntensity * sunUp * 0.7);
    lit = mix(lit, waterLit, ${WATER_ALPHA.toFixed(3)} * clamp(waterDepth / ${WATER_TINT_FULL_DEPTH.toFixed(3)}, 0.0, 1.0));
  }

  vec3 finalColor = applyFog(lit, length(vPositionFromCamera));
  outColor = vec4(finalColor, 1.0);
}
`;

/** Baked terrain textures: colour+roughness and normal+height pixels, TEXTURE_RESOLUTION² RGBA a
 *  layer, and each layer's own average colour - one layer per distinct texture (terrainTextureLayers). */
export interface TerrainTextures {
  colorBuffer: Uint8Array;
  normalBuffer: Uint8Array;
  layerAverages: [number, number, number][];
}

/** A terrain shader for a list of materials, their textures baked and packed - what the world's
 *  material library is built on, and what the workbench draws a single material with. */
export interface TerrainMaterial {
  terrainMaterial: ShaderMaterial;
  litShading: LitShading;
  /** Every material's average colour as drawn - its texture's average through its colour
   *  adjustment - by material index. */
  averageColors: [number, number, number][];
  textures: TerrainTextures;
  /** Every material's layer in `textures`, by material index. */
  layerOf: number[];
}

/**
 * The textures `materialDefs` draw, one per distinct textureId in first-use order, and which of
 * them each material draws - materials that borrow a texture (textureFrom) share its layer, so a
 * texture is baked, cached and uploaded once however many materials recolour it.
 */
export function terrainTextureLayers(materialDefs: MaterialDef[]): { layerOf: number[]; layers: { id: string; texture: TextureDef }[] } {
  const layerById = new Map<string, number>();
  const layers: { id: string; texture: TextureDef }[] = [];
  const layerOf = materialDefs.map((def) => {
    let layer = layerById.get(def.textureId);
    if (layer === undefined) {
      layer = layers.length;
      layerById.set(def.textureId, layer);
      layers.push({ id: def.textureId, texture: def.texture });
    }
    return layer;
  });
  return { layerOf, layers };
}

/** The textures `materialDefs` draw (terrainTextureLayers), as createTerrainMaterial uploads them. */
export async function bakeTerrainTextures(
  seed: number,
  materialDefs: MaterialDef[],
  onProgress?: (done: number, total: number) => void,
): Promise<TerrainTextures> {
  const { layers } = terrainTextureLayers(materialDefs);
  const colorBuffer = new Uint8Array(TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4 * layers.length);
  const normalBuffer = new Uint8Array(TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4 * layers.length);

  // Baked across a worker pool - this is by far the most expensive part of starting a world, and
  // textures are fully independent of one another, so it parallelises exactly (see
  // textureBakePool.ts). The averaged swatch colors come back with each result: they are averaged
  // from the actual baked pixels rather than re-derived from a texture's declared colors, since how
  // much of the bake each part of a pipeline covers is not knowable from the definition alone.
  const { averageColors } = await bakeMaterialTextures(layers, seed, colorBuffer, normalBuffer, onProgress);
  return { colorBuffer, normalBuffer, layerAverages: averageColors };
}

/**
 * Bakes `materialDefs`' procedural textures (packed as layers of one array texture each for colour
 * and normals, so the terrain shader can blend any of them through a single sampler) and builds
 * the terrain shader over them, lit by `sunLighting`. A mesh drawn with it names its materials by
 * index into `materialDefs` (its matIndices/matWeights attributes - see terrainMesh.ts); the
 * material table maps each index to its layer, detail and colour adjustment.
 *
 * `prebaked` skips the bake with textures already baked from exactly these definitions and seed -
 * the workbench keeps its bakes, so previewing again does not bake an unchanged material again.
 */
export async function createTerrainMaterial(
  scene: Scene,
  seed: number,
  materialDefs: MaterialDef[],
  sunLighting: SunLighting,
  onProgress?: (done: number, total: number) => void,
  prebaked?: TerrainTextures,
): Promise<TerrainMaterial> {
  const { layerOf, layers } = terrainTextureLayers(materialDefs);
  const textures = prebaked ?? (await bakeTerrainTextures(seed, materialDefs, onProgress));

  const materialAtlas = RawTexture2DArray.CreateRGBATexture(textures.colorBuffer, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, layers.length, scene, true, false);
  materialAtlas.wrapU = Texture.WRAP_ADDRESSMODE;
  materialAtlas.wrapV = Texture.WRAP_ADDRESSMODE;

  const normalAtlas = RawTexture2DArray.CreateRGBATexture(textures.normalBuffer, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, layers.length, scene, true, false);
  normalAtlas.wrapU = Texture.WRAP_ADDRESSMODE;
  normalAtlas.wrapV = Texture.WRAP_ADDRESSMODE;

  const matrices = materialDefs.map(materialMatrix);
  const averageColors = materialDefs.map((_, i) => applyColorMatrix(matrices[i], textures.layerAverages[layerOf[i]]));

  const table = new Float32Array(materialDefs.length * TABLE_WIDTH * 4);
  materialDefs.forEach((def, i) => {
    const row = i * TABLE_WIDTH * 4;
    table.set([layerOf[i], def.detail.scale, def.detail.strength, 0], row);
    table.set([...textures.layerAverages[layerOf[i]], 0], row + 4);
    const m = matrices[i];
    for (let column = 0; column < 3; column++) table.set([m[column], m[3 + column], m[6 + column], 0], row + 8 + column * 4);
  });
  const materialTable = new RawTexture(
    table,
    TABLE_WIDTH,
    materialDefs.length,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    false,
    false,
    Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    Constants.TEXTURETYPE_FLOAT,
  );

  Effect.ShadersStore["terrainBlendVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["terrainBlendFragmentShader"] = FRAGMENT_SHADER;

  const terrainMaterial = new ShaderMaterial("terrainBlend", scene, "terrainBlend", {
    attributes: ["position", "normal", "matIndices", "matWeights"],
    uniforms: [
      "world",
      "view",
      "projection",
      "tileScale",
      "waterLevel",
      "specularMinShininess",
      "specularMaxShininess",
      "specularIntensity",
      ...LIT_SHADING_UNIFORMS,
    ],
    samplers: ["materialAtlas", "normalAtlas", "materialTable", ...LIT_SHADING_SAMPLERS],
  });
  terrainMaterial.setTexture("materialAtlas", materialAtlas);
  terrainMaterial.setTexture("normalAtlas", normalAtlas);
  terrainMaterial.setTexture("materialTable", materialTable);
  terrainMaterial.setFloat("tileScale", 1 / TEXTURE_WORLD_TILE_SIZE);
  // Overwritten every frame by ocean.ts once the water exists; until then, nothing is underwater.
  terrainMaterial.setFloat("waterLevel", -1e6);
  terrainMaterial.setFloat("specularMinShininess", SPECULAR_MIN_SHININESS);
  terrainMaterial.setFloat("specularMaxShininess", SPECULAR_MAX_SHININESS);
  terrainMaterial.setFloat("specularIntensity", SPECULAR_INTENSITY);
  terrainMaterial.backFaceCulling = true;

  const litShading = createLitShading(scene, sunLighting);
  litShading.register(terrainMaterial);

  return { terrainMaterial, litShading, averageColors, textures, layerOf };
}

/** Builds every ground material's procedural texture once per world (see createTerrainMaterial),
 *  and compiles every material layer's weight pipeline once (reusing the exact same pipeline engine
 *  height pipelines use - see pipeline/pipelineCompiler.ts). Several layers - or a layer and a
 *  biome's own base - may resolve to the same MaterialDef (e.g. the two snow layers), so materials
 *  are deduplicated by id before building texture layers. */
export async function createMaterialLibrary(
  scene: Scene,
  seed: number,
  content: WorldContent,
  /** The world's areas' own rolls of their biomes (TerrainWorld.areaBiomes) - each gets its ground. */
  areaBiomes: readonly BiomeDefinition[],
  sunLighting: SunLighting,
  onProgress?: (done: number, total: number) => void,
): Promise<MaterialLibrary> {
  const blender = createMaterialBlender(seed, content, areaBiomes);
  const { materialDefs, defaultIndex, buildMaterialBlend, resolveMaterialIndex } = blender;
  const { terrainMaterial, litShading, averageColors, textures, layerOf } = await createTerrainMaterial(scene, seed, materialDefs, sunLighting, onProgress);
  const materialColors: Color3[] = averageColors.map(([r, g, b]) => new Color3(r, g, b));

  function getMaterialColor(materialIndex: number): Color3 {
    return materialColors[materialIndex] ?? materialColors[defaultIndex];
  }

  function getBiomeBaseColor(biome: BiomeDefinition): Color3 {
    return getMaterialColor(blender.biomeBaseIndex(biome));
  }

  const layerSize = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;
  // The texture as baked - a material that borrows another's shows that one, unadjusted.
  const texturePreviews: MaterialTexturePreview[] = materialDefs.map((def, i) => ({
    id: def.id,
    name: def.textureId === def.id ? def.name : `${def.name} (${def.textureId}'s texture)`,
    colorPixels: textures.colorBuffer.subarray(layerOf[i] * layerSize, (layerOf[i] + 1) * layerSize),
    normalPixels: textures.normalBuffer.subarray(layerOf[i] * layerSize, (layerOf[i] + 1) * layerSize),
  }));

  function listMaterialTextures(): MaterialTexturePreview[] {
    return texturePreviews;
  }

  function setShadowsEnabled(enabled: boolean): void {
    litShading.setShadowsEnabled(enabled);
  }

  const shadowCasterMaterial = new StandardMaterial("terrainShadowCaster", scene);

  function setWireframe(enabled: boolean): void {
    terrainMaterial.wireframe = enabled;
  }

  return {
    terrainMaterial,
    litShading,
    blender,
    buildMaterialBlend,
    resolveMaterialIndex,
    getMaterialColor,
    averageColors,
    getBiomeBaseColor,
    listMaterialTextures,
    setShadowsEnabled,
    shadowCasterMaterial,
    setWireframe,
  };
}
