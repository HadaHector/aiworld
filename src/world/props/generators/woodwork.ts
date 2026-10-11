import type { PropGenerator } from "../propGenerator";
import { ORIGIN, PROUD, between, moved, turned } from "../propShapes";
import type { Vec3 } from "../../buildings/buildingGeometry";

/** The everyday wooden things about a yard: a chopping block, a sawbuck, a crate, a barrel. */

/** A round of trunk stood on end, an axe stuck in its top, split billets lying round it. */
export const choppingBlock: PropGenerator = {
  doc: "A chopping block with an axe in it and split wood by it.",
  params: {
    radius: { kind: "range", default: [0.4, 0.55], min: 0.1, doc: "the block's radius" },
    height: { kind: "range", default: [0.7, 0.95], min: 0.2, doc: "how high it stands" },
    billets: { kind: "count", default: [3, 7], min: 0, doc: "split billets lying round it" },
    axe: { kind: "chance", default: 0.8, doc: "how likely an axe is stuck in it" },
  },
  parts: ["bark", "end", "wood", "handle", "iron"],
  build(ctx) {
    const { shape, rng } = ctx;
    const r = ctx.range("radius");
    const h = ctx.range("height");
    shape.cylinder(between(ORIGIN, [0, -0.1, 0], [0, h, 0], [0, 0, 1]), h + 0.1, r, ctx.paint("bark"), { ends: ctx.paint("end"), caps: "end", heart: [(rng() - 0.5) * r * 0.5, (rng() - 0.5) * r * 0.5], collide: true });
    if (ctx.far) return;
    if (ctx.chance("axe")) {
      // Its head bitten into the top, a little off the middle; its handle rising from it.
      const yaw = rng() * Math.PI * 2;
      const off = r * (0.2 + rng() * 0.25);
      const head: Vec3 = [Math.cos(yaw + 1.3) * off, h + 0.08, Math.sin(yaw + 1.3) * off];
      const rise = 0.45 + rng() * 0.3;
      const reach = 1.5 + rng() * 0.3;
      const tip: Vec3 = [head[0] + Math.cos(yaw) * Math.cos(rise) * reach, head[1] + Math.sin(rise) * reach, head[2] + Math.sin(yaw) * Math.cos(rise) * reach];
      const handle = between(ORIGIN, head, tip);
      shape.beam(ORIGIN, head, tip, 0.09, 0.12, ctx.paint("handle"), { taper: [1.1, 0.8] });
      // The blade: down into the wood, square to the handle's flat.
      const blade = turned(moved(handle, [0, 0, 0.02]), "x", rise);
      shape.box(moved(blade, [0, -0.06, 0.06]), [0.04, 0.24, 0.18], ctx.paint("iron"));
    }
    const billets = ctx.count("billets");
    const first = rng() * Math.PI * 2;
    for (let n = 0; n < billets; n++) {
      // A wedge of split wood lying on a flat side, spread round the block so none lies on another.
      const around = first + ((n + 0.2 + rng() * 0.6) / billets) * Math.PI * 2;
      const br = 0.12 + rng() * 0.06;
      const bl = 0.55 + rng() * 0.3;
      // Far enough out that its near end, however it lies, keeps clear of the block.
      const away = r + bl / 2 + 0.15 + rng() * 0.7;
      // Lying roughly out from the block, as they fell from it.
      const yaw = around + (rng() - 0.5) * 1.2;
      const centre: Vec3 = [Math.cos(around) * away, br * 0.5, Math.sin(around) * away];
      const half: Vec3 = [Math.cos(yaw) * bl * 0.5, 0, Math.sin(yaw) * bl * 0.5];
      const from: Vec3 = [centre[0] - half[0], centre[1], centre[2] - half[2]];
      const to: Vec3 = [centre[0] + half[0], centre[1], centre[2] + half[2]];
      shape.cylinder(turned(between(ORIGIN, from, to), "z", Math.PI / 2), bl, br, ctx.paint("wood"), { ends: ctx.paint("end"), sides: 3 });
    }
  },
};

