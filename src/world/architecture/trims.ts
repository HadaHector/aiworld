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
  kind: "plinth" | "cornice";
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
  const pieces: TrimPiece[] = [];
  const tolerance = spec.tolerance ?? 0.1;
  const minHeight = spec.minHeight ?? 1.5;
  const minRun = spec.minRun ?? 1.5;
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
        pieces.push({ kind: "plinth", points: bandPrism(foot[0], foot[1], f.n, low, low + Math.min(p.height, (high - low) / 3), p.proud, p.proud) });
      }
    }
    if (spec.cornice) {
      const head = ends(high);
      const mid: V3 | null = head && [(head[0][0] + head[1][0]) / 2, high, (head[0][2] + head[1][2]) / 2];
      const ceiling = mid && around.ceilingOver(front(mid, high - 0.05));
      if (head && ceiling !== null && ceiling !== undefined && Math.abs(ceiling - high) < tolerance) {
        const c = spec.cornice;
        pieces.push({ kind: "cornice", points: bandPrism(head[0], head[1], f.n, high - Math.min(c.height, (high - low) / 3), high, c.proud, c.proud) });
      }
    }
  }
  return pieces;
}
