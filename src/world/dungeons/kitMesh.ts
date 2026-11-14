// A kit-built dungeon part as it is drawn (DUNGEONS.md, *Building it*): its faces are its colliders'
// own - so what is seen is exactly what is walked on - each face cut where another of the part's
// solids covers it, dropped where it faces into the rock, and painted by what it is to the way
// through: floor, wall, vault, step. Torches stand at its light spots. Pure: no engine, so it can
// run anywhere the layout does.
import { arcosolia, loculi, type DentSurroundings, type Niche } from "../architecture/dents";
import { TOMB_SIZE, ledgerCorners, type LedgerDef, type TombDef } from "./tombs";
import { copings, ribs, wallTrims, type TrimPiece, type CeilingSpan, type StairEdge, type WallFace, type WallTrims } from "../architecture/trims";
import { convexHull, rotate, type ShapeDesc } from "../collision/index";
import { ModelBuilder } from "../buildings/buildingGeometry";
import type { BuildingModel, ModelLight, Paint } from "../buildings/buildingTypes";
import { generateProp } from "../props/propGenerator";
import type { PropDef } from "../props/propTypes";
import { deriveSeed, mulberry32 } from "../rng";
import type { DungeonPaint, DungeonPartDef, DungeonStyleDef } from "./dungeonDefs";
import { worldToFrame, type DungeonFrame, type DungeonLayout, type PlacedPart } from "./layout";

type V = [number, number, number];

/** A solid of a part: its planes (inside where n . p <= d), and - square to the part - its box. */
interface Solid {
  planes: { n: V; d: number }[];
  box: { min: V; max: V } | null;
  /** Its flat sides, each a convex polygon facing out - for a solid that is not a box. */
  sides: { n: V; corners: V[] }[];
  /** The box round it, to pass over it quickly. */
  lo: V;
  hi: V;
}

/** A face to draw, in the part's own frame. */
interface Face {
  n: V;
  corners: V[];
  /** Which solid it is a side of. */
  solid: number;
  /** The inside of a dent cut into it (a niche): drawn as wall, whatever way it faces. */
  dent?: boolean;
}

/** One part drawn: its model and the lights at its fixtures, in the layout's frame (y the world's). */
export interface PartModel {
  model: BuildingModel;
  lights: ModelLight[];
}

const EPS = 1e-4;
/** How far in front of a face its points are tested for open space. */
const FRONT = 0.05;
/** A tread narrower than this, or a riser lower than this, is a step. */
const STEP_WIDTH = 2.5;
const RISER = 0.6;
/** How high over the floor below a torch's flame burns, at the least. */
const FLAME_HEIGHT = 3.8;
/** How far from a light spot a wall may be for a torch to hang on it. */
const MOUNT_REACH = 4;

const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A part's colliders as solids. */
function solidsOf(shapes: readonly ShapeDesc[]): Solid[] {
  const solids: Solid[] = [];
  for (const s of shapes) {
    if (s.kind === "box") {
      const q = s.rotation;
      const corners: V[] = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
        const local = { x: x * s.half.x, y: y * s.half.y, z: z * s.half.z };
        const r = q ? rotate(q, local) : local;
        corners.push([s.center.x + r.x, s.center.y + r.y, s.center.z + r.z]);
      }
      const ax = q ? rotate(q, { x: 1, y: 0, z: 0 }) : { x: 1, y: 0, z: 0 };
      const square = [ax.x, ax.y, ax.z].every((c) => Math.abs(c) < 1e-6 || Math.abs(Math.abs(c) - 1) < 1e-6) && (!q || Math.abs(rotate(q, { x: 0, y: 1, z: 0 }).y - 1) < 1e-6);
      if (square) {
        const min: V = [Infinity, Infinity, Infinity], max: V = [-Infinity, -Infinity, -Infinity];
        for (const c of corners) for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], c[k]);
          max[k] = Math.max(max[k], c[k]);
        }
        const planes = [0, 1, 2].flatMap((k) => {
          const n: V = [0, 0, 0], m: V = [0, 0, 0];
          n[k] = 1;
          m[k] = -1;
          return [{ n, d: max[k] }, { n: m, d: -min[k] }];
        });
        solids.push({ planes, box: { min, max }, sides: boxSides(min, max), lo: min, hi: max });
      } else {
        solids.push(hullSolid(corners));
      }
    } else if (s.kind === "convex") {
      solids.push(hullSolid(s.points.map((p) => [p.x, p.y, p.z] as V)));
    }
  }
  return solids;
}

/** A box's six sides, each facing out. */
function boxSides(min: V, max: V): { n: V; corners: V[] }[] {
  const sides: { n: V; corners: V[] }[] = [];
  for (let k = 0; k < 3; k++) {
    const u = (k + 1) % 3, v = (k + 2) % 3;
    for (const sign of [-1, 1]) {
      const at = (cu: number, cv: number): V => {
        const p: V = [0, 0, 0];
        p[k] = sign > 0 ? max[k] : min[k];
        p[u] = cu;
        p[v] = cv;
        return p;
      };
      const n: V = [0, 0, 0];
      n[k] = sign;
      sides.push({ n, corners: [at(min[u], min[v]), at(max[u], min[v]), at(max[u], max[v]), at(min[u], max[v])] });
    }
  }
  return sides;
}

/** A convex solid from its corners: its planes, and each flat side as a polygon. */
function hullSolid(points: V[]): Solid {
  const hull = convexHull(points.map(([x, y, z]) => ({ x, y, z })));
  const P = hull.points.map((p) => [p.x, p.y, p.z] as V);
  const sides: { n: V; corners: V[] }[] = [];
  const planes = hull.planes.map((pl) => ({ n: [pl.normal.x, pl.normal.y, pl.normal.z] as V, d: pl.d }));
  for (const plane of planes) {
    const on = new Set<number>();
    for (let t = 0; t < hull.triangles.length; t += 3) {
      const ids = [hull.triangles[t], hull.triangles[t + 1], hull.triangles[t + 2]];
      const n = norm(cross(sub(P[ids[1]], P[ids[0]]), sub(P[ids[2]], P[ids[0]])));
      if (dot(n, plane.n) > 1 - 1e-6) ids.forEach((i) => on.add(i));
    }
    if (on.size < 3) continue;
    const corners = [...on].map((i) => P[i]);
    const centre: V = [0, 0, 0];
    for (const c of corners) for (let k = 0; k < 3; k++) centre[k] += c[k] / corners.length;
    const u = norm(sub(corners[0], centre)), w = cross(plane.n, u);
    corners.sort((a, b) => Math.atan2(dot(sub(a, centre), w), dot(sub(a, centre), u)) - Math.atan2(dot(sub(b, centre), w), dot(sub(b, centre), u)));
    sides.push({ n: plane.n, corners });
  }
  const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (const p of P) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], p[k]);
    hi[k] = Math.max(hi[k], p[k]);
  }
  return { planes, box: null, sides, lo, hi };
}

export const inside = (s: Solid, p: V): boolean =>
  p[0] > s.lo[0] && p[0] < s.hi[0] && p[1] > s.lo[1] && p[1] < s.hi[1] && p[2] > s.lo[2] && p[2] < s.hi[2] && s.planes.every((pl) => dot(pl.n, p) < pl.d - EPS);

/** The heights a vertical line through (x, z) is inside a solid between, or null. */
function column(s: Solid, x: number, z: number): [number, number] | null {
  if (x < s.lo[0] || x > s.hi[0] || z < s.lo[2] || z > s.hi[2]) return null;
  let lo = -Infinity, hi = Infinity;
  for (const { n, d } of s.planes) {
    const r = d - n[0] * x - n[2] * z;
    if (Math.abs(n[1]) < 1e-9) {
      if (r < EPS) return null;
    } else if (n[1] > 0) hi = Math.min(hi, r / n[1]);
    else lo = Math.max(lo, r / n[1]);
  }
  return lo < hi - EPS ? [lo, hi] : null;
}

