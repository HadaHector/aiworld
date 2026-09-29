import type { AreaWeight } from "../cells/areaField";
import { compilePipeline, type CompiledPipeline } from "../terrain/pipeline/pipelineCompiler";
import type { WorldContent } from "../content/worldContent";
import type { GrassSpec, MaterialDef } from "./materialTypes";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import { isNoAdjust, type ColorAdjust } from "./colorAdjust";

/** How an area recolours one material: its ground's adjustment, then each of its tints for the
 *  material's family - leaving out any that change nothing. */
function areaAdjustsFor(def: MaterialDef, biome: BiomeDefinition): ColorAdjust[] {
  const tints = biome.groundTints.filter((tint) => def.family !== undefined && tint.family === def.family).map((tint) => tint.adjust);
  return [biome.groundAdjust, ...tints].filter((adjust) => !isNoAdjust(adjust));
}

/** What an area grows on one material besides the material's own grass: its `ground.grass` entries
 *  for the material's family. */
function areaGrassFor(def: MaterialDef, biome: BiomeDefinition): GrassSpec[] {
  return biome.groundGrass.filter((entry) => def.family !== undefined && entry.family === def.family).map((entry) => entry.spec);
}

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
 * same seed and the same area list. Indices are assigned in a fixed order from the definitions and
 * the areas, so every blender made from them agrees on what each index means, and so does the
 * texture atlas built from `materialDefs`.
 *
 * An area whose biome recolours its ground (`ground.adjust`) gets its own variant of every
 * material it draws - the same texture, its own index and colour - so a material is not one index
 * but one per distinct recolouring. Areas that recolour alike share their variants.
 */
export interface MaterialBlender {
  /** Every distinct material and variant, in index order. */
  materialDefs: MaterialDef[];
  defaultIndex: number;
  biomeBaseIndex: (biome: BiomeDefinition) => number;
  buildMaterialBlend: (worldX: number, worldZ: number, context: Record<string, number>, areaWeights: AreaWeight[]) => Map<number, number>;
  resolveMaterialIndex: (worldX: number, worldZ: number, context: Record<string, number>, biome: BiomeDefinition) => number;
}

/** A variant's key: the material, how its area recolours it and what extra grass the area grows on
 *  it - or just the material when the area does neither. */
function variantKey(id: string, adjusts: readonly ColorAdjust[], extraGrass: readonly GrassSpec[]): string {
  return [
    id,
    ...adjusts.map((adjust) => `${adjust.hue},${adjust.saturation},${adjust.value},${adjust.tint.join(",")}`),
    ...extraGrass.map((spec) => `+${spec.kind}:${spec.density}:${spec.color.join(",")}`),
  ].join("|");
}

/**
 * `areaBiomes` are the world's areas' own rolls of their biomes (see cells/areaField.ts); every one
 * of them has its ground compiled here, up front and in order, which is what keeps the indices the
 * same in every thread. A biome object not among them or `content.biomes` - there should be none -
 * is drawn as its biome's middle roll.
 */
