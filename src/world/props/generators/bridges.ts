import type { Vec3 } from "../../buildings/buildingGeometry";
import type { LineRun, PropContext, PropGenerator } from "../propGenerator";
import { ORIGIN, type Frame } from "../propShapes";
import { walk } from "./walls";

/**
 * Bridges, laid along a road's deck over a river (see roads/bridges.ts): line props whose points are
 * the deck's surface, not the ground - LineRun.width how wide, LineRun.base how low their piers
 * reach (under the water, to the river's bed).
 */

/** The workbench's sample: a span this long, humped, over water this far below its ends. */
const SAMPLE_LENGTH = 60;
const SAMPLE_DEPTH = 6;

function sampleRun(): LineRun {
  // (Its hump as a road's bridge's would be over this length.)
  const points: Vec3[] = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    points.push([-SAMPLE_LENGTH / 2 + SAMPLE_LENGTH * t, (1 - Math.abs(2 * t - 1) ** 2.5) * SAMPLE_LENGTH * 0.06, 0]);
  }
  return { points, ends: ["free", "free"], breach: false, width: 13, base: -SAMPLE_DEPTH };
}

/** A frame at a point of the run, its x across the deck, its z along it. */
function across(p: Vec3, dx: number, dz: number): Frame {
  return { origin: p, x: [-dz, 0, dx], y: [0, 1, 0], z: [dx, 0, dz] };
}

/**
 * A bridge of stone piers carrying a timber deck: a plank deck on two stringers, a post-and-rail
 * handrail either side; under it, a pier of dressed stone every `span` metres or so - tapering a
 * little, a timber cap across its head - down to the river's bed, and a stone abutment at each bank.
 * The deck and its rails are in the way - walked on, and kept to.
 */
export const pierBridge: PropGenerator = {
  doc: "A bridge - stone piers carrying a timber deck on two stringers, a post-and-rail handrail either side.",
  params: {
    span: { kind: "range", default: [20, 26], min: 3, doc: "between its piers" },
    deck: { kind: "range", default: [0.56, 0.64], min: 0.05, doc: "the deck's thickness" },
    rail: { kind: "range", default: [1.05, 1.15], min: 0.3, doc: "the handrail's height" },
    lumber: { kind: "range", default: [0.24, 0.3], min: 0.03, doc: "how thick its handrail's posts and rails are" },
    pier: { kind: "range", default: [3.4, 4.2], min: 0.3, doc: "a pier's thickness along the bridge" },
    pierReach: { kind: "range", default: [1.4, 1.8], min: 0, doc: "how far a pier reaches past the deck either side" },
  },
  parts: ["stone", "deck", "beams", "rails"],
  build(ctx) {
    pierBridge.line!(ctx, sampleRun());
  },
  line(ctx, run) {
    const { shape } = ctx;
    const path = walk(run.points);
    if (path.length < 0.5) return;
    const w = run.width ?? 6;
    const base = run.base ?? -8;
    const deckT = ctx.range("deck");
    const railH = ctx.range("rail");
    const pierT = ctx.range("pier");
    const pierReach = ctx.range("pierReach");
    const lumber = ctx.range("lumber");
    const spanTarget = ctx.range("span");
    const deckPaint = ctx.paint("deck");
    const beams = ctx.paint("beams");
    const rails = ctx.paint("rails");
    const stone = ctx.paint("stone");
    const pts = run.points;

    // The deck: a plank slab along each segment, its top on the run's points, in the way; two
    // stringers under it.
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const l = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
      const dx = (b[0] - a[0]) / l;
      const dz = (b[2] - a[2]) / l;
      const over = 0.04;
      const from: Vec3 = [a[0] - dx * over, a[1] - deckT / 2, a[2] - dz * over];
      const to: Vec3 = [b[0] + dx * over, b[1] - deckT / 2, b[2] + dz * over];
      shape.beam(ORIGIN, from, to, w, deckT, deckPaint, { collide: true });
      if (ctx.far) continue;
      for (const side of [-1, 1]) {
        const off = side * (w / 2 - 0.9);
        const lift = deckT + 0.44;
        shape.beam(ORIGIN, [from[0] - dz * off, a[1] - lift, from[2] + dx * off], [to[0] - dz * off, b[1] - lift, to[2] + dx * off], 0.64, 0.88, beams);
      }
    }

    railings(ctx, run, w, railH, lumber, rails);

    // The piers: evenly along it, one at a join with the next stretch (that stretch's), an abutment
    // at each free end.
    const n = Math.max(1, Math.round(path.length / spanTarget));
    const pierAt = (s: number, abutment: boolean): void => {
      const p = path.at(s);
      const [dx, dz] = path.dir(s);
      // Under the stringers' feet - each piece stopping just short of the one over it, so no two faces
      // share a plane: the cap a hair under the stringers, the stone's head inside the cap.
      const capT = 0.48;
      const top = p[1] - deckT - 0.88 - 0.02;
      const stoneTop = abutment || ctx.far ? top : top - capT + 0.06;
      const height = stoneTop - base;
      if (height <= 0.2) return;
      const frame = across([p[0], base + height / 2, p[2]], dx, dz);
      const half: Vec3 = [w / 2 + pierReach + (abutment ? 0.4 : 0), height / 2, (abutment ? pierT * 1.3 : pierT) / 2];
      // Its courses level, however wide it is.
      shape.box(frame, half, stone, { bottom: false, collide: true, taper: [1, 0.92], grain: "y" });
      // A timber cap across its head, under the stringers.
      if (!ctx.far && !abutment) shape.box(across([p[0], top - capT / 2, p[2]], dx, dz), [w / 2 + 0.6, capT / 2, pierT / 2 + 0.2], beams);
    };
    if (run.ends[0] === "free") pierAt(Math.min(1, path.length / 2), true);
    for (let k = run.ends[0] === "join" ? 0 : 1; k < n; k++) pierAt((path.length * k) / n, false);
    if (run.ends[1] === "free") pierAt(Math.max(0, path.length - 1), true);
  },
};

