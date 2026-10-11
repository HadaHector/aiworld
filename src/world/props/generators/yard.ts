import type { PropGenerator } from "../propGenerator";
import { ORIGIN, PROUD, between, moved, turned } from "../propShapes";
import type { Vec3 } from "../../buildings/buildingGeometry";

/** The things of a working yard: a well, a trough, a heap - of dung, of stones, of anything. */

/**
 * A well: a curb of stone blocks round its shaft, dark water down in it - and most often two posts
 * over it carrying a roller with a crank, a rope down to a bucket hung inside, now and then a little
 * roof of boards over the posts. Without them it is the curb alone, drawn from by a bucket on a rope.
 */
export const well: PropGenerator = {
  doc: "A well - a curb of stone blocks, a windlass on two posts, a bucket on its rope.",
  params: {
    radius: { kind: "range", default: [0.75, 0.95], min: 0.3, doc: "the curb's outer radius" },
    height: { kind: "range", default: [0.9, 1.1], min: 0.3, doc: "how high the curb stands" },
    frame: { kind: "range", default: [2.4, 2.8], min: 1, doc: "how high the posts stand" },
    windlass: { kind: "chance", default: 0.7, doc: "how likely posts and a windlass stand over it (else the curb alone)" },
    roof: { kind: "chance", default: 0.5, doc: "how likely a roof of boards is over its windlass" },
  },
  parts: ["stone", "wood", "roof", "rope", "bucket", "water", "iron"],
  build(ctx) {
    const { shape, rng } = ctx;
    const r = ctx.range("radius");
    const h = ctx.range("height");
    const top = ctx.range("frame");
    const windlass = ctx.chance("windlass");
    // A roofed one's posts go on up to its ridge.
    const roofed = windlass && ctx.chance("roof");
    const rise = 0.55;
    const stone = ctx.paint("stone");
    const wood = ctx.paint("wood");
    const thick = 0.28;
    // The curb: blocks round it, each a little off true - two courses, the upper turned half a block.
    const blocks = ctx.far ? 6 : 9;
    for (let course = 0; course < 2; course++) {
      const y0 = (h / 2) * course;
      for (let k = 0; k < blocks; k++) {
        const a = ((k + course * 0.5) / blocks) * Math.PI * 2;
        const mid = r - thick / 2;
        const len = (Math.PI * 2 * mid) / blocks / 2 + 0.02;
        // Its length along the curb, across the way out from the middle.
        const f = turned(moved(ORIGIN, [Math.cos(a) * mid, y0 + h / 4, Math.sin(a) * mid]), "y", -a - Math.PI / 2 + (rng() - 0.5) * 0.06);
        shape.box(f, [len, h / 4 - 0.005, thick / 2], stone, { bottom: course > 0, collide: true, bevel: ctx.far ? 0 : 0.03 });
      }
    }
    // The water, well down the shaft.
    const inner = r - thick;
    shape.cylinder(between(ORIGIN, [0, h - 0.6, 0], [0, h - 0.55, 0], [0, 0, 1]), 0.05, inner + 0.02, ctx.paint("water"), { ends: ctx.paint("water"), caps: "end", sides: blocks });
    if (!windlass) return;
    // The posts either side, and the roller across them with its crank.
    const post = 0.16;
    const postX = r + post / 2 + 0.02;
    const postTop = roofed ? top + rise : top;
    for (const side of [-1, 1]) shape.box(moved(ORIGIN, [side * postX, postTop / 2, 0]), [post / 2, postTop / 2, post / 2], wood, { bottom: false, collide: true, taper: [1, 0.85] });
    const rollerY = h + 0.55;
    shape.cylinder(between(ORIGIN, [-postX - post / 2 - 0.05, rollerY, 0], [postX + post / 2 + 0.05, rollerY, 0], [0, 1, 0]), postX * 2 + post + 0.1, 0.1, wood, { ends: wood, sides: ctx.far ? 5 : 8 });
    if (!ctx.far) {
      const iron = ctx.paint("iron");
      const end = postX + post / 2 + 0.05;
      const turn = rng() * Math.PI * 2;
      const foot: Vec3 = [end + 0.05, rollerY + Math.sin(turn) * 0.35, Math.cos(turn) * 0.35];
      shape.beam(ORIGIN, [end + 0.05, rollerY, 0], foot, 0.05, 0.05, iron);
      shape.cylinder(between(ORIGIN, foot, [foot[0] + 0.3, foot[1], foot[2]], [0, 1, 0]), 0.3, 0.045, wood, { ends: wood, sides: 6 });
      // The rope down to the bucket, hung a little way into the shaft.
      const bucketTop = h - 0.05;
      shape.beam(ORIGIN, [0, rollerY - 0.09, 0], [0, bucketTop, 0], 0.035, 0.035, ctx.paint("rope"));
      const br = 0.2;
      // Full, its water at its brim - closed, so it is solid from above.
      shape.lathe(moved(ORIGIN, [0, bucketTop - 0.36, 0]), [[br * 0.8, 0], [br, 0.36]], ctx.paint("bucket"), { bottom: ctx.paint("bucket"), top: ctx.paint("water"), sides: 8 });
    }
    // Its roof: two pitches of boards on the posts' heads, ridge along the roller.
    if (roofed) {
      const roof = ctx.paint("roof");
      const span = r + 0.35;
      const along = postX + post / 2 + 0.25;
      for (const side of [-1, 1]) {
        const pitch = Math.atan2(rise, span);
        const f = turned(moved(ORIGIN, [0, top + rise / 2, (side * span) / 2]), "x", side * pitch);
        shape.box(f, [along, 0.04, Math.hypot(span, rise) / 2 + 0.08], roof);
      }
      shape.box(moved(ORIGIN, [0, top + rise - 0.06, 0]), [along - 0.1, 0.07, 0.07], wood);
    }
  },
};

