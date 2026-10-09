import type { PropContext, PropGenerator } from "../propGenerator";
import { ORIGIN, PROUD, between, moved, turned } from "../propShapes";
import type { Vec3 } from "../../buildings/buildingGeometry";
import type { Paint } from "../../buildings/buildingTypes";

/**
 * Furniture - see FURNITURE.md. Thick, crude parts at oversized dimensions, to sit with the
 * buildings drawn twice life size: legs as thick as posts, tops and seats as slabs, iron as straps.
 * Few parts, each chunky - and many of them slightly tapered (a leg slimming to its foot, a handle
 * to its end), which costs no polygons and reads as shaped wood rather than stock. Every piece stands on y 0, its front toward +z, centred on its footprint;
 * a piece for a wall has its back toward -z.
 */

/** A box with its centre at `c`, `half` its half extents - the everyday piece. */
function slab(ctx: PropContext, c: Vec3, half: Vec3, paint: Paint, options: { collide?: boolean; bottom?: boolean; top?: Paint; taper?: [number, number]; bevel?: number } = {}): void {
  ctx.shape.box(moved(ORIGIN, c), half, paint, options);
}

/** How much a leg slims to its foot, by default: its foot this share of its head's thickness. */
const LEG_TAPER: [number, number] = [0.8, 1];

/** A square post from (x, y0, z) up to y1 - slimming to its foot by `taper` [foot, head] (see
 *  Shaper.box). */
function post(ctx: PropContext, x: number, z: number, y0: number, y1: number, thick: number, paint: Paint, collide = false, taper: [number, number] = LEG_TAPER): void {
  slab(ctx, [x, (y0 + y1) / 2, z], [thick / 2, (y1 - y0) / 2, thick / 2], paint, { bottom: y0 > 0, collide, taper, bevel: thick * 0.12 });
}

/** A candle with its flame, standing at `base`. */
function candle(ctx: PropContext, base: Vec3, radius: number, height: number): void {
  const { shape } = ctx;
  shape.cylinder(between(ORIGIN, base, [base[0], base[1] + height, base[2]], [0, 0, 1]), height, radius, ctx.paint("wax"), { ends: ctx.paint("wax"), caps: "end", sides: 6 });
  flame(ctx, [base[0], base[1] + height + 0.02, base[2]], radius * 1.3, radius * 4);
}

/** A tongue of flame standing at `base`: two crossed, tapering slivers - the second turned an eighth
 *  round, not a quarter, or its four sides would lie on the first's. */
function flame(ctx: PropContext, base: Vec3, radius: number, height: number): void {
  if (ctx.far) return;
  const paint = ctx.paint("flame");
  for (const turn of [0, Math.PI / 4]) {
    const f = turned(moved(ORIGIN, base), "y", turn);
    ctx.shape.lathe(f, [[radius * 0.6, 0], [radius, height * 0.3], [radius * 0.5, height * 0.75], [0.001, height]], paint, { sides: 4 });
  }
}

/** A table: a slab of a top on four posts and an apron under it - or on two trestles and a
 *  stretcher between them. */
export const table: PropGenerator = {
  doc: "A table: a thick top on posts, or on trestles.",
  params: {
    length: { kind: "range", default: [2.6, 3.6], min: 0.6, doc: "along its long side" },
    width: { kind: "range", default: [1.6, 2.0], min: 0.6, doc: "across it" },
    height: { kind: "range", default: [1.5, 1.7], min: 0.4, doc: "its top's height" },
    top: { kind: "range", default: [0.16, 0.22], min: 0.04, doc: "its top's thickness" },
    leg: { kind: "range", default: [0.24, 0.3], min: 0.05, doc: "its legs' thickness" },
    trestle: { kind: "chance", default: 0.3, doc: "how likely it stands on trestles" },
  },
  parts: ["top", "legs"],
  build(ctx) {
    const l = ctx.range("length") / 2;
    const w = ctx.range("width") / 2;
    const h = ctx.range("height");
    const t = ctx.range("top");
    const leg = ctx.range("leg");
    const legs = ctx.paint("legs");
    slab(ctx, [0, h - t / 2, 0], [l, t / 2, w], ctx.paint("top"), { collide: true, bevel: 0.04 });
    // Up into the top, short of its top face.
    const under = h - t * 0.4;
    if (ctx.chance("trestle")) {
      for (const sx of [-1, 1]) {
        const x = sx * (l - leg * 1.6);
        // An A of two legs and a foot, its head a cross bar under the top.
        for (const sz of [-1, 1]) ctx.shape.beam(ORIGIN, [x, 0, sz * (w - leg)], [x, under, sz * w * 0.25], leg, leg, legs, { collide: true, taper: [1, 0.75] });
        slab(ctx, [x, leg * 0.6, 0], [leg * 0.6, leg * 0.6, w - leg * 0.3], legs, { bottom: false });
        slab(ctx, [x, h - t - leg * 0.5 + PROUD, 0], [leg * 0.6, leg * 0.5, w * 0.8], legs);
      }
      // A stretcher along the floor from foot to foot, holding the trestles apart.
      slab(ctx, [0, leg * 0.45, 0], [l - leg * 1.6, leg * 0.45, leg * 0.45], legs, { bottom: false });
      return;
    }
    const inset = leg * 0.9;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) post(ctx, sx * (l - inset), sz * (w - inset), 0, under, leg, legs, true);
    if (ctx.far) return;
    // The apron: boards from leg to leg under the top, set in from the legs' faces.
    const apron = leg * 1.2;
    const y = h - t - apron / 2 + PROUD;
    for (const sz of [-1, 1]) slab(ctx, [0, y, sz * (w - inset)], [l - inset, apron / 2, leg * 0.3], legs);
    for (const sx of [-1, 1]) slab(ctx, [sx * (l - inset), y - PROUD, 0], [leg * 0.3, apron / 2, w - inset], legs);
  },
};

