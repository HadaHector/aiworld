import { Color3, Effect, RawTexture2DArray, ShaderMaterial, Texture, Vector3, type Scene } from "@babylonjs/core";
import { BIOME_REGISTRY } from "../biomes/biomeDefinitions";
import type { AreaWeight } from "../cells/areaField";
import { compilePipeline, type CompiledPipeline } from "../terrain/pipeline/pipelineCompiler";
import {
  DEFAULT_MATERIAL,
  MATERIAL_REGISTRY,
  PER_BIOME_MATERIAL_LAYERS,
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

in vec2 vUV;
in vec3 vNormal;
in vec3 vWorldPosition;
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
uniform vec3 cameraPosition;
uniform float specularMinShininess;
uniform float specularMaxShininess;
uniform float specularIntensity;

out vec4 outColor;

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

  outColor = vec4(albedo.rgb * diffuse + vec3(specular) * lightIntensity, 1.0);
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
  lightDirection: Vector3,
  lightIntensity: number,
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
      "cameraPosition",
      "specularMinShininess",
      "specularMaxShininess",
      "specularIntensity",
    ],
    samplers: ["materialAtlas", "normalAtlas"],
  });
  terrainMaterial.setTexture("materialAtlas", materialAtlas);
  terrainMaterial.setTexture("normalAtlas", normalAtlas);
  terrainMaterial.setFloat("tileScale", 1 / TEXTURE_WORLD_TILE_SIZE);
  terrainMaterial.setVector3("lightDirection", lightDirection);
  terrainMaterial.setFloat("lightIntensity", lightIntensity);
  terrainMaterial.setFloat("specularMinShininess", SPECULAR_MIN_SHININESS);
  terrainMaterial.setFloat("specularMaxShininess", SPECULAR_MAX_SHININESS);
  terrainMaterial.setFloat("specularIntensity", SPECULAR_INTENSITY);
  terrainMaterial.backFaceCulling = true;

  // cameraPosition isn't one of ShaderMaterial's automatically-bound uniform names (only the
  // world/view/projection matrix family is), so it needs a manual per-frame update for the
  // specular term's view direction - scene.activeCamera doesn't exist yet on the very first tick
  // (main.ts creates the camera after the world), hence the guard.
  scene.onBeforeRenderObservable.add(() => {
    if (scene.activeCamera) {
      terrainMaterial.setVector3("cameraPosition", scene.activeCamera.position);
    }
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
  const singleBiomeSlotCount = 1 + compiledUniversalLayers.length + maxPerBiomeLayerCount;
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

    const perAreaOverlays: { layers: CompiledLayer[]; weights: number[]; scale: number; share: number; biomeId: string }[] = [];
    for (const area of orderedAreas) {
      const layers = compiledPerBiomeLayers.get(area.biome.id) ?? [];
      const layerWeights: number[] = [];
      let overlaySum = universalSum;
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

    // Then one contiguous block per area: its base, then its own layers.
    for (const area of perAreaOverlays) {
      let overlaySum = universalSum;
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
    const emitted = order.slice().sort((a, b) => a - b);
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

  return { terrainMaterial, buildMaterialBlend, resolveMaterialIndex, getMaterialColor, getBiomeBaseColor, listMaterialTextures };
}
