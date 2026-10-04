import type { Paint, PitchedRoofSpec, RoofType } from "./buildingTypes";
import { ModelBuilder, roll, type Vec3 } from "./buildingGeometry";
import type { PartPaints } from "./buildingParts";

/**
 * A pitched roof (gable or hip) over a house's blocks: a slope either side of each block's ridge, a
 * gable or a hip at each free end, each block's slopes cut where they pass under another's - so they
 * end along clean valleys - and drawn as thick slabs, with a ridge cap along the ridges and hips.
 *
 * The roof sags like an old one: a field over the whole house lowers it, nothing at the eaves and
 * at the house's outermost ends, most at the middle of a ridge and of a rafter - so a ridge dips, and
 * a hip bows inward. One field for every block, so where two roofs meet they still meet. Its slabs
 * are split into cells to bend.
 */

type Point = [number, number];

export interface RoofEnd {
  kind: RoofType | "attached";
  /** How far the roof reaches past the wall at this end. */
  overhang: number;
  /** An attached end's roof runs this far on into the block it joins. */
  extend: number;
}

/** One block to roof, in metres: `a` runs along its ridge, `c` across it. */
export interface RoofBlockInput {
  a0: number;
  a1: number;
  c0: number;
  c1: number;
  alongX: boolean;
  start: RoofEnd;
  end: RoofEnd;
}

/** What a roof settles before the walls are built: its shape at free ends, and its pitch, overhang
 *  and thickness - all the gables, the ridge and the eaves depend on. */
export interface RoofPlan {
  shape: RoofType;
  slope: number;
  overhang: number;
  thickness: number;
  /** How far its ridges and rafters sag at most (metres). */
  ridgeSag: number;
  slopeSag: number;
  /** How far its ridge tiles stand above the slab. */
  ridgeHeight: number;
}

export function planPitchedRoof(spec: PitchedRoofSpec, rng: () => number): RoofPlan {
  const shape = spec.shapes[Math.floor(rng() * spec.shapes.length) % spec.shapes.length];
  const slope = Math.tan((roll(spec.pitch, rng) * Math.PI) / 180);
  return {
    shape,
    slope,
    overhang: spec.overhang,
    thickness: spec.thickness,
    ridgeSag: roll(spec.sag.ridge, rng),
    slopeSag: roll(spec.sag.slope, rng),
    ridgeHeight: spec.ridgeTiles ? spec.ridgeTiles.height : 0,
  };
}

/** A convex polygon cut to where `inside` is >= 0 (Sutherland-Hodgman, one edge). */
function clipHalf(polygon: Point[], inside: (p: Point) => number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    const dp = inside(p);
    const dq = inside(q);
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  // A corner the cut lands on comes out twice.
  return out.filter((p, i) => {
    const q = out[(i + 1) % out.length];
    return out.length < 2 || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  });
}

function area(polygon: Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    sum += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(sum) / 2;
}

/** A sloping plane, y = h0 + hx x + hz z. */
type Plane = [number, number, number];
const heightOn = (plane: Plane, [x, z]: Point): number => plane[0] + plane[1] * x + plane[2] * z;
const planeNormal = (plane: Plane): Vec3 => {
  const length = Math.hypot(plane[1], 1, plane[2]);
  return [-plane[1] / length, 1 / length, -plane[2] / length];
};