/** Open space in the part: in none of its solids, with one of them over it and one under it. */
function open(solids: readonly Solid[], p: V): boolean {
  if (solids.some((s) => inside(s, p))) return false;
  let over = Infinity, under = -Infinity;
  for (const s of solids) {
    const c = column(s, p[0], p[2]);
    if (!c) continue;
    if (c[0] >= p[1] - EPS) over = Math.min(over, c[0]);
    if (c[1] <= p[1] + EPS) under = Math.max(under, c[1]);
  }
  // A slit between two solids - the rock between a spiral's laps - is not open: nothing goes there.
  return over < Infinity && under > -Infinity && over - under >= MIN_OPEN;
}

/** The least height of open space: anything lower is a gap in the rock, never seen. */
const MIN_OPEN = 1;

/** The underside of the lowest solid over a point, or null. */
function ceilingOver(solids: readonly Solid[], p: V): number | null {
  let best: number | null = null;
  for (const s of solids) {
    const c = column(s, p[0], p[2]);
    if (c && c[0] >= p[1] - EPS && (best === null || c[0] < best)) best = c[0];
  }
  return best;
}

/** The top of the highest solid under a point, or null. */
function floorUnder(solids: readonly Solid[], p: V): number | null {
  let best: number | null = null;
  for (const s of solids) {
    const c = column(s, p[0], p[2]);
    if (c && c[1] <= p[1] + EPS && (best === null || c[1] > best)) best = c[1];
  }
  return best;
}

/** The first solid a ray from `p` along unit `d` enters: how far, and the face's outward normal. */
function rayHit(solids: readonly Solid[], p: V, d: V, reach: number): { t: number; n: V } | null {
  let best: { t: number; n: V } | null = null;
  for (const s of solids) {
    let enter = 0, exit = reach, normal: V | null = null;
    let missed = false;
    for (const { n, d: dist } of s.planes) {
      const along = dot(n, d), gap = dist - dot(n, p);
      if (Math.abs(along) < 1e-9) {
        if (gap < 0) { missed = true; break; }
        continue;
      }
      const t = gap / along;
      if (along < 0) {
        if (t > enter) { enter = t; normal = n; }
      } else exit = Math.min(exit, t);
    }
    if (missed || !normal || enter > exit) continue;
    if (!best || enter < best.t) best = { t: enter, n: normal };
  }
  return best;
}

type P2 = [number, number];

const area2 = (poly: readonly P2[]): number => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

/** The part of a convex polygon on the left of the line from `a` to `b` (or the right, `keepLeft` false). */
function clipLine(poly: readonly P2[], a: P2, b: P2, keepLeft: boolean): P2[] {
  const side = (p: P2): number => {
    const v = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    return keepLeft ? v : -v;
  };
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Convex `a` with convex `b` taken out of it, as convex pieces (both counter-clockwise). */
function difference(a: P2[], b: P2[]): P2[][] {
  // Not overlapping (or by a sliver): a stays whole, not cut along b's edges for nothing.
  let common: P2[] = a;
  for (let i = 0; i < b.length && common.length >= 3; i++) common = clipLine(common, b[i], b[(i + 1) % b.length], true);
  if (common.length < 3 || area2(common) < 1e-4) return [a];
  const pieces: P2[][] = [];
  let rest: P2[] = a;
  for (let i = 0; i < b.length && rest.length >= 3; i++) {
    const outside = clipLine(rest, b[i], b[(i + 1) % b.length], false);
    if (outside.length >= 3 && area2(outside) > 1e-4) pieces.push(outside);
    rest = clipLine(rest, b[i], b[(i + 1) % b.length], true);
  }
  return pieces;
}

/** Points' convex hull in 2D, counter-clockwise. */
function hull2(points: P2[]): P2[] {
  const p = [...points].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  if (p.length < 3) return p;
  const cross2 = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [], upper: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Where a solid meets the plane n . p = d: the points where its edges cross it. */
function section(s: Solid, n: V, d: number): V[] {
  const out: V[] = [];
  for (const side of s.sides) {
    const c = side.corners;
    for (let i = 0; i < c.length; i++) {
      const p = c[i], q = c[(i + 1) % c.length];
      const sp = dot(n, p) - d, sq = dot(n, q) - d;
      if ((sp < 0) !== (sq < 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
      }
    }
  }
  return out;
}

/** How far in front of a face another solid must reach to cover it. */
const COVER = 0.01;

/**
 * Every face of `solids` (by index, `own`: those of the part itself) that can be seen: each side cut
 * wherever a solid of `solids` lies just in front of it - a step's end where the next step is, a
 * wall behind a stair - as convex pieces, and only the pieces with open space in front kept. With
 * `all`, kept seen or not (a cap, seen only from the part it closes).
 */
function partFaces(solids: readonly Solid[], all = false, own: readonly number[] = solids.map((_, i) => i), whole: ReadonlySet<number> = new Set()): Face[] {
  const faces: Face[] = [];
  const kept: Face[] = [];
  for (const i of own) {
    // Drawn whole: every side as it is, seen or not (a spiral's pillar, a column the height of it).
    if (whole.has(i)) {
      for (const side of solids[i].sides) if (Math.abs(side.n[1]) < 0.5) kept.push({ n: side.n, corners: side.corners, solid: i });
      continue;
    }
    for (const side of solids[i].sides) {
      // Cut where another solid covers it - and where an earlier solid's face lies on it, so two
      // faces in one place (a landing's floor and the piece running on from it) never flicker.
      const face: Face = { n: side.n, corners: side.corners, solid: i };
      const earlier = cutFace(face, solids.filter((_, j) => j < i), [COVER, -COVER]);
      faces.push(...earlier.flatMap((f) => cutFace(f, solids.filter((_, j) => j > i), [COVER])));
    }
  }
  return [...kept, ...(all ? faces : faces.filter((f) => seen(solids, f)))];
}

/**
 * A face less wherever one of `cutters` lies across its plane `offsets` off it - in front of it
 * (COVER: it is covered), or just behind it (-COVER: a face of the cutter's lies on it, and the
 * cutter's is the one drawn) - as convex pieces.
 */
function cutFace(face: Face, cutters: readonly Solid[], offsets: readonly number[]): Face[] {
  const { n } = face;
  const c0 = face.corners[0];
  const d = dot(n, c0);
  const U = norm(sub(face.corners[1], c0)), W = cross(n, U);
  const to2 = (p: V): P2 => [dot(sub(p, c0), U), dot(sub(p, c0), W)];
  const to3 = (q: P2): V => [c0[0] + U[0] * q[0] + W[0] * q[1], c0[1] + U[1] * q[0] + W[1] * q[1], c0[2] + U[2] * q[0] + W[2] * q[1]];
  let first = face.corners.map(to2);
  if (area2(first) < 0) first = first.reverse();
  let pieces = [first];
  const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (const p of face.corners) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], p[k]);
    hi[k] = Math.max(hi[k], p[k]);
  }
  for (const b of cutters) {
    if (pieces.length === 0) break;
    if (b.hi[0] < lo[0] - COVER || b.lo[0] > hi[0] + COVER || b.hi[1] < lo[1] - COVER || b.lo[1] > hi[1] + COVER || b.hi[2] < lo[2] - COVER || b.lo[2] > hi[2] + COVER) continue;
    for (const offset of offsets) {
      const cut = section(b, n, d + offset);
      if (cut.length < 3) continue;
      const shape = hull2(cut.map(to2));
      if (shape.length < 3 || area2(shape) < 1e-4) continue;
      pieces = pieces.flatMap((piece) => difference(piece, shape));
    }
  }
  if (pieces.length === 1 && pieces[0] === first) return [face];
  return pieces.map((piece) => ({ ...face, n, corners: piece.map(to3) }));
}

/** A solid moved: its points by `point`, its directions by `turn` (a rotation). */
function moveSolid(s: Solid, point: (p: V) => V, turn: (d: V) => V): Solid {
  const sides = s.sides.map((side) => ({ n: turn(side.n), corners: side.corners.map(point) }));
  const planes = s.planes.map(({ n, d }) => {
    const m = turn(n);
    return { n: m, d: dot(m, point([n[0] * d, n[1] * d, n[2] * d])) };
  });
  const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (const side of sides) for (const p of side.corners) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], p[k]);
    hi[k] = Math.max(hi[k], p[k]);
  }
  return { planes, box: null, sides, lo, hi };
}

