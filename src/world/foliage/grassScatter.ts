import type { MaterialDef } from "../materials/materialTypes";
import { SEA_LEVEL } from "../cells/areaField";
import { GRASS_CELL_SIZE, GRASS_SALT, GRASS_WATER_CLEARANCE, type GrassKindDef } from "./grassConfig";

/** Floats per tuft in ChunkGrass.instances: x, y, z (chunk-local), kind * 16 + scale, then
 *  r, g, b, rotation (radians), then the ground's colour at the root packed into one float (see
 *  packColor), or -1 where it is not known. Matches the instance attributes in grassField.ts. */
export const GRASS_INSTANCE_STRIDE = 9;

/** 8 bits a channel, as an integer up to 2^24 - exactly representable in a float, so it survives
 *  the Float32Array and the GPU unchanged. */
function packColor(r: number, g: number, b: number): number {
  const channel = (v: number): number => Math.min(255, Math.max(0, Math.round(v * 255)));
  return channel(r) * 65536 + channel(g) * 256 + channel(b);
}

/** A chunk's grass, ready to hand to the GPU as it is. */
export interface ChunkGrass {
  /** Grouped by kind, in WorldContent.grassKinds order, so each kind can be drawn (and culled by distance) on
   *  its own straight from a slice of this. */
  instances: Float32Array;
  count: number;
  /** How many of `instances` belong to each kind, in WorldContent.grassKinds order. */
  kindCounts: number[];
  /** Lowest and highest tuft root, for the chunk's bounding box. */
  minY: number;
  maxY: number;
}

/** One ground material's grass, flattened for the inner loop: kind index, density, colour. */
interface GrassEntry {
  kind: number;
  density: number;
  r: number;
  g: number;
  b: number;
}

interface GrassTable {
  /** Per material index: what it grows. */
  grows: GrassEntry[][];
  /** Per material index: how strongly it clears grass (MaterialDef.clearsGrass), 0 for most. */
  clears: number[];
}

const tablesByDefs = new WeakMap<MaterialDef[], GrassTable>();

/** Every material index's grass specs, looked up once per material list rather than by id per
 *  tuft. */
function grassTableFor(materialDefs: MaterialDef[], grassKinds: GrassKindDef[]): GrassTable {
  let table = tablesByDefs.get(materialDefs);
  if (!table) {
    const kindIndex = new Map(grassKinds.map((kind, index) => [kind.id, index]));
    table = {
      grows: materialDefs.map((def) =>
        def.grass.map((spec) => ({
          kind: kindIndex.get(spec.kind)!,
          density: spec.density,
          r: spec.color[0],
          g: spec.color[1],
          b: spec.color[2],
        })),
      ),
      clears: materialDefs.map((def) => def.clearsGrass),
    };
    tablesByDefs.set(materialDefs, table);
  }
  return table;
}

/** A well-mixed hash of a cell and a stream index, as 0..1 - one independent random number per
 *  (cell, k) without allocating a generator per cell. */
