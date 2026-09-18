import { Color3, Effect, RawTexture2DArray, ShaderMaterial, Texture, Vector3, type Scene } from "@babylonjs/core";
import { BIOME_REGISTRY } from "../biomes/biomeDefinitions";
import { compilePipeline, type CompiledPipeline } from "../terrain/pipeline/pipelineCompiler";
import {
  DEFAULT_MATERIAL,
  MATERIAL_REGISTRY,
  PER_BIOME_MATERIAL_LAYERS,
  UNIVERSAL_MATERIAL_LAYERS,
  type MaterialDef,
  type MaterialLayer,
} from "./materialDefinitions";
import { TEXTURE_RESOLUTION, writeProceduralTexturePixels } from "./textureGen";

// World units per texture repeat. Chosen so CHUNK_SIZE (world.ts, 50) divides it evenly - every
// chunk boundary then falls exactly on a tile boundary too, so the tiled pattern stays in phase
// across chunks with no custom per-vertex UVs needed (see terrainMesh.ts).
const TEXTURE_WORLD_TILE_SIZE = 10;

// Below this, no layer's weight is trusted and the base material wins outright - used only by the
// legacy single-winner resolveMaterialIndex (the debug map's read path). The blended path
// (buildMaterialBlend) has no threshold: weight conservation already fades a layer out to exactly
// 0 as it loses relevance, so there's no cliff left to guard against.
const MATERIAL_WEIGHT_THRESHOLD = 0.05;

/** A pipeline that always contributes nothing - the filler buildMaterialBlend pads a biome's own
 *  overlay slots with when it has fewer per-biome layers than the biome with the most (today,
 *  hills), so every biome's blend has the SAME fixed slot count with the SAME fixed meaning per
 *  slot (see MATERIAL_SLOT_CAPACITY below). */
const ZERO_PIPELINE: CompiledPipeline = () => 0;

/**
 * One base slot + a fixed roster of overlay slots (today: the 3 universal layers, then up to
 * MAX_PER_BIOME_LAYERS per-biome layers, padded with zero-weight fillers for biomes with fewer) -
 * every vertex, in every biome, blends exactly this many materials, in exactly this slot order.
 *
 * This replaced an earlier per-TRIANGLE "pick the 2 best-matching layers" design: picking
 * independently per triangle meant two adjacent triangles could disagree on which 2 materials to
 * blend, so wherever 3+ materials were genuinely competitive (e.g. rock/rockAlt/snow on a mountain
 * slope), neighboring triangles constantly flipped identities - a hard, jagged, triangle-shaped
 * seam at every flip, not the smooth blend this milestone is for. A fixed roster with a constant
 * per-slot meaning has no identity to flip: every vertex agrees on what "slot 4" means (within one
 * biome - see the "explicitly out of scope" note on biome-base borders), so ordinary GPU
 * interpolation across shared, unexpanded vertices is correct everywhere but a biome border.
 *
 * 12 is a small round number comfortably above what's needed today (1 base + 3 universal + 5 for
 * hills, the largest per-biome list = 9) with headroom for biomes to grow a couple more layers
 * before this needs raising - still far short of blending across all ~16 materials at once.
 */
const MATERIAL_SLOT_CAPACITY = 12;

export interface MaterialLibrary {
  /** The single shader material every terrain chunk uses - blends MATERIAL_SLOT_CAPACITY materials
   *  per vertex (see terrainMesh.ts), so no MultiMaterial/SubMesh split is needed any more. */
  terrainMaterial: ShaderMaterial;
  /** The fixed-size (MATERIAL_SLOT_CAPACITY) material-index/weight roster for one point, weights
   *  summing to 1. Slot 0 is always the biome's own base material; the rest are the universal
   *  layers followed by this biome's own per-biome layers, in fixed declared order, padded with
   *  zero-weight filler slots out to MATERIAL_SLOT_CAPACITY. */
  buildMaterialBlend: (worldX: number, worldZ: number, context: Record<string, number>, biomeId: string) => { indices: number[]; weights: number[] };
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
}

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec2 uv;
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
out vec4 vMatIndices0;
out vec4 vMatIndices1;
out vec4 vMatIndices2;
out vec4 vMatWeights0;
out vec4 vMatWeights1;
out vec4 vMatWeights2;

