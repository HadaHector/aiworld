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


/** The shapes a `scatter` noise lays down (see ScatterNoiseSpec). */
export type ScatterShape = "ellipse" | "splinter" | "chip";

/** A `scatter` noise's instances, all in cells (see ScatterNoiseSpec). */
export interface ScatterLayout {
  shape: ScatterShape;
  count: number;
  density: number;
  size: [number, number];
  aspect: [number, number];
  /** Degrees. */
  rotation: [number, number];
  height: [number, number];
}

/** One instance's numbers, per slot of the table: centre x, y (in cells), the cosine and sine of
 *  its turn, its half length and half width (cells), its height, its own value - and 0 where it is
 *  left out. */
const INSTANCE_STRIDE = 8;
/** A tiling scatter keeps a table of every instance on its tile up to this many floats. */
const MAX_TABLE_FLOATS = 4_000_000;

/** How high a shape stands at (u, v) in its own frame - u along it, v across, each over its half
 *  length and width - 0 outside it. */
function shapeProfile(shape: ScatterShape, u: number, v: number, halfWidth: number, halfLength: number): number {
  const au = Math.abs(u);
  const av = Math.abs(v);
  if (au >= 1 || av >= 1) return 0;
  switch (shape) {
    case "ellipse": {
      const r = u * u + v * v;
      return r < 1 ? Math.sqrt(1 - r) : 0;
    }
    case "splinter": {
      // A needle: narrowing to a point at each end, ridged along its middle.
      const width = 1 - au * au;
      if (av >= width) return 0;
      return (1 - av / width) * Math.sqrt(1 - au * au * au * au);
    }
    case "chip": {
      // A flat flake, its edges bevelled over a third of its half width all round.
      const bevel = 0.35 * halfWidth;
      const edge = Math.min((1 - au) * halfLength, (1 - av) * halfWidth);
      return Math.min(1, edge / bevel);
    }
  }
}

/**
 * Shapes scattered over a grid - Substance Designer's tile sampler: `count` per cell, each kept by
 * `density`, set down at a random point of its cell, turned, sized and stretched by its own rolls,
 * and stood up to its own height. Where two overlap, the taller there shows (max blending). Returns
 * the height there (0 on bare ground), the value of the instance showing (0-1, its own random; 0
 * where none), and how far the point is covered (1 inside any, 0 outside).
 */
export function scatterNoise2D(seed: number, frequency: number, tilePeriod: number | undefined, layout: ScatterLayout): (worldX: number, worldZ: number) => { height: number; id: number; coverage: number } {
  const cellsX = tilePeriod === undefined ? 0 : Math.max(1, Math.round(tilePeriod * frequency));
  const cellsY = cellsX;
  const effective = tilePeriod === undefined ? frequency : cellsX / tilePeriod;
  const { shape, count, density, size, aspect, rotation, height } = layout;
  const reach = size[1] / 2;
  const DEG = Math.PI / 180;

  const rollInstance = (cellX: number, cellY: number, k: number, into: Float32Array, at: number): void => {
    const rng = mulberry32(deriveSeed(deriveSeed(deriveSeed(seed, (cellX * 0x1f1f1f1f) >>> 0), (cellY * 0x2c2c2c2c) >>> 0), k + 1));
    const x = rng();
    const y = rng();
    const kept = rng() < density;
    const angle = (rotation[0] + rng() * (rotation[1] - rotation[0])) * DEG;
    const length = size[0] + rng() * (size[1] - size[0]);
    const width = length * (aspect[0] + rng() * (aspect[1] - aspect[0]));
    into[at] = x;
    into[at + 1] = y;
    into[at + 2] = Math.cos(angle);
    into[at + 3] = Math.sin(angle);
    into[at + 4] = length / 2;
    into[at + 5] = Math.max(1e-4, width / 2);
    into[at + 6] = height[0] + rng() * (height[1] - height[0]);
    into[at + 7] = kept ? rng() : -1;
  };

  // On a tile, every instance once, in a table; out in the world, each as it is needed.
  const tableFloats = cellsX * cellsY * count * INSTANCE_STRIDE;
  let table: Float32Array | null = null;
  if (cellsX > 0 && tableFloats <= MAX_TABLE_FLOATS) {
    table = new Float32Array(tableFloats);
    for (let cy = 0; cy < cellsY; cy++) for (let cx = 0; cx < cellsX; cx++) for (let k = 0; k < count; k++) rollInstance(cx, cy, k, table, ((cy * cellsX + cx) * count + k) * INSTANCE_STRIDE);
  }
  const scratch = new Float32Array(INSTANCE_STRIDE);
  const result = { height: 0, id: 0, coverage: 0 };

  return (worldX: number, worldZ: number) => {
    const x = worldX * effective;
    const y = worldZ * effective;
    let best = 0;
    let bestId = 0;
    let covered = 0;
    const x0 = Math.floor(x - reach - 1);
    const x1 = Math.floor(x + reach);
    const y0 = Math.floor(y - reach - 1);
    const y1 = Math.floor(y + reach);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const wx = wrapCell(cx, cellsX);
        const wy = wrapCell(cy, cellsY);
        for (let k = 0; k < count; k++) {
          let data: Float32Array;
          let at: number;
          if (table) {
            data = table;
            at = ((wy * cellsX + wx) * count + k) * INSTANCE_STRIDE;
          } else {
            rollInstance(wx, wy, k, scratch, 0);
            data = scratch;
            at = 0;
          }
          if (data[at + 7] < 0) continue;
          const dx = x - (cx + data[at]);
          const dy = y - (cy + data[at + 1]);
          const halfLength = data[at + 4];
          if (Math.abs(dx) > halfLength + 1e-9 && Math.abs(dy) > halfLength + 1e-9) continue;
          const cos = data[at + 2];
          const sin = data[at + 3];
          const halfWidth = data[at + 5];
          const u = (dx * cos + dy * sin) / halfLength;
          const v = (-dx * sin + dy * cos) / halfWidth;
          const profile = shapeProfile(shape, u, v, halfWidth, halfLength);
          if (profile <= 0) continue;
          covered = 1;
          const h = profile * data[at + 6];
          if (h > best) {
            best = h;
            bestId = data[at + 7];
          }
        }
      }
    }
    result.height = best;
    result.id = bestId;
    result.coverage = covered;
    return result;
  };
}