/** A chair: a slab of a seat on four legs, the back legs running up into a back of thick rails. */
export const chair: PropGenerator = {
  doc: "A chair: a thick seat on posts, a back of rails.",
  params: {
    seat: { kind: "range", default: [0.95, 1.05], min: 0.3, doc: "its seat's height" },
    width: { kind: "range", default: [0.95, 1.1], min: 0.3, doc: "across its seat" },
    depth: { kind: "range", default: [0.9, 1.0], min: 0.3, doc: "front to back" },
    back: { kind: "range", default: [1.0, 1.3], min: 0.2, doc: "how far its back rises over the seat" },
    leg: { kind: "range", default: [0.15, 0.19], min: 0.04, doc: "its legs' thickness" },
    rails: { kind: "count", default: [2, 3], min: 1, doc: "rails across its back" },
  },
  parts: ["wood", "seat"],
  build(ctx) {
    const s = ctx.range("seat");
    const w = ctx.range("width") / 2;
    const d = ctx.range("depth") / 2;
    const back = ctx.range("back");
    const leg = ctx.range("leg");
    const wood = ctx.paint("wood");
    const t = 0.14;
    slab(ctx, [0, s - t / 2, 0], [w, t / 2, d], ctx.paint("seat"), { collide: true, bevel: 0.035 });
    const inset = leg * 0.7;
    // Front legs up into the seat; back legs on up through it into the back.
    for (const sx of [-1, 1]) {
      post(ctx, sx * (w - inset), d - inset, 0, s - t * 0.4, leg, wood, true);
      post(ctx, sx * (w - inset), -(d - inset), 0, s + back, leg, wood, true, [0.85, 0.75]);
    }
    if (ctx.far) return;
    const rails = ctx.count("rails");
    for (let n = 0; n < rails; n++) {
      const y = s + back * (0.35 + (0.6 * (n + 1)) / rails) - leg * 0.6;
      // Never as tall as the gap to the next rail, so no two touch; thinner than the back legs are
      // at their slimmest, so no face of a rail meets a leg's.
      const half = Math.min(leg * 0.6, (back * 0.6) / rails / 2 - 0.03);
      slab(ctx, [0, y, -(d - inset)], [w - inset, half, leg * 0.28], wood);
    }
    // Stretchers low between the legs, front to back.
    for (const sx of [-1, 1]) slab(ctx, [sx * (w - inset), s * 0.3, 0], [leg * 0.35, leg * 0.4, d - inset], wood);
  },
};

