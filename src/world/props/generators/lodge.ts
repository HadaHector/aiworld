import type { PropContext, PropGenerator } from "../propGenerator";
import { ORIGIN, between, moved, turned } from "../propShapes";
import type { Vec3 } from "../../buildings/buildingGeometry";

/**
 * What a hunting lodge keeps about it (LODGE.md): a frame for drying hides, a gallows to hang the
 * game from, a kennel for the hounds, a firewood rick, a campfire ring, and - on its wall - a set of
 * antlers and a bunch of herbs. Sizes are a little over life (GEOMETRY.md) so they read from afar.
 */

/** A round pole from `a` to `b` (any direction), its ends showing their grain. */
function pole(ctx: PropContext, a: Vec3, b: Vec3, radius: number | [number, number], side: ReturnType<PropContext["paint"]>, collide = false, sides?: number): void {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  ctx.shape.cylinder(between(ORIGIN, a, b), length, radius, side, { ends: side, collide, ...(sides ? { sides } : {}) });
}

/** A hide-drying frame: two uneven posts, a crossbar lashed across their tops, a bar low down, and a
 *  hide - a rough oval - laced to them on cords. Its front is +z. */
export const hideFrame: PropGenerator = {
  doc: "A hide-drying frame - two posts, two bars, a hide laced in on cords.",
  params: {
    height: { kind: "range", default: [2.3, 2.7], min: 1, doc: "the taller post's height" },
    width: { kind: "range", default: [1.8, 2.2], min: 0.6, doc: "between its posts" },
    hide: { kind: "range", default: [1.1, 1.4], min: 0.3, doc: "the hide's width" },
  },
  parts: ["wood", "cord", "hide"],
  build(ctx) {
    const { shape, rng } = ctx;
    const h = ctx.range("height");
    const w = ctx.range("width") / 2;
    const hw = ctx.range("hide") / 2;
    const wood = ctx.paint("wood");
    const cord = ctx.paint("cord");
    const hidePaint = ctx.paint("hide");
    const r = 0.1;
    // Posts of unequal height, as cut in the wood.
    const heights = [h, h - 0.1 - rng() * 0.2];
    [-1, 1].forEach((side, i) => shape.cylinder(between(ORIGIN, [side * w, -0.1, 0], [side * w, heights[i], 0], [0, 0, 1]), heights[i] + 0.1, r, wood, { ends: wood, caps: "end", collide: true }));
    // The bars lashed across their fronts, running past them.
    const top = Math.min(...heights) - 0.2;
    const low = 0.4;
    const front = r + 0.08;
    pole(ctx, [-w - 0.3, top, front], [w + 0.3, top + 0.05 * (rng() - 0.5), front], 0.08, wood, false);
    pole(ctx, [-w - 0.15, low, front], [w + 0.15, low, front], 0.07, wood, false);
    if (ctx.far) return;
    // The hide: a rough oval standing in the frame, two faces. A fan from its middle, so it stays star-shaped.
    const cy = (top + low) / 2;
    const hh = (top - low) * 0.38;
    const n = 12;
    const rim: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const flare = k % 3 === 1 ? 1.15 : 0.85 + rng() * 0.15;
      rim.push([Math.cos(a) * hw * flare, cy + Math.sin(a) * hh * flare]);
    }
    const z = front + 0.01;
    shape.b.face(rim.map(([x, y]) => [x, y, z] as Vec3), [0, 0, 1], hidePaint, [0, 1, 0], [0, cy, z]);
    shape.b.face(rim.map(([x, y]) => [x, y, z - 0.03] as Vec3).reverse(), [0, 0, -1], hidePaint, [0, 1, 0], [0, cy, z - 0.03]);
    // Cords from the rim to the bar or post nearest it.
    for (let k = 0; k < n; k += 1) {
      const [x, y] = rim[k];
      if (k % 2 === 0) continue;
      let to: Vec3;
      if (Math.abs(x) > hw * 0.8) to = [Math.sign(x) * w, y, front - r * 0.3];
      else if (y > cy) to = [x, top, front + 0.07];
      else to = [x, low, front + 0.06];
      shape.beam(ORIGIN, [x, y, z + 0.02], to, 0.035, 0.035, cord);
    }
  },
};

