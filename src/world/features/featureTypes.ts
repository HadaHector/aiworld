import type { FeatureNaming } from "../naming/nameGenerator";
import type { Spill } from "../props/propTypes";
import type { MaterialLayer } from "../materials/materialTypes";
import type { SettlementTier } from "../settlements/settlementConfig";
import type { BuildingDef } from "../buildings/buildingTypes";
import type { PropDef, PropGroupDef } from "../props/propTypes";

/**
 * What stands in a cell besides the land itself: one major feature per cell at most - a settlement,
 * a quarry, a compound (a camp, a farmstead), and in time a mine. Settlements keep their own placement and layout
 * rules (settlements/), but which cells have one is rolled here, like any other feature.
 *
 * A feature kind is content (a pack's features/ folder); its `type` picks the code that places it
 * and shapes the ground under it. A biome lists which kinds its cells roll, with odds - "none"
 * among them to leave a share of cells empty on purpose.
 */
export const NO_FEATURE = "none";

export const FEATURE_TYPES = ["quarry", "settlement", "compound"] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

/** `features: [{ feature, odds }]` in a biome: which kinds its cells roll, and how likely each is -
 *  its odds over the sum of them all. `feature: "none"` is a cell left empty. */
export interface FeatureChance {
  featureId: string;
  odds: number;
}

/** A quarry: a level floor cut back into a hillside, its back and sides a stepped rock face, and
 *  its spoil tipped out in front. Each range is rolled per quarry. */
export interface QuarrySpec {
  /** How far the floor reaches into the hill (along the slope), and how wide it is across it. */
  floorLength: [number, number];
  floorWidth: [number, number];
  /** The face is cut in benches: each this tall, its face this steep (rise over run), with a ledge
   *  this wide before the next. */
  benchHeight: [number, number];
  benchSteepness: number;
  benchWidth: [number, number];
  /** How steeply the spoil in front of the floor falls back to the ground (rise over run). */
  spoilSlope: number;
  /** The hillside it is cut into: steeper than the first, less steep than the second (rise over
   *  run). Between them, the nearer the third, the better. */
  grade: [number, number];
  idealGrade: number;
}

/** How a compound's buildings stand round its yard - see FEATURES.md. Each is built with the first
 *  compound that needs it: `ring`, round the yard's rim facing in, its entrances kept free - its
 *  roads come to it; `roadside`, the same ring round a yard a road already laid runs straight
 *  through - sited after the roads, on one (a coaching inn), its two ways in where the road
 *  crosses its rim. */
export const COMPOUND_ARRANGEMENTS = ["ring", "roadside"] as const;
export type CompoundArrangement = (typeof COMPOUND_ARRANGEMENTS)[number];

/** Where a compound's trail leads: `clearing` - out into the ground round it, the way furthest from
 *  its roads. */
export const TRAIL_DESTINATIONS = ["clearing"] as const;
export type TrailDestination = (typeof TRAIL_DESTINATIONS)[number];

/** A way out of a compound that is not a road: a narrow path on the ground as it lies, ending where
 *  it gets to. `length` is rolled; it is made with `chance`. */
export interface CompoundTrailSpec {
  to: TrailDestination;
  length: [number, number];
  chance: number;
}

/** Which way a compound building's door is turned: to the yard's middle. */
export const COMPOUND_DOORS = ["yard"] as const;
export type CompoundDoor = (typeof COMPOUND_DOORS)[number];

/** A building a compound puts up: `count` of it (rolled), each with `chance`. A `required` one must
 *  fit, or the compound is not placed there. */
export interface CompoundBuildingSpec {
  building: BuildingDef;
  count: [number, number];
  chance: number;
  required: boolean;
  doorTo: CompoundDoor;
}

/**
 * Where a compound sets a prop (or a group of them) down:
 * - `yard`: anywhere in the yard, turned freely - off the ways across it from its entrances to its
 *   middle;
 * - `yardEdge`: round the yard's rim, in the gaps the buildings leave, facing the yard;
 * - `byBuilding`: beside a building (of `building`, if given), along its side near its front;
 * - `front`: before a building's front (of `building`, if given), beside its door but off the way to
 *   it, facing out - a trough before a stable, crates before a store;
 * - `trail`: beside its trails, out past the buildings, lying along them;
 * - `gate`: across a lane's mouth, between the buildings, facing out along it (a gate) - one to a
 *   lane at most, so `count` is how many of its lanes get one;
 * - `road`: beside a road leading away from it, `distance` metres out along the road (a wayside
 *   sign) - one to a way at most, as a gate is.
 */
