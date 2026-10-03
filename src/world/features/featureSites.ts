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
  /** Roads keep out of this circle (other than the feature's own track). */
  footprint: number;
  /** Where its track starts, the point a little way out it is routed from, and the level it starts
   *  at. Null for a feature with no road. */
  entrance: { x: number; z: number; approachX: number; approachZ: number; height: number } | null;
  quarry: QuarryShape;
}

// Candidates are scattered over most of the cell, not all of it: a feature at the very edge would
// sit next to whatever the cell beside it rolled.
const CANDIDATES_PER_CELL = 24;
const CANDIDATE_RADIUS = CELL_SPACING * 0.4;
/** Kept this far clear of a settlement's edge, and of each other. */
const SETTLEMENT_CLEARANCE = 250;
const MIN_FEATURE_SPACING = 500;

const FEATURE_ROLL_SALT = 901;
const FEATURE_PLACE_SALT = 902;

export interface FeatureInput {
  seed: number;
  cellSites: CellPoint[];
  sampleTerrain: TerrainSampler;
  kinds: FeatureKindDef[];
  settlements: SettlementSite[];
}

function roll(range: [number, number], rng: () => number): number {
  return range[0] + (range[1] - range[0]) * rng();
}

/**
 * Rolls each cell's major feature and finds it a place.
 *
 * A cell a settlement stands in has that for its feature and rolls nothing. Every other cell rolls
 * one kind from its biome's `features` list, then looks for ground that suits it - a quarry wants a
 * hillside - among a scatter of points over the cell, and takes the best. A cell where nothing suits
 * is simply empty: the roll is what the cell would like, the ground is what it gets.
 *
 * Each cell has its own random stream, so what one cell rolls never shifts another's.
 */
export function generateFeatureSites({ seed, cellSites, sampleTerrain, kinds, settlements }: FeatureInput): FeatureSite[] {
  const kindIndex = new Map(kinds.map((kind, i) => [kind.id, i]));

  // The cells settlements stand in.
  const settled = new Set<number>();
  for (const settlement of settlements) {
    let nearest = -1;
    let nearestSq = Infinity;
    cellSites.forEach((site, i) => {
      const distSq = (site.x - settlement.x) ** 2 + (site.z - settlement.z) ** 2;
      if (distSq < nearestSq) {
        nearestSq = distSq;
        nearest = i;
      }
    });
    if (nearest >= 0) settled.add(nearest);
  }

  const features: FeatureSite[] = [];
  const clearOfOthers = (x: number, z: number): boolean =>
    settlements.every((s) => Math.hypot(s.x - x, s.z - z) > s.radius + SETTLEMENT_CLEARANCE) &&
    features.every((f) => Math.hypot(f.x - x, f.z - z) > MIN_FEATURE_SPACING);

  for (let cell = 0; cell < cellSites.length; cell++) {
    if (settled.has(cell)) continue;
    const site = cellSites[cell];
    const biome = sampleTerrain(site.x, site.z).primaryBiome;
    const chances = biome.features;
    const total = chances.reduce((sum, chance) => sum + chance.odds, 0);
    if (total <= 0) continue;

    let pick = mulberry32(deriveSeed(seed, FEATURE_ROLL_SALT + cell))() * total;
    const chosen = chances.find((chance) => (pick -= chance.odds) < 0) ?? chances[chances.length - 1];
    if (chosen.featureId === NO_FEATURE) continue;
    const index = kindIndex.get(chosen.featureId);
    if (index === undefined) continue;
    const kind = kinds[index];

    const rng = mulberry32(deriveSeed(seed, FEATURE_PLACE_SALT + cell));
    // One size per cell, rolled before the search, so where it lands does not change how big it is.
    const spec = kind.quarry;
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
      id: features.length,
      kindIndex: index,
      kind,
      x: shape.x,
      z: shape.z,
      areaId: best.areaId,
      footprint: quarryFootprint(shape),
      entrance: kind.road ? { ...quarryEntrance(shape), height: shape.level } : null,
      quarry: shape,
    });
  }
  return features;
}
