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
 *
 * |n| has a kink at 0, so every crest is a crease - a knife edge that a terrain mesh can only
 * draw as a jagged line. `crest` rounds it over: |n| becomes sqrt(n^2 + crest^2) - crest, the
 * scaled to still reach 1 where |n| does: nearly the same away from the crest and smooth across it,
 * with the crest itself exactly as high as before.
 * 0 is the plain fold.
 */
export function ridgedNoise2D(sample: OctaveSampler, params: OctaveNoiseParams, crest = 0): Noise2D {
  const crestSquared = crest * crest;
  // Scaled back up to reach 1 where |n| does, so only the crest is rounded - not the whole ridge
  // lifted by the few hundredths the smoothing takes off everywhere.
  const crestScale = crest > 0 ? 1 / (Math.sqrt(1 + crestSquared) - crest) : 1;
  return (worldX: number, worldZ: number): number => {
    let amplitude = params.baseAmplitude;
    let frequency = params.baseFrequency;
    let height = 0;

    for (let i = 0; i < params.octaves; i++) {
      const raw = sample(worldX, worldZ, frequency);
      const n = 1 - (crest > 0 ? (Math.sqrt(raw * raw + crestSquared) - crest) * crestScale : Math.abs(raw));
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
/** A cell's jittered point, a random value of its own and a size weight (each drawn after the
 *  last, so adding one moved nothing earlier). */
function cellOffset(seed: number, cellX: number, cellY: number): { x: number; y: number; id: number; weight: number } {
  const cellSeed = deriveSeed(deriveSeed(seed, (cellX * 0x1f1f1f1f) >>> 0), (cellY * 0x2c2c2c2c) >>> 0);
  const rng = mulberry32(cellSeed);
  return { x: rng(), y: rng(), id: rng(), weight: rng() };
}

function wrapCell(value: number, cellsPerTile: number): number {
  if (cellsPerTile === 0) return value;
  return ((value % cellsPerTile) + cellsPerTile) % cellsPerTile;
}

/** Shaping for a worley noise, all in cells (see WorleyNoiseSpec). */
export interface WorleyShape {
  warp?: number;
  sizeJitter?: number;
  round?: number;
}

/** Smooth minimum (polynomial): min(a, b), eased over a band `k` wide where the two are close. */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * A tiling value noise over the cell grid, -1..1, on a lattice `perCell` times finer than the
 * cells - the warp that bends each cell's sides. Hashed under wrapped lattice coordinates like the
 * cells' points, so it tiles with them.
 */
function latticeNoise(seed: number, x: number, y: number, periodX: number, periodY: number): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const tx = x - cellX;
  const ty = y - cellY;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const corner = (cx: number, cy: number) => cellOffset(seed, wrapCell(cx, periodX), wrapCell(cy, periodY)).x * 2 - 1;
  const top = corner(cellX, cellY) + (corner(cellX + 1, cellY) - corner(cellX, cellY)) * sx;
  const bottom = corner(cellX, cellY + 1) + (corner(cellX + 1, cellY + 1) - corner(cellX, cellY + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** Warp lattices per cell, and their weights: a broad bend and a finer wobble on it. */
const WARP_OCTAVES: ReadonlyArray<{ perCell: number; weight: number; salt: number }> = [
  { perCell: 1, weight: 0.7, salt: 0x5a17 },
  { perCell: 3, weight: 0.3, salt: 0x6b28 },
];

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
 *
 * `shape` makes it less of a diagram: `warp` moves the query by a tiling noise at the cells' own
 * scale, so each side bends; `sizeJitter` scales each point's distances by a weight of its own
 * (multiplicatively weighted Voronoi), so neighbours differ in size and the borders between them
 * curve; `round` takes the edge distance as a smooth minimum over every neighbour rather than just
 * the second-nearest, so where borders meet at a corner they blend instead of switching - a stone
 * cut from it has rounded corners. All three are in cells; none costs more than a few lookups.
 */
export function worleyNoise2D(
  seed: number,
  frequency: number,
  tilePeriod?: number,
  stretchX = 1,
  stretchY = 1,
  shape: WorleyShape = {},
): (worldX: number, worldZ: number) => { f1: number; f2: number; id: number } {
  // Stretching is a different cell count per axis - taller cells for a vertical stretch - and each
  // axis rounds to a whole number of cells across the tile on its own.
  const frequencyX = frequency / stretchX;
  const frequencyY = frequency / stretchY;
  const cellsX = tilePeriod === undefined ? 0 : Math.max(1, Math.round(tilePeriod * frequencyX));
  const cellsY = tilePeriod === undefined ? 0 : Math.max(1, Math.round(tilePeriod * frequencyY));
  const effectiveFrequencyX = tilePeriod === undefined ? frequencyX : cellsX / tilePeriod;
  const effectiveFrequencyY = tilePeriod === undefined ? frequencyY : cellsY / tilePeriod;
  const warp = shape.warp ?? 0;
  const sizeJitter = shape.sizeJitter ?? 0;
  const round = shape.round ?? 0;
  const warpSeeds = WARP_OCTAVES.map((octave) => deriveSeed(seed, octave.salt));
  const distances = new Float64Array(9);

  return (worldX: number, worldZ: number) => {
    let x = worldX * effectiveFrequencyX;
    let y = worldZ * effectiveFrequencyY;
    if (warp > 0) {
      let shiftX = 0;
      let shiftY = 0;
      for (let i = 0; i < WARP_OCTAVES.length; i++) {
        const { perCell, weight } = WARP_OCTAVES[i];
        const periodX = cellsX * perCell;
        const periodY = cellsY * perCell;
        shiftX += latticeNoise(warpSeeds[i], x * perCell, y * perCell, periodX, periodY) * weight;
        // The second axis reads the same lattice half a period over, so the two shifts are unrelated.
        shiftY += latticeNoise(warpSeeds[i], x * perCell + 0.5 * (periodX || 1024), y * perCell + 0.5 * (periodY || 1024), periodX, periodY) * weight;
      }
      x += shiftX * warp;
      y += shiftY * warp;
    }
    const cellX = Math.floor(x);
    const cellY = Math.floor(y);

    let f1 = Infinity;
    let f2 = Infinity;
    let id = 0;
    let slot = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const neighborX = cellX + dx;
        const neighborY = cellY + dy;
        const offset = cellOffset(seed, wrapCell(neighborX, cellsX), wrapCell(neighborY, cellsY));
        const ddx = neighborX + offset.x - x;
        const ddy = neighborY + offset.y - y;
        let dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (sizeJitter > 0) dist *= 1 + sizeJitter * (offset.weight * 2 - 1);
        distances[slot++] = dist;
        if (dist < f1) {
          f2 = f1;
          f1 = dist;
          id = offset.id;
        } else if (dist < f2) {
          f2 = dist;
        }
      }
    }
    if (round > 0) {
      // The edge distance as a smooth minimum of every other point's lead over the nearest (f1's
      // own slot skipped) - their plain minimum is f2 - f1, which this rounds where two are close.
      let edge = Infinity;
      let skipped = false;
      for (let i = 0; i < 9; i++) {
        const lead = distances[i] - f1;
        if (!skipped && lead === 0) {
          skipped = true;
          continue;
        }
        edge = edge === Infinity ? lead : smoothMin(edge, lead, round);
      }
      f2 = f1 + Math.max(edge, 0);
    }
    return { f1, f2, id };
  };
}