export const PROP_ANCHORS = ["yard", "yardEdge", "byBuilding", "front", "trail", "gate", "road"] as const;
export type PropAnchor = (typeof PROP_ANCHORS)[number];

/** A prop, or a group of them, a compound sets down: `count` of it (rolled), each with `chance`,
 *  at its anchor - where it fits, clear of the buildings, the lanes, the roads and each other. */
export interface CompoundPropSpec {
  placed: { kind: "prop"; prop: PropDef } | { kind: "group"; group: PropGroupDef };
  count: [number, number];
  chance: number;
  at: PropAnchor;
  building: BuildingDef | null;
  /** For `road`: how far out along the road it stands, metres from the compound's middle. */
  distance: [number, number];
}

/**
 * A compound: a yard with buildings standing round it, its entrances where its roads arrive (its
 * `road` block decides how many) and its trails lead off. No streets - one open space everything
 * faces. Each range is rolled per compound.
 */
export interface CompoundSpec {
  /** The ground it wants: the grade across it within the range (rise over run); tree cover round
   *  it at least the first, the more the better up to the second (0-1, as the trees scatter by);
   *  a river within `nearWater` counts in its favour (null: no matter); and at least
   *  `fromSettlements` metres past every settlement's edge (null: no matter) - a roadside inn is
   *  for the road between towns, not beside one. */
  site: { grade: [number, number]; cover: [number, number]; nearWater: number | null; fromSettlements: number | null };
  /** The yard: a level round of trodden ground, this radius. */
  yard: { radius: [number, number] };
  /** How the level ground under its yard, buildings and props blends back to the ground round it -
   *  see PadBlend: `slope` the steepest its banks stand, `blend` how narrow and wide they may get -
   *  and `spill`, the ground under and round each of them painted (trodden earth), or none. */
  pads: { slope: number; blend: [number, number]; spill: Spill | null };
  arrangement: CompoundArrangement;
  trails: CompoundTrailSpec[];
  buildings: CompoundBuildingSpec[];
  props: CompoundPropSpec[];
}

/**
 * A feature's place in the road network, which is planned over settlements and features alike
 * (roads/places.ts): how much a road to it matters, how many roads it takes, which kinds of place
 * it would rather be joined to, and how far it will reach for one.
 */
export interface PlaceRoadSpec {
  /** How much it matters to the roads: a village is 2. Important places are joined first and most
   *  directly, the less important hang off them, and the road between two places is as grand as
   *  the lesser of them (roadConfig's ROAD_CLASSES). A settlement gives one per tier. */
  importance: number | Record<SettlementTier, number>;
  /** The fewest roads it is given, and the most it takes: [1, 1] is a dead end, two or more at the
   *  least puts it on a road running through. */
  links: [number, number];
  /** Kinds of place (feature ids - "settlement" for any settlement) a road from it would rather
   *  lead to: a mine to a smelter, a camp to a sawmill. */
  wants: string[];
  /** The longest straight line it will be joined across. */
  maxLength: number;
}

export interface FeatureKindDef {
  id: string;
  name: string;
  /** "settlement" is placed and laid out by settlements/ - in the biome's own `settlement` style,
   *  with its streets, plots and gates - and uses none of the fields below but `road`. */
  type: FeatureType;
  /** A quarry's own block; null for any other type. */
  quarry: QuarrySpec | null;
  /** A compound's own block; null for any other type. */
  compound: CompoundSpec | null;
  /** Trees, bushes and stones are cleared off the ground the feature changes, and up to the first
   *  distance past its edge, returning by the second. */
  clearing: [number, number];
  /** The share (0-1) of the trees its clearing takes - past its own circle, round a compound - left
   *  standing as stumps: worked timber rather than a lawn. 0 for none. */
  stumps: number;
  /** Its place in the road network (see PlaceRoadSpec), or null for a feature nobody drives to. */
  road: PlaceRoadSpec | null;
  /** How each of its own is named (see FeatureNaming) - shown on the map and on its signs - or null:
   *  known by its kind's name. */
  names: FeatureNaming | null;
  /** What the feature's ground is painted with: a material, laid over everything else, and its
   *  weight - a graph that can read `featureGap` (distance past the feature's edge, 0 inside it),
   *  `featureDepth` (how far the ground was cut or filled there) and the usual inputs. */
  ground: MaterialLayer | null;
}
