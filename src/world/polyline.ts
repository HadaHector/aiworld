import type { CellPoint } from "./cells/cellGrid";

/**
 * Polyline shaping shared by everything in the world that is a line on the ground - river
 * centrelines and roads today.
 *
 * Both want the same two things from a raw generated path: rounded corners, and then as few points
 * as can carry the shape. They were written for rivers first and moved here unchanged when roads
 * needed exactly the same treatment, rather than being copied.
 */

/** Chaikin corner cutting, with both ends pinned - a river mouth has to stay exactly on the shore
 *  it was placed on, and a road has to stay attached to the settlements it runs between. */
export function chaikin(points: CellPoint[], passes: number): CellPoint[] {
  let current = points;
  for (let pass = 0; pass < passes; pass++) {
    if (current.length < 3) return current;
    const next: CellPoint[] = [current[0]];
    for (let i = 0; i < current.length - 1; i++) {
      const a = current[i];
      const b = current[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

/**
 * Ramer-Douglas-Peucker. Smoothing leaves points every few units, and a segment index tests every
 * segment in a bucket against every terrain sample - so the segment count is a direct cost on
 * terrain generation. Dropping points that sit within a couple of units of the line through their
 * neighbours cuts that by an order of magnitude and is invisible at the width these features carve.
 */
export function simplify(points: CellPoint[], tolerance: number): CellPoint[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const toleranceSq = tolerance * tolerance;

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    const a = points[first];
    const b = points[last];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;

    let worst = -1;
    let worstDistSq = 0;
    for (let i = first + 1; i < last; i++) {
      const px = points[i].x - a.x;
      const pz = points[i].z - a.z;
      const u = lengthSq > 0 ? Math.min(1, Math.max(0, (px * dx + pz * dz) / lengthSq)) : 0;
      const ox = px - u * dx;
      const oz = pz - u * dz;
      const distSq = ox * ox + oz * oz;
      if (distSq > worstDistSq) {
        worstDistSq = distSq;
        worst = i;
      }
    }

    if (worst >= 0 && worstDistSq > toleranceSq) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  return points.filter((_, i) => keep[i] === 1);
}