function planeThrough(a: Vec3, b: Vec3, c: Vec3): Plane {
  const det = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
  const hx = ((b[1] - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (b[2] - a[2])) / det;
  const hz = ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / det;
  return [a[1] - hx * a[0] - hz * a[2], hx, hz];
}

/** One slope of a roof in plan (x, z), its plane, and which of its edges are the roof's own - an
 *  eave or a verge - and so closed with a strip. */
interface RoofFace {
  polygon: Point[];
  plane: Plane;
  open: [Point, Point][];
}

/** A line of ridge tiles: from `from` to `to` on the slabs' underside planes (low end first), with
 *  `up` the way the tiles' backs face. */
interface RidgeLine {
  from: Vec3;
  to: Vec3;
  up: Vec3;
  /** How far past each end (metres in plan) its tiles run on, out to the covering's edge. */
  extend: [number, number];
  /** How steeply the slopes either side fall away from it, across it: down per metre out. */
  fall: number;
}

/** A block's roof: its slopes, its ridge and hip lines, and its outline in plan. */
interface BlockRoof {
  faces: RoofFace[];
  lines: RidgeLine[];
  outline: { x0: number; x1: number; z0: number; z1: number };
}

/**
 * A roof over one block: two slopes, and at each end a gable, a hip, or - where it joins another
 * block - nothing, running on into that block's roof. Draws the gables' wall triangles; the slopes
 * are returned, to be cut against the house's other roofs before they are drawn.
 */
function roofBlock(b: ModelBuilder, block: RoofBlockInput, eaves: number, slope: number, overhang: number, reach: { eave: number; verge: number }, wall: Paint): BlockRoof {
  const { a0, a1, c0, c1, alongX, start, end } = block;
  const half = (c1 - c0) / 2;
  const middle = (c0 + c1) / 2;
  const ridge = eaves + half * slope;
  const eaveLow = eaves - overhang * slope;
  const P = (a: number, c: number, y: number): Vec3 => (alongX ? [a, y, c] : [c, y, a]);
  const eaveA0 = a0 - (start.kind === "attached" ? start.extend : start.overhang);
  const eaveA1 = a1 + (end.kind === "attached" ? end.extend : end.overhang);
  // A hip's slope at an end climbs as steeply as the sides do: the ridge stops half a span short.
  let ridgeA0 = start.kind === "hip" ? a0 + half : eaveA0;
  let ridgeA1 = end.kind === "hip" ? a1 - half : eaveA1;
  if (ridgeA0 > ridgeA1) ridgeA0 = ridgeA1 = (ridgeA0 + ridgeA1) / 2;

  const faces: RoofFace[] = [];
  const face = (corners: Vec3[], open: [number, number][]): void => {
    const polygon = corners.map(([x, , z]): Point => [x, z]);
    faces.push({ polygon, plane: planeThrough(corners[0], corners[1], corners[2]), open: open.map(([i, j]): [Point, Point] => [polygon[i], polygon[j]]) });
  };
  for (const cEave of [c0 - overhang, c1 + overhang]) {
    const open: [number, number][] = [[0, 1]];
    if (start.kind === "gable") open.push([0, 3]);
    if (end.kind === "gable") open.push([1, 2]);
    face([P(eaveA0, cEave, eaveLow), P(eaveA1, cEave, eaveLow), P(ridgeA1, middle, ridge), P(ridgeA0, middle, ridge)], open);
  }
  const lines: RidgeLine[] = [];
  // The ridge runs on to the covering's edge at a gable, past the verge.
  const ridgeReach = (endSpec: RoofEnd): number => (endSpec.kind === "gable" ? reach.verge : 0);
  if (ridgeA1 - ridgeA0 > 1e-3) {
    lines.push({ from: P(ridgeA0, middle, ridge), to: P(ridgeA1, middle, ridge), up: [0, 1, 0], extend: [ridgeReach(start), ridgeReach(end)], fall: slope });
  }
  const outward = (sign: number): Vec3 => (alongX ? [sign, 0, 0] : [0, 0, sign]);
  for (const [endSpec, a, eaveA, ridgeA, sign] of [
    [start, a0, eaveA0, ridgeA0, -1],
    [end, a1, eaveA1, ridgeA1, 1],
  ] as const) {
    if (endSpec.kind === "hip") {
      face([P(eaveA, c0 - overhang, eaveLow), P(eaveA, c1 + overhang, eaveLow), P(ridgeA, middle, ridge)], [[0, 1]]);
      // The hips, each between a side slope and this end's: their tiles face between the two.
      const endNormal = planeNormal(faces[faces.length - 1].plane);
      for (const [side, cEave] of [[0, c0 - overhang], [1, c1 + overhang]] as const) {
        const n = planeNormal(faces[side].plane);
        // A hip runs on down to the covering's corner, out past both its eaves. Its tiles face
        // halfway between the two slopes, which fall away from them by half the angle between.
        const up = normalize([n[0] + endNormal[0], n[1] + endNormal[1], n[2] + endNormal[2]]);
        const half = Math.acos(Math.min(1, n[0] * up[0] + n[1] * up[1] + n[2] * up[2]));
        lines.push({ from: P(eaveA, cEave, eaveLow), to: P(ridgeA, middle, ridge), up, extend: [reach.eave * Math.SQRT2, 0], fall: Math.tan(half) });
      }
    } else if (endSpec.kind === "gable") {
      // The wall's triangle up under the roof.
      b.faceToward([P(a, c0, eaves), P(a, c1, eaves), P(a, middle, ridge)], outward(sign), wall);
    }
  }
  const [x0, , z0] = P(eaveA0, c0 - overhang, 0);
  const [x1, , z1] = P(eaveA1, c1 + overhang, 0);
  return { faces, lines, outline: { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) } };
}

