import { deriveSeed, mulberry32 } from "../../rng";
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

/** One pseudo-random point per grid cell, jittered within the cell (not pinned to its center) -
 *  deterministic from (seed, cellX, cellY) via the project's existing mulberry32/deriveSeed
 *  pattern, so no point list needs generating/storing up front; any cell's point is derived on
 *  demand, which is what makes this usable as an ordinary infinite-domain Noise2D-like function. */
function cellPoint(seed: number, cellX: number, cellY: number): { x: number; y: number } {
  const cellSeed = deriveSeed(deriveSeed(seed, (cellX * 0x1f1f1f1f) >>> 0), (cellY * 0x2c2c2c2c) >>> 0);
  const rng = mulberry32(cellSeed);
  return { x: cellX + rng(), y: cellY + rng() };
}

/** Cellular/Worley noise (see WorleyNoiseSpec in pipelineTypes.ts for the "f1" vs "edge" shapes).
 *  Searches the query point's own grid cell plus its 8 neighbors - enough to always find the true
 *  nearest and second-nearest points given each cell holds exactly one jittered point. */
export function worleyNoise2D(seed: number, frequency: number): (worldX: number, worldZ: number) => { f1: number; f2: number } {
  return (worldX: number, worldZ: number) => {
    const x = worldX * frequency;
    const y = worldZ * frequency;
    const cellX = Math.floor(x);
    const cellY = Math.floor(y);

    let f1 = Infinity;
    let f2 = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const point = cellPoint(seed, cellX + dx, cellY + dy);
        const ddx = point.x - x;
        const ddy = point.y - y;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist < f1) {
          f2 = f1;
          f1 = dist;
        } else if (dist < f2) {
          f2 = dist;
        }
      }
    }
    return { f1, f2 };
  };
}
