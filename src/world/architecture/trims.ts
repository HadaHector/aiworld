// Trims (GEOMETRY.md, sections 7-9): the bands of stone or wood that run along the borders of a
// built thing's grid - where a wall meets the floor (a plinth), where it meets the ceiling or vault
// (a cornice), round a pier, across a vault (a rib). Pure geometry, no engine and nothing of any one
// kind of building: a builder hands in its wall faces and what is over and under them, and gets
// back solid pieces (convex prisms) to build or draw as it builds its own - a dungeon part adds them
// to its solids, a house could lay them into its model.

import type { LoculiSpec } from "./dents";

export type V3 = [number, number, number];

/** A flat wall face: its corners (a convex polygon, standing upright) and which way it faces. */
export interface WallFace {
  n: V3;
  corners: V3[];
}

/** A band's section: how high it is, and how far it stands out from the face it runs along. */
export interface TrimProfile {
  height: number;
  proud: number;
}

/** What a builder knows about the space in front of its walls. */
export interface TrimSurroundings {
  /** The top of the floor under a point, or null where there is none. */
  floorUnder(p: V3): number | null;
  /** The underside of the ceiling or vault over a point, or null where there is none. */
  ceilingOver(p: V3): number | null;
  /** Whether the floor under a point (for a plinth) or the vault over it (for a cornice) is a
   *  stair's step: no level band there - the stair's own runs along it (see `stairBands`). A builder
   *  without it gets no band on a run shorter than `stepRun` instead. */
  stair?(p: V3, kind: "plinth" | "cornice"): boolean;
}

/** A trim piece: which band it is, and its corners - a convex prism, eight points or more. */
export interface TrimPiece {
  kind: "plinth" | "cornice" | "rib" | "pilaster" | "block" | "coping";
  points: V3[];
  /** Which way its stone runs, where that is not level along the wall (a stair's band, sloping). */
  grain?: V3;
  /** Where its stone's courses start: a joint on the point, so pieces meeting there meet joint to joint. */
  uvOrigin?: V3;
}

export interface WallTrims {
  /** Along the foot of a wall that stands on a floor. */
  plinth?: TrimProfile;
  /** Along the head of a wall that meets a ceiling or vault. */
  cornice?: TrimProfile;
  /** A wall lower than this gets neither (a riser, a sliver left between two openings), nor one
   *  shorter than `minRun` (an opening's reveal, a wall's thickness deep: its frame trims it). */
  minHeight?: number;
  minRun?: number;
  /** How far a face's foot or head may lie from the floor or ceiling and still meet it. */
  tolerance?: number;
  /** A band whose run - with the bands at its height it meets end to end - is shorter than this is
   *  on a stair's step: none there (a stair's own trim is something else). */
  stepRun?: number;
  /** Ribs across flat ceilings, pilasters under them (see `ribs`) - for a builder that has spans. */
  ribs?: RibSpec;
  /** A stone laid on top of a railing or parapet, wider than it (see `copings`). */
  coping?: CopingSpec;
  /** Burial niches cut low into the walls (see `loculi` in ./dents) - a dent, not a trim, but laid
   *  out with them, between the pilasters. */
  loculi?: LoculiSpec;
}

export interface CopingSpec {
  /** How thick the stone is, and how far it reaches out past the railing's sides. */
  height: number;
  overhang: number;
}

/**
 * Copings (GEOMETRY.md, 7: a band where a wall ends at the top): on each railing's top - its corners,
 * a flat convex outline at one height - a stone as thick as `height`, reaching `overhang` out past
 * every side, so the railing reads as built and not as a slab.
 */
