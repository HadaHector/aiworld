import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { VoiceId } from "../naming/nameGenerator";
import type { TreeKind } from "../foliage/foliageConfig";

/** Reserved for future differentiated border generation; only "smooth" is generated today. */
export type BorderType = "smooth" | "mountain" | "river" | "cliff" | "wall";

export interface BiomeOutputs {
  height: PipelineDef;
  // Future, unimplemented: wetness?: PipelineDef; material?: PipelineDef;
}

export interface BiomeDefinition {
  id: string;
  name: string;
  /** Which phonetic palette this biome's zones are named from (naming/nameGenerator.ts). A property
   *  of the biome rather than a lookup table elsewhere, so adding a biome cannot forget to set it. */
  voiceId: VoiceId;
  outputs: BiomeOutputs;
  /** A per-biome declared preference. "mountain" generates boundary hills along a qualifying edge
   *  (see cells/areaField.ts); "river"/"cliff"/"wall" remain reserved, unbranched. */
  borderType: BorderType;
  spawnWeight: number;
  /** How much of the tree lattice this biome actually grows, 0-1, before the slope, shore,
   *  treeline, road and grove fades thin it further (see foliage/treeScatter.ts). 1 would be every
   *  trunk the TREE_SPACING hard core allows - a closed wood - and 0 is treeless. */
  treeDensity: number;
  /** Which of the tree archetypes (foliage/treeModels.ts) this biome grows. A tree at a zone
   *  border picks between its neighbours by how many of the trees there each one is responsible
   *  for, so the two mix along the edge rather than meeting at a line. */
  treeKind: TreeKind;
  /** Probability (0-1) any given cell inside an area of this biome becomes a lake cell. Unset/0 = never. */
  lakeChance?: number;
  /** MaterialDef id (materials/materialDefinitions.ts's MATERIAL_REGISTRY) this biome's ground
   *  texture falls back to wherever no overlay layer (rock/sand/snow) outweighs it. */
  baseMaterialId: string;
  /** The surface a road through this zone is made of, as a MATERIAL_REGISTRY key. Roads are graded
   *  into the terrain and painted by one layer that reaches everywhere, but what that layer paints
   *  is the zone's own choice - a track through a desert is not a track through a forest. Biomes
   *  may share one, and sharing is what keeps the material roster small at a border between them. */
  roadMaterialId: string;
}