/** How far apart, at most, the points tested in front of a face are. */
const SEEN_STEP = 0.75;

/**
 * Whether open space lies in front of any point of a face, tested about every SEEN_STEP over it -
 * a pillar the height of a spiral passes through floors and vaults, and only between them is seen.
 */
function seen(solids: readonly Solid[], f: Face): boolean {
  const c = f.corners;
  const test = (p: V): boolean => open(solids, [p[0] + f.n[0] * FRONT, p[1] + f.n[1] * FRONT, p[2] + f.n[2] * FRONT]);
  for (let i = 1; i < c.length - 1; i++) {
    const a = c[0], b = c[i], d = c[i + 1];
    const longest = Math.max(Math.hypot(...sub(b, a)), Math.hypot(...sub(d, b)), Math.hypot(...sub(a, d)));
    const n = Math.min(60, Math.max(2, Math.ceil(longest / SEEN_STEP)));
    // A grid of points over the fan's triangle, drawn a little in from its edges.
    for (let u = 0; u <= n; u++) {
      for (let v = 0; u + v <= n; v++) {
        const wu = (u + 0.1) / (n + 0.3), wv = (v + 0.1) / (n + 0.3), wa = 1 - wu - wv;
        if (test([a[0] * wa + b[0] * wu + d[0] * wv, a[1] * wa + b[1] * wu + d[1] * wv, a[2] * wa + b[2] * wu + d[2] * wv])) return true;
      }
    }
  }
  return false;
}

/** A convex polygon's least width: the narrowest it is across, between two parallel lines. */
function leastWidth(f: Face): number {
  let least = Infinity;
  const c = f.corners;
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    const edge = norm(sub(b, a));
    const across = cross(f.n, edge);
    let far = 0;
    for (const p of c) far = Math.max(far, Math.abs(dot(sub(p, a), across)));
    least = Math.min(least, far);
  }
  return least;
}

/** What each solid is to the way through, from its faces that are seen. */
interface SolidKind {
  /** A step: a narrow tread on top. */
  tread: boolean;
  /** A floor or landing on top. */
  floor: boolean;
  /** A vault: seen from under it. */
  roof: boolean;
  /** A step's tread's height. */
  top: number;
  /** Wall all over, whatever its shape (a railing). */
  plain?: boolean;
  /** A trim (a plinth, a cornice): drawn in the style's trim. */
  trim?: boolean;
  /** Part of a niche (its frame, its slab): drawn in the style's niche paint. */
  niche?: boolean;
  /** Part of a tomb: drawn in the style's tomb paint. */
  tomb?: boolean;
  /** Ironwork (a gate's bars), and the dark past a gate: drawn in the style's iron and dark. */
  iron?: boolean;
  dark?: boolean;
  /** A trim's stone direction, where it slopes (a stair's band), and where its courses start. */
  grain?: V;
  uvOrigin?: V;
}

function solidKinds(count: number, faces: readonly Face[]): SolidKind[] {
  const kinds = Array.from({ length: count }, (): SolidKind => ({ tread: false, floor: false, roof: false, top: -Infinity }));
  for (const f of faces) {
    const k = kinds[f.solid];
    if (f.n[1] > 0.5) {
      k.floor = true;
      if (leastWidth(f) < STEP_WIDTH) {
        k.tread = true;
        k.top = Math.max(k.top, ...f.corners.map((c) => c[1]));
      }
    } else if (f.n[1] < -0.5) k.roof = true;
  }
  return kinds;
}

/**
 * What a face is made of, by what its solid is: a step's every face dressed stone; a floor's top
 * flagstones and its low edge a step; a vault's underside and its low edges the vault; anything
 * else wall - so a wall cut into pieces round a flight of stairs stays wall.
 */
function paintFor(f: Face, kind: SolidKind, look: DungeonStyleDef["look"]): DungeonPaint {
  if (kind.iron) return look.iron;
  if (kind.dark) return look.dark;
  if (kind.niche) return look.niche;
  if (kind.tomb) return look.tomb;
  if (kind.trim) return look.trim;
  if (kind.plain) return look.wall;
  if (f.n[1] > 0.5) return kind.tread ? look.steps : look.floor;
  if (f.n[1] < -0.5) return look.ceiling;
  if (kind.tread) return look.steps;
  let low = Infinity, high = -Infinity;
  for (const c of f.corners) {
    low = Math.min(low, c[1]);
    high = Math.max(high, c[1]);
  }
  if (high - low <= RISER && kind.floor) return look.steps;
  if (high - low <= RISER && kind.roof) return look.ceiling;
  return look.wall;
}

/** Each part's solids and seen faces, in its own frame - worked out once however often it is placed. */
const shapesOfPart = new WeakMap<DungeonPartDef, { solids: Solid[]; faces: Face[]; kinds: SolidKind[] }>();
/** Each part's look with a style's trims, by the style. */
const trimmedParts = new WeakMap<DungeonPartDef, Map<WallTrims, { solids: Solid[]; faces: Face[]; kinds: SolidKind[] }>>();

/**
 * A part as a style draws it: its solids and faces, and its trims (src/world/architecture/trims.ts)
 * - plinths at the feet of its walls, cornices at their heads - as solids of their own, cut against
 * the rest as any solid is: a wall gives way to the plinth in front of it, two bands meeting at a
 * corner never flicker. Not for doorways or caps: a doorway is a trim itself.
 */
