import { Color3, Effect, Matrix, RawTexture2DArray, ShaderMaterial, StandardMaterial, Texture, type Material, type Scene } from "@babylonjs/core";
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

// Below this, no layer's weight is trusted and the base material wins outright - used only by the
// legacy single-winner resolveMaterialIndex (the debug map's read path). The blended path
// (buildMaterialBlend) has no threshold: weight conservation already fades a layer out to exactly
// 0 as it loses relevance, so there's no cliff left to guard against.
const MATERIAL_WEIGHT_THRESHOLD = 0.05;

/**
 * How many materials one triangle blends. Each triangle draws the materials of one "owner" vertex
 * (see terrainMesh.ts), so this is also the fragment shader's texture-read budget: two reads (colour
 * and normal) per material.
 */
export const MATERIALS_PER_TRIANGLE = 3;

export interface MaterialLibrary {
  /** The single shader material every terrain chunk uses - blends MATERIALS_PER_TRIANGLE materials
   *  per triangle (see terrainMesh.ts), so no MultiMaterial/SubMesh split is needed any more. */
  terrainMaterial: ShaderMaterial;
  /** Every material's weight at one point, keyed by material index and summing to 1. Every area
   *  with a say there contributes its own base and layers, scaled by that area's share. */
  buildMaterialBlend: (worldX: number, worldZ: number, context: Record<string, number>, areaWeights: AreaWeight[]) => Map<number, number>;
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
  /** The material on terrain's shadow-only meshes (see terrainMesh.ts). Never drawn: the shadow
   *  generator uses its own depth shader and only reads render state from it - face culling, and
   *  fill mode, which is why it is not terrainMaterial: switching that to wireframe would otherwise
   *  turn the terrain's shadows into wireframe too. */
  shadowCasterMaterial: Material;
  /** Draws the terrain as wireframe - a debug view for judging mesh density and level of detail. */
  setWireframe: (enabled: boolean) => void;
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
flat in vec4 vMatIndices;
in vec4 vMatWeights;

uniform sampler2DArray materialAtlas;
uniform sampler2DArray normalAtlas;
uniform vec3 lightDirection;
uniform float lightIntensity;
uniform vec3 lightColor;
uniform vec3 ambientColor;
uniform float ambientIntensity;
uniform float waterLevel;
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

  vec4 albedo = ${materialSlots.map((c) => `texture(materialAtlas, vec3(vUV, vMatIndices.${c})) * vMatWeights.${c}`).join("\n    + ")};

  vec3 tangentNormal = ${materialSlots.map((c) => `(texture(normalAtlas, vec3(vUV, vMatIndices.${c})).rgb * 2.0 - 1.0) * vMatWeights.${c}`).join("\n    + ")};
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
    attributes: ["position", "normal", "matIndices", "matWeights"],
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
      "waterLevel",
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
  // Overwritten every frame by ocean.ts once the water exists; until then, nothing is underwater.
  terrainMaterial.setFloat("waterLevel", -1e6);
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

  /**
   * Every material's weight at one point, blending every area that has a say there. Weights sum to
   * 1; materials with no weight are left out.
   *
   * Each area contributes the result of the ordinary single-biome blend - its own base plus the
   * universal layers plus its per-biome layers, weight-conserved - scaled by that area's share.
   * Contributions accumulate per MATERIAL rather than per layer, so two layers pointing at the same
   * MaterialDef, or two areas of the same biome, merge. Which of these a triangle actually draws is
   * decided by the mesh builder (see terrainMesh.ts), not here.
   */
  function buildMaterialBlend(worldX: number, worldZ: number, context: Record<string, number>, areaWeights: AreaWeight[]): Map<number, number> {
    const weightByMaterial = new Map<number, number>();
    if (areaWeights.length === 0) return weightByMaterial;
    const add = (materialIndex: number, weight: number): void => {
      if (weight <= 0) return;
      weightByMaterial.set(materialIndex, (weightByMaterial.get(materialIndex) ?? 0) + weight);
    };

    const universalWeights: number[] = [];
    let universalSum = 0;
    for (const layer of compiledUniversalLayers) {
      const weight = Math.max(0, layer.evaluate(worldX, worldZ, context));
      universalWeights.push(weight);
      universalSum += weight;
    }

    // The road's weight is the same everywhere - the layer is one pipeline over roadGap - so it is
    // evaluated once here and only its MATERIAL varies per area below.
    const roadWeight = Math.max(0, compiledRoadLayer.evaluate(worldX, worldZ, context));

    for (const area of areaWeights) {
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
      const share = area.weight;
      for (let i = 0; i < compiledUniversalLayers.length; i++) {
        add(compiledUniversalLayers[i].materialIndex, universalWeights[i] * scale * share);
      }
      add(biomeRoadIndex.get(area.biome.id) ?? defaultIndex, roadWeight * scale * share);
      add(biomeBaseIndex.get(area.biome.id) ?? defaultIndex, Math.max(0, 1 - overlaySum * scale) * share);
      for (let i = 0; i < layers.length; i++) {
        add(layers[i].materialIndex, layerWeights[i] * scale * share);
      }
    }

    return weightByMaterial;
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

  const shadowCasterMaterial = new StandardMaterial("terrainShadowCaster", scene);

  function setWireframe(enabled: boolean): void {
    terrainMaterial.wireframe = enabled;
  }

  return {
    terrainMaterial,
    buildMaterialBlend,
    resolveMaterialIndex,
    getMaterialColor,
    getBiomeBaseColor,
    listMaterialTextures,
    setShadowsEnabled,
    shadowCasterMaterial,
    setWireframe,
  };
}
