import { Color3, Effect, Matrix, RawTexture2DArray, ShaderMaterial, Texture, type Scene } from "@babylonjs/core";
import { BIOME_REGISTRY } from "../biomes/biomeDefinitions";
import type { AreaWeight } from "../cells/areaField";
import { compilePipeline, type CompiledPipeline } from "../terrain/pipeline/pipelineCompiler";
import { SHADOW_CASCADE_COUNT, SHADOW_CASCADE_BLEND, SHADOW_DARKNESS, SHADOW_EDGE_FADE, SHADOW_MAP_SIZE, type SunLighting } from "../lighting/sunLighting";
import {
  DEFAULT_MATERIAL,
  MATERIAL_REGISTRY,
  PER_BIOME_MATERIAL_LAYERS,
  ROAD_MATERIAL_LAYER,
  UNIVERSAL_MATERIAL_LAYERS,
  type MaterialDef,
  type MaterialLayer,
} from "./materialDefinitions";
import { TEXTURE_RESOLUTION } from "./textureGen";
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

// Below this, no layer's weight is trusted and the base material wins outright - used only by the
// legacy single-winner resolveMaterialIndex (the debug map's read path). The blended path
// (buildMaterialBlend) has no threshold: weight conservation already fades a layer out to exactly
// 0 as it loses relevance, so there's no cliff left to guard against.
const MATERIAL_WEIGHT_THRESHOLD = 0.05;

/**
 * How many materials one vertex can blend at once.
 *
 * Which material occupies which slot is decided per vertex (see buildMaterialBlend) rather than
 * being fixed, because there are more materials in the atlas than there are slots. That is the only
 * reason any slot-ordering logic exists: with one slot per material the indices would be constants
 * and every vertex could compute its weights in complete isolation.
 *
 * The ordering has to agree between the vertices of a triangle, since the GPU interpolates the
 * weights while `flat` pins the indices to one vertex - a disagreement lands one vertex's weights
 * on another's materials. Slots are therefore laid out by material index, which is stable under
 * area weights changing order; it is not stable when the SET of materials changes, which is the
 * residual measured at ~0.25% of border-adjacent vertex pairs.
 */
const MATERIAL_SLOT_CAPACITY = 12;

export interface MaterialLibrary {
  /** The single shader material every terrain chunk uses - blends MATERIAL_SLOT_CAPACITY materials
   *  per vertex (see terrainMesh.ts), so no MultiMaterial/SubMesh split is needed any more. */
  terrainMaterial: ShaderMaterial;
  /** The material-index/weight roster for one point, weights summing to 1. Every area with a say
   *  there contributes its own base and layers, scaled by that area's share, accumulated per
   *  material and emitted in material-index order. */
  buildMaterialBlend: (worldX: number, worldZ: number, context: Record<string, number>, areaWeights: AreaWeight[]) => { indices: number[]; weights: number[] };
  /** Legacy single-winner resolution (highest-weight layer overall, thresholded) - kept only for
   *  the debug map, which renders one flat color per sample point and has no use for a blend. */
  resolveMaterialIndex: (worldX: number, worldZ: number, context: Record<string, number>, biomeId: string) => number;
  /** A representative swatch (the midpoint of its procedural texture's two colors) for a resolved
   *  material index - used by the debug map, which draws to a 2D canvas and has no Babylon
   *  Material/Texture of its own to sample from. */
  getMaterialColor: (materialIndex: number) => Color3;
  /** A biome's own base material's swatch, with no overlay layers evaluated - what the debug
   *  map's coarse World view shows, since resolving overlays isn't worth it at that zoom level. */
  getBiomeBaseColor: (biomeId: string) => Color3;
  /** Every deduplicated material's baked color+roughness and normal-map pixels (RGBA,
   *  TEXTURE_RESOLUTION² each), for the texture browser dev tool - views into the same buffers
   *  uploaded to the GPU, not a fresh render. */
  listMaterialTextures: () => MaterialTexturePreview[];
  /** Stops the terrain fragment shader from sampling the shadow map at all - the companion half of
   *  SunLighting.setShadowsEnabled, which stops the map being rendered into in the first place. */
  setShadowsEnabled: (enabled: boolean) => void;
}

export interface MaterialTexturePreview {
  id: string;
  name: string;
  colorPixels: Uint8Array;
  normalPixels: Uint8Array;
}