export function trimmedShape(part: DungeonPartDef, trims: WallTrims): { solids: Solid[]; faces: Face[]; kinds: SolidKind[] } {
  const plain = partShape(part);
  if (part.ending) return endingShape(part, trims, plain);
  if (part.doorway || part.paths.length === 0 || (!trims.plinth && !trims.cornice && !trims.ribs && !trims.coping && !trims.loculi && !part.tombs?.length && !part.ledgers?.length)) return plain;
  let byStyle = trimmedParts.get(part);
  if (!byStyle) trimmedParts.set(part, (byStyle = new Map()));
  const known = byStyle.get(trims);
  if (known) return known;
  const { solids, kinds } = plain;
  const whole = new Set(part.whole);
  // The walls: upright faces of solids that are wall (not a step, a railing, a pillar drawn whole).
  const walls: WallFace[] = plain.faces.filter((f) => Math.abs(f.n[1]) < 0.1 && !kinds[f.solid].tread && !kinds[f.solid].plain && !whole.has(f.solid));
  // What stands and hangs round the walls, less what is wall all over (a railing, a tunnel's
  // walls): a band never sits on one of those.
  const built = solids.filter((_, i) => !kinds[i].plain && !whole.has(i));
  const stairs = stairEdges(plain.faces, solids, kinds, built);
  const pieces = wallTrims(walls, { floorUnder: (p) => floorUnder(built, p), ceilingOver: (p) => ceilingOver(built, p), stair: stairs.on }, trims, stairs);
  if (trims.ribs) {
    // The flat ceilings: each box seen from under it, as far as it is seen.
    const spans: CeilingSpan[] = [];
    solids.forEach((s, i) => {
      if (!s.box) return;
      const under = plain.faces.filter((f) => f.solid === i && f.n[1] < -0.9);
      if (under.length === 0) return;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const f of under) for (const c of f.corners) {
        x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]);
        z0 = Math.min(z0, c[2]); z1 = Math.max(z1, c[2]);
      }
      const y = s.box.min[1];
      const floor = floorUnder(solids, [(x0 + x1) / 2, y - 0.1, (z0 + z1) / 2]);
      if (floor === null || y - floor < 4) return;
      spans.push({ x0, z0, x1, z1, y, floor });
    });
    // Piers standing free in a span (a box from floor to vault, off the walls): ribs run over them.
    const pierSolids = solids.filter((s) => s.box && spans.some((sp) => s.box!.min[1] <= sp.floor && s.box!.max[1] >= sp.y && s.box!.min[0] > sp.x0 + 0.5 && s.box!.max[0] < sp.x1 - 0.5 && s.box!.min[2] > sp.z0 + 0.5 && s.box!.max[2] < sp.z1 - 0.5));
    const piers = pierSolids.map((s): [number, number, number] => [(s.box!.min[0] + s.box!.max[0]) / 2, 0, (s.box!.min[2] + s.box!.max[2]) / 2]);
    // Walls are what a rib ends on: the piers it passes over are not.
    const walls = solids.filter((s) => !pierSolids.includes(s));
    pieces.push(...ribs(spans, { solidAt: (p) => walls.some((s) => inside(s, p)), floorUnder: (p) => floorUnder(built, p) }, trims.ribs, piers));
  }
  if (trims.coping) {
    // The railings' tops: the solids that are wall all over and low (not a tunnel's walls, whose
    // tops show over its mouth), each at its top as far as it is seen.
    const tops: [number, number, number][][] = [];
    for (const i of part.plain) {
      // Its top: the faces it shows upward lying in the plane of its highest (it may slope).
      const up = plain.faces.filter((f) => f.solid === i && f.n[1] > 0.7);
      if (up.length === 0) continue;
      const highest = up.reduce((p, q) => (Math.max(...q.corners.map((c) => c[1])) > Math.max(...p.corners.map((c) => c[1])) ? q : p));
      const d = dot(highest.n, highest.corners[0]);
      const level = up.filter((f) => dot(f.n, highest.n) > 0.999 && f.corners.every((c) => Math.abs(dot(highest.n, c) - d) < 1e-3));
      // Low, foot to top, under its top's middle (a sloping railing reaches far down overall).
      const mid = highest.corners.reduce((m, c) => [m[0] + c[0] / highest.corners.length, 0, m[2] + c[2] / highest.corners.length], [0, 0, 0]);
      const col = column(solids[i], mid[0], mid[2]);
      if (!col || col[1] - col[0] > RAILING_MAX) continue;
      tops.push(level.flatMap((f) => f.corners.map((c): [number, number, number] => [c[0], c[1], c[2]])));
    }
    pieces.push(...copings(tops, trims.coping));
  }
  // Loculi (src/world/architecture/dents.ts): laid out now, their frames trims like the rest; cut
  // out of the walls' faces once those are known, their insides drawn in the style's niche paint,
  // the sealed ones' slabs drawn in their openings (drawn only: the walls collide whole).
  let niches: Niche[] = [];
  if (trims.loculi || trims.arcosolia) {
    const lights = part.spots.light ?? [];
    const near = (lo: V, hi: V, p: V, across: number, up: number): boolean =>
      p[0] > lo[0] - across && p[0] < hi[0] + across && p[2] > lo[2] - across && p[2] < hi[2] + across && p[1] > lo[1] - up && p[1] < hi[1] + up;
    const trimBoxes = pieces.map((t) => hullSolid(t.points));
    const around: DentSurroundings = {
      floorUnder: (p) => floorUnder(built, p),
      solidAt: (p) => built.some((s) => inside(s, p)),
      blocked: (lo, hi) =>
        // A trim beside it (a frame may stand on a plinth, not cut into one).
        trimBoxes.some((b) => b.hi[0] > lo[0] - 0.3 && b.lo[0] < hi[0] + 0.3 && b.hi[1] > lo[1] + 1e-3 && b.lo[1] < hi[1] - 1e-3 && b.hi[2] > lo[2] - 0.3 && b.lo[2] < hi[2] + 0.3) ||
        // A torch's spot (it is hung on the wall nearest it), a doorway's frame round a socket.
        lights.some((l) => near(lo, hi, [l.x, l.y, l.z], 1.2, 1.5)) ||
        part.sockets.some((s) => {
          // In the socket's own frame: the doorway reaches about its depth either side of the
          // socket's plane, and a jamb's width past its opening across.
          const a = (s.facing * Math.PI) / 180, fx = Math.sin(a), fz = Math.cos(a);
          if (hi[1] < s.at.y - 0.5 || lo[1] > s.at.y + s.size[1] + DOORWAY_REACH) return false;
          const corners: V[] = [[lo[0], 0, lo[2]], [hi[0], 0, lo[2]], [hi[0], 0, hi[2]], [lo[0], 0, hi[2]]];
          const fwd = corners.map((c) => (c[0] - s.at.x) * fx + (c[2] - s.at.z) * fz);
          const across = corners.map((c) => (c[0] - s.at.x) * fz - (c[2] - s.at.z) * fx);
          const half = s.size[0] / 2 + DOORWAY_REACH;
          return Math.min(...fwd) < DOORWAY_REACH && Math.max(...fwd) > -DOORWAY_REACH && Math.min(...across) < half && Math.max(...across) > -half;
        }),
      random: (p) => {
        const h = Math.sin(p[0] * 12.9898 + p[1] * 78.233 + p[2] * 37.719) * 43758.5453;
        return h - Math.floor(h);
      },
    };
    // The arcosolia first, as centrepieces; the loculi round them, kept clear of them.
    // A room gets its share; a way (a corridor) one at most, on a short wall - an alcove's back.
    const great = !trims.arcosolia
      ? []
      : part.room
        ? arcosolia(walls, around, trims.arcosolia)
        : arcosolia(walls.filter((f) => wallRun(f) <= ALCOVE_WALL), around, { ...trims.arcosolia, count: Math.min(1, trims.arcosolia.count) });
    const greatBoxes = great.map((n) => hullSolid([...n.points, ...n.frame.flatMap((b) => b.points)]));
    const small = trims.loculi
      ? loculi(walls, { ...around, blocked: (lo, hi) => around.blocked(lo, hi) || greatBoxes.some((b) => b.hi[0] > lo[0] - 0.3 && b.lo[0] < hi[0] + 0.3 && b.hi[1] > lo[1] - 0.3 && b.lo[1] < hi[1] + 0.3 && b.hi[2] > lo[2] - 0.3 && b.lo[2] < hi[2] + 0.3) }, trims.loculi)
      : [];
    niches = [...great, ...small];
  }
  const all = [...solids, ...pieces.map((t) => hullSolid(t.points))];
  let faces = partFaces(all, false, all.map((_, i) => i), whole);
  const kindsAll = solidKinds(all.length, faces);
  if (niches.length > 0) faces = drawNiches(niches, faces, all, kindsAll);
  // Its tombs, drawn as they are, every side but their undersides: they stand on the floor, and a
  // lid's overhang over its chest is no gap in the rock.
  for (const piece of [...(part.tombs ?? []).flatMap(tombPieces), ...(part.ledgers ?? []).map(ledgerPiece)]) {
    const solid = hullSolid(piece.points);
    for (const side of solid.sides) if (side.n[1] > -0.9) faces.push({ n: side.n, corners: side.corners, solid: all.length });
    all.push(solid);
    kindsAll.push({ tread: false, floor: false, roof: false, top: -Infinity, trim: true, tomb: true });
  }
  for (const i of part.plain) kindsAll[i] = { ...kindsAll[i], tread: false, plain: true };
  for (let i = solids.length; i < solids.length + pieces.length; i++) kindsAll[i] = { tread: false, floor: false, roof: false, top: -Infinity, trim: true, grain: pieces[i - solids.length].grain, uvOrigin: pieces[i - solids.length].uvOrigin };
  const shape = { solids: all, faces, kinds: kindsAll };
  byStyle.set(trims, shape);
  return shape;
}

/**
 * Niches (src/world/architecture/dents.ts) into a part's faces: cut out of the faces they open in,
 * their insides drawn as the sides of the wall they are cut into (in the style's niche paint), each
 * frame's bars, what lies in them and the sealed ones' slabs drawn as they are - added to `all` and
 * `kindsAll`. The faces as cut, with all that.
 */
