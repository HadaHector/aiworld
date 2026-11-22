import type { PropContext, PropGenerator } from "../propGenerator";
import { ORIGIN, between, distance, moved, turned } from "../propShapes";
import type { Vec3 } from "../../buildings/buildingGeometry";
import type { Paint } from "../../buildings/buildingTypes";

/**
 * A mine's things (DUNGEONS.md, *The mine*): timber supports, rails, a cart, picks and shovels, ore,
 * a windlass. Drawn about twice life size like the other props, so they read from afar: posts as
 * thick as a man's body, rails as wide as a hand. Each stands on y 0 with its front toward +z; a
 * piece for the wall has its back at z 0 (set against the rock), a piece laid along a way runs
 * along z.
 */

const slab = (ctx: PropContext, c: Vec3, half: Vec3, paint: Paint, options: { collide?: boolean; bottom?: boolean; top?: Paint; taper?: [number, number]; bevel?: number } = {}): void =>
  ctx.shape.box(moved(ORIGIN, c), half, paint, options);

/** Rail height over the sleepers' foot, and the gauge between rail centres. */
const RAIL_TOP = 0.28;
const GAUGE = 1.6;

/** Sleepers and a pair of iron rails along z, from `z0` to `z1`: the track under a cart or laid alone. */
function track(ctx: PropContext, z0: number, z1: number): void {
  const wood = ctx.paint("timber");
  const iron = ctx.paint("iron");
  const length = z1 - z0;
  const count = Math.max(2, Math.round(length / 0.85));
  for (let i = 0; i < count; i++) {
    const z = z0 + (length * (i + 0.5)) / count;
    slab(ctx, [0, 0.08, z], [GAUGE / 2 + 0.4, 0.08, 0.17], wood, { bottom: false, bevel: 0.025 });
  }
  for (const side of [-1, 1]) ctx.shape.beam(ORIGIN, [side * GAUGE / 2, RAIL_TOP - 0.1, z0], [side * GAUGE / 2, RAIL_TOP - 0.1, z1], 0.17, 0.2, iron, { up: [0, 1, 0] });
}

/** A hull standing for a heap or a boulder: a ring of points at the foot, a smaller ring on top. */
function heapHull(ctx: PropContext, radius: number, height: number): void {
  const points: Vec3[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    points.push([Math.sin(a) * radius, 0, Math.cos(a) * radius], [Math.sin(a) * radius * 0.45, height, Math.cos(a) * radius * 0.45]);
  }
  ctx.shape.solid(points);
}

/** A lump: a bevelled box turned any way, a chunk of rock or ore. */
function lump(ctx: PropContext, at: Vec3, size: number, paint: Paint): void {
  const { rng } = ctx;
  const f = turned(turned(turned(moved(ORIGIN, at), "y", rng() * Math.PI * 2), "x", (rng() - 0.5) * 1.2), "z", (rng() - 0.5) * 1.2);
  ctx.shape.box(f, [size * (0.7 + rng() * 0.4), size * (0.55 + rng() * 0.35), size * (0.7 + rng() * 0.4)], paint, { bevel: size * 0.3 });
}

/**
 * A timber set: two posts and a cap across the way, boards laid over the cap along it, a knee brace
 * either side. Stands across a tunnel or chamber; its width is the gap it fits.
 */
export const timberFrame: PropGenerator = {
  doc: "A post-and-lintel timber set across a way: two posts, a cap, boards over it, knee braces.",
  params: {
    width: { kind: "range", default: [3.4, 4.6], min: 1.5, doc: "between its posts" },
    height: { kind: "range", default: [3.4, 4.0], min: 2, doc: "the posts' height, to the cap's underside" },
    thickness: { kind: "range", default: [0.34, 0.44], min: 0.1, doc: "its posts' thickness" },
  },
  parts: ["timber", "brace"],
  build(ctx) {
    const w = ctx.range("width") / 2;
    const h = ctx.range("height");
    const t = ctx.range("thickness");
    const wood = ctx.paint("timber");
    const brace = ctx.paint("brace");
    // Each post leans in a hair toward its head, its foot on a flat stone-sized wedge.
    for (const side of [-1, 1]) slab(ctx, [side * w, (h + t * 0.5) / 2, 0], [t / 2, (h + t * 0.5) / 2, t / 2], wood, { collide: true, taper: [0.88, 1], bevel: t * 0.1, bottom: false });
    // The cap across their heads, reaching past them.
    slab(ctx, [0, h + t * 0.55, 0], [w + t * 1.3, t * 0.55, t * 0.6], wood, { bevel: t * 0.1 });
    if (ctx.far) return;
    // Boards over the cap, along the way: the roof the set holds up.
    for (const x of [-w * 0.6, 0, w * 0.6]) slab(ctx, [x, h + t * 1.1 + 0.07, 0], [t * 0.45, 0.07, 1.1], brace, { bevel: 0.03 });
    // Knee braces, post to cap, slimmer than either so they sit inside their faces.
    const reach = Math.min(1.2, w * 0.7);
    for (const side of [-1, 1]) {
      ctx.shape.beam(ORIGIN, [side * (w - t * 0.3), h - reach, 0], [side * (w - reach), h + t * 0.1, 0], t * 0.6, t * 0.55, brace);
    }
    // A wedge driven in at each joint.
    for (const side of [-1, 1]) slab(ctx, [side * (w + t * 0.55), h - 0.05, 0], [0.12, 0.17, t * 0.3], brace, { bevel: 0.03 });
  },
};