export function copings(tops: readonly V3[][], spec: CopingSpec): TrimPiece[] {
  const pieces: TrimPiece[] = [];
  for (const top of tops) {
    if (top.length < 3) continue;
    // The top's plane (it may slope, a railing down a flight): its height over any point of the plan.
    const [a, b, c] = [top[0], top.find((p) => Math.hypot(p[0] - top[0][0], p[2] - top[0][2]) > 1e-3)!, top.reduce((best, p) => {
      const area = (q: V3) => Math.abs((top[1][0] - top[0][0]) * (q[2] - top[0][2]) - (q[0] - top[0][0]) * (top[1][2] - top[0][2]));
      return area(p) > area(best) ? p : best;
    })];
    const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nrm: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (Math.abs(nrm[1]) < 1e-6) continue;
    const heightAt = (x: number, z: number): number => a[1] - (nrm[0] * (x - a[0]) + nrm[2] * (z - a[2])) / nrm[1];
    // The outline round the corners (a hull, counter-clockwise seen from above), each side moved out.
    const plan = hull2(top.map((c): [number, number] => [c[0], c[2]]));
    if (plan.length < 3) continue;
    const n = plan.length;
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const p = plan[(i + n - 1) % n], q = plan[i], r = plan[(i + 1) % n];
      // The outward normals of the two sides meeting at q, and the corner where the moved sides meet.
      const n1 = outward(p, q), n2 = outward(q, r);
      const bis: [number, number] = [n1[0] + n2[0], n1[1] + n2[1]];
      const k = spec.overhang / Math.max(0.2, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
      out.push([q[0] + bis[0] * k, q[1] + bis[1] * k]);
    }
    // Its stone along its longest side, up the slope with it.
    let long = 0, grain: V3 = [1, 0, 0];
    for (let i = 0; i < n; i++) {
      const [p, q] = [out[i], out[(i + 1) % n]];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l <= long) continue;
      long = l;
      const dy = heightAt(q[0], q[1]) - heightAt(p[0], p[1]);
      const m = Math.hypot(l, dy);
      grain = [(q[0] - p[0]) / m, dy / m, (q[1] - p[1]) / m];
    }
    pieces.push({ kind: "coping", grain, points: [...out.map(([x, z]): V3 => [x, heightAt(x, z) - 0.02, z]), ...out.map(([x, z]): V3 => [x, heightAt(x, z) + spec.height, z])] });
  }
  return pieces;
}

/** A side's outward normal, for an outline running counter-clockwise seen from above (x right, z up the page). */
function outward(a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  return [dz / l, -dx / l];
}