const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const EPS = 1e-6;

/** What of another block's roof hides: inside its outline, and below every one of its slopes'
 *  planes - each as a test >= 0. A point in the very plane of one of its slopes is hidden only if
 *  `yields`. */
function hiddenUnder(other: BlockRoof, height: (p: Point) => number, yields: boolean): ((p: Point) => number)[] {
  const { x0, x1, z0, z1 } = other.outline;
  const tie = yields ? -1e-4 : EPS;
  return [
    (p) => p[0] - x0 - EPS,
    (p) => x1 - p[0] - EPS,
    (p) => p[1] - z0 - EPS,
    (p) => z1 - p[1] - EPS,
    ...other.faces.map((f) => (p: Point) => heightOn(f.plane, p) - height(p) - tie),
  ];
}

/**
 * A slope with whatever of it lies under another block's roof cut away.
 *
 * Every block's roof has the same pitch and is convex: its surface is the lowest of its slopes'
 * planes, over its outline. What of a slope is hidden is where it lies inside that outline and
 * below every one of those planes - a convex region - and taking it away leaves at most one convex
 * piece per side of it. The cut runs exactly along the valley where the two roofs meet.
 *
 * A slope in the very same plane as one of the other roof's (a side wing flush with the main block's
 * front or back) is under it only if `yields`: the one that yields is cut away where the two
 * overlap, and the other runs on over it, its overhang and all.
 */
function cutUnder(face: RoofFace, other: BlockRoof, yields: boolean): RoofFace[] {
  const pieces: RoofFace[] = [];
  let rest = face.polygon;
  for (const inside of hiddenUnder(other, (p) => heightOn(face.plane, p), yields)) {
    const outside = clipHalf(rest, (p) => -inside(p));
    if (outside.length >= 3 && area(outside) > 1e-4) pieces.push({ ...face, polygon: outside });
    rest = clipHalf(rest, inside);
    if (rest.length < 3) break;
  }
  return pieces;
}

/** The stretches (0-1 along it) of a ridge line not hidden under another block's roof. */
function visibleSpans(line: RidgeLine, other: BlockRoof, yields: boolean, spans: [number, number][]): [number, number][] {
  const at = (t: number): Point => [line.from[0] + (line.to[0] - line.from[0]) * t, line.from[2] + (line.to[2] - line.from[2]) * t];
  const heightAt = (t: number): number => line.from[1] + (line.to[1] - line.from[1]) * t;
  // Where a point in plan is along the line, so the line's own height can be tested there.
  const dx = line.to[0] - line.from[0];
  const dz = line.to[2] - line.from[2];
  const tOf = (p: Point): number => ((p[0] - line.from[0]) * dx + (p[1] - line.from[2]) * dz) / (dx * dx + dz * dz);
  // Each test is linear along the line (past its ends too): hidden where all of them are >= 0, an
  // interval [lo, hi].
  let lo = -Infinity;
  let hi = Infinity;
  for (const test of hiddenUnder(other, (p) => heightAt(tOf(p)), yields)) {
    const f0 = test(at(0));
    const f1 = test(at(1));
    if (Math.abs(f1 - f0) < 1e-12) {
      if (f0 < 0) return spans;
      continue;
    }
    const t = f0 / (f0 - f1);
    if (f1 > f0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
  }
  if (hi - lo < 1e-6) return spans;
  return spans.flatMap(([s0, s1]): [number, number][] => {
    const out: [number, number][] = [];
    if (lo > s0) out.push([s0, Math.min(s1, lo)]);
    if (hi < s1) out.push([Math.max(s0, hi), s1]);
    return out.filter(([p, q]) => q - p > 1e-4);
  });
}

/** Whether p-q lies along one of a face's open edges. */
function alongOpenEdge(face: RoofFace, p: Point, q: Point): boolean {
  const on = (point: Point, [a, b]: [Point, Point]): boolean => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    if (length === 0) return false;
    const across = Math.abs((point[0] - a[0]) * dz - (point[1] - a[1]) * dx) / length;
    const along = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (length * length);
    return across < 1e-4 && along > -1e-4 && along < 1 + 1e-4;
  };
  return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6 && face.open.some((edge) => on(p, edge) && on(q, edge));
}