/**
 * Plank-and-prop against a wall: boards stood up the rock, two wales across them, and raking props
 * from the floor to the upper wale. Its back (z 0) is on the rock.
 */
export const wallShoring: PropGenerator = {
  doc: "Boards stood against a wall, held by wales and raking props.",
  params: {
    width: { kind: "range", default: [3, 4.4], min: 1, doc: "along the wall" },
    height: { kind: "range", default: [2.8, 3.4], min: 1.5, doc: "the boards' height" },
  },
  parts: ["timber", "brace"],
  build(ctx) {
    const w = ctx.range("width") / 2;
    const h = ctx.range("height");
    const wood = ctx.paint("timber");
    const brace = ctx.paint("brace");
    const count = Math.max(3, Math.round(w * 2 / 0.5));
    const board = w / count;
    for (let i = 0; i < count; i++) {
      const x = -w + board * (2 * i + 1);
      // Ragged at their heads, a little out of line.
      const top = h * (0.9 + ctx.rng() * 0.1);
      slab(ctx, [x, top / 2, 0.16], [board - 0.02, top / 2, 0.07], wood, { collide: i === 0 || i === count - 1 || i === count >> 1, bottom: false });
    }
    if (ctx.far) return;
    // Two wales across the boards' faces.
    for (const y of [h * 0.3, h * 0.78]) slab(ctx, [0, y, 0.36], [w + 0.1, 0.14, 0.1], brace, { bevel: 0.03 });
    // Raking props: floor to the upper wale, one at each third.
    for (const x of [-w * 0.55, w * 0.55]) ctx.shape.beam(ORIGIN, [x, 0, 1.7], [x, h * 0.78, 0.5], 0.3, 0.3, brace, { collide: true, bevel: 0.03 });
    // A sole piece under each prop's foot.
    for (const x of [-w * 0.55, w * 0.55]) slab(ctx, [x, 0.06, 1.7], [0.3, 0.06, 0.25], wood, { bottom: false });
  },
};

/** A length of track: sleepers and two iron rails along z, to lay end to end along a way. */
export const railTrack: PropGenerator = {
  doc: "A length of rail track: sleepers and two rails, to lay in a line.",
  params: {
    length: { kind: "range", default: [3.4, 3.4], min: 1, doc: "along it" },
  },
  parts: ["timber", "iron"],
  build(ctx) {
    const l = ctx.range("length") / 2;
    track(ctx, -l, l);
  },
};

/**
 * A mine cart on a stub of track: a tapered box of boards on four iron wheels, iron bands round it,
 * a coupling at each end - empty, or heaped with ore. Along z.
 */
