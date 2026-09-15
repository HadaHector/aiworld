import { createNoise2D } from "simplex-noise";

/** Small deterministic PRNG so a numeric seed reproduces the same terrain every time. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type HeightSampler = (worldX: number, worldZ: number) => number;

const OCTAVES = 4;
const BASE_FREQUENCY = 0.018;
const BASE_AMPLITUDE = 7;
const PERSISTENCE = 0.4;
const LACUNARITY = 2.0;

/** Fractal Brownian motion height sampler, sampled in world-space so future chunks can reuse it unchanged. */
export function createHeightSampler(seed: number): HeightSampler {
  const noise2D = createNoise2D(mulberry32(seed));

  return function heightAt(worldX: number, worldZ: number): number {
    let amplitude = BASE_AMPLITUDE;
    let frequency = BASE_FREQUENCY;
    let height = 0;

    for (let i = 0; i < OCTAVES; i++) {
      height += noise2D(worldX * frequency, worldZ * frequency) * amplitude;
      amplitude *= PERSISTENCE;
      frequency *= LACUNARITY;
    }

    return height;
  };
}