/** How far the roof sags at a point in plan, whose underside (before sagging) is `y` high. */
type Sag = (x: number, z: number, y: number) => number;

/** How a slab is built up, and painted. */
interface SlabLook {
  /** The whole slab, and the covering on top of its boards. */
  thickness: number;
  covering: PitchedRoofSpec["covering"];
  bargeboard: PitchedRoofSpec["bargeboard"];
  step: number;
  top: Paint;
  underside: Paint;
}

/**
 * A convex polygon with some of its edges pushed out: edge i (from corner i to i + 1) by `by[i]`,
 * away from the polygon. Each corner is where its two edges' lines, pushed, now cross.
 */
function pushEdges(polygon: Point[], by: number[]): Point[] {
  const n = polygon.length;
  const cx = polygon.reduce((sum, p) => sum + p[0], 0) / n;
  const cz = polygon.reduce((sum, p) => sum + p[1], 0) / n;
  // Each edge's line, pushed: a point on it and its direction.
  const lines = polygon.map((p, i) => {
    const q = polygon[(i + 1) % n];
    const d: Point = [q[0] - p[0], q[1] - p[1]];
    const length = Math.hypot(d[0], d[1]) || 1;
    let out: Point = [d[1] / length, -d[0] / length];
    if (out[0] * ((p[0] + q[0]) / 2 - cx) + out[1] * ((p[1] + q[1]) / 2 - cz) < 0) out = [-out[0], -out[1]];
    return { at: [p[0] + out[0] * by[i], p[1] + out[1] * by[i]] as Point, d, out };
  });
  return polygon.map((p, i) => {
    const a = lines[(i + n - 1) % n];
    const b = lines[i];
    const det = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    // Two edges in line: the corner just moves out with them.
    if (Math.abs(det) < 1e-9) return [p[0] + b.out[0] * by[i], p[1] + b.out[1] * by[i]];
    const t = ((b.at[0] - a.at[0]) * b.d[1] - (b.at[1] - a.at[1]) * b.d[0]) / det;
    return [a.at[0] + a.d[0] * t, a.at[1] + a.d[1] * t];
  });
}

/**
 * A slope drawn as a slab, sagging: boards on its plane, and the covering on them - the whole of it
 * `thickness` thick across the slope, both layers bent down by the sag. It is split into cells `step`
 * across to bend; each cell is textured in the slope's own frame, so the texture runs on across them
 * unbroken, and shaded by the bent surface's normal.
 *
 * At the eaves the covering reaches out past the boards, its own edge showing over theirs. At a
 * verge (a gable's edge) a bargeboard stands up past the covering - or, without one, the covering
 * reaches past the boards there too. The building is drawn from both sides, so the covering's lip
 * needs no underside of its own.
 */
