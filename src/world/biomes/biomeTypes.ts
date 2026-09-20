import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { VoiceId } from "../naming/nameGenerator";

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
  /** Reserved extension point for future prop scattering; unused today. */
  propDensity?: number;
  /** Probability (0-1) any given cell inside an area of this biome becomes a lake cell. Unset/0 = never. */
  lakeChance?: number;
  /** MaterialDef id (materials/materialDefinitions.ts's MATERIAL_REGISTRY) this biome's ground
   *  texture falls back to wherever no overlay layer (rock/sand/snow) outweighs it. */
  baseMaterialId: string;
}
