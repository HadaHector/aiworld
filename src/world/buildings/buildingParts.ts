import type { BuildingPartDef, ChimneySpec, FramedSpec, HousePart, Paint, PartChoice, WallSide } from "./buildingTypes";
import { FOUNDATION_DEPTH, roll, type Vec3 } from "./buildingGeometry";

/**
 * Building parts: the pieces a building generator leaves to a generator of their own (see
 * BuildingPartDef). The building works out where each goes and hands it a slot; the part fills it.
 */

/** How each of a building's parts is painted - what a part's pieces are painted as. */
export type PartPaints = Record<HousePart, Paint>;

/**
 * Where a part goes on a wall: a stretch of it, a bay or a few wide, seen from the front. Points are
 * given as [along, up, out]: along it, 0 is the slot's middle; out from it, 0 is the wall's face.
 */
export interface WallSlot {
  /** Lays a box against the wall: `a0` to `a1` metres along it, `y0` to `y1` up, standing out between
   *  `out0` and `out1` metres from its face (negative: into the wall). No bottom. */
  box(a0: number, a1: number, y0: number, y1: number, out0: number, out1: number, paint: Paint): void;
  /** A flat polygon, its corners as [along, up, out], facing toward `towards` (the same way). */
  face(corners: Vec3[], towards: Vec3, paint: Paint): void;
  /** The floor's height, and the most an opening may reach up to (under the eaves). */
  floor: number;
  top: number;
  /** The top of the house's highest roof, and how far its plinth stands out from the wall. */
  ridge: number;
  plinthOutset: number;
  /** How far either side of the middle it may reach before it meets a corner post or the next bay. */
  halfRoom: number;
  /** Which wall it is on, and whether it reaches an inner corner - where another wing of the house
   *  stands right beside it. */
  wall: WallSide;
  innerCorner: boolean;
}

/** How many bays a wall part takes up. */
export function partSpan(part: BuildingPartDef): number {
  switch (part.generator) {
    case "framed":
      return part.framed!.span;
    case "chimney":
      return part.chimney!.span;
  }
}

/**
 * How far an opening's pieces stand out from the wall's face (metres), each layer well clear of the
 * one behind it - a few centimetres reads as a flat decal and flickers into the layer behind at a
 * distance, where the depth buffer is coarse. The head stands proudest, then the jambs, the glazing
 * bars in front of the panel, the panel well in front of the wall. Every piece starts a little inside
 * the wall, so none of them has a face lying in the wall's own plane.
 */
const OUT = { panel: 0.07, bars: 0.1, frame: 0.15, head: 0.18 };
const SET_IN = -0.03;

/** Fills a wall slot with a part. False where the slot leaves it too little room to be built. */
export function buildWallPart(part: BuildingPartDef, slot: WallSlot, paints: PartPaints, rng: () => number): boolean {
  switch (part.generator) {
    case "framed":
      return buildFramed(part.framed!, slot, paints);
    case "chimney":
      return buildChimney(part.chimney!, slot, paints, rng);
  }
}

function buildFramed(spec: FramedSpec, slot: WallSlot, paints: PartPaints): boolean {
  const { box } = slot;
  const f = spec.frame;
  const reach = Math.max(spec.headReach, spec.sillReach ?? 0);
  const half = Math.min(spec.width / 2, slot.halfRoom - f - reach);
  const bottom = slot.floor + spec.sill;
  const top = Math.min(bottom + spec.height, slot.top - f);
  if (half < 0.2 || top - bottom < 0.4) return false;
  const frame = paints[spec.parts.frame];

  box(-half, half, bottom, top, SET_IN, OUT.panel, paints[spec.parts.panel]);
  // Jambs at its two edges, and a head over them, reaching past them.
  box(-half - f, -half, bottom, top + f, SET_IN, OUT.frame, frame);
  box(half, half + f, bottom, top + f, SET_IN, OUT.frame, frame);
  const headHalf = half + f + spec.headReach;
  box(-headHalf, headHalf, top, top + f, SET_IN, spec.headReach > 0 ? OUT.head : OUT.frame, frame);
  // Glazing bars, evenly spaced up and across the panel.
  const [up, across] = spec.bars;
  for (let k = 1; k <= up; k++) {
    const a = -half + (2 * half * k) / (up + 1);
    box(a - f / 4, a + f / 4, bottom, top, SET_IN, OUT.bars, frame);
  }
  for (let k = 1; k <= across; k++) {
    const y = bottom + ((top - bottom) * k) / (across + 1);
    box(-half, half, y - f / 4, y + f / 4, SET_IN, OUT.bars, frame);
  }
  // A sill under it, wider and standing further out.
  if (spec.sillReach !== null) {
    const sillHalf = half + f + spec.sillReach;
    box(-sillHalf, sillHalf, bottom - f, bottom, SET_IN, OUT.frame + spec.sillReach, frame);
  }
  return true;
}

