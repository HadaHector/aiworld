import { collisionStats } from "./stats";
import type { Vec3 } from "./vec";

/**
 * A convex set as the hull of a few points - a point, a segment, a triangle, a box's corners, a
 * hull's - which is all GJK needs: the point furthest along a direction.
 */
export type PointSet = readonly Vec3[];

export function support(points: PointSet, dir: Vec3): Vec3 {
  return points[supportIndex(points, dir.x, dir.y, dir.z, 0, 0, 0)];
}

/** Which point is furthest along a direction, the points taken relative to an origin `o`. */
function supportIndex(points: PointSet, dx: number, dy: number, dz: number, ox: number, oy: number, oz: number): number {
  let best = 0;
  let bestDot = (points[0].x - ox) * dx + (points[0].y - oy) * dy + (points[0].z - oz) * dz;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const d = (p.x - ox) * dx + (p.y - oy) * dy + (p.z - oz) * dz;
    if (d > bestDot) { bestDot = d; best = i; }
  }
  return best;
}

export interface GjkResult {
  /** 0 when the sets overlap. */
  distance: number;
  /** The closest points, on each set; the same point when they overlap. */
  onA: Vec3;
  onB: Vec3;
}

const MAX_ITERATIONS = 64;

// The working simplex, in flat arrays reused from call to call (GJK runs thousands of times a step,
// and never inside itself): up to four vertices of the difference, each with the two points it
// came from - all taken relative to `base`. Slot 4 holds the vertex being tried.
const W = new Float64Array(15);
const A = new Float64Array(15);
const B = new Float64Array(15);
let count = 0;
const weights = new Float64Array(4);
// What closestOnSimplex found: the point, its weights, and which vertices make it up (a bit mask).
const foundV = new Float64Array(3);
const foundWeights = new Float64Array(4);
let foundKeep = 0;
// The affine solve's scratch: the subset's vertices, its edges, a 3x4 augmented matrix, the answer.
const subset = new Int32Array(4);
const mat = new Float64Array(12);
const lambdas = new Float64Array(4);
const edgeX = new Float64Array(3);
const edgeY = new Float64Array(3);
const edgeZ = new Float64Array(3);

/**
 * The distance between two convex hulls of points, and the closest points on each: GJK, walking a
 * simplex on their difference toward the origin. The closest point of each simplex is found by
 * trying each of its faces, edges and corners and keeping the nearest one it projects inside -
 * slower than the usual case analysis, and simpler to trust.
 */
export function gjkDistance(worldA: PointSet, worldB: PointSet): GjkResult {
  collisionStats.gjkCalls++;
  // Worked near the origin, so far-off coordinates lose no precision.
  const bx = worldA[0].x, by = worldA[0].y, bz = worldA[0].z;
  let scaleOf = 1;
  for (const set of [worldA, worldB]) {
    for (const p of set) {
      const x = p.x - bx, y = p.y - by, z = p.z - bz;
      scaleOf = Math.max(scaleOf, x * x + y * y + z * z);
    }
  }
  const tiny = scaleOf * 1e-14;

  /** Puts the vertex furthest along a direction into a slot. */
  const vertex = (slot: number, dx: number, dy: number, dz: number): void => {
    const a = worldA[supportIndex(worldA, dx, dy, dz, bx, by, bz)];
    const b = worldB[supportIndex(worldB, -dx, -dy, -dz, bx, by, bz)];
    const o = slot * 3;
    A[o] = a.x - bx; A[o + 1] = a.y - by; A[o + 2] = a.z - bz;
    B[o] = b.x - bx; B[o + 1] = b.y - by; B[o + 2] = b.z - bz;
    W[o] = A[o] - B[o]; W[o + 1] = A[o + 1] - B[o + 1]; W[o + 2] = A[o + 2] - B[o + 2];
  };
  vertex(0, worldB[0].x - bx, worldB[0].y - by, worldB[0].z - bz);
  count = 1;
  weights[0] = 1;
  let vx = W[0], vy = W[1], vz = W[2];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    collisionStats.gjkIterations++;
    const vv = vx * vx + vy * vy + vz * vz;
    if (vv <= tiny) break;
    vertex(count, -vx, -vy, -vz);
    const o = count * 3;
    const nx = W[o], ny = W[o + 1], nz = W[o + 2];
    // No point further toward the origin than the simplex already reaches: done.
    if (vv - (vx * nx + vy * ny + vz * nz) <= vv * 1e-10 + tiny) break;
    let repeated = false;
    for (let k = 0; k < count; k++) {
      const dx = W[k * 3] - nx, dy = W[k * 3 + 1] - ny, dz = W[k * 3 + 2] - nz;
      if (dx * dx + dy * dy + dz * dz <= tiny) { repeated = true; break; }
    }
    if (repeated) break;
    closestOnSimplex(count + 1);
    if (foundV[0] * foundV[0] + foundV[1] * foundV[1] + foundV[2] * foundV[2] >= vv) break;
    // Keep the vertices that make up the closest point, in their order.
    let kept = 0;
    for (let k = 0; k <= count; k++) {
      if (!(foundKeep & (1 << k))) continue;
      if (kept !== k) {
        for (let c = 0; c < 3; c++) { W[kept * 3 + c] = W[k * 3 + c]; A[kept * 3 + c] = A[k * 3 + c]; B[kept * 3 + c] = B[k * 3 + c]; }
      }
      weights[kept] = foundWeights[kept];
      kept++;
    }
    count = kept;
    vx = foundV[0]; vy = foundV[1]; vz = foundV[2];
    if (count === 4) break;
  }

  let ax = 0, ay = 0, az = 0, qx = 0, qy = 0, qz = 0;
  for (let k = 0; k < count; k++) {
    const w = weights[k];
    ax += A[k * 3] * w; ay += A[k * 3 + 1] * w; az += A[k * 3 + 2] * w;
    qx += B[k * 3] * w; qy += B[k * 3 + 1] * w; qz += B[k * 3 + 2] * w;
  }
  const distance = count === 4 ? 0 : Math.sqrt(vx * vx + vy * vy + vz * vz);
  return { distance: distance <= Math.sqrt(tiny) ? 0 : distance, onA: { x: ax + bx, y: ay + by, z: az + bz }, onB: { x: qx + bx, y: qy + by, z: qz + bz } };
}

