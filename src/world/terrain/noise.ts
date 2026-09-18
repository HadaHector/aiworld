import { createNoise2D, createNoise4D } from "simplex-noise";
import { mulberry32 } from "../rng";

export type HeightSampler = (worldX: number, worldZ: number) => number;
export type Noise2D = (x: number, z: number) => number;

/**
 * Samples a single octave at (x, y) with a given frequency.
 *
 * Octave loops (fbm/ridged/billow) delegate to one of these instead of scaling their own
 * coordinates, because the two modes need the frequency applied in fundamentally different places:
 * the world-space sampler scales the input, while the tiling sampler folds frequency into a torus
 * radius (see createTilingOctaveSampler). Scaling coordinates before handing them to a tiling
 * sampler would break its periodicity for every octave past the first.
 */
export type OctaveSampler = (x: number, y: number, frequency: number) => number;

const TAU = Math.PI * 2;

/** Ordinary infinite-domain sampling - `noise2D(x * frequency, y * frequency)`, exactly what every
 *  octave loop in this project did inline before OctaveSampler existed. */
export function createWorldOctaveSampler(seed: number): OctaveSampler {
  const noise2D = createNoise2D(mulberry32(seed));
  return (x: number, y: number, frequency: number): number => noise2D(x * frequency, y * frequency);
}

/**
 * Sampling that is EXACTLY periodic with `period` in both axes - the whole point of Milestone 14,
 * used to bake material textures that tile with no seam at the wrap.
 *
 * It works by walking a torus embedded in 4D rather than a plane: x and y each drive their own
 * circle (`x -> (r·cos, r·sin)` in dims 1-2, `y` likewise in dims 3-4), and since cos/sin are
 * periodic by construction, so is the resulting 2D field. Unlike edge cross-fading or mirroring,
 * nothing is blended or duplicated - the wrap is genuinely just another interior point, so there is
 * no softened band or repeated detail to spot.
 *
 * The radius sets feature scale: going once around the tile covers arc length 2·PI·r of noise
 * space, and the flat-plane equivalent covers `period * frequency`, so r = period·frequency / 2·PI
 * reproduces the apparent scale of the non-tiling sampler for ANY frequency (no integer constraint)
 * - which is what lets every material keep its already-tuned frequencies unchanged.
 */
export function createTilingOctaveSampler(seed: number, period: number): OctaveSampler {
  const noise4D = createNoise4D(mulberry32(seed));
  const angleScale = TAU / period;
  const radiusScale = period / TAU;

  return (x: number, y: number, frequency: number): number => {
    const radius = radiusScale * frequency;
    const theta = x * angleScale;
    const phi = y * angleScale;
    return noise4D(radius * Math.cos(theta), radius * Math.sin(theta), radius * Math.cos(phi), radius * Math.sin(phi));
  };
}

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

/** Fractal Brownian motion. Whether this composes across a world (world-space sampler) or tiles
 *  seamlessly over one texture (tiling sampler) is entirely the caller's choice of `sample`. */
export function fbm(sample: OctaveSampler, worldX: number, worldZ: number, params: FbmParams): number {
  let amplitude = params.baseAmplitude;
  let frequency = params.baseFrequency;
  let height = 0;

  for (let i = 0; i < params.octaves; i++) {
    height += sample(worldX, worldZ, frequency) * amplitude;
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
  }

  return height + params.offset;
}