/**
 * A trough: a long box hollowed out - its sides, ends and floor - holding water near its brim. Of
 * stone or boards by its paint.
 */
export const trough: PropGenerator = {
  doc: "A trough - a long open box with water near its brim.",
  params: {
    length: { kind: "range", default: [1.8, 2.4], min: 0.4, doc: "along it" },
    width: { kind: "range", default: [0.7, 0.85], min: 0.2, doc: "across it" },
    height: { kind: "range", default: [0.6, 0.75], min: 0.2, doc: "how high its brim stands" },
    wall: { kind: "range", default: [0.12, 0.16], min: 0.03, doc: "how thick its sides are" },
  },
  parts: ["body", "water"],
  build(ctx) {
    const { shape } = ctx;
    const l = ctx.range("length") / 2;
    const w = ctx.range("width") / 2;
    const h = ctx.range("height");
    const t = ctx.range("wall");
    const body = ctx.paint("body");
    const bevel = ctx.far ? 0 : Math.min(0.03, t * 0.25);
    // The sides run its length; the ends sit between them, reaching half into each so no gap is
    // left at a corner, a hair lower so their tops never lie in the sides' plane.
    for (const side of [-1, 1]) shape.box(moved(ORIGIN, [0, h / 2, side * (w - t / 2)]), [l, h / 2, t / 2], body, { bottom: false, collide: true, bevel });
    const endTop = h - PROUD;
    for (const end of [-1, 1]) shape.box(moved(ORIGIN, [end * (l - t / 2), endTop / 2, 0]), [t / 2, endTop / 2, w - t / 2], body, { bottom: false, collide: true, bevel });
    // The water a little under the brim, reaching into the walls so it meets them all round.
    shape.box(moved(ORIGIN, [0, (h - 0.1) / 2, 0]), [l - t + PROUD, (h - 0.1) / 2, w - t + PROUD], ctx.paint("water"), { bottom: false });
  },
};

/**
 * A heap: a low, lumpy mound - a dung heap, a pile of earth, of sand, of coal - smooth-shaded, its
 * outline rolled out of round and drawn out longer one way, its top off its middle. What it is a
 * heap of is its paint's texture (dung: muck with straw through it).
 */
