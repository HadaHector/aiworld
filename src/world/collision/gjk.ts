import { collisionStats } from "./stats";
import { add, dot, lengthSq, scale, sub, vec3, type Vec3 } from "./vec";

/**
 * A convex set as the hull of a few points - a point, a segment, a triangle, a box's corners, a
 * hull's - which is all GJK needs: the point furthest along a direction.
 */
export type PointSet = readonly Vec3[];

export function support(points: PointSet, dir: Vec3): Vec3 {
  let best = points[0];
  let bestDot = dot(best, dir);
  for (let i = 1; i < points.length; i++) {
    const d = dot(points[i], dir);
    if (d > bestDot) { bestDot = d; best = points[i]; }
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

interface Vertex {
  w: Vec3;
  a: Vec3;
  b: Vec3;
}

const MAX_ITERATIONS = 64;

/**
 * The distance between two convex hulls of points, and the closest points on each: GJK, walking a
 * simplex on their difference toward the origin. The closest point of each simplex is found by
 * trying each of its faces, edges and corners and keeping the nearest one it projects inside -
 * slower than the usual case analysis, and simpler to trust.
 */
export function gjkDistance(worldA: PointSet, worldB: PointSet): GjkResult {
  collisionStats.gjkCalls++;
  // Worked near the origin, so far-off coordinates lose no precision.
  const base = worldA[0];
  const setA = worldA.map((p) => sub(p, base));
  const setB = worldB.map((p) => sub(p, base));
  const vertex = (dir: Vec3): Vertex => {
    const a = support(setA, dir);
    const b = support(setB, scale(dir, -1));
    return { w: sub(a, b), a, b };
  };
  let simplex: Vertex[] = [vertex(sub(setB[0], setA[0]))];
  let closest = { v: simplex[0].w, weights: [1] };
  const scaleOf = Math.max(1, ...setA.map(lengthSq), ...setB.map(lengthSq));
  const tiny = scaleOf * 1e-14;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    collisionStats.gjkIterations++;
    const v = closest.v;
    const vv = lengthSq(v);
    if (vv <= tiny) break;
    const next = vertex(scale(v, -1));
    // No point further toward the origin than the simplex already reaches: done.
    if (vv - dot(v, next.w) <= vv * 1e-10 + tiny) break;
    if (simplex.some((s) => lengthSq(sub(s.w, next.w)) <= tiny)) break;
    const candidate = [...simplex, next];
    const found = closestOnSimplex(candidate.map((s) => s.w));
    if (lengthSq(found.v) >= vv) break;
    simplex = found.keep.map((k) => candidate[k]);
    closest = { v: found.v, weights: found.weights };
    if (simplex.length === 4) break;
  }

  let onA = vec3(), onB = vec3();
  simplex.forEach((s, k) => {
    onA = add(onA, scale(s.a, closest.weights[k]));
    onB = add(onB, scale(s.b, closest.weights[k]));
  });
  const distance = simplex.length === 4 ? 0 : Math.sqrt(lengthSq(closest.v));
  return { distance: distance <= Math.sqrt(tiny) ? 0 : distance, onA: add(onA, base), onB: add(onB, base) };
}

/** The point of the hull of up to four points nearest the origin, with which points make it up. */
function closestOnSimplex(points: Vec3[]): { v: Vec3; keep: number[]; weights: number[] } {
  let best: { v: Vec3; keep: number[]; weights: number[] } | null = null;
  let bestD = Infinity;
  const n = points.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const keep: number[] = [];
    for (let k = 0; k < n; k++) if (mask & (1 << k)) keep.push(k);
    const weights = affineClosest(keep.map((k) => points[k]));
    if (!weights || weights.some((w) => w < -1e-12)) continue;
    let v = vec3();
    keep.forEach((k, j) => { v = add(v, scale(points[k], weights[j])); });
    const d = lengthSq(v);
    // A tie goes to the smaller set.
    if (d < bestD - 1e-18 || (d <= bestD + 1e-18 && best && keep.length < best.keep.length)) {
      bestD = d;
      best = { v, keep, weights };
    }
  }
  return best!;
}

/**
 * The weights (summing to 1) of the point nearest the origin on the plane, line or point through
 * up to four points; null if they are degenerate (a flat tetrahedron, a collapsed triangle).
 */
function affineClosest(p: Vec3[]): number[] | null {
  const k = p.length - 1;
  if (k === 0) return [1];
  const e = p.slice(1).map((q) => sub(q, p[0]));
  // Solve G l = -r, with G the Gram matrix of the edges and r their dots with p0.
  const g = e.map((ei) => e.map((ej) => dot(ei, ej)));
  const r = e.map((ei) => -dot(ei, p[0]));
  const l = solve(g, r);
  if (!l) return null;
  return [1 - l.reduce((s, x) => s + x, 0), ...l];
}

function solve(m: number[][], r: number[]): number[] | null {
  const n = r.length;
  const a = m.map((row, i) => [...row, r[i]]);
  let scaleOf = 0;
  for (const row of m) for (const x of row) scaleOf = Math.max(scaleOf, Math.abs(x));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) <= scaleOf * 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = a[row][col] / a[col][col];
      for (let c = col; c <= n; c++) a[row][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}
