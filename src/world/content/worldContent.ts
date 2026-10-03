import type { BiomeDefinition, BoundaryHillStyle } from "../biomes/biomeTypes";
import type { MaterialDef, MaterialLayer } from "../materials/materialTypes";
import type { GrassKindDef } from "../foliage/grassConfig";
import type { OldTrees, TreeKindDef } from "../foliage/foliageConfig";
import type { Voice } from "../naming/nameGenerator";
import type { SettlementStyle } from "../settlements/settlementConfig";
import type { Defaults } from "./resolveContent";
import type { WeatherDef } from "../weather/weatherTypes";
import type { FeatureKindDef } from "../features/featureTypes";
import type { BuildingDef, BuildingMaterialDef } from "../buildings/buildingTypes";

/**
 * Everything a world is generated from that is content rather than code: its biomes, ground
 * materials, plants, name voices, border hill styles and settlement styles.
 *
 * Loaded from the packs in public/packs (see content/resolveContent.ts) and plain data throughout -
 * no class instances, no functions - so the same object is handed to the chunk build workers as is.
 * Every list is in a fixed order decided when the packs are resolved, and generation depends on
 * that order (the biome roulette, a tree's species, a grass kind's index), so everything built from
 * one WorldContent agrees with everything else built from it.
 */
export interface WorldContent {
  /** Every biome as its middle roll (see content/biomeRolls.ts) - what picks a biome for an area,
   *  and what a biome is when shown alone. The world's areas each have their own roll of theirs
   *  (content/resolveContent.ts's rollAreaBiome). */
  biomes: BiomeDefinition[];
  /** Each biome's file as written, by id, for rolling per area; `rolls` says whether it rolls anything. */
  biomeSources: Record<string, { file: string; data: Record<string, unknown>; rolls: boolean }>;
  biomeDefaults: Defaults;
  /** Every material any pack defines. Only the ones something uses get a texture - see
   *  materials/materialBlend.ts. */
  materials: MaterialDef[];
  /** What the ground falls back to where nothing else applies - always texture index 0. */
  defaultMaterialId: string;
  /** Layers checked at every point, whatever the biome (rock, shore). Kept few and cheap. */
  universalLayers: MaterialLayer[];
  /**
   * The road surface. One layer reaching everywhere, but what it paints is each biome's own
   * roadMaterialId - so its shape is universal and its surface local. Its own `materialId` is
   * the fallback for a biome with no road material.
   */
  roadLayer: MaterialLayer;
  grassKinds: GrassKindDef[];
  treeKinds: TreeKindDef[];
  /** Bushes are drawn by the same renderer as trees, so their ids share one namespace with them. */
  bushKinds: TreeKindDef[];
  /** Boulders - placed on the trees' lattice and drawn by the same renderer, so their ids share the
   *  trees' and bushes' namespace too. */
  rockKinds: TreeKindDef[];
  oldTrees: OldTrees;
  voices: Record<string, Voice>;
  boundaryHillStyles: BoundaryHillStyle[];
  settlementStyles: SettlementStyle[];
  /** Every kind of weather (a pack's weathers/ folder) - what a biome's `weather` list names. */
  weathers: WeatherDef[];
  /** Every kind of cell feature (a pack's features/ folder) - what a biome's `features` list names. */
  featureKinds: FeatureKindDef[];
  /** Every building (a pack's buildings/ folder) - what features place. */
  buildings: BuildingDef[];
  /** What buildings are made of (a pack's buildingMaterials/ folder). */
  buildingMaterials: BuildingMaterialDef[];
}
