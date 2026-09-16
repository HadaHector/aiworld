import { deriveSeed } from "../../rng";
import { smoothstep } from "../../mathUtils";
import { createBaseNoise2D } from "../noise";
import { RIVER_WIDTH, RIVER_DEPTH, RIVER_EDGE_NOISE_FREQUENCY, RIVER_EDGE_NOISE_AMPLITUDE, RIVER_EDGE_NOISE_SALT } from "./riverConfig";

export type RiverEvaluator = (isRiverEdge: boolean, borderGap: number, worldX: number, worldZ: number) => number;

/** Mirrors boundaryHillsEvaluator.ts's bell-curve shape, but simpler (no per-style pipeline map -
 *  a river doesn't need "styles") and returns a plain positive depth magnitude to subtract. */
export function createRiverEvaluator(seed: number): RiverEvaluator {
  // Dedicated, independent from every other border-jitter noise in the codebase (coastNoise2D,
  // boundary hills' edgeNoise2D, the lake-shore jitter) - the river channel's edge wobbles on its own.
  const edgeNoise2D = createBaseNoise2D(deriveSeed(seed, RIVER_EDGE_NOISE_SALT));

  return function evaluateRiver(isRiverEdge: boolean, borderGap: number, worldX: number, worldZ: number): number {
    if (!isRiverEdge) return 0;

    const jitter =
      edgeNoise2D(worldX * RIVER_EDGE_NOISE_FREQUENCY, worldZ * RIVER_EDGE_NOISE_FREQUENCY) * RIVER_EDGE_NOISE_AMPLITUDE;
    const bell = 1 - smoothstep(0, RIVER_WIDTH, borderGap + jitter);
    if (bell <= 0) return 0;

    return bell * RIVER_DEPTH;
  };
}