void main() {
  vec4 worldPosition = world * vec4(position, 1.0);
  gl_Position = projection * view * worldPosition;
  vNormal = normalize((world * vec4(normal, 0.0)).xyz);
  vUV = uv * tileScale;
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
in vec4 vMatIndices0;
in vec4 vMatIndices1;
in vec4 vMatIndices2;
in vec4 vMatWeights0;
in vec4 vMatWeights1;
in vec4 vMatWeights2;

uniform sampler2DArray materialAtlas;
uniform vec3 lightDirection;
uniform float lightIntensity;

out vec4 outColor;

void main() {
  vec3 n = normalize(vNormal);
  float ndl = dot(n, normalize(lightDirection)) * 0.5 + 0.5;
  float diffuse = ndl * lightIntensity;

  vec3 color = texture(materialAtlas, vec3(vUV, vMatIndices0.x)).rgb * vMatWeights0.x
    + texture(materialAtlas, vec3(vUV, vMatIndices0.y)).rgb * vMatWeights0.y
    + texture(materialAtlas, vec3(vUV, vMatIndices0.z)).rgb * vMatWeights0.z
    + texture(materialAtlas, vec3(vUV, vMatIndices0.w)).rgb * vMatWeights0.w
    + texture(materialAtlas, vec3(vUV, vMatIndices1.x)).rgb * vMatWeights1.x
    + texture(materialAtlas, vec3(vUV, vMatIndices1.y)).rgb * vMatWeights1.y
    + texture(materialAtlas, vec3(vUV, vMatIndices1.z)).rgb * vMatWeights1.z
    + texture(materialAtlas, vec3(vUV, vMatIndices1.w)).rgb * vMatWeights1.w
    + texture(materialAtlas, vec3(vUV, vMatIndices2.x)).rgb * vMatWeights2.x
    + texture(materialAtlas, vec3(vUV, vMatIndices2.y)).rgb * vMatWeights2.y
    + texture(materialAtlas, vec3(vUV, vMatIndices2.z)).rgb * vMatWeights2.z
    + texture(materialAtlas, vec3(vUV, vMatIndices2.w)).rgb * vMatWeights2.w;

  outColor = vec4(color * diffuse, 1.0);
}
`;

/** Builds every ground material's procedural texture once per world (packed as layers of one
 *  combined array texture, so the terrain shader can blend any of them via a single sampler), and
 *  compiles every material layer's weight pipeline once (reusing the exact same pipeline engine
 *  height pipelines use - see pipeline/pipelineCompiler.ts). Several layers - or a layer and a
 *  biome's own base - may resolve to the same MaterialDef (e.g. the two snow layers), so materials
 *  are deduplicated by id before building texture layers. */
export function createMaterialLibrary(
  scene: Scene,
  seed: number,
  chunkSize: number,
  lightDirection: Vector3,
  lightIntensity: number,
): MaterialLibrary {
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

  const pixelBuffer = new Uint8Array(TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4 * materialDefs.length);
  const materialColors: Color3[] = [];
  for (let i = 0; i < materialDefs.length; i++) {
    const def = materialDefs[i];
    writeProceduralTexturePixels(pixelBuffer, i, seed, def.id, def.texture);
    materialColors.push(Color3.Lerp(def.texture.baseColor, def.texture.variationColor, 0.5));
  }

  const materialAtlas = RawTexture2DArray.CreateRGBATexture(pixelBuffer, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, materialDefs.length, scene, true, false);
  materialAtlas.wrapU = Texture.WRAP_ADDRESSMODE;
  materialAtlas.wrapV = Texture.WRAP_ADDRESSMODE;

  Effect.ShadersStore["terrainBlendVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["terrainBlendFragmentShader"] = FRAGMENT_SHADER;

  const terrainMaterial = new ShaderMaterial("terrainBlend", scene, "terrainBlend", {
    attributes: ["position", "normal", "uv", "matIndices0", "matIndices1", "matIndices2", "matWeights0", "matWeights1", "matWeights2"],
    uniforms: ["world", "view", "projection", "tileScale", "lightDirection", "lightIntensity"],
    samplers: ["materialAtlas"],
  });
  terrainMaterial.setTexture("materialAtlas", materialAtlas);
  terrainMaterial.setFloat("tileScale", chunkSize / TEXTURE_WORLD_TILE_SIZE);
  terrainMaterial.setVector3("lightDirection", lightDirection);
  terrainMaterial.setFloat("lightIntensity", lightIntensity);
  terrainMaterial.backFaceCulling = true;

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

  const maxPerBiomeLayerCount = Math.max(0, ...Object.values(PER_BIOME_MATERIAL_LAYERS).map((layers) => layers.length));
  const overlaySlotCount = compiledUniversalLayers.length + maxPerBiomeLayerCount;
  if (overlaySlotCount + 1 > MATERIAL_SLOT_CAPACITY) {
    throw new Error(`MATERIAL_SLOT_CAPACITY (${MATERIAL_SLOT_CAPACITY}) is too small for ${overlaySlotCount} overlay layers - raise it`);
  }

  // Every biome's own overlay list, padded with zero-weight filler layers up to the same fixed
  // length (maxPerBiomeLayerCount) - so slot (3 + universal-count + k) means "this biome's k-th
  // declared per-biome layer" everywhere, never "whichever layer happened to win here".
  const paddedPerBiomeLayers = new Map<string, CompiledLayer[]>();
  for (const [biomeId, layers] of compiledPerBiomeLayers) {
    const padded = layers.slice();
    while (padded.length < maxPerBiomeLayerCount) padded.push({ materialIndex: 0, evaluate: ZERO_PIPELINE });
    paddedPerBiomeLayers.set(biomeId, padded);
  }
  const emptyPerBiomeLayers: CompiledLayer[] = new Array(maxPerBiomeLayerCount).fill({ materialIndex: 0, evaluate: ZERO_PIPELINE });

  function buildMaterialBlend(worldX: number, worldZ: number, context: Record<string, number>, biomeId: string): { indices: number[]; weights: number[] } {
    const indices = new Array<number>(MATERIAL_SLOT_CAPACITY).fill(0);
    const weights = new Array<number>(MATERIAL_SLOT_CAPACITY).fill(0);

    indices[0] = biomeBaseIndex.get(biomeId) ?? defaultIndex;

    const biomeOverlays = paddedPerBiomeLayers.get(biomeId) ?? emptyPerBiomeLayers;
    let slot = 1;
    let overlaySum = 0;
    for (const layer of compiledUniversalLayers) {
      const weight = Math.max(0, layer.evaluate(worldX, worldZ, context));
      indices[slot] = layer.materialIndex;
      weights[slot] = weight;
      overlaySum += weight;
      slot++;
    }
    for (const layer of biomeOverlays) {
      const weight = Math.max(0, layer.evaluate(worldX, worldZ, context));
      indices[slot] = layer.materialIndex;
      weights[slot] = weight;
      overlaySum += weight;
      slot++;
    }

    // Weight conservation, not a threshold cliff: the base fades in/out smoothly as the overlays'
    // combined weight rises/falls, only ever giving up the remainder they don't use.
    const scale = overlaySum > 1 ? 1 / overlaySum : 1;
    for (let i = 1; i < slot; i++) weights[i] *= scale;
    weights[0] = Math.max(0, 1 - overlaySum * scale);

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

  return { terrainMaterial, buildMaterialBlend, resolveMaterialIndex, getMaterialColor, getBiomeBaseColor };
}