// Blinn-Phong shininess range the blended roughness (0=smooth..1=matte) maps into - not a real
// BRDF, just enough to make rock/snow read a hair shinier than matte grass. Kept low-key
// deliberately (SPECULAR_INTENSITY) so terrain doesn't read as wet plastic.
const SPECULAR_MIN_SHININESS = 4.0;
const SPECULAR_MAX_SHININESS = 48.0;
const SPECULAR_INTENSITY = 0.25;

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec4 matIndices0;
in vec4 matIndices1;
in vec4 matIndices2;
in vec4 matWeights0;
in vec4 matWeights1;
in vec4 matWeights2;

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
// flat, NOT smooth: these are sampler2DArray layer indices, and interpolating an index is
// meaningless - a fractional layer just rounds to the nearest one. Within a biome every vertex
// carries the same roster so interpolation was a no-op, but across a biome border the rosters
// differ (slot 0 is Mud on a swamp vertex and Desert Sand on a desert one), and interpolating
// between those two integers walked through every material lying numerically between them. That
// painted a one-triangle-wide ribbon of unrelated materials - grey rock, silt - along every biome
// boundary. flat makes each triangle use one vertex's roster outright, which is the clean hard
// edge the design already accepts at biome borders.
flat out vec4 vMatIndices0;
flat out vec4 vMatIndices1;
flat out vec4 vMatIndices2;
out vec4 vMatWeights0;
out vec4 vMatWeights1;
out vec4 vMatWeights2;

