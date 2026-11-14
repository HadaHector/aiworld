// Dents (GEOMETRY.md, section 8, step 2: details that put a dent in the surface, built before the
// fill): niches cut into a wall - loculi, the shelf-like burial niches of a crypt, in rows low on its
// walls, and arcosolia, the great arched niches a tomb chest lies in. Pure geometry like the trims beside it: a builder hands in its wall faces and what it knows
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
  /** A frame round each opening, standing out of the wall, its inner edge bevelled down into the
   *  opening: this wide, standing out this far, the bevel this wide on its face. Set the gaps to
   *  twice its width and neighbours' frames meet, a block of niches. */
  frame?: { width: number; proud: number; bevel: number };
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

/** A niche: its hollow (a convex prism's corners) to cut out, the face it opens in (facing `n`), its
 *  slab if sealed, its frame's bars (each a convex prism, with the way its stone runs), and what
 *  stands in it (an arcosolium's tomb chest: convex prisms). */
export interface Niche {
  points: V3[];
  n: V3;
  slab: V3[] | null;
  frame: { points: V3[]; grain: V3 }[];
  contents?: V3[][];
}

export interface ArcosoliaSpec {
  /** The opening: this wide, its sides this high from the sill to where the round arch springs. */
  width: number;
  rise: number;
  depth: number;
  /** The sill over the floor (on the plinth). */
  above: number;
  /** Kept this far from the face's ends and the head of the wall; at most this many a part. */
  margin: number;
  count: number;
  /** As a loculus's frame. */
  frame?: { width: number; proud: number; bevel: number };
  /** The tomb chest lying in it: this high, this far in from the opening's sides; its lid this
   *  thick, reaching this far out of the wall. */
  tomb?: { height: number; inset: number; lid: number; lidOut: number };
}

/** A wall face worked in its own plane: along the wall (u), up (y), and back to the world. */
function facePlane(f: WallFace) {
  const t = along(f.n);
  const u = (p: V3): number => p[0] * t[0] + p[2] * t[2];
  const outline = f.corners.map((c): [number, number] => [u(c), c[1]]);
  const low = Math.min(...outline.map((p) => p[1])), high = Math.max(...outline.map((p) => p[1]));
  const u0 = Math.min(...outline.map((p) => p[0])), u1 = Math.max(...outline.map((p) => p[0]));
  const plane = f.corners[0][0] * f.n[0] + f.corners[0][2] * f.n[2];
  /** A point on the face at (along, up), `out` in front of it (negative: into the wall). */
  const at = (a: number, y: number, out = 0): V3 => [f.n[0] * plane + t[0] * a + f.n[0] * out, y, f.n[2] * plane + t[2] * a + f.n[2] * out];
  return { t, outline, low, high, u0, u1, at };
}

/**
 * A frame round a convex opening (its outline in the face's plane, counter-clockwise: along, up):
 * a bar along each side, mitred where they meet - its back a little into the wall, its face standing
 * `proud` out, its inner edge bevelled down to the opening's. Given a sill, none along it and
 * none below it: the frame stands on it.
 */
function frameRound(opening: readonly [number, number][], at: (a: number, y: number, out?: number) => V3, frame: { width: number; proud: number; bevel: number }, sill?: number): Niche["frame"] {
  const n = opening.length;
  /** The outline moved out by d, each corner where its two moved sides meet. */
  const offset = (d: number): [number, number][] =>
    opening.map((q, i) => {
      const p = opening[(i + n - 1) % n], r = opening[(i + 1) % n];
      const side = (a: [number, number], b: [number, number]): [number, number] => {
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
        return [dy / l, -dx / l];
      };
      const n1 = side(p, q), n2 = side(q, r);
      const k = d / Math.max(0.2, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
      // Standing on a sill: nothing below it.
      return [q[0] + (n1[0] + n2[0]) * k, Math.max(sill ?? -Infinity, q[1] + (n1[1] + n2[1]) * k)];
    });
  const outer = offset(frame.width), bevel = offset(frame.bevel);
  const bars: Niche["frame"] = [];
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    if (sill !== undefined && opening[k][1] <= sill + 1e-6 && opening[j][1] <= sill + 1e-6) continue;
    const points = [at(...opening[k], -0.05), at(...opening[j], -0.05), at(...outer[k], -0.05), at(...outer[j], -0.05), at(...outer[k], frame.proud), at(...outer[j], frame.proud), at(...bevel[k], frame.proud), at(...bevel[j], frame.proud)];
    const from = at(...opening[k]), to = at(...opening[j]);
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], l = Math.hypot(d[0], d[1], d[2]) || 1;
    bars.push({ points, grain: [d[0] / l, d[1] / l, d[2] / l] });
  }
  return bars;
}

