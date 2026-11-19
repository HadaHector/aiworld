// Crystals (DUNGEONS.md, *Light*): a cluster grown from the rock of a cave - six-sided prisms ending
// in points, leaning out from a common root, the tallest near its middle, glowing cold from inside.
import type { PropGenerator } from "../propGenerator";
import { ORIGIN, moved, turned } from "../propShapes";

export const crystals: PropGenerator = {
  doc: "A cluster of glowing crystals, prisms ending in points, leaning out from one root.",
  params: {
    count: { kind: "count", default: [5, 9], min: 1, doc: "how many crystals" },
    height: { kind: "range", default: [1.0, 3.4], min: 0.1, doc: "each crystal's length, rolled for each (the middle's longest)" },
    radius: { kind: "range", default: [0.14, 0.34], min: 0.02, doc: "each crystal's thickness, rolled for each" },
    lean: { kind: "range", default: [0.15, 0.75], min: 0, doc: "how far each leans from upright (radians)" },
    spread: { kind: "range", default: [0.35, 0.7], min: 0, doc: "how far from the middle their roots stand" },
  },
  parts: ["crystal", "root"],
  build(ctx) {
    const glow = ctx.paint("crystal");
    const root = ctx.paint("root");
    const n = ctx.count("count");
    const spread = ctx.range("spread");
    const [h0, h1] = ctx.bounds("height");
    const [r0, r1] = ctx.bounds("radius");
    const [l0, l1] = ctx.bounds("lean");
    // The rock they grow from: a low lump.
    ctx.shape.lathe(ORIGIN, [[spread + 0.25, -0.1], [spread + 0.15, 0.08], [spread * 0.4, 0.16], [0.001, 0.18]], root, { sides: 7 });
    let tallest = 0;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + ctx.rng() * 0.8;
      const d = k === 0 ? 0 : spread * (0.4 + 0.6 * ctx.rng());
      // The middle's upright and longest; those round it lean outward and are shorter.
      const out = d / Math.max(spread, 1e-3);
      const lean = k === 0 ? l0 * 0.3 : l0 + (l1 - l0) * (0.4 + 0.6 * out) * ctx.rng();
      const h = (h0 + (h1 - h0) * ctx.rng()) * (k === 0 ? 1 : 1 - 0.45 * out);
      const r = r0 + (r1 - r0) * ctx.rng();
      // Lean away from the middle: turned about the horizontal axis square to its bearing.
      let f = moved(ORIGIN, [Math.cos(a) * d, 0.05, Math.sin(a) * d]);
      f = turned(f, "y", -a);
      f = turned(f, "z", -lean);
      f = turned(f, "y", ctx.rng() * Math.PI);
      const tip = r * (1.6 + ctx.rng());
      ctx.shape.lathe(f, [[r * 0.8, -0.15], [r, 0.1], [r, h - tip], [0.001, h]], glow, { sides: 6 });
      tallest = Math.max(tallest, h * Math.cos(lean));
    }
    ctx.light([0, Math.max(0.6, tallest * 0.6), 0]);
  },
};
