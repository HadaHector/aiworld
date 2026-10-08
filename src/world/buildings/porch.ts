import type { Paint, PorchSpec } from "./buildingTypes";
import { roll, type ModelBuilder, type Vec3 } from "./buildingGeometry";
import type { PartPaints } from "./buildingParts";
import type { ColliderBuilder } from "./buildingColliders";
import { buildSlopedSlab, TUCK } from "./leanToRoof";

/**
 * A porch along a wall: a plank deck at the floor's level, a step down from its front where the
 * floor stands high, a post at every bay along its outer edge with a beam along their tops, and a
 * lean-to roof from the wall - under the storey's top - out over the posts, open at its ends.
 * Walkable on, under and along: its deck, step, posts and roof are all in the way.
 */

/** The wall a porch stands along, in the house's space. */
export interface PorchInput {
  b: ModelBuilder;
  colliders: ColliderBuilder | null;
  /** From `a0` to `a1` metres along the wall; `at(a, out, y)` is the point `out` metres off the
   *  wall's face there, `y` up; `along` and `outward` the directions those run in the model. */
  a0: number;
  a1: number;
  at: (a: number, out: number, y: number) => Vec3;
  along: Vec3;
  outward: Vec3;
  /** The ground's level, and the floor's - the deck's top - and the storey's top, its roof's high
   *  edge DROP under it. */
  ground: number;
  floor: number;
  top: number;
  /** Where along the wall its posts stand, ends and all: the wall's bays. */
  posts: number[];
}

/** What a porch rolls: how deep it is, and its roof's slope. */
export interface PorchPlan {
  depth: number;
  slope: number;
}

export function planPorch(spec: PorchSpec, rng: () => number): PorchPlan {
  return { depth: roll(spec.depth, rng), slope: Math.tan((roll(spec.pitch, rng) * Math.PI) / 180) };
}

/** A floor this far over the ground has a step down from the deck. */
const STEP_FROM = 0.35;
/** The deck's skirt reaches this far into the ground, so it never stands on air on a slope. */
const SKIRT = 0.3;
/** The deck's top stands this far over the floor's line, so it is never drawn in one plane with the
 *  plinth's top it covers - under a door's threshold, which stands higher. */
const DECK_LIFT = 0.03;

export function buildPorch(spec: PorchSpec, plan: PorchPlan, input: PorchInput, paints: PartPaints): void {
  const { b, colliders, a0, a1, at, along, outward, ground, top } = input;
  const floor = input.floor + DECK_LIFT;
  const deck = paints[spec.parts.deck];
  const post = paints[spec.parts.post];
  const covering = paints[spec.parts.covering];
  const underside = paints[spec.parts.underside];
  const depth = plan.depth;
  const w = spec.post;

  /** A box from (a, out, y) to (a', out', y') - the porch runs square to the house. A deck's top is
   *  laid on its own (`boarded`), its texture's v out from the wall, so its boards run along it. */
  const box = (p: [number, number, number], q: [number, number, number], paint: Paint, boarded = false): void => {
    const [x0, y0, z0] = at(p[0], p[1], p[2]);
    const [x1, y1, z1] = at(q[0], q[1], q[2]);
    const [lx, ly, lz, hx, hy, hz] = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
    b.box(lx, ly, lz, hx, hy, hz, paint, paint, boarded ? "bottom" : "top");
    if (boarded) b.face([[lx, hy, hz], [hx, hy, hz], [hx, hy, lz], [lx, hy, lz]], [0, 1, 0], paint, outward);
    colliders?.box(x0, y0, z0, x1, y1, z1);
  };

  // The deck, from the wall out, its skirt down into the ground; a step down from its front.
  box([a0, -TUCK, ground - SKIRT], [a1, depth, floor], deck, true);
  if (floor - ground > STEP_FROM) box([a0, depth, ground - SKIRT], [a1, depth + spec.step, (ground + floor) / 2], deck, true);

  // The roof: from DROP under the storey's top at the wall, falling at its slope out over the posts
  // - held shallower where that would bring its low edge under `headroom` over the deck.
  const high = top - spec.drop;
  const slope = Math.max(0, Math.min(plan.slope, (high - floor - spec.headroom) / depth));
  const low = high - depth * slope;
  const rise = spec.thickness * Math.sqrt(1 + slope * slope);

  // Posts at every bay along its front edge, and a beam along their tops.
  for (const p of input.posts) {
    const c = Math.min(a1 - w / 2, Math.max(a0 + w / 2, p));
    box([c - w / 2, depth - w, floor], [c + w / 2, depth, low - spec.beam], post);
  }
  box([a0, depth - w, low - spec.beam], [a1, depth, low], post);

  // The slab, d measured from the posts' line (0) back to the wall (depth), rising as it goes - out
  // past the posts over its overhang, and tucked into the wall.
  const point = (a: number, d: number, onTop: boolean): Vec3 => at(a, depth - d, low + d * slope + (onTop ? rise : 0));
  buildSlopedSlab(b, point, a0 - spec.overhang, a1 + spec.overhang, -spec.overhang, depth + TUCK, along, outward, covering, underside);
  if (colliders) {
    const e0 = a0 - spec.overhang;
    const e1 = a1 + spec.overhang;
    colliders.hull([
      point(e0, -spec.overhang, false), point(e1, -spec.overhang, false), point(e0, depth, false), point(e1, depth, false),
      point(e0, -spec.overhang, true), point(e1, -spec.overhang, true), point(e0, depth, true), point(e1, depth, true),
    ]);
  }
}