export const mineCart: PropGenerator = {
  doc: "A mine cart on its rails, empty or heaped with ore.",
  params: {
    length: { kind: "range", default: [2.2, 2.6], min: 1, doc: "its body's length" },
    load: { kind: "chance", default: 0, doc: "how likely it is heaped with ore" },
  },
  parts: ["timber", "iron", "rock", "ore"],
  build(ctx) {
    const l = ctx.range("length") / 2;
    const wood = ctx.paint("timber");
    const iron = ctx.paint("iron");
    const loaded = ctx.chance("load");
    track(ctx, -l - 0.9, l + 0.9);
    const wheel = 0.3;
    const axleY = RAIL_TOP + wheel;
    const floor = axleY + 0.22;
    const half = GAUGE / 2 + 0.05;
    // Floor, ends, and sides that flare outward.
    slab(ctx, [0, floor, 0], [half, 0.07, l], wood, { collide: true, bevel: 0.03 });
    const rim = 0.95;
    for (const end of [-1, 1]) slab(ctx, [0, floor + rim / 2, end * (l - 0.06)], [half - 0.02, rim / 2, 0.06], wood, { collide: true, bottom: false, bevel: 0.03 });
    for (const side of [-1, 1]) {
      const f = turned(moved(ORIGIN, [side * half, floor + rim / 2, 0]), "z", -side * 0.12);
      ctx.shape.box(f, [0.06, rim / 2, l], wood, { collide: true, bottom: false, bevel: 0.03 });
    }
    if (ctx.far) return;
    const top = floor + rim;
    // Iron bands round the rim and a third of the way down, one over each end.
    for (const end of [-1, 1]) slab(ctx, [0, top - 0.1, end * (l + 0.02)], [half + 0.12, 0.08, 0.04], iron, { bottom: false });
    for (const side of [-1, 1]) for (const z of [-l * 0.55, l * 0.55]) slab(ctx, [side * (half + 0.12), floor + rim * 0.55, z], [0.04, rim * 0.5, 0.07], iron, { bottom: false });
    // Wheels, axle ends through them.
    for (const side of [-1, 1]) for (const z of [-l * 0.6, l * 0.6]) {
      ctx.shape.cylinder(between(ORIGIN, [side * (GAUGE / 2 - 0.08), axleY, z], [side * (GAUGE / 2 + 0.12), axleY, z]), 0.2, wheel, iron, { ends: iron, sides: 10 });
    }
    // Couplings: a stub bar and a ring out of each end.
    for (const end of [-1, 1]) ctx.shape.beam(ORIGIN, [0, floor - 0.04, end * l], [0, floor - 0.04, end * (l + 0.55)], 0.09, 0.09, iron);
    if (loaded) {
      // A heap mounded over the rim: rock below, bright ore among it.
      const rock = ctx.paint("rock");
      const ore = ctx.paint("ore");
      slab(ctx, [0, floor + rim * 0.5, 0], [half - 0.12, rim * 0.5, l - 0.12], rock, { bottom: false });
      const lumps = 12;
      for (let i = 0; i < lumps; i++) {
        const u = (i / (lumps - 1)) * 2 - 1;
        const x = (ctx.rng() - 0.5) * (half * 1.4);
        const z = u * (l - 0.3);
        const crown = 1 - u * u * 0.6;
        lump(ctx, [x, top + 0.08 + 0.3 * crown * (1 - Math.abs(x) / half * 0.5), z], 0.24 + ctx.rng() * 0.1, i % 3 === 0 ? rock : ore);
      }
    }
  },
};

/**
 * A pick and a shovel leaning on the wall, or a pick stuck in a lump of rock. Against a wall (its
 * back z 0): the tools lean on it. In a rock (`stuck`): stands free.
 */
