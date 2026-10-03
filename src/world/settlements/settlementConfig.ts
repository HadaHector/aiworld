import type { BuildingDef } from "../buildings/buildingTypes";

/**
 * How settlements are laid out: gates, streets, house plots and how the ground is flattened under
 * them. Lengths are world units (metres).
 *
 * What a settlement looks like - how big each tier grows, and which buildings it builds - is its
 * biome's SettlementStyle, loaded from a pack's settlements/ folder. What is here are the rules
 * every settlement follows whatever its style.
 */

export type SettlementTier = "hamlet" | "village" | "town";

export interface SettlementTierDef {
  /** Gates sit on a circle this far from the centre; streets and houses stay inside it. */
  radius: number;
  /** Chance a side street is tried at each branching point along a main street. */
  sideStreetChance: number;
  /** Side street length range. */
  sideStreetLength: [number, number];
  /** Chance a plot along a street is built on, rather than left as a gap. */
  plotFill: number;
  squareRadius: number;
}

/** The houses a style builds - see settlementLayout.ts. */
export interface HouseStyle {
  /** The buildings (a pack's buildings/ folder) its plots are built with, each picked as often as
   *  its weight over the sum of them all - and each house its own variant of it. */
  buildings: { building: BuildingDef; weight: number }[];
  /** Front wall this far back from the street's level edge. At least far enough that the whole
   *  footprint is past where a plot's levelling fades out next to a street (terrainSampler.ts). */
  setback: [number, number];
  /** Gap between neighbouring houses along a street. */
  gap: [number, number];
}

/** What settlements in a biome look like. Several biomes may share one. */
export interface SettlementStyle {
  id: string;
  tiers: Record<SettlementTier, SettlementTierDef>;
  houses: HouseStyle;
}

/** Site score thresholds (settlementSites.ts's 0..1 score) for the bigger tiers. The best ground
 *  gets the biggest places. */
export const TOWN_MIN_SCORE = 0.72;
export const VILLAGE_MIN_SCORE = 0.5;

// --- Gates ---
//
// A gate is where a countryside road meets the settlement's own streets. It is chosen by looking at
// the ground, not just the direction of the neighbour: a gate on a cliff edge, in a river, or at the
// top of a slope no street can climb would leave a road that arrives somewhere unusable.

/** A new road reuses an existing gate if it is heading within this angle of it. */
export const GATE_MERGE_ANGLE = (40 * Math.PI) / 180;
/** Two distinct gates are at least this far apart around the circle. */
export const GATE_MIN_SEPARATION = (35 * Math.PI) / 180;
/** How far either side of the neighbour's direction a gate may be moved to find better ground, and
 *  in what steps. */
export const GATE_SEARCH_ANGLE = (70 * Math.PI) / 180;
export const GATE_SEARCH_STEP = (7 * Math.PI) / 180;
/** Largest height difference allowed across the gate's own spot (probes this far out). */
export const GATE_FLAT_RADIUS = 8;
export const GATE_MAX_RELIEF = 4;
/** The way in from the gate to the centre: sampled this often, no step steeper than
 *  GATE_APPROACH_MAX_STEP_GRADE, and the overall climb no steeper than GATE_APPROACH_MAX_GRADE. */
export const GATE_APPROACH_STEP = 5;
export const GATE_APPROACH_MAX_STEP_GRADE = 0.3;
export const GATE_APPROACH_MAX_GRADE = 0.16;
/** Roads arrive at a gate head-on: a road is routed to a point this far straight out from the gate
 *  and runs straight in from there, so it meets the main street leaving the gate in one line instead
 *  of turning sharply at the gate itself. Long enough for the corner where the route turns onto it
 *  to be rounded at the full road corner radius (roadShaping.ts's roundCorners rounds at most half
 *  of each neighbouring stretch). The gate check tests this stretch of ground too - see gates.ts. */
export const GATE_APPROACH_LENGTH = 50;
/** Main streets likewise leave a gate straight inward for this long before their own route
 *  takes over. */
export const STREET_GATE_STRAIGHT = 20;
/** Where no gate passes the checks above, a second search looks further round the circle with
 *  these looser limits - a harder way in beats no road at all. It still insists on dry, passable
 *  ground at the gate, and on no water between the gate and the centre. */