function drawNiches(niches: readonly Niche[], cut: Face[], all: Solid[], kindsAll: SolidKind[]): Face[] {
  const voids = niches.map((n) => hullSolid(n.points));
  const faces = cut.flatMap((f) => cutFace(f, voids, [-COVER]));
  for (const v of voids) {
    for (const side of v.sides) {
      // Each side but the opening, facing into the niche, as a side of the wall it is cut into.
      const c = side.corners.reduce((m, p): V => [m[0] + p[0] / side.corners.length, m[1] + p[1] / side.corners.length, m[2] + p[2] / side.corners.length], [0, 0, 0]);
      const owner = all.findIndex((s) => inside(s, [c[0] + side.n[0] * 0.1, c[1] + side.n[1] * 0.1, c[2] + side.n[2] * 0.1]));
      if (owner < 0) continue;
      faces.push({ n: [-side.n[0], -side.n[1], -side.n[2]], corners: side.corners, solid: owner, dent: true });
    }
  }
  // Each frame's bars drawn as they are, uncut (they only stand in front of the wall): the face,
  // the bevel down into the opening and the outer side - not the back in the wall, nor the mitres
  // where the bars meet.
  for (const niche of niches) {
    for (const bar of niche.frame) {
      const solid = hullSolid(bar.points);
      for (const side of solid.sides) {
        if (Math.abs(dot(side.n, bar.grain)) > 0.3 || dot(side.n, niche.n) < -0.9) continue;
        faces.push({ n: side.n, corners: side.corners, solid: all.length });
      }
      all.push(solid);
      kindsAll.push({ tread: false, floor: false, roof: false, top: -Infinity, trim: true, niche: true, grain: bar.grain });
    }
  }
  // What stands in a niche (a tomb chest): drawn whole but for its back, in the trims' stone.
  for (const niche of niches) {
    for (const piece of niche.contents ?? []) {
      const solid = hullSolid(piece);
      for (const side of solid.sides) if (dot(side.n, niche.n) > -0.9 && side.n[1] > -0.9) faces.push({ n: side.n, corners: side.corners, solid: all.length });
      all.push(solid);
      kindsAll.push({ tread: false, floor: false, roof: false, top: -Infinity, trim: true, tomb: true });
    }
  }
  for (const niche of niches) {
    if (!niche.slab) continue;
    const slab = hullSolid(niche.slab);
    const front = slab.sides.find((s) => dot(s.n, niche.n) > 0.99);
    if (!front) continue;
    faces.push({ n: front.n, corners: front.corners, solid: all.length });
    all.push(slab);
    kindsAll.push({ tread: false, floor: false, roof: false, top: -Infinity, trim: true, niche: true });
  }
  return faces;
}

/**
 * A tomb drawn: a base a little wider than it, the chest, a lid standing out over the chest's
 * sides, and a low gabled top along its length - each a convex piece, in the trims' stone.
 */
function tombPieces(t: TombDef): TrimPiece[] {
  const [len, wid, high] = TOMB_SIZE;
  const along = t.yaw === 90;
  /** A box from the tomb's middle: l along its length, w across, between two heights. */
  const box = (l: number, w: number, y0: number, y1: number): V[] => {
    const hx = (along ? l : w) / 2, hz = (along ? w : l) / 2;
    const plan: [number, number][] = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
    return [y0, y1].flatMap((y) => plan.map(([x, z]): V => [t.at.x + x, t.at.y + y, t.at.z + z]));
  };
  const lidAt = high - 0.42, gableAt = high - 0.22;
  // The gable: the lid's top rising to a ridge along the length.
  const ridge: V[] = [-1, 1].map((s): V => (along ? [t.at.x + s * (len / 2 + 0.05), t.at.y + high, t.at.z] : [t.at.x, t.at.y + high, t.at.z + s * (len / 2 + 0.05)]));
  return [
    { kind: "tomb", points: box(len + 0.2, wid + 0.2, -0.02, 0.25) },
    { kind: "tomb", points: box(len, wid, 0.25, lidAt) },
    { kind: "tomb", points: box(len + 0.1, wid + 0.16, lidAt, gableAt) },
    { kind: "tomb", points: [...box(len + 0.1, wid + 0.16, gableAt, gableAt + 0.01).slice(0, 4), ...ridge] },
  ];
}

/** A gate's bars: this thick, this far apart, and its rails this high over the sill, standing this far in from the cap's face. */
const GATE_BAR = 0.1;
const GATE_SPACING = 0.5;
const GATE_RAILS = [0.4, 2.6, 4.8];
const GATE_IN = 0.15;

/**
 * A cap that ends a way in something other than a plain wall (its `ending`), in its own frame:
 * - a wall tomb: the style's arcosolium (its frame, its chest) cut into the cap's face, centred in the
 *   opening it closes;
 * - a gate: iron bars standing across the opening, and past them the cap's wall drawn back to the
 *   socket's plane, its face, sides, floor and top in the dark - a way on into the dark, closed.
 * Its collider is its box all the same: nothing passes.
 */
function endingShape(part: DungeonPartDef, trims: WallTrims, plain: { solids: Solid[]; faces: Face[]; kinds: SolidKind[] }): { solids: Solid[]; faces: Face[]; kinds: SolidKind[] } {
  let byStyle = trimmedParts.get(part);
  if (!byStyle) trimmedParts.set(part, (byStyle = new Map()));
  const known = byStyle.get(trims);
  if (known) return known;
  const socket = part.sockets[0];
  const a = (socket.facing * Math.PI) / 180;
  const out: V = [Math.sin(a), 0, Math.cos(a)];
  const t: V = [-out[2], 0, out[0]];
  const [w, h] = socket.size;
  const y0 = socket.at.y;
  /** A point across the opening (u from its middle), up from its floor, `o` out from the socket's plane. */
  const at = (u: number, y: number, o: number): V => [socket.at.x + t[0] * u + out[0] * o, y0 + y, socket.at.z + t[2] * u + out[2] * o];
  // The cap's face: how far out of the socket's plane it stands.
  const face = plain.faces.find((f) => dot(f.n, out) > 0.99);
  const depth = face ? dot(sub(face.corners[0], [socket.at.x, socket.at.y, socket.at.z]), out) : 1;
  const all = [...plain.solids];
  const kinds = [...plain.kinds];
  let faces = [...plain.faces];
  if (part.ending === "tomb" && trims.arcosolia) {
    // The opening it closes as a wall of its own, the arcosolium centred in it.
    const wall: WallFace = { n: out, corners: [at(-w / 2, 0, depth), at(w / 2, 0, depth), at(w / 2, h, depth), at(-w / 2, h, depth)] };
    const niches = arcosolia([wall], {
      floorUnder: () => y0,
      solidAt: (p) => plain.solids.some((s) => inside(s, p)),
      blocked: () => false,
      random: () => 0,
    }, { ...trims.arcosolia, count: 1, margin: Math.min(trims.arcosolia.margin, 0.1) });
    faces = drawNiches(niches, faces, all, kinds);
  } else if (part.ending === "gate") {
    // The dark: the face drawn back to the socket's plane - the inside of the cap's box, a hair in
    // from the opening's sides, floor and top, all but its open front.
    const e = 0.01;
    faces = faces.filter((f) => dot(f.n, out) <= 0.99);
    const recess = hullSolid([0, depth].flatMap((d) => [at(-w / 2 + e, e, d), at(w / 2 - e, e, d), at(w / 2 - e, h - e, d), at(-w / 2 + e, h - e, d)]));
    for (const side of recess.sides) if (dot(side.n, out) < 0.99) faces.push({ n: [-side.n[0], -side.n[1], -side.n[2]], corners: side.corners, solid: all.length });
    all.push(recess);
    kinds.push({ tread: false, floor: false, roof: false, top: -Infinity, dark: true });
    // The bars: uprights across the opening, rails across them; each drawn but for its ends.
    const o = depth - GATE_IN, r = GATE_BAR / 2;
    const bar = (u0: number, u1: number, v0: number, v1: number) => {
      const solid = hullSolid([o - r, o + r].flatMap((d) => [at(u0, v0, d), at(u1, v0, d), at(u1, v1, d), at(u0, v1, d)]));
      const long: V = v1 - v0 > u1 - u0 ? [0, 1, 0] : t;
      for (const side of solid.sides) if (Math.abs(dot(side.n, long)) < 0.5) faces.push({ n: side.n, corners: side.corners, solid: all.length });
      all.push(solid);
      kinds.push({ tread: false, floor: false, roof: false, top: -Infinity, iron: true });
    };
    const count = Math.floor(w / GATE_SPACING);
    for (let i = 1; i < count; i++) {
      const u = -w / 2 + (i * w) / count;
      bar(u - r, u + r, 0, h);
    }
    for (const y of GATE_RAILS) if (y + GATE_BAR < h) bar(-w / 2, w / 2, y, y + GATE_BAR);
  }
  const shape = { solids: all, faces, kinds };
  byStyle.set(trims, shape);
  return shape;
}

