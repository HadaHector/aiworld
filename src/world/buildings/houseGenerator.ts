import type { BuildingModel, HouseSpec, Level, Paint, StoreyKind, WallSide } from "./buildingTypes";
import { FOUNDATION_DEPTH, ModelBuilder, pick, roll, rollInt, type Vec3 } from "./buildingGeometry";
import { buildFraming, buildRoof, buildSupport, buildTerrace, buildWallPart, isRoof, partSpan, pickPart, planFraming, planRoof, type FramingCorner, type FramingWall, type PartExtent, type PartPaints, type WallSlot } from "./buildingParts";
import type { RoofBlockInput, RoofEnd } from "./pitchedRoof";

/**
 * A traditional house, built in the order a house is: its plan (tiles), the plinth, the walls storey
 * by storey with their door, windows and the like, the framing over them, and the roofs and
 * terraces over its masses.
 *
 * The plan is a main block with its front to +z, and maybe a wing out of the back (a T or an L)
 * and one out of a side. Each block is a rectangle; the roof is handed all of them.
 *
 * The roof, the framing, the door and the wall's extras - windows, chimneys - are building parts
 * (see buildingParts.ts): the house picks them and where they go, and each builds itself there - a
 * door or a window closed, standing on the wall, never a hole.
 */

/** A block of the plan, in tiles: i along x, j along z (the front is the main block's +z side). */
interface Block {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

type Direction = "px" | "nx" | "pz" | "nz";

/** A straight run of outer wall along tile edges: on the line `line`, from `from` to `to` (tiles). */
interface WallRun {
  dir: Direction;
  line: number;
  from: number;
  to: number;
}

const UP: Vec3 = [0, 1, 0];
const DOWN: Vec3 = [0, -1, 0];

/** A level as the house builds it: also its place in the stack (cellars below 0), and how far its
 *  walls stand out where they are jettied. */
interface Storey {
  kind: StoreyKind;
  index: number;
  floor: number;
  top: number;
  jetty: number;
}

/** The plan: the main block and any wings, each wing with how its roof meets the main block's. */
function planHouse(spec: HouseSpec, rng: () => number) {
  const W = rollInt(spec.width, rng);
  const D = rollInt(spec.depth, rng);
  const main: Block = { i0: 0, i1: W, j0: 0, j1: D };
  let back: Block | null = null;
  let side: (Block & { left: boolean }) | null = null;

  // A wing's width, from the spec's range, held under the most its block allows. Where the block
  // allows less than the range's least, there is no wing at all rather than a sliver of one.
  const [widthMin, widthMax] = spec.wingWidth;
  const wingWidth = (most: number): number => rollInt([widthMin, Math.min(widthMax, most)], rng);
  // A wing out of the back: narrower than the main block's front, and no wider than it is deep, so
  // its ridge never stands above the main ridge.
  const backWidthMax = Math.min(W - 1, D);
  if (backWidthMax >= widthMin && rng() < spec.backWing) {
    const w = wingWidth(backWidthMax);
    const offset = pick([0, Math.floor((W - w) / 2), W - w], rng);
    back = { i0: offset, i1: offset + w, j0: -rollInt(spec.wingLength, rng), j1: 0 };
  }
  // A wing out of one side: shallower than the main block, so its ridge is lower.
  if (D - 1 >= widthMin && rng() < spec.sideWing) {
    const d = wingWidth(D - 1);
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

/** A mass of the house: a block of tiles standing from storey `from` up to (not including) `to`. */
interface Mass {
  rect: Block;
  from: number;
  to: number;
}

const inRect = (r: Block, i: number, j: number): boolean => i >= r.i0 && i < r.i1 && j >= r.j0 && j < r.j1;

/**
 * Builds a house - `far`, to be seen from afar: its parts leave out their small pieces, though every
 * roll is taken as near, so near and far are the same house.
 *
 * A house is a set of masses - blocks of tiles, each standing from one storey up to another - and
 * each storey's walls are the outline of the masses it has: a wing lower than the main block, a top
 * storey stood back from the front, a ground storey open under the ones over it. What tops a mass
 * the ones over it do not cover is a roof or a terrace; what a storey covers that the one under it
 * does not - an arcade, a jetty - has a ceiling, and an arcade supports along its open side.
 */
export function buildHouse(spec: HouseSpec, rng: () => number, far = false): BuildingModel {
  const b = new ModelBuilder();
  const tile = roll(spec.tile, rng);
  const { W, main, back, side } = planHouse(spec, rng);
  const blocks = [main, ...(back ? [back] : []), ...(side ? [side] : [])];
  // The plan: every tile the house stands on, open or not.
  const inside = (i: number, j: number): boolean => blocks.some((k) => inRect(k, i, j));

  const wallHeight = roll(spec.wallHeight, rng);
  const plinth = roll(spec.plinth, rng);
  const outset = spec.plinthOutset;
  const roofPlan = planRoof(spec.roof, rng);
  const { shape: roofType } = roofPlan;
  const paint = (part: keyof HouseSpec["parts"]): Paint => ({ material: spec.parts[part].material, tint: pick(spec.parts[part].tints, rng) });
  const paints: PartPaints = {
    walls: paint("walls"),
    timber: paint("timber"),
    stone: paint("stone"),
    roof: paint("roof"),
    plinth: paint("plinth"),
    door: paint("door"),
    glass: paint("glass"),
  };

  // The levels, cellars first: the cellars dug down from the ground floor, then the ground storey on
  // the plinth and the storeys over it, each jettied further out than the one below.
  const storeys = rollInt(spec.storeys, rng);
  const cellars = rollInt(spec.cellars, rng);
  const upperHeight = spec.upperHeight ? roll(spec.upperHeight, rng) : wallHeight;
  const cellarHeight = roll(spec.cellarHeight, rng);
  const levels: Storey[] = [];
  for (let k = cellars; k >= 1; k--) {
    const top = plinth - (k - 1) * cellarHeight;
    levels.push({ kind: "cellar", index: -k, floor: top - cellarHeight, top, jetty: 0 });
  }
  let floorAt = plinth;
  for (let k = 0; k < storeys; k++) {
    const height = k === 0 ? wallHeight : upperHeight;
    levels.push({ kind: k === 0 ? "ground" : "upper", index: k, floor: floorAt, top: floorAt + height, jetty: spec.jetty ? k * spec.jetty.out : 0 });
    floorAt += height;
  }
  const above = levels.filter((level) => level.kind !== "cellar");
  const ground = above[0];
  // The plinth's foot: below the deepest cellar's floor, or the foundation's depth.
  const footing = Math.min(-FOUNDATION_DEPTH, levels[0].floor - 0.3);

  // The masses. A wing may stand lower than the main block; the main block's front row of tiles may
  // be open on the ground storey (an arcade) and stand back on the top one (a setback).
  const wingStoreys = (): number => (spec.wingStoreys ? Math.min(storeys, rollInt(spec.wingStoreys, rng)) : storeys);
  const backStoreys = back ? wingStoreys() : 0;
  const sideStoreys = side ? wingStoreys() : 0;
  const deep = main.j1 - main.j0 >= 2;
  const arcade = spec.arcade !== null && storeys >= 2 && deep && rng() < spec.arcade.chance;
  const setback = spec.setback !== null && storeys >= (arcade ? 3 : 2) && deep && rng() < spec.setback.chance;
  const frontRow: Block = { i0: main.i0, i1: main.i1, j0: main.j1 - 1, j1: main.j1 };
  const rest: Block = { ...main, j1: main.j1 - 1 };
  const masses: Mass[] = [];
  if (arcade || setback) {
    masses.push({ rect: rest, from: 0, to: storeys });
    masses.push({ rect: frontRow, from: arcade ? 1 : 0, to: setback ? storeys - 1 : storeys });
  } else {
    masses.push({ rect: main, from: 0, to: storeys });
  }
  if (back) masses.push({ rect: back, from: 0, to: backStoreys });
  if (side) masses.push({ rect: side, from: 0, to: sideStoreys });
  const occupied = (i: number, j: number, k: number): boolean => masses.some((m) => m.from <= k && k < m.to && inRect(m.rect, i, j));

  // Tiles to metres, with the plan's bounding box centred on the origin.
  const iMin = Math.min(...blocks.map((k) => k.i0));
  const iMax = Math.max(...blocks.map((k) => k.i1));
  const jMin = Math.min(...blocks.map((k) => k.j0));
  const jMax = Math.max(...blocks.map((k) => k.j1));
  const X = (i: number): number => (i - (iMin + iMax) / 2) * tile;
  const Z = (j: number): number => (j - (jMin + jMax) / 2) * tile;

  /** A storey's walls - or, for a cellar, the plan's, in the plinth - and how its corners turn. */
  interface Outline {
    inside: (i: number, j: number) => boolean;
    runs: WallRun[];
    runsAt: Map<string, WallRun[]>;
  }
  const pointOf = (run: WallRun, along: number): [number, number] => (run.dir === "pz" || run.dir === "nz" ? [along, run.line] : [run.line, along]);
  const outlineOf = (insideOf: (i: number, j: number) => boolean, rects: Block[]): Outline => {
    const runs = wallRuns(insideOf, rects);
    const runsAt = new Map<string, WallRun[]>();
    for (const run of runs) {
      for (const along of [run.from, run.to]) {
        const key = pointOf(run, along).join(",");
        runsAt.set(key, [...(runsAt.get(key) ?? []), run]);
      }
    }
    return { inside: insideOf, runs, runsAt };
  };
  const planOutline = outlineOf(inside, blocks);
  const outlines = new Map<number, Outline>();
  for (const level of above) {
    const k = level.index;
    outlines.set(k, outlineOf((i, j) => occupied(i, j, k), masses.filter((m) => m.from <= k && k < m.to).map((m) => m.rect)));
  }
  const outlineAt = (level: Storey): Outline => (level.kind === "cellar" ? planOutline : outlines.get(level.index)!);

  // Corners: where runs meet. An outer corner has one tile of the four around it inside, an inner
  // corner three.
  const cornerKind = (outline: Outline, i: number, j: number): "outer" | "inner" => {
    const count = [outline.inside(i - 1, j - 1), outline.inside(i, j - 1), outline.inside(i - 1, j), outline.inside(i, j)].filter(Boolean).length;
    return count === 3 ? "inner" : "outer";
  };

  const wallOf = (run: WallRun): WallSide => (run.dir === "pz" ? "front" : run.dir === "nz" ? "back" : "side");
  const sideOf = (dir: Direction): WallSide => (dir === "pz" ? "front" : dir === "nz" ? "back" : "side");
  const jettied = (dir: Direction): boolean => spec.jetty !== null && spec.jetty.walls.includes(sideOf(dir));
  /** How far a run's wall stands out on a level: its storey's jetty, if its wall is jettied. */
  const offsetOf = (run: WallRun, level: Storey): number => (jettied(run.dir) ? level.jetty : 0);
  /** How far a run's wall reaches past its corner at one end on a level, to meet the other wall
   *  there where that one is jettied out: further at an outer corner, shorter at an inner one. */
  const reachPast = (run: WallRun, along: number, level: Storey): number => {
    if (level.kind === "cellar") return 0;
    const outline = outlineAt(level);
    const [i, j] = pointOf(run, along);
    const other = (outline.runsAt.get(`${i},${j}`) ?? []).find((r) => r !== run);
    if (!other) return 0;
    return (cornerKind(outline, i, j) === "outer" ? 1 : -1) * offsetOf(other, level);
  };

  /** A run's wall on a level: where it starts and ends (tiles, past its corners as it reaches), how
   *  far out it stands - a cellar's out at the plinth's face - and where a point `along` it (tiles)
   *  and `out` metres off its face is. */
  const wallAt = (run: WallRun, level: Storey) => {
    const alongX = run.dir === "pz" || run.dir === "nz";
    const sign = run.dir === "px" || run.dir === "pz" ? 1 : -1;
    const lineAt = alongX ? Z(run.line) : X(run.line);
    const normal: Vec3 = alongX ? [0, 0, sign] : [sign, 0, 0];
    const off = level.kind === "cellar" ? outset : offsetOf(run, level);
    const from = run.from - reachPast(run, run.from, level) / tile;
    const to = run.to + reachPast(run, run.to, level) / tile;
    const at = (along: number, out: number, y: number): Vec3 =>
      alongX ? [X(along), y, lineAt + sign * (out + off)] : [lineAt + sign * (out + off), y, Z(along)];
    return { alongX, sign, normal, off, from, to, at };
  };

  /** A mass's rectangle in metres, out to the faces of its walls on a storey (jettied, or not). */
  const rectOf = (r: Block, level: Storey) => {
    const grow = (dir: Direction): number => (jettied(dir) ? level.jetty : 0);
    return { x0: X(r.i0) - grow("nx"), x1: X(r.i1) + grow("px"), z0: Z(r.j0) - grow("nz"), z1: Z(r.j1) + grow("pz") };
  };

  // What tops each mass: those reaching the top storey share the house's roof; a lower wing has a
  // roof or a terrace of its own; a setback strip, a terrace.
  const topStorey = above[above.length - 1];
  const joined = (storeysOf: number): boolean => storeysOf === storeys;
  const overhang = roofPlan.overhang;
  const free = (): RoofEnd => ({ kind: roofType, overhang, extend: 0 });
  const backFlushLeft = back !== null && joined(backStoreys) && back.i0 === 0;
  const backFlushRight = back !== null && joined(backStoreys) && back.i1 === W;
  const mainEnd = (left: boolean): RoofEnd => {
    const wingHere = side !== null && joined(sideStoreys) && side.left === left;
    const gable = wingHere || (left ? backFlushLeft : backFlushRight);
    return { kind: gable ? "gable" : roofType, overhang, extend: 0 };
  };

  /** A roof over some blocks, from the top of a storey, and the gables on its walls. */
  interface RoofGroup {
    part: (typeof spec)["roof"];
    plan: typeof roofPlan;
    level: Storey;
    blocks: RoofBlockInput[];
    /** Each block's tiles, for the walls its gables stand on. */
    rects: Block[];
    gables: { dir: Direction; line: number; at: number; ridge: number }[];
  }
  const roofGroups: RoofGroup[] = [];
  const terraces: { part: (typeof spec)["roof"]; mass: Mass }[] = [];
  {
    const top = rectOf(setback ? rest : main, topStorey);
    const group: RoofGroup = { part: spec.roof, plan: roofPlan, level: topStorey, blocks: [], rects: [], gables: [] };
    group.blocks.push({ a0: top.x0, a1: top.x1, c0: top.z0, c1: top.z1, alongX: true, start: mainEnd(true), end: mainEnd(false) });
    group.rects.push(setback ? rest : main);
    if (back && joined(backStoreys)) {
      const r = rectOf(back, topStorey);
      group.blocks.push({ a0: r.z0, a1: Z(back.j1), c0: r.x0, c1: r.x1, alongX: false, start: free(), end: { kind: "attached", overhang: 0, extend: (r.x1 - r.x0) / 2 } });
      group.rects.push(back);
    }
    if (side && joined(sideStoreys)) {
      const r = rectOf(side, topStorey);
      const attached: RoofEnd = { kind: "attached", overhang: 0, extend: 0 };
      group.blocks.push({ a0: side.left ? r.x0 : X(side.i0), a1: side.left ? X(side.i1) : r.x1, c0: r.z0, c1: r.z1, alongX: true, start: side.left ? free() : attached, end: side.left ? attached : free() });
      group.rects.push(side);
    }
    roofGroups.push(group);
    if (setback) terraces.push({ part: pickPart(spec.setback!.terraces, rng)!, mass: masses[1] });
  }
  // A lower wing: its own roof, stopping at the taller block's wall, or a terrace.
  for (const [wing, storeysOf, isBack] of [[back, backStoreys, true], [side, sideStoreys, false]] as const) {
    if (!wing || joined(storeysOf)) continue;
    const mass = masses.find((m) => m.rect === wing)!;
    const part = pickPart(spec.lowTops, rng) ?? spec.roof;
    if (!isRoof(part)) {
      terraces.push({ part, mass });
      continue;
    }
    const level = above[storeysOf - 1];
    const plan = planRoof(part, rng);
    const wingFree: RoofEnd = { kind: plan.shape, overhang: plan.overhang, extend: 0 };
    const attached: RoofEnd = { kind: "attached", overhang: 0, extend: 0 };
    const r = rectOf(wing, level);
    const group: RoofGroup = { part, plan, level, blocks: [], rects: [wing], gables: [] };
    if (isBack) group.blocks.push({ a0: r.z0, a1: Z(wing.j1), c0: r.x0, c1: r.x1, alongX: false, start: wingFree, end: attached });
    else {
      const left = (wing as typeof side)!.left;
      group.blocks.push({ a0: left ? r.x0 : X(wing.i0), a1: left ? X(wing.i1) : r.x1, c0: r.z0, c1: r.z1, alongX: true, start: left ? wingFree : attached, end: left ? attached : wingFree });
    }
    roofGroups.push(group);
  }
  // Each roof's gables: a block end with one, as the wall it stands on, and its apex - where along
  // that wall (metres) and how high.
  for (const group of roofGroups) {
    const eaves = group.level.top;
    const gableOf = (k: RoofBlockInput, dir: Direction, line: number): void => {
      group.gables.push({ dir, line, at: (k.c0 + k.c1) / 2, ridge: eaves + ((k.c1 - k.c0) / 2) * group.plan.slope });
    };
    group.blocks.forEach((k, n) => {
      const rect = group.rects[n];
      for (const [end, atStart] of [[k.start, true], [k.end, false]] as const) {
        if (end.kind !== "gable") continue;
        // The wall the end stands on: the block's own end, in tiles.
        if (k.alongX) gableOf(k, atStart ? "nx" : "px", atStart ? rect.i0 : rect.i1);
        else gableOf(k, atStart ? "nz" : "pz", atStart ? rect.j0 : rect.j1);
      }
    });
  }

  // Every ridge, as a segment in plan and the height of its top (slab and ridge cap on it) - a hip
  // end stops it half a span short, a gable runs it out over the verge.
  const ridges = roofGroups.flatMap((group) => {
    const { slope: s } = group.plan;
    const onTop = group.plan.thickness * Math.sqrt(1 + s * s) + group.plan.ridgeHeight;
    return group.blocks.map((k) => {
      const half = (k.c1 - k.c0) / 2;
      const reach = (end: RoofEnd): number => (end.kind === "hip" ? -half : end.kind === "attached" ? end.extend : end.overhang);
      let s0 = k.a0 - reach(k.start);
      let s1 = k.a1 + reach(k.end);
      if (s0 > s1) s0 = s1 = (s0 + s1) / 2;
      const c = (k.c0 + k.c1) / 2;
      const [x0, z0, x1, z1] = k.alongX ? [s0, c, s1, c] : [c, s0, c, s1];
      return { x0, z0, x1, z1, height: group.level.top + half * s + onTop };
    });
  });
  /** How high a line falling at `angle` (degrees) from the nearest ridge reaches over a point. */
  const ridgeLine = (x: number, z: number, angle: number): number =>
    Math.max(
      ...ridges.map((r) => {
        const dx = r.x1 - r.x0;
        const dz = r.z1 - r.z0;
        const t = dx === 0 && dz === 0 ? 0 : Math.min(1, Math.max(0, ((x - r.x0) * dx + (z - r.z0) * dz) / (dx * dx + dz * dz)));
        const distance = Math.hypot(x - (r.x0 + dx * t), z - (r.z0 + dz * t));
        return r.height - distance * Math.tan((angle * Math.PI) / 180);
      }),
    );

  // Where a post goes along each run between its corners: wherever the block behind the wall - and
  // so the roof over it - changes.
  const blockAt = (i: number, j: number): number => blocks.findIndex((k) => inRect(k, i, j));
  const behind = (run: WallRun, along: number): number => {
    switch (run.dir) {
      case "pz":
        return blockAt(along, run.line - 1);
      case "nz":
        return blockAt(along, run.line);
      case "px":
        return blockAt(run.line - 1, along);
      case "nx":
        return blockAt(run.line, along);
    }
  };
  const breaks = (run: WallRun): number[] => {
    const out: number[] = [];
    for (let along = run.from + 1; along < run.to; along++) if (behind(run, along - 1) !== behind(run, along)) out.push(along);
    return out;
  };

  // The framing, settled before anything goes on the walls, so all of it keeps clear of its posts
  // and its top beams.
  const framing = planFraming(spec.framing, rng);

  /** The slot for a part `span` bays wide, its middle `centre` tiles along a run, on a level. Clear of
   *  the storey's top beam (or, in a cellar, of the ground floor), and of a post where it reaches one
   *  - at the run's end, or where the roof changes. */
  const slotAt = (run: WallRun, centre: number, span: number, level: Storey): WallSlot => {
    const wall = wallAt(run, level);
    const outline = outlineAt(level);
    const { alongX, sign, at } = wall;
    const atStart = centre - span / 2 <= run.from;
    const atEnd = atStart || centre + span / 2 >= run.to;
    const atPost = breaks(run).some((along) => Math.abs(along - (centre - span / 2)) < 1e-6 || Math.abs(along - (centre + span / 2)) < 1e-6);
    const startInner = cornerKind(outline, ...pointOf(run, run.from)) === "inner";
    const endInner = cornerKind(outline, ...pointOf(run, run.to)) === "inner";
    const point = ([a, y, out]: Vec3): Vec3 => {
      const [x, , z] = at(centre, out, y);
      return alongX ? [x + a, y, z] : [x, y, z + a];
    };
    return {
      storey: level.kind,
      floor: level.floor,
      top: level.kind === "cellar" ? plinth - 0.1 : level.top - framing.top - 0.25,
      ridgeLine: (a, out, angle) => {
        const [x, , z] = point([a, 0, out]);
        return ridgeLine(x, z, angle);
      },
      plinthOutset: outset - wall.off,
      halfRoom: (span * tile) / 2 - 0.05 - Math.max(atEnd ? framing.cornerReach : 0, atPost ? framing.postHalf : 0),
      wall: wallOf(run),
      far,
      innerCorner: (atStart && startInner) || (centre + span / 2 >= run.to && endInner),
      box: (a0, a1, y0, y1, out0, out1, paint) => {
        const [ax, , az] = at(centre, out0, 0);
        const [bx, , bz] = at(centre, out1, 0);
        if (alongX) b.box(ax + a0, y0, Math.min(az, bz), ax + a1, y1, Math.max(az, bz), paint);
        else b.box(Math.min(ax, bx), y0, az + a0, Math.max(ax, bx), y1, az + a1, paint);
      },
      face: (corners, [ta, ty, tout], paint) =>
        b.faceToward(corners.map(point), alongX ? [ta, ty, sign * tout] : [sign * tout, ty, ta], paint),
    };
  };

  // 2. The plinth, round the whole plan: standing out from the walls, from its footing to the ground
  // floor, with a ledge on top - and a floor of it where the ground storey is open over it.
  for (const run of planOutline.runs) {
    const base = wallAt(run, levels[0].kind === "cellar" ? levels[0] : ground);
    const alongX = run.dir === "pz" || run.dir === "nz";
    const sign = run.dir === "px" || run.dir === "pz" ? 1 : -1;
    const lineAt = alongX ? Z(run.line) : X(run.line);
    const at = (along: number, out: number, y: number): Vec3 => (alongX ? [X(along), y, lineAt + sign * out] : [lineAt + sign * out, y, Z(along)]);
    const startCorner = cornerKind(planOutline, ...pointOf(run, run.from));
    const endCorner = cornerKind(planOutline, ...pointOf(run, run.to));
    // Out at an outer corner, back at an inner one, so the plinths of two runs meet.
    const plinthGrow = (kind: "outer" | "inner"): number => (kind === "outer" ? outset : -outset) / tile;
    const p0 = run.from - plinthGrow(startCorner);
    const p1 = run.to + plinthGrow(endCorner);
    b.face([at(p0, outset, footing), at(p1, outset, footing), at(p1, outset, plinth), at(p0, outset, plinth)], base.normal, paints.plinth);
    b.faceToward([at(p0, outset, plinth), at(p1, outset, plinth), at(run.to, 0, plinth), at(run.from, 0, plinth)], UP, paints.plinth);
  }
  for (const block of blocks) {
    for (let i = block.i0; i < block.i1; i++) {
      for (let j = block.j0; j < block.j1; j++) {
        if (occupied(i, j, 0)) continue;
        b.faceToward([[X(i), plinth, Z(j)], [X(i + 1), plinth, Z(j)], [X(i + 1), plinth, Z(j + 1)], [X(i), plinth, Z(j + 1)]], UP, paints.plinth);
      }
    }
  }

  // 3. The walls, storey by storey.
  for (const level of above) {
    for (const run of outlineAt(level).runs) {
      const wall = wallAt(run, level);
      b.face([wall.at(wall.from, 0, level.floor), wall.at(wall.to, 0, level.floor), wall.at(wall.to, 0, level.top), wall.at(wall.from, 0, level.top)], wall.normal, paints.walls);
    }
  }

  // Ceilings: wherever a storey covers ground the one under it does not - an arcade, the overhang of a
  // jetty - its underside is closed, at its floor. Found on a grid of every edge of either storey.
  const coversAt = (level: Storey, x: number, z: number): boolean =>
    masses.some((m) => m.from <= level.index && level.index < m.to && (({ x0, x1, z0, z1 }) => x > x0 && x < x1 && z > z0 && z < z1)(rectOf(m.rect, level)));
  for (let k = 1; k < above.length; k++) {
    const level = above[k];
    const under = above[k - 1];
    const xs = new Set<number>();
    const zs = new Set<number>();
    for (const m of masses) {
      for (const l of [level, under]) {
        const r = rectOf(m.rect, l);
        xs.add(r.x0).add(r.x1);
        zs.add(r.z0).add(r.z1);
      }
    }
    const xList = [...xs].sort((p, q) => p - q);
    const zList = [...zs].sort((p, q) => p - q);
    for (let xi = 0; xi + 1 < xList.length; xi++) {
      for (let zi = 0; zi + 1 < zList.length; zi++) {
        const [x0, x1, z0, z1] = [xList[xi], xList[xi + 1], zList[zi], zList[zi + 1]];
        if (x1 - x0 < 1e-4 || z1 - z0 < 1e-4) continue;
        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;
        if (!coversAt(level, cx, cz) || coversAt(under, cx, cz)) continue;
        const y = level.floor;
        b.faceToward([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], DOWN, paints.timber);
      }
    }
  }

  // Supports: along the first storey's walls wherever the ground under them is open - an arcade's
  // front - at every bay's edge and its corners, each standing on the plinth and carrying the beam.
  if (arcade && above.length > 1) {
    const level = above[1];
    const outline = outlineAt(level);
    const half = (spec.arcade!.support.support?.width ?? 0.4) / 2;
    const placed = new Set<string>();
    for (const run of outline.runs) {
      const wall = wallAt(run, level);
      const innerTile = (along: number): [number, number] => {
        switch (run.dir) {
          case "pz":
            return [along, run.line - 1];
          case "nz":
            return [along, run.line];
          case "px":
            return [run.line - 1, along];
          case "nx":
            return [run.line, along];
        }
      };
      const openBelow = (along: number): boolean => {
        const [i, j] = innerTile(along);
        return along >= run.from && along < run.to && outline.inside(i, j) && !occupied(i, j, 0);
      };
      for (let along = run.from; along <= run.to; along++) {
        if (!openBelow(along - 1) && !openBelow(along)) continue;
        // At its ends, in from the corner both ways, so the two runs there put it in one place.
        const a = along === run.from ? wall.from + half / tile : along === run.to ? wall.to - half / tile : along;
        const [x, , z] = wall.at(a, -half, 0);
        const key = `${x.toFixed(2)},${z.toFixed(2)}`;
        if (placed.has(key)) continue;
        placed.add(key);
        buildSupport(spec.arcade!.support, { x, z, floor: plinth, top: level.floor, far, box: (x0, y0, z0, x1, y1, z1, p) => b.box(x0, y0, z0, x1, y1, z1, p) }, paints);
      }
    }
  }

  // Which bays of each wall line, on each level, parts have taken, as [from, to) - and the stretches
  // of its foot (metres from where the wall starts) the parts there stand in.
  const keyOf = (run: WallRun, level: Storey): string => `${run.dir}:${run.line}:${level.index}`;
  const taken = new Map<string, [number, number][]>();
  const footGaps = new Map<string, [number, number][]>();
  const add = (map: Map<string, [number, number][]>, key: string, range: [number, number]): void => {
    map.set(key, [...(map.get(key) ?? []), range]);
  };
  /** A part built at `centre` of a run, on a level: its bays taken on every level it rises through,
   *  and its foot standing in the foot beam of every one whose floor it stands on or below. */
  const place = (run: WallRun, level: Storey, centre: number, span: number, extent: PartExtent): void => {
    for (const other of levels) {
      const overlaps = other === level || (other.floor < extent.top && other.top > extent.foot);
      if (!overlaps) continue;
      add(taken, keyOf(run, other), [centre - span / 2, centre + span / 2]);
      if (other.kind === "cellar" || extent.foot > other.floor + 0.5) continue;
      const there = outlineAt(other).runs.find((r) => r.dir === run.dir && r.line === run.line && r.from <= centre && r.to >= centre);
      if (!there) continue;
      const at = (centre - wallAt(there, other).from) * tile;
      add(footGaps, keyOf(there, other), [at - extent.half, at + extent.half]);
    }
  };
  const isFree = (run: WallRun, level: Storey, from: number, to: number): boolean => (taken.get(keyOf(run, level)) ?? []).every(([a, z]) => to <= a || from >= z);

  // The door: one of the house's doors that fits the front, in a middle bay of it (bays, for a
  // big door) where there are bays to spare either side - on the ground storey's front wall, at the
  // back of an arcade where there is one.
  const doorPart = pickPart(spec.doors.filter((choice) => partSpan(choice.part) <= W), rng);
  const doorSpan = doorPart ? partSpan(doorPart) : 1;
  const doorBay = W >= doorSpan + 2 ? rollInt([1, W - 1 - doorSpan], rng) : rollInt([0, W - doorSpan], rng);
  const doorCentre = doorBay + doorSpan / 2;
  const frontRun = outlineAt(ground)
    .runs.filter((run) => run.dir === "pz" && run.from <= doorBay && run.to >= doorBay + doorSpan && run.line <= main.j1 && run.line > main.j0)
    .sort((p, q) => q.line - p.line)[0];
  if (frontRun) add(taken, keyOf(frontRun, ground), [doorBay, doorBay + doorSpan]);
  if (doorPart && frontRun) {
    const extent = buildWallPart(doorPart, slotAt(frontRun, doorCentre, doorSpan, ground), paints, rng);
    if (extent) place(frontRun, ground, doorCentre, doorSpan, extent);
  }

  // The wall's extras, highest priority first: each tries every free spot of the walls and storeys
  // it may go on, in a random order, taking each with its chance, until it has as many as it may.
  const extras = spec.wallExtras.map((extra, order) => ({ extra, order })).sort((p, q) => q.extra.priority - p.extra.priority || p.order - q.order);
  for (const { extra } of extras) {
    const span = partSpan(extra.part);
    const spots: { run: WallRun; level: Storey; bay: number }[] = [];
    for (const level of levels) {
      if (!extra.storeys.includes(level.kind)) continue;
      for (const run of outlineAt(level).runs) {
        if (!extra.walls.includes(wallOf(run))) continue;
        for (let bay = run.from; bay + span <= run.to; bay++) spots.push({ run, level, bay });
      }
    }
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    let count = 0;
    for (const { run, level, bay } of spots) {
      if (extra.maxCount !== null && count >= extra.maxCount) break;
      if (!isFree(run, level, bay, bay + span) || rng() >= extra.chance) continue;
      const extent = buildWallPart(extra.part, slotAt(run, bay + span / 2, span, level), paints, rng);
      if (!extent) continue;
      place(run, level, bay + span / 2, span, extent);
      count++;
    }
  }

  // 4. The framing over the walls: every storey's walls, their posts and - under a roof's gable - its
  // gable, and every corner on every storey.
  const gableOn = (run: WallRun, level: Storey) => {
    for (const group of roofGroups) {
      if (group.level !== level) continue;
      const gable = group.gables.find((g) => g.dir === run.dir && g.line === run.line);
      if (gable) return gable;
    }
    return undefined;
  };
  const framingWalls: FramingWall[] = [];
  const framingCorners: FramingCorner[] = [];
  /** The storey over a level's - none over the top one. */
  const over = (level: Storey): Outline | null => (level.index + 1 < above.length ? outlineAt(above[level.index + 1]) : null);
  for (const level of above) {
    const outline = outlineAt(level);
    const next = over(level);
    // A wall, or a corner, is at the top of its stack - under eaves, or a terrace's edge - where the
    // storey over it has none in its place.
    const wallUnder = (run: WallRun): boolean => next !== null && next.runs.some((r) => r.dir === run.dir && r.line === run.line && r.from < run.to && r.to > run.from);
    for (const run of outline.runs) {
      const wall = wallAt(run, level);
      const { alongX, at } = wall;
      const startAt = alongX ? at(wall.from, 0, 0)[0] : at(wall.from, 0, 0)[2];
      const length = (wall.to - wall.from) * tile;
      const gable = gableOn(run, level);
      const gableAt = gable ? gable.at - startAt : -1;
      framingWalls.push({
        floor: level.floor,
        top: level.top,
        topStorey: !wallUnder(run),
        length,
        posts: breaks(run).filter((along) => along > run.from && along < run.to).map((along) => (along - wall.from) * tile),
        gable: gable && gableAt > 0 && gableAt < length ? { at: gableAt, ridge: gable.ridge } : null,
        gaps: footGaps.get(keyOf(run, level)) ?? [],
        box: (a0, a1, y0, y1, out0, out1, paint) => {
          const [ax, , az] = at(wall.from, out0, 0);
          const [bx, , bz] = at(wall.from, out1, 0);
          if (alongX) b.box(ax + a0, y0, Math.min(az, bz), ax + a1, y1, Math.max(az, bz), paint);
          else b.box(Math.min(ax, bx), y0, az + a0, Math.max(ax, bx), y1, az + a1, paint);
        },
      });
    }
    const corners = new Set<string>();
    for (const run of outline.runs) for (const along of [run.from, run.to]) corners.add(pointOf(run, along).join(","));
    for (const key of corners) {
      const [i, j] = key.split(",").map(Number);
      // u and v run along x and z, toward the house at an outer corner (the one tile of the four
      // around it that is inside), away from the outside at an inner one (the one that is not).
      const kind = cornerKind(outline, i, j);
      const quadrant = [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]].find(([ti, tj]) => outline.inside(ti, tj) === (kind === "outer"))!;
      const flip = kind === "outer" ? 1 : -1;
      const su = (quadrant[0] === i ? 1 : -1) * flip;
      const sv = (quadrant[1] === j ? 1 : -1) * flip;
      // On a jettied storey the corner moves out with its walls: the wall along x (facing z) carries
      // it in z, the wall along z in x.
      let cx = X(i);
      let cz = Z(j);
      for (const run of outline.runsAt.get(key) ?? []) {
        const off = offsetOf(run, level) * (run.dir === "px" || run.dir === "pz" ? 1 : -1);
        if (run.dir === "pz" || run.dir === "nz") cz += off;
        else cx += off;
      }
      framingCorners.push({
        kind,
        floor: level.floor,
        top: level.top,
        topStorey: next === null || !next.runsAt.has(key),
        box: (u0, u1, v0, v1, y0, y1, paint) => {
          const xa = cx + su * u0;
          const xb = cx + su * u1;
          const za = cz + sv * v0;
          const zb = cz + sv * v1;
          b.box(Math.min(xa, xb), y0, Math.min(za, zb), Math.max(xa, xb), y1, Math.max(za, zb), paint);
        },
      });
    }
  }
  buildFraming(spec.framing, framing, { floor: plinth, eaves: topStorey.top, far, walls: framingWalls, corners: framingCorners }, paints);

  // 5-7. The roofs, each over its blocks from the top of its storey.
  for (const group of roofGroups) buildRoof(group.part, group.plan, { b, eaves: group.level.top, blocks: group.blocks, far }, paints);

  // And the terraces: on top of a mass the storeys over it do not cover, its sides open but where a
  // wall rises over them.
  for (const { part, mass } of terraces) {
    const level = above[mass.to - 1];
    const overLevel = mass.to;
    const r = mass.rect;
    const openAlong = (tiles: [number, number][]): boolean => tiles.some(([i, j]) => !occupied(i, j, overLevel));
    const range = (a: number, z: number): number[] => Array.from({ length: z - a }, (_, k) => a + k);
    buildTerrace(
      part,
      {
        rect: rectOf(r, level),
        y: level.top,
        open: {
          nx: openAlong(range(r.j0, r.j1).map((j): [number, number] => [r.i0 - 1, j])),
          px: openAlong(range(r.j0, r.j1).map((j): [number, number] => [r.i1, j])),
          nz: openAlong(range(r.i0, r.i1).map((i): [number, number] => [i, r.j0 - 1])),
          pz: openAlong(range(r.i0, r.i1).map((i): [number, number] => [i, r.j1])),
        },
        far,
        box: (x0, y0, z0, x1, y1, z1, p) => b.box(x0, y0, z0, x1, y1, z1, p),
        floor: (corners, p) => b.faceToward(corners, UP, p),
      },
      paints,
    );
  }

  const tiles: NonNullable<BuildingModel["tiles"]> = [];
  for (const block of blocks) {
    for (let i = block.i0; i < block.i1; i++) {
      for (let j = block.j0; j < block.j1; j++) tiles.push({ x0: X(i), z0: Z(j), x1: X(i + 1), z1: Z(j + 1) });
    }
  }
  const model = b.finish({ x: X(doorCentre), z: Z(main.j1) }, tiles);
  model.levels = levels.map(({ kind, floor, top }): Level => ({ kind, floor, top }));
  return model;
}