/** A sawbuck: two X-shaped trestles joined by a rail, a log laid in their crotches for sawing. */
export const sawbuck: PropGenerator = {
  doc: "A sawbuck - two crossed-leg trestles and a rail.",
  params: {
    length: { kind: "range", default: [2.2, 3.0], min: 0.5, doc: "between its trestles' outsides" },
    height: { kind: "range", default: [1.6, 1.9], min: 0.3, doc: "how high its legs' tops reach" },
    spread: { kind: "range", default: [0.7, 0.9], min: 0.1, doc: "how far each foot stands out from its middle" },
  },
  parts: ["wood"],
  build(ctx) {
    const { shape } = ctx;
    const length = ctx.range("length");
    const height = ctx.range("height");
    const spread = ctx.range("spread");
    const leg = 0.14;
    // Each leg from its foot to past the crossing; the crossing a little over half way up.
    const crossing = height * 0.55;
    const ends = [-length / 2 + leg, length / 2 - leg];
    for (const x of ends) {
      for (const side of [-1, 1]) {
        const lean = side * 0.06;
        shape.beam(ORIGIN, [x + lean, 0, side * spread], [x - lean, height, -side * spread * 0.7], leg, leg, ctx.paint("wood"), { collide: true, taper: [1, 0.8] });
      }
    }
    // The rail joining the crossings, and a brace across each trestle's feet.
    shape.beam(ORIGIN, [ends[0] - leg, crossing * 0.85, 0], [ends[1] + leg, crossing * 0.85, 0], leg * 0.9, leg * 0.9, ctx.paint("wood"), { collide: true });
    if (!ctx.far) for (const x of ends) shape.beam(ORIGIN, [x, height * 0.18, -spread * 0.8], [x, height * 0.18, spread * 0.8], leg * 0.6, leg * 0.8, ctx.paint("wood"));
  },
};

/** A crate of boards, battens down its corners and round its top and foot. */
export const crate: PropGenerator = {
  doc: "A boarded crate with battened edges.",
  params: {
    width: { kind: "range", default: [1.0, 1.6], min: 0.2, doc: "across its front" },
    depth: { kind: "range", default: [1.0, 1.4], min: 0.2, doc: "front to back" },
    height: { kind: "range", default: [0.9, 1.3], min: 0.2, doc: "how high" },
  },
  parts: ["boards", "battens"],
  build(ctx) {
    const { shape } = ctx;
    const w = ctx.range("width") / 2;
    const d = ctx.range("depth") / 2;
    const h = ctx.range("height");
    shape.box(moved(ORIGIN, [0, h / 2, 0]), [w, h / 2, d], ctx.paint("boards"), { bottom: false, collide: true });
    if (ctx.far) return;
    const t = 0.07;
    const battens = ctx.paint("battens");
    // Every batten stands proud of the boards it lies on, its top over the crate's top, and keeps
    // clear of the battens it meets - no face of it in another's plane (see propShapes.ts).
    // Down each corner, standing proud of both faces and a little over the top.
    const cornerTop = h + 2 * PROUD;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) shape.box(moved(ORIGIN, [sx * (w - t + PROUD), cornerTop / 2, sz * (d - t + PROUD)]), [t, cornerTop / 2, t], battens, { bottom: false });
    // Round the top - its top a little over the boards' - and the foot, on the ground: each stopping
    // short of the corner battens.
    for (const [y0, y1] of [[0, 2 * t], [h - 2 * t + PROUD, h + PROUD]]) {
      const mid = (y0 + y1) / 2;
      const half = (y1 - y0) / 2;
      const onGround = y0 === 0;
      for (const sz of [-1, 1]) shape.box(moved(ORIGIN, [0, mid, sz * (d + PROUD - t / 2)]), [w - t * 2 - PROUD, half, t / 2], battens, { bottom: !onGround });
      for (const sx of [-1, 1]) shape.box(moved(ORIGIN, [sx * (w + PROUD - t / 2), mid, 0]), [t / 2, half, d - t * 2 - PROUD], battens, { bottom: !onGround });
    }
  },
};