export const GATE_RELAXED = {
  searchAngle: (110 * Math.PI) / 180,
  maxRelief: 7,
  approachMaxStepGrade: 0.45,
  approachMaxGrade: 0.26,
};

/** Countryside roads may not pass closer to a settlement's centre than its radius minus this -
 *  so they end at a gate instead of cutting across the houses to reach it. */
export const GATE_ROAD_EXCLUSION_MARGIN = 8;
/** A road whose route passes this close to another gate of the settlement it is heading for ends
 *  there instead - it has arrived, and merges with the roads already using that gate rather than
 *  running on round the rim to its own. */
export const GATE_PASS_SNAP = 37;

// --- Streets ---

/** Street widths as a fraction of a countryside road's - level ground, painted surface and verge
 *  all scale with it (see RoadLine.widthScale). A main street carries the road that arrives at its
 *  gate on into the settlement, so it stays the road's own width; only side streets are narrower. */
export const MAIN_STREET_WIDTH = 1;
export const SIDE_STREET_WIDTH = 0.45;
/** Street routing grid - fine enough to wind between the ground a settlement actually has, coarse
 *  enough that a street bending back on a slope keeps its legs further apart than a main street is
 *  wide. */
export const STREET_GRID = 6;
/** Terrain is sampled for layout checks (street grades, house plots) on this finer lattice. */
export const LAYOUT_SAMPLE_GRID = 4;
/** Street grades: free below the easy grade, steeply penalised above it, impassable above max. */
export const STREET_EASY_GRADE = 0.06;
export const STREET_MAX_GRADE = 0.28;
export const STREET_GRADE_WEIGHT = 8;
/** A straightened street stretch may climb no steeper than this. */
export const STREET_STRAIGHT_MAX_GRADE = 0.14;
/** Street surface smoothing along its length. */
export const STREET_PROFILE_SMOOTH_REACH = 12;
/** Streets meet the road at a gate, and each other at a junction, at the same height: the first and
 *  last stretch of a street is blended to the height it joins over this length. */
export const STREET_JOIN_BLEND = 20;
/** ...or longer where the height to make up needs it, so the join itself climbs no steeper than
 *  this - a road at a gate can sit several metres into a cutting. */
export const STREET_JOIN_MAX_GRADE = 0.1;
/** Last word on a street's surface: no stretch steeper than this, cutting or filling as needed. */
export const STREET_PROFILE_MAX_GRADE = 0.16;
/** Side streets branch off a main street about this often. */
export const SIDE_STREET_SPACING: [number, number] = [28, 45];
/** A side street keeps this far clear of every other street but the one it branches from. */
export const SIDE_STREET_CLEARANCE = 14;

// --- Houses ---

export interface HouseVariant {
  /** Along the street. */
  width: [number, number];
  /** Back from the street. */
  depth: [number, number];
  wallHeight: [number, number];
  weight: number;
}

/** A house's floor is its street's surface height in front of it plus this step up - so a row of
 *  houses climbs with its street instead of each sitting at its own plot's average height, a
 *  little above or sunk below the street depending on the slope behind it. */
export const HOUSE_FLOOR_ABOVE_STREET = 0.2;
/** The ground under a house may be at most this far above or below its floor before the plot is
 *  given up. Generous on purpose: the plot is levelled to the floor (see padField.ts), so on a
 *  slope it becomes a terrace cut into the hill - past this it would be a pit or a plinth. */
export const HOUSE_MAX_CUT_FILL = 6;

// --- Ground under buildings ---

/** Around a pad the ground returns to its own level at this slope, as wide as that takes - the same
 *  rule road shoulders follow (roadConfig's ROAD_SIDE_SLOPE) - between these widths. */
export const PAD_SIDE_SLOPE = 0.6;
export const PAD_BLEND_MIN = 1.5;
export const PAD_BLEND_MAX = 10;
/** Pads are painted with the road surface by reporting a road gap this much larger than the
 *  distance to the pad's edge: full surface under the house, fading out a few metres around it. */
export const PAD_PAINT_OFFSET = 3.5;

export const SETTLEMENT_LAYOUT_SALT = 811;