/** A game gallows: two forked posts, a heavy crossbar lying in their forks, and - mostly - a deer
 *  hung from it by the hind legs. The deer is made of plain tapered limbs: a hung carcass reads
 *  from its outline. Its front is +z. */
export const gameGallows: PropGenerator = {
  doc: "A hunter's gallows - forked posts, a crossbar, a hung deer.",
  params: {
    height: { kind: "range", default: [2.7, 3.1], min: 1.5, doc: "the posts' height" },
    span: { kind: "range", default: [2.6, 3.0], min: 1, doc: "between its posts" },
    deer: { kind: "chance", default: 0.85, doc: "how likely a deer hangs on it" },
  },
  parts: ["wood", "rope", "hide", "bone"],
  build(ctx) {
    const { shape, rng } = ctx;
    const h = ctx.range("height");
    const span = ctx.range("span") / 2;
    const wood = ctx.paint("wood");
    for (const side of [-1, 1]) {
      const x = side * span;
      shape.cylinder(between(ORIGIN, [x, -0.1, 0], [x, h - 0.5, 0], [0, 0, 1]), h + 0.4, [0.16, 0.13], wood, { ends: wood, caps: "end", collide: true });
      // The fork: two arms up and out front and back, the bar between them.
      for (const z of [-1, 1]) shape.beam(ORIGIN, [x, h - 0.75, 0], [x + side * 0.02, h + 0.25, z * 0.32], 0.13, 0.13, wood, { taper: [1.1, 0.8] });
    }
    pole(ctx, [-span - 0.45, h, 0], [span + 0.45, h, 0], 0.11, wood, true);
    if (ctx.far || !ctx.chance("deer")) return;
    // The deer, head down, hung by the hind legs: each part a tube, thick where the body is and
    // thin at the hocks and the muzzle.
    const bar = h - 0.1;
    const x = (rng() - 0.5) * span * 0.9;
    const fit = Math.min(1, (bar - 0.55) / 2.18);
    const hock = bar - 0.2 * fit;
    const pelvis = hock - 0.45 * fit;
    const shoulder = pelvis - 0.85 * fit;
    const head = shoulder - 0.45 * fit;
    const hide = ctx.paint("hide");
    const bone = ctx.paint("bone");
    const sway = (rng() - 0.5) * 0.08;
    for (const sd of [-1, 1]) {
      // The rope from the bar, the hock (thin), the thigh swelling down to the haunch.
      shape.tube(ORIGIN, [{ at: [x + sd * 0.04, bar, 0], radius: 0.022 }, { at: [x + sd * 0.07, hock, 0], radius: 0.022 }], ctx.paint("rope"), { sides: 5 });
      shape.tube(ORIGIN, [
        { at: [x + sd * 0.07, hock + 0.02, 0], radius: 0.035 },
        { at: [x + sd * 0.07, hock - 0.08 * fit, 0.01], radius: 0.05 },
        { at: [x + sd * 0.14, pelvis + 0.12 * fit, 0.03], radius: 0.1 },
        { at: [x + sd * 0.15, pelvis - 0.02, 0.04], radius: 0.1 },
      ], hide, { sides: 7 });
    }
    // The body: a rounded rump at the top, the barrel, the chest, down to the base of the neck.
    shape.tube(ORIGIN, [
      { at: [x, pelvis + 0.06, 0.03], radius: 0.1 },
      { at: [x, pelvis - 0.05, 0.03], radius: 0.21 },
      { at: [x + sway, pelvis - 0.35 * fit, 0.05], radius: 0.25 },
      { at: [x + sway * 1.5, shoulder + 0.15 * fit, 0.07], radius: 0.24 },
      { at: [x + sway * 2, shoulder - 0.05, 0.09], radius: 0.15 },
    ], hide, { sides: 10, ends: hide });
    // The neck and head hang on, the head slack, the muzzle thin and forward.
    const neck = shape.tube(ORIGIN, [
      { at: [x + sway * 2, shoulder, 0.09], radius: 0.13 },
      { at: [x + sway * 2.5, shoulder - 0.2 * fit, 0.13], radius: 0.1 },
      { at: [x + sway * 3, head, 0.17], radius: 0.085 },
      { at: [x + sway * 3.2, head - 0.14 * fit, 0.22], radius: 0.075 },
      { at: [x + sway * 3.3, head - 0.3 * fit, 0.3], radius: 0.05 },
      { at: [x + sway * 3.3, head - 0.36 * fit, 0.32], radius: 0.03 },
    ], hide, { sides: 8, ends: hide });
    // Forelegs hanging loose from the shoulder, bent at the knee.
    for (const sd of [-1, 1]) {
      shape.tube(ORIGIN, [
        { at: [x + sd * 0.17, shoulder + 0.1 * fit, 0.1], radius: 0.075 },
        { at: [x + sd * 0.22, shoulder - 0.15 * fit, 0.16], radius: 0.045 },
        { at: [x + sd * 0.2, shoulder - 0.35 * fit, 0.26], radius: 0.03 },
        { at: [x + sd * 0.21, shoulder - 0.5 * fit, 0.28], radius: 0.022 },
      ], hide, { sides: 6, ends: bone });
    }
    // Small antlers off the head's crown, curving up the way the head hangs (away from the ground).
    const crown = neck.points[Math.floor(neck.points.length * 0.62)];
    for (const sd of [-1, 1]) {
      shape.tube(ORIGIN, [
        { at: [crown[0] + sd * 0.04, crown[1], crown[2] + 0.02], radius: 0.028 },
        { at: [crown[0] + sd * 0.12, crown[1] + 0.06 * fit, crown[2] + 0.04], radius: 0.022 },
        { at: [crown[0] + sd * 0.2, crown[1] - 0.02 * fit, crown[2] + 0.07], radius: 0.015 },
        { at: [crown[0] + sd * 0.26, crown[1] - 0.14 * fit, crown[2] + 0.08], radius: 0.004 },
      ], bone, { sides: 5 });
    }
  },
};