/** A barrel of staves, bulging at its middle, iron hoops round it, its head boarded. */
export const barrel: PropGenerator = {
  doc: "A coopered barrel with iron hoops.",
  params: {
    height: { kind: "range", default: [1.6, 2.0], min: 0.2, doc: "how tall" },
    radius: { kind: "range", default: [0.5, 0.62], min: 0.1, doc: "its radius at the ends" },
    bulge: { kind: "range", default: [0.08, 0.14], min: 0, doc: "how much wider it is at its middle" },
  },
  parts: ["staves", "hoops", "head"],
  build(ctx) {
    const { shape } = ctx;
    const h = ctx.range("height");
    const r = ctx.range("radius");
    const bulge = ctx.range("bulge");
    const radiusAt = (y: number): number => r + bulge * Math.sin((Math.PI * y) / h);
    const steps = ctx.far ? 4 : 8;
    const profile: [number, number][] = Array.from({ length: steps + 1 }, (_, i) => {
      const y = (h * i) / steps;
      return [radiusAt(y), y];
    });
    // The staves' boards standing up it.
    shape.lathe(ORIGIN, profile, ctx.paint("staves"), { top: ctx.paint("head"), collide: true, turned: true });
    if (ctx.far) return;
    for (const share of [0.1, 0.32, 0.68, 0.9]) {
      const y = h * share;
      const band = 0.05;
      shape.lathe(ORIGIN, [[radiusAt(y - band) + 0.02, y - band], [radiusAt(y) + 0.025, y], [radiusAt(y + band) + 0.02, y + band]], ctx.paint("hoops"));
    }
  },
};

/**
 * A grindstone for the axes: a stone wheel on an iron axle across a frame of rails on four legs, a
 * crank on the axle's end, and a trough of water under the wheel for it to turn through.
 */
export const grindstone: PropGenerator = {
  doc: "A grindstone - a stone wheel in a wooden frame, a crank, a water trough under it.",
  params: {
    radius: { kind: "range", default: [0.6, 0.78], min: 0.2, doc: "the wheel's radius" },
    thickness: { kind: "range", default: [0.22, 0.32], min: 0.05, doc: "the wheel's thickness" },
    height: { kind: "range", default: [1.25, 1.4], min: 0.4, doc: "the axle's height" },
  },
  parts: ["frame", "stone", "trough", "water", "iron"],
  build(ctx) {
    const { shape } = ctx;
    const r = ctx.range("radius");
    const t = ctx.range("thickness");
    // The wheel's foot dips into the trough under it.
    const h = Math.max(ctx.range("height"), r + 0.45);
    const frame = ctx.paint("frame");
    const iron = ctx.paint("iron");
    const stone = ctx.paint("stone");
    shape.cylinder(between(ORIGIN, [0, h, -t / 2], [0, h, t / 2]), t, r, stone, { ends: stone, collide: true, sides: ctx.far ? 8 : 16 });
    // The rails either side of the wheel, along it, the axle resting on them; a leg under each end.
    const leg = 0.16;
    const half = r + 0.35;
    const railZ = t / 2 + 0.12 + leg / 2;
    for (const side of [-1, 1]) {
      shape.beam(ORIGIN, [-half, h - 0.08, side * railZ], [half, h - 0.08, side * railZ], leg, leg, frame, { collide: true });
      for (const end of [-1, 1]) {
        // Splayed a little out at the foot.
        shape.beam(ORIGIN, [end * (half - leg), 0, side * (railZ + 0.12)], [end * (half - leg), h - 0.08 - leg / 2, side * railZ], leg, leg, frame, { collide: true, taper: [0.85, 1] });
      }
    }
    // The trough between the legs, its water just over the wheel's foot.
    const troughTop = h - r + 0.14;
    const troughHalf: Vec3 = [r * 0.8, troughTop / 2, t / 2 + 0.1];
    shape.box(moved(ORIGIN, [0, troughTop / 2, 0]), troughHalf, ctx.paint("trough"), { bottom: false, top: ctx.paint("water"), collide: true });
    if (ctx.far) return;
    // The axle through the wheel and out over the rails, on the crank's side further.
    const reach = railZ + leg / 2 + 0.25;
    shape.cylinder(between(ORIGIN, [0, h, -railZ - leg / 2 - 0.05], [0, h, reach]), railZ + leg / 2 + 0.05 + reach, 0.045, iron, { ends: iron, sides: 6 });
    // The crank: an arm down off the axle's end, a handle out from its foot.
    const arm = 0.35;
    const turn = ctx.rng() * Math.PI * 2;
    const foot: Vec3 = [Math.sin(turn) * arm, h - Math.cos(turn) * arm, reach];
    shape.beam(ORIGIN, [0, h, reach], foot, 0.06, 0.06, iron);
    shape.cylinder(between(ORIGIN, foot, [foot[0], foot[1], reach + 0.3]), 0.3, 0.05, frame, { ends: frame, sides: 6 });
  },
};

