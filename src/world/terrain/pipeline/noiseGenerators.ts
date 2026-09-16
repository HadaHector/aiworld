import type { Noise2D } from "../noise";

export interface OctaveNoiseParams {
  octaves: number;
  baseFrequency: number;
  baseAmplitude: number;
  persistence: number;
  lacunarity: number;
}

/**
 * Ridged multifractal: each octave folds the signal via (1-|n|)^2 before summing, so the fold
 * (and resulting crest lines) happens at every scale, not just once on the final sum. This is
 * what a post-hoc `abs`/`power` step on a plain fbm sum cannot reproduce - the canyon primitive.
 */
export function ridgedNoise2D(noise2D: Noise2D, params: OctaveNoiseParams): Noise2D {
  return (worldX: number, worldZ: number): number => {
    let amplitude = params.baseAmplitude;
    let frequency = params.baseFrequency;
    let height = 0;

    for (let i = 0; i < params.octaves; i++) {
      const n = 1 - Math.abs(noise2D(worldX * frequency, worldZ * frequency));
      height += n * n * amplitude;
      amplitude *= params.persistence;
      frequency *= params.lacunarity;
    }

    return height;
  };
}

/** Billow: each octave folds via 2|n|-1 before summing - rounded, puffy bumps instead of ridges. */
export function billowNoise2D(noise2D: Noise2D, params: OctaveNoiseParams): Noise2D {
  return (worldX: number, worldZ: number): number => {
    let amplitude = params.baseAmplitude;
    let frequency = params.baseFrequency;
    let height = 0;

    for (let i = 0; i < params.octaves; i++) {
      const n = 2 * Math.abs(noise2D(worldX * frequency, worldZ * frequency)) - 1;
      height += n * amplitude;
      amplitude *= params.persistence;
      frequency *= params.lacunarity;
    }

    return height;
  };
}