/** A hound kennel: a low log shelter, open at the front, a gabled roof of shingles, a floor of
 *  boards with straw on it, and a post with a chain beside it. Its front (open) is +z. */
export const houndKennel: PropGenerator = {
  doc: "A hound kennel - a log shelter open at the front, straw, a chain post.",
  params: {
    width: { kind: "range", default: [2.2, 2.6], min: 1, doc: "along its front" },
    depth: { kind: "range", default: [1.5, 1.8], min: 0.8, doc: "front to back" },
    height: { kind: "range", default: [1.5, 1.7], min: 0.8, doc: "to the eaves" },
  },
  parts: ["logs", "roof", "floor", "straw", "iron", "gable"],
  build(ctx) {
    const { shape, rng } = ctx;
    const w = ctx.range("width") / 2;
    const d = ctx.range("depth") / 2;
    const h = ctx.range("height");
    const logs = ctx.paint("logs");
    const r = 0.17;
    const step = 0.31;
    const courses = Math.floor((h - r) / step);
    const wallTop = r + courses * step + r;
    shape.box(moved(ORIGIN, [0, 0.05, 0]), [w + 0.1, 0.05, d + 0.1], ctx.paint("floor"), { bottom: false });
    // Back wall and the two side walls: round logs course on course, the sides half a course up from
    // the back so their corners interlock.
    for (let k = 0; k <= courses; k++) {
      const y = r + k * step;
      pole(ctx, [-w - 0.15, y, -d], [w + 0.15, y, -d], r, logs);
      for (const side of [-1, 1]) pole(ctx, [side * w, y + step / 2, -d - 0.15], [side * w, y + step / 2, d + 0.15], r, logs);
    }
    shape.solid([[-w, 0, -d], [w, 0, -d], [w, wallTop, -d], [-w, wallTop, -d], [-w, 0, d * 0.5], [w, 0, d * 0.5], [w, wallTop, d * 0.5], [-w, wallTop, d * 0.5]]);
    // The straw they lie in.
    const straw = ctx.paint("straw");
    shape.box(moved(ORIGIN, [0, 0.14, 0.05]), [w - 0.12, 0.07, d - 0.15], straw, { bottom: false });
    if (!ctx.far) for (let n = 0; n < 4; n++) shape.box(moved(turned(ORIGIN, "y", rng() * 2), [(rng() - 0.5) * w * 1.4, 0.26, (rng() - 0.3) * d]), [0.25, 0.06, 0.15], straw);
    // The roof: two shingled slopes up to a ridge along the front, overhanging every side.
    const rise = 0.7;
    const hang = 0.3;
    const roof = ctx.paint("roof");
    for (const side of [-1, 1]) shape.beam(ORIGIN, [0, wallTop - 0.05 + 0.0, side * (d + hang)], [0, wallTop + rise, 0], w * 2 + 0.5, 0.1, roof);
    // The gable ends' boards, under the roof.
    const gable = ctx.paint("gable");
    for (const side of [-1, 1]) shape.b.face([[side * (w + 0.02), wallTop, -d], [side * (w + 0.02), wallTop, d], [side * (w + 0.02), wallTop + rise * 0.8, 0]] as Vec3[], [side, 0, 0], gable, [0, 1, 0]);
    if (ctx.far) return;
    // A post for the chain, out front at one side, the chain run to the shelter.
    const iron = ctx.paint("iron");
    const px = w + 0.75;
    pole(ctx, [px, -0.1, d + 0.5], [px, 0.95, d + 0.5], 0.09, logs, true, 6);
    shape.beam(ORIGIN, [px - 0.08, 0.85, d + 0.5], [w - 0.15, 0.1, d - 0.25], 0.05, 0.05, iron);
  },
};