export const minerTools: PropGenerator = {
  doc: "A pick and a shovel leaning on a wall, or a pick stuck in a rock.",
  params: {
    stuck: { kind: "chance", default: 0, doc: "how likely it is a pick stuck in a rock instead of leaning tools" },
    length: { kind: "range", default: [2.1, 2.5], min: 1, doc: "the handles' length" },
  },
  parts: ["handle", "iron", "rock"],
  build(ctx) {
    const { shape } = ctx;
    const l = ctx.range("length");
    const handle = ctx.paint("handle");
    const iron = ctx.paint("iron");
    const stuck = ctx.chance("stuck");
    /** A pick from `foot` to `head`: its handle, the iron across the head curving to two points. */
    const pick = (foot: Vec3, head: Vec3, across: Vec3): void => {
      shape.beam(ORIGIN, foot, head, 0.11, 0.11, handle, { taper: [1, 0.85], collide: !stuck });
      if (ctx.far) return;
      for (const s of [-1, 1]) {
        shape.beam(ORIGIN, [head[0], head[1] + 0.02, head[2]], [head[0] + across[0] * s, head[1] - 0.14 + across[1] * s, head[2] + across[2] * s], 0.12, 0.1, iron, { taper: [1, 0.35] });
      }
    };
    if (stuck) {
      // A rock: a few lumps, a pick standing up out of its crown, slanted.
      const rock = ctx.paint("rock");
      lump(ctx, [0, 0.4, 0], 0.55, rock);
      if (!ctx.far) {
        lump(ctx, [0.55, 0.22, 0.2], 0.32, rock);
        lump(ctx, [-0.45, 0.2, -0.3], 0.3, rock);
      }
      heapHull(ctx, 0.7, 0.8);
      const tilt = 0.35 + ctx.rng() * 0.2;
      pick([0.05, 0.55, 0], [0.05 + Math.sin(tilt) * l * 0.8, 0.55 + Math.cos(tilt) * l * 0.8, 0.1], [0.55, -0.12, 0]);
      return;
    }
    // Leaning on the wall: the pick by one side, the shovel by the other, feet on the floor out from it.
    const lean = 0.78;
    const topZ = 0.12;
    pick([-0.45, 0, lean], [-0.45, l * 0.95, topZ], [0.5, -0.1, 0.02]);
    // The shovel: handle, a grip across its head, the blade at its foot (iron, at the floor).
    const foot: Vec3 = [0.45, 0, lean * 0.9];
    const head: Vec3 = [0.45, l * 0.95, topZ];
    shape.beam(ORIGIN, foot, head, 0.1, 0.1, handle, { collide: true });
    shape.beam(ORIGIN, foot, [foot[0], foot[1] + 0.7, foot[2] - 0.12], 0.45, 0.05, iron, { taper: [0.55, 1] });
    if (!ctx.far) shape.beam(ORIGIN, [head[0] - 0.2, head[1], head[2]], [head[0] + 0.2, head[1], head[2]], 0.08, 0.08, handle);
  },
};

/** A heap of ore: broken rock with the bright metal showing in it. */
export const orePile: PropGenerator = {
  doc: "A heap of broken ore: dull rock lumps and bright ore among them.",
  params: {
    radius: { kind: "range", default: [0.9, 1.3], min: 0.3, doc: "across its foot" },
    lumps: { kind: "count", default: [12, 18], min: 3, doc: "lumps in it" },
  },
  parts: ["rock", "ore"],
  build(ctx) {
    const r = ctx.range("radius");
    const lumps = ctx.far ? Math.ceil(ctx.count("lumps") / 2) : ctx.count("lumps");
    const rock = ctx.paint("rock");
    const ore = ctx.paint("ore");
    heapHull(ctx, r * 0.85, r * 0.8);
    for (let i = 0; i < lumps; i++) {
      // Spread by the area, the middle higher: a cone's heap.
      const a = ctx.rng() * Math.PI * 2;
      const d = Math.sqrt(ctx.rng()) * r * 0.85;
      const y = (1 - d / (r * 1.1)) * r * 0.62;
      lump(ctx, [Math.sin(a) * d, y, Math.cos(a) * d], 0.2 + ctx.rng() * 0.12 + (1 - d / r) * 0.1, i % 3 === 0 ? ore : rock);
    }
  },
};

/** An outcrop of ore standing out of the wall: a mound of rock with seams of bright metal crossing it. */
export const oreOutcrop: PropGenerator = {
  doc: "A mound of rock against a wall with a seam of ore across its face.",
  params: {
    width: { kind: "range", default: [2.2, 3.2], min: 1, doc: "along the wall" },
    height: { kind: "range", default: [1.8, 2.6], min: 0.8, doc: "how high" },
    seams: { kind: "count", default: [2, 4], min: 1, doc: "bright seams across it" },
  },
  parts: ["rock", "ore"],
  build(ctx) {
    const w = ctx.range("width") / 2;
    const h = ctx.range("height");
    const rock = ctx.paint("rock");
    const ore = ctx.paint("ore");
    // The mound: a big block with its face leaning back, a couple of lumps at its foot.
    ctx.shape.box(turned(moved(ORIGIN, [0, h / 2, 0.15]), "x", -0.1), [w, h / 2, 0.55], rock, { collide: true, bevel: 0.25, bottom: false });
    lump(ctx, [-w * 0.8, 0.35, 0.8], 0.5, rock);
    lump(ctx, [w * 0.7, 0.3, 0.9], 0.45, rock);
    if (ctx.far) return;
    // Seams: slim slabs across the face at a slant, proud of the rock, here and there thickening to a nugget.
    const seams = ctx.count("seams");
    for (let i = 0; i < seams; i++) {
      const y = h * (0.25 + (0.6 * (i + 0.5)) / seams);
      const x0 = -w * (0.35 + ctx.rng() * 0.35), x1 = w * (0.3 + ctx.rng() * 0.4);
      const tilt = (ctx.rng() - 0.5) * 0.4;
      ctx.shape.beam(ORIGIN, [x0, y - tilt * 0.5, 0.69], [x1, y + tilt, 0.69], 0.14 + ctx.rng() * 0.1, 0.07, ore, { bevel: 0.04 });
      lump(ctx, [(x0 + x1) / 2 + (ctx.rng() - 0.5) * 0.6, y + tilt * 0.2, 0.74], 0.15, ore);
    }
  },
};