/**
 * A chimney built against the outside of a wall, from a foundation of its own: a broad breast (the
 * fireplace behind it) up to its shoulders, sloping in to a narrower stack that rises through the
 * eaves to stand `rise` above the ridge, capped by a projecting band with pots on it. Not by an
 * inner corner, where it would stand in the other wing's way.
 */
function buildChimney(spec: ChimneySpec, slot: WallSlot, paints: PartPaints, rng: () => number): boolean {
  if (slot.innerCorner) return false;
  const { box, face } = slot;
  const body = paints[spec.parts.body];
  const cap = paints[spec.parts.cap];
  // It starts inside the wall, so no face of it lies in the wall's plane.
  const back = -0.05;
  const foundationReach = spec.foundation.reach;
  const breastHalf = Math.min(spec.width / 2, slot.halfRoom - foundationReach);
  const stackHalf = Math.min(spec.stackWidth / 2, breastHalf - 0.1);
  if (stackHalf < 0.2) return false;
  const breastOut = spec.depth;
  const stackOut = Math.min(spec.stackDepth, breastOut);

  // The foundation: from below ground to a little above the house's floor, and out past its plinth
  // (never level with the plinth's face or its top).
  const footTop = slot.floor + spec.foundation.height;
  const footOut = Math.max(breastOut + foundationReach, slot.plinthOutset + 0.12);
  box(-breastHalf - foundationReach, breastHalf + foundationReach, -FOUNDATION_DEPTH, footTop, back, footOut, body);

  // The breast, up to the shoulders.
  const shoulder = Math.max(footTop + 0.5, slot.floor + spec.shoulder);
  box(-breastHalf, breastHalf, footTop, shoulder, back, breastOut, body);
  // The shoulders: sloping in from the breast to the stack, steeply enough to shed rain.
  const slopeTop = shoulder + Math.max(breastHalf - stackHalf, breastOut - stackOut) * 1.2;
  face([[-breastHalf, shoulder, breastOut], [breastHalf, shoulder, breastOut], [stackHalf, slopeTop, stackOut], [-stackHalf, slopeTop, stackOut]], [0, 1, 1], body);
  for (const side of [-1, 1]) {
    face([[side * breastHalf, shoulder, back], [side * breastHalf, shoulder, breastOut], [side * stackHalf, slopeTop, stackOut], [side * stackHalf, slopeTop, back]], [side, 1, 0], body);
  }

  // The stack, up past the ridge, and the band capping it, with a closed underside.
  const top = Math.max(slopeTop + 1, slot.ridge + roll(spec.rise, rng));
  const capBottom = top - spec.cap.height;
  box(-stackHalf, stackHalf, slopeTop, capBottom, back, stackOut, body);
  const capHalf = stackHalf + spec.cap.reach;
  const capOut = stackOut + spec.cap.reach;
  box(-capHalf, capHalf, capBottom, top, back, capOut, cap);
  face([[-capHalf, capBottom, back], [capHalf, capBottom, back], [capHalf, capBottom, capOut], [-capHalf, capBottom, capOut]], [0, -1, 0], cap);

  // Pots in a row along the top.
  const pots = spec.pots;
  if (pots.count > 0) {
    const r = pots.width / 2;
    const middle = (back + stackOut) / 2;
    for (let k = 0; k < pots.count; k++) {
      const a = -stackHalf + (2 * stackHalf * (k + 1)) / (pots.count + 1);
      box(a - r, a + r, top, top + pots.height, middle - r, middle + r, paints[spec.parts.pots]);
    }
  }
  return true;
}

/** One of a list of choices, each as likely as its weight - null if none has any. */
export function pickPart(choices: PartChoice[], rng: () => number): BuildingPartDef | null {
  const total = choices.reduce((sum, choice) => sum + choice.weight, 0);
  if (total <= 0) return null;
  let at = rng() * total;
  for (const choice of choices) {
    at -= choice.weight;
    if (at < 0) return choice.part;
  }
  return choices[choices.length - 1].part;
}