/**
 * A field gate where a lane comes in: two posts across the lane, a leaf of rails and a brace hung on
 * one of them and swung open into the place - never shut: a lane's gate is its only way in - and
 * a short run of rail fence out from each post. Its front (+z) faces out along the lane.
 */
export const gate: PropGenerator = {
  doc: "A field gate - two posts, a railed leaf swung open, a little fence out from each post.",
  params: {
    opening: { kind: "range", default: [3.8, 4.4], min: 1, doc: "between the posts" },
    height: { kind: "range", default: [1.5, 1.7], min: 0.5, doc: "the leaf's height" },
    open: { kind: "range", default: [70, 110], min: 10, doc: "how far the leaf stands open (degrees)" },
    wings: { kind: "range", default: [1.5, 3], min: 0, doc: "how far the fence runs out from each post" },
  },
  parts: ["posts", "rails"],
  build(ctx) {
    const { shape, rng } = ctx;
    const opening = ctx.range("opening");
    const h = ctx.range("height");
    const open = (ctx.range("open") * Math.PI) / 180;
    const wings = ctx.range("wings");
    const posts = ctx.paint("posts");
    const rails = ctx.paint("rails");
    const post = 0.3;
    const postTop = h + 0.35;
    const postX = opening / 2 + post / 2;
    for (const side of [-1, 1]) shape.box(moved(ORIGIN, [side * postX, postTop / 2, 0]), [post / 2, postTop / 2, post / 2], posts, { bottom: false, collide: true, taper: [1, 0.9], taperAxis: "y" });
    // The leaf, from its hinge by one post, swung back (toward -z, into the place).
    const hinge = rng() < 0.5 ? -1 : 1;
    const leafFrame = turned(moved(ORIGIN, [hinge * opening / 2, 0, -post / 2 - 0.08]), "y", hinge < 0 ? open : Math.PI - open);
    const length = opening - 0.1;
    const bar = 0.1;
    const foot = 0.25;
    const railYs = ctx.far ? [foot, h] : [foot, foot + (h - foot) * 0.35, foot + (h - foot) * 0.68, h];
    railYs.forEach((y, i) => shape.beam(leafFrame, [0, y, 0], [length, y, 0], bar, i === railYs.length - 1 ? bar * 1.4 : bar, rails, { collide: i === 0 || i === railYs.length - 1 }));
    // Its stiles at each end, and a brace from the hinge's foot up to the far top.
    for (const x of [bar / 2, length - bar / 2]) shape.beam(leafFrame, [x, foot - bar, PROUD], [x, h + bar * 0.7, PROUD], bar * 1.3, bar, rails, { collide: true });
    if (!ctx.far) shape.beam(leafFrame, [bar * 1.5, foot + bar, -PROUD], [length - bar * 1.5, h - bar, -PROUD], bar, bar * 0.8, rails);
    // The fence out from each post: two rails to a post at its end, another half way if it is long.
    if (wings <= 0.3) return;
    for (const side of [-1, 1]) {
      const from = side * (postX + post / 2);
      const to = side * (postX + post / 2 + wings);
      const stakes = wings > 2.5 ? [to - side * wings / 2, to] : [to];
      for (const x of stakes) shape.box(moved(ORIGIN, [x, (h + 0.15) / 2, 0]), [0.1, (h + 0.15) / 2, 0.1], posts, { bottom: false, collide: true });
      for (const y of [h * 0.45, h * 0.9]) shape.beam(ORIGIN, [from, y, 0.12], [to + side * 0.1, y, 0.12], 0.09, 0.12, rails, { collide: true });
    }
  },
};