/** An armchair: a deep seat, broad arms, a high back - a cushion on the seat and against the back. */
export const armchair: PropGenerator = {
  doc: "An armchair: deep, broad-armed, high-backed, cushioned.",
  params: {
    seat: { kind: "range", default: [0.85, 0.95], min: 0.3, doc: "its seat's height" },
    width: { kind: "range", default: [1.6, 1.9], min: 0.6, doc: "across it, arms and all" },
    depth: { kind: "range", default: [1.4, 1.6], min: 0.6, doc: "front to back" },
    back: { kind: "range", default: [1.3, 1.6], min: 0.3, doc: "how far its back rises over the seat" },
  },
  parts: ["wood", "cushion"],
  build(ctx) {
    const s = ctx.range("seat");
    const w = ctx.range("width") / 2;
    const d = ctx.range("depth") / 2;
    const back = ctx.range("back");
    const wood = ctx.paint("wood");
    const arm = 0.26;
    const frame = 0.22;
    // Raised on four short legs: the box of its base, the back and an arm each side over them, all
    // of thick boards.
    const lift = 0.32;
    slab(ctx, [0, (lift + s - 0.08) / 2, 0], [w - arm, (s - 0.08 - lift) / 2, d - 0.05], wood, { collide: true });
    // The back between the arms' outer faces and a little over their feet - never in a plane with
    // them (see propShapes.ts).
    slab(ctx, [0, (lift + PROUD + s + back) / 2, -(d - frame / 2)], [w - 2 * PROUD, (s + back - lift - PROUD) / 2, frame / 2], wood, { collide: true });
    const armTop = s + 0.6;
    for (const sx of [-1, 1]) slab(ctx, [sx * (w - arm / 2), (lift + armTop) / 2, PROUD], [arm / 2, (armTop - lift) / 2, d - PROUD], wood, { collide: true, bevel: 0.05 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) post(ctx, sx * (w - 0.16), sz * (d - 0.16), 0, lift + 0.06, 0.24, wood, true, [0.65, 1]);
    if (ctx.far) return;
    const cushion = ctx.paint("cushion");
    slab(ctx, [0, s + 0.05, PROUD], [w - arm - PROUD, 0.16, d - frame - PROUD], cushion, { bevel: 0.07 });
    slab(ctx, [0, s + back * 0.55, -(d - frame - 0.14)], [w - arm - PROUD, back * 0.42, 0.14], cushion, { bevel: 0.06 });
  },
};

/** A stool: a round or square seat on three or four splayed legs. */
export const stool: PropGenerator = {
  doc: "A stool: a thick seat on splayed legs.",
  params: {
    seat: { kind: "range", default: [0.9, 1.05], min: 0.2, doc: "its seat's height" },
    radius: { kind: "range", default: [0.42, 0.52], min: 0.1, doc: "its seat's radius (half its side, if square)" },
    round: { kind: "chance", default: 0.6, doc: "how likely its seat is round" },
    legs: { kind: "count", default: [3, 4], min: 3, doc: "how many legs" },
  },
  parts: ["seat", "legs"],
  build(ctx) {
    const s = ctx.range("seat");
    const r = ctx.range("radius");
    const t = 0.14;
    if (ctx.chance("round")) ctx.shape.cylinder(between(ORIGIN, [0, s - t, 0], [0, s, 0], [0, 0, 1]), t, r, ctx.paint("seat"), { ends: ctx.paint("seat"), collide: true });
    else slab(ctx, [0, s - t / 2, 0], [r, t / 2, r], ctx.paint("seat"), { collide: true, bevel: 0.035 });
    const legs = ctx.count("legs");
    const turn = ctx.rng() * Math.PI * 2;
    for (let n = 0; n < legs; n++) {
      const a = turn + (n / legs) * Math.PI * 2;
      const foot: Vec3 = [Math.cos(a) * r * 1.05, 0, Math.sin(a) * r * 1.05];
      const head: Vec3 = [Math.cos(a) * r * 0.55, s - t * 0.5, Math.sin(a) * r * 0.55];
      ctx.shape.beam(ORIGIN, foot, head, 0.15, 0.15, ctx.paint("legs"), { collide: true, taper: [0.75, 1] });
    }
  },
};

/** A bench: a long seat on two slab ends - or on four posts. */
export const bench: PropGenerator = {
  doc: "A bench: a long thick seat on slab ends or posts.",
  params: {
    length: { kind: "range", default: [2.6, 3.8], min: 0.6, doc: "along it" },
    depth: { kind: "range", default: [0.65, 0.8], min: 0.2, doc: "across its seat" },
    seat: { kind: "range", default: [0.95, 1.05], min: 0.2, doc: "its seat's height" },
    slabs: { kind: "chance", default: 0.6, doc: "how likely it stands on slab ends rather than posts" },
  },
  parts: ["wood"],
  build(ctx) {
    const l = ctx.range("length") / 2;
    const d = ctx.range("depth") / 2;
    const s = ctx.range("seat");
    const wood = ctx.paint("wood");
    const t = 0.16;
    slab(ctx, [0, s - t / 2, 0], [l, t / 2, d], wood, { collide: true, bevel: 0.04 });
    if (ctx.chance("slabs")) {
      for (const sx of [-1, 1]) slab(ctx, [sx * (l - 0.4), (s - t * 0.6) / 2, 0], [0.09, (s - t * 0.6) / 2, d - 0.05], wood, { bottom: false, collide: true, taper: [1, 0.85] });
      if (!ctx.far) slab(ctx, [0, s * 0.45, 0], [l - 0.4, 0.09, 0.07], wood);
      return;
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) post(ctx, sx * (l - 0.25), sz * (d - 0.12), 0, s - t * 0.4, 0.18, wood, true);
  },
};

/** A bed: a frame on posts, a high head board and a low foot board, a mattress, a blanket over most
 *  of it, a pillow. Its head is its back (-z). */
export const bed: PropGenerator = {
  doc: "A bed: posts, boards, a mattress, a blanket and a pillow.",
  params: {
    length: { kind: "range", default: [4.0, 4.4], min: 1, doc: "head to foot" },
    width: { kind: "range", default: [2.2, 3.0], min: 0.6, doc: "across it" },
    height: { kind: "range", default: [0.75, 0.9], min: 0.2, doc: "its frame's top" },
    head: { kind: "range", default: [1.9, 2.3], min: 0.5, doc: "its head posts' height" },
  },
  parts: ["wood", "mattress", "blanket", "pillow"],
  build(ctx) {
    const d = ctx.range("length") / 2;
    const w = ctx.range("width") / 2;
    const h = ctx.range("height");
    const head = ctx.range("head");
    const wood = ctx.paint("wood");
    const p = 0.24;
    // Four corner posts, the head's high, the foot's low.
    for (const sx of [-1, 1]) {
      post(ctx, sx * (w - p / 2), -(d - p / 2), 0, head, p, wood, true, [0.85, 0.8]);
      post(ctx, sx * (w - p / 2), d - p / 2, 0, h + 0.5, p, wood, true);
    }
    // The side rails, and the head and foot boards between the posts.
    for (const sx of [-1, 1]) slab(ctx, [sx * (w - p / 2), h - 0.15, 0], [p * 0.35, 0.15, d - p], wood, { collide: true });
    slab(ctx, [0, (h + head) / 2 - 0.1, -(d - p / 2)], [w - p, (head - h) / 2 - 0.1, p * 0.3], wood, { collide: true });
    slab(ctx, [0, h + 0.1, d - p / 2], [w - p, 0.3, p * 0.3], wood, { collide: true });
    // The mattress on the frame, between the boards.
    const mattress = 0.32;
    const top = h + mattress;
    slab(ctx, [0, h + mattress / 2 - 0.1, 0], [w - p * 0.6, mattress / 2, d - p * 0.7], ctx.paint("mattress"), { collide: true, bevel: 0.08 });
    if (ctx.far) return;
    // A blanket over its foot two thirds, hanging a little over the sides; a pillow at its head.
    const reach = (d - p) * 1.35;
    slab(ctx, [0, top - 0.1 + 0.04, d - p - reach / 2], [w - p * 0.6 + 0.06, 0.06, reach / 2], ctx.paint("blanket"));
    slab(ctx, [0, top - 0.1 + 0.12, -(d - p - 0.45)], [w * 0.6, 0.12, 0.35], ctx.paint("pillow"), { bevel: 0.08 });
  },
};

/** A wardrobe: a tall cupboard on a plinth, a cornice over it, two plank doors (their ledges and
 *  ring handles their material's own - doorBoards). */
export const cabinet: PropGenerator = {
  doc: "A tall cupboard: two plank doors, a plinth and a cornice.",
  params: {
    width: { kind: "range", default: [2.2, 2.8], min: 0.5, doc: "across its front" },
    depth: { kind: "range", default: [1.1, 1.3], min: 0.3, doc: "front to back" },
    height: { kind: "range", default: [3.8, 4.4], min: 0.5, doc: "how tall" },
  },
  parts: ["wood", "doors"],
  build(ctx) {
    const w = ctx.range("width") / 2;
    const d = ctx.range("depth") / 2;
    const h = ctx.range("height");
    const wood = ctx.paint("wood");
    const plinth = 0.25;
    const cornice = 0.25;
    slab(ctx, [0, plinth / 2, 0], [w + 0.05, plinth / 2, d + 0.05], wood, { bottom: false, collide: true });
    slab(ctx, [0, (plinth + h - cornice) / 2, 0], [w, (h - cornice - plinth) / 2 + PROUD, d], wood, { collide: true });
    slab(ctx, [0, h - cornice / 2, 0], [w + 0.1, cornice / 2, d + 0.1], wood, { bevel: 0.06 });
    if (ctx.far) return;
    // Two doors standing proud of its front, a gap between them.
    const doors = ctx.paint("doors");
    const doorH = (h - cornice - plinth) / 2 - 0.12;
    const y = (plinth + h - cornice) / 2;
    for (const sx of [-1, 1]) slab(ctx, [sx * (w / 2), y, d + 0.04], [w / 2 - 0.12, doorH, 0.04], doors);
  },
};

/** A chest: a box of thick boards, a lid over it, iron straps round both and a lock plate. */
export const chest: PropGenerator = {
  doc: "A chest: boards, a lid, iron straps and a lock.",
  params: {
    width: { kind: "range", default: [1.8, 2.3], min: 0.4, doc: "across its front" },
    depth: { kind: "range", default: [1.1, 1.3], min: 0.3, doc: "front to back" },
    height: { kind: "range", default: [1.0, 1.2], min: 0.3, doc: "how tall, lid and all" },
    straps: { kind: "count", default: [2, 3], min: 0, doc: "iron straps round it" },
  },
  parts: ["wood", "iron"],
  build(ctx) {
    const w = ctx.range("width") / 2;
    const d = ctx.range("depth") / 2;
    const h = ctx.range("height");
    const wood = ctx.paint("wood");
    const lid = 0.22;
    slab(ctx, [0, (h - lid) / 2, 0], [w, (h - lid) / 2, d], wood, { bottom: false, collide: true, taper: [0.94, 1] });
    slab(ctx, [0, h - lid / 2, 0], [w + 0.06, lid / 2, d + 0.06], wood, { collide: true, bevel: 0.05 });
    if (ctx.far) return;
    const iron = ctx.paint("iron");
    const straps = ctx.count("straps");
    for (let n = 0; n < straps; n++) {
      const x = (straps === 1 ? 0 : -w * 0.7 + (1.4 * w * n) / (straps - 1));
      // Up the front, over the lid and down the back - each standing proud of the wood under it.
      slab(ctx, [x, h / 2, d + 0.06 + PROUD], [0.07, h / 2 - PROUD, PROUD], iron, { bottom: false });
      slab(ctx, [x, h / 2, -(d + 0.06 + PROUD)], [0.07, h / 2 - PROUD, PROUD], iron, { bottom: false });
      slab(ctx, [x, h + PROUD, 0], [0.07, PROUD, d + 0.06 + PROUD], iron);
    }
    slab(ctx, [0, h - lid - 0.05, d + 0.06 + 2 * PROUD], [0.16, 0.2, PROUD], iron);
  },
};

/** A sack: a lumpy bag, full, tied off at its neck, leaning a little. */
export const sack: PropGenerator = {
  doc: "A full sack tied at its neck.",
  params: {
    height: { kind: "range", default: [1.1, 1.4], min: 0.3, doc: "how tall" },
    radius: { kind: "range", default: [0.45, 0.55], min: 0.1, doc: "how fat" },
    lean: { kind: "range", default: [0, 0.18], min: 0, doc: "how far it leans (radians)" },
  },
  parts: ["cloth", "tie"],
  build(ctx) {
    const { rng } = ctx;
    const h = ctx.range("height");
    const r = ctx.range("radius");
    const lean = ctx.range("lean");
    const f = turned(turned(ORIGIN, "y", rng() * Math.PI * 2), "x", lean);
    // Slumped wide at its foot, bellied, drawn in to its neck, a tuft over the tie.
    const profile: [number, number][] = [
      [r * 0.85, 0],
      [r * 1.05, h * 0.15],
      [r, h * 0.5],
      [r * 0.7, h * 0.78],
      [r * 0.22, h * 0.88],
      [r * 0.35, h * 0.97],
      [r * 0.12, h * 1.02],
    ];
    ctx.shape.lathe(f, profile, ctx.paint("cloth"), { collide: true, sides: ctx.far ? 6 : 9 });
    if (!ctx.far) ctx.shape.lathe(f, [[r * 0.24, h * 0.85], [r * 0.27, h * 0.88], [r * 0.24, h * 0.91]], ctx.paint("tie"), { sides: 6 });
  },
};

/** A bar: a counter of thick planks, its top overhanging its front and ends, posts down its front,
 *  a kick board at its foot. Its customers' side is its front (+z). */
export const counter: PropGenerator = {
  doc: "A bar counter: a plank front, posts, an overhanging top.",
  params: {
    length: { kind: "range", default: [4, 7], min: 1, doc: "along it" },
    depth: { kind: "range", default: [1.1, 1.3], min: 0.4, doc: "front to back" },
    height: { kind: "range", default: [2.0, 2.2], min: 0.6, doc: "its top's height" },
  },
  parts: ["front", "top", "posts"],
  build(ctx) {
    const l = ctx.range("length") / 2;
    const d = ctx.range("depth") / 2;
    const h = ctx.range("height");
    const t = 0.18;
    slab(ctx, [0, (h - t) / 2, 0], [l, (h - t) / 2, d], ctx.paint("front"), { bottom: false, collide: true });
    slab(ctx, [0, h - t / 2, 0.12], [l + 0.12, t / 2, d + 0.12], ctx.paint("top"), { collide: true, bevel: 0.04 });
    if (ctx.far) return;
    const posts = ctx.paint("posts");
    const count = Math.max(2, Math.round(l / 1.2) + 1);
    for (let n = 0; n < count; n++) {
      const x = -l + 0.15 + ((2 * l - 0.3) * n) / (count - 1);
      slab(ctx, [x, (h - t) / 2, d + 0.05], [0.13, (h - t) / 2 - PROUD, 0.06], posts, { bottom: false });
    }
    slab(ctx, [0, 0.15, d + 0.02], [l - 0.01, 0.15, 0.04], posts, { bottom: false });
  },
};

/** A fireplace: a stone hearth stone, cheeks either side of the fire, a lintel and a chimney breast
 *  up to its top, a timber mantel; logs burning inside. Its back (-z) goes against the wall. */
export const fireplace: PropGenerator = {
  doc: "A stone fireplace: hearth, cheeks, lintel, mantel, a fire.",
  params: {
    width: { kind: "range", default: [3.0, 3.6], min: 1, doc: "across it" },
    depth: { kind: "range", default: [1.2, 1.5], min: 0.4, doc: "out from the wall" },
    height: { kind: "range", default: [3.4, 4.0], min: 1, doc: "its breast's top" },
    fire: { kind: "chance", default: 0.8, doc: "how likely a fire burns in it" },
  },
  parts: ["stone", "hearth", "soot", "mantel", "logs", "end", "flame"],
  build(ctx) {
    const { rng } = ctx;
    const w = ctx.range("width") / 2;
    const d = ctx.range("depth") / 2;
    const h = ctx.range("height");
    const stone = ctx.paint("stone");
    const opening = w * 0.55;
    const openTop = Math.min(h * 0.5, 1.8);
    const lintel = 0.45;
    // The cheeks, the lintel over the opening, the breast up from it - and the fire's back.
    for (const sx of [-1, 1]) slab(ctx, [sx * (opening + (w - opening) / 2), openTop / 2, 0], [(w - opening) / 2, openTop / 2, d], stone, { bottom: false, collide: true, taper: [1, 0.94] });
    slab(ctx, [0, openTop + lintel / 2, 0.06], [w + 0.06, lintel / 2, d + 0.06], stone, { collide: true, bevel: 0.06 });
    slab(ctx, [0, (openTop + lintel + h) / 2, -0.15], [w - 0.2, (h - openTop - lintel) / 2, d - 0.15], stone, { collide: true });
    slab(ctx, [0, openTop / 2, -d + 0.16], [opening + PROUD, openTop / 2, 0.14], ctx.paint("soot"), { bottom: false });
    // The hearth stone out in front, a step up from the floor.
    // Out in front, stopping short of the wall behind (where the cheeks' backs are).
    slab(ctx, [0, 0.08, d * 0.4 + 0.015], [w + 0.25, 0.08, d * 1.4 - 0.015], ctx.paint("hearth"), { bottom: false, collide: true, bevel: 0.04 });
    if (ctx.far) return;
    // The mantel on the lintel, its back set into the breast (whose face is at d - 0.3), its front
    // out over the hearth.
    const mantelBack = d - 0.36;
    const mantelFront = d + 0.52;
    slab(ctx, [0, openTop + lintel + 0.08 + PROUD, (mantelBack + mantelFront) / 2], [w + 0.3, 0.08, (mantelFront - mantelBack) / 2], ctx.paint("mantel"), { bevel: 0.03 });
    if (!ctx.chance("fire")) return;
    // Two or three logs on the hearth, crossed, and flames up from them.
    const logs = 2 + Math.floor(rng() * 2);
    for (let n = 0; n < logs; n++) {
      const yaw = (rng() - 0.5) * 0.8 + (n % 2 === 0 ? 0 : Math.PI / 2) * 0.4;
      const len = opening * 1.4;
      const r = 0.13 + rng() * 0.05;
      const y = 0.16 + r + n * 0.12;
      const from: Vec3 = [-Math.cos(yaw) * len / 2, y, -d * 0.2 - Math.sin(yaw) * len / 2];
      const to: Vec3 = [Math.cos(yaw) * len / 2, y, -d * 0.2 + Math.sin(yaw) * len / 2];
      ctx.shape.cylinder(between(ORIGIN, from, to), len, r, ctx.paint("logs"), { ends: ctx.paint("end"), sides: 6 });
    }
    for (let n = 0; n < 3; n++) flame(ctx, [(n - 1) * opening * 0.35, 0.35, -d * 0.2], 0.22, 0.7 + rng() * 0.4);
  },
};

/** A stove: an iron box on stubby feet, a door with the fire showing through, a pipe up from it. */
export const stove: PropGenerator = {
  doc: "An iron stove on feet, a fire door, a pipe up.",
  params: {
    width: { kind: "range", default: [1.3, 1.6], min: 0.4, doc: "across it" },
    depth: { kind: "range", default: [1.1, 1.3], min: 0.4, doc: "front to back" },
    height: { kind: "range", default: [1.4, 1.7], min: 0.4, doc: "its top's height" },
    pipe: { kind: "range", default: [3.6, 4.4], min: 1, doc: "how high its pipe reaches" },
  },
  parts: ["iron", "flame"],
  build(ctx) {
    const w = ctx.range("width") / 2;
    const d = ctx.range("depth") / 2;
    const h = ctx.range("height");
    const pipe = ctx.range("pipe");
    const iron = ctx.paint("iron");
    const feet = 0.25;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) post(ctx, sx * (w - 0.15), sz * (d - 0.15), 0, feet + 0.05, 0.16, iron);
    slab(ctx, [0, (feet + h) / 2, 0], [w, (h - feet) / 2, d], iron, { collide: true });
    slab(ctx, [0, h + 0.05, 0], [w + 0.08, 0.05, d + 0.08], iron);
    ctx.shape.cylinder(between(ORIGIN, [0, h, -d * 0.4], [0, pipe, -d * 0.4], [0, 0, 1]), pipe - h, 0.2, iron, { collide: true, sides: 8 });
    if (ctx.far) return;
    // The fire door, the fire glowing in a slot of it.
    slab(ctx, [0, feet + (h - feet) * 0.45, d + 0.04], [w * 0.55, (h - feet) * 0.28, 0.04], iron);
    slab(ctx, [0, feet + (h - feet) * 0.4, d + 0.08 + PROUD], [w * 0.4, 0.06, 0.02], ctx.paint("flame"));
  },
};

