import type { PropGenerator } from "../propGenerator";
import { ORIGIN, moved, turned } from "../propShapes";
import type { Vec3 } from "../../buildings/buildingGeometry";

/**
 * The druid grove's stones (SLICE.md W5; concept: assets_work/comfyUI/concepts_slice/a-druid-grove-...):
 * a tall standing stone with a spiral carved into its face, moss at its foot and shelf fungus on its
 * shoulder; a low offering slab on stub stones; and the marker that stands for a tree a feature plants
 * (the tree itself is a thin instance of the tree field - see foliage/featureTrees.ts).
 */

/** How far the spiral of a standing stone winds, in radians (2.5 turns). */
const SPIRAL_TURNS = 2.5;

/**
 * A standing stone: a tall, bevelled pillar narrowing to a blunt top and leaning a little, a spiral
 * ridge carved proud on its front face (the concept's), a cushion of moss round its foot and a bracket
 * of fungus or two. Plumb on the ground, sunk into it.
 */
export const menhir: PropGenerator = {
  doc: "A standing stone with a spiral carved on its face, moss at its foot.",
  params: {
    height: { kind: "range", default: [3.8, 4.6], min: 0.5, doc: "how tall it stands" },
    width: { kind: "range", default: [1.5, 1.9], min: 0.2, doc: "across its front, at the foot" },
    thickness: { kind: "range", default: [0.8, 1.0], min: 0.1, doc: "front to back, at the foot" },
    lean: { kind: "range", default: [0, 3], min: 0, doc: "how far it leans, degrees" },
    carving: { kind: "chance", default: 1, doc: "how likely a spiral is carved on its face" },
  },
  parts: ["stone", "carved", "moss", "fungus"],
  build(ctx) {
    const { shape, rng } = ctx;
    const h = ctx.range("height");
    const w = ctx.range("width");
    const t = ctx.range("thickness");
    const lean = (ctx.range("lean") * Math.PI) / 180;
    const taper = 0.62;
    const sink = 0.35;
    const stone = ctx.paint("stone");
    const body = turned(moved(ORIGIN, [0, h / 2 - sink, 0]), "z", (rng() < 0.5 ? -1 : 1) * lean);
    shape.box(body, [w / 2, h / 2, t / 2], stone, { bottom: false, collide: true, taper: [1, taper], bevel: ctx.far ? 0 : Math.min(0.22, t * 0.28) });
    // Moss: a cushion at the foot, a few lumps up from it on the weather side.
    const moss = ctx.paint("moss");
    const lumps = ctx.far ? 3 : 7;
    for (let i = 0; i < lumps; i++) {
      const a = (i / lumps) * Math.PI * 2 + rng() * 0.5;
      const rx = (w / 2) * (0.85 + rng() * 0.25);
      const rz = (t / 2) * (0.95 + rng() * 0.3);
      const size = 0.22 + rng() * 0.2;
      shape.box(turned(moved(ORIGIN, [Math.cos(a) * rx, 0.12, Math.sin(a) * rz]), "y", rng() * Math.PI), [size, 0.16 + rng() * 0.1, size * 0.8], moss, { bottom: false, bevel: ctx.far ? 0 : 0.1 });
    }
    if (ctx.far) return;
    // A cap of moss on its blunt top, the concept's mossy crown, a little off to one side.
    shape.box(turned(moved(body, [w * 0.04, h / 2, 0]), "y", rng() * 0.4), [w * taper * 0.36, 0.09, t * taper * 0.3], moss, { bevel: 0.07 });
    // The spiral: a ridge winding out from its middle, a little above the stone's middle.
    if (ctx.chance("carving")) {
      const carved = ctx.paint("carved");
      const centre: Vec3 = [0, h * 0.08, 0];
      const radius = (w / 2) * 0.55;
      const width = Math.max(0.09, w * 0.075);
      const zAt = (y: number): number => (t / 2) * (1 - (1 - taper) * ((y + h / 2) / h)) + 0.02;
      let previous: Vec3 | null = null;
      const steps = Math.round(SPIRAL_TURNS * 28);
      for (let i = 0; i <= steps; i++) {
        const theta = (i / steps) * SPIRAL_TURNS * Math.PI * 2;
        const r = (i / steps) * radius;
        const x = centre[0] + Math.cos(theta) * r;
        const y = centre[1] + Math.sin(theta) * r * 1.15;
        const point: Vec3 = [x, y, zAt(y)];
        if (previous) shape.beam(body, previous, point, width, 0.09, carved, { up: [0, 0, 1] });
        previous = point;
      }
    }
    // Shelf fungus: two or three brackets on its lower shoulder, the pale ones of the concept.
    const fungus = ctx.paint("fungus");
    const brackets = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < brackets; i++) {
      const side = rng() < 0.5 ? -1 : 1;
      const up = 0.12 + rng() * 0.3;
      // The stone's half width there, narrowing as it rises: a bracket sits half in its face.
      const faceX = (w / 2) * (1 - (1 - taper) * up) - 0.03;
      shape.box(turned(moved(body, [side * faceX, h * (up - 0.5) + sink, (rng() - 0.5) * t * 0.4]), "y", side > 0 ? 0 : Math.PI), [0.16 + rng() * 0.08, 0.03, 0.13], fungus, { bevel: 0.02 });
    }
  },
};

