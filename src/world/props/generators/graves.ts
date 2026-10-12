import type { Vec3 } from "../../buildings/buildingGeometry";
import type { Paint } from "../../buildings/buildingTypes";
import type { PropGenerator } from "../propGenerator";
import { at, moved, ORIGIN, turned, between, type Frame, type Shaper } from "../propShapes";
import { emblem, EMBLEMS, type Emblem } from "../emblems";

/**
 * A churchyard's pieces: its grave markers - a headstone, a wooden post, a tomb or a slab - and its
 * lychgate. Markers stand plumb on the ground as it lies (PropDef.ground "plumb"), sunk into it, a
 * little out of true as old ones are.
 */

/** How far a marker is sunk into the ground. */
const SINK = 0.25;

/** A marker's lean: a few degrees off upright, back or forward and a little sideways - its frame. */
function leaning(maxDegrees: number, rng: () => number): Frame {
  const lean = ((rng() - 0.5) * 2 * maxDegrees * Math.PI) / 180;
  const side = ((rng() - 0.5) * maxDegrees * Math.PI) / 180;
  return turned(turned(ORIGIN, "x", lean), "z", side);
}

/**
 * A flat piece cut to an outline: `profile` (x, y in its own plane, round its outline, convex) given
 * depth `thickness` along z, centred on z 0 - its two faces and its edges; none along its foot,
 * which is in the ground.
 */
function extrude(shape: Shaper, f: Frame, profile: [number, number][], thickness: number, paint: Paint): void {
  const half = thickness / 2;
  const front = profile.map(([x, y]) => at(f, [x, y, half]));
  const back = profile.map(([x, y]) => at(f, [x, y, -half]));
  shape.b.face(front, f.z, paint);
  shape.b.face([...back].reverse(), [-f.z[0], -f.z[1], -f.z[2]], paint);
  for (let i = 0; i < profile.length; i++) {
    const j = (i + 1) % profile.length;
    const [ax, ay] = profile[i];
    const [bx, by] = profile[j];
    // The foot (the first edge, along the bottom) stays in the ground.
    if (i === 0) continue;
    const ex = bx - ax;
    const ey = by - ay;
    const l = Math.hypot(ex, ey) || 1;
    const n: Vec3 = [f.x[0] * (ey / l) - f.y[0] * (ex / l), f.x[1] * (ey / l) - f.y[1] * (ex / l), f.x[2] * (ey / l) - f.y[2] * (ex / l)];
    shape.b.face([front[i], back[i], back[j], front[j]], n, paint);
  }
}

/**
 * A headstone: an upright slab sunk in the ground, its top round, gabled or square, its faith's
 * emblem (see emblems.ts) proud on its face now and then - leaning a little, as old ones do.
 */
export const headstone: PropGenerator = {
  doc: "A headstone - an upright slab, its top round, gabled or square, an emblem on its face.",
  params: {
    width: { kind: "range", default: [0.5, 0.75], min: 0.1, doc: "across its face" },
    height: { kind: "range", default: [0.7, 1.0], min: 0.1, doc: "above the ground" },
    thickness: { kind: "range", default: [0.12, 0.16], min: 0.03, doc: "front to back" },
    round: { kind: "chance", default: 0.45, doc: "how likely its top is rounded" },
    gabled: { kind: "chance", default: 0.25, doc: "how likely, if not rounded, its top is gabled" },
    emblem: { kind: "chance", default: 0.6, doc: "how likely an emblem stands proud on its face" },
    emblems: { kind: "choice", options: EMBLEMS, default: ["ringDot"], doc: "the emblems it may bear (one picked)" },
    lean: { kind: "number", default: 6, min: 0, doc: "how far it may lean, degrees" },
  },
  parts: ["stone"],
  build(ctx) {
    const { shape, rng } = ctx;
    const stone = ctx.paint("stone");
    const w = ctx.range("width");
    const h = ctx.range("height");
    const t = ctx.range("thickness");
    const f = leaning(ctx.number("lean"), rng);
    const hw = w / 2;
    const profile: [number, number][] = [[-hw, -SINK], [hw, -SINK]];
    if (ctx.chance("round")) {
      const steps = ctx.far ? 3 : 7;
      for (let k = 0; k <= steps; k++) {
        const a = (k / steps) * Math.PI;
        profile.push([Math.cos(a) * hw, h - hw + Math.sin(a) * hw]);
      }
    } else if (ctx.chance("gabled")) {
      profile.push([hw, h - hw * 0.5], [0, h], [-hw, h - hw * 0.5]);
    } else {
      profile.push([hw, h], [-hw, h]);
    }
    extrude(shape, f, profile, t, stone);
    shape.solid([[-hw, 0, -t / 2], [hw, 0, -t / 2], [-hw, 0, t / 2], [hw, 0, t / 2], at(f, [-hw, h * 0.8, -t / 2]), at(f, [hw, h * 0.8, -t / 2]), at(f, [-hw, h * 0.8, t / 2]), at(f, [hw, h * 0.8, t / 2])]);
    if (!ctx.chance("emblem")) return;
    // Its faith's emblem, proud on its face, high on it.
    const size = Math.min(w * 0.55, h * 0.4);
    emblem(shape, moved(f, [0, h - hw * 0.9 - size * 0.25, t / 2]), ctx.choice("emblems") as Emblem, size, stone, ctx.far);
  },
};