/** A lantern: an iron frame with lit panes, a cap and a ring - standing, or hung on a chain. */
export const lantern: PropGenerator = {
  doc: "An iron lantern with lit panes, standing or hung.",
  params: {
    height: { kind: "range", default: [0.5, 0.6], min: 0.2, doc: "its body's height" },
    width: { kind: "range", default: [0.3, 0.35], min: 0.1, doc: "across its body" },
    chain: { kind: "range", default: [0, 0], min: 0, doc: "how long a chain it hangs from (0: it stands)" },
  },
  parts: ["iron", "pane"],
  build(ctx) {
    const h = ctx.range("height");
    const w = ctx.range("width") / 2;
    const chain = ctx.range("chain");
    const iron = ctx.paint("iron");
    const base = 0.08;
    slab(ctx, [0, base / 2, 0], [w + 0.04, base / 2, w + 0.04], iron, { collide: true });
    // The panes: one glowing block inside the posts.
    slab(ctx, [0, base + (h - base) * 0.45, 0], [w - 0.02, (h - base) * 0.42, w - 0.02], ctx.paint("pane"));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) post(ctx, sx * w, sz * w, base, h, 0.06, iron, false, [1, 1]);
    // A cap like a little roof, and the ring over it.
    ctx.shape.lathe(turned(moved(ORIGIN, [0, h - 0.02, 0]), "y", Math.PI / 4), [[(w + 0.08) * Math.SQRT2, 0], [0.06, h * 0.3]], iron, { sides: 4, bottom: iron });
    if (ctx.far) return;
    const ringY = h * 1.3 + 0.06;
    ctx.shape.cylinder(turned(moved(ORIGIN, [0, ringY, -0.02]), "y", 0), 0.04, 0.09, iron, { ends: iron, sides: 6 });
    if (chain > 0) ctx.shape.beam(ORIGIN, [0, ringY + 0.06, 0], [0, ringY + chain, 0], 0.03, 0.03, iron);
  },
};

