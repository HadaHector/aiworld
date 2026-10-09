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