void main() {
  vec4 worldPosition = world * vec4(position, 1.0);
  gl_Position = projection * view * worldPosition;
  vNormal = normalize((world * vec4(normal, 0.0)).xyz);
  vWorldPosition = worldPosition.xyz;
  vPositionFromCamera = (view * worldPosition).xyz;
  // Texture coordinates come straight from world-space position, not the mesh's own 0..1 UV - see
  // TEXTURE_WORLD_TILE_SIZE's comment for why (this is what makes chunk boundaries seamless).
  vUV = worldPosition.xz * tileScale;
  vMatIndices0 = matIndices0;
  vMatIndices1 = matIndices1;
  vMatIndices2 = matIndices2;
  vMatWeights0 = matWeights0;
  vMatWeights1 = matWeights1;
  vMatWeights2 = matWeights2;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DArrayShadow;

#define NUM_CASCADES ${SHADOW_CASCADE_COUNT}
#define CASCADE_BLEND ${SHADOW_CASCADE_BLEND.toFixed(4)}
#define SHADOW_DARKNESS ${SHADOW_DARKNESS.toFixed(4)}
#define SHADOW_EDGE_FADE ${SHADOW_EDGE_FADE.toFixed(4)}

in vec2 vUV;
in vec3 vNormal;
in vec3 vWorldPosition;
in vec3 vPositionFromCamera;
flat in vec4 vMatIndices0;
flat in vec4 vMatIndices1;
flat in vec4 vMatIndices2;
in vec4 vMatWeights0;
in vec4 vMatWeights1;
in vec4 vMatWeights2;

uniform sampler2DArray materialAtlas;
uniform sampler2DArray normalAtlas;
uniform vec3 lightDirection;
uniform float lightIntensity;
uniform vec3 lightColor;
uniform vec3 ambientColor;
uniform float ambientIntensity;
uniform vec3 cameraPosition;
uniform float specularMinShininess;
uniform float specularMaxShininess;
uniform float specularIntensity;

uniform bool shadowsEnabled;
uniform highp sampler2DArrayShadow shadowMap;
uniform mat4 lightMatrix[NUM_CASCADES];
uniform float cascadeSplits[NUM_CASCADES];
uniform float cascadeBias[NUM_CASCADES];
uniform float shadowTexelSize;

uniform int fogMode;
uniform vec3 fogColor;
uniform float fogStart;
uniform float fogEnd;
uniform float fogDensity;

out vec4 outColor;

/**
 * One cascade's worth of shadow, hardware-compared and box-filtered.
 *
 * texture() on a sampler2DArrayShadow returns the already-filtered fraction of the 2x2 texel
 * neighbourhood that is nearer the light than depth - one hardware comparison per tap, not a raw
 * depth read this code would have to compare by hand. The 3x3 loop around it is what turns that
 * single soft edge into a properly area-filtered one.
 */
float sampleCascade(int cascade, vec3 worldPos) {
  vec4 posFromLight = lightMatrix[cascade] * vec4(worldPos, 1.0);
  vec3 clipSpace = posFromLight.xyz / posFromLight.w;
  vec2 uv = clipSpace.xy * 0.5 + 0.5;
  float depth = clamp(clipSpace.z * 0.5 + 0.5, 0.0, 0.9999);

  float lit = 0.0;
  for (int dx = -1; dx <= 1; dx++) {
    for (int dy = -1; dy <= 1; dy++) {
      vec2 offset = vec2(float(dx), float(dy)) * shadowTexelSize;
      lit += texture(shadowMap, vec4(uv + offset, float(cascade), depth));
    }
  }
  return lit / 9.0;
}

/**
 * Which of the four cascades - and, near a cascade boundary, how much of the next one too - a
 * fragment falls into, then the shadow those choices actually add up to.
 *
 * Cascade choice keys on view-space Z (vPositionFromCamera.z, forward depth from the camera - see
 * that varying's own comment) against cascadeSplits, which SunLighting computes with the exact
 * same closed-form split the shadow generator itself uses internally: the fragment shader has no
 * access to the generator's own numbers, so agreement here depends entirely on both sides doing
 * the identical arithmetic from the identical near/far/lambda inputs.
 *
 * Every seam a hard cascade choice would leave is instead a fade: CASCADE_BLEND blends this
 * cascade's sample toward the next one's over the last fraction of its own span, and
 * SHADOW_EDGE_FADE fades the whole effect back to fully lit over the last few units before the
 * far cascade's own edge, rather than the shadow switching off in one triangle.
 */
float computeShadow(vec3 worldPos, vec3 worldNormal) {
  if (!shadowsEnabled) return 1.0;

  float viewDepth = vPositionFromCamera.z;
  if (viewDepth > cascadeSplits[NUM_CASCADES - 1]) return 1.0;

  int cascade = NUM_CASCADES - 1;
  for (int i = 0; i < NUM_CASCADES; i++) {
    if (viewDepth <= cascadeSplits[i]) { cascade = i; break; }
  }

  // Normal-offset bias: pushes the sampled point off the surface along its own normal before
  // projecting into light space, rather than biasing the compared depth by a flat amount. A flat
  // bias sized for the near cascade's fine texels is nowhere near enough to clear self-shadowing
  // acne in the coarser far ones, and one sized for the far cascade would peel the near shadows
  // away from their casters - cascadeBias is scaled per cascade for exactly this reason.
  vec3 biasedPos = worldPos + worldNormal * cascadeBias[cascade];
  float lit = sampleCascade(cascade, biasedPos);

  if (cascade < NUM_CASCADES - 1) {
    float prevSplit = cascade == 0 ? 0.0 : cascadeSplits[cascade - 1];
    float span = cascadeSplits[cascade] - prevSplit;
    float t = clamp((viewDepth - prevSplit) / span - (1.0 - CASCADE_BLEND), 0.0, CASCADE_BLEND) / CASCADE_BLEND;
    float blend = t * t * (3.0 - 2.0 * t);
    if (blend > 0.0) {
      float nextLit = sampleCascade(cascade + 1, biasedPos);
      lit = mix(lit, nextLit, blend);
    }
  }

  float edgeT = clamp((cascadeSplits[NUM_CASCADES - 1] - viewDepth) / SHADOW_EDGE_FADE, 0.0, 1.0);
  float edgeFade = edgeT * edgeT * (3.0 - 2.0 * edgeT);
  float shadow = mix(SHADOW_DARKNESS, 1.0, lit);
  return mix(1.0, shadow, edgeFade);
}

void main() {
  vec3 n = normalize(vNormal);

  vec4 albedo = texture(materialAtlas, vec3(vUV, vMatIndices0.x)) * vMatWeights0.x
    + texture(materialAtlas, vec3(vUV, vMatIndices0.y)) * vMatWeights0.y
    + texture(materialAtlas, vec3(vUV, vMatIndices0.z)) * vMatWeights0.z
    + texture(materialAtlas, vec3(vUV, vMatIndices0.w)) * vMatWeights0.w
    + texture(materialAtlas, vec3(vUV, vMatIndices1.x)) * vMatWeights1.x
    + texture(materialAtlas, vec3(vUV, vMatIndices1.y)) * vMatWeights1.y
    + texture(materialAtlas, vec3(vUV, vMatIndices1.z)) * vMatWeights1.z
    + texture(materialAtlas, vec3(vUV, vMatIndices1.w)) * vMatWeights1.w
    + texture(materialAtlas, vec3(vUV, vMatIndices2.x)) * vMatWeights2.x
    + texture(materialAtlas, vec3(vUV, vMatIndices2.y)) * vMatWeights2.y
    + texture(materialAtlas, vec3(vUV, vMatIndices2.z)) * vMatWeights2.z
    + texture(materialAtlas, vec3(vUV, vMatIndices2.w)) * vMatWeights2.w;

  vec3 tangentNormal = (texture(normalAtlas, vec3(vUV, vMatIndices0.x)).rgb * 2.0 - 1.0) * vMatWeights0.x
    + (texture(normalAtlas, vec3(vUV, vMatIndices0.y)).rgb * 2.0 - 1.0) * vMatWeights0.y
    + (texture(normalAtlas, vec3(vUV, vMatIndices0.z)).rgb * 2.0 - 1.0) * vMatWeights0.z
    + (texture(normalAtlas, vec3(vUV, vMatIndices0.w)).rgb * 2.0 - 1.0) * vMatWeights0.w
    + (texture(normalAtlas, vec3(vUV, vMatIndices1.x)).rgb * 2.0 - 1.0) * vMatWeights1.x
    + (texture(normalAtlas, vec3(vUV, vMatIndices1.y)).rgb * 2.0 - 1.0) * vMatWeights1.y
    + (texture(normalAtlas, vec3(vUV, vMatIndices1.z)).rgb * 2.0 - 1.0) * vMatWeights1.z
    + (texture(normalAtlas, vec3(vUV, vMatIndices1.w)).rgb * 2.0 - 1.0) * vMatWeights1.w
    + (texture(normalAtlas, vec3(vUV, vMatIndices2.x)).rgb * 2.0 - 1.0) * vMatWeights2.x
    + (texture(normalAtlas, vec3(vUV, vMatIndices2.y)).rgb * 2.0 - 1.0) * vMatWeights2.y
    + (texture(normalAtlas, vec3(vUV, vMatIndices2.z)).rgb * 2.0 - 1.0) * vMatWeights2.z
    + (texture(normalAtlas, vec3(vUV, vMatIndices2.w)).rgb * 2.0 - 1.0) * vMatWeights2.w;
  tangentNormal = normalize(tangentNormal);

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
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 halfVec = normalize(viewDir + lightDir);
  float ndh = max(dot(worldNormal, halfVec), 0.0);
  float shininess = mix(specularMaxShininess, specularMinShininess, roughness);
  float specular = pow(ndh, shininess) * (1.0 - roughness) * specularIntensity;

  // Shadow darkens the light itself, not the surface it lands on - a shadowed patch of sand is
  // still sand, just lit by the sky rather than the sun, which is what SHADOW_DARKNESS's floor is
  // standing in for (see computeShadow).
  float shadow = computeShadow(vWorldPosition, worldNormal);
  // Ambient is not shadowed - it is sky-fill, not a beam the sun caster could block, and reaches a
  // shadowed patch exactly as it reaches a lit one. Without this, night terrain (a dim moon,
  // frequently in the 0-intensity instant right at moonrise/moonset) would read as pure black,
  // since - unlike trees and ocean's StandardMaterial, which pick up the scene's HemisphericLight
  // automatically - this shader has no light of its own besides lightColor/lightIntensity.
  vec3 ambient = albedo.rgb * ambientColor * ambientIntensity;
  vec3 lit = albedo.rgb * diffuse * lightColor * shadow + vec3(specular) * lightColor * lightIntensity * shadow + ambient;

  float fogDistance = length(vPositionFromCamera);
  float fogFactor = 1.0;
  if (fogMode == 3) {
    fogFactor = clamp((fogEnd - fogDistance) / max(fogEnd - fogStart, 0.0001), 0.0, 1.0);
  } else if (fogMode == 1) {
    fogFactor = clamp(1.0 / exp(fogDistance * fogDensity), 0.0, 1.0);
  } else if (fogMode == 2) {
    fogFactor = clamp(1.0 / exp(fogDistance * fogDistance * fogDensity * fogDensity), 0.0, 1.0);
  }
  vec3 finalColor = mix(fogColor, lit, fogFactor);

  outColor = vec4(finalColor, 1.0);
}
`;

/** Builds every ground material's procedural texture once per world (packed as layers of one
 *  combined array texture, so the terrain shader can blend any of them via a single sampler), and
 *  compiles every material layer's weight pipeline once (reusing the exact same pipeline engine
 *  height pipelines use - see pipeline/pipelineCompiler.ts). Several layers - or a layer and a
 *  biome's own base - may resolve to the same MaterialDef (e.g. the two snow layers), so materials
 *  are deduplicated by id before building texture layers. */
export async function createMaterialLibrary(
  scene: Scene,
  seed: number,
  sunLighting: SunLighting,
  onProgress?: (done: number, total: number) => void,
): Promise<MaterialLibrary> {
  const materialDefs: MaterialDef[] = [];
  const materialIndexById = new Map<string, number>();

  function ensureMaterial(def: MaterialDef): number {
    let index = materialIndexById.get(def.id);
    if (index === undefined) {
      index = materialDefs.length;
      materialIndexById.set(def.id, index);
      materialDefs.push(def);
    }
    return index;
  }

  const defaultIndex = ensureMaterial(DEFAULT_MATERIAL);

  const biomeBaseIndex = new Map<string, number>();
  for (const biome of BIOME_REGISTRY) {
    const def = MATERIAL_REGISTRY[biome.baseMaterialId] ?? DEFAULT_MATERIAL;
    biomeBaseIndex.set(biome.id, ensureMaterial(def));
  }

  for (const layer of UNIVERSAL_MATERIAL_LAYERS) {
    ensureMaterial(layer.material);
  }
  ensureMaterial(ROAD_MATERIAL_LAYER.material);
  // One entry per biome, exactly like biomeBaseIndex: the road layer is shared, the surface it
  // paints is the zone's own.
  const biomeRoadIndex = new Map<string, number>();
  for (const biome of BIOME_REGISTRY) {
    const def = MATERIAL_REGISTRY[biome.roadMaterialId] ?? ROAD_MATERIAL_LAYER.material;
    biomeRoadIndex.set(biome.id, ensureMaterial(def));
  }
  for (const layers of Object.values(PER_BIOME_MATERIAL_LAYERS)) {
    for (const layer of layers) ensureMaterial(layer.material);
  }

  const colorBuffer = new Uint8Array(TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4 * materialDefs.length);
  const normalBuffer = new Uint8Array(TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4 * materialDefs.length);

  // Baked across a worker pool - this is by far the most expensive part of starting a world, and
  // materials are fully independent of one another, so it parallelises exactly (see
  // textureBakePool.ts). The averaged swatch colors come back with each result: they are averaged
  // from the actual baked pixels rather than re-derived from a texture's declared colors, since how
  // much of the bake each part of a pipeline covers is not knowable from the definition alone.
  const { averageColors } = await bakeMaterialTextures(
    materialDefs.map((def) => ({ id: def.id, texture: def.texture })),
    seed,
    colorBuffer,
    normalBuffer,
    onProgress,
  );
  const materialColors: Color3[] = averageColors.map(([r, g, b]) => new Color3(r, g, b));

  const materialAtlas = RawTexture2DArray.CreateRGBATexture(colorBuffer, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, materialDefs.length, scene, true, false);
  materialAtlas.wrapU = Texture.WRAP_ADDRESSMODE;
  materialAtlas.wrapV = Texture.WRAP_ADDRESSMODE;

  const normalAtlas = RawTexture2DArray.CreateRGBATexture(normalBuffer, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, materialDefs.length, scene, true, false);
  normalAtlas.wrapU = Texture.WRAP_ADDRESSMODE;
  normalAtlas.wrapV = Texture.WRAP_ADDRESSMODE;

  Effect.ShadersStore["terrainBlendVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["terrainBlendFragmentShader"] = FRAGMENT_SHADER;

  const terrainMaterial = new ShaderMaterial("terrainBlend", scene, "terrainBlend", {
    attributes: ["position", "normal", "matIndices0", "matIndices1", "matIndices2", "matWeights0", "matWeights1", "matWeights2"],
    uniforms: [
      "world",
      "view",
      "projection",
      "tileScale",
      "lightDirection",
      "lightIntensity",
      "lightColor",
      "ambientColor",
      "ambientIntensity",
      "cameraPosition",
      "specularMinShininess",
      "specularMaxShininess",
      "specularIntensity",
      "shadowsEnabled",
      "lightMatrix",
      "cascadeSplits",
      "cascadeBias",
      "shadowTexelSize",
      "fogMode",
      "fogColor",
      "fogStart",
      "fogEnd",
      "fogDensity",
    ],
    samplers: ["materialAtlas", "normalAtlas", "shadowMap"],
  });
  terrainMaterial.setTexture("materialAtlas", materialAtlas);
  terrainMaterial.setTexture("normalAtlas", normalAtlas);
  terrainMaterial.setFloat("tileScale", 1 / TEXTURE_WORLD_TILE_SIZE);
  terrainMaterial.setFloat("specularMinShininess", SPECULAR_MIN_SHININESS);
  terrainMaterial.setFloat("specularMaxShininess", SPECULAR_MAX_SHININESS);
  terrainMaterial.setFloat("specularIntensity", SPECULAR_INTENSITY);
  terrainMaterial.backFaceCulling = true;

  let shadowsEnabled = true;
  terrainMaterial.setInt("shadowsEnabled", 1);
  terrainMaterial.setFloats("cascadeSplits", sunLighting.cascadeSplits);
  terrainMaterial.setFloats("cascadeBias", sunLighting.cascadeBias);
  terrainMaterial.setFloat("shadowTexelSize", 1 / SHADOW_MAP_SIZE);

  // cameraPosition isn't one of ShaderMaterial's automatically-bound uniform names (only the
  // world/view/projection matrix family is), so it needs a manual per-frame update for the
  // specular term's view direction - scene.activeCamera doesn't exist yet on the very first tick
  // (main.ts creates the camera after the world), hence the guard. Fog rides along here too; both
  // are safe this early in the frame because neither depends on anything the render loop hasn't
  // computed yet - unlike the shadow matrices below, which very much do.
  //
  // Light direction/colour/intensity and ambient colour/intensity ride along here too, now that
  // the day-night cycle (sunLighting.updateDayNight) changes all five every frame - direction and
  // the two colours are mutated in place rather than reassigned (see SunLighting's own fields), so
  // reading them fresh here every frame is what actually picks up each frame's value; setting them
  // once at creation, as this used to, would have frozen the terrain at whatever moment it started.
  scene.onBeforeRenderObservable.add(() => {
    if (scene.activeCamera) {
      terrainMaterial.setVector3("cameraPosition", scene.activeCamera.position);
    }
    terrainMaterial.setInt("fogMode", scene.fogMode);
    terrainMaterial.setColor3("fogColor", scene.fogColor);
    terrainMaterial.setFloat("fogStart", scene.fogStart);
    terrainMaterial.setFloat("fogEnd", scene.fogEnd);
    terrainMaterial.setFloat("fogDensity", scene.fogDensity);
    terrainMaterial.setVector3("lightDirection", sunLighting.direction);
    terrainMaterial.setFloat("lightIntensity", sunLighting.intensity);
    terrainMaterial.setColor3("lightColor", sunLighting.color);
    terrainMaterial.setColor3("ambientColor", sunLighting.ambientColor);
    terrainMaterial.setFloat("ambientIntensity", sunLighting.ambientIntensity);
  });

  /**
   * The shadow map's per-cascade matrices are NOT safe to read at the top of the frame. They
   * describe where the generator pointed its shadow camera to cover THIS frame, and the generator
   * only refits them to the camera during its own render pass, which Babylon runs after
   * onBeforeRenderObservable, as part of rendering the main camera's view. Reading them there (this
   * code's first shape) read last frame's fit instead of this one's: invisible while the camera sat
   * still, since consecutive frames then fit identically, and a visibly wrong, lagging shadow the
   * instant it moved - exactly what turned up once someone actually orbited the camera over a
   * hillside.
   *
   * The shadow map's own onAfterRenderObservable is what actually pins this down: it fires once
   * per cascade layer, strictly after that layer's render, which is strictly before the main pass
   * that draws the terrain reads it - the same ordering a StandardMaterial's built-in shadow
   * binding relies on without anyone having to arrange it by hand. Every cascade's matrix is
   * computed together before layer 0 even starts (see the generator's own onBeforeBindObservable),
   * so any one layer finishing is already enough to read all of them; the gate below just keeps
   * the actual update to once per frame instead of once per cascade.
   */
  const shadowMap = sunLighting.shadowGenerator.getShadowMap();
  let shadowMatricesStale = true;
  scene.onBeforeRenderObservable.add(() => {
    shadowMatricesStale = true;
  });
  shadowMap?.onAfterRenderObservable.add(() => {
    if (!shadowMatricesStale || !shadowsEnabled) return;
    shadowMatricesStale = false;

    // The RenderTargetTexture itself is a colour attachment; the depth-stencil texture the
    // generator creates alongside it (see CascadedShadowGenerator's own _createTargetRenderTexture)
    // is the one WebGL actually built as a comparison texture, which is what a sampler2DArrayShadow
    // uniform in GLSL requires - binding the colour one there is a real GL_INVALID_OPERATION, not a
    // silently-wrong-looking result, since a shadow sampler can only ever read a comparison texture.
    const depthTexture = shadowMap.depthStencilTexture;
    if (!depthTexture) return;

    terrainMaterial.setInternalTexture("shadowMap", depthTexture);
    const matrices: Matrix[] = [];
    for (let i = 0; i < SHADOW_CASCADE_COUNT; i++) {
      matrices.push(sunLighting.shadowGenerator.getCascadeTransformMatrix(i) ?? Matrix.Identity());
    }
    terrainMaterial.setMatrices("lightMatrix", matrices);
  });

  interface CompiledLayer {
    materialIndex: number;
    evaluate: CompiledPipeline;
  }

  function compileLayers(layers: MaterialLayer[]): CompiledLayer[] {
    return layers.map((layer) => ({
      materialIndex: materialIndexById.get(layer.material.id)!,
      evaluate: compilePipeline(layer.weight, seed, `material-${layer.id}`),
    }));
  }

  // Compiled once per biome (not once globally) - every resolve function below only ever walks the
  // universal list plus THIS biome's own list, so per-vertex cost stays flat as more biomes grow
  // their own layers, instead of scaling with the total layer count across every biome combined.
  const compiledUniversalLayers = compileLayers(UNIVERSAL_MATERIAL_LAYERS);
  const compiledRoadLayer = compileLayers([ROAD_MATERIAL_LAYER])[0];
  const compiledPerBiomeLayers = new Map<string, CompiledLayer[]>();
  for (const [biomeId, layers] of Object.entries(PER_BIOME_MATERIAL_LAYERS)) {
    compiledPerBiomeLayers.set(biomeId, compileLayers(layers));
  }

  // A single biome must always fit outright; beyond that the roster is assembled per point from
  // whichever areas are in range, deduplicated by material, so there is no fixed layout to size
  // against. Measured over every biome combination: two areas need at most 11 of the 12 slots, a
  // three-area junction at most 14 - the rare overflow drops the weakest area's layers, never a
  // base (see buildMaterialBlend's emission order).
  const maxPerBiomeLayerCount = Math.max(0, ...Object.values(PER_BIOME_MATERIAL_LAYERS).map((layers) => layers.length));
  // +1 for the road, which is one material per biome and so one slot in a single-biome roster.
  const singleBiomeSlotCount = 1 + compiledUniversalLayers.length + 1 + maxPerBiomeLayerCount;
  if (singleBiomeSlotCount > MATERIAL_SLOT_CAPACITY) {
    throw new Error(`MATERIAL_SLOT_CAPACITY (${MATERIAL_SLOT_CAPACITY}) is too small for a single biome needing ${singleBiomeSlotCount} slots - raise it`);
  }


  /**
   * The material roster and weights for one point, blending every area that has a say there.
   *
   * Each area contributes the result of the ordinary single-biome blend - its own base plus the
   * universal layers plus its per-biome layers, weight-conserved exactly as before - scaled by that
   * area's share. Universal layers appear once per area with the same weight, so they survive the
   * sum unchanged and need no special case.
   *
   * Contributions accumulate per MATERIAL rather than per layer, which is what makes this fit: two
   * layers pointing at the same MaterialDef, or two areas of the same biome, merge into one slot.
   * Measured over every biome combination, a two-area border needs at most 11 of the 12 slots and a
   * three-area junction at most 14 - so the emission order below matters, since the tail is what
   * gets dropped in the rare overflow.
   */
  function buildMaterialBlend(worldX: number, worldZ: number, context: Record<string, number>, areaWeights: AreaWeight[]): { indices: number[]; weights: number[] } {
    const indices = new Array<number>(MATERIAL_SLOT_CAPACITY).fill(0);
    const weights = new Array<number>(MATERIAL_SLOT_CAPACITY).fill(0);
    if (areaWeights.length === 0) return { indices, weights };

    // Accumulated per material index, then emitted in a priority order that is a pure function of
    // the (already deterministically ordered) area list - so two neighbouring vertices that see the
    // same areas always lay their slots out identically.
    const weightByMaterial = new Map<number, number>();
    const order: number[] = [];
    const add = (materialIndex: number, weight: number): void => {
      const existing = weightByMaterial.get(materialIndex);
      if (existing === undefined) {
        weightByMaterial.set(materialIndex, weight);
        order.push(materialIndex);
      } else {
        weightByMaterial.set(materialIndex, existing + weight);
      }
    };

    // Universal layers first: they are shared by every area and so are the one part of the roster
    // guaranteed to be present whatever the area set is.
    const universalWeights: number[] = [];
    let universalSum = 0;
    for (const layer of compiledUniversalLayers) {
      const weight = Math.max(0, layer.evaluate(worldX, worldZ, context));
      universalWeights.push(weight);
      universalSum += weight;
    }

    // Then every area's base, strongest area first, before any per-biome layer - a base is what
    // actually reads as "which zone is this", so it must never be the thing an overflow drops.
    // Emission order is what keeps neighbouring vertices agreeing on what each slot means, and it
    // has to be grouped by AREA rather than by role. Adding every area's base, then the universal
    // layers, then every area's layers put a newly-arrived area's base in the MIDDLE of the list,
    // which shifted every later material down a slot - and those later materials carry real weight,
    // so the shift painted a dashed line of wrong-material triangles along every border. Grouping
    // by area means a newcomer appends its whole block at the end and displaces nothing.
    //
    // Areas go strongest first so the newcomer - always the weakest, since it is fading in from
    // zero - is the one that lands last. The order can still flip between two areas of equal
    // weight, but that is self-cancelling: at the flip their weights are equal by definition, so
    // swapping their blocks is very nearly a no-op. The shift this replaces was not.
    const orderedAreas = [...areaWeights].sort((a, b) => b.weight - a.weight || a.areaId - b.areaId);

    // The road's weight is the same everywhere - the layer is one pipeline over roadGap - so it is
    // evaluated once here and only its MATERIAL varies per area below.
    const roadWeight = Math.max(0, compiledRoadLayer.evaluate(worldX, worldZ, context));

    const perAreaOverlays: { layers: CompiledLayer[]; weights: number[]; scale: number; share: number; biomeId: string }[] = [];
    for (const area of orderedAreas) {
      const layers = compiledPerBiomeLayers.get(area.biome.id) ?? [];
      const layerWeights: number[] = [];
      let overlaySum = universalSum + roadWeight;
      for (const layer of layers) {
        const weight = Math.max(0, layer.evaluate(worldX, worldZ, context));
        layerWeights.push(weight);
        overlaySum += weight;
      }
      // Same weight conservation as the single-biome case, applied within this area's own blend.
      const scale = overlaySum > 1 ? 1 / overlaySum : 1;
      perAreaOverlays.push({ layers, weights: layerWeights, scale, share: area.weight, biomeId: area.biome.id });
    }

    // Universal layers occupy the first slots always - they are present for every area, so pinning
    // them here means nothing downstream of them can be displaced by the area set changing.
    for (let i = 0; i < compiledUniversalLayers.length; i++) {
      let weight = 0;
      for (const area of perAreaOverlays) weight += universalWeights[i] * area.scale * area.share;
      add(compiledUniversalLayers[i].materialIndex, weight);
    }

    // Then one contiguous block per area: its road surface, its base, then its own layers. The road
    // comes first in the block because it is the one thing in it that is a made surface rather than
    // something that grew, and so the one that should survive a roster overflow.
    for (const area of perAreaOverlays) {
      if (roadWeight > 0) {
        add(biomeRoadIndex.get(area.biomeId) ?? defaultIndex, roadWeight * area.scale * area.share);
      }
      let overlaySum = universalSum + roadWeight;
      for (const weight of area.weights) overlaySum += weight;
      add(biomeBaseIndex.get(area.biomeId) ?? defaultIndex, Math.max(0, 1 - overlaySum * area.scale) * area.share);
      for (let i = 0; i < area.layers.length; i++) {
        add(area.layers[i].materialIndex, area.weights[i] * area.scale * area.share);
      }
    }

    // Slots are laid out by MATERIAL index, never by the order areas happened to be visited in.
    // Two vertices that see the same set of materials therefore always agree on which slot holds
    // which material, whatever their area weights are doing - and area weights swap order along the
    // middle of every border, where the two areas sit at ~50/50. Laying out by area put each
    // biome's base and layers in one block, so that swap misaligned every slot after it (blocks
    // differ in length), rendering ~25-30% of the blend as the wrong material in a dashed line
    // right down the border.
    // On overflow, drop the LIGHTEST materials rather than the highest-numbered ones.
    //
    // This used to sort the whole roster by material index and keep the first twelve, which meant
    // an overflow discarded whichever materials happened to have been registered last - a property
    // of declaration order in materialDefinitions, with no relation to whether the material was
    // doing anything at that point. A zone naming its own road surface made overflow reachable at
    // an ordinary two-way border (measured: 2 of 28 biome pairs need a 13th slot), so what gets
    // dropped stopped being hypothetical.
    //
    // Selection by weight first, and only then the sort by material index that the slot layout
    // depends on - two vertices seeing the same materials must still agree on which slot holds
    // which, and that is what the index sort is for.
    let kept = order;
    if (kept.length > MATERIAL_SLOT_CAPACITY) {
      kept = order
        .slice()
        .sort((a, b) => (weightByMaterial.get(b) ?? 0) - (weightByMaterial.get(a) ?? 0) || a - b)
        .slice(0, MATERIAL_SLOT_CAPACITY);
    }
    const emitted = kept.slice().sort((a, b) => a - b);
    const slotCount = Math.min(emitted.length, MATERIAL_SLOT_CAPACITY);
    for (let slot = 0; slot < slotCount; slot++) {
      indices[slot] = emitted[slot];
      weights[slot] = weightByMaterial.get(emitted[slot]) ?? 0;
    }

    return { indices, weights };
  }

  function resolveMaterialIndex(worldX: number, worldZ: number, context: Record<string, number>, biomeId: string): number {
    let bestIndex = biomeBaseIndex.get(biomeId) ?? defaultIndex;
    let bestWeight = MATERIAL_WEIGHT_THRESHOLD;

    const applicableLayers = compiledPerBiomeLayers.get(biomeId);
    for (const layer of compiledUniversalLayers) {
      const weight = layer.evaluate(worldX, worldZ, context);
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIndex = layer.materialIndex;
      }
    }
    const roadWeight = compiledRoadLayer.evaluate(worldX, worldZ, context);
    if (roadWeight > bestWeight) {
      bestWeight = roadWeight;
      bestIndex = biomeRoadIndex.get(biomeId) ?? defaultIndex;
    }
    if (applicableLayers) {
      for (const layer of applicableLayers) {
        const weight = layer.evaluate(worldX, worldZ, context);
        if (weight > bestWeight) {
          bestWeight = weight;
          bestIndex = layer.materialIndex;
        }
      }
    }

    return bestIndex;
  }

  function getMaterialColor(materialIndex: number): Color3 {
    return materialColors[materialIndex] ?? materialColors[defaultIndex];
  }

  function getBiomeBaseColor(biomeId: string): Color3 {
    return getMaterialColor(biomeBaseIndex.get(biomeId) ?? defaultIndex);
  }

  const layerSize = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;
  const texturePreviews: MaterialTexturePreview[] = materialDefs.map((def, i) => ({
    id: def.id,
    name: def.name,
    colorPixels: colorBuffer.subarray(i * layerSize, (i + 1) * layerSize),
    normalPixels: normalBuffer.subarray(i * layerSize, (i + 1) * layerSize),
  }));

  function listMaterialTextures(): MaterialTexturePreview[] {
    return texturePreviews;
  }

  function setShadowsEnabled(enabled: boolean): void {
    shadowsEnabled = enabled;
    terrainMaterial.setInt("shadowsEnabled", enabled ? 1 : 0);
  }

  return { terrainMaterial, buildMaterialBlend, resolveMaterialIndex, getMaterialColor, getBiomeBaseColor, listMaterialTextures, setShadowsEnabled };
}
