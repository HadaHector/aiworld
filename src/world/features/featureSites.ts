import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { SettlementSite } from "../settlements/settlementSites";
import { CELL_SPACING } from "../cells/config";
import { deriveSeed, mulberry32 } from "../rng";
import { NO_FEATURE, type FeatureKindDef } from "./featureTypes";
import { evaluateQuarry, quarryEntrance, quarryFootprint, type QuarryShape } from "./quarry";

/** One feature as it stands in the world. */
export interface FeatureSite {
  id: number;
  /** Its kind's index in WorldContent.featureKinds - what the ground's samples carry. */
  kindIndex: number;
  kind: FeatureKindDef;
  x: number;
  z: number;
  areaId: number;
  /** Roads keep out of this circle (other than the feature's own track). 0 for a settlement, whose
   *  roads come in at its gates instead. */
  footprint: number;
  /** Where its track starts, the point a little way out it is routed from, and the level it starts
   *  at. Null for a feature with no track of its own (a settlement is on the road network itself). */
  entrance: { x: number; z: number; approachX: number; approachZ: number; height: number } | null;
  /** The type's own data: one of these is set. */
  quarry: QuarryShape | null;
  settlement: SettlementSite | null;
}

/** No feature rolled. */
export const NO_ROLL = -1;

// Candidates are scattered over most of the cell, not all of it: a feature at the very edge would
// sit next to whatever the cell beside it rolled.
const CANDIDATES_PER_CELL = 24;
const CANDIDATE_RADIUS = CELL_SPACING * 0.4;
/** Kept this far clear of a settlement's edge, and of each other. */
const SETTLEMENT_CLEARANCE = 250;
const MIN_FEATURE_SPACING = 500;

const FEATURE_ROLL_SALT = 901;
const FEATURE_PLACE_SALT = 902;

function roll(range: [number, number], rng: () => number): number {
  return range[0] + (range[1] - range[0]) * rng();
}

/**
 * What each land cell would like to hold: one kind (its index in `kinds`) drawn from its biome's
 * `features` list, or NO_ROLL. Each cell has its own random stream, so what one cell rolls never
 * shifts another's.
 */
export function rollCellFeatures(seed: number, cellSites: CellPoint[], sampleTerrain: TerrainSampler, kinds: FeatureKindDef[]): number[] {
  const kindIndex = new Map(kinds.map((kind, i) => [kind.id, i]));
  return cellSites.map((site, cell) => {
    const chances = sampleTerrain(site.x, site.z).primaryBiome.features;
    const total = chances.reduce((sum, chance) => sum + chance.odds, 0);
    if (total <= 0) return NO_ROLL;
    let pick = mulberry32(deriveSeed(seed, FEATURE_ROLL_SALT + cell))() * total;
    const chosen = chances.find((chance) => (pick -= chance.odds) < 0) ?? chances[chances.length - 1];
    if (chosen.featureId === NO_FEATURE) return NO_ROLL;
    return kindIndex.get(chosen.featureId) ?? NO_ROLL;
  });
}

export interface FeatureInput {
  seed: number;
  cellSites: CellPoint[];
  sampleTerrain: TerrainSampler;
  kinds: FeatureKindDef[];
  /** rollCellFeatures's answer. */
  rolls: number[];
  /** Already placed (settlements/settlementSites.ts), in the cells that rolled one. */
  settlements: SettlementSite[];
}

/**
 * Every cell's feature, placed.
 *
 * Settlements come first, as their sites were placed by their own rules in the cells that rolled
 * one. Every other cell looks for ground that suits its roll - a quarry wants a hillside - among a
 * scatter of points over the cell, and takes the best. A cell where nothing suits is simply empty:
 * the roll is what the cell would like, the ground is what it gets.
 */
export function placeFeatures({ seed, cellSites, sampleTerrain, kinds, rolls, settlements }: FeatureInput): FeatureSite[] {
  const features: FeatureSite[] = settlements.map((settlement) => ({
    id: 0,
    kindIndex: rolls[settlement.cellId],
    kind: kinds[rolls[settlement.cellId]],
    x: settlement.x,
    z: settlement.z,
    areaId: settlement.areaId,
    footprint: 0,
    entrance: null,
    quarry: null,
    settlement,
  }));

  const clearOfOthers = (x: number, z: number): boolean =>
    settlements.every((s) => Math.hypot(s.x - x, s.z - z) > s.radius + SETTLEMENT_CLEARANCE) &&
    features.every((f) => f.settlement !== null || Math.hypot(f.x - x, f.z - z) > MIN_FEATURE_SPACING);

  for (let cell = 0; cell < cellSites.length; cell++) {
    const index = rolls[cell];
    if (index === NO_ROLL) continue;
    const kind = kinds[index];
    const spec = kind.quarry;
    if (kind.type !== "quarry" || !spec) continue;
    const site = cellSites[cell];

    const rng = mulberry32(deriveSeed(seed, FEATURE_PLACE_SALT + cell));
    // One size per cell, rolled before the search, so where it lands does not change how big it is.
    const size = {
      halfLength: roll(spec.floorLength, rng) / 2,
      halfWidth: roll(spec.floorWidth, rng) / 2,
      benchHeight: roll(spec.benchHeight, rng),
      benchWidth: roll(spec.benchWidth, rng),
    };
    let best: ReturnType<typeof evaluateQuarry> = null;
    for (let attempt = 0; attempt < CANDIDATES_PER_CELL; attempt++) {
      const radius = Math.sqrt(rng()) * CANDIDATE_RADIUS;
      const angle = rng() * Math.PI * 2;
      const x = site.x + Math.cos(angle) * radius;
      const z = site.z + Math.sin(angle) * radius;
      if (!clearOfOthers(x, z)) continue;
      const scored = evaluateQuarry(x, z, spec, size, sampleTerrain);
      if (scored && (!best || scored.score > best.score)) best = scored;
    }
    if (!best) continue;

    const shape = best.shape;
    features.push({
      id: 0,
      kindIndex: index,
      kind,
      x: shape.x,
      z: shape.z,
      areaId: best.areaId,
      footprint: quarryFootprint(shape),
      entrance: kind.road ? { ...quarryEntrance(shape), height: shape.level } : null,
      quarry: shape,
      settlement: null,
    });
  }
  features.forEach((feature, id) => (feature.id = id));
  return features;
}