/**
 * A windlass over a shaft: a square collar of timbers round a dark hole, two posts either side with
 * a drum across them, a crank on one end, and a bucket hung on its rope over the hole.
 */
export const windlass: PropGenerator = {
  doc: "A windlass: a shaft's collar, two posts, a crank drum and a bucket on its rope.",
  params: {
    height: { kind: "range", default: [2.6, 3.0], min: 1.5, doc: "to the drum's axle" },
  },
  parts: ["timber", "iron", "rope", "hole"],
  build(ctx) {
    const { shape } = ctx;
    const h = ctx.range("height");
    const wood = ctx.paint("timber");
    const iron = ctx.paint("iron");
    const half = 0.95;
    // The hole: a dark slab sunk a hair under the collar's top.
    slab(ctx, [0, 0.12, 0], [half - 0.12, 0.12, half - 0.12], ctx.paint("hole"), { bottom: false });
    // The collar: four squared timbers laid round it, the ends of two crossing the others.
    for (const side of [-1, 1]) {
      slab(ctx, [side * half, 0.2, 0], [0.18, 0.2, half + 0.2], wood, { collide: true, bottom: false, bevel: 0.05 });
      slab(ctx, [0, 0.3, side * half], [half - 0.2, 0.2, 0.18], wood, { collide: true, bottom: false, bevel: 0.05 });
    }
    // The posts either side of the hole, braced out to the collar.
    for (const side of [-1, 1]) {
      slab(ctx, [side * (half + 0.05), h / 2 + 0.3, -0.3], [0.17, h / 2, 0.17], wood, { collide: true, taper: [0.9, 1], bevel: 0.04, bottom: false });
    }
    const axleY = h + 0.3 - 0.45;
    if (ctx.far) {
      shape.cylinder(between(ORIGIN, [-half, axleY, -0.3], [half, axleY, -0.3]), half * 2, 0.22, wood, { ends: wood, sides: 6 });
      return;
    }
    // The drum across the posts, rope wound on it, an iron-shod crank out of the near end.
    shape.cylinder(between(ORIGIN, [-half - 0.1, axleY, -0.3], [half + 0.1, axleY, -0.3]), half * 2 + 0.2, 0.22, wood, { ends: wood, sides: 8 });
    shape.cylinder(between(ORIGIN, [-half * 0.5, axleY, -0.3], [half * 0.5, axleY, -0.3]), half, 0.28, ctx.paint("rope"), { ends: ctx.paint("rope"), sides: 8 });
    const crankX = half + 0.1;
    shape.beam(ORIGIN, [crankX, axleY, -0.3], [crankX + 0.35, axleY - 0.5, -0.3], 0.1, 0.1, iron);
    shape.cylinder(between(ORIGIN, [crankX + 0.35, axleY - 0.5, -0.3 - 0.15], [crankX + 0.35, axleY - 0.5, -0.3 + 0.35]), 0.5, 0.06, wood, { ends: wood, sides: 5 });
    // The rope from the drum down to a bucket over the hole.
    const hang = 0.55 + ctx.rng() * 0.4;
    const ropeTop: Vec3 = [0, axleY - 0.28, -0.3], ropeFoot: Vec3 = [0, hang + 0.45, 0];
    shape.cylinder(between(ORIGIN, ropeTop, ropeFoot), distance(ropeTop, ropeFoot), 0.04, ctx.paint("rope"), { ends: ctx.paint("rope"), sides: 4 });
    shape.lathe(moved(ORIGIN, [0, hang - 0.1, 0]), [[0.3, 0], [0.34, 0.2], [0.38, 0.5], [0.36, 0.52]], wood, { sides: 8 });
    shape.lathe(moved(ORIGIN, [0, hang - 0.1, 0]), [[0.33, 0.1], [0.37, 0.2], [0.4, 0.3]], iron, { sides: 8 });
  },
};