function drawSlab(b: ModelBuilder, face: RoofFace, slope: number, sag: Sag, look: SlabLook): void {
  const k = Math.sqrt(1 + slope * slope);
  const lift = look.thickness * k;
  const boards = Math.max(0, look.thickness - look.covering.thickness) * k;
  const flat = planeNormal(face.plane);
  const down: Vec3 = [-flat[0], -flat[1], -flat[2]];
  const at = ([x, z]: Point, up: number): Vec3 => {
    const y = heightOn(face.plane, [x, z]);
    return [x, y + sag(x, z, y) + up, z];
  };
  // The bent surface's normal, from its slope either way.
  const normalAt = ([x, z]: Point): Vec3 => {
    const e = 0.05;
    const h = (px: number, pz: number): number => at([px, pz], 0)[1];
    return normalize([-(h(x + e, z) - h(x - e, z)) / (2 * e), 1, -(h(x, z + e) - h(x, z - e)) / (2 * e)]);
  };
  /** A polygon split into cells, each drawn by `draw`. */
  const cells = (polygon: Point[], draw: (cell: Point[]) => void): void => {
    const step = look.step;
    const xs = polygon.map((p) => p[0]);
    const zs = polygon.map((p) => p[1]);
    for (let gx = Math.floor(Math.min(...xs) / step); gx * step < Math.max(...xs); gx++) {
      for (let gz = Math.floor(Math.min(...zs) / step); gz * step < Math.max(...zs); gz++) {
        let cell = polygon;
        cell = clipHalf(cell, (p) => p[0] - gx * step);
        cell = clipHalf(cell, (p) => (gx + 1) * step - p[0]);
        cell = clipHalf(cell, (p) => p[1] - gz * step);
        cell = clipHalf(cell, (p) => (gz + 1) * step - p[1]);
        if (cell.length >= 3 && area(cell) > 1e-6) draw(cell);
      }
    }
  };
  /** An edge from p to q split into lengths short enough to follow the sag. */
  const lengths = (p: Point, q: Point): [Point, Point][] => {
    const count = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / look.step));
    const point = (t: number): Point => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    return Array.from({ length: count }, (_, i): [Point, Point] => [point(i / count), point((i + 1) / count)]);
  };
  const cx = face.polygon.reduce((sum, p) => sum + p[0], 0) / face.polygon.length;
  const cz = face.polygon.reduce((sum, p) => sum + p[1], 0) / face.polygon.length;
  const awayFrom = (p: Point, q: Point): Vec3 => {
    const away = normalize(cross([q[0] - p[0], 0, q[1] - p[1]], [0, 1, 0]));
    return away[0] * ((p[0] + q[0]) / 2 - cx) + away[2] * ((p[1] + q[1]) / 2 - cz) < 0 ? [-away[0], -away[1], -away[2]] : away;
  };

  // Which edges are open, and which of those are verges - sloping, where an eave is level.
  const n = face.polygon.length;
  const edges = face.polygon.map((p, i) => {
    const q = face.polygon[(i + 1) % n];
    const open = alongOpenEdge(face, p, q);
    const verge = open && Math.abs(heightOn(face.plane, p) - heightOn(face.plane, q)) > 1e-4;
    return { p, q, open, verge, barge: verge && look.bargeboard !== null };
  });

  // The boards: their underside, and their edges at every open edge a bargeboard does not cover.
  cells(face.polygon, (cell) => {
    const normals = cell.map((p): Vec3 => {
      const v = normalAt(p);
      return [-v[0], -v[1], -v[2]];
    });
    b.surface(cell.map((p) => at(p, 0)), normals, down, look.underside);
  });
  for (const { p, q, open, barge } of edges) {
    if (!open || barge) continue;
    const away = awayFrom(p, q);
    const grain: Vec3 = [q[0] - p[0], 0, q[1] - p[1]];
    for (const [s, t] of lengths(p, q)) b.surface([at(s, 0), at(t, 0), at(t, boards), at(s, boards)], [away, away, away, away], away, look.underside, grain);
  }

  // The covering, on the boards, reaching past them at the eaves (and verges with no bargeboard).
  const reach = edges.map((edge) => (edge.open && !edge.barge ? look.covering.overhang : 0));
  const cover = pushEdges(face.polygon, reach);
  cells(cover, (cell) => b.surface(cell.map((p) => at(p, lift)), cell.map(normalAt), flat, look.top));
  cover.forEach((p, i) => {
    if (reach[i] === 0) return;
    const q = cover[(i + 1) % n];
    const away = awayFrom(p, q);
    const grain: Vec3 = [q[0] - p[0], 0, q[1] - p[1]];
    for (const [s, t] of lengths(p, q)) b.surface([at(s, boards), at(t, boards), at(t, lift), at(s, lift)], [away, away, away, away], away, look.top, grain);
  });

  // Bargeboards up the verges: boards on edge, standing past the covering, closing the slab's end.
  const barge = look.bargeboard;
  if (!barge) return;
  for (const { p, q, barge: here } of edges) {
    if (!here) continue;
    const away = awayFrom(p, q);
    const inward: Vec3 = [-away[0], -away[1], -away[2]];
    const grain: Vec3 = [q[0] - p[0], 0, q[1] - p[1]];
    const outer = (point: Point): Point => [point[0] + away[0] * barge.thickness, point[1] + away[2] * barge.thickness];
    const low = (point: Point, from: Point): Vec3 => {
      const v = at(from, 0);
      return [point[0], v[1] - 0.05, point[1]];
    };
    const high = (point: Point, from: Point): Vec3 => {
      const v = at(from, lift);
      return [point[0], v[1] + barge.height, point[1]];
    };
    for (const [s, t] of lengths(p, q)) {
      const so = outer(s);
      const to = outer(t);
      b.surface([low(so, s), low(to, t), high(to, t), high(so, s)], [away, away, away, away], away, look.underside, grain);
      b.surface([low(s, s), low(t, t), high(t, t), high(s, s)], [inward, inward, inward, inward], inward, look.underside, grain);
      b.faceToward([high(s, s), high(t, t), high(to, t), high(so, s)], [0, 1, 0], look.underside, grain);
      b.faceToward([low(s, s), low(t, t), low(to, t), low(so, s)], [0, -1, 0], look.underside, grain);
    }
    // Its ends: the low one at the eaves, the high one at the ridge.
    for (const [end, other] of [[p, q], [q, p]] as const) {
      const towards: Vec3 = [end[0] - other[0], 0, end[1] - other[1]];
      const eo = outer(end);
      b.faceToward([low(end, end), low(eo, end), high(eo, end), high(end, end)], towards, look.underside);
    }
  }
}

