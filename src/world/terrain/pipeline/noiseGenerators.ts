import { deriveSeed, mulberry32 } from "../../rng";
import type { Noise2D, OctaveSampler } from "../noise";

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
export function ridgedNoise2D(sample: OctaveSampler, params: OctaveNoiseParams): Noise2D {
  return (worldX: number, worldZ: number): number => {
    let amplitude = params.baseAmplitude;
    let frequency = params.baseFrequency;
    let height = 0;

    for (let i = 0; i < params.octaves; i++) {
      const n = 1 - Math.abs(sample(worldX, worldZ, frequency));
      height += n * n * amplitude;
      amplitude *= params.persistence;
      frequency *= params.lacunarity;
    }

    return height;
  };
}

/** Billow: each octave folds via 2|n|-1 before summing - rounded, puffy bumps instead of ridges. */
export function billowNoise2D(sample: OctaveSampler, params: OctaveNoiseParams): Noise2D {
  return (worldX: number, worldZ: number): number => {
    let amplitude = params.baseAmplitude;
    let frequency = params.baseFrequency;
    let height = 0;

    for (let i = 0; i < params.octaves; i++) {
      const n = 2 * Math.abs(sample(worldX, worldZ, frequency)) - 1;
      height += n * amplitude;
      amplitude *= params.persistence;
      frequency *= params.lacunarity;
    }

    return height;
  };
}

/** One pseudo-random in-cell offset (both components in 0..1, so the cell's point is jittered
 *  within it rather than pinned to its center) - deterministic from (seed, cellX, cellY) via the
 *  project's existing mulberry32/deriveSeed pattern, so no point list needs generating/storing up
 *  front; any cell's point is derived on demand, which is what makes this usable as an ordinary
 *  infinite-domain Noise2D-like function. Returns the OFFSET rather than an absolute position so
 *  the caller can look a point up under wrapped cell coordinates while still placing it at its
 *  unwrapped location - the whole trick behind tiling Worley (see worleyNoise2D). */
function cellOffset(seed: number, cellX: number, cellY: number): { x: number; y: number } {
  const cellSeed = deriveSeed(deriveSeed(seed, (cellX * 0x1f1f1f1f) >>> 0), (cellY * 0x2c2c2c2c) >>> 0);
  const rng = mulberry32(cellSeed);
  return { x: rng(), y: rng() };
}

function wrapCell(value: number, cellsPerTile: number): number {
  if (cellsPerTile === 0) return value;
  return ((value % cellsPerTile) + cellsPerTile) % cellsPerTile;
}

/**
 * Cellular/Worley noise (see WorleyNoiseSpec in pipelineTypes.ts for the "f1" vs "edge" shapes).
 * Searches the query point's own grid cell plus its 8 neighbors - enough to always find the true
 * nearest and second-nearest points given each cell holds exactly one jittered point.
 *
 * With `tilePeriod` set, the result is exactly periodic over that many input units: each cell's
 * point is looked up under cell coordinates wrapped modulo the tile's cell count, while staying
 * geometrically placed at its unwrapped position - so a query just past the wrap finds the same
 * points, in the same relative arrangement, as one just before it. The torus trick the other noise
 * types use (see createTilingOctaveSampler) doesn't apply here because Worley's domain is its own
 * integer cell grid, not a continuous noise field.
 *
 * Exact tiling needs a whole number of cells across the tile, so the cell count is rounded and the
 * effective frequency snaps to match it - at the frequencies the core pack's materials actually use
 * this shifts feature scale by only a few percent.
 */
export function worleyNoise2D(
  seed: number,
  frequency: number,
  tilePeriod?: number,
  stretchX = 1,
  stretchY = 1,
): (worldX: number, worldZ: number) => { f1: number; f2: number } {
  // Stretching is a different cell count per axis - taller cells for a vertical stretch - and each
  // axis rounds to a whole number of cells across the tile on its own.
  const frequencyX = frequency / stretchX;
  const frequencyY = frequency / stretchY;
  const cellsX = tilePeriod === undefined ? 0 : Math.max(1, Math.round(tilePeriod * frequencyX));
  const cellsY = tilePeriod === undefined ? 0 : Math.max(1, Math.round(tilePeriod * frequencyY));
  const effectiveFrequencyX = tilePeriod === undefined ? frequencyX : cellsX / tilePeriod;
  const effectiveFrequencyY = tilePeriod === undefined ? frequencyY : cellsY / tilePeriod;

  return (worldX: number, worldZ: number) => {
    const x = worldX * effectiveFrequencyX;
    const y = worldZ * effectiveFrequencyY;
    const cellX = Math.floor(x);
    const cellY = Math.floor(y);

    let f1 = Infinity;
    let f2 = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const neighborX = cellX + dx;
        const neighborY = cellY + dy;
        const offset = cellOffset(seed, wrapCell(neighborX, cellsX), wrapCell(neighborY, cellsY));
        const ddx = neighborX + offset.x - x;
        const ddy = neighborY + offset.y - y;
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