/** A firewood rick: chopped billets in rows, their ends to the front, between a stake at each end. A
 *  rick is built as a solid grid of billets, the half-round pale where split and half barked. Its
 *  front is +z. */
export const firewoodStack: PropGenerator = {
  doc: "A rick of split firewood between two stakes.",
  params: {
    width: { kind: "range", default: [1.6, 2.4], min: 0.5, doc: "along its front" },
    height: { kind: "range", default: [0.9, 1.2], min: 0.3, doc: "how high" },
    depth: { kind: "range", default: [0.5, 0.65], min: 0.2, doc: "the billets' length" },
  },
  parts: ["bark", "split", "end", "stake"],
  build(ctx) {
    const { shape, rng } = ctx;
    const w = ctx.range("width") / 2;
    const h = ctx.range("height");
    const d = ctx.range("depth") / 2;
    if (ctx.far) {
      shape.box(moved(ORIGIN, [0, h / 2, 0]), [w, h / 2, d], ctx.paint("bark"), { bottom: false, collide: true });
      return;
    }
    const bark = ctx.paint("bark");
    const split = ctx.paint("split");
    const end = ctx.paint("end");
    const r = 0.12;
    const pitch = r * 1.9;
    const rows = Math.max(2, Math.floor(h / (r * 1.75)));
    for (let row = 0; row < rows; row++) {
      const offset = row % 2 ? pitch / 2 : 0;
      const across = Math.floor((w * 2 - offset) / pitch);
      for (let k = 0; k < across; k++) {
        // The top row is thinner: a rick is finished unevenly.
        if (row === rows - 1 && rng() < 0.3) continue;
        const x = -w + r + offset + k * pitch + (rng() - 0.5) * 0.02;
        const y = r * 0.9 + row * r * 1.75;
        const br = r * (0.85 + rng() * 0.3);
        const len = d * 2 * (0.9 + rng() * 0.1);
        shape.cylinder(between(ORIGIN, [x, y, -len / 2], [x, y, len / 2]), len, br, rng() < 0.45 ? bark : split, { ends: end, sides: 5 });
      }
    }
    shape.solid([[-w, 0, -d], [w, 0, -d], [w, h, -d], [-w, h, -d], [-w, 0, d], [w, 0, d], [w, h, d], [-w, h, d]]);
    // A stake each end, leaning a little in against the pile.
    const stake = ctx.paint("stake");
    for (const side of [-1, 1]) pole(ctx, [side * (w + 0.1), -0.1, d * 0.3], [side * (w + 0.05), h + 0.15, d * 0.3], 0.06, stake, false, 5);
  },
};

/** A campfire ring: a ring of fieldstones on trodden earth, a bed of ash, a few logs burning in a
 *  star, a flame (the prop's `effects`) and its light. */