/** An altar: a block of stone on a plinth, a slab over it, a cloth over its top falling down its
 *  front, candles at its ends. Its back (-z) goes against the wall. */
export const altar: PropGenerator = {
  doc: "A stone altar, a cloth over it, candles on it.",
  params: {
    width: { kind: "range", default: [2.6, 3.2], min: 0.6, doc: "across it" },
    depth: { kind: "range", default: [1.2, 1.5], min: 0.4, doc: "front to back" },
    height: { kind: "range", default: [1.8, 2.0], min: 0.5, doc: "its top's height" },
    candles: { kind: "count", default: [2, 2], min: 0, doc: "candles on it" },
  },
  parts: ["stone", "cloth", "iron", "wax", "flame"],
  build(ctx) {
    const w = ctx.range("width") / 2;
    const d = ctx.range("depth") / 2;
    const h = ctx.range("height");
    const stone = ctx.paint("stone");
    const top = 0.2;
    slab(ctx, [0, 0.12, 0], [w + 0.15, 0.12, d + 0.15], stone, { bottom: false, collide: true, bevel: 0.05 });
    slab(ctx, [0, (0.24 + h - top) / 2, 0], [w, (h - top - 0.24) / 2 + PROUD, d], stone, { collide: true, taper: [1, 0.95] });
    slab(ctx, [0, h - top / 2, 0], [w + 0.12, top / 2, d + 0.12], stone, { collide: true, bevel: 0.06 });
    if (ctx.far) return;
    const cloth = ctx.paint("cloth");
    slab(ctx, [0, h + 0.03, 0], [w * 0.75, 0.03, d + 0.12 + PROUD], cloth);
    slab(ctx, [0, h - 0.5, d + 0.12 + 0.03 + PROUD], [w * 0.75, 0.5, 0.03], cloth);
    const candles = ctx.count("candles");
    for (let n = 0; n < candles; n++) {
      const x = candles === 1 ? 0 : -w * 0.8 + (1.6 * w * n) / (candles - 1);
      ctx.shape.lathe(moved(ORIGIN, [x, h + 0.06, -d * 0.4]), [[0.16, 0], [0.06, 0.1], [0.05, 0.45], [0.12, 0.5]], ctx.paint("iron"), { bottom: ctx.paint("iron"), top: ctx.paint("iron"), sides: 6 });
      candle(ctx, [x, h + 0.56, -d * 0.4], 0.07, 0.45);
    }
  },
};