/** The convex hull of points in the plan, counter-clockwise (x, z), close points merged. */
function hull2(points: [number, number][]): [number, number][] {
  const ps = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-4);
  if (ps.length < 3) return ps;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of ps) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  for (const p of [...ps].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Horizontal, along a wall facing `n`. */
export function along(n: V3): V3 {
  const l = Math.hypot(n[0], n[2]) || 1;
  return [-n[2] / l, 0, n[0] / l];
}

/**
 * A band's prism along a wall from `a` to `b` (both on the wall's face, at the band's foot height):
 * `height` up from there, standing `proud` out of the face (along its outward normal `n`), and running
 * `extend` past each end - so two bands meeting at a corner close it, outside corners included.
 */
export function bandPrism(a: V3, b: V3, n: V3, y0: number, y1: number, proud: number, extend = 0): V3[] {
  const t = along(n);
  const dir = dot([b[0] - a[0], 0, b[2] - a[2]], t) >= 0 ? 1 : -1;
  const ta: V3 = [a[0] - t[0] * extend * dir, 0, a[2] - t[2] * extend * dir];
  const tb: V3 = [b[0] + t[0] * extend * dir, 0, b[2] + t[2] * extend * dir];
  const out = (p: V3, k: number): V3 => [p[0] + n[0] * k, 0, p[2] + n[2] * k];
  // Into the wall a little too, so the band is never a sheet on the face.
  const back = Math.min(0.1, proud);
  const plan = [out(ta, -back), out(tb, -back), out(tb, proud), out(ta, proud)];
  return [...plan.map(([x, , z]): V3 => [x, y0, z]), ...plan.map(([x, , z]): V3 => [x, y1, z])];
}

/**
 * The plinths and cornices of a set of wall faces: a plinth along every face whose foot stands on
 * the floor in front of it, a cornice along every face whose head meets the ceiling or vault over
 * it. Each band runs the face's width and a little past, so the bands of faces meeting at a corner
 * close round it; a builder that cuts overlapping solids against each other (as a dungeon part does)
 * keeps them from flickering where they overlap.
 */
export function wallTrims(faces: readonly WallFace[], around: TrimSurroundings, spec: WallTrims, stairs?: StairEdges): TrimPiece[] {
  const tolerance = spec.tolerance ?? 0.1;
  const minHeight = spec.minHeight ?? 1.5;
  const minRun = spec.minRun ?? 1.5;
  const stepRun = spec.stepRun ?? 4;
  /** Each band found - its kind, its ends along the wall, its face's facing, the height it meets the
   *  floor or ceiling at, its bottom and top - before pieces of one wall are joined and short ones dropped. */
  interface Band {
    kind: "plinth" | "cornice";
    ends: [V3, V3];
    n: V3;
    y: number;
    y0: number;
    y1: number;
    proud: number;
  }
  const found: Band[] = [];
  for (const f of faces) {
    if (Math.abs(f.n[1]) > 0.1) continue;
    let low = Infinity, high = -Infinity;
    for (const c of f.corners) {
      low = Math.min(low, c[1]);
      high = Math.max(high, c[1]);
    }
    if (high - low < minHeight) continue;
    const t = along(f.n);
    /** The face's ends along its run, at a height: from the corners within a hand of it. */
    const ends = (y: number): [V3, V3] | null => {
      const near = f.corners.filter((c) => Math.abs(c[1] - y) < 1e-3);
      if (near.length < 2) return null;
      let lo = near[0], hi = near[0];
      for (const c of near) {
        if (dot(c, t) < dot(lo, t)) lo = c;
        if (dot(c, t) > dot(hi, t)) hi = c;
      }
      return dot(hi, t) - dot(lo, t) > 1e-3 ? [lo, hi] : null;
    };
    const front = (c: V3, y: number): V3 => [c[0] + f.n[0] * 0.05, y, c[2] + f.n[2] * 0.05];
    if (spec.plinth) {
      const foot = ends(low);
      const mid: V3 | null = foot && [(foot[0][0] + foot[1][0]) / 2, low, (foot[0][2] + foot[1][2]) / 2];
      const floor = mid && around.floorUnder(front(mid, low + 0.05));
      if (foot && floor !== null && floor !== undefined && Math.abs(floor - low) < tolerance) {
        const p = spec.plinth;
        found.push({ kind: "plinth", ends: foot, n: f.n, y: low, y0: low, y1: low + Math.min(p.height, (high - low) / 3), proud: p.proud });
      }
    }
    if (spec.cornice) {
      const head = ends(high);
      const mid: V3 | null = head && [(head[0][0] + head[1][0]) / 2, high, (head[0][2] + head[1][2]) / 2];
      const ceiling = mid && around.ceilingOver(front(mid, high - 0.05));
      if (head && ceiling !== null && ceiling !== undefined && Math.abs(ceiling - high) < tolerance) {
        const c = spec.cornice;
        found.push({ kind: "cornice", ends: head, n: f.n, y: high, y0: high - Math.min(c.height, (high - low) / 3), y1: high, proud: c.proud });
      }
    }
  }
  // One wall built of several solids (a wall's end flush with the next wall's face) is several faces
  // in a line: their bands joined into one, so a short piece at a corner is not dropped as too short.
  const length = (b: Band): number => Math.hypot(b.ends[1][0] - b.ends[0][0], b.ends[1][2] - b.ends[0][2]);
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < found.length && !merged; i++) {
      for (let j = i + 1; j < found.length && !merged; j++) {
        const a = found[i], b = found[j];
        if (a.kind !== b.kind || Math.abs(a.y0 - b.y0) > 0.01 || Math.abs(a.y1 - b.y1) > 0.01 || dot(a.n, b.n) < 0.999) continue;
        if (Math.abs(dot(a.ends[0], a.n) - dot(b.ends[0], a.n)) > 0.01) continue;
        if (!a.ends.some((e) => b.ends.some((g) => Math.hypot(e[0] - g[0], e[2] - g[2]) < 0.05))) continue;
        const t = along(a.n);
        const all = [...a.ends, ...b.ends];
        let lo = all[0], hi = all[0];
        for (const c of all) {
          if (dot(c, t) < dot(lo, t)) lo = c;
          if (dot(c, t) > dot(hi, t)) hi = c;
        }
        found[i] = { ...a, ends: [lo, hi] };
        found.splice(j, 1);
        merged = true;
      }
    }
  }
  const long = found.filter((b) => length(b) >= minRun);
  found.length = 0;
  found.push(...long);
  // Bands of a kind at one height meeting end to end are one run (a round wall's facets); a run
  // shorter than stepRun - a stair's step, each at its own height - gets none (a stair's own trim is
  // something else).
  let kept: Band[];
  if (around.stair) {
    // Told where the stairs are: every band but those on a step (a landing's, however short, kept).
    kept = found.filter((b) => {
      const m: V3 = [(b.ends[0][0] + b.ends[1][0]) / 2 + b.n[0] * 0.05, b.kind === "plinth" ? b.y + 0.05 : b.y - 0.05, (b.ends[0][2] + b.ends[1][2]) / 2 + b.n[2] * 0.05];
      return !around.stair!(m, b.kind);
    });
  } else {
    const group = found.map((_, i) => i);
    const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
    found.forEach((a, i) => {
      for (let j = 0; j < i; j++) {
        const b = found[j];
        if (a.kind !== b.kind || Math.abs(a.y - b.y) > 0.05) continue;
        if (a.ends.some((e) => b.ends.some((g) => Math.hypot(e[0] - g[0], e[2] - g[2]) < 0.3))) group[root(i)] = root(j);
      }
    });
    const run = new Map<number, number>();
    found.forEach((a, i) => run.set(root(i), (run.get(root(i)) ?? 0) + length(a)));
    kept = found.filter((_, i) => run.get(root(i))! >= stepRun);
  }
  const pieces = kept.map((b): TrimPiece => ({ kind: b.kind, points: bandPrism(b.ends[0], b.ends[1], b.n, b.y0, b.y1, b.proud, b.proud) }));
  if (stairs) {
    if (spec.plinth) pieces.push(...stairBands(stairs.treads, "plinth", spec.plinth));
    if (spec.cornice) pieces.push(...stairBands(stairs.vaults, "cornice", spec.cornice));
  }
  return pieces;
}

