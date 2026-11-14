// Dents (GEOMETRY.md, section 8, step 2: details that put a dent in the surface, built before the
// fill): niches cut into a wall - loculi, the shelf-like burial niches of a crypt, in rows low on its
// walls. Pure geometry like the trims beside it: a builder hands in its wall faces and what it knows
// round them, and gets back the boxes to cut out of its walls and the slabs that seal some of them,
// to build as it builds its own.

import { along, type V3, type WallFace } from "./trims";

export interface LoculiSpec {
  /** Each niche's opening, and how deep it goes into the wall. */
  width: number;
  height: number;
  depth: number;
  /** Between niches side by side, and between rows. */
  gap: number;
  rowGap: number;
  /** The lowest row's sill over the floor (over the plinth). */
  above: number;
  /** How many rows; on a wall at least `tallWall` high, `tallRows`. */
  rows: number;
  tallRows?: number;
  tallWall?: number;
  /** Kept this far from the face's ends and from the head of the wall. */
  margin: number;
  /** The share sealed by a slab, set back a little in the opening. */
  sealed: number;
}

/** What a builder knows round its walls. */
export interface DentSurroundings {
  /** The top of the floor under a point, or null. */
  floorUnder(p: V3): number | null;
  /** Whether a point is in something solid (the wall behind a niche must be). */
  solidAt(p: V3): boolean;
  /** Whether something is in the way of a niche whose box this is - a pilaster, a torch, a doorway. */
  blocked(lo: V3, hi: V3): boolean;
  /** A number in [0, 1) for a point, the same each time - which niches are sealed. */
  random(p: V3): number;
}

/** A niche: its box (eight corners) to cut out, the face it opens in (facing `n`), and its slab if sealed. */
export interface Niche {
  points: V3[];
  n: V3;
  slab: V3[] | null;
}

/**
 * Loculi along a set of wall faces: on each that stands on the floor in front of it, as many columns
 * as fit between its ends, centred, each `rows` niches high from `above` over the floor - wherever
 * the whole niche lies inside the face, the wall behind is deep enough, and nothing is in the way.
 */
export function loculi(faces: readonly WallFace[], around: DentSurroundings, spec: LoculiSpec): Niche[] {
  const niches: Niche[] = [];
  for (const f of faces) {
    if (Math.abs(f.n[1]) > 0.1) continue;
    const t = along(f.n);
    const u = (p: V3): number => p[0] * t[0] + p[2] * t[2];
    // The face in its own plane: along the wall (u) and up (y), a convex outline.
    const outline = f.corners.map((c): [number, number] => [u(c), c[1]]);
    const low = Math.min(...outline.map((p) => p[1])), high = Math.max(...outline.map((p) => p[1]));
    const u0 = Math.min(...outline.map((p) => p[0])), u1 = Math.max(...outline.map((p) => p[0]));
    const plane = f.corners[0][0] * f.n[0] + f.corners[0][2] * f.n[2];
    /** A point on the face at (along, up), `out` in front of it (negative: into the wall). */
    const at = (a: number, y: number, out = 0): V3 => {
      const base = [f.n[0] * plane, f.n[2] * plane];
      return [base[0] + t[0] * a + f.n[0] * out, y, base[1] + t[2] * a + f.n[2] * out];
    };
    // On the floor: its foot meets the floor in front of it.
    const floor = around.floorUnder(at((u0 + u1) / 2, low + 0.05, 0.05));
    if (floor === null || Math.abs(floor - low) > 0.1) continue;
    const rows = spec.tallRows !== undefined && spec.tallWall !== undefined && high - low >= spec.tallWall ? spec.tallRows : spec.rows;
    const columns = Math.floor((u1 - u0 - 2 * spec.margin + spec.gap) / (spec.width + spec.gap));
    if (columns < 1) continue;
    const start = (u0 + u1) / 2 - (columns * spec.width + (columns - 1) * spec.gap) / 2;
    for (let c = 0; c < columns; c++) {
      const a0 = start + c * (spec.width + spec.gap), a1 = a0 + spec.width;
      for (let r = 0; r < rows; r++) {
        const y0 = low + spec.above + r * (spec.height + spec.rowGap), y1 = y0 + spec.height;
        if (y1 > high - spec.margin) break;
        // Inside the face with a margin all round, the wall solid behind it all, nothing in the way.
        const m = spec.margin;
        if (![[a0 - m, y0 - m], [a1 + m, y0 - m], [a1 + m, y1 + m], [a0 - m, y1 + m]].every(([a, y]) => insideOutline(outline, a, y))) continue;
        const back = -(spec.depth + 0.15);
        if (![[a0, y0], [a1, y0], [a1, y1], [a0, y1], [(a0 + a1) / 2, (y0 + y1) / 2]].every(([a, y]) => around.solidAt(at(a, y, back)))) continue;
        const points: V3[] = [];
        for (const out of [0, -spec.depth]) for (const [a, y] of [[a0, y0], [a1, y0], [a1, y1], [a0, y1]]) points.push(at(a, y, out));
        const lo: V3 = [Math.min(...points.map((p) => p[0])), y0, Math.min(...points.map((p) => p[2]))];
        const hi: V3 = [Math.max(...points.map((p) => p[0])), y1, Math.max(...points.map((p) => p[2]))];
        if (around.blocked(lo, hi)) continue;
        // Sealed: a slab a hand thick, set back a little into the opening.
        let slab: V3[] | null = null;
        if (around.random(at((a0 + a1) / 2, y0)) < spec.sealed) {
          slab = [];
          for (const out of [-0.08, -0.2]) for (const [a, y] of [[a0, y0], [a1, y0], [a1, y1], [a0, y1]]) slab.push(at(a, y, out));
        }
        niches.push({ points, n: f.n, slab });
      }
    }
  }
  return niches;
}

/** Whether (a, y) lies inside a convex outline (either way round), on its edge counting. */
function insideOutline(outline: readonly [number, number][], a: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i], q = outline[(i + 1) % outline.length];
    const cross = (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (a - p[0]);
    if (Math.abs(cross) < 1e-6) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
