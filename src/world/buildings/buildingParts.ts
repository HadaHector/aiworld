import type { BuildingPartDef, ChimneySpec, FramedSpec, HousePart, Paint, PartChoice, StoneFrameSpec, TimberFrameSpec, WallSide } from "./buildingTypes";
import { FOUNDATION_DEPTH, roll, type Vec3 } from "./buildingGeometry";

/**
 * Building parts: the pieces a building generator leaves to a generator of their own (see
 * BuildingPartDef). The building works out where each goes and hands it a slot; the part fills it.
 * Most fill a slot on a wall (a door, a window, a chimney); a framing part is handed every wall of
 * the house at once.
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

/** How much of a wall a part took: how far either side of its middle it reaches, and how low its
 *  foot is - a part down at the floor stands where the wall's foot beam would run. */
export interface PartExtent {
  half: number;
  foot: number;
}

/** How many bays a wall part takes up. */
export function partSpan(part: BuildingPartDef): number {
  switch (part.generator) {
    case "framed":
      return part.framed!.span;
    case "chimney":
      return part.chimney!.span;
    case "timberFrame":
    case "stoneFrame":
      return 1;
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

/** Fills a wall slot with a part, and says how much of the wall it took - null where the slot leaves
 *  it too little room to be built (or it is no part for a wall slot). */
export function buildWallPart(part: BuildingPartDef, slot: WallSlot, paints: PartPaints, rng: () => number): PartExtent | null {
  switch (part.generator) {
    case "framed":
      return buildFramed(part.framed!, slot, paints);
    case "chimney":
      return buildChimney(part.chimney!, slot, paints, rng);
    case "timberFrame":
    case "stoneFrame":
      return null;
  }
}

function buildFramed(spec: FramedSpec, slot: WallSlot, paints: PartPaints): PartExtent | null {
  const { box } = slot;
  const f = spec.frame;
  const reach = Math.max(spec.headReach, spec.sillReach ?? 0);
  const half = Math.min(spec.width / 2, slot.halfRoom - f - reach);
  const bottom = slot.floor + spec.sill;
  const top = Math.min(bottom + spec.height, slot.top - f);
  if (half < 0.2 || top - bottom < 0.4) return null;
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
  return { half: half + f + reach, foot: spec.sillReach !== null ? bottom - f : bottom };
}

/**
 * A chimney built against the outside of a wall, from a foundation of its own: a broad breast (the
 * fireplace behind it) up to its shoulders, sloping in to a narrower stack that rises through the
 * eaves to stand `rise` above the ridge, capped by a projecting band with pots on it. Not by an
 * inner corner, where it would stand in the other wing's way.
 */
function buildChimney(spec: ChimneySpec, slot: WallSlot, paints: PartPaints, rng: () => number): PartExtent | null {
  if (slot.innerCorner) return null;
  const { box, face } = slot;
  const body = paints[spec.parts.body];
  const cap = paints[spec.parts.cap];
  // It starts inside the wall, so no face of it lies in the wall's plane.
  const back = -0.05;
  const foundationReach = spec.foundation.reach;
  const breastHalf = Math.min(spec.width / 2, slot.halfRoom - foundationReach);
  const stackHalf = Math.min(spec.stackWidth / 2, breastHalf - 0.1);
  if (stackHalf < 0.2) return null;
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
  return { half: breastHalf + foundationReach, foot: -FOUNDATION_DEPTH };
}

/**
 * One wall of a house, as a framing part is handed it: a straight run from corner to corner, seen
 * from the front. Points along it are metres from its start.
 */
export interface FramingWall {
  length: number;
  /** Where along it a post belongs between the corners: where the wall or the roof over it changes. */
  posts: number[];
  /** A gable standing over it - where along it its apex is, and how high. */
  gable: { at: number; ridge: number } | null;
  /** Stretches along its foot that a part stands in (a door, a chimney's foundation): no foot beam. */
  gaps: [number, number][];
  /** Lays a box against it: `a0` to `a1` metres along, `y0` to `y1` up, `out0` to `out1` out from its
   *  face (negative: into the wall). No bottom. */
  box(a0: number, a1: number, y0: number, y1: number, out0: number, out1: number, paint: Paint): void;
}

/**
 * A corner of the house as its framing is handed it, in a frame of its own: u runs along one of its
 * walls away from the corner, v along the other, both from the corner's point. At an outer corner
 * the house is where u and v are both positive, and its walls' faces stand at u 0 and v 0, the
 * outside below them.
 */
export interface FramingCorner {
  kind: "outer" | "inner";
  /** Lays a box at the corner: `u0` to `u1`, `v0` to `v1`, `y0` to `y1` up. No bottom. */
  box(u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, paint: Paint): void;
}

/** The house's shape as its framing is handed it: every wall, and every corner where two meet. */
export interface FramingInput {
  floor: number;
  eaves: number;
  walls: FramingWall[];
  corners: FramingCorner[];
}

/**
 * What a framing part settles before anything else is put on the walls, so the rest keeps clear of
 * it: how far along a wall from a corner it reaches, how far either side of a post between the
 * corners, and how much of the top of the wall it takes.
 */
export interface FramingPlan {
  cornerReach: number;
  postHalf: number;
  top: number;
}

export function planFraming(part: BuildingPartDef | null, rng: () => number): FramingPlan {
  switch (part?.generator) {
    case "timberFrame": {
      const spec = part.timberFrame!;
      return { cornerReach: roll(spec.corner, rng) / 2, postHalf: spec.post.width / 2, top: spec.plate.height };
    }
    case "stoneFrame": {
      const spec = part.stoneFrame!;
      return { cornerReach: spec.quoins.long, postHalf: spec.pilaster.width / 2, top: spec.cornice.height };
    }
    default:
      return { cornerReach: 0, postHalf: 0, top: 0 };
  }
}

/** Frames a house's walls. */
export function buildFraming(part: BuildingPartDef | null, plan: FramingPlan, input: FramingInput, paints: PartPaints): void {
  switch (part?.generator) {
    case "timberFrame":
      buildTimberFrame(part.timberFrame!, plan, input, paints);
      break;
    case "stoneFrame":
      buildStoneFrame(part.stoneFrame!, plan, input, paints);
      break;
  }
}

/** A band along the foot of a wall from `from` to `to`, in pieces around whatever stands there. */
function footBand(wall: FramingWall, from: number, to: number, y0: number, y1: number, out: number, paint: Paint): void {
  const gaps = [...wall.gaps].sort((a, b) => a[0] - b[0]);
  for (const [g0, g1] of [...gaps, [to, to] as [number, number]]) {
    const end = Math.min(g0, to);
    if (end - from > 0.05) wall.box(from, end, y0, y1, SET_IN, out, paint);
    from = Math.max(from, g1);
  }
}

const inGap = (wall: FramingWall, at: number): boolean => wall.gaps.some(([g0, g1]) => at > g0 && at < g1);

/**
 * A timber frame: a heavy square post on every corner, a beam along the foot of every wall (broken
 * where a door stands) and one along its top under the eaves, a post between them wherever the wall
 * or the roof over it changes, and a king post up the middle of every gable to its ridge.
 */
function buildTimberFrame(spec: TimberFrameSpec, plan: FramingPlan, input: FramingInput, paints: PartPaints): void {
  const timber = paints[spec.parts.timber];
  const { floor, eaves } = input;
  const sillTop = floor + spec.sill.height;
  const plateBottom = eaves - spec.plate.height;
  const half = plan.cornerReach;
  const { postHalf } = plan;
  for (const corner of input.corners) corner.box(-half, half, -half, half, floor, eaves, timber);
  for (const wall of input.walls) {
    const end = wall.length - half;
    footBand(wall, half, end, floor, sillTop, spec.sill.out, timber);
    // The top beam, under the eaves.
    wall.box(half, end, plateBottom, eaves, SET_IN, spec.plate.out, timber);
    // Posts between the beams; one standing in a gap stands on the floor.
    for (const at of wall.posts) wall.box(at - postHalf, at + postHalf, inGap(wall, at) ? floor : sillTop, plateBottom, SET_IN, spec.post.out, timber);
    // The king post, from the top beam to the ridge.
    if (wall.gable) wall.box(wall.gable.at - postHalf, wall.gable.at + postHalf, eaves, wall.gable.ridge, SET_IN, spec.post.out, timber);
  }
}

/**
 * A stone frame: quoins up every outer corner - dressed stones in courses, long along one wall and
 * short along the other, turn and turn about - a cornice along the top of every wall under the
 * eaves, maybe a string course along its foot, and a pilaster wherever the wall or the roof over it
 * changes. Its stones stand a little proud of the wall, and start a little inside it.
 */
function buildStoneFrame(spec: StoneFrameSpec, _plan: FramingPlan, input: FramingInput, paints: PartPaints): void {
  const stone = paints[spec.parts.stone];
  const shaded: Paint = { material: stone.material, tint: [stone.tint[0] * 0.9, stone.tint[1] * 0.9, stone.tint[2] * 0.9] };
  const { floor, eaves } = input;
  const foot = spec.band ? floor + spec.band.height : floor;
  const corniceBottom = eaves - spec.cornice.height;
  const inWall = 0.05;
  const { course, long, short, out } = spec.quoins;
  const courses = Math.max(1, Math.round((corniceBottom - foot) / course));
  const h = (corniceBottom - foot) / courses;
  const c = spec.cornice.out;
  const b = spec.band?.out ?? 0;
  for (const corner of input.corners) {
    if (corner.kind !== "outer") continue;
    // The cornice, and the band, turning the corner: the walls' own run between their corners.
    corner.box(-c, 0, -c, 0, corniceBottom, eaves, stone);
    if (spec.band) corner.box(-b, 0, -b, 0, floor, foot, stone);
    for (let k = 0; k < courses; k++) {
      const y0 = foot + k * h;
      const y1 = y0 + h;
      // Every other course a shade darker, so one stone reads from the next.
      const paint = k % 2 === 0 ? stone : shaded;
      // Each course a long stone along one wall, wrapping the corner, and a short one along the other.
      const [alongU, alongV] = k % 2 === 0 ? [long, short] : [short, long];
      if (k % 2 === 0) {
        corner.box(-out, alongU, -out, inWall, y0, y1, paint);
        corner.box(-out, inWall, inWall, alongV, y0, y1, paint);
      } else {
        corner.box(-out, inWall, -out, alongV, y0, y1, paint);
        corner.box(inWall, alongU, -out, inWall, y0, y1, paint);
      }
    }
  }
  for (const wall of input.walls) {
    wall.box(0, wall.length, corniceBottom, eaves, SET_IN, c, stone);
    if (spec.band) footBand(wall, 0, wall.length, floor, foot, b, stone);
    const half = spec.pilaster.width / 2;
    for (const at of wall.posts) wall.box(at - half, at + half, inGap(wall, at) ? floor : foot, corniceBottom, SET_IN, spec.pilaster.out, stone);
  }
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