/** An edge of a stair's step where it meets a wall: along the wall at the step's height (`a`, `b`),
 *  the wall facing `n`. A tread's edge for the plinth; the vault's over the step for the cornice. */
export interface StairEdge {
  a: V3;
  b: V3;
  n: V3;
}

export interface StairEdges {
  treads: StairEdge[];
  vaults: StairEdge[];
}

/**
 * A stair's plinth or cornice (GEOMETRY.md, 7: a band runs on along the border it follows - up a
 * flight too): no band a step, but one sloping with the flight along its pitch line, as a stair's
 * stringer does. Edges meeting end to end a step apart are one flight; along it the band's line runs
 * through the middle of each step, its foot (a plinth's) or head (a cornice's) sunk into the steps
 * or the vault, so a step shows at least the band's height of it. Only a flight of three steps or more.
 */
export function stairBands(edges: readonly StairEdge[], kind: "plinth" | "cornice", profile: TrimProfile): TrimPiece[] {
  const pieces: TrimPiece[] = [];
  const near = (p: V3, q: V3): boolean => Math.hypot(p[0] - q[0], p[2] - q[2]) < 0.3;
  const group = edges.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  edges.forEach((e, i) => {
    for (let j = 0; j < i; j++) {
      const f = edges[j];
      if (dot(e.n, f.n) < 0.5 || Math.abs(e.a[1] - f.a[1]) > 0.6) continue;
      if ([e.a, e.b].some((p) => near(p, f.a) || near(p, f.b))) group[root(i)] = root(j);
    }
  });
  const flights = new Map<number, number[]>();
  edges.forEach((_, i) => flights.set(root(i), [...(flights.get(root(i)) ?? []), i]));
  for (const members of flights.values()) {
    const heights = [...new Set(members.map((i) => Math.round(edges[i].a[1] * 100) / 100))].sort((p, q) => p - q);
    if (heights.length < 3) continue;
    const steps = heights.slice(1).map((h, k) => h - heights[k]).sort((p, q) => p - q);
    const rise = steps[Math.floor(steps.length / 2)];
    const at = (i: number) => Math.round(edges[i].a[1] * 100) / 100;
    /** A step along this wall: its edges (maybe in pieces), their extent along the wall, which way is
     *  up the flight (towards the step above, away from the one below; 0 where neither is). */
    const stepOf = (y: number, t: V3) => {
      const same = members.filter((j) => at(j) === y);
      const ts = same.flatMap((j) => [dot(edges[j].a, t), dot(edges[j].b, t)]);
      const t0 = Math.min(...ts), t1 = Math.max(...ts);
      const mid = (j: number) => (dot(edges[j].a, t) + dot(edges[j].b, t)) / 2;
      const above = members.filter((j) => Math.abs(at(j) - y - rise) < 0.02);
      const below = members.filter((j) => Math.abs(y - at(j) - rise) < 0.02);
      let up = 0;
      if (above.length) up = mid(above[0]) > (t0 + t1) / 2 ? 1 : -1;
      else if (below.length) up = mid(below[0]) > (t0 + t1) / 2 ? -1 : 1;
      const corners = same.flatMap((j) => [edges[j].a, edges[j].b]);
      const point = (tv: number) => corners.reduce((p, q) => (Math.abs(dot(q, t) - tv) < Math.abs(dot(p, t) - tv) ? q : p));
      return { same, t0, t1, up, top: above.length === 0, foot: below.length === 0, point };
    };
    /**
     * A flight's end step: where its block ends towards the flight, and the band's edge there - its
     * top (a plinth's) or bottom (a cornice's), the pitch line half a step from the step's middle -
     * so the block's courses and the band's meet joint to joint there.
     */
    const joint = (y: number, t: V3, top: boolean) => {
      const st = stepOf(y, t);
      const side = top ? st.up : -st.up;
      const tFar = side > 0 ? st.t0 : st.t1, tEnd = side > 0 ? st.t1 : st.t0;
      const lineFar = top ? y - rise / 2 : y + rise / 2;
      const edge = kind === "plinth" ? lineFar + rise / 2 + profile.height : lineFar - rise / 2 - profile.height;
      return { st, side, tFar, tEnd, edge, at: st.point(tFar) };
    };
    const yTop = heights[heights.length - 1];
    /** How far down the band's edge it is from where it meets the top block to a step's upper end:
     *  each step between along its own slope - so its stone runs on round a turning flight. */
    const slope = (h: number): number => {
      const st = stepOf(h, along(edges[members.find((j) => at(j) === h)!].n));
      return Math.hypot(st.t1 - st.t0, rise);
    };
    const fromTop = (y: number): number => heights.filter((h) => h > y + 0.01 && h < yTop - 0.01).reduce((sum, h) => sum + slope(h), 0);
    for (const i of members) {
      const e = edges[i], y = at(i);
      const t = along(e.n);
      const { same, t0, t1, up, top, foot, point } = stepOf(y, t);
      if (t1 - t0 < 1e-3) continue;
      if (up === 0) {
        // Level, between steps of the same height (a vault kept level over a spiral's first lap).
        const [y0, y1] = kind === "plinth" ? [y, y + profile.height] : [y - profile.height, y];
        pieces.push({ kind, points: bandPrism(e.a, e.b, e.n, y0, y1, profile.proud, profile.proud) });
        continue;
      }
      // A flight's end step (no step above, or none below): a block over the whole step and on past
      // it, where the flight's band meets the level one beyond - the joint hidden, no short piece of
      // band beside it. A course taller than the band where they meet, its courses laid from there.
      // Once a step (its edge may be in pieces).
      if (top || foot) {
        if (i !== same[0]) continue;
        const j = joint(y, t, top);
        const past = 0.5, out = profile.proud + 0.1, back = Math.min(0.1, profile.proud);
        const [lo, hi] = kind === "plinth" ? [j.edge - profile.height - 2 * rise - 0.3, j.edge + profile.height] : [j.edge - profile.height, j.edge + profile.height + 2 * rise + 0.3];
        const pts: V3[] = [];
        for (const [c, dt] of [[j.at, 0], [j.st.point(j.tEnd), j.side * past]] as [V3, number][]) {
          for (const k of [-back, out]) {
            const x = c[0] + t[0] * dt + e.n[0] * k, z = c[2] + t[2] * dt + e.n[2] * k;
            pts.push([x, lo, z], [x, hi, z]);
          }
        }
        pieces.push({ kind: "block", points: pts, grain: t, uvOrigin: [j.at[0], kind === "plinth" ? hi : lo, j.at[2]] });
        continue;
      }
      /** The pitch line's height at a point along the wall: through the step's middle, rising a step a step. */
      const line = (p: number) => y + (rise * up * (p - (t0 + t1) / 2)) / (t1 - t0);
      const ends: [V3, V3] = dot(e.a, t) <= dot(e.b, t) ? [e.a, e.b] : [e.b, e.a];
      const extend = profile.proud;
      const back = Math.min(0.1, profile.proud);
      const pts: V3[] = [];
      for (const [p, dir] of [[ends[0], -1], [ends[1], 1]] as [V3, number][]) {
        const q: V3 = [p[0] + t[0] * extend * dir, 0, p[2] + t[2] * extend * dir];
        const h = line(dot(q, t));
        const [lo, hi] = kind === "plinth" ? [h - rise, h + rise / 2 + profile.height] : [h - rise / 2 - profile.height, h + rise];
        for (const k of [-back, profile.proud]) {
          const x = q[0] + e.n[0] * k, z = q[2] + e.n[2] * k;
          pts.push([x, lo, z], [x, hi, z]);
        }
      }
      // Its stone along the slope: across the plan along the wall, climbing a step a step.
      const k = (rise * up) / (t1 - t0);
      const l = Math.hypot(1, k);
      // Its courses laid from where the band meets the top block, measured down along the band:
      // the point its stone starts at, back up the slope from this step's upper end.
      const down: V3 = up > 0 ? [-t[0] / l, -k / l, -t[2] / l] : [t[0] / l, k / l, t[2] / l];
      const upper = point(up > 0 ? t1 : t0);
      const edgeAt = kind === "plinth" ? y + rise + profile.height : y - profile.height;
      const s0 = fromTop(y);
      const uvOrigin: V3 = [upper[0] - down[0] * s0, edgeAt - down[1] * s0, upper[2] - down[2] * s0];
      pieces.push({ kind, points: pts, grain: down, uvOrigin });
    }
  }
  return pieces;
}

