import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { SettlementSite } from "../settlements/settlementSites";
import { CELL_SPACING } from "../cells/config";
import { deriveSeed, mulberry32 } from "../rng";
import { NO_FEATURE, type FeatureKindDef } from "./featureTypes";
import { evaluateQuarry, quarryEntrance, quarryFootprint, type QuarryShape } from "./quarry";
import { evaluateCompound, planCompound, type CompoundSite } from "./compound";
import type { TreeCover } from "../foliage/treeScatter";
import type { RoadStretch } from "../roads/roadGraph";
import { ROAD_HALF_WIDTH } from "../roads/roadConfig";

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
  /** A compound as sited - laid out once the roads are built (see compound.ts). */
  compound: CompoundSite | null;
  /** Its own name, for a kind that names its own (FeatureKindDef.names) - a settlement's is its
   *  site's. Given once every feature is placed. */
  name?: string;
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
  /** How thick the woods are - what a compound that wants to stand in them reads. */
  treeCover: TreeCover;
}

/**
 * Every cell's feature, placed.
 *
 * Settlements come first, as their sites were placed by their own rules in the cells that rolled
 * one. Every other cell looks for ground that suits its roll - a quarry wants a hillside - among a
 * scatter of points over the cell, and takes the best. A cell where nothing suits is simply empty:
 * the roll is what the cell would like, the ground is what it gets.
 */
export function placeFeatures({ seed, cellSites, sampleTerrain, kinds, rolls, settlements, treeCover }: FeatureInput): FeatureSite[] {
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
    compound: null,
  }));

  const clearOfOthers = (x: number, z: number): boolean =>
    settlements.every((s) => Math.hypot(s.x - x, s.z - z) > s.radius + SETTLEMENT_CLEARANCE) &&
    features.every((f) => f.settlement !== null || Math.hypot(f.x - x, f.z - z) > MIN_FEATURE_SPACING);

  for (let cell = 0; cell < cellSites.length; cell++) {
    const index = rolls[cell];
    if (index === NO_ROLL) continue;
    const kind = kinds[index];
    const site = cellSites[cell];
    const rng = mulberry32(deriveSeed(seed, FEATURE_PLACE_SALT + cell));

    // A roadside one is placed once the roads are laid (placeRoadsideFeatures).
    if (kind.compound?.arrangement === "roadside") continue;
    if (kind.type === "compound" && kind.compound) {
      // Everything that decides its size first, so where it lands does not change how big it is.
      const plan = planCompound(kind, seed, rng);
      let best: { x: number; z: number; height: number; areaId: number; score: number } | null = null;
      for (let attempt = 0; attempt < CANDIDATES_PER_CELL; attempt++) {
        const radius = Math.sqrt(rng()) * CANDIDATE_RADIUS;
        const angle = rng() * Math.PI * 2;
        const x = site.x + Math.cos(angle) * radius;
        const z = site.z + Math.sin(angle) * radius;
        if (!clearOfOthers(x, z)) continue;
        const scored = evaluateCompound(x, z, kind.compound, plan.radius, sampleTerrain, treeCover);
        if (scored && (!best || scored.score > best.score)) best = { x, z, ...scored };
      }
      if (!best) continue;
      features.push({
        id: 0,
        kindIndex: index,
        kind,
        x: best.x,
        z: best.z,
        areaId: best.areaId,
        footprint: plan.radius,
        entrance: null,
        quarry: null,
        settlement: null,
        compound: { ...plan, x: best.x, z: best.z, height: best.height, roadAngles: [] },
      });
      continue;
    }

    const spec = kind.quarry;
    if (kind.type !== "quarry" || !spec) continue;

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
      compound: null,
    });
  }
  features.forEach((feature, id) => (feature.id = id));
  return features;
}

/** Along a road, a roadside compound is tried every this many metres. */
const ROADSIDE_STEP = 8;
/** The road across a roadside compound's circle may bend this far (radians) from one side to the
 *  other: it runs through the yard nearly straight. */
const ROADSIDE_MAX_BEND = 0.35;

/**
 * The cells that rolled a roadside compound (a coaching inn), placed once the roads are laid: on a
 * road (not a track) through the cell, nearly straight across the compound's circle, with no other
 * road and no junction within it, its ground as the kind asks, and as far from the settlements as
 * the road allows - past its `fromSettlements` from each at the least. A cell with no such road is
 * left empty. Returned to be added to the features already placed, which they keep clear of.
 */
