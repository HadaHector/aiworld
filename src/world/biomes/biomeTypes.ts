import type { Color3 } from "@babylonjs/core";
import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";

/** Reserved for future differentiated border generation; only "smooth" is generated today. */
export type BorderType = "smooth" | "mountain" | "river" | "cliff" | "wall";

export interface BiomeColorBands {
  color0: Color3;
  height0: number;
  color1: Color3;
  height1: number;
  color2: Color3;
  height2: number;
  color3: Color3;
  height3: number;
  slopeThreshold: number; // normalY below this blends toward slopeColor
  slopeColor: Color3;
}

export interface BiomeOutputs {
  height: PipelineDef;
  // Future, unimplemented: wetness?: PipelineDef; material?: PipelineDef;
}

export interface BiomeDefinition {
  id: string;
  name: string;
  colors: BiomeColorBands;
  outputs: BiomeOutputs;
  /** A per-biome declared preference. "mountain" generates boundary hills along a qualifying edge
   *  (see cells/areaField.ts); "river"/"cliff"/"wall" remain reserved, unbranched. */
  borderType: BorderType;
  spawnWeight: number;
  /** Reserved extension point for future prop scattering; unused today. */
  propDensity?: number;
  /** Probability (0-1) any given cell inside an area of this biome becomes a lake cell. Unset/0 = never. */
  lakeChance?: number;
}