/** A flat ceiling over a floor, square to the builder's own axes: x0-x1 by z0-z1, its underside at `y`. */
export interface CeilingSpan {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
  floor: number;
}

export interface RibSpec {
  /** About how far apart the ribs stand along a span; each rib this wide and hanging this deep. */
  spacing: number;
  width: number;
  depth: number;
  /** Where a rib meets a wall, a pilaster carrying it down to the floor - this wide and proud. */
  pilaster?: { width: number; proud: number };
  /** A span narrower than this, either way, gets none. */
  minSpan?: number;
}

/** What a builder knows of the solid round its ceilings. */
export interface RibSurroundings {
  /** Whether a point is in something solid (a wall, a pier). */
  solidAt(p: V3): boolean;
  /** The top of the floor under a point, or null. */
  floorUnder(p: V3): number | null;
}

/**
 * Ribs across flat ceilings (GEOMETRY.md, 6.1: subdividing a surface along its run): across each
 * span's shorter side, spread along its longer, each standing on a pilaster at both ends.
 *
 * - A rib reaches a wall at both ends or is not there: where its ceiling runs on past the span (the
 *   other arm of an L), it carries on across to the wall beyond; where an end meets an opening or
 *   nothing (a crossing, a tee's open side), there is no rib.
 * - It is moved along its span, a little at a time up to half the spacing, to where both its
 *   pilasters stand on wall from the floor to the ceiling across their whole width - framing an
 *   alcove, never standing in an opening.
 * - `anchors` (piers standing in the span) are kept: a rib runs over each, and more between them
 *   where they stand far apart.
 */
