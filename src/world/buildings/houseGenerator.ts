import type { BuildingModel, HouseSpec, Paint, WallSide } from "./buildingTypes";
import { FOUNDATION_DEPTH, ModelBuilder, pick, roll, rollInt, type Vec3 } from "./buildingGeometry";
import { buildFraming, buildRoof, buildWallPart, partSpan, pickPart, planFraming, planRoof, type FramingCorner, type FramingWall, type PartExtent, type PartPaints, type WallSlot } from "./buildingParts";
import type { RoofBlockInput, RoofEnd } from "./pitchedRoof";

/**
 * A traditional one-storey house, built in the order a house is: its plan (tiles), the plinth, the
 * walls with their door, windows and the like, the framing over them, and a roof over each block of
 * the plan.
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

export function buildHouse(spec: HouseSpec, rng: () => number): BuildingModel {
  const b = new ModelBuilder();
  const tile = roll(spec.tile, rng);
  const { W, main, back, side } = planHouse(spec, rng);
  const blocks = [main, ...(back ? [back] : []), ...(side ? [side] : [])];
  const inside = (i: number, j: number): boolean => blocks.some((k) => i >= k.i0 && i < k.i1 && j >= k.j0 && j < k.j1);

  const wallHeight = roll(spec.wallHeight, rng);
  const plinth = roll(spec.plinth, rng);
  const outset = spec.plinthOutset;
  const eaves = plinth + wallHeight;
  const roofPlan = planRoof(spec.roof, rng);
  const { slope, shape: roofType } = roofPlan;
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
    return { alongX, normal, at };
  };

  // How each block's roof ends. The main block's ridge runs along the front, a wing's away from it.
  // A main end with a wing at it is a gable, overhanging the wing's roof like any other.
  const overhang = roofPlan.overhang;
  const free = (): RoofEnd => ({ kind: roofType, overhang, extend: 0 });
  const backFlushLeft = back !== null && back.i0 === 0;
  const backFlushRight = back !== null && back.i1 === W;
  const mainEnd = (left: boolean): RoofEnd => {
    const wingHere = side !== null && side.left === left;
    const gable = wingHere || (left ? backFlushLeft : backFlushRight);
    return { kind: gable ? "gable" : roofType, overhang, extend: 0 };
  };

  // The gables: each block end with one, as the wall it stands on (its direction and line), and its
  // apex - along that wall, in tiles, and how high.
  const gables: { dir: Direction; line: number; at: number; ridge: number }[] = [];
  const apex = (span: number): number => eaves + (span * tile * slope) / 2;
  if (mainEnd(true).kind === "gable") gables.push({ dir: "nx", line: main.i0, at: (main.j0 + main.j1) / 2, ridge: apex(main.j1 - main.j0) });
  if (mainEnd(false).kind === "gable") gables.push({ dir: "px", line: main.i1, at: (main.j0 + main.j1) / 2, ridge: apex(main.j1 - main.j0) });
  if (back && roofType === "gable") gables.push({ dir: "nz", line: back.j0, at: (back.i0 + back.i1) / 2, ridge: apex(back.i1 - back.i0) });
  if (side && roofType === "gable") {
    gables.push({ dir: side.left ? "nx" : "px", line: side.left ? side.i0 : side.i1, at: (side.j0 + side.j1) / 2, ridge: apex(side.j1 - side.j0) });
  }

  // The roof's blocks, the main one first. The main block's ridge runs along the front, a wing's
  // away from it; a wing's roof, where it joins, runs on into the main roof as far as its ridge could
  // reach (its half span, at one pitch).
  const roofBlocks: RoofBlockInput[] = [{ a0: X(main.i0), a1: X(main.i1), c0: Z(main.j0), c1: Z(main.j1), alongX: true, start: mainEnd(true), end: mainEnd(false) }];
  if (back) {
    const halfSpan = ((back.i1 - back.i0) * tile) / 2;
    roofBlocks.push({ a0: Z(back.j0), a1: Z(back.j1), c0: X(back.i0), c1: X(back.i1), alongX: false, start: free(), end: { kind: "attached", overhang: 0, extend: halfSpan } });
  }
  if (side) {
    const attached: RoofEnd = { kind: "attached", overhang: 0, extend: 0 };
    roofBlocks.push({ a0: X(side.i0), a1: X(side.i1), c0: Z(side.j0), c1: Z(side.j1), alongX: true, start: side.left ? free() : attached, end: side.left ? attached : free() });
  }

  // Every ridge, as a segment in plan and the height of its top (slab and ridge cap on it) - a hip
  // end stops it half a span short, a gable runs it out over the verge.
  const onTop = roofPlan.thickness * Math.sqrt(1 + slope * slope) + roofPlan.ridgeHeight;
  const ridges = roofBlocks.map((k) => {
    const half = (k.c1 - k.c0) / 2;
    const reach = (end: RoofEnd): number => (end.kind === "hip" ? -half : end.kind === "attached" ? end.extend : end.overhang);
    let s0 = k.a0 - reach(k.start);
    let s1 = k.a1 + reach(k.end);
    if (s0 > s1) s0 = s1 = (s0 + s1) / 2;
    const c = (k.c0 + k.c1) / 2;
    const [x0, z0, x1, z1] = k.alongX ? [s0, c, s1, c] : [c, s0, c, s1];
    return { x0, z0, x1, z1, height: eaves + half * slope + onTop };
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
  const blockAt = (i: number, j: number): number => blocks.findIndex((k) => i >= k.i0 && i < k.i1 && j >= k.j0 && j < k.j1);
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
  // and its top beam.
  const framing = planFraming(spec.framing, rng);

  const wallOf = (run: WallRun): WallSide => (run.dir === "pz" ? "front" : run.dir === "nz" ? "back" : "side");
  /** Whether a run starts and ends at an inner corner. */
  const innerEnds = (run: WallRun): [boolean, boolean] => {
    const alongX = run.dir === "pz" || run.dir === "nz";
    const kind = (along: number) => (alongX ? cornerKind(along, run.line) : cornerKind(run.line, along));
    return [kind(run.from) === "inner", kind(run.to) === "inner"];
  };

  /** The slot for a part `span` bays wide, its middle `centre` tiles along a run. Clear of the
   *  eaves and the framing's top beam, and of a post where it reaches one - at the run's end, or
   *  where the roof changes. */
  const slotAt = (run: WallRun, centre: number, span: number): WallSlot => {
    const { alongX, at } = frame(run);
    const sign = run.dir === "px" || run.dir === "pz" ? 1 : -1;
    const atStart = centre - span / 2 <= run.from;
    const atEnd = atStart || centre + span / 2 >= run.to;
    const atPost = breaks(run).some((along) => Math.abs(along - (centre - span / 2)) < 1e-6 || Math.abs(along - (centre + span / 2)) < 1e-6);
    const [startInner, endInner] = innerEnds(run);
    const point = ([a, y, out]: Vec3): Vec3 => {
      const [x, , z] = at(centre, out, y);
      return alongX ? [x + a, y, z] : [x, y, z + a];
    };
    return {
      floor: plinth,
      top: eaves - framing.top - 0.25,
      ridgeLine: (a, out, angle) => {
        const [x, , z] = point([a, 0, out]);
        return ridgeLine(x, z, angle);
      },
      plinthOutset: outset,
      halfRoom: (span * tile) / 2 - 0.05 - Math.max(atEnd ? framing.cornerReach : 0, atPost ? framing.postHalf : 0),
      wall: wallOf(run),
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

  // 2. The plinth: standing out from the walls, from below ground to the floor, with a ledge on top.
  // 3. The walls.
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

  // The door: one of the house's doors that fits the front, in a middle bay of it (bays, for a
  // big door) where there are bays to spare either side.
  const doorPart = pickPart(spec.doors.filter((choice) => partSpan(choice.part) <= W), rng);
  const doorSpan = doorPart ? partSpan(doorPart) : 1;
  const doorBay = W >= doorSpan + 2 ? rollInt([1, W - 1 - doorSpan], rng) : rollInt([0, W - doorSpan], rng);
  const doorCentre = doorBay + doorSpan / 2;
  const frontRun = runs.find((run) => run.dir === "pz" && run.line === main.j1 && run.from <= doorBay && run.to >= doorBay + doorSpan)!;
  /** The bays each run has given to a part so far, as [from, to), and the stretches of its foot
   *  (metres from its start) the parts there stand in. */
  const taken = new Map<WallRun, [number, number][]>([[frontRun, [[doorBay, doorBay + doorSpan]]]]);
  const take = (run: WallRun, from: number, to: number): void => {
    taken.set(run, [...(taken.get(run) ?? []), [from, to]]);
  };
  const footGaps = new Map<WallRun, [number, number][]>();
  const place = (run: WallRun, centre: number, extent: PartExtent | null): void => {
    if (!extent || extent.foot > plinth + 0.5) return;
    const at = (centre - run.from) * tile;
    footGaps.set(run, [...(footGaps.get(run) ?? []), [at - extent.half, at + extent.half]]);
  };
  if (doorPart) place(frontRun, doorCentre, buildWallPart(doorPart, slotAt(frontRun, doorCentre, doorSpan), paints, rng));

  // The wall's extras, highest priority first: each tries every free spot of the walls it may go
  // on, in a random order, taking each with its chance, until it has as many as it may.
  const extras = spec.wallExtras.map((extra, order) => ({ extra, order })).sort((a, b) => b.extra.priority - a.extra.priority || a.order - b.order);
  const isFree = (run: WallRun, from: number, to: number): boolean => (taken.get(run) ?? []).every(([a, z]) => to <= a || from >= z);
  for (const { extra } of extras) {
    const span = partSpan(extra.part);
    const spots: { run: WallRun; bay: number }[] = [];
    for (const run of runs) {
      if (!extra.walls.includes(wallOf(run))) continue;
      for (let bay = run.from; bay + span <= run.to; bay++) spots.push({ run, bay });
    }
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    let count = 0;
    for (const { run, bay } of spots) {
      if (extra.maxCount !== null && count >= extra.maxCount) break;
      if (!isFree(run, bay, bay + span) || rng() >= extra.chance) continue;
      const extent = buildWallPart(extra.part, slotAt(run, bay + span / 2, span), paints, rng);
      if (!extent) continue;
      place(run, bay + span / 2, extent);
      take(run, bay, bay + span);
      count++;
    }
  }

  // 4. The framing over the walls: every run, its posts and its gable, and every corner.
  const framingWalls = runs.map((run): FramingWall => {
    const { alongX, at } = frame(run);
    const gable = gables.find((g) => g.dir === run.dir && g.line === run.line && g.at > run.from && g.at < run.to);
    return {
      length: (run.to - run.from) * tile,
      posts: breaks(run).map((along) => (along - run.from) * tile),
      gable: gable ? { at: (gable.at - run.from) * tile, ridge: gable.ridge } : null,
      gaps: footGaps.get(run) ?? [],
      box: (a0, a1, y0, y1, out0, out1, paint) => {
        const [ax, , az] = at(run.from, out0, 0);
        const [bx, , bz] = at(run.from, out1, 0);
        if (alongX) b.box(ax + a0, y0, Math.min(az, bz), ax + a1, y1, Math.max(az, bz), paint);
        else b.box(Math.min(ax, bx), y0, az + a0, Math.max(ax, bx), y1, az + a1, paint);
      },
    };
  });
  buildFraming(
    spec.framing,
    framing,
    {
      floor: plinth,
      eaves,
      walls: framingWalls,
      corners: [...corners].map((key): FramingCorner => {
        const [i, j] = key.split(",").map(Number);
        // u and v run along x and z, toward the house at an outer corner (the one tile of the four
        // around it that is inside), away from the outside at an inner one (the one that is not).
        const kind = cornerKind(i, j);
        const quadrant = [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]].find(([ti, tj]) => inside(ti, tj) === (kind === "outer"))!;
        const flip = kind === "outer" ? 1 : -1;
        const su = (quadrant[0] === i ? 1 : -1) * flip;
        const sv = (quadrant[1] === j ? 1 : -1) * flip;
        return {
          kind,
          box: (u0, u1, v0, v1, y0, y1, paint) => {
            const xa = X(i) + su * u0;
            const xb = X(i) + su * u1;
            const za = Z(j) + sv * v0;
            const zb = Z(j) + sv * v1;
            b.box(Math.min(xa, xb), y0, Math.min(za, zb), Math.max(xa, xb), y1, Math.max(za, zb), paint);
          },
        };
      }),
    },
    paints,
  );

  // 5-7. The roof, over every block (laid out above).
  buildRoof(spec.roof, roofPlan, { b, eaves, blocks: roofBlocks }, paints);

  const tiles: NonNullable<BuildingModel["tiles"]> = [];
  for (const block of blocks) {
    for (let i = block.i0; i < block.i1; i++) {
      for (let j = block.j0; j < block.j1; j++) tiles.push({ x0: X(i), z0: Z(j), x1: X(i + 1), z1: Z(j + 1) });
    }
  }
  return b.finish({ x: X(doorCentre), z: Z(main.j1) }, tiles);
}