/**
 * The ridge cap along a ridge or a hip, from `t0` to `t1` of it: one rounded back `width` across
 * standing `height` above the slabs, its edges sunk a little into them either side, swept along the
 * line in lengths short enough (`step`) to follow the sag, and closed at both ends.
 */
function drawRidgeCap(
  b: ModelBuilder,
  line: RidgeLine,
  t0: number,
  t1: number,
  lift: number,
  cap: NonNullable<PitchedRoofSpec["ridgeTiles"]>,
  step: number,
  sag: Sag,
  paint: Paint,
): void {
  const dir = normalize([line.to[0] - line.from[0], line.to[1] - line.from[1], line.to[2] - line.from[2]]);
  const side = normalize(cross(line.up, dir));
  const up = normalize(cross(dir, side));
  const point = (t: number): Vec3 => [
    line.from[0] + (line.to[0] - line.from[0]) * t,
    line.from[1] + (line.to[1] - line.from[1]) * t,
    line.from[2] + (line.to[2] - line.from[2]) * t,
  ];
  const span = Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1], line.to[2] - line.from[2]) * (t1 - t0);
  const lengths = Math.max(1, Math.ceil(span / step));
  const r = cap.width / 2;
  const SEGMENTS = 4;
  // Its edges come down onto the slopes either side - as far below the line as they fall in its
  // half width - and a little into them, so no gap shows under it.
  const sink = r * line.fall + 0.03;
  // The arc across the cap at `t`, and its normals.
  const arc =(t: number): { ring: Vec3[]; normals: Vec3[] } => {
    const base = point(t);
    const drop = sag(base[0], base[2], base[1]);
    const ring: Vec3[] = [];
    const normals: Vec3[] = [];
    for (let k = 0; k <= SEGMENTS; k++) {
      const angle = (Math.PI * k) / SEGMENTS;
      const across = Math.cos(angle) * r;
      const rise = Math.sin(angle) * (cap.height + sink) - sink;
      ring.push([
        base[0] + side[0] * across + up[0] * rise,
        base[1] + lift + side[1] * across + up[1] * rise + drop,
        base[2] + side[2] * across + up[2] * rise,
      ]);
      normals.push(normalize([side[0] * Math.cos(angle) + up[0] * Math.sin(angle), side[1] * Math.cos(angle) + up[1] * Math.sin(angle), side[2] * Math.cos(angle) + up[2] * Math.sin(angle)]));
    }
    return { ring, normals };
  };
  // One frame for the whole cap's texture, so it runs on unbroken along it.
  let previous = arc(t0);
  for (let k = 1; k <= lengths; k++) {
    const next = arc(t0 + ((t1 - t0) * k) / lengths);
    for (let s = 0; s < SEGMENTS; s++) {
      const frame = previous.normals[s];
      b.surface([previous.ring[s], previous.ring[s + 1], next.ring[s + 1], next.ring[s]], [previous.normals[s], previous.normals[s + 1], next.normals[s + 1], next.normals[s]], frame, paint, dir);
    }
    previous = next;
  }
  // Its two ends, closed.
  b.faceToward(arc(t0).ring, [-dir[0], -dir[1], -dir[2]], paint);
  b.faceToward(previous.ring, dir, paint);
}