export function ribs(spans: readonly CeilingSpan[], around: RibSurroundings, spec: RibSpec, anchors: readonly V3[] = []): TrimPiece[] {
  const pieces: TrimPiece[] = [];
  const minSpan = spec.minSpan ?? 4;
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): V3[] => {
    const plan: [number, number][] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    return [...plan.map(([x, z]): V3 => [x, y0, z]), ...plan.map(([x, z]): V3 => [x, y1, z])];
  };
  const reach = 60, step = 0.5;
  /** Whether a rib already stands within half a spacing of this one, alongside it (two spans
   *  sharing a ceiling - a tee's bar and stem - would each put one there). */
  const near = (rib: TrimPiece): boolean => {
    const bounds = (q: TrimPiece) => {
      const xs = q.points.map((c) => c[0]), zs = q.points.map((c) => c[2]);
      return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
    };
    const r = bounds(rib);
    const alongZ = r.z1 - r.z0 > r.x1 - r.x0;
    return pieces.some((q) => {
      if (q.kind !== "rib") return false;
      const o = bounds(q);
      if (o.z1 - o.z0 > o.x1 - o.x0 !== alongZ) return false;
      const gap = alongZ ? Math.abs((o.x0 + o.x1) / 2 - (r.x0 + r.x1) / 2) : Math.abs((o.z0 + o.z1) / 2 - (r.z0 + r.z1) / 2);
      const overlap = alongZ ? Math.min(o.z1, r.z1) - Math.max(o.z0, r.z0) : Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0);
      return gap < spec.spacing / 2 && overlap > 0;
    });
  };
  for (const s of spans) {
    const dx = s.x1 - s.x0, dz = s.z1 - s.z0;
    if (Math.min(dx, dz) < minSpan) continue;
    // Along the longer side: ribs run across it. (a, b): along the run, across it.
    const alongX = dx > dz;
    const [a0, a1, b0, b1] = alongX ? [s.x0, s.x1, s.z0, s.z1] : [s.z0, s.z1, s.x0, s.x1];
    const point = (a: number, b: number, y: number): V3 => (alongX ? [a, y, b] : [b, y, a]);
    const w = spec.width / 2;
    const pw = (spec.pilaster?.width ?? spec.width) / 2;
    const proud = spec.pilaster?.proud ?? 0;
    const y = s.y;
    /** Where a rib at `a` going `dir` from the span's middle meets a wall, or null: walked out from
     *  the middle, on past the span's side wherever its ceiling runs on. */
    const middle = (b0 + b1) / 2;
    const wallAt = (a: number, dir: number): number | null => {
      for (let d = 0; d <= reach; d += step / 2) {
        if (around.solidAt(point(a, middle + dir * d, y - spec.depth - 0.5))) return middle + dir * d;
      }
      return null;
    };
    /** A pilaster against the wall at b (facing -dir), at a: wall behind it all the way up, or null. */
    const pilaster = (a: number, b: number, dir: number): V3[] | null => {
      const floor = around.floorUnder(point(a, b - dir * 0.2, y - 0.1));
      if (floor === null) return null;
      for (let h = floor + 0.5; h < y - 0.2; h += 1) {
        for (const off of [-pw + 0.05, 0, pw - 0.05]) if (!around.solidAt(point(a + off, b + dir * 0.3, h))) return null;
      }
      const [pb0, pb1] = dir > 0 ? [b - proud, b + 0.1] : [b - 0.1, b + proud];
      return alongX ? box(a - pw, floor, pb0, a + pw, y, pb1) : box(pb0, floor, a - pw, pb1, y, a + pw);
    };
    /** The rib at `a`, with its pilasters, if it reaches walls at both ends. */
    const ribAt = (a: number): TrimPiece[] | null => {
      const end0 = wallAt(a, -1), end1 = wallAt(a, 1);
      if (end0 === null || end1 === null) return null;
      const out: TrimPiece[] = [{ kind: "rib", points: alongX ? box(a - w, y - spec.depth, end0, a + w, y, end1) : box(end0, y - spec.depth, a - w, end1, y, a + w) }];
      if (spec.pilaster) {
        const p0 = pilaster(a, end0, -1), p1 = pilaster(a, end1, 1);
        if (!p0 || !p1) return null;
        out.push({ kind: "pilaster", points: p0 }, { kind: "pilaster", points: p1 });
      }
      return out;
    };
    /** Whether a rib at t would run into a recess (an alcove): an end past the span's side by more
     *  than a little and less than a span. Where the ceiling runs on further (an L's other arm), it
     *  carries on across. */
    const into = (t: number): boolean => {
      const past = [b0 - (wallAt(t, -1) ?? b0), (wallAt(t, 1) ?? b1) - b1];
      return past.some((d) => d > 1 && d < 2 * minSpan);
    };
    // Where along the run: over the piers standing in it, either side of each recess (framing it),
    // and evenly between.
    const piers = anchors.map((p) => (alongX ? p[0] : p[2])).filter((a, i) => {
      const across = alongX ? anchors[i][2] : anchors[i][0];
      return a > a0 + 1 && a < a1 - 1 && across > b0 && across < b1;
    });
    const fixed = [...new Set(piers.map((a) => Math.round(a * 4) / 4))].sort((p, q) => p - q);
    const wanted: { a: number; fixed: boolean }[] = fixed.map((a) => ({ a, fixed: true }));
    const frames: number[] = [];
    let was = false;
    for (let t = a0 + w + 0.25; t < a1 - w; t += 0.25) {
      const now = into(t);
      if (now !== was) frames.push(now ? t - 0.25 : t);
      was = now;
    }
    for (const a of frames) wanted.push({ a, fixed: false });
    const marks = [a0, ...[...fixed, ...frames].sort((p, q) => p - q), a1];
    for (let k = 0; k + 1 < marks.length; k++) {
      const gap = marks[k + 1] - marks[k];
      const count = Math.round(gap / spec.spacing);
      for (let i = 1; i < count; i++) wanted.push({ a: marks[k] + (gap * i) / count, fixed: false });
    }
    for (const { a, fixed: isFixed } of wanted) {
      if (isFixed) {
        // Over a pier: as it is, its pilasters where there is wall.
        const end0 = wallAt(a, -1) ?? b0, end1 = wallAt(a, 1) ?? b1;
        pieces.push({ kind: "rib", points: alongX ? box(a - w, y - spec.depth, end0, a + w, y, end1) : box(end0, y - spec.depth, a - w, end1, y, a + w) });
        if (spec.pilaster) {
          const p0 = pilaster(a, end0, -1), p1 = pilaster(a, end1, 1);
          if (p0) pieces.push({ kind: "pilaster", points: p0 });
          if (p1) pieces.push({ kind: "pilaster", points: p1 });
        }
        continue;
      }
      // The nearest within half a spacing - but not one running into a recess, when one framing it
      // from the walls beside it is there.
      let best: { rib: TrimPiece[]; into: boolean } | null = null;
      for (let k = 0; k * 0.25 <= spec.spacing / 2 && !(best && !best.into); k++) {
        for (const t of k === 0 ? [a] : [a - k * 0.25, a + k * 0.25]) {
          if (t <= a0 + w || t >= a1 - w) continue;
          const rib = ribAt(t);
          if (!rib) continue;
          const recess = into(t);
          if (!best || (best.into && !recess)) best = { rib, into: recess };
          if (!recess) break;
        }
      }
      if (best && !near(best.rib[0])) pieces.push(...best.rib);
    }
  }
  return pieces;
}