export const campfire: PropGenerator = {
  doc: "A campfire ring of fieldstones with logs burning.",
  params: {
    radius: { kind: "range", default: [0.75, 0.95], min: 0.3, doc: "the ring's radius" },
    stones: { kind: "count", default: [9, 12], min: 5, doc: "stones in the ring" },
    logs: { kind: "count", default: [3, 4], min: 1, doc: "logs on the fire" },
  },
  parts: ["stone", "ash", "logs"],
  build(ctx) {
    const { shape, rng } = ctx;
    const R = ctx.range("radius");
    const n = ctx.count("stones");
    const stone = ctx.paint("stone");
    for (let k = 0; k < n; k++) {
      const a = ((k + (rng() - 0.5) * 0.3) / n) * Math.PI * 2;
      // A water-worn stone: a flattened dome, each its own size and outline, half sunk in the earth.
      const rx = 0.26 + rng() * 0.1;
      const hy = 0.2 + rng() * 0.08;
      const jag = () => 0.9 + rng() * 0.2;
      const profile: [number, number][] = [[rx * 0.55 * jag(), 0], [rx * jag(), hy * 0.25], [rx * 1.05 * jag(), hy * 0.55], [rx * 0.8 * jag(), hy * 0.88], [rx * 0.4 * jag(), hy * 1.05], [0.02, hy * 1.08]];
      shape.lathe(turned(moved(ORIGIN, [Math.cos(a) * R, -0.03, Math.sin(a) * R]), "y", rng() * Math.PI), profile, stone, { sides: 9, top: stone, collide: true });
    }
    shape.lathe(ORIGIN, [[R - 0.1, 0.02], [R * 0.7, 0.07], [0.2, 0.09], [0, 0.09]], ctx.paint("ash"));
    const logs = ctx.paint("logs");
    const m = ctx.count("logs");
    const first = rng() * Math.PI * 2;
    for (let k = 0; k < m; k++) {
      const a = first + (k / m) * Math.PI * 2 + (rng() - 0.5) * 0.4;
      // Laid across each other: far ends on the ash, near ends crossing in the middle.
      const from: Vec3 = [Math.cos(a) * R * 0.75, 0.14, Math.sin(a) * R * 0.75];
      const to: Vec3 = [-Math.cos(a) * 0.15, 0.3 + k * 0.1, -Math.sin(a) * 0.15];
      pole(ctx, from, to, 0.1, logs, false, 6);
    }
    if (ctx.far) return;
    ctx.mount("flame", [0, 0.3, 0], R * 0.5, 1.0);
    ctx.light([0, 0.6, 0]);
  },
};

/** A set of antlers on a plaque, for a wall: a tall rough board, the skull and muzzle on it, two beams
 *  sweeping out, up and back in, each with a brow tine and several tines - every one a tube, thick at
 *  the burr and running to a point. Built at a wall's height with its back flat to the wall (see
 *  FURNITURE.md `mount`). */