export const heap: PropGenerator = {
  doc: "A heap - a lumpy, smooth mound, longer one way than the other.",
  params: {
    radius: { kind: "range", default: [1.0, 1.4], min: 0.1, doc: "its radius across its narrow way" },
    height: { kind: "range", default: [0.8, 1.2], min: 0.05, doc: "how high it rises" },
    stretch: { kind: "range", default: [1.1, 1.5], min: 1, doc: "how much longer it is one way" },
    lumps: { kind: "range", default: [0.12, 0.2], min: 0, doc: "how far its outline wanders in and out (a share of its size)" },
  },
  parts: ["body"],
  build(ctx) {
    const { shape, rng } = ctx;
    const r = ctx.range("radius");
    const h = ctx.range("height");
    const stretch = ctx.range("stretch");
    const lumps = ctx.range("lumps");
    const body = ctx.paint("body");
    const around = ctx.far ? 7 : 14;
    const rings = ctx.far ? 2 : 5;
    // Its top a little off its middle.
    const peak: Vec3 = [(rng() - 0.5) * r * 0.4, h, (rng() - 0.5) * r * 0.3];
    // Its outline's lumps: one wobble round it, a few slow waves, which every ring follows - so the
    // rings never cross, and no face hangs over the one below it.
    const waves = [1, 2, 3].map((n) => ({ n: n + 1, phase: rng() * Math.PI * 2, size: (rng() * lumps) / n }));
    const wobble = (a: number): number => 1 + waves.reduce((sum, w) => sum + Math.sin(a * w.n + w.phase) * w.size, 0);
    // Rings from its foot (just under the ground) up towards its top: each smaller and higher than
    // the one under it.
    const ring: Vec3[][] = [];
    for (let i = 0; i < rings; i++) {
      const out = 1 - i / rings;
      const y = i === 0 ? -0.08 : h * (1 - Math.pow(out, 2.6)) * (1 + (rng() - 0.5) * lumps * 0.3);
      // Drawn towards its top as it rises.
      const lean = 1 - out;
      ring.push(
        Array.from({ length: around }, (_, k) => {
          const a = (k / around) * Math.PI * 2;
          const reach = r * out * wobble(a);
          return [Math.cos(a) * reach * stretch + peak[0] * lean, y, Math.sin(a) * reach + peak[2] * lean];
        }),
      );
    }
    // Triangles between each ring and the next, and a fan to its top - by index into its points, so
    // each point's normal can be the mean of the faces round it: smooth-shaded.
    const points: Vec3[] = [...ring.flat(), peak];
    const top = points.length - 1;
    const at = (i: number, k: number): number => i * around + (k % around);
    const triangles: [number, number, number][] = [];
    for (let i = 0; i + 1 < rings; i++) {
      for (let k = 0; k < around; k++) {
        triangles.push([at(i, k), at(i, k + 1), at(i + 1, k + 1)], [at(i, k), at(i + 1, k + 1), at(i + 1, k)]);
      }
    }
    for (let k = 0; k < around; k++) triangles.push([at(rings - 1, k), at(rings - 1, k + 1), top]);
    // Each face's normal, outward (up and away from its middle), its size by its area.
    const faceNormal = ([a, b, c]: [number, number, number]): Vec3 => {
      const [pa, pb, pc] = [points[a], points[b], points[c]];
      const u: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const v: Vec3 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      return n[1] < 0 ? [-n[0], -n[1], -n[2]] : n;
    };
    const normals: Vec3[] = points.map(() => [0, 0, 0]);
    for (const tri of triangles) {
      const n = faceNormal(tri);
      for (const i of tri) for (let axis = 0; axis < 3; axis++) normals[i][axis] += n[axis];
    }
    for (const n of normals) {
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      for (let axis = 0; axis < 3; axis++) n[axis] /= len;
    }
    // Its texture projected straight down on it, a metre a unit; its tangent the way its u runs (x),
    // laid flat on the surface.
    const tangentOf = (n: Vec3): Vec3 => {
      const t: Vec3 = [1 - n[0] * n[0], -n[1] * n[0], -n[2] * n[0]];
      const len = Math.hypot(t[0], t[1], t[2]) || 1;
      return [t[0] / len, t[1] / len, t[2] / len];
    };
    for (const tri of triangles) {
      shape.b.raw(
        tri.map((i) => points[i]),
        tri.map((i) => normals[i]),
        tri.map((i) => tangentOf(normals[i])),
        tri.map((i): [number, number] => [points[i][0], points[i][2]]),
        body,
      );
    }
    shape.solid([...ring[0], ...ring[rings - 1], peak]);
  },
};