/** A sconce: an iron plate on the wall, an arm out from it, a dish and a candle burning on it. Built
 *  standing on y 0; set up the wall where it hangs. Its back (-z) is on the wall. */
export const sconce: PropGenerator = {
  doc: "A wall sconce: a plate, an arm, a candle.",
  params: {
    reach: { kind: "range", default: [0.45, 0.6], min: 0.1, doc: "how far its arm reaches out" },
    candle: { kind: "range", default: [0.35, 0.5], min: 0.1, doc: "its candle's height" },
  },
  parts: ["iron", "wax", "flame"],
  build(ctx) {
    const reach = ctx.range("reach");
    const iron = ctx.paint("iron");
    const back = -reach / 2;
    slab(ctx, [0, 0.35, back + 0.03], [0.16, 0.35, 0.03], iron);
    ctx.shape.beam(ORIGIN, [0, 0.15, back + 0.05], [0, 0.32, back + reach], 0.07, 0.07, iron, { taper: [1.2, 0.6] });
    ctx.shape.lathe(moved(ORIGIN, [0, 0.3, back + reach]), [[0.06, 0], [0.2, 0.06], [0.22, 0.1]], iron, { bottom: iron, sides: 6 });
    candle(ctx, [0, 0.36, back + reach], 0.07, ctx.range("candle"));
  },
};

