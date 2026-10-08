import type { LeanToRoofSpec, Paint } from "./buildingTypes";
import { roll, type ModelBuilder, type Vec3 } from "./buildingGeometry";
import type { PartPaints } from "./buildingParts";
import type { RoofBlockInput, RoofEnd, RoofInput, RoofPlan } from "./pitchedRoof";

/**
 * A lean-to roof: one slope over a lower block, rising from its outer wall to the taller wall it
 * leans against (its block's `lean` side) - a thick slab, its covering on top, its boards under it,
 * a fascia along its low edge and boards up its verges; and at each free end a wall under the slope,
 * from the eaves up to it, as a gable is filled.
 */
export function planLeanToRoof(spec: LeanToRoofSpec, rng: () => number): RoofPlan {
  return {
    shape: "gable",
    slope: Math.tan((roll(spec.pitch, rng) * Math.PI) / 180),
    overhang: spec.overhang,
    thickness: spec.thickness,
    ridgeSag: 0,
    slopeSag: 0,
    ridgeHeight: 0,
    mono: true,
  };
}

/** How far a slab tucks into the wall it leans on, so no gap shows where they meet. */
export const TUCK = 0.08;

/**
 * A sloping slab - a lean-to's, a porch's - from `d0` to `d1` across its slope and `a0` to `a1`
 * along it: `point(a, d, top)` is a point on its underside (or its top) there, `along` and `down`
 * the directions in the model its a runs and its low edge faces. Its covering on top, `underside`
 * under it and round its low edge and its verges; its high edge is in the wall it leans on.
 */
export function buildSlopedSlab(
  b: ModelBuilder,
  point: (a: number, d: number, top: boolean) => Vec3,
  a0: number,
  a1: number,
  d0: number,
  d1: number,
  along: Vec3,
  down: Vec3,
  covering: Paint,
  underside: Paint,
): void {
  const at = (a: number, d: number, top = false): Vec3 => point(a, d, top);
  b.faceToward([at(a0, d0, true), at(a1, d0, true), at(a1, d1, true), at(a0, d1, true)], [0, 1, 0], covering);
  b.faceToward([at(a0, d0), at(a1, d0), at(a1, d1), at(a0, d1)], [0, -1, 0], underside);
  b.faceToward([at(a0, d0), at(a1, d0), at(a1, d0, true), at(a0, d0, true)], down, underside);
  const back: Vec3 = [-along[0], -along[1], -along[2]];
  b.faceToward([at(a0, d0), at(a0, d1), at(a0, d1, true), at(a0, d0, true)], back, underside);
  b.faceToward([at(a1, d0), at(a1, d1), at(a1, d1, true), at(a1, d0, true)], along, underside);
}

/** How far a lean-to block's roof reaches past its end: its overhang at a free end, none where it
 *  meets something. */
const reachAt = (end: RoofEnd): number => (end.kind === "attached" ? 0 : end.overhang);

export function buildLeanToRoof(spec: LeanToRoofSpec, plan: RoofPlan, input: RoofInput, paints: PartPaints): void {
  const { b, eaves } = input;
  const { slope: s, overhang, thickness } = plan;
  const covering = paints[spec.parts.covering];
  const underside = paints[spec.parts.underside];
  const gable = paints[spec.parts.gable];
  const rise = thickness * Math.sqrt(1 + s * s);
  for (const k of input.blocks) buildBlock(k);

  function buildBlock(k: RoofBlockInput): void {
    // Across it, from its low wall (0) to its high one (span): which way c runs to get there.
    const highAtEnd = k.lean !== "c0";
    const [low, high] = highAtEnd ? [k.c0, k.c1] : [k.c1, k.c0];
    const towardHigh = highAtEnd ? 1 : -1;
    const span = Math.abs(high - low);
    const place = (a: number, c: number, y: number): Vec3 => (k.alongX ? [a, y, c] : [c, y, a]);
    /** A point `d` across from its low wall (negative: out over the overhang), `a` along it, on the
     *  slab's underside (or its top). */
    const point = (a: number, d: number, top: boolean): Vec3 => place(a, low + towardHigh * d, eaves + d * s + (top ? rise : 0));
    const along: Vec3 = k.alongX ? [1, 0, 0] : [0, 0, 1];
    const down: Vec3 = k.alongX ? [0, 0, -towardHigh] : [-towardHigh, 0, 0];
    buildSlopedSlab(b, point, k.a0 - reachAt(k.start), k.a1 + reachAt(k.end), -overhang, span + TUCK, along, down, covering, underside);
    // A free end's wall under the slope: from the eaves up to the slab, its wall's own face.
    for (const [end, a, sign] of [[k.start, k.a0, -1], [k.end, k.a1, 1]] as const) {
      if (end.kind === "attached") continue;
      const wall = (d: number, y: number): Vec3 => place(a, low + towardHigh * d, y);
      b.faceToward([wall(0, eaves), wall(span, eaves), wall(span, eaves + span * s)], [along[0] * sign, 0, along[2] * sign], gable);
    }
  }
}
