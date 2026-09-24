import { BIOME_REGISTRY } from "../biomes/biomeDefinitions";
import type { AreaWeight } from "../cells/areaField";
import { compilePipeline, type CompiledPipeline } from "../terrain/pipeline/pipelineCompiler";
import {
  DEFAULT_MATERIAL,
  MATERIAL_REGISTRY,
  PER_BIOME_MATERIAL_LAYERS,
  ROAD_MATERIAL_LAYER,
  UNIVERSAL_MATERIAL_LAYERS,
  type MaterialDef,
  type MaterialLayer,
} from "./materialDefinitions";

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

/**
 * Which materials the ground is made of at a point, with no rendering attached: the material
 * registry (every material's index into the texture atlas) and the compiled weight pipelines.
 *
 * Separate from materialLibrary.ts, which owns the shader and the baked textures, so that terrain
 * chunks can be built off the main thread - a chunk build worker creates its own blender from the
 * same seed. Indices are assigned in a fixed order from the definitions, so every blender made from
 * them agrees on what each index means, and so does the texture atlas built from `materialDefs`.
 */
export interface MaterialBlender {
  /** Every distinct material, in index order - the texture atlas has one layer per entry. */
  materialDefs: MaterialDef[];
  defaultIndex: number;
  biomeBaseIndex: (biomeId: string) => number;
  buildMaterialBlend: (worldX: number, worldZ: number, context: Record<string, number>, areaWeights: AreaWeight[]) => Map<number, number>;
  resolveMaterialIndex: (worldX: number, worldZ: number, context: Record<string, number>, biomeId: string) => number;
}

export function createMaterialBlender(seed: number): MaterialBlender {
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

  return {
    materialDefs,
    defaultIndex,
    biomeBaseIndex: (biomeId) => biomeBaseIndex.get(biomeId) ?? defaultIndex,
    buildMaterialBlend,
    resolveMaterialIndex,
  };
}