/** A post-and-rail handrail along each side of a deck: posts every few metres, a top rail and a
 *  middle one between them following the deck - and in the way to its top rail, so nobody walks off. */
function railings(ctx: PropContext, run: LineRun, w: number, railH: number, lumber: number, paint: ReturnType<PropContext["paint"]>): void {
  const { shape } = ctx;
  const path = walk(run.points);
  const stations = path.stations(2.4);
  for (const side of [-1, 1]) {
    const off = side * (w / 2 - lumber);
    const posts = stations.map((s) => {
      const p = path.at(s);
      const [dx, dz] = path.dir(s);
      return { p: [p[0] - dz * off, p[1], p[2] + dx * off] as Vec3, dx, dz };
    });
    posts.forEach(({ p }, k) => {
      // A joined end's post is the next stretch's first.
      if (k === posts.length - 1 && run.ends[1] === "join") return;
      shape.box({ origin: [p[0], p[1] + railH / 2, p[2]], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, [lumber / 2, railH / 2 + lumber / 2, lumber / 2], paint, { bottom: false });
    });
    for (let k = 0; k + 1 < posts.length; k++) {
      const a = posts[k].p;
      const b = posts[k + 1].p;
      for (const y of ctx.far ? [railH] : [railH, railH * 0.5]) shape.beam(ORIGIN, [a[0], a[1] + y, a[2]], [b[0], b[1] + y, b[2]], lumber * 0.8, lumber, paint);
      const t = 0.08;
      const { dx, dz } = posts[k];
      shape.solid([
        [a[0] - dz * t, a[1], a[2] + dx * t], [a[0] + dz * t, a[1], a[2] - dx * t], [a[0] - dz * t, a[1] + railH, a[2] + dx * t], [a[0] + dz * t, a[1] + railH, a[2] - dx * t],
        [b[0] - dz * t, b[1], b[2] + dx * t], [b[0] + dz * t, b[1], b[2] - dx * t], [b[0] - dz * t, b[1] + railH, b[2] + dx * t], [b[0] + dz * t, b[1] + railH, b[2] - dx * t],
      ]);
    }
  }
}
