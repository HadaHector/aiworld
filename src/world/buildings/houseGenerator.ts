import type { BuildingModel, HouseSpec, Paint, RoofType } from "./buildingTypes";
import { FOUNDATION_DEPTH, ModelBuilder, pick, roll, rollInt, type Vec3 } from "./buildingGeometry";

/**
 * A traditional one-storey house, built in the order a house is: its plan (tiles), the plinth, the
 * corner posts, the walls with their door and windows, and a roof over each block of the plan.
 *
 * The plan is a main block with its front to +z, and maybe a wing out of the back (a T or an L)
 * and one out of a side. Each block is a rectangle and gets a roof of its own - every one at the
 * same pitch and from the same eave height, so where two meet their slopes cut each other along
 * clean valleys without anything having to work out where those are.
 *
 * Doors and windows are closed: a frame and a panel standing proud of the wall, never a hole.
 */

/** A block of the plan, in tiles: i along x, j along z (the front is the main block's +z side). */
interface Block {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

type Direction = "px" | "nx" | "pz" | "nz";

type Point = [number, number];

/** A straight run of outer wall along tile edges: on the line `line`, from `from` to `to` (tiles). */
interface WallRun {
  dir: Direction;
  line: number;
  from: number;
  to: number;
}

interface RoofEnd {
  kind: RoofType | "attached";
  /** How far the roof reaches past the wall at this end. */
  overhang: number;
  /** An attached end's roof runs this far on into the block it joins - see buildHouse. */
  extend: number;
}

const UP: Vec3 = [0, 1, 0];

/**
 * How far a door's and a window's parts stand out from the wall's face (metres), each layer well clear
 * of the one behind it - a few centimetres reads as a flat decal and flickers into the layer behind
 * at a distance, where the depth buffer is coarse. The frame stands proudest, the glazing bars in
 * front of the pane, the pane well in front of the wall. Every part starts a little inside the wall,
 * so none of them has a face lying in the wall's own plane.
 */
const OUT = { pane: 0.06, bars: 0.1, door: 0.08, frame: 0.15, lintel: 0.18 };
const SET_IN = -0.03;
const DOWN: Vec3 = [0, -1, 0];

/** The plan: the main block and any wings, each wing with how its roof meets the main block's. */
function planHouse(spec: HouseSpec, rng: () => number) {
  const W = rollInt(spec.width, rng);
  const D = rollInt(spec.depth, rng);
  const main: Block = { i0: 0, i1: W, j0: 0, j1: D };
  let back: Block | null = null;
  let side: (Block & { left: boolean }) | null = null;

  // A wing out of the back: narrower than the main block's front, and no wider than it is deep, so
  // its ridge never stands above the main ridge.
  const backWidthMax = Math.min(W - 1, D);
  if (backWidthMax >= 1 && rng() < spec.backWing) {
    const w = rollInt([1, backWidthMax], rng);
    const offset = pick([0, Math.floor((W - w) / 2), W - w], rng);
    back = { i0: offset, i1: offset + w, j0: -rollInt(spec.wingLength, rng), j1: 0 };
  }
  // A wing out of one side: shallower than the main block, so its ridge is lower.
  if (D >= 2 && rng() < spec.sideWing) {
    const d = rollInt([1, D - 1], rng);
    const left = rng() < 0.5;
    let offset = pick([0, Math.floor((D - d) / 2), D - d], rng);
    // Flush with the back where a back wing is flush with the same end, the two would touch at
    // just a corner: then it goes flush with the front instead.
    if (offset === 0 && back && (left ? back.i0 === 0 : back.i1 === W)) offset = D - d;
    const length = rollInt(spec.wingLength, rng);
    side = left ? { i0: -length, i1: 0, j0: offset, j1: offset + d, left } : { i0: W, i1: W + length, j0: offset, j1: offset + d, left };
  }
  return { W, D, main, back, side };
}

/** Every outer wall of a set of tiles, as straight runs. */
function wallRuns(inside: (i: number, j: number) => boolean, blocks: Block[]): WallRun[] {
  const edges = new Map<string, { dir: Direction; line: number; at: number[] }>();
  const add = (dir: Direction, line: number, at: number): void => {
    const key = `${dir}:${line}`;
    const group = edges.get(key);
    if (group) group.at.push(at);
    else edges.set(key, { dir, line, at: [at] });
  };
  for (const block of blocks) {
    for (let i = block.i0; i < block.i1; i++) {
      for (let j = block.j0; j < block.j1; j++) {
        if (!inside(i, j + 1)) add("pz", j + 1, i);
        if (!inside(i, j - 1)) add("nz", j, i);
        if (!inside(i + 1, j)) add("px", i + 1, j);
        if (!inside(i - 1, j)) add("nx", i, j);
      }
    }
  }
  const runs: WallRun[] = [];
  for (const { dir, line, at } of edges.values()) {
    at.sort((a, b) => a - b);
    let from = at[0];
    for (let k = 1; k <= at.length; k++) {
      if (k === at.length || at[k] !== at[k - 1] + 1) {
        runs.push({ dir, line, from, to: at[k - 1] + 1 });
        if (k < at.length) from = at[k];
      }
    }
  }
  return runs;
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

/** A block's roof: its slopes, and its outline in plan. */
interface BlockRoof {
  faces: RoofFace[];
  outline: { x0: number; x1: number; z0: number; z1: number };
}

/**
 * A roof over one block: two slopes, and at each end a gable, a hip, or - where it joins another
 * block - nothing, running on into that block's roof. `a` runs along the ridge, `c` across it.
 * Draws the gables' wall triangles; the slopes are returned, to be cut against the house's other
 * roofs before they are drawn.
 */
function roofBlock(
  b: ModelBuilder,
  a0: number,
  a1: number,
  c0: number,
  c1: number,
  alongX: boolean,
  start: RoofEnd,
  end: RoofEnd,
  eaves: number,
  slope: number,
  overhang: number,
  wall: Paint,
): BlockRoof {
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
  const outward = (sign: number): Vec3 => (alongX ? [sign, 0, 0] : [0, 0, sign]);
  for (const [endSpec, a, eaveA, ridgeA, sign] of [
    [start, a0, eaveA0, ridgeA0, -1],
    [end, a1, eaveA1, ridgeA1, 1],
  ] as const) {
    if (endSpec.kind === "hip") {
      face([P(eaveA, c0 - overhang, eaveLow), P(eaveA, c1 + overhang, eaveLow), P(ridgeA, middle, ridge)], [[0, 1]]);
    } else if (endSpec.kind === "gable") {
      // The wall's triangle up under the roof.
      b.faceToward([P(a, c0, eaves), P(a, c1, eaves), P(a, middle, ridge)], outward(sign), wall);
    }
  }
  const [x0, , z0] = P(eaveA0, c0 - overhang, 0);
  const [x1, , z1] = P(eaveA1, c1 + overhang, 0);
  return { faces, outline: { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) } };
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
  const { x0, x1, z0, z1 } = other.outline;
  const EPS = 1e-6;
  const tie = yields ? -1e-4 : EPS;
  const hidden: ((p: Point) => number)[] = [
    (p) => p[0] - x0 - EPS,
    (p) => x1 - p[0] - EPS,
    (p) => p[1] - z0 - EPS,
    (p) => z1 - p[1] - EPS,
    ...other.faces.map((f) => (p: Point) => heightOn(f.plane, p) - heightOn(face.plane, p) - tie),
  ];
  const pieces: RoofFace[] = [];
  let rest = face.polygon;
  for (const inside of hidden) {
    const outside = clipHalf(rest, (p) => -inside(p));
    if (outside.length >= 3 && area(outside) > 1e-4) pieces.push({ ...face, polygon: outside });
    rest = clipHalf(rest, inside);
    if (rest.length < 3) break;
  }
  return pieces;
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

/** A slope drawn as a slab `thickness` thick: its underside on its plane, its top lifted straight up
 *  by as much as makes it that thick across the slope, and its open edges closed. Its top is the
 *  roof's covering; its underside and edges are timber. */
function drawSlab(b: ModelBuilder, face: RoofFace, slope: number, thickness: number, top: Paint, timber: Paint): void {
  const lift = thickness * Math.sqrt(1 + slope * slope);
  const under = face.polygon.map((p): Vec3 => [p[0], heightOn(face.plane, p), p[1]]);
  const over = under.map(([x, y, z]): Vec3 => [x, y + lift, z]);
  // The covering on top; the boards under it run up the slope, and along its edges.
  b.faceToward(over, UP, top);
  b.faceToward(under, DOWN, timber);
  const cx = under.reduce((sum, v) => sum + v[0], 0) / under.length;
  const cz = under.reduce((sum, v) => sum + v[2], 0) / under.length;
  face.polygon.forEach((p, i) => {
    const j = (i + 1) % face.polygon.length;
    const q = face.polygon[j];
    if (!alongOpenEdge(face, p, q)) return;
    const away: Vec3 = [(p[0] + q[0]) / 2 - cx, 0, (p[1] + q[1]) / 2 - cz];
    b.faceToward([under[i], under[j], over[j], over[i]], away, timber, [q[0] - p[0], 0, q[1] - p[1]]);
  });
}

export function buildHouse(spec: HouseSpec, rng: () => number): BuildingModel {
  const b = new ModelBuilder();
  const tile = roll(spec.tile, rng);
  const { W, main, back, side } = planHouse(spec, rng);
  const blocks = [main, ...(back ? [back] : []), ...(side ? [side] : [])];
  const inside = (i: number, j: number): boolean => blocks.some((k) => i >= k.i0 && i < k.i1 && j >= k.j0 && j < k.j1);

  const wallHeight = roll(spec.wallHeight, rng);
  const plinth = roll(spec.plinth, rng);
  const outset = spec.plinthOutset;
  const post = roll(spec.post, rng);
  const eaves = plinth + wallHeight;
  const roofType = pick(spec.roofs, rng);
  const slope = Math.tan((roll(spec.pitch, rng) * Math.PI) / 180);
  const paint = (part: keyof HouseSpec["parts"]): Paint => ({ material: spec.parts[part].material, tint: pick(spec.parts[part].tints, rng) });
  const paints = {
    walls: paint("walls"),
    timber: paint("timber"),
    roof: paint("roof"),
    plinth: paint("plinth"),
    door: paint("door"),
    glass: paint("glass"),
  };

  // Tiles to metres, with the plan's bounding box centred on the origin.
  const iMin = Math.min(...blocks.map((k) => k.i0));
  const iMax = Math.max(...blocks.map((k) => k.i1));
  const jMin = Math.min(...blocks.map((k) => k.j0));
  const jMax = Math.max(...blocks.map((k) => k.j1));
  const X = (i: number): number => (i - (iMin + iMax) / 2) * tile;
  const Z = (j: number): number => (j - (jMin + jMax) / 2) * tile;

  const runs = wallRuns(inside, blocks);

  // Corners: where runs meet. An outer corner has one tile of the four around it inside, an inner
  // corner three.
  const cornerKind = (i: number, j: number): "outer" | "inner" => {
    const count = [inside(i - 1, j - 1), inside(i, j - 1), inside(i - 1, j), inside(i, j)].filter(Boolean).length;
    return count === 3 ? "inner" : "outer";
  };

  /** A run's frame: where a point `along` it (tiles) and `out` metres off its face is. */
  const frame = (run: WallRun) => {
    const alongX = run.dir === "pz" || run.dir === "nz";
    const sign = run.dir === "px" || run.dir === "pz" ? 1 : -1;
    const lineAt = alongX ? Z(run.line) : X(run.line);
    const normal: Vec3 = alongX ? [0, 0, sign] : [sign, 0, 0];
    const at = (along: number, out: number, y: number): Vec3 =>
      alongX ? [X(along), y, lineAt + sign * out] : [lineAt + sign * out, y, Z(along)];
    /** A box against the face: `along` metres either side of a point (tiles), standing out
     *  between `out0` and `out1` metres. */
    const box = (centre: number, halfAlong: number, y0: number, y1: number, out0: number, out1: number, color: Paint): void => {
      const [ax, , az] = at(centre, out0, 0);
      const [bx, , bz] = at(centre, out1, 0);
      if (alongX) {
        const x = X(centre);
        b.box(x - halfAlong, y0, Math.min(az, bz), x + halfAlong, y1, Math.max(az, bz), color);
      } else {
        const z = Z(centre);
        b.box(Math.min(ax, bx), y0, z - halfAlong, Math.max(ax, bx), y1, z + halfAlong, color);
      }
    };
    return { alongX, normal, at, box };
  };

  // 2. The plinth: standing out from the walls, from below ground to the floor, with a ledge on top.
  // 3. The corner posts - heavy, square, a beam's width either way of the corner. 4. The walls.
  const corners = new Set<string>();
  for (const run of runs) {
    const { alongX, normal, at } = frame(run);
    const startCorner = alongX ? cornerKind(run.from, run.line) : cornerKind(run.line, run.from);
    const endCorner = alongX ? cornerKind(run.to, run.line) : cornerKind(run.line, run.to);
    // Out at an outer corner, back at an inner one, so the plinths of two runs meet.
    const grow = (kind: "outer" | "inner"): number => (kind === "outer" ? outset : -outset) / tile;
    const p0 = run.from - grow(startCorner);
    const p1 = run.to + grow(endCorner);
    b.face([at(p0, outset, -FOUNDATION_DEPTH), at(p1, outset, -FOUNDATION_DEPTH), at(p1, outset, plinth), at(p0, outset, plinth)], normal, paints.plinth);
    b.faceToward([at(p0, outset, plinth), at(p1, outset, plinth), at(run.to, 0, plinth), at(run.from, 0, plinth)], UP, paints.plinth);
    b.face([at(run.from, 0, plinth), at(run.to, 0, plinth), at(run.to, 0, eaves), at(run.from, 0, eaves)], normal, paints.walls);
    for (const along of [run.from, run.to]) corners.add(alongX ? `${along},${run.line}` : `${run.line},${along}`);
  }
  for (const key of corners) {
    const [i, j] = key.split(",").map(Number);
    const h = post / 2;
    b.box(X(i) - h, plinth, Z(j) - h, X(i) + h, eaves, Z(j) + h, paints.timber);
  }

  // The door: in a middle bay of the main block's front.
  const doorBay = W >= 3 ? rollInt([1, W - 2], rng) : rollInt([0, W - 1], rng);
  const frontRun = runs.find((run) => run.dir === "pz" && run.line === main.j1 && run.from <= doorBay && run.to > doorBay)!;
  const door = spec.door;
  const doorTop = plinth + Math.min(door.height, wallHeight - 0.3 - door.frame);
  {
    const { box } = frame(frontRun);
    const centre = doorBay + 0.5;
    const half = Math.min(door.width, tile * 0.8) / 2;
    const f = door.frame;
    box(centre, half, plinth, doorTop, SET_IN, OUT.door, paints.door);
    // Jambs at the door's two edges, and a lintel over it reaching past them.
    box(centre - (half + f / 2) / tile, f / 2, plinth, doorTop + f, SET_IN, OUT.frame, paints.timber);
    box(centre + (half + f / 2) / tile, f / 2, plinth, doorTop + f, SET_IN, OUT.frame, paints.timber);
    box(centre, half + f * 1.25, doorTop, doorTop + f, SET_IN, OUT.lintel, paints.timber);
  }

  // Windows: any bay of any wall but the door's, with the window's own chance.
  const win = spec.window;
  const sill = plinth + win.sill;
  const head = Math.min(sill + win.height, eaves - 0.25 - win.frame);
  for (const run of runs) {
    const { box } = frame(run);
    for (let bay = run.from; bay < run.to; bay++) {
      if (run === frontRun && bay === doorBay) continue;
      if (rng() >= win.chance || head - sill < 0.4) continue;
      const centre = bay + 0.5;
      const half = Math.min(win.width, tile * 0.7) / 2;
      const f = win.frame;
      box(centre, half, sill, head, SET_IN, OUT.pane, paints.glass);
      // Frame, a cross of glazing bars, and a sill below, wider and standing further out.
      box(centre - (half + f / 2) / tile, f / 2, sill, head + f, SET_IN, OUT.frame, paints.timber);
      box(centre + (half + f / 2) / tile, f / 2, sill, head + f, SET_IN, OUT.frame, paints.timber);
      box(centre, half + f, head, head + f, SET_IN, OUT.frame, paints.timber);
      box(centre, f / 4, sill, head, SET_IN, OUT.bars, paints.timber);
      box(centre, half, (sill + head) / 2 - f / 4, (sill + head) / 2 + f / 4, SET_IN, OUT.bars, paints.timber);
      box(centre, half + f + win.sillReach, sill - f, sill, SET_IN, OUT.frame + win.sillReach, paints.timber);
    }
  }

  // 5-7. The roofs. The main block's ridge runs along the front; a wing's runs away from it, and
  // where it joins runs on into the main roof as far as its ridge could reach (its half span, at
  // one pitch). Then every block's slopes are cut where they pass under another block's roof - so
  // they end exactly along the valleys - and only then drawn. A main end with a wing at it is a
  // gable, overhanging the wing's roof like any other - where a side wing is flush with its front or
  // back and the two share a plane, the wing's gives way under it.
  const overhang = spec.overhang;
  const free = (): RoofEnd => ({ kind: roofType, overhang, extend: 0 });
  const backFlushLeft = back !== null && back.i0 === 0;
  const backFlushRight = back !== null && back.i1 === W;
  const mainEnd = (left: boolean): RoofEnd => {
    const wingHere = side !== null && side.left === left;
    const gable = wingHere || (left ? backFlushLeft : backFlushRight);
    return { kind: gable ? "gable" : roofType, overhang, extend: 0 };
  };
  const roofs: BlockRoof[] = [roofBlock(b, X(main.i0), X(main.i1), Z(main.j0), Z(main.j1), true, mainEnd(true), mainEnd(false), eaves, slope, overhang, paints.walls)];
  if (back) {
    const halfSpan = ((back.i1 - back.i0) * tile) / 2;
    roofs.push(roofBlock(b, Z(back.j0), Z(back.j1), X(back.i0), X(back.i1), false, free(), { kind: "attached", overhang: 0, extend: halfSpan }, eaves, slope, overhang, paints.walls));
  }
  if (side) {
    const attached: RoofEnd = { kind: "attached", overhang: 0, extend: 0 };
    roofs.push(roofBlock(b, X(side.i0), X(side.i1), Z(side.j0), Z(side.j1), true, side.left ? free() : attached, side.left ? attached : free(), eaves, slope, overhang, paints.walls));
  }
  roofs.forEach((roof, k) => {
    let faces = roof.faces;
    roofs.forEach((other, m) => {
      // A wing yields to the main block (the first roof) where their slopes share a plane.
      if (m !== k) faces = faces.flatMap((face) => cutUnder(face, other, m < k));
    });
    for (const face of faces) drawSlab(b, face, slope, spec.roofThickness, paints.roof, paints.timber);
  });

  const tiles: NonNullable<BuildingModel["tiles"]> = [];
  for (const block of blocks) {
    for (let i = block.i0; i < block.i1; i++) {
      for (let j = block.j0; j < block.j1; j++) tiles.push({ x0: X(i), z0: Z(j), x1: X(i + 1), z1: Z(j + 1) });
    }
  }
  return b.finish({ x: X(doorBay + 0.5), z: Z(main.j1) }, tiles);
}