/**
 * Arcosolia: a great niche with a round arch, a tomb chest lying in it, centred on a wall face that
 * stands on the floor - the centrepiece of an end wall, or of an alcove. The narrowest faces it fits
 * first (a hall's end walls before its sides), at most `count`, never two on one wall.
 */
export function arcosolia(faces: readonly WallFace[], around: DentSurroundings, spec: ArcosoliaSpec): Niche[] {
  const niches: Niche[] = [];
  const fw = spec.frame?.width ?? 0;
  const candidates = faces
    .filter((f) => Math.abs(f.n[1]) < 0.1)
    .map((f) => ({ f, p: facePlane(f) }))
    .filter(({ p }) => p.u1 - p.u0 >= spec.width + 2 * (fw + spec.margin))
    .sort((a, b) => a.p.u1 - a.p.u0 - (b.p.u1 - b.p.u0));
  const used: { n: V3; d: number }[] = [];
  for (const { f, p } of candidates) {
    if (niches.length >= spec.count) break;
    const d = f.corners[0][0] * f.n[0] + f.corners[0][2] * f.n[2];
    if (used.some((w) => w.n[0] * f.n[0] + w.n[2] * f.n[2] > 0.99 && Math.abs(w.d - d) < 0.1)) continue;
    const floor = around.floorUnder(p.at((p.u0 + p.u1) / 2, p.low + 0.05, 0.05));
    if (floor === null || Math.abs(floor - p.low) > 0.1) continue;
    const mid = (p.u0 + p.u1) / 2, r = spec.width / 2;
    const a0 = mid - r, a1 = mid + r, y0 = p.low + spec.above, spring = y0 + spec.rise, apex = spring + r;
    if (apex + fw > p.high - spec.margin) continue;
    // The opening: its sill, its sides, the round arch over them (counter-clockwise).
    const arch = 12;
    const opening: [number, number][] = [[a0, y0], [a1, y0]];
    for (let i = 0; i <= arch; i++) opening.push([mid + r * Math.cos((Math.PI * i) / arch), spring + r * Math.sin((Math.PI * i) / arch)]);
    const m = spec.margin + fw;
    if (![[a0 - m, y0], [a1 + m, y0], [a1 + m, apex + m], [a0 - m, apex + m]].every(([a, y]) => insideOutline(p.outline, a, y))) continue;
    const back = -(spec.depth + 0.15);
    if (![[a0, y0], [a1, y0], [a1, spring], [a0, spring], [mid, apex], [mid, y0 + 1]].every(([a, y]) => around.solidAt(p.at(a, y, back)))) continue;
    const room = [p.at(a0 - fw, y0), p.at(a1 + fw, y0), p.at(a0 - fw, y0, -spec.depth), p.at(a1 + fw, y0, -spec.depth)];
    const lo: V3 = [Math.min(...room.map((q) => q[0])), y0, Math.min(...room.map((q) => q[2]))];
    const hi: V3 = [Math.max(...room.map((q) => q[0])), apex + fw, Math.max(...room.map((q) => q[2]))];
    if (around.blocked(lo, hi)) continue;
    const points = [0, -spec.depth].flatMap((out) => opening.map(([a, y]) => p.at(a, y, out)));
    const frame = spec.frame ? frameRound(opening, p.at, spec.frame, y0) : [];
    // The tomb chest: a box from the back of the niche to just behind the wall's face, its lid over
    // it a little wider and standing out of the wall.
    const contents: V3[][] = [];
    if (spec.tomb) {
      const { height, inset, lid, lidOut } = spec.tomb;
      const box = (b0: number, b1: number, h0: number, h1: number, back: number, front: number): V3[] =>
        [back, front].flatMap((out) => [[b0, h0], [b1, h0], [b1, h1], [b0, h1]].map(([a, y]) => p.at(a, y, out)));
      contents.push(box(a0 + inset, a1 - inset, y0 - 0.02, y0 + height, -spec.depth + 0.02, -0.04));
      contents.push(box(a0 + inset - 0.1, a1 - inset + 0.1, y0 + height, y0 + height + lid, -spec.depth + 0.02, lidOut));
    }
    niches.push({ points, n: f.n, slab: null, frame, contents });
    used.push({ n: f.n, d });
  }
  return niches;
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
    /** The niche at a0 in row r, or null where it does not fit or something is in the way. */
    const nicheAt = (a0: number, r: number): Niche | null => {
      const a1 = a0 + spec.width;
      const y0 = low + spec.above + r * (spec.height + spec.rowGap), y1 = y0 + spec.height;
      if (y1 > high - spec.margin) return null;
      // Inside the face with a margin all round, the wall solid behind it all, nothing in the way.
      const m = spec.margin;
      if (![[a0 - m, y0 - m], [a1 + m, y0 - m], [a1 + m, y1 + m], [a0 - m, y1 + m]].every(([a, y]) => insideOutline(outline, a, y))) return null;
      const back = -(spec.depth + 0.15);
      if (![[a0, y0], [a1, y0], [a1, y1], [a0, y1], [(a0 + a1) / 2, (y0 + y1) / 2]].every(([a, y]) => around.solidAt(at(a, y, back)))) return null;
      const points: V3[] = [];
      for (const out of [0, -spec.depth]) for (const [a, y] of [[a0, y0], [a1, y0], [a1, y1], [a0, y1]]) points.push(at(a, y, out));
      // What it takes up, its frame with it.
      const fw = spec.frame?.width ?? 0;
      const room = [at(a0 - fw, y0, 0), at(a1 + fw, y0, 0), ...points];
      const lo: V3 = [Math.min(...room.map((p) => p[0])), y0 - fw, Math.min(...room.map((p) => p[2]))];
      const hi: V3 = [Math.max(...room.map((p) => p[0])), y1 + fw, Math.max(...room.map((p) => p[2]))];
      if (around.blocked(lo, hi)) return null;
      // Sealed: a slab a hand thick, set back a little into the opening.
      let slab: V3[] | null = null;
      if (around.random(at((a0 + a1) / 2, y0)) < spec.sealed) {
        slab = [];
        for (const out of [-0.08, -0.2]) for (const [a, y] of [[a0, y0], [a1, y0], [a1, y1], [a0, y1]]) slab.push(at(a, y, out));
      }
      // The frame: a bar along each side, mitred at the corners - its back a little into the wall,
      // its face standing out, the inner edge bevelled down to the opening's.
      const frame: Niche["frame"] = [];
      if (spec.frame) {
        const { width: w, proud, bevel } = spec.frame;
        const corners: [number, number][] = [[a0, y0], [a1, y0], [a1, y1], [a0, y1]];
        const away: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (let k = 0; k < 4; k++) {
          const pts: V3[] = [];
          for (const j of [k, (k + 1) % 4]) {
            const [a, y] = corners[j], [sa, sy] = away[j];
            pts.push(at(a, y, -0.05), at(a + sa * w, y + sy * w, -0.05), at(a + sa * w, y + sy * w, proud), at(a + sa * bevel, y + sy * bevel, proud));
          }
          const [p, q] = [corners[k], corners[(k + 1) % 4]];
          const run = at(q[0], q[1]), from = at(p[0], p[1]);
          const d = [run[0] - from[0], run[1] - from[1], run[2] - from[2]], l = Math.hypot(d[0], d[1], d[2]) || 1;
          frame.push({ points: pts, grain: [d[0] / l, d[1] / l, d[2] / l] });
        }
      }
      return { points, n: f.n, slab, frame };
    };
    // Columns where the lowest row fits: along the face a little at a time, each clear stretch filled
    // with as many columns as it holds, centred in it - so a pilaster, a torch or a doorway splits
    // the wall into stretches rather than knocking out columns laid on one grid.
    const step = 0.05, pitch = spec.width + spec.gap;
    let run: number | null = null;
    const fill = (from: number, to: number) => {
      const count = Math.floor((to - from) / pitch + 1e-6) + 1;
      const first = from + (to - from - (count - 1) * pitch) / 2;
      for (let c = 0; c < count; c++) {
        for (let r = 0; r < rows; r++) {
          const niche = nicheAt(first + c * pitch, r);
          if (niche) niches.push(niche);
        }
      }
    };
    for (let a0 = u0; a0 <= u1 - spec.width + 1e-6; a0 += step) {
      const fits = nicheAt(a0, 0) !== null;
      if (fits && run === null) run = a0;
      if (!fits && run !== null) {
        fill(run, a0 - step);
        run = null;
      }
    }
    if (run !== null) fill(run, u1 - spec.width);
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