function cellRandom(ix: number, iz: number, k: number, seedMix: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(k + seedMix, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise on the unit lattice, 0..1 - where a clustered kind's patches are. */
function valueNoise(x: number, z: number, stream: number, seedMix: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = cellRandom(ix, iz, stream, seedMix);
  const b = cellRandom(ix + 1, iz, stream, seedMix);
  const c = cellRandom(ix, iz + 1, stream, seedMix);
  const d = cellRandom(ix + 1, iz + 1, stream, seedMix);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/**
 * valueNoise's own distribution, sampled once. Smoothed value noise piles up around 0.5 - measured,
 * well under half the ground clears a naive 0.65 - so a patch threshold of 1 - coverage covers far
 * less than coverage says. Thresholding at the noise's actual quantile instead makes coverage the
 * real fraction of ground inside a patch.
 */
const NOISE_QUANTILES: Float64Array = (() => {
  const samples = new Float64Array(4096);
  for (let i = 0; i < samples.length; i++) samples[i] = valueNoise(i * 0.618034 * 7.3, i * 0.381966 * 5.1, 999, 0x5eed);
  return samples.sort();
})();

function noiseQuantile(fraction: number): number {
  const index = Math.min(NOISE_QUANTILES.length - 1, Math.max(0, Math.round(fraction * (NOISE_QUANTILES.length - 1))));
  return NOISE_QUANTILES[index];
}

/** How much of a clustered kind grows at a point: 1 inside a patch, 0 outside, a short fade
 *  between. Never above 1, so a material's density stays an upper bound for the early rejection. */
function clusterFactor(x: number, z: number, kind: number, grassKinds: GrassKindDef[], seedMix: number): number {
  const cluster = grassKinds[kind].cluster;
  if (!cluster) return 1;
  const n = valueNoise(x / cluster.scale, z / cluster.scale, 100 + kind, seedMix);
  // The fade straddles the threshold by 5% of the ground either side.
  const low = noiseQuantile(1 - cluster.coverage - 0.05);
  const high = noiseQuantile(1 - cluster.coverage + 0.05);
  const t = Math.min(1, Math.max(0, (n - low) / Math.max(high - low, 1e-6)));
  return t * t * (3 - 2 * t);
}

export interface GrassGround {
  size: number;
  subdivisions: number;
  originX: number;
  originZ: number;
  /** Material weights at rendered grid vertex (row, col), 0..subdivisions each. */
  blendAt: (row: number, col: number) => Map<number, number>;
  /** Height of the drawn surface inside grid square (row, col) at (u, v) across it. */
  surfaceHeight: (row: number, col: number, u: number, v: number) => number;
}

/**
 * Scatters grass over one chunk from its material weights.
 *
 * Each GRASS_CELL_SIZE cell of the world holds at most one tuft, jittered inside the cell, with
 * every random choice (position, whether it grows, kind, size, turn, tint) hashed from the cell's
 * own coordinates. So the same tuft comes out whichever chunk build asks, however many times the
 * chunk is rebuilt, and a tuft belongs to exactly the chunk its position falls in.
 *
 * Whether a cell grows a tuft is its density - every material's specs scaled by that material's
 * weight, interpolated across the grid square - times the cell's area, against one random draw;
 * the same draw then picks the kind in proportion to each kind's share of that density.
 */
export function scatterGrass(
  ground: GrassGround,
  materialDefs: MaterialDef[],
  grassKinds: GrassKindDef[],
  seed: number,
  /** Each material's average colour, by index - what the ground under a tuft looks like, which the
   *  bottom of its blades fade from. Null if not known yet. */
  groundColors: [number, number, number][] | null,
): ChunkGrass {
  const { size, subdivisions, originX, originZ, blendAt, surfaceHeight } = ground;
  const table = grassTableFor(materialDefs, grassKinds);
  const kindCount = grassKinds.length;
  const gridSize = subdivisions + 1;
  const step = size / subdivisions;

  // Per grid vertex and kind: density, and density-weighted colour (so interpolating both and
  // dividing gives a colour weighted by how much each material contributes to that kind).
  const density = new Float32Array(gridSize * gridSize * kindCount);
  const color = new Float32Array(gridSize * gridSize * kindCount * 3);
  const totalDensity = new Float32Array(gridSize * gridSize);
  // Per grid vertex: the ground's colour, its materials' average colours by weight.
  const groundColor = new Float32Array(gridSize * gridSize * 3);
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const vertex = row * gridSize + col;
      const blend = blendAt(row, col);
      if (groundColors) {
        let weightSum = 0;
        for (const [material, weight] of blend) {
          const c = groundColors[material];
          if (!c) continue;
          groundColor[vertex * 3] += c[0] * weight;
          groundColor[vertex * 3 + 1] += c[1] * weight;
          groundColor[vertex * 3 + 2] += c[2] * weight;
          weightSum += weight;
        }
        if (weightSum > 0) for (let c = 0; c < 3; c++) groundColor[vertex * 3 + c] /= weightSum;
      }
      let clearing = 0;
      for (const [material, weight] of blend) clearing += (table.clears[material] ?? 0) * weight;
      const keep = Math.max(0, 1 - clearing);
      if (keep === 0) continue;
      for (const [material, weight] of blend) {
        for (const entry of table.grows[material] ?? []) {
          const d = weight * entry.density * keep;
          const slot = vertex * kindCount + entry.kind;
          density[slot] += d;
          color[slot * 3] += d * entry.r;
          color[slot * 3 + 1] += d * entry.g;
          color[slot * 3 + 2] += d * entry.b;
          totalDensity[vertex] += d;
        }
      }
    }
  }

  const seedMix = (seed ^ GRASS_SALT) | 0;
  const cell = GRASS_CELL_SIZE;
  const cellArea = cell * cell;
  const minX = originX - size / 2;
  const maxX = originX + size / 2;
  const minZ = originZ - size / 2;
  const maxZ = originZ + size / 2;

  const byKind: number[][] = grassKinds.map(() => []);
  let minY = Infinity;
  let maxY = -Infinity;
  const kindDensity = new Float64Array(kindCount);

  for (let iz = Math.floor(minZ / cell); iz <= Math.floor(maxZ / cell); iz++) {
    for (let ix = Math.floor(minX / cell); ix <= Math.floor(maxX / cell); ix++) {
      const x = (ix + cellRandom(ix, iz, 0, seedMix)) * cell;
      const z = (iz + cellRandom(ix, iz, 1, seedMix)) * cell;
      if (x < minX || x >= maxX || z < minZ || z >= maxZ) continue;

      const colF = (x - minX) / step;
      const rowF = (maxZ - z) / step;
      const col = Math.min(subdivisions - 1, Math.floor(colF));
      const row = Math.min(subdivisions - 1, Math.floor(rowF));
      const u = colF - col;
      const v = rowF - row;
      const w00 = (1 - u) * (1 - v);
      const w10 = u * (1 - v);
      const w01 = (1 - u) * v;
      const w11 = u * v;
      const v00 = row * gridSize + col;
      const v10 = v00 + 1;
      const v01 = v00 + gridSize;
      const v11 = v01 + 1;

      // Cheapest rejection first: most cells in thin grass fail on the total alone.
      const pick = cellRandom(ix, iz, 2, seedMix);
      const total = totalDensity[v00] * w00 + totalDensity[v10] * w10 + totalDensity[v01] * w01 + totalDensity[v11] * w11;
      if (pick >= total * cellArea) continue;

      // A cell holds one tuft at most. Where the kinds together ask for more than that, each is scaled
      // down in proportion - otherwise the first kinds in the list would fill every cell and the
      // later ones would never grow at all.
      const share = total * cellArea > 1 ? 1 / (total * cellArea) : 1;
      let kind = -1;
      let remaining = pick / cellArea;
      for (let k = 0; k < kindCount; k++) {
        let d =
          density[v00 * kindCount + k] * w00 +
          density[v10 * kindCount + k] * w10 +
          density[v01 * kindCount + k] * w01 +
          density[v11 * kindCount + k] * w11;
        kindDensity[k] = d;
        // Patches thin a clustered kind where the tuft stands, but its colour still averages over
        // the unthinned density (kindDensity), which is what the colour sums were weighted by.
        if (d > 0) d *= clusterFactor(x, z, k, grassKinds, seedMix);
        remaining -= d * share;
        if (remaining < 0 && kind < 0) kind = k;
      }
      if (kind < 0) continue;

      const y = surfaceHeight(row, col, u, v);
      if (y < SEA_LEVEL + GRASS_WATER_CLEARANCE) continue;

      const channel = (c: number): number =>
        (color[(v00 * kindCount + kind) * 3 + c] * w00 +
          color[(v10 * kindCount + kind) * 3 + c] * w10 +
          color[(v01 * kindCount + kind) * 3 + c] * w01 +
          color[(v11 * kindCount + kind) * 3 + c] * w11) /
        kindDensity[kind];
      // A little brightness variation per tuft, so a meadow is not one flat colour.
      const tint = 0.85 + 0.3 * cellRandom(ix, iz, 3, seedMix);
      const scale = 0.75 + 0.5 * cellRandom(ix, iz, 4, seedMix);
      const rotation = cellRandom(ix, iz, 5, seedMix) * Math.PI * 2;

      const groundChannel = (c: number): number =>
        groundColor[v00 * 3 + c] * w00 + groundColor[v10 * 3 + c] * w10 + groundColor[v01 * 3 + c] * w01 + groundColor[v11 * 3 + c] * w11;
      const root = groundColors ? packColor(groundChannel(0), groundChannel(1), groundChannel(2)) : -1;

      byKind[kind].push(x - originX, y, z - originZ, kind * 16 + scale, channel(0) * tint, channel(1) * tint, channel(2) * tint, rotation, root);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const instances = new Float32Array(byKind.reduce((n, list) => n + list.length, 0));
  let offset = 0;
  for (const list of byKind) {
    instances.set(list, offset);
    offset += list.length;
  }
  return {
    instances,
    count: instances.length / GRASS_INSTANCE_STRIDE,
    kindCounts: byKind.map((list) => list.length / GRASS_INSTANCE_STRIDE),
    minY,
    maxY,
  };
}
