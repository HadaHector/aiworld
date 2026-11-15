import type { CellPoint } from "../cells/cellGrid";

/**
 * A compound's yard as a polygon instead of a round (`yard: { shape: "polygon" }`): a convex
 * polygon with its corners on a circle round the yard's middle, in order round it (increasing
 * angle), so the middle is always inside. Every polygon here is convex and wound that way - the
 * outside of an edge is to its right.
 */

/**
 * A polygon's corners on the unit circle, `points` of them (a whole number in the range), the arcs
 * between them in proportion to as many weights rolled in `weights` - a balanced shape, never a
 * sliver - from a random start angle. Scaled so its area is the unit circle's (pi), so a yard of
 * radius r has the area of a round one of the same radius.
 */
export function rollYardUnit(points: [number, number], weights: [number, number], rng: () => number): CellPoint[] {
  const count = points[0] + Math.floor(rng() * (points[1] - points[0] + 1));
  const w = Array.from({ length: count }, () => weights[0] + (weights[1] - weights[0]) * rng());
  const total = w.reduce((a, b) => a + b, 0);
  const start = rng() * Math.PI * 2;
  const angles: number[] = [];
  let angle = start;
  for (const weight of w) {
    angles.push(angle);
    angle += (weight / total) * Math.PI * 2;
  }
  // The area of corners on the unit circle: half the sum of the sines of the arcs between them.
  let area = 0;
  for (let i = 0; i < count; i++) area += 0.5 * Math.sin(((w[i] / total) * Math.PI * 2));
  const scale = Math.sqrt(Math.PI / area);
  return angles.map((a) => ({ x: Math.cos(a) * scale, z: Math.sin(a) * scale }));
}

/** The largest share of the circle one arc of a rolled shape may be: past 150 degrees the shape is
 *  lopsided (and past 180 its middle is outside it). */
export const MAX_YARD_ARC = 150 / 360;

export function scaled(points: CellPoint[], factor: number): CellPoint[] {
  return points.map((p) => ({ x: p.x * factor, z: p.z * factor }));
}

export function translated(points: CellPoint[], x: number, z: number): CellPoint[] {
  return points.map((p) => ({ x: p.x + x, z: p.z + z }));
}

/** The polygon moved out by `d` metres on every side, its corners mitred. */
export function offsetPolygon(points: CellPoint[], d: number): CellPoint[] {
  const n = points.length;
  const normals = points.map((a, i) => {
    const b = points[(i + 1) % n];
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.z - a.z) / length, z: -(b.x - a.x) / length };
  });
  return points.map((p, i) => {
    const before = normals[(i - 1 + n) % n];
    const after = normals[i];
    const k = d / (1 + before.x * after.x + before.z * after.z);
    return { x: p.x + (before.x + after.x) * k, z: p.z + (before.z + after.z) * k };
  });
}

export function perimeter(points: CellPoint[]): number {
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return length;
}

/** The largest distance of a corner from (x, z). */
export function reachOf(points: CellPoint[], x = 0, z = 0): number {
  return Math.max(...points.map((p) => Math.hypot(p.x - x, p.z - z)));
}

/** Distance from (x, z) past the polygon's edge - 0 inside it. */
export function polygonGap(points: CellPoint[], x: number, z: number): number {
  const n = points.length;
  let inside = true;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    if (ex * (z - a.z) - ez * (x - a.x) < 0) inside = false;
    const lengthSq = ex * ex + ez * ez;
    const u = lengthSq > 0 ? Math.min(1, Math.max(0, ((x - a.x) * ex + (z - a.z) * ez) / lengthSq)) : 0;
    best = Math.min(best, Math.hypot(x - a.x - u * ex, z - a.z - u * ez));
  }
  return inside ? 0 : best;
}

/** Where a ray from the polygon's middle (the origin) at `angle` leaves it: its distance, how far
 *  round the polygon's edge that is from its first corner (`s`) and the outward unit normal there. */
export interface RayHit {
  distance: number;
  s: number;
  nx: number;
  nz: number;
}

export function rayHit(points: CellPoint[], angle: number): RayHit {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  const n = points.length;
  let before = 0;
  let best: RayHit = { distance: 0, s: 0, nx: dx, nz: dz };
  let bestDistance = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const length = Math.hypot(ex, ez) || 1;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) > 1e-9) {
      const t = (a.x * ez - a.z * ex) / den;
      const u = (a.x * dz - a.z * dx) / den;
      // The ray leaves through the edge it meets furthest out (the middle is inside).
      if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9 && t > bestDistance) {
        bestDistance = t;
        best = { distance: t, s: before + Math.min(1, Math.max(0, u)) * length, nx: ez / length, nz: -ex / length };
      }
    }
    before += length;
  }
  return best;
}

/** The point `s` metres round the polygon from its first corner (wrapping), and the outward unit
 *  normal of the edge it is on. */
export function pointAt(points: CellPoint[], s: number): { x: number; z: number; nx: number; nz: number } {
  const n = points.length;
  const total = perimeter(points);
  let left = ((s % total) + total) % total;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (left <= length || i === n - 1) {
      const t = length > 0 ? Math.min(1, left / length) : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, nx: (b.z - a.z) / (length || 1), nz: -(b.x - a.x) / (length || 1) };
    }
    left -= length;
  }
  return { x: points[0].x, z: points[0].z, nx: 1, nz: 0 };
}

/** The convex hull of some points, wound the same way as a yard's polygon (Andrew's chain). */
export function convexHull(points: CellPoint[]): CellPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: CellPoint, a: CellPoint, b: CellPoint): number => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: CellPoint[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: CellPoint[] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}
