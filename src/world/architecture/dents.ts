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
  /** A breach (see `breaches`): its inside the wall's core, and the blocks fallen out of it lying
   *  heaped at its foot (convex chunks). */
  breach?: boolean;
  fallen?: V3[][];
}

/** A course of a wall's stone, as its texture lays it (twice life size): a breach steps by it. */
const COURSE = 0.6;

export interface BreachSpec {
  /** The share of the walls it could be in that have one; at most this many a part. */
  share: number;
  count: number;
  /** Its size (each rolled between), how deep it goes into the wall, and its foot over the floor. */
  width: [number, number];
  height: [number, number];
  depth: number;
  above: number;
  /** Kept this far from the face's ends and from the head of the wall. */
  margin: number;
  /** How many blocks lie fallen at its foot, and how big each is (rolled between). */
  stones: [number, number];
  size: [number, number];
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

/**
 * Breaches: where blocks have come away from a wall - a shallow ragged hollow in it, the wall's core
 * showing, and the blocks lying heaped at its foot, widest at the wall and thinning across the
 * floor. On faces standing on the floor and long and high enough, `share` of them (at most `count`),
 * wherever the hollow lies inside the face with wall behind it and nothing is in the way of it or
 * of its heap (`blocked` asked of the hollow, `heapBlocked` of the floor its heap lies on).
 */
export function breaches(faces: readonly WallFace[], around: DentSurroundings, spec: BreachSpec, heapBlocked: (lo: V3, hi: V3) => boolean): Niche[] {
  const out: Niche[] = [];
  let placed = 0;
  for (const f of faces) {
    if (placed >= spec.count) break;
    if (Math.abs(f.n[1]) > 0.1) continue;
    const p = facePlane(f);
    const mid0 = (p.u0 + p.u1) / 2;
    if (around.random(p.at(mid0, p.low + 0.5, 0.3)) >= spec.share) continue;
    // Its own rolls, from where it is.
    let seed = Math.floor(around.random(p.at(mid0, p.low + 1, 0.7)) * 2 ** 31) | 1;
    const roll = (): number => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const between = ([a, b]: [number, number]): number => a + (b - a) * roll();
    const w = between(spec.width), h = between(spec.height);
    if (p.u1 - p.u0 < w + 2 * spec.margin) continue;
    const floor = around.floorUnder(p.at(mid0, p.low + 0.05, 0.05));
    if (floor === null || Math.abs(floor - p.low) > 0.1) continue;
    const y0 = floor + spec.above;
    if (y0 + h > p.high - spec.margin) continue;
    const mid = p.u0 + spec.margin + w / 2 + roll() * (p.u1 - p.u0 - 2 * spec.margin - w);
    // The hollow: course by course, whole blocks gone - widest and deepest in its middle courses,
    // each course's run and depth its own - so its edge steps as the coursing does.
    const rows = Math.max(2, Math.round(h / COURSE));
    const course = h / rows;
    const runs: { a0: number; a1: number; y0: number; y1: number; deep: number }[] = [];
    for (let k = 0; k < rows; k++) {
      const shape = Math.sin((Math.PI * (k + 0.5)) / rows) ** 0.7;
      const half = (w / 2) * (0.45 + 0.55 * shape) * (0.85 + 0.25 * roll());
      const centre = Math.min(mid + w / 2 - half, Math.max(mid - w / 2 + half, mid + (roll() - 0.5) * 0.3 * w));
      runs.push({ a0: centre - half, a1: centre + half, y0: y0 + k * course, y1: y0 + (k + 1) * course, deep: spec.depth * (0.55 + 0.45 * shape) * (0.8 + 0.25 * roll()) });
    }
    if (!runs.every((r) => [[r.a0, r.y0], [r.a1, r.y0], [r.a1, r.y1], [r.a0, r.y1]].every(([a, y]) => insideOutline(p.outline, a, y)))) continue;
    if (!runs.every((r) => [[r.a0, r.y0], [r.a1, r.y1], [(r.a0 + r.a1) / 2, (r.y0 + r.y1) / 2]].every(([a, y]) => around.solidAt(p.at(a, y, -r.deep - 0.15))))) continue;
    const reach = 1.8;
    const box = (pts: V3[], y0b: number, y1b: number): [V3, V3] => [[Math.min(...pts.map((q) => q[0])), y0b, Math.min(...pts.map((q) => q[2]))], [Math.max(...pts.map((q) => q[0])), y1b, Math.max(...pts.map((q) => q[2]))]];
    const hollow = box([p.at(mid - w / 2, y0), p.at(mid + w / 2, y0), p.at(mid - w / 2, y0, -spec.depth), p.at(mid + w / 2, y0, -spec.depth)], y0, y0 + h);
    if (around.blocked(...hollow)) continue;
    const heap = box([p.at(mid - w * 0.75, floor), p.at(mid + w * 0.75, floor), p.at(mid - w * 0.75, floor, reach), p.at(mid + w * 0.75, floor, reach)], floor, floor + 1);
    if (heapBlocked(...heap)) continue;
    // The heap: blocks out from the wall's foot, the biggest nearest it, piled where it is highest.
    const fallen: V3[][] = [];
    const count = Math.round(between(spec.stones));
    for (let k = 0; k < count; k++) {
      const du = (roll() + roll() - 1) * w * 0.7;
      const dv = 0.2 + Math.abs(roll() + roll() - 1) * reach;
      const near = Math.max(0, 1 - dv / reach);
      const s = spec.size[0] + (spec.size[1] - spec.size[0]) * (0.35 + 0.65 * near) * (0.6 + 0.4 * roll());
      const pile = 0.9 * Math.max(0, 1 - (du / (w * 0.75)) ** 2 - (dv / reach) ** 2);
      const half: V3 = [s * (0.45 + 0.25 * roll()), s * (0.25 + 0.15 * roll()), s * (0.35 + 0.2 * roll())];
      const v = Math.max(dv, half[2] + 0.18);
      const centre = p.at(mid + du, floor + Math.max(half[1] * 0.8, pile - half[1]), v);
      // Turned about the upright and tipped a little, each corner knocked about.
      const yaw = roll() * Math.PI, tip = (roll() - 0.5) * 0.6, lean = (roll() - 0.5) * 0.6;
      const piece: V3[] = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        let x = sx * half[0] * (0.75 + 0.25 * roll()), y = sy * half[1] * (0.75 + 0.25 * roll()), z = sz * half[2] * (0.75 + 0.25 * roll());
        [y, z] = [y * Math.cos(tip) - z * Math.sin(tip), y * Math.sin(tip) + z * Math.cos(tip)];
        [x, y] = [x * Math.cos(lean) - y * Math.sin(lean), x * Math.sin(lean) + y * Math.cos(lean)];
        [x, z] = [x * Math.cos(yaw) - z * Math.sin(yaw), x * Math.sin(yaw) + z * Math.cos(yaw)];
        piece.push([centre[0] + x, Math.max(floor - 0.05, centre[1] + y), centre[2] + z]);
      }
      fallen.push(piece);
    }
    // Each course a hollow of its own, the heap with the lowest.
    runs.forEach((r, k) => {
      const points = [0, -r.deep].flatMap((o) => [p.at(r.a0, r.y0, o), p.at(r.a1, r.y0, o), p.at(r.a1, r.y1, o), p.at(r.a0, r.y1, o)]);
      out.push({ points, n: f.n, slab: null, frame: [], breach: true, fallen: k === 0 ? fallen : undefined });
    });
    placed++;
  }
  return out;
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