/**
 * An offering slab: a flat capstone laid on two low stub stones, moss on its top, a hollow worn in the
 * middle of it - where the grove's gift is left. About table height.
 */
export const offeringSlab: PropGenerator = {
  doc: "A flat stone on two stub stones - a grove's offering table.",
  params: {
    length: { kind: "range", default: [2.4, 2.9], min: 0.4, doc: "along the slab" },
    width: { kind: "range", default: [1.4, 1.7], min: 0.3, doc: "across it" },
    height: { kind: "range", default: [0.8, 1.0], min: 0.2, doc: "to the slab's top" },
  },
  parts: ["stone", "moss"],
  build(ctx) {
    const { shape, rng } = ctx;
    const l = ctx.range("length") / 2;
    const w = ctx.range("width") / 2;
    const h = ctx.range("height");
    const slabThick = 0.32;
    const stone = ctx.paint("stone");
    const moss = ctx.paint("moss");
    const bevel = ctx.far ? 0 : 0.1;
    for (const side of [-1, 1]) {
      shape.box(turned(moved(ORIGIN, [side * (l - 0.55), (h - slabThick) / 2 - 0.1, 0]), "y", (rng() - 0.5) * 0.2), [0.4, (h - slabThick) / 2 + 0.1, w * 0.62], stone, { bottom: false, collide: true, taper: [1, 0.9], bevel });
    }
    shape.box(turned(moved(ORIGIN, [0, h - slabThick / 2, 0]), "y", (rng() - 0.5) * 0.08), [l, slabThick / 2, w], stone, { collide: true, bevel });
    if (ctx.far) return;
    // Moss over its far end and a patch at its middle, in the hollow.
    shape.box(moved(ORIGIN, [l * 0.55, h + 0.01, w * 0.2], ), [l * 0.4, 0.03, w * 0.5], moss, { bevel: 0.02, bottom: false });
    shape.box(moved(ORIGIN, [-l * 0.1, h + 0.005, -w * 0.15]), [l * 0.25, 0.02, w * 0.3], moss, { bevel: 0.015, bottom: false });
  },
};

/**
 * What stands for the trees a feature plants: a small disc of dark earth (its footprint, so the
 * compound keeps other props off it), and where the tree goes is read from its settings by
 * foliage/featureTrees.ts. The tree is the tree kind named like the prop (`props/ancientOak.json5`
 * stands for `trees/ancientOak.json5`). With `ring` 0 it is one tree, at the prop's own spot; with
 * `ring` above 0 that many trees (rolled) stand evenly round the compound's middle, each `reach`
 * metres out from the yard's rim (rolled) - a grove's ring, which the compound's own placement
 * (spread out from what is down, round the rim) could not hold to a circle. Collides with nothing:
 * the trees' own hulls do.
 */
export const treeMarker: PropGenerator = {
  doc: "Stands for a tree (or a ring of them) a feature plants: the tree kind is the kind with the prop's own id.",
  params: {
    radius: { kind: "range", default: [0.6, 0.6], min: 0.1, doc: "the footprint's radius" },
    ring: { kind: "count", default: [0, 0], min: 0, doc: "trees in a ring round the compound's middle (0: one tree, where the prop stands)" },
    reach: { kind: "range", default: [4, 4], min: 0, doc: "for a ring: metres from the yard's rim to each trunk's middle" },
    wander: { kind: "number", default: 0.2, min: 0, max: 0.5, doc: "for a ring: how far each tree strays from its even place round it, a share of the gap between two" },
  },
  parts: ["earth"],
  build(ctx) {
    const r = ctx.range("radius");
    ctx.shape.lathe(ORIGIN, [[r, -0.05], [r * 0.9, 0.02], [0.05, 0.03]], ctx.paint("earth"), { sides: ctx.far ? 6 : 10 });
  },
};
