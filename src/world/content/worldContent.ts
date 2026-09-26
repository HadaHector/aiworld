import type { BiomeDefinition, BoundaryHillStyle } from "../biomes/biomeTypes";
import type { MaterialDef, MaterialLayer } from "../materials/materialTypes";
import type { GrassKindDef } from "../foliage/grassConfig";
import type { OldTrees, TreeKindDef } from "../foliage/foliageConfig";
import type { Voice } from "../naming/nameGenerator";
import type { SettlementStyle } from "../settlements/settlementConfig";

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
  biomes: BiomeDefinition[];
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
  oldTrees: OldTrees;
  voices: Record<string, Voice>;
  boundaryHillStyles: BoundaryHillStyle[];
  settlementStyles: SettlementStyle[];
}
