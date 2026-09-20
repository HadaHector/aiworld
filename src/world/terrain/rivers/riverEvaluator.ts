import { deriveSeed } from "../../rng";
import { smoothstep, lerp } from "../../mathUtils";
import { createBaseNoise2D } from "../noise";
import {
  RIVER_BED_HEIGHT_MOUTH,
  RIVER_BED_HEIGHT_SOURCE,
  RIVER_BED_HALF_WIDTH_MOUTH,
  RIVER_BED_HALF_WIDTH_SOURCE,
  RIVER_BANK_SLOPE,
  RIVER_VALLEY_REACH,
  RIVER_VALLEY_FADE_START,
  RIVER_EDGE_NOISE_FREQUENCY,
  RIVER_EDGE_NOISE_AMPLITUDE_RATIO,
  RIVER_EDGE_NOISE_SALT,
} from "./riverConfig";

/** Takes the land height this point would otherwise have and returns it with the river valley cut
 *  into it - not a depth to subtract from it. See riverConfig.ts for why. */
export type RiverEvaluator = (
  isRiverEdge: boolean,
  riverTaper: number,
  riverGap: number,
  worldX: number,
  worldZ: number,
  landHeight: number,
) => number;

/**
 * Clips the terrain down to a valley profile: a flat bed at an absolute height, and a bank that
 * climbs out of it at a constant gradient until it meets the ground again.
 *
 * Unlike boundaryHillsEvaluator.ts's bell curve - which this used to mirror - the profile is not
 * subtracted from the terrain, it *replaces* it wherever the terrain is higher. That is the whole
 * point: a subtraction carries the terrain's own shape down with it, so a channel on high ground
 * stays on high ground and never reaches the water plane, while the same bell curve on flat ground
 * is a bowl rather than a valley with banks. Clipping to a profile gives the same channel whatever
 * is above it, and the bank is what the terrain is clipped *along* rather than a separate feature.
 *
 * "Remove the positive part of (terrain - profile)" and "take the lower of terrain and profile" are
 * the same operation written two ways; it is spelled as a depth here because the fade below has to
 * act on the depth rather than on the height.
 */
export function createRiverEvaluator(seed: number): RiverEvaluator {
  // Dedicated, independent from every other border-jitter noise in the codebase (coastNoise2D,
  // boundary hills' edgeNoise2D, the lake-shore jitter) - the river channel's edge wobbles on its own.
  const edgeNoise2D = createBaseNoise2D(deriveSeed(seed, RIVER_EDGE_NOISE_SALT));

  return function carveRiver(isRiverEdge, riverTaper, riverGap, worldX, worldZ, landHeight) {
    if (!isRiverEdge) return landHeight;

    const bedHalfWidth = lerp(RIVER_BED_HALF_WIDTH_MOUTH, RIVER_BED_HALF_WIDTH_SOURCE, riverTaper);
    const bedHeight = lerp(RIVER_BED_HEIGHT_MOUTH, RIVER_BED_HEIGHT_SOURCE, riverTaper);

    const jitter =
      edgeNoise2D(worldX * RIVER_EDGE_NOISE_FREQUENCY, worldZ * RIVER_EDGE_NOISE_FREQUENCY) *
      bedHalfWidth *
      RIVER_EDGE_NOISE_AMPLITUDE_RATIO;
    // Jitter can push a point past the centerline; the bed is flat there anyway, and a negative
    // distance would make the bank start climbing again on the wrong side of it.
    const distance = Math.max(0, riverGap + jitter);

    const valleyOuter = bedHalfWidth + RIVER_VALLEY_REACH;
    if (distance >= valleyOuter) return landHeight;

    const profile = bedHeight + RIVER_BANK_SLOPE * Math.max(0, distance - bedHalfWidth);
    const depth = Math.max(0, landHeight - profile);
    if (depth <= 0) return landHeight;

    // Forced to zero by valleyOuter whether or not the bank has caught up to the terrain - see
    // RIVER_VALLEY_REACH. Where it has caught up (the overwhelmingly common case) depth is already
    // 0 out here and this multiplies nothing.
    const fadeStart = bedHalfWidth + RIVER_VALLEY_REACH * RIVER_VALLEY_FADE_START;
    const fade = 1 - smoothstep(fadeStart, valleyOuter, distance);

    return landHeight - depth * fade;
  };
}