/** A ledger stone drawn: a slab a step high, its top edge chamfered all round. */
function ledgerPiece(t: LedgerDef): TrimPiece {
  const high = t.high;
  const ring = (y: number, inset: number): V[] => ledgerCorners(t, inset).map(([x, z]): V => [x, t.at.y + y, z]);
  return { kind: "tomb", points: [...ring(-0.02, 0), ...ring(high - LEDGER_BEVEL, 0), ...ring(high, LEDGER_BEVEL)] };
}

/** The chamfer round a ledger stone's top. */
const LEDGER_BEVEL = 0.08;

/** A way's wall no longer than this may hold an arcosolium (an alcove's back, not a corridor's side). */
const ALCOVE_WALL = 8;

/** A wall face's run along the plan. */
function wallRun(f: { n: V; corners: V[] }): number {
  const t: V = [-f.n[2], 0, f.n[0]];
  const us = f.corners.map((c) => c[0] * t[0] + c[2] * t[2]);
  return Math.max(...us) - Math.min(...us);
}

/** How far round a socket a doorway's frame may reach (its depth, its jambs): no niche there. */
const DOORWAY_REACH = 1.5;

/** A railing is no taller than this, all told, foot to top: wall all over that is taller is a wall. */
const RAILING_MAX = 2.5;

/** A step's tread is smaller than this, square metres: a floor seen in narrow pieces is not one. */
const STEP_AREA = 15;

/**
 * Where a part's stairs meet its walls, for their trims: each tread's edge with a wall just past it
 * (a hand over the tread), and each edge of the vault over a step with a wall just past it (a hand
 * under the vault) - the wall facing back over the step.
 */
export function stairEdges(faces: readonly Face[], solids: readonly Solid[], kinds: readonly SolidKind[], built: readonly Solid[]): { treads: StairEdge[]; vaults: StairEdge[]; on: (p: V, kind: "plinth" | "cornice") => boolean } {
  const treads: StairEdge[] = [], vaults: StairEdge[] = [];
  // The steps: solids with a narrow tread, small all told - not a floor whose top is seen only in
  // narrow pieces; and the vaults over them as small (the vault over each step, not a hall's).
  const topArea = new Map<number, number>(), underArea = new Map<number, number>();
  for (const f of faces) {
    if (Math.abs(f.n[1]) < 0.9) continue;
    let area = 0;
    for (let i = 1; i + 1 < f.corners.length; i++) {
      const [o, p, q] = [f.corners[0], f.corners[i], f.corners[i + 1]];
      area += Math.abs((p[0] - o[0]) * (q[2] - o[2]) - (q[0] - o[0]) * (p[2] - o[2])) / 2;
    }
    const sum = f.n[1] > 0 ? topArea : underArea;
    sum.set(f.solid, (sum.get(f.solid) ?? 0) + area);
  }
  const steps = solids.filter((_, i) => kinds[i].tread && (topArea.get(i) ?? 0) < STEP_AREA);
  const stepVaults = new Set<Solid>();
  /** Whether the floor under p is a step's, or the vault over it one over a step. */
  const on = (p: V, kind: "plinth" | "cornice"): boolean => {
    if (kind === "plinth") {
      const step = floorUnder(steps, p);
      return step !== null && step === floorUnder(built, p);
    }
    const vault = ceilingOver([...stepVaults], p);
    return vault !== null && vault === ceilingOver(built, p);
  };
  if (steps.length === 0) return { treads, vaults, on };
  // A wall: anything built but the step itself - a step a turn higher (a landing's end over the
  // lap below) is the wall there too; the next step is never a hand higher.
  const wallAt = (p: V, own: Solid): boolean => built.some((s) => s !== own && inside(s, p));
  for (const f of faces) {
    const k = kinds[f.solid];
    const up = f.n[1] > 0.9 && k.tread && steps.includes(solids[f.solid]);
    let c: V = [0, 0, 0];
    for (const p of f.corners) c = [c[0] + p[0] / f.corners.length, c[1] + p[1] / f.corners.length, c[2] + p[2] / f.corners.length];
    const down = f.n[1] < -0.9 && k.roof && !k.tread && (underArea.get(f.solid) ?? 0) < STEP_AREA && floorUnder(steps, [c[0], c[1] - 0.1, c[2]]) !== null;
    if (!up && !down) continue;
    if (down) stepVaults.add(solids[f.solid]);
    for (let i = 0; i < f.corners.length; i++) {
      const a = f.corners[i], b = f.corners[(i + 1) % f.corners.length];
      const l = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (l < 0.05) continue;
      // Out across this edge, away from the face's middle.
      let o: V = [(b[2] - a[2]) / l, 0, -(b[0] - a[0]) / l];
      const m: V = [(a[0] + b[0]) / 2, a[1], (a[2] + b[2]) / 2];
      if ((m[0] - c[0]) * o[0] + (m[2] - c[2]) * o[2] < 0) o = [-o[0], 0, -o[2]];
      if (!wallAt([m[0] + o[0] * 0.3, m[1] + (up ? 0.5 : -0.5), m[2] + o[2] * 0.3], solids[f.solid])) continue;
      (up ? treads : vaults).push({ a, b, n: [-o[0], 0, -o[2]] });
    }
  }
  return { treads, vaults, on };
}

function partShape(part: DungeonPartDef): { solids: Solid[]; faces: Face[]; kinds: SolidKind[] } {
  let known = shapesOfPart.get(part);
  if (!known) {
    // Its colliders, then what is only drawn (a doorway's open leaves).
    // (Its tombs collide as boxes but are drawn carved, with its trims: not here.)
    const solids = solidsOf([...part.shapes.slice(0, part.drawn ?? part.shapes.length), ...part.visuals]);
    // A part with no way through (a cap) is seen only from the part it closes: its faces lying in
    // a socket's plane, facing out through it.
    const faces = part.paths.length > 0 ? partFaces(solids, false, solids.map((_, i) => i), new Set(part.whole)) : socketFaces(solids, part);
    const kinds = solidKinds(solids.length, faces);
    // Wall all over, though narrow on top: no step.
    for (const i of part.plain) kinds[i] = { tread: false, floor: false, roof: false, top: -Infinity, plain: true };
    shapesOfPart.set(part, (known = { solids, faces, kinds }));
  }
  return known;
}

/** The faces of a part's solids lying in one of its sockets' planes and facing out of it. */
function socketFaces(solids: readonly Solid[], part: DungeonPartDef): Face[] {
  const all = partFaces(solids, true);
  return all.filter((f) =>
    part.sockets.some((socket) => {
      const a = (socket.facing * Math.PI) / 180;
      const out: V = [Math.sin(a), 0, Math.cos(a)];
      const at: V = [socket.at.x, socket.at.y, socket.at.z];
      // Facing out through it, in its plane or out to a wall's depth in front of it (a cap stands in
      // the opening it closes).
      return dot(f.n, out) > 0.99 && f.corners.every((c) => dot(sub(c, at), out) > -1e-3 && dot(sub(c, at), out) < 1.5);
    }),
  );
}

/**
 * A face of a round wall or pillar (square to a line from one of the part's round centres): its
 * texture laid round it by the angle - so a spiral's courses of stone run on round its wall and
 * pillar unbroken, rather than starting again on every chord - and up it by height.
 */
