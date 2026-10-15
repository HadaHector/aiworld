import type { Vec3 } from "../../buildings/buildingGeometry";
import type { PropGenerator } from "../propGenerator";
import { at, moved, ORIGIN, PROUD } from "../propShapes";

/**
 * A fingerpost at a road junction: its post (`fingerpost`) and each of its arms (`fingerArm`) a prop
 * of its own - the arms set on the post at their heights, each turned down its own road, each saying
 * where that road leads (see roads/roadSigns.ts).
 */

/** A fingerpost's post: a squared post, tapering a little, a pyramid cap on its head. Its arms are
 *  set on it, at its axis. */
export const fingerpost: PropGenerator = {
  doc: "A fingerpost's post - squared, tapering, a little cap on its head; its arms are props of their own.",
  params: {
    height: { kind: "range", default: [3.0, 3.4], min: 1, doc: "the post's height" },
    thickness: { kind: "range", default: [0.18, 0.22], min: 0.05, doc: "how thick the post is" },
  },
  parts: ["post", "cap"],
  build(ctx) {
    const { shape } = ctx;
    const h = ctx.range("height");
    const t = ctx.range("thickness");
    shape.box(moved(ORIGIN, [0, h / 2 - 0.15, 0]), [t / 2, h / 2 + 0.15, t / 2], ctx.paint("post"), { bottom: false, collide: true, taper: [1, 0.88], bevel: ctx.far ? 0 : 0.02 });
    // The cap: a little pyramid over the post's head.
    const cap = ctx.paint("cap");
    const half = t * 0.62;
    const top: Vec3 = [0, h + 0.14, 0];
    const corners: Vec3[] = [[-half, h, -half], [half, h, -half], [half, h, half], [-half, h, half]];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[2] + b[2]) / 2;
      const l = Math.hypot(mx, mz) || 1;
      shape.b.face([a, b, top], [mx / l, 0.6, mz / l], cap);
    }
  },
};

/**
 * One arm of a fingerpost: a board from the post's face out along its +z, cut to a point at its
 * end - the way the road goes - painted with a band along each face. Its origin is at the post's axis,
 * its middle at the board's middle height.
 */
export const fingerArm: PropGenerator = {
  doc: "A fingerpost's arm - a board pointing down its road, its end cut to a point, a painted band along it.",
  params: {
    length: { kind: "range", default: [1.0, 1.2], min: 0.3, doc: "how far it reaches from the post's axis" },
    height: { kind: "range", default: [0.22, 0.26], min: 0.05, doc: "the board's height" },
    thickness: { kind: "number", default: 0.05, min: 0.01, doc: "the board's thickness" },
  },
  parts: ["board", "band"],
  build(ctx) {
    const { shape } = ctx;
    const length = ctx.range("length");
    const h = ctx.range("height");
    const t = ctx.number("thickness");
    const board = ctx.paint("board");
    // Its outline in its own plane (z along it, y up), from just inside the post to the point.
    const z0 = 0.05;
    const tip = length;
    const shoulder = length - h * 0.6;
    const outline: [number, number][] = [[z0, -h / 2], [shoulder, -h / 2], [tip, 0], [shoulder, h / 2], [z0, h / 2]];
    const face = (x: number): Vec3[] => outline.map(([z, y]) => [x, y, z]);
    const left = face(-t / 2);
    const right = face(t / 2);
    shape.b.face(right, [1, 0, 0], board);
    shape.b.face([...left].reverse(), [-1, 0, 0], board);
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      const [az, ay] = outline[i];
      const [bz, by] = outline[j];
      const l = Math.hypot(bz - az, by - ay) || 1;
      shape.b.face([left[i], left[j], right[j], right[i]], [0, -(bz - az) / l, (by - ay) / l], board);
    }
    shape.solid([...left, ...right]);
    if (ctx.far) return;
    // A painted band along each face, short of the point.
    const band = ctx.paint("band");
    for (const side of [-1, 1]) {
      const x = side * (t / 2 + PROUD / 2);
      const f = { ...ORIGIN, origin: at(ORIGIN, [x, 0, (z0 + 0.08 + shoulder - 0.04) / 2]) };
      shape.box(f, [PROUD / 2, h * 0.3, (shoulder - 0.04 - z0 - 0.08) / 2], band);
    }
  },
};
