import type { MaterialLayer } from "../materials/materialTypes";

/**
 * What stands in a cell besides the land itself: one major feature per cell at most - a settlement,
 * a quarry, and in time a farm, a mine, a camp. Settlements keep their own placement and layout
 * rules (settlements/), but which cells have one is rolled here, like any other feature.
 *
 * A feature kind is content (a pack's features/ folder); its `type` picks the code that places it
 * and shapes the ground under it. A biome lists which kinds its cells roll, with odds - "none"
 * among them to leave a share of cells empty on purpose.
 */
export const NO_FEATURE = "none";

export const FEATURE_TYPES = ["quarry", "settlement"] as const;
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

export interface FeatureKindDef {
  id: string;
  name: string;
  /** "settlement" is placed and laid out by settlements/ - in the biome's own `settlement` style,
   *  with its streets, plots and gates - and uses none of the fields below. */
  type: FeatureType;
  /** A quarry's own block; null for any other type. */
  quarry: QuarrySpec | null;
  /** Trees, bushes and stones are cleared off the ground the feature changes, and up to the first
   *  distance past its edge, returning by the second. */
  clearing: [number, number];
  /** A track to the nearest road: its width next to a road's (1), and the furthest it will run.
   *  Null for a feature nobody drives to. */
  road: { width: number; maxLength: number } | null;
  /** What the feature's ground is painted with: a material, laid over everything else, and its
   *  weight - a graph that can read `featureGap` (distance past the feature's edge, 0 inside it),
   *  `featureDepth` (how far the ground was cut or filled there) and the usual inputs. */
  ground: MaterialLayer | null;
}
