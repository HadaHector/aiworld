import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { VoiceId } from "../naming/nameGenerator";

/** Reserved for future differentiated border generation; only "smooth" is generated today. */
export type BorderType = "smooth" | "mountain" | "river" | "cliff" | "wall";

export interface BiomeOutputs {
  height: PipelineDef;
  /**
   * How thickly this zone grows each kind of tree, as one graph with a named output per TreeKind
   * (foliage/treeModels.ts) - so a zone is not one species at one density, it is a density *map*
   * per species, and two species can share ground with the mix shifting across it.
   *
   * A kind with no output does not grow here. Each output reads as a 0-1 share of the scatter
   * lattice (see foliage/treeScatter.ts) and the world's own rules - water, roads, cliffs, the
   * treeline - thin whatever this asks for afterwards.
   *
   * One graph rather than one per species so shared work is shared: a "how wooded is it here"
   * noise feeding both broadleaf and pine is evaluated once per sample, not once per output.
   *
   * Besides noise, the graph can read named values of the ground it is being asked about via
   * `op: "input"` - "height", "slope", "riverGap", "roadGap", "lakeFactor" and "areaBorderGap" -
   * which is what lets a zone put conifers up its slopes and broadleaf in its valleys, or gather
   * palms at its water.
   */
  foliage?: PipelineDef;
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
