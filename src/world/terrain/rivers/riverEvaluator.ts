import { deriveSeed } from "../../rng";
import { smoothstep, lerp } from "../../mathUtils";
import { createBaseNoise2D } from "../noise";
import {
  RIVER_WIDTH_MOUTH,
  RIVER_WIDTH_SOURCE,
  RIVER_DEPTH,
  RIVER_EDGE_NOISE_FREQUENCY,
  RIVER_EDGE_NOISE_AMPLITUDE_RATIO,
  RIVER_EDGE_NOISE_SALT,
} from "./riverConfig";

export type RiverEvaluator = (isRiverEdge: boolean, riverTaper: number, borderGap: number, worldX: number, worldZ: number) => number;

/** Mirrors boundaryHillsEvaluator.ts's bell-curve shape, but simpler (no per-style pipeline map -
 *  a river doesn't need "styles") and returns a plain positive depth magnitude to subtract. */
export function createRiverEvaluator(seed: number): RiverEvaluator {
  // Dedicated, independent from every other border-jitter noise in the codebase (coastNoise2D,
  // boundary hills' edgeNoise2D, the lake-shore jitter) - the river channel's edge wobbles on its own.
  const edgeNoise2D = createBaseNoise2D(deriveSeed(seed, RIVER_EDGE_NOISE_SALT));

  return function evaluateRiver(
    isRiverEdge: boolean,
    riverTaper: number,
    borderGap: number,
    worldX: number,
    worldZ: number,
  ): number {
    if (!isRiverEdge) return 0;

    const width = lerp(RIVER_WIDTH_MOUTH, RIVER_WIDTH_SOURCE, riverTaper);
    const amplitude = width * RIVER_EDGE_NOISE_AMPLITUDE_RATIO;
    const jitter = edgeNoise2D(worldX * RIVER_EDGE_NOISE_FREQUENCY, worldZ * RIVER_EDGE_NOISE_FREQUENCY) * amplitude;
    const bell = 1 - smoothstep(0, width, borderGap + jitter);
    if (bell <= 0) return 0;

    return bell * RIVER_DEPTH;
  };
}
