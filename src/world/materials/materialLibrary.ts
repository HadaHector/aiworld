import { Color3, MultiMaterial, StandardMaterial, type Scene } from "@babylonjs/core";
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
import { generateProceduralTexture } from "./textureGen";

// World units per texture repeat. Chosen so CHUNK_SIZE (world.ts, 50) divides it evenly - every
// chunk boundary then falls exactly on a tile boundary too, so the tiled pattern stays in phase
// across chunks with no custom per-vertex UVs needed (see terrainMesh.ts).
const TEXTURE_WORLD_TILE_SIZE = 10;

// Below this, no layer's weight is trusted and the base material wins - avoids a near-zero weight
// (e.g. a sliver of rock right at the slope threshold) flickering in over the default ground.
const MATERIAL_WEIGHT_THRESHOLD = 0.05;

export interface MaterialLibrary {
  multiMaterial: MultiMaterial;
  resolveMaterialIndex: (worldX: number, worldZ: number, context: Record<string, number>, biomeId: string) => number;
  /** A representative swatch (the midpoint of its procedural texture's two colors) for a resolved
   *  material index - used by the debug map, which draws to a 2D canvas and has no Babylon
   *  Material/Texture of its own to sample from. */
  getMaterialColor: (materialIndex: number) => Color3;
  /** A biome's own base material's swatch, with no overlay layers evaluated - what the debug
   *  map's coarse World view shows, since resolving overlays isn't worth it at that zoom level. */
  getBiomeBaseColor: (biomeId: string) => Color3;
}

/** Builds every ground material + its procedural texture once per world, and compiles every
 *  material layer's weight pipeline once (reusing the exact same pipeline engine height pipelines
 *  use - see pipeline/pipelineCompiler.ts). Several layers - or a layer and a biome's own base -
 *  may resolve to the same MaterialDef (e.g. the two snow layers), so materials are deduplicated
 *  by id before building subMaterials. */
export function createMaterialLibrary(scene: Scene, seed: number, chunkSize: number): MaterialLibrary {
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

  const multiMaterial = new MultiMaterial("terrainMaterials", scene);
  const materialColors: Color3[] = [];
  for (const def of materialDefs) {
    const material = new StandardMaterial(`terrainMaterial_${def.id}`, scene);
    const texture = generateProceduralTexture(scene, seed, def.id, def.texture);
    texture.uScale = chunkSize / TEXTURE_WORLD_TILE_SIZE;
    texture.vScale = chunkSize / TEXTURE_WORLD_TILE_SIZE;
    material.diffuseTexture = texture;
    material.specularColor = Color3.Black();
    multiMaterial.subMaterials.push(material);
    materialColors.push(Color3.Lerp(def.texture.baseColor, def.texture.variationColor, 0.5));
  }

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

  // Compiled once per biome (not once globally) - resolveMaterialIndex below only ever walks the
  // universal list plus THIS biome's own list, so per-face cost stays flat as more biomes grow
  // their own layers, instead of scaling with the total layer count across every biome combined.
  const compiledUniversalLayers = compileLayers(UNIVERSAL_MATERIAL_LAYERS);
  const compiledPerBiomeLayers = new Map<string, CompiledLayer[]>();
  for (const [biomeId, layers] of Object.entries(PER_BIOME_MATERIAL_LAYERS)) {
    compiledPerBiomeLayers.set(biomeId, compileLayers(layers));
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

  return { multiMaterial, resolveMaterialIndex, getMaterialColor, getBiomeBaseColor };
}
