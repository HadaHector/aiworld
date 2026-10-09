import type { PropGenerator } from "../propGenerator";
import { ORIGIN, between, turned, moved, type Frame } from "../propShapes";
import type { Vec3 } from "../../buildings/buildingGeometry";

/**
 * Logs: a stack of them, and one felled - bark round them, their sawn ends' rings each off its own
 * heart.
 */

/** A stack of logs lying side by side along x, each row nested in the hollows of the one under it,
 *  narrowing to the top - between stakes driven in at its sides. */
export const logStack: PropGenerator = {
  doc: "Logs stacked in a pyramid between stakes.",
  params: {
    length: { kind: "range", default: [3.6, 5.2], min: 0.5, doc: "each log's length (metres)" },
    radius: { kind: "range", default: [0.24, 0.36], min: 0.05, doc: "each log's radius" },
    bottom: { kind: "count", default: [3, 5], min: 1, doc: "logs in the bottom row" },
    rows: { kind: "count", default: [2, 4], min: 1, doc: "rows, each a log fewer than the one under it" },
    stakes: { kind: "chance", default: 0.7, doc: "how likely it is held between stakes" },
  },
  parts: ["bark", "end"],
  build(ctx) {
    const { shape, rng } = ctx;
    const length = ctx.range("length");
    const [rLo, rHi] = ctx.bounds("radius");
    const spacing = rLo + rHi;
    const bottom = ctx.count("bottom");
    const rows = Math.min(ctx.count("rows"), bottom);
    const rise = spacing * Math.sin(Math.PI / 3);
    for (let k = 0; k < rows; k++) {
      const n = bottom - k;
      for (let i = 0; i < n; i++) {
        const r = rLo + (rHi - rLo) * rng();
        const z = (i - (n - 1) / 2) * spacing;
        const y = spacing / 2 + k * rise - (spacing / 2 - r);
        // Each a little shorter or longer, slid a little along, turned a little off true.
        const l = length * (0.9 + rng() * 0.1);
        const shift = (rng() - 0.5) * 0.3;
        const skew = (rng() - 0.5) * 0.12;
        const from: Vec3 = [-l / 2 + shift, y, z - skew];
        const to: Vec3 = [l / 2 + shift, y, z + skew];
        shape.cylinder(between(ORIGIN, from, to), l, r, ctx.paint("bark"), { ends: ctx.paint("end"), heart: [(rng() - 0.5) * r * 0.6, (rng() - 0.5) * r * 0.6] });
      }
    }
    const top = spacing / 2 + (rows - 1) * rise + spacing / 2;
    const halfBottom = (bottom * spacing) / 2;
    const halfTop = ((bottom - rows + 1) * spacing) / 2;
    // In the way as one piece: its section, the length of it.
    const points: Vec3[] = [];
    for (const x of [-length / 2, length / 2]) points.push([x, 0, -halfBottom], [x, 0, halfBottom], [x, top, -halfTop], [x, top, halfTop]);
    shape.solid(points);
    if (ctx.chance("stakes")) {
      for (const x of [-length * 0.3, length * 0.3]) {
        for (const side of [-1, 1]) {
          const r = 0.07 + rng() * 0.03;
          const z = side * (halfBottom + r + 0.02);
          const height = top * (0.75 + rng() * 0.25) + 0.3;
          const lean = (rng() - 0.5) * 0.15;
          shape.cylinder(between(ORIGIN, [x, -0.3, z], [x + lean, height - 0.3, z + side * 0.05], [0, 0, 1]), height, [r, r * 0.8], ctx.paint("bark"), { ends: ctx.paint("end"), caps: "end" });
        }
      }
    }
  },
};

/** A felled trunk lying on the ground, lopped: tapering from its sawn butt to its cut top, stubs of
 *  its branches standing off it - never down into the ground. */
export const felledLog: PropGenerator = {
  doc: "One felled trunk, lopped, lying.",
  params: {
    length: { kind: "range", default: [6, 11], min: 1, doc: "its length" },
    radius: { kind: "range", default: [0.32, 0.5], min: 0.05, doc: "its radius at the butt" },
    taper: { kind: "range", default: [0.55, 0.75], min: 0.1, doc: "its top's radius, as a share of its butt's" },
    stubs: { kind: "count", default: [2, 6], min: 0, doc: "stubs of lopped branches" },
  },
  parts: ["bark", "end"],
  build(ctx) {
    const { shape, rng } = ctx;
    const length = ctx.range("length");
    const r0 = ctx.range("radius");
    const r1 = r0 * ctx.range("taper");
    // Its underside on the ground all along: its axis falls from the butt to the top.
    const log = between(ORIGIN, [-length / 2, r0 - 0.04, 0], [length / 2, r1 - 0.04, 0]);
    shape.cylinder(log, length, [r0, r1], ctx.paint("bark"), { ends: ctx.paint("end"), heart: [(rng() - 0.5) * r0 * 0.5, (rng() - 0.5) * r0 * 0.5], collide: true });
    if (ctx.far) return;
    const stubs = ctx.count("stubs");
    for (let n = 0; n < stubs; n++) {
      const t = 0.3 + rng() * 0.65;
      const r = r0 + (r1 - r0) * t;
      // Round the trunk, but never pointing into the ground: from straight up to level either side.
      const around = (rng() - 0.5) * Math.PI * 1.2 + Math.PI / 2;
      const base: Frame = moved(log, [0, 0, t * length]);
      const out = turned(turned(base, "z", around - Math.PI / 2), "x", -Math.PI / 2 + (rng() - 0.5) * 0.6);
      const stubR = r * (0.25 + rng() * 0.15);
      const stubLength = r + 0.15 + rng() * 0.45;
      shape.cylinder(out, stubLength, [stubR, stubR * 0.8], ctx.paint("bark"), { ends: ctx.paint("end"), caps: "end" });
    }
  },
};
