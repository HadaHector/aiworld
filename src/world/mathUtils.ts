export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Smooth vertex normals for an indexed triangle mesh: each vertex the normalised sum of the unit
 * normals of the triangles that use it. The same sums, in the same order, as Babylon's
 * `VertexData.ComputeNormals`, so a mesh lit before and after the switch away from it is unchanged -
 * here so code that has to run without Babylon (the simulation, see SIMULATION.md) can make them.
 */
export function computeNormals(positions: ArrayLike<number>, indices: ArrayLike<number>, normals: number[] | Float32Array): void {
  for (let i = 0; i < positions.length; i++) normals[i] = 0;
  const faces = (indices.length / 3) | 0;
  for (let f = 0; f < faces; f++) {
    const a = indices[f * 3] * 3;
    const b = indices[f * 3 + 1] * 3;
    const c = indices[f * 3 + 2] * 3;
    const abx = positions[a] - positions[b];
    const aby = positions[a + 1] - positions[b + 1];
    const abz = positions[a + 2] - positions[b + 2];
    const cbx = positions[c] - positions[b];
    const cby = positions[c + 1] - positions[b + 1];
    const cbz = positions[c + 2] - positions[b + 2];
    let nx = aby * cbz - abz * cby;
    let ny = abz * cbx - abx * cbz;
    let nz = abx * cby - aby * cbx;
    let length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    length = length === 0 ? 1 : length;
    nx /= length;
    ny /= length;
    nz /= length;
    for (const v of [a, b, c]) {
      normals[v] += nx;
      normals[v + 1] += ny;
      normals[v + 2] += nz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    let length = Math.sqrt(normals[v] * normals[v] + normals[v + 1] * normals[v + 1] + normals[v + 2] * normals[v + 2]);
    length = length === 0 ? 1 : length;
    normals[v] /= length;
    normals[v + 1] /= length;
    normals[v + 2] /= length;
  }
}