function roundOf(part: DungeonPartDef, f: Face): { uvs: [number, number][]; tangent: V } | null {
  if (Math.abs(f.n[1]) > 0.1 || part.rounds.length === 0) return null;
  const centre: V = [0, 0, 0];
  for (const c of f.corners) for (let k = 0; k < 3; k++) centre[k] += c[k] / f.corners.length;
  for (const [cx, cz] of part.rounds) {
    const dx = centre[0] - cx, dz = centre[2] - cz;
    const r = Math.hypot(dx, dz);
    if (r < 0.5 || Math.abs((f.n[0] * dx + f.n[2] * dz) / r) < 0.95) continue;
    const a = Math.atan2(dx, dz);
    const uvs = f.corners.map((c): [number, number] => {
      let ca = Math.atan2(c[0] - cx, c[2] - cz) - a;
      ca -= Math.round(ca / (2 * Math.PI)) * 2 * Math.PI;
      return [(a + ca) * r, c[1]];
    });
    return { uvs, tangent: [Math.cos(a), 0, -Math.sin(a)] };
  }
  return null;
}

/**
 * A step's tread or riser laid by the step (DUNGEONS.md, *Materials*): the tread from its nosing -
 * the edge it drops away from - (v 0) to its back (v 1), the riser from its foot (v 0) to the
 * tread (v 1); both in metres along the step. So the materials' bevels lie on the nosing whatever
 * the step's size; a spiral's wedge-shaped steps stretch them a little toward the pillar. Null for
 * any other face.
 */
function stairOf(f: Face, kind: SolidKind, solids: readonly Solid[], look: DungeonStyleDef["look"]): { paint: DungeonPaint; uvs: [number, number][]; tangent: V } | null {
  if (!kind.tread) return null;
  let c = f.corners;
  if (f.n[1] > 0.5) {
    // The step's whole top, not the piece of it left between the pillar and the wall: every piece
    // of one tread is laid from the same nosing.
    const piece = f.corners;
    c = solids[f.solid].sides.find((side) => side.n[1] > 0.5)?.corners ?? piece;
    // The nosing: the edge with open space past it and the floor there lowest under it.
    const y = Math.max(...c.map((p) => p[1]));
    let front = -1, deepest = 0.1;
    const inward = (i: number): V => {
      const a = c[i], b = c[(i + 1) % c.length];
      const along = norm(sub(b, a));
      let into = cross(f.n, along);
      const centre: V = [0, 0, 0];
      for (const p of c) for (let k = 0; k < 3; k++) centre[k] += p[k] / c.length;
      if (dot(sub(centre, a), into) < 0) into = [-into[0], -into[1], -into[2]];
      return into;
    };
    for (let i = 0; i < c.length; i++) {
      const a = c[i], b = c[(i + 1) % c.length];
      const into = inward(i);
      const past: V = [(a[0] + b[0]) / 2 - into[0] * 0.1, y + 0.05, (a[2] + b[2]) / 2 - into[2] * 0.1];
      if (solids.some((s) => inside(s, past))) continue;
      const floor = floorUnder(solids, past);
      if (floor !== null && y - floor > deepest) {
        deepest = y - floor;
        front = i;
      }
    }
    // Nowhere it drops away: a landing among the steps (a spiral's level ends) - floor.
    if (front < 0) return { paint: look.floor, uvs: piece.map((p): [number, number] => [p[0], -p[2]]), tangent: [1, 0, 0] };
    const a = c[front];
    const into = inward(front);
    // The back: the edge facing the nosing most squarely.
    let back = -1, facing = 1;
    for (let i = 0; i < c.length; i++) {
      if (i === front) continue;
      const d = dot(inward(i), into);
      if (d < facing) { facing = d; back = i; }
    }
    const b0 = c[back];
    const backInto = inward(back);
    // Along the nosing, turned so its u x v climbs into the step (the shader's tangent frame).
    let tangent = norm(sub(c[(front + 1) % c.length], a));
    if (dot(cross(f.n, tangent), into) < 0) tangent = [-tangent[0], -tangent[1], -tangent[2]];
    const uvs = piece.map((p): [number, number] => {
      const fromFront = dot(sub(p, a), into), fromBack = dot(sub(p, b0), backInto);
      return [dot(p, tangent), fromFront / Math.max(1e-6, fromFront + fromBack)];
    });
    return { paint: look.tread, uvs, tangent };
  }
  if (Math.abs(f.n[1]) > 0.1) return null;
  let low = Infinity, high = -Infinity;
  for (const p of c) {
    low = Math.min(low, p[1]);
    high = Math.max(high, p[1]);
  }
  // A riser: up to its step's tread. (What lies under a step is its underside: the vault's.)
  if (Math.abs(high - kind.top) > 0.05 || high - low < 1e-3) return { paint: look.ceiling, uvs: c.map((p) => [dot(p, horizontal(f.n)), p[1]]), tangent: horizontal(f.n) };
  const tangent = horizontal(f.n);
  return { paint: look.riser, uvs: c.map((p): [number, number] => [dot(p, tangent), (p[1] - low) / (high - low)]), tangent };
}

/** The frame stone's blocks (`doorStone`: two across a 3 m repeat, four courses up it). */
const BLOCK: [number, number] = [1.5, 0.75];

/**
 * A doorway's stone laid by its own shape, in its frame (the opening's middle, on the floor): the
 * jambs, sill and lintel in courses from the floor and blocks from the opening's edge, so joints
 * fall on their edges; each arch stone (voussoir) one whole block - across it from the ring's inside
 * out, along it round the ring - on its face and underneath, alternate courses staggered.
 */
function doorwayStone(f: Face, part: DungeonPartDef): { uvs: [number, number][]; tangent: V } | null {
  const c = f.corners;
  const v = part.voussoirs.find((x) => x.shape === f.solid);
  if (v) {
    const centre: V = [0, 0, 0];
    for (const p of c) for (let k = 0; k < 3; k++) centre[k] += p[k] / c.length;
    const phi = Math.atan2(centre[1] - v.cy, centre[0]);
    const radial: V = [Math.cos(phi), Math.sin(phi), 0];
    const round: V = [-Math.sin(phi), Math.cos(phi), 0];
    const facing = Math.abs(f.n[2]) > 0.7;
    if (!facing && Math.abs(dot(f.n, radial)) < 0.7) return null;
    // Across the block: out from the ring on its face, through the doorway underneath.
    const tangent: V = facing ? radial : [0, 0, 1];
    const forward = dot(cross(f.n, tangent), round) > 0;
    const u0 = (v.course % 2) * (BLOCK[0] / 2);
    const uvs = c.map((p): [number, number] => {
      const a = Math.atan2(p[1] - v.cy, p[0]);
      const along = Math.min(1, Math.max(0, (a - v.a0) / (v.a1 - v.a0)));
      const across = facing ? (Math.hypot(p[0], p[1] - v.cy) - v.r0) / (v.r1 - v.r0) : (p[2] + BLOCK[0]) / (2 * BLOCK[0]);
      return [u0 + across * BLOCK[0], (v.course + (forward ? along : 1 - along)) * BLOCK[1]];
    });
    return { uvs, tangent };
  }
  if (Math.abs(f.n[1]) > 0.5) {
    const tangent: V = [1, 0, 0];
    const up = cross(f.n, tangent);
    return { uvs: c.map((p): [number, number] => [p[0], dot(p, up)]), tangent };
  }
  const tangent = horizontal(f.n);
  return { uvs: c.map((p): [number, number] => [dot(p, tangent), p[1]]), tangent };
}

/** Along a wall, level - turned so that n x it points up, as the shader's frame wants v. */
function horizontal(n: V): V {
  const t = norm([-n[2], 0, n[0]]);
  return cross(n, t)[1] >= 0 ? t : [-t[0], -t[1], -t[2]];
}

