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

/** Where two segments properly cross, or null. Shared endpoints do not count - consecutive
 *  segments always have one. */
export function crossingPoint(a: CellPoint, b: CellPoint, c: CellPoint, d: CellPoint): CellPoint | null {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const denominator = rx * sz - rz * sx;
  if (denominator === 0) return null;

  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / denominator;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / denominator;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { x: a.x + rx * t, z: a.z + rz * t };
}

/**
 * Cuts out any loop the displacement created.
 *
 * A river meander offsets a line sideways, which makes it cross itself wherever the offset exceeds
 * the local radius of curvature; a road rounds a hairpin, which can do the same. Measured on
 * rivers, 1-11 crossings per seed, every one a cusp of 10-600 units of arc rather than a real
 * oxbow; on roads, 6 across the whole network.
 * Bounding the amplitude by curvature would give up real meanders everywhere to prevent them; this
 * deletes exactly the offending loop and leaves the rest of the line untouched, and it is exact
 * rather than a margin that has to be tuned.
 */
export function removeLoops(points: CellPoint[]): CellPoint[] {
  let current = points;
  for (let guard = 0; guard < 64; guard++) {
    let cut: { from: number; to: number; at: CellPoint } | null = null;
    outer: for (let i = 0; i < current.length - 1 && !cut; i++) {
      for (let j = i + 2; j < current.length - 1; j++) {
        const at = crossingPoint(current[i], current[i + 1], current[j], current[j + 1]);
        if (at) {
          cut = { from: i, to: j, at };
          break outer;
        }
      }
    }
    if (!cut) return current;
    // Keep everything up to the first segment's start, the crossing itself, then resume after the
    // second segment's start - which is precisely the loop between them, removed.
    current = [...current.slice(0, cut.from + 1), cut.at, ...current.slice(cut.to + 1)];
  }
  return current;
}