/** A banner: a cloth hanging from a pole, a fringe at its foot - flat against the wall. Built from y
 *  0 up; set up the wall where it hangs. Its back (-z) is on the wall. */
export const banner: PropGenerator = {
  doc: "A banner of cloth on a pole, fringed.",
  params: {
    width: { kind: "range", default: [1.6, 2.2], min: 0.3, doc: "across it" },
    length: { kind: "range", default: [2.6, 3.6], min: 0.5, doc: "from its pole down" },
  },
  parts: ["cloth", "fringe", "pole"],
  build(ctx) {
    const w = ctx.range("width") / 2;
    const l = ctx.range("length");
    const fringe = 0.18;
    // The pole along its top, a knob at each end.
    ctx.shape.cylinder(between(ORIGIN, [-w - 0.25, l, 0], [w + 0.25, l, 0]), 2 * w + 0.5, 0.07, ctx.paint("pole"), { ends: ctx.paint("pole"), sides: 6 });
    slab(ctx, [0, fringe + (l - fringe) / 2 - 0.05, 0], [w, (l - fringe) / 2 - 0.05, 0.04], ctx.paint("cloth"), { bottom: false });
    if (ctx.far) return;
    slab(ctx, [0, fringe / 2 + 0.02, 0], [w - 0.03, fringe / 2, 0.03], ctx.paint("fringe"));
    for (const sx of [-1, 1]) ctx.shape.lathe(moved(ORIGIN, [sx * (w + 0.3), l - 0.1, 0]), [[0.001, 0], [0.12, 0.1], [0.001, 0.2]], ctx.paint("pole"), { sides: 6 });
  },
};