/** The house as its roof is handed it: the eave height, and every block, the main one first. */
export interface RoofInput {
  b: ModelBuilder;
  eaves: number;
  blocks: RoofBlockInput[];
}

export function buildPitchedRoof(spec: PitchedRoofSpec, plan: RoofPlan, input: RoofInput, paints: PartPaints): void {
  const { b, eaves, blocks } = input;
  const { slope, overhang, thickness } = plan;
  // How far past the boards the covering's edge is - the ridge tiles run out to it: at the eaves,
  // and at a gable's verge (to the bargeboard's face, where there is one).
  const reach = { eave: spec.covering.overhang, verge: spec.bargeboard ? spec.bargeboard.thickness : spec.covering.overhang };
  const roofs = blocks.map((block) => roofBlock(b, block, eaves, slope, overhang, reach, paints[spec.parts.gable]));

  // The sag: over the whole roof's outline, nothing at its edges and most in its middle, and up the
  // slopes from nothing at the eaves - the ridge sinking as a whole, the rafters bowing between.
  const X0 = Math.min(...roofs.map((r) => r.outline.x0));
  const X1 = Math.max(...roofs.map((r) => r.outline.x1));
  const Z0 = Math.min(...roofs.map((r) => r.outline.z0));
  const Z1 = Math.max(...roofs.map((r) => r.outline.z1));
  const eaveLow = eaves - overhang * slope;
  const top = eaves + (Math.max(...blocks.map((k) => k.c1 - k.c0)) / 2) * slope;
  const sag: Sag = (x, z, y) => {
    const u = Math.min(1, Math.max(0, (x - X0) / (X1 - X0)));
    const v = Math.min(1, Math.max(0, (z - Z0) / (Z1 - Z0)));
    const h = Math.min(1, Math.max(0, (y - eaveLow) / (top - eaveLow)));
    return -(plan.ridgeSag * h + plan.slopeSag * Math.sin(Math.PI * h)) * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
  };

  const lift = thickness * Math.sqrt(1 + slope * slope);
  roofs.forEach((roof, k) => {
    let faces = roof.faces;
    roofs.forEach((other, m) => {
      // A wing yields to the main block (the first roof) where their slopes share a plane.
      if (m !== k) faces = faces.flatMap((face) => cutUnder(face, other, m < k));
    });
    for (const face of faces) {
      drawSlab(b, face, slope, sag, {
        thickness,
        covering: spec.covering,
        bargeboard: spec.bargeboard,
        step: spec.step,
        top: paints[spec.parts.covering],
        underside: paints[spec.parts.underside],
      });
    }
    if (!spec.ridgeTiles) return;
    for (const line of roof.lines) {
      const length = Math.hypot(line.to[0] - line.from[0], line.to[2] - line.from[2]);
      let spans: [number, number][] = [[-line.extend[0] / length, 1 + line.extend[1] / length]];
      roofs.forEach((other, m) => {
        if (m !== k) spans = visibleSpans(line, other, m < k, spans);
      });
      for (const [t0, t1] of spans) drawRidgeCap(b, line, t0, t1, lift, spec.ridgeTiles, spec.step, sag, paints[spec.parts.ridge]);
    }
  });
}