/**
 * A wooden grave post: a squared upright sunk at a grave's head, a board nailed high on its face
 * bearing its faith's emblem (see emblems.ts), now and then a little roof of two boards over it - the
 * dead kept under a roof - grey with weather, leaning.
 */
export const gravePost: PropGenerator = {
  doc: "A wooden grave post - an upright, an emblem board high on it, now and then a little roof.",
  params: {
    height: { kind: "range", default: [1.3, 1.7], min: 0.3, doc: "above the ground" },
    board: { kind: "range", default: [0.32, 0.42], min: 0.1, doc: "its board's width and height" },
    roof: { kind: "chance", default: 0.4, doc: "how likely a little roof stands over its board" },
    emblems: { kind: "choice", options: EMBLEMS, default: ["ringDot"], doc: "the emblems its board may bear (one picked)" },
    lean: { kind: "number", default: 8, min: 0, doc: "how far it may lean, degrees" },
  },
  parts: ["wood", "roof", "emblem"],
  build(ctx) {
    const { shape, rng } = ctx;
    const wood = ctx.paint("wood");
    const h = ctx.range("height");
    const size = ctx.range("board");
    const f = leaning(ctx.number("lean"), rng);
    const post = 0.12;
    shape.beam(f, [0, -SINK, 0], [0, h, 0], post, post, wood, { collide: true });
    // The board, high on its face, and the emblem on it.
    const boardY = h - size / 2 - 0.08;
    const board = 0.04;
    shape.box(moved(f, [0, boardY, post / 2 + board / 2]), [size / 2, size / 2, board / 2], wood);
    emblem(shape, moved(f, [0, boardY, post / 2 + board]), ctx.choice("emblems") as Emblem, size * 0.72, ctx.paint("emblem"), ctx.far);
    if (ctx.far || !ctx.chance("roof")) return;
    // Two boards meeting over it, pitched like a house's roof.
    const roof = ctx.paint("roof");
    const eaveY = h - 0.02;
    const ridge = eaveY + 0.22;
    for (const side of [-1, 1]) {
      const eave: Vec3 = [side * (size / 2 + 0.08), eaveY, 0];
      const top: Vec3 = [0, ridge, 0];
      const frame = between(f, eave, top);
      const length = Math.hypot(eave[0], eave[1] - ridge);
      shape.box(moved(frame, [0, 0, length / 2]), [0.14, 0.012, length / 2 + 0.02], roof);
    }
  },
};

/**
 * A tomb: a stone chest under a lid that overhangs it - a table tomb - or, with no chest, the lid
 * alone laid flat on the grave (a ledger slab), just proud of the grass.
 */
export const tomb: PropGenerator = {
  doc: "A tomb - a stone chest under an overhanging lid, or the lid alone, flat on the grave.",
  params: {
    length: { kind: "range", default: [1.9, 2.2], min: 0.3, doc: "the lid's length" },
    width: { kind: "range", default: [0.85, 1.05], min: 0.2, doc: "the lid's width" },
    height: { kind: "range", default: [0.6, 0.8], min: 0, doc: "the chest's height - 0 for a slab alone" },
    lid: { kind: "range", default: [0.1, 0.14], min: 0.02, doc: "the lid's thickness" },
    overhang: { kind: "range", default: [0.06, 0.1], min: 0, doc: "how far the lid overhangs the chest" },
    askew: { kind: "chance", default: 0.08, doc: "how likely its lid has been shoved aside" },
  },
  parts: ["stone", "lid"],
  build(ctx) {
    const { shape, rng } = ctx;
    const stone = ctx.paint("stone");
    const lidPaint = ctx.paint("lid");
    const l = ctx.range("length");
    const w = ctx.range("width");
    const h = ctx.range("height");
    const lid = ctx.range("lid");
    const over = h > 0 ? ctx.range("overhang") : 0;
    if (h > 0) shape.box(moved(ORIGIN, [0, (h - SINK) / 2, 0]), [w / 2 - over, (h + SINK) / 2, l / 2 - over], stone, { bottom: false, collide: true });
    // A slab alone lies a hand proud of the ground, most of it sunk.
    const base = h > 0 ? h : -lid + 0.06;
    let frame = moved(ORIGIN, [0, base + lid / 2, 0]);
    if (h > 0 && ctx.chance("askew")) frame = turned(moved(frame, [(rng() - 0.5) * 0.3, 0, l * 0.18]), "y", (rng() - 0.5) * 0.5);
    shape.box(frame, [w / 2, lid / 2, l / 2], lidPaint, { collide: h > 0, bevel: ctx.far ? 0 : 0.02 });
  },
};

