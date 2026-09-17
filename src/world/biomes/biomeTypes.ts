import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";

/** Reserved for future differentiated border generation; only "smooth" is generated today. */
export type BorderType = "smooth" | "mountain" | "river" | "cliff" | "wall";

export interface BiomeOutputs {
  height: PipelineDef;
  // Future, unimplemented: wetness?: PipelineDef; material?: PipelineDef;
}

export interface BiomeDefinition {
  id: string;
  name: string;
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
