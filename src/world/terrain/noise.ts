import { createNoise2D } from "simplex-noise";
import { mulberry32 } from "../rng";

export type HeightSampler = (worldX: number, worldZ: number) => number;
export type Noise2D = (x: number, z: number) => number;

export interface FbmParams {
  octaves: number;
  baseFrequency: number;
  baseAmplitude: number;
  persistence: number;
  lacunarity: number;
  offset: number;
}

export const DEFAULT_FBM_PARAMS: FbmParams = {
  octaves: 4,
  baseFrequency: 0.018,
  baseAmplitude: 7,
  persistence: 0.4,
  lacunarity: 2.0,
  offset: 0,
};

export function createBaseNoise2D(seed: number): Noise2D {
  return createNoise2D(mulberry32(seed));
}

/** Fractal Brownian motion, sampled in world-space so it composes cleanly across biomes/chunks. */
export function fbm(noise2D: Noise2D, worldX: number, worldZ: number, params: FbmParams): number {
  let amplitude = params.baseAmplitude;
  let frequency = params.baseFrequency;
  let height = 0;

  for (let i = 0; i < params.octaves; i++) {
    height += noise2D(worldX * frequency, worldZ * frequency) * amplitude;
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
  }

  return height + params.offset;
}