/**
 * A lychgate: a roofed gateway into a churchyard - four posts, a beam along each side and across
 * each end, a steep roof of two boarded slopes over the way through (its ridge across it, along the
 * wall), its gable ends boarded; a bench along each side under it, where the coffin and its bearers
 * waited. No leaf: it stands open. Its front (+z) faces out.
 */
export const lychgate: PropGenerator = {
  doc: "A lychgate - four posts under a steep roof over the way in, benches under it.",
  params: {
    opening: { kind: "range", default: [2.4, 2.8], min: 1, doc: "the way through, between its posts" },
    depth: { kind: "range", default: [1.8, 2.2], min: 0.5, doc: "front to back, post to post" },
    height: { kind: "range", default: [2.3, 2.6], min: 1.5, doc: "to its eaves" },
    pitch: { kind: "range", default: [45, 52], min: 20, doc: "its roof's pitch, degrees" },
    bench: { kind: "chance", default: 0.7, doc: "how likely benches stand under it" },
  },
  parts: ["posts", "roof", "bench"],
  build(ctx) {
    const { shape } = ctx;
    const posts = ctx.paint("posts");
    const roof = ctx.paint("roof");
    const opening = ctx.range("opening");
    const depth = ctx.range("depth");
    const h = ctx.range("height");
    const pitch = (ctx.range("pitch") * Math.PI) / 180;
    const post = 0.22;
    const px = opening / 2 + post / 2;
    const pz = depth / 2;
    // Its posts sunk well into the ground: it stands plumb on the ground as it lies (no level ground
    // of its own - so no bank by the graves), one corner's foot lower than another's.
    const sunk = 0.6;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) shape.box(moved(ORIGIN, [sx * px, (h - sunk) / 2, sz * pz]), [post / 2, (h + sunk) / 2, post / 2], posts, { bottom: false, collide: true, bevel: ctx.far ? 0 : 0.02 });
    // The beams: along each side and across each end, on the posts' heads.
    const beam = 0.18;
    for (const sx of [-1, 1]) shape.beam(ORIGIN, [sx * px, h + beam / 2, -pz - 0.3], [sx * px, h + beam / 2, pz + 0.3], post, beam, posts);
    for (const sz of [-1, 1]) shape.beam(ORIGIN, [-px - post / 2, h - beam / 2, sz * pz], [px + post / 2, h - beam / 2, sz * pz], beam * 0.8, beam, posts);
    // The roof: two slopes from eaves past the posts up to a ridge over the middle, as wide as the
    // gate's posts (so a wall runs up to its sides).
    const eave = pz + 0.45;
    const ridge = h + beam + eave * Math.tan(pitch);
    const half = px + post / 2;
    for (const side of [-1, 1]) {
      const from: Vec3 = [0, h + beam, side * eave];
      const to: Vec3 = [0, ridge, 0];
      const frame = between(ORIGIN, from, to);
      const length = Math.hypot(eave, ridge - h - beam);
      shape.box(moved(frame, [0, 0.05, length / 2]), [half, 0.05, length / 2 + 0.04], roof);
    }
    // Its gables boarded, both ends.
    for (const sx of [-1, 1]) {
      const x = sx * (half - 0.03);
      const corners: Vec3[] = [[x, h + beam, -eave + 0.2], [x, h + beam, eave - 0.2], [x, ridge - 0.2, 0]];
      shape.b.face(corners, [sx, 0, 0], posts);
      shape.b.face([...corners].reverse(), [-sx, 0, 0], posts);
    }
    if (ctx.far || !ctx.chance("bench")) return;
    const bench = ctx.paint("bench");
    for (const sx of [-1, 1]) {
      const x = sx * (px - post / 2 - 0.22);
      shape.box(moved(ORIGIN, [x, 0.43, 0]), [0.2, 0.03, pz - post / 2], bench);
      for (const sz of [-1, 1]) shape.box(moved(ORIGIN, [x, 0.2, sz * (pz - post)]), [0.16, 0.2, 0.04], bench, { bottom: false });
    }
  },
};