/** A tool rack: a board on the wall, pegs out of it, and on them a few tools - an axe, a saw, a rake
 *  or a shovel. Built from y 0 up; set up the wall where it hangs. Its back (-z) is on the wall. */
export const rack: PropGenerator = {
  doc: "A wall board of pegs with tools hung on it.",
  params: {
    width: { kind: "range", default: [2.4, 3.2], min: 0.5, doc: "along the wall" },
    tools: { kind: "count", default: [2, 4], min: 0, doc: "tools hung on it" },
  },
  parts: ["board", "handle", "iron"],
  build(ctx) {
    const { rng } = ctx;
    const w = ctx.range("width") / 2;
    const board = ctx.paint("board");
    const handle = ctx.paint("handle");
    const iron = ctx.paint("iron");
    const back = -0.35;
    const top = 2.4;
    slab(ctx, [0, top, back + 0.06], [w, 0.22, 0.06], board);
    if (ctx.far) return;
    const tools = ctx.count("tools");
    for (let n = 0; n < tools; n++) {
      const x = tools === 1 ? 0 : -w + 0.4 + ((2 * w - 0.8) * n) / (tools - 1);
      ctx.shape.beam(ORIGIN, [x, top, back + 0.1], [x, top + 0.04, back + 0.4], 0.07, 0.07, handle, { taper: [1, 0.7] });
      const z = back + 0.3;
      const kind = Math.floor(rng() * 4);
      if (kind === 0) {
        // An axe, head down.
        ctx.shape.beam(ORIGIN, [x, top - 0.05, z], [x, top - 1.6, z], 0.08, 0.1, handle, { taper: [0.8, 1.1] });
        slab(ctx, [x + 0.12, top - 1.5, z], [0.2, 0.14, 0.03], iron);
      } else if (kind === 1) {
        // A bow saw's blade and frame.
        slab(ctx, [x, top - 0.9, z], [0.03, 0.8, 0.05], handle);
        slab(ctx, [x + 0.25, top - 0.9, z], [0.01, 0.75, 0.07], iron);
      } else {
        // A rake or a shovel: a long handle, its head at the foot.
        ctx.shape.beam(ORIGIN, [x, top - 0.05, z], [x, top - 2.2, z], 0.07, 0.07, handle, { taper: [0.8, 1.1] });
        if (kind === 2) slab(ctx, [x, top - 2.25, z], [0.35, 0.05, 0.05], iron);
        else slab(ctx, [x, top - 2.4, z], [0.18, 0.25, 0.02], iron);
      }
    }
  },
};