export const antlerMount: PropGenerator = {
  doc: "Antlers on a wooden plaque, for a wall.",
  params: {
    span: { kind: "range", default: [1.0, 1.3], min: 0.4, doc: "the antlers' width at their widest" },
    tines: { kind: "count", default: [3, 4], min: 1, doc: "tines up off each beam" },
  },
  parts: ["board", "bone", "fur"],
  build(ctx) {
    const { shape, rng } = ctx;
    const span = ctx.range("span") / 2;
    const n = ctx.count("tines");
    const board = ctx.paint("board");
    const bone = ctx.paint("bone");
    const fur = ctx.paint("fur");
    const y = 1.55;
    shape.box(moved(ORIGIN, [0, y, 0.05]), [0.27, 0.42, 0.05], board, { bevel: 0.02 });
    // The skull's crown and, under it, the furred muzzle, as tubes.
    shape.tube(ORIGIN, [{ at: [0, y + 0.1, 0.12], radius: 0.13 }, { at: [0, y - 0.05, 0.15], radius: 0.14 }], bone, { sides: 8, ends: bone });
    shape.tube(ORIGIN, [{ at: [0, y - 0.05, 0.14], radius: 0.13 }, { at: [0, y - 0.2, 0.22], radius: 0.1 }, { at: [0, y - 0.3, 0.3], radius: 0.05 }, { at: [0, y - 0.31, 0.33], radius: 0.03 }], fur, { sides: 8, ends: fur });
    if (ctx.far) return;
    for (const s of [-1, 1]) {
      // The beam: out and back from the burr, then up and curving in toward the top.
      const w = span * (0.95 + rng() * 0.1);
      const beam = shape.tube(ORIGIN, [
        { at: [s * 0.07, y + 0.2, 0.18], radius: 0.065 },
        { at: [s * w * 0.45, y + 0.3, 0.26], radius: 0.055 },
        { at: [s * w * 0.9, y + 0.62, 0.3], radius: 0.045 },
        { at: [s * w * 0.95, y + 1.0, 0.27], radius: 0.034 },
        { at: [s * w * 0.78, y + 1.3, 0.23], radius: 0.012 },
      ], bone, { sides: 7 });
      // A brow tine forward and up from the burr, curving up.
      shape.tube(ORIGIN, [
        { at: [s * 0.1, y + 0.24, 0.2], radius: 0.045 },
        { at: [s * 0.17, y + 0.3, 0.4], radius: 0.036 },
        { at: [s * 0.2, y + 0.5, 0.5], radius: 0.012 },
      ], bone, { sides: 6 });
      // Tines off the beam, rising: from points along it, each curving up and in.
      const p = beam.points;
      for (let t = 0; t < n; t++) {
        const at = p[Math.floor(p.length * (0.42 + (t / Math.max(1, n)) * 0.5))];
        const len = 0.3 - t * 0.04 + rng() * 0.08;
        shape.tube(ORIGIN, [
          { at: [at[0], at[1], at[2]], radius: 0.034 },
          { at: [at[0] - s * 0.03, at[1] + len * 0.5, at[2] + 0.03], radius: 0.024 },
          { at: [at[0] - s * 0.08, at[1] + len, at[2] + 0.04], radius: 0.006 },
        ], bone, { sides: 5 });
      }
    }
  },
};

/** A bunch of dried herbs hung head down from a nail in a wall, tied at the top with twine: up to
 *  three kinds - lavender, sage, yarrow - tied in one bunch and fanning out below the tie. */
export const herbBundle: PropGenerator = {
  doc: "A bunch of dried herbs hung from a wall nail.",
  params: {
    kinds: { kind: "count", default: [2, 3], min: 1, doc: "kinds of herb in the bunch" },
    length: { kind: "range", default: [0.5, 0.7], min: 0.2, doc: "how long the bunch hangs" },
  },
  parts: ["nail", "lavender", "sage", "yarrow", "twine"],
  build(ctx) {
    const { shape, rng } = ctx;
    const n = ctx.count("kinds");
    const len = ctx.range("length");
    const top = 2.0;
    const tie = top - 0.12;
    const kinds = ["lavender", "sage", "yarrow"];
    const nail = ctx.paint("nail");
    shape.cylinder(between(ORIGIN, [0, top, 0.01], [0, top, 0.14]), 0.13, 0.025, nail, { ends: nail, sides: 5 });
    if (ctx.far) return;
    shape.cylinder(between(ORIGIN, [0, top, 0.14], [0, top, 0.16]), 0.02, 0.06, nail, { ends: nail, sides: 6 });
    shape.beam(ORIGIN, [0, top - 0.03, 0.13], [0, tie, 0.1], 0.025, 0.025, ctx.paint("twine"));
    for (let k = 0; k < n; k++) {
      // Each kind fans out to its own side, the first leaning left, the last right.
      const lean = n === 1 ? 0 : (k / (n - 1) - 0.5) * 0.9;
      const l = len * (0.85 + rng() * 0.25);
      const frame = turned(moved(ORIGIN, [0, tie, 0.1]), "z", lean);
      // Narrow at the tie, flaring to the heads: a turned shape, its foot l below the tie.
      shape.lathe(moved(frame, [0, -l, 0]), [[0.07, 0], [0.13, l * 0.06], [0.15, l * 0.25], [0.1, l * 0.6], [0.045, l * 0.88], [0.03, l]], ctx.paint(kinds[k]), { sides: 7 });
    }
    shape.lathe(moved(ORIGIN, [0, tie - 0.06, 0.1]), [[0.055, 0], [0.065, 0.04], [0.055, 0.08]], ctx.paint("twine"), { sides: 6 });
  },
};
