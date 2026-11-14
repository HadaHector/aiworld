// Trims (GEOMETRY.md, sections 7-9): the bands of stone or wood that run along the borders of a
// built thing's grid - where a wall meets the floor (a plinth), where it meets the ceiling or vault
// (a cornice), round a pier, across a vault (a rib). Pure geometry, no engine and nothing of any one
// kind of building: a builder hands in its wall faces and what is over and under them, and gets
// back solid pieces (convex prisms) to build or draw as it builds its own - a dungeon part adds them
// to its solids, a house could lay them into its model.

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
}

/** A trim piece: which band it is, and its corners - a convex prism, eight points or more. */
export interface TrimPiece {
  kind: "plinth" | "cornice" | "rib" | "pilaster";
  points: V3[];
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
export function wallTrims(faces: readonly WallFace[], around: TrimSurroundings, spec: WallTrims): TrimPiece[] {
  const tolerance = spec.tolerance ?? 0.1;
  const minHeight = spec.minHeight ?? 1.5;
  const minRun = spec.minRun ?? 1.5;
  const stepRun = spec.stepRun ?? 4;
  /** Each band found, with its ends and height, before the short lone ones are dropped. */
  const found: { piece: TrimPiece; ends: [V3, V3]; y: number }[] = [];
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
      return dot(hi, t) - dot(lo, t) >= minRun ? [lo, hi] : null;
    };
    const front = (c: V3, y: number): V3 => [c[0] + f.n[0] * 0.05, y, c[2] + f.n[2] * 0.05];
    if (spec.plinth) {
      const foot = ends(low);
      const mid: V3 | null = foot && [(foot[0][0] + foot[1][0]) / 2, low, (foot[0][2] + foot[1][2]) / 2];
      const floor = mid && around.floorUnder(front(mid, low + 0.05));
      if (foot && floor !== null && floor !== undefined && Math.abs(floor - low) < tolerance) {
        const p = spec.plinth;
        found.push({ piece: { kind: "plinth", points: bandPrism(foot[0], foot[1], f.n, low, low + Math.min(p.height, (high - low) / 3), p.proud, p.proud) }, ends: foot, y: low });
      }
    }
    if (spec.cornice) {
      const head = ends(high);
      const mid: V3 | null = head && [(head[0][0] + head[1][0]) / 2, high, (head[0][2] + head[1][2]) / 2];
      const ceiling = mid && around.ceilingOver(front(mid, high - 0.05));
      if (head && ceiling !== null && ceiling !== undefined && Math.abs(ceiling - high) < tolerance) {
        const c = spec.cornice;
        found.push({ piece: { kind: "cornice", points: bandPrism(head[0], head[1], f.n, high - Math.min(c.height, (high - low) / 3), high, c.proud, c.proud) }, ends: head, y: high });
      }
    }
  }
  // Bands of a kind at one height meeting end to end are one run (a round wall's facets); a run
  // shorter than stepRun - a stair's step, each at its own height - gets none (a stair's own trim is
  // something else).
  const group = found.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  found.forEach((a, i) => {
    for (let j = 0; j < i; j++) {
      const b = found[j];
      if (a.piece.kind !== b.piece.kind || Math.abs(a.y - b.y) > 0.05) continue;
      if (a.ends.some((e) => b.ends.some((g) => Math.hypot(e[0] - g[0], e[2] - g[2]) < 0.3))) group[root(i)] = root(j);
    }
  });
  const run = new Map<number, number>();
  found.forEach((a, i) => run.set(root(i), (run.get(root(i)) ?? 0) + Math.hypot(a.ends[1][0] - a.ends[0][0], a.ends[1][2] - a.ends[0][2])));
  return found.filter((_, i) => run.get(root(i))! >= stepRun).map((a) => a.piece);
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