/**
 * A wayside sign: a post by the road, an arm out over it, and a board hung from the arm on two
 * irons - or, plainer, the board fixed to the post's head - painted both sides with a panel and an
 * emblem on it, read from the road by those who cannot read. Its arm reaches along +x (towards the
 * road), its board faces ±z (along it).
 */
export const signpost: PropGenerator = {
  doc: "A wayside sign - a post, an arm over the road, a painted board hung from it.",
  params: {
    height: { kind: "range", default: [3.0, 3.4], min: 1, doc: "the post's height" },
    arm: { kind: "range", default: [1.3, 1.6], min: 0.3, doc: "how far the arm reaches out" },
    width: { kind: "range", default: [1.1, 1.3], min: 0.2, doc: "the board's width" },
    board: { kind: "range", default: [0.75, 0.9], min: 0.2, doc: "the board's height" },
    hanging: { kind: "chance", default: 0.6, doc: "how likely its board hangs from an arm (else it is fixed to the post)" },
  },
  parts: ["post", "board", "face", "emblem", "iron"],
  build(ctx) {
    const { shape } = ctx;
    const h = ctx.range("height");
    const arm = ctx.range("arm");
    const bw = ctx.range("width");
    const bh = ctx.range("board");
    const post = ctx.paint("post");
    const thick = 0.2;
    const hanging = ctx.chance("hanging");
    const boardThick = 0.06;
    // Hung from an arm out over the road on two irons, facing along it; or fixed to the post's head
    // on its road side, facing the road.
    const armY = h - 0.15;
    const cx = arm - bw / 2 + 0.05;
    const cy = hanging ? armY - 0.27 - bh / 2 : h - bh / 2 - 0.1;
    const boardFrame = hanging ? moved(ORIGIN, [cx, cy, 0]) : turned(moved(ORIGIN, [thick / 2 + boardThick / 2 + PROUD, cy, 0]), "y", Math.PI / 2);
    shape.box(moved(ORIGIN, [0, h / 2, 0]), [thick / 2, h / 2, thick / 2], post, { bottom: false, collide: true, taper: [1, 0.85], bevel: ctx.far ? 0 : 0.02 });
    if (hanging) {
      shape.beam(ORIGIN, [thick / 2 - 0.02, armY, 0], [arm + 0.15, armY, 0], 0.12, 0.14, post);
      if (!ctx.far) for (const side of [-1, 1]) shape.beam(ORIGIN, [cx + side * (bw / 2 - 0.12), armY - 0.07, 0], [cx + side * (bw / 2 - 0.12), cy + bh / 2, 0], 0.03, 0.03, ctx.paint("iron"));
    }
    shape.box(boardFrame, [bw / 2, bh / 2, boardThick / 2], ctx.paint("board"), { bevel: ctx.far ? 0 : 0.015 });
    // Painted both sides: a panel inside a border of the board's own wood, and on it the emblem -
    // a diamond, the sign's picture at a distance.
    const face = ctx.paint("face");
    const emblem = ctx.paint("emblem");
    // A board fixed to the post shows only its front, to the road.
    for (const side of hanging ? [-1, 1] : [1]) {
      const z = side * (boardThick / 2 + PROUD / 2);
      shape.box(moved(boardFrame, [0, 0, z]), [bw / 2 - 0.08, bh / 2 - 0.08, PROUD / 2], face);
      const size = Math.min(bw, bh) * 0.28;
      shape.box(turned(moved(boardFrame, [0, 0, z + side * PROUD]), "z", Math.PI / 4), [size / 2, size / 2, PROUD / 2], emblem);
    }
  },
};