export function createMaterialBlender(seed: number, content: WorldContent, areaBiomes: readonly BiomeDefinition[]): MaterialBlender {
  const materialDefs: MaterialDef[] = [];
  const materialIndexByKey = new Map<string, number>();
  const definitionById = new Map(content.materials.map((def) => [def.id, def]));

  // Only materials something actually uses get an index, and so a place in the material table.
  // `biome`, when given, is the area's: its ground adjustment, whichever of its tints are for this
  // material's family and whatever extra grass it grows on that family make the variant.
  function ensureMaterial(id: string, biome?: BiomeDefinition): number {
    const def = definitionById.get(id);
    if (!def) throw new Error(`Unknown material "${id}"`);
    const adjusts = biome ? areaAdjustsFor(def, biome) : [];
    const extraGrass = biome ? areaGrassFor(def, biome) : [];
    const key = variantKey(id, adjusts, extraGrass);
    let index = materialIndexByKey.get(key);
    if (index === undefined) {
      index = materialDefs.length;
      materialIndexByKey.set(key, index);
      materialDefs.push(
        adjusts.length === 0 && extraGrass.length === 0
          ? def
          : { ...def, ...(adjusts.length > 0 ? { areaAdjusts: adjusts } : {}), ...(extraGrass.length > 0 ? { grass: [...def.grass, ...extraGrass] } : {}) },
      );
    }
    return index;
  }

  // The unrecoloured materials first, in the order they always had, so a world with no ground
  // adjustments numbers its materials exactly as before.
  const defaultIndex = ensureMaterial(content.defaultMaterialId);
  for (const biome of content.biomes) ensureMaterial(biome.baseMaterialId);
  for (const layer of content.universalLayers) ensureMaterial(layer.materialId);
  ensureMaterial(content.roadLayer.materialId);
  for (const biome of content.biomes) ensureMaterial(biome.roadMaterialId);
  for (const biome of content.biomes) {
    for (const layer of biome.materialLayers) ensureMaterial(layer.materialId);
  }

  interface CompiledLayer {
    materialIndex: number;
    evaluate: CompiledPipeline;
  }

  /** What one area's ground is made of: its base and road, which variant each universal layer
   *  paints here, and its own layers - each area's compiled with its own noise seeds. */
  interface AreaGround {
    base: number;
    road: number;
    universal: number[];
    layers: CompiledLayer[];
  }

  // Compiled once per universal layer, not per area - a universal layer is the same shape
  // everywhere; only the variant of its material it paints is the area's.
  const compiledUniversalLayers = content.universalLayers.map((layer) => compilePipeline(layer.weight, seed, `material-${layer.id}`));
  const compiledRoadLayer = compilePipeline(content.roadLayer.weight, seed, `material-${content.roadLayer.id}`);

  // Each area walks only the universal list plus ITS OWN biome's layers, so per-vertex cost stays
  // flat as more biomes grow their own layers, instead of scaling with every biome's put together.
  function compileGround(biome: BiomeDefinition): AreaGround {
    return {
      base: ensureMaterial(biome.baseMaterialId, biome),
      road: ensureMaterial(biome.roadMaterialId, biome),
      universal: content.universalLayers.map((layer) => ensureMaterial(layer.materialId, biome)),
      layers: biome.materialLayers.map((layer) => ({
        materialIndex: ensureMaterial(layer.materialId, biome),
        // A biome's middle roll keeps the layer's own name for a seed; an area's roll adds its own.
        evaluate: compilePipeline(layer.weight, seed, biome.seedKey === biome.id ? `material-${layer.id}` : `material-${layer.id}|${biome.seedKey}`),
      })),
    };
  }

  const groundOf = new Map<BiomeDefinition, AreaGround>();
  const groundById = new Map<string, AreaGround>();
  for (const biome of content.biomes) {
    const ground = compileGround(biome);
    groundOf.set(biome, ground);
    groundById.set(biome.id, ground);
  }
  for (const biome of areaBiomes) {
    if (!groundOf.has(biome)) groundOf.set(biome, compileGround(biome));
  }
  const groundFor = (biome: BiomeDefinition): AreaGround => groundOf.get(biome) ?? groundById.get(biome.id)!;

  /**
   * Every material's weight at one point, blending every area that has a say there. Weights sum to
   * 1; materials with no weight are left out.
   *
   * Each area contributes the result of the ordinary single-biome blend - its own base plus the
   * universal layers plus its per-biome layers, weight-conserved - scaled by that area's share.
   * Contributions accumulate per MATERIAL rather than per layer, so two layers pointing at the same
   * material, or two areas recolouring alike, merge. Which of these a triangle actually draws is
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
      const weight = Math.max(0, layer(worldX, worldZ, context));
      universalWeights.push(weight);
      universalSum += weight;
    }

    // The road's weight is the same everywhere - the layer is one pipeline over roadGap - so it is
    // evaluated once here and only its MATERIAL varies per area below. The road is laid on top:
    // it takes its weight first and every other layer shares what is left. Sharing evenly, a road
    // through a wood came out half forest floor, and that half's own height - leaves, fine and high -
    // won through at every dip of the road's surface, as a sparkle that crawled when the camera moved.
    const roadWeight = Math.min(1, Math.max(0, compiledRoadLayer(worldX, worldZ, context)));
    const offRoad = 1 - roadWeight;

    for (const area of areaWeights) {
      const ground = groundFor(area.biome);
      const layers = ground.layers;
      const layerWeights: number[] = [];
      let overlaySum = universalSum;
      for (const layer of layers) {
        const weight = Math.max(0, layer.evaluate(worldX, worldZ, context));
        layerWeights.push(weight);
        overlaySum += weight;
      }
      // Same weight conservation as the single-biome case, applied within this area's own blend -
      // within what the road leaves.
      const scale = overlaySum > 1 ? offRoad / overlaySum : offRoad;
      const share = area.weight;
      for (let i = 0; i < compiledUniversalLayers.length; i++) {
        add(ground.universal[i], universalWeights[i] * scale * share);
      }
      add(ground.road, roadWeight * share);
      add(ground.base, Math.max(0, offRoad - overlaySum * scale) * share);
      for (let i = 0; i < layers.length; i++) {
        add(layers[i].materialIndex, layerWeights[i] * scale * share);
      }
    }

    return weightByMaterial;
  }

  function resolveMaterialIndex(worldX: number, worldZ: number, context: Record<string, number>, biome: BiomeDefinition): number {
    const ground = groundFor(biome);
    let bestIndex = ground.base;
    let bestWeight = MATERIAL_WEIGHT_THRESHOLD;

    compiledUniversalLayers.forEach((layer, i) => {
      const weight = layer(worldX, worldZ, context);
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIndex = ground.universal[i];
      }
    });
    const roadWeight = compiledRoadLayer(worldX, worldZ, context);
    if (roadWeight > bestWeight) {
      bestWeight = roadWeight;
      bestIndex = ground.road;
    }
    for (const layer of ground.layers) {
      const weight = layer.evaluate(worldX, worldZ, context);
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIndex = layer.materialIndex;
      }
    }

    return bestIndex;
  }

  return {
    materialDefs,
    defaultIndex,
    biomeBaseIndex: (biome) => groundFor(biome).base,
    buildMaterialBlend,
    resolveMaterialIndex,
  };
}