/**
 * The point of the hull of the first `n` (up to four) vertices of `W` nearest the origin: into
 * foundV, foundWeights (one per kept vertex, in order) and foundKeep.
 */
function closestOnSimplex(n: number): void {
  let bestD = Infinity;
  let bestSize = 0;
  foundKeep = 0;
  for (let mask = 1; mask < 1 << n; mask++) {
    let size = 0;
    for (let k = 0; k < n; k++) if (mask & (1 << k)) subset[size++] = k;
    if (!affineClosest(size)) continue;
    let negative = false;
    for (let j = 0; j < size; j++) if (lambdas[j] < -1e-12) negative = true;
    if (negative) continue;
    let x = 0, y = 0, z = 0;
    for (let j = 0; j < size; j++) {
      const o = subset[j] * 3;
      x += W[o] * lambdas[j]; y += W[o + 1] * lambdas[j]; z += W[o + 2] * lambdas[j];
    }
    const d = x * x + y * y + z * z;
    // A tie goes to the smaller set.
    if (d < bestD - 1e-18 || (d <= bestD + 1e-18 && foundKeep !== 0 && size < bestSize)) {
      bestD = d;
      bestSize = size;
      foundKeep = mask;
      foundV[0] = x; foundV[1] = y; foundV[2] = z;
      for (let j = 0; j < size; j++) foundWeights[j] = lambdas[j];
    }
  }
}

/**
 * The weights (summing to 1) of the point nearest the origin on the plane, line or point through
 * the subset's vertices, into `lambdas`; false if they are degenerate (a flat tetrahedron, a
 * collapsed triangle). Solves G l = -r, with G the Gram matrix of the edges from the first vertex
 * and r their dots with it - by Gauss-Jordan elimination with partial pivoting.
 */
function affineClosest(size: number): boolean {
  const k = size - 1;
  if (k === 0) {
    lambdas[0] = 1;
    return true;
  }
  const o0 = subset[0] * 3;
  const p0x = W[o0], p0y = W[o0 + 1], p0z = W[o0 + 2];
  // The edges from the first vertex: e_i = p_i - p0.
  const ex = edgeX, ey = edgeY, ez = edgeZ;
  for (let i = 0; i < k; i++) {
    const o = subset[i + 1] * 3;
    ex[i] = W[o] - p0x; ey[i] = W[o + 1] - p0y; ez[i] = W[o + 2] - p0z;
  }
  let scaleOf = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const g = ex[i] * ex[j] + ey[i] * ey[j] + ez[i] * ez[j];
      mat[i * 4 + j] = g;
      scaleOf = Math.max(scaleOf, Math.abs(g));
    }
    mat[i * 4 + k] = -(ex[i] * p0x + ey[i] * p0y + ez[i] * p0z);
  }
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let row = col + 1; row < k; row++) if (Math.abs(mat[row * 4 + col]) > Math.abs(mat[pivot * 4 + col])) pivot = row;
    if (Math.abs(mat[pivot * 4 + col]) <= scaleOf * 1e-12) return false;
    if (pivot !== col) {
      for (let c = 0; c <= k; c++) {
        const t = mat[col * 4 + c];
        mat[col * 4 + c] = mat[pivot * 4 + c];
        mat[pivot * 4 + c] = t;
      }
    }
    for (let row = 0; row < k; row++) {
      if (row === col) continue;
      const f = mat[row * 4 + col] / mat[col * 4 + col];
      for (let c = col; c <= k; c++) mat[row * 4 + c] -= f * mat[col * 4 + c];
    }
  }
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const l = mat[i * 4 + k] / mat[i * 4 + i];
    lambdas[i + 1] = l;
    sum += l;
  }
  lambdas[0] = 1 - sum;
  return true;
}