/** Whether two boxes meet, or nearly. */
const boxesMeet = (a: PlacedPart["box"], b: PlacedPart["box"]): boolean =>
  a.min.x < b.max.x + 0.2 && a.max.x > b.min.x - 0.2 && a.min.y < b.max.y + 0.2 && a.max.y > b.min.y - 0.2 && a.min.z < b.max.z + 0.2 && a.max.z > b.min.z - 0.2;

/** A part's point and its directions in the layout's frame. */
function partToFrame(p: PlacedPart, frame: DungeonFrame): { point: (l: V) => V; turn: (l: V) => V; back: (f: V) => V; unturn: (f: V) => V } {
  const o = worldToFrame(frame, p.x, p.z);
  const rel = p.yaw - frame.yaw;
  // Parts are square to the frame: exact quarter turns, so faces meeting at a join meet exactly.
  const snap = (x: number): number => (Math.abs(x) < 1e-9 ? 0 : Math.abs(Math.abs(x) - 1) < 1e-9 ? Math.sign(x) : x);
  const c = snap(Math.cos(rel)), s = snap(Math.sin(rel));
  const turn = (l: V): V => [l[0] * c + l[2] * s, l[1], -l[0] * s + l[2] * c];
  const unturn = (f: V): V => [f[0] * c - f[2] * s, f[1], f[0] * s + f[2] * c];
  return {
    turn,
    point: (l) => { const t = turn(l); return [o.fx + t[0], p.y + t[1], o.fz + t[2]]; },
    unturn,
    back: (f) => unturn([f[0] - o.fx, f[1] - p.y, f[2] - o.fz]),
  };
}

const asPaint = (p: DungeonPaint): Paint => ({ material: p.material, tint: p.tint });

/**
 * One placed part's model in the layout's frame: its faces, and a fixture at each of its `light`
 * spots the style lights (its `lit` share), hung on the nearest wall with its flame at least
 * FLAME_HEIGHT over the floor.
 */
export function buildPartModel(layout: DungeonLayout, index: number, style: DungeonStyleDef, fixture: PropDef | undefined): PartModel {
  const placed = layout.parts[index];
  const shape = trimmedShape(placed.part, style.trims);
  const { solids, kinds } = shape;
  let faces = shape.faces;
  const { point, turn, back, unturn } = partToFrame(placed, layout.frame);
  // The parts touching this one, their solids moved into its frame.
  const touching = (wanted: (q: PlacedPart) => boolean, colliders: boolean): Solid[] =>
    layout.parts.flatMap((q, i) => {
      if (i === index || !wanted(q) || !boxesMeet(q.box, placed.box)) return [];
      const there = partToFrame(q, layout.frame);
      const own = partShape(q.part).solids;
      return (colliders ? own.slice(0, q.part.shapes.length) : own).map((so) => moveSolid(so, (p) => back(there.point(p)), (d) => unturn(there.turn(d))));
    });
  if (placed.role === "doorway") {
    // A doorway is cut, and seen or not, against the parts it stands between.
    const all = [...solids, ...touching((q) => q.role !== "doorway", true)];
    faces = partFaces(all, false, solids.map((_, i) => i));
  } else {
    // A part gives way to the doorways set across it: where they lie in front of its faces, and
    // where a face of theirs lies on one of its own.
    const doors = touching((q) => q.role === "doorway", true);
    if (doors.length > 0) faces = faces.flatMap((f) => cutFace(f, doors, [COVER, -COVER]));
  }
  const b = new ModelBuilder();
  for (const f of faces) {
    const door = placed.role === "doorway" ? (f.solid >= placed.part.shapes.length ? style.look.door : style.look.frame) : null;
    const paint = asPaint(door ?? paintFor(f, kinds[f.solid], style.look));
    // A doorway's stone laid by its own shape (its leaves, drawn only, as any face).
    const stone = placed.role === "doorway" && f.solid < placed.part.shapes.length ? doorwayStone(f, placed.part) : null;
    if (stone) {
      b.raw(f.corners.map(point), f.corners.map(() => turn(f.n)), f.corners.map(() => turn(stone.tangent)), stone.uvs, paint);
      continue;
    }
    // A trim's stone along its grain, where it slopes (a stair's band).
    const grain = kinds[f.solid].grain;
    if (grain) {
      const g = sub(grain, [f.n[0] * dot(grain, f.n), f.n[1] * dot(grain, f.n), f.n[2] * dot(grain, f.n)]);
      if (Math.hypot(g[0], g[1], g[2]) > 0.3) {
        const tangent = norm(g), up = cross(f.n, tangent);
        const o = kinds[f.solid].uvOrigin ?? [0, 0, 0];
        b.raw(f.corners.map(point), f.corners.map(() => turn(f.n)), f.corners.map(() => turn(tangent)), f.corners.map((p): [number, number] => [dot(sub(p, o), tangent), dot(sub(p, o), up)]), paint);
        continue;
      }
    }
    const stair = placed.role === "doorway" ? null : stairOf(f, kinds[f.solid], solids, style.look);
    if (stair) {
      b.raw(f.corners.map(point), f.corners.map(() => turn(f.n)), f.corners.map(() => turn(stair.tangent)), stair.uvs, asPaint(stair.paint));
      continue;
    }
    // A niche's inside: the wall's stone, laid as the wall's is.
    if (f.dent) {
      b.face(f.corners.map(point), turn(f.n), asPaint(style.look.niche));
      continue;
    }
    const round = roundOf(placed.part, f);
    if (round) b.raw(f.corners.map(point), f.corners.map(() => turn(f.n)), f.corners.map(() => turn(round.tangent)), round.uvs, paint);
    else b.face(f.corners.map(point), turn(f.n), paint);
  }
  const random = mulberry32(deriveSeed(layout.seed, index * 7919 + 13));
  const spots = placed.part.spots.light ?? [];
  spots.forEach((spot, i) => {
    if (!fixture || random() >= style.light.lit) return;
    let at: V = [spot.x, spot.y, spot.z];
    const floor = floorUnder(solids, at);
    if (floor !== null) at = [at[0], Math.max(at[1], floor + FLAME_HEIGHT), at[2]];
    // The nearest wall round it, along the part's axes and between them.
    let wall: { t: number; n: V } | null = null;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const hit = rayHit(solids, at, [Math.sin(a), 0, Math.cos(a)], MOUNT_REACH);
      if (hit && Math.abs(hit.n[1]) < 0.2 && (!wall || hit.t < wall.t)) wall = { t: hit.t, n: hit.n };
    }
    if (!wall) return;
    const model = generateProp(fixture, deriveSeed(layout.seed, index * 131 + i), i);
    const flame = model.lights?.[0]?.position ?? [0, 0, 0];
    // Its back on the wall straight behind the spot (the prop's back is 0.35 m behind its origin),
    // facing out of the wall; its flame at the spot's height.
    const out = norm([wall.n[0], 0, wall.n[2]]);
    const away = wallDistance(solids, at, out) - 0.35;
    const p = point([at[0] - out[0] * away, at[1] - flame[1], at[2] - out[2] * away]);
    const front = turn(out);
    b.append(model, p[0], p[1], p[2], front[0], front[2]);
  });
  const model = b.finish({ x: 0, z: 0 });
  return { model, lights: model.lights ?? [] };
}

/** How far a point is from the wall facing it along -`out` (the wall's outward normal). */
function wallDistance(solids: readonly Solid[], p: V, out: V): number {
  const hit = rayHit(solids, p, [-out[0], -out[1], -out[2]], MOUNT_REACH * 2);
  return hit ? hit.t : 0;
}

/** The lights that reach into a part: every fixture's in the layout within its reach of the part's box. */
export function lightsReaching(placed: PlacedPart, all: readonly ModelLight[]): ModelLight[] {
  const { min, max } = placed.box;
  return all.filter((l) => {
    const [x, y, z] = l.position;
    const dx = Math.max(min.x - x, 0, x - max.x), dy = Math.max(min.y - y, 0, y - max.y), dz = Math.max(min.z - z, 0, z - max.z);
    return Math.hypot(dx, dy, dz) < l.radius;
  });
}
