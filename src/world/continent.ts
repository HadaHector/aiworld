import { createBaseNoise2D, type Noise2D } from "./terrain/noise";
import { deriveSeed } from "./rng";
import { smoothstep } from "./mathUtils";

export interface ContinentSample {
  landmass: number;
  isLand: boolean;
}

export type ContinentSampler = (worldX: number, worldZ: number) => ContinentSample;

export const SEA_LEVEL = 0;
export const CONTINENT_CENTER_X = 0;
export const CONTINENT_CENTER_Z = 0;
export const CONTINENT_RADIUS_WORLD = 320;

const COAST_FALLOFF_INNER = 0.82; // fraction of radius
const COAST_FALLOFF_OUTER = 1.0; // fraction of radius
const WARP_FREQUENCY = 0.004;
const WARP_AMPLITUDE = 45;
const WARP_DECORRELATION_OFFSET = 91.7;
const COAST_NOISE_FREQUENCY = 0.015;
const COAST_NOISE_AMPLITUDE = 0.22;

const WARP_SALT = 101;
const COAST_NOISE_SALT = 202;

/**
 * Radial falloff distorted by domain warp and perturbed by bounded coastal noise.
 * The noise amplitude (0.35) is smaller than the falloff's unsaturated range, so it can only
 * flip land/ocean near the coastline band — it can't punch islands far out or holes in the core.
 */
export function createContinentSampler(seed: number): ContinentSampler {
  const warpNoise2D: Noise2D = createBaseNoise2D(deriveSeed(seed, WARP_SALT));
  const coastNoise2D: Noise2D = createBaseNoise2D(deriveSeed(seed, COAST_NOISE_SALT));

  return function sampleContinent(worldX: number, worldZ: number): ContinentSample {
    const warpX = worldX + warpNoise2D(worldX * WARP_FREQUENCY, worldZ * WARP_FREQUENCY) * WARP_AMPLITUDE;
    const warpZ =
      worldZ +
      warpNoise2D(
        worldX * WARP_FREQUENCY + WARP_DECORRELATION_OFFSET,
        worldZ * WARP_FREQUENCY + WARP_DECORRELATION_OFFSET,
      ) *
        WARP_AMPLITUDE;

    const dx = warpX - CONTINENT_CENTER_X;
    const dz = warpZ - CONTINENT_CENTER_Z;
    const distance = Math.sqrt(dx * dx + dz * dz) / CONTINENT_RADIUS_WORLD;

    const falloff = 1 - smoothstep(COAST_FALLOFF_INNER, COAST_FALLOFF_OUTER, distance);
    const coastNoise = coastNoise2D(worldX * COAST_NOISE_FREQUENCY, worldZ * COAST_NOISE_FREQUENCY) * COAST_NOISE_AMPLITUDE;
    const landmass = falloff * 2 - 1 + coastNoise;

    return { landmass, isLand: landmass > 0 };
  };
}
