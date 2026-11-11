// A distance field sampled on a grid and turned into triangles by surface nets: a vertex in each
// cell the surface crosses (at the average of where it crosses the cell's edges), a quad across each
// grid edge it crosses. See DUNGEONS.md, *Spike*.

/** A field sampled on a grid: `values[(k * ny + j) * nx + i]` at origin + (i, j, k) * cell. */
export interface SampledField {
  origin: [number, number, number];
  cell: number;
  nx: number;
  ny: number;
  nz: number;
  /** Positive in the solid. */
  values: Float32Array;
}

export interface FieldMesh {
  positions: Float32Array;
  /** Wound counter-clockwise seen from the open side (where the field is negative). */
  indices: Uint32Array;
}

/** Samples `solid` (positive in the solid) over a box, at `cell` apart. */
export function sampleField(solid: (x: number, y: number, z: number) => number, min: readonly number[], max: readonly number[], cell: number): SampledField {
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1;
  const ny = Math.ceil((max[1] - min[1]) / cell) + 1;
  const nz = Math.ceil((max[2] - min[2]) / cell) + 1;
  const values = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    values[(k * ny + j) * nx + i] = solid(min[0] + i * cell, min[1] + j * cell, min[2] + k * cell);
  }
  return { origin: [min[0], min[1], min[2]], cell, nx, ny, nz, values };
}

/** The field at any point, trilinear; `outside` beyond the grid. */
export function fieldAt(field: SampledField, x: number, y: number, z: number, outside = 1): number {
  const { origin, cell, nx, ny, nz, values } = field;
  const fx = (x - origin[0]) / cell, fy = (y - origin[1]) / cell, fz = (z - origin[2]) / cell;
  if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx < nx - 1 && fy < ny - 1 && fz < nz - 1)) return outside;
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  const u = fx - i, v = fy - j, w = fz - k;
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    r += values[((k + dz) * ny + j + dy) * nx + i + dx] * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r;
}

const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

/** The whole grid's surface as one mesh. */
export function surfaceNets(field: SampledField): FieldMesh {
  const { origin, cell, nx, ny, nz, values } = field;
  const at = (i: number, j: number, k: number): number => values[(k * ny + j) * nx + i];
  const cx = nx - 1, cy = ny - 1;
  const vertexOf = new Int32Array(cx * cy * (nz - 1)).fill(-1);
  const cellIndex = (i: number, j: number, k: number): number => (k * cy + j) * cx + i;
  const positions: number[] = [];
  const corner = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let b = 0; b < 8; b++) {
      corner[b] = at(i + (b & 1), j + ((b >> 1) & 1), k + (b >> 2));
      if (corner[b] > 0) mask |= 1 << b;
    }
    if (mask === 0 || mask === 255) continue;
    let n = 0, px = 0, py = 0, pz = 0;
    for (const [a, b] of EDGES) {
      if (corner[a] > 0 === corner[b] > 0) continue;
      const t = corner[a] / (corner[a] - corner[b]);
      px += (a & 1) + t * ((b & 1) - (a & 1));
      py += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
      pz += (a >> 2) + t * ((b >> 2) - (a >> 2));
      n++;
    }
    vertexOf[cellIndex(i, j, k)] = positions.length / 3;
    positions.push(origin[0] + (i + px / n) * cell, origin[1] + (j + py / n) * cell, origin[2] + (k + pz / n) * cell);
  }
  const indices: number[] = [];
  const ids = [0, 0, 0, 0];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v0 = at(i, j, k);
    // The three grid edges from this point, along +x, +y and +z, and the four cells round each.
    for (let axis = 0; axis < 3; axis++) {
      const di = axis === 0 ? 1 : 0, dj = axis === 1 ? 1 : 0, dk = axis === 2 ? 1 : 0;
      if (i + di >= nx || j + dj >= ny || k + dk >= nz) continue;
      if (v0 > 0 === at(i + di, j + dj, k + dk) > 0) continue;
      const ua = axis === 0 ? [0, 1, 0] : axis === 1 ? [0, 0, 1] : [1, 0, 0];
      const ub = axis === 0 ? [0, 0, 1] : axis === 1 ? [1, 0, 0] : [0, 1, 0];
      let ok = true;
      const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (let q = 0; q < 4 && ok; q++) {
        const a = i - ua[0] * quad[q][0] - ub[0] * quad[q][1];
        const b = j - ua[1] * quad[q][0] - ub[1] * quad[q][1];
        const c = k - ua[2] * quad[q][0] - ub[2] * quad[q][1];
        if (a < 0 || b < 0 || c < 0 || a >= cx || b >= cy || c >= nz - 1) { ok = false; break; }
        ids[q] = vertexOf[cellIndex(a, b, c)];
        if (ids[q] < 0) ok = false;
      }
      if (!ok) continue;
      // Wound to face out of the solid.
      if (v0 > 0) indices.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
      else indices.push(ids[0], ids[2], ids[1], ids[0], ids[3], ids[2]);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