export function placeRoadsideFeatures({ seed, cellSites, sampleTerrain, kinds, rolls, settlements, treeCover, features, stretches }: FeatureInput & { features: FeatureSite[]; stretches: RoadStretch[] }): FeatureSite[] {
  const placed: FeatureSite[] = [];
  const roads = stretches.filter((stretch) => stretch.roadClass !== "track");
  // Each road's length along it, point by point, to walk it by distance.
  const along = roads.map((stretch) => {
    const lengths = [0];
    for (let i = 1; i < stretch.points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(stretch.points[i].x - stretch.points[i - 1].x, stretch.points[i].z - stretch.points[i - 1].z));
    return lengths;
  });
  // Each road's box, to find the few near a cell without walking them all.
  const boxes = roads.map((stretch) => {
    const xs = stretch.points.map((p) => p.x);
    const zs = stretch.points.map((p) => p.z);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  });
  const pointAt = (r: number, s: number): CellPoint => {
    const { points } = roads[r];
    const lengths = along[r];
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < s) i++;
    const t = (s - lengths[i - 1]) / Math.max(1e-6, lengths[i] - lengths[i - 1]);
    return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, z: points[i - 1].z + (points[i].z - points[i - 1].z) * t };
  };
  const distanceTo = (points: CellPoint[], x: number, z: number): number => {
    let best = Infinity;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - a.x - u * dx, z - a.z - u * dz));
    }
    return best;
  };

  for (let cell = 0; cell < cellSites.length; cell++) {
    const index = rolls[cell];
    if (index === NO_ROLL) continue;
    const kind = kinds[index];
    const spec = kind.compound;
    if (!spec || spec.arrangement !== "roadside") continue;
    const site = cellSites[cell];
    const rng = mulberry32(deriveSeed(seed, FEATURE_PLACE_SALT + cell));
    const plan = planCompound(kind, seed, rng);
    const away = spec.site.fromSettlements ?? 0;
    let best: { x: number; z: number; height: number; areaId: number; score: number; roadAngles: number[] } | null = null;
    const reach = CANDIDATE_RADIUS + plan.radius + ROAD_HALF_WIDTH;
    const near = boxes.flatMap((box, r) => (box.minX - reach < site.x && box.maxX + reach > site.x && box.minZ - reach < site.z && box.maxZ + reach > site.z ? [r] : []));
    near.forEach((r) => {
      const length = along[r][along[r].length - 1];
      // Its ends are junctions or gates: kept out of the circle.
      for (let s = plan.radius; s <= length - plan.radius; s += ROADSIDE_STEP) {
        const p = pointAt(r, s);
        if (Math.hypot(p.x - site.x, p.z - site.z) > CANDIDATE_RADIUS) continue;
        const gap = Math.min(Infinity, ...settlements.map((other) => Math.hypot(other.x - p.x, other.z - p.z) - other.radius));
        if (gap < away) continue;
        if (![...features, ...placed].every((f) => f.settlement !== null || Math.hypot(f.x - p.x, f.z - p.z) > Math.max(MIN_FEATURE_SPACING, f.footprint + plan.radius))) continue;
        // Nearly straight across it, both ways out from its middle.
        const back = pointAt(r, s - plan.radius);
        const ahead = pointAt(r, s + plan.radius);
        const a1 = Math.atan2(p.z - back.z, p.x - back.x);
        const a2 = Math.atan2(ahead.z - p.z, ahead.x - p.x);
        let bend = Math.abs(a2 - a1) % (Math.PI * 2);
        if (bend > Math.PI) bend = Math.PI * 2 - bend;
        if (bend > ROADSIDE_MAX_BEND) continue;
        if (near.some((o) => o !== r && distanceTo(roads[o].points, p.x, p.z) < plan.radius + ROAD_HALF_WIDTH)) continue;
        const scored = evaluateCompound(p.x, p.z, spec, plan.radius, sampleTerrain, treeCover);
        if (!scored) continue;
        // The further from the towns either way the better - an inn half way between them.
        const score = 0.5 * scored.score + 0.5 * Math.min(1, gap / Math.max(1, away * 2));
        if (!best || score > best.score) {
          best = { x: p.x, z: p.z, height: scored.height, areaId: scored.areaId, score, roadAngles: [Math.atan2(back.z - p.z, back.x - p.x), Math.atan2(ahead.z - p.z, ahead.x - p.x)] };
        }
      }
    });
    if (!best) continue;
    const { x, z, height, areaId, roadAngles } = best;
    placed.push({
      id: 0,
      kindIndex: index,
      kind,
      x,
      z,
      areaId,
      footprint: plan.radius,
      entrance: null,
      quarry: null,
      settlement: null,
      compound: { ...plan, x, z, height, roadAngles },
    });
  }
  return placed;
}
