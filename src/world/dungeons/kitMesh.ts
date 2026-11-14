// A kit-built dungeon part as it is drawn (DUNGEONS.md, *Building it*): its faces are its colliders'
// own - so what is seen is exactly what is walked on - each face cut where another of the part's
// solids covers it, dropped where it faces into the rock, and painted by what it is to the way
// through: floor, wall, vault, step. Torches stand at its light spots. Pure: no engine, so it can
// run anywhere the layout does.
import { ribs, wallTrims, type CeilingSpan, type WallFace, type WallTrims } from "../architecture/trims";
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

const inside = (s: Solid, p: V): boolean =>
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
  return pieces.map((piece) => ({ n, corners: piece.map(to3), solid: face.solid }));
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
function trimmedShape(part: DungeonPartDef, trims: WallTrims): { solids: Solid[]; faces: Face[]; kinds: SolidKind[] } {
  const plain = partShape(part);
  if (part.doorway || part.paths.length === 0 || (!trims.plinth && !trims.cornice && !trims.ribs)) return plain;
  let byStyle = trimmedParts.get(part);
  if (!byStyle) trimmedParts.set(part, (byStyle = new Map()));
  const known = byStyle.get(trims);
  if (known) return known;
  const { solids, kinds } = plain;
  const whole = new Set(part.whole);
  // The walls: upright faces of solids that are wall (not a step, a railing, a pillar drawn whole).
  const walls: WallFace[] = plain.faces.filter((f) => Math.abs(f.n[1]) < 0.1 && !kinds[f.solid].tread && !kinds[f.solid].plain && !whole.has(f.solid));
  const pieces = wallTrims(walls, { floorUnder: (p) => floorUnder(solids, p), ceilingOver: (p) => ceilingOver(solids, p) }, trims);
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
    pieces.push(...ribs(spans, (p) => solids.some((s) => inside(s, p)), trims.ribs));
  }
  const all = [...solids, ...pieces.map((t) => hullSolid(t.points))];
  const faces = partFaces(all, false, all.map((_, i) => i), whole);
  const kindsAll = solidKinds(all.length, faces);
  for (const i of part.plain) kindsAll[i] = { ...kindsAll[i], tread: false, plain: true };
  for (let i = solids.length; i < all.length; i++) kindsAll[i] = { tread: false, floor: false, roof: false, top: -Infinity, trim: true };
  const shape = { solids: all, faces, kinds: kindsAll };
  byStyle.set(trims, shape);
  return shape;
}

function partShape(part: DungeonPartDef): { solids: Solid[]; faces: Face[]; kinds: SolidKind[] } {
  let known = shapesOfPart.get(part);
  if (!known) {
    // Its colliders, then what is only drawn (a doorway's open leaves).
    const solids = solidsOf([...part.shapes, ...part.visuals]);
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
    const stair = placed.role === "doorway" ? null : stairOf(f, kinds[f.solid], solids, style.look);
    if (stair) {
      b.raw(f.corners.map(point), f.corners.map(() => turn(f.n)), f.corners.map(() => turn(stair.tangent)), stair.uvs, asPaint(stair.paint));
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
