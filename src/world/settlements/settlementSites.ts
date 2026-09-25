import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import { deriveSeed, mulberry32 } from "../rng";
import { smoothstep } from "../mathUtils";
import { CELL_SPACING } from "../cells/config";
import { TOWN_MIN_SCORE, VILLAGE_MIN_SCORE, type SettlementStyle, type SettlementTier } from "./settlementConfig";

/**
 * Where a settlement would stand. Nothing renders one yet - this is the set of named places a road
 * network has to connect, and having nothing to connect is why roads were not the thing to build
 * first.
 */
export interface SettlementSite {
  id: number;
  name: string;
  x: number;
  z: number;
  height: number;
  areaId: number;
  biome: BiomeDefinition;
  /** Its biome's settlement style - how big each tier grows, and what it builds. */
  style: SettlementStyle;
  /** 0..1, how good this spot is by the rules below. Also the order sites were claimed in. */
  score: number;
  /** How big a place grows here - the best ground gets the biggest. */
  tier: SettlementTier;
  /** Gates sit on a circle this far out; streets and houses stay inside it. */
  radius: number;
}

// Candidates are drawn inside each land cell rather than over a world-wide grid, so the search
// effort follows the land instead of the ocean, and every cell gets the same number of chances
// however big the continent around it is.
const CANDIDATES_PER_CELL = 12;
const CANDIDATE_RADIUS = CELL_SPACING * 0.42;

// A settlement wants dry, level, well-inside ground. Each of these is a hard rejection; the soft
// preferences that decide between the survivors are further down.
const MIN_SITE_HEIGHT = 2; // world units above sea level - a beach at +0.5 floods
const MAX_LAKE_FACTOR = 0.05;
const MAX_RELIEF = 6; // world units of height spread across the footprint

// Measured around the footprint a village would actually occupy, not at a single point: a point
// sample says nothing about slope, and the whole question here is whether the ground is level.
//
// Eight probes rather than four. With four, the worst relief actually present under an accepted
// site measured 17.9 units against a limit of 6 - a ridge running between two probe directions is
// invisible to them. Eight halves the angular gap and brought the worst case inside the limit.
const FOOTPRINT_RADIUS = 14;
const FOOTPRINT_PROBES = 8;

// A zone border is where the boundary hills are, and a town wedged into a mountain pass reads as a
// mistake. The same gap drives the soft preference: comfortably inland scores better.
const MIN_BORDER_GAP = 120;
const COMFORTABLE_BORDER_GAP = 500;

// Fresh water within a walk is the single strongest real reason a settlement is where it is. It is
// a preference rather than a requirement because not every zone has a river through it, and a zone
// with no settlement at all is worse than one whose settlement carries its water uphill.
const WATER_ACCESS_REACH = 500;

// The core probe above only says the centre is level. A settlement spreads out to its radius
// (settlementConfig.ts's tiers), and what decides how many houses it can hold is how much of THAT
// ground is usable - dry, clear of rivers and lakes, and not far above or below the centre. Rings of
// probes out to the biggest settlement's reach measure it; a site where too little of it is usable
// is rejected, since it could only ever grow a couple of houses.
const AREA_RINGS: [radius: number, probes: number][] = [
  [30, 8],
  [55, 12],
  [80, 16],
];
/** A probe is usable ground if it is within this grade of the centre's height - a street can reach
 *  it and a house plot there needs no more than ordinary levelling. */
const AREA_MAX_GRADE = 0.14;
const AREA_RIVER_CLEARANCE = 12;
const MIN_USABLE_FRACTION = 0.45;

const SCORE_FLATNESS = 0.55;
const SCORE_WATER = 0.3;
const SCORE_INLAND = 0.15;

// Greedy claiming radius. Above CELL_SPACING deliberately: one settlement per cell would come out
// as a grid however well each individual spot scored, and the point of scoring is that the good
// ground decides the spacing, not the cell diagram.
const MIN_SETTLEMENT_SPACING = 1400;

const SETTLEMENT_SALT = 702;
// Settlement ids share the name generator uniqueness pool with zone ids, and sit well clear of them
// so the two can never derive the same name stream.
const SETTLEMENT_ID_BASE = 100000;

interface Candidate {
  x: number;
  z: number;
  height: number;
  areaId: number;
  biome: BiomeDefinition;
  score: number;
}

export interface SettlementInput {
  seed: number;
  /** One site per land cell that is not a lake - the centres candidates are scattered around. */
  cellSites: CellPoint[];
  sampleTerrain: TerrainSampler;
  nameFor: (biome: BiomeDefinition, id: number) => string;
}

/**
 * Scores one candidate point, or rejects it.
 *
 * Ordered so the cheap point test runs before the extra terrain samples the footprint needs:
 * the overwhelming majority of candidates die on "under water", "too near a zone border" or "not
 * land at all", and paying nine samples each to learn that would cost nine times what this does.
 */
function evaluate(x: number, z: number, sampleTerrain: TerrainSampler): Candidate | null {
  const here = sampleTerrain(x, z);
  if (!here.isLand) return null;
  // A biome with no settlement style is one nobody settles.
  if (!here.primaryBiome.settlementStyle) return null;
  if (here.height < MIN_SITE_HEIGHT) return null;
  if (here.lakeFactor > MAX_LAKE_FACTOR) return null;
  if (here.areaBorderGap < MIN_BORDER_GAP) return null;

  let lowest = here.height;
  let highest = here.height;
  for (let probe = 0; probe < FOOTPRINT_PROBES; probe++) {
    const angle = (probe / FOOTPRINT_PROBES) * Math.PI * 2;
    const around = sampleTerrain(x + Math.cos(angle) * FOOTPRINT_RADIUS, z + Math.sin(angle) * FOOTPRINT_RADIUS);
    if (around.height < lowest) lowest = around.height;
    if (around.height > highest) highest = around.height;
    // The relief found so far can only grow, so a candidate that is already too steep is already
    // rejected - and most of them are, well before the eighth probe.
    if (highest - lowest > MAX_RELIEF) return null;
  }
  const relief = highest - lowest;

  // Usable ground across the whole footprint. Probes are counted as they come, so a site that
  // already cannot reach MIN_USABLE_FRACTION stops paying for samples.
  const totalProbes = AREA_RINGS.reduce((sum, [, probes]) => sum + probes, 0);
  const allowedMisses = Math.floor(totalProbes * (1 - MIN_USABLE_FRACTION));
  let misses = 0;
  for (const [radius, probes] of AREA_RINGS) {
    for (let probe = 0; probe < probes; probe++) {
      const angle = (probe / probes) * Math.PI * 2 + radius;
      const at = sampleTerrain(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
      const usable =
        at.isLand &&
        at.height >= MIN_SITE_HEIGHT &&
        at.lakeFactor <= MAX_LAKE_FACTOR &&
        at.riverGap > AREA_RIVER_CLEARANCE &&
        Math.abs(at.height - here.height) / radius <= AREA_MAX_GRADE;
      if (!usable && ++misses > allowedMisses) return null;
    }
  }
  const usableFraction = 1 - misses / totalProbes;

  // Mostly how much usable ground there is; a little for how level the centre (the square) is.
  const flatness = 0.25 * (1 - relief / MAX_RELIEF) + 0.75 * usableFraction;
  // riverGap is Infinity where no river is in range, which smoothstep clamps to 1 - so "no water
  // anywhere near" scores exactly zero here rather than needing a branch of its own.
  const water = 1 - smoothstep(0, WATER_ACCESS_REACH, here.riverGap);
  const inland = smoothstep(MIN_BORDER_GAP, COMFORTABLE_BORDER_GAP, here.areaBorderGap);

  return {
    x,
    z,
    height: here.height,
    areaId: here.primaryAreaId,
    biome: here.primaryBiome,
    score: flatness * SCORE_FLATNESS + water * SCORE_WATER + inland * SCORE_INLAND,
  };
}

function tierFor(score: number): SettlementTier {
  if (score >= TOWN_MIN_SCORE) return "town";
  if (score >= VILLAGE_MIN_SCORE) return "village";
  return "hamlet";
}

/**
 * Picks the places settlements will stand.
 *
 * Two phases. Every land cell scatters candidates and scores them independently, then the whole
 * world's survivors are claimed greedily best-first, each one blocking anything within
 * MIN_SETTLEMENT_SPACING. Claiming globally rather than per cell is what stops two towns ending up
 * on opposite sides of one cell border, which a per-cell pass cannot see.
 */
export function generateSettlementSites({ seed, cellSites, sampleTerrain, nameFor }: SettlementInput): SettlementSite[] {
  const candidates: Candidate[] = [];

  for (let cell = 0; cell < cellSites.length; cell++) {
    const rng = mulberry32(deriveSeed(seed, SETTLEMENT_SALT + cell));
    const site = cellSites[cell];
    for (let attempt = 0; attempt < CANDIDATES_PER_CELL; attempt++) {
      // The square root spreads points evenly over the disc; a raw roll would pile them at the
      // centre and barely sample the cell edges, which are often the flattest ground it has.
      const radius = Math.sqrt(rng()) * CANDIDATE_RADIUS;
      const angle = rng() * Math.PI * 2;
      const scored = evaluate(site.x + Math.cos(angle) * radius, site.z + Math.sin(angle) * radius, sampleTerrain);
      if (scored) candidates.push(scored);
    }
  }

  // Tie-broken by position, so the order is fixed for a given seed rather than depending on the
  // sort implementation being stable.
  candidates.sort((a, b) => b.score - a.score || a.x - b.x || a.z - b.z);

  const spacingSq = MIN_SETTLEMENT_SPACING * MIN_SETTLEMENT_SPACING;
  const sites: SettlementSite[] = [];
  // Buckets one spacing wide, so a claim check only ever looks at the nine cells around it.
  const claimed = new Map<number, SettlementSite[]>();
  const bucketKey = (gx: number, gz: number): number => (gx + 32768) * 65536 + (gz + 32768);

  for (const candidate of candidates) {
    const gx = Math.floor(candidate.x / MIN_SETTLEMENT_SPACING);
    const gz = Math.floor(candidate.z / MIN_SETTLEMENT_SPACING);
    let blocked = false;
    for (let dx = -1; dx <= 1 && !blocked; dx++) {
      for (let dz = -1; dz <= 1 && !blocked; dz++) {
        const bucket = claimed.get(bucketKey(gx + dx, gz + dz));
        if (!bucket) continue;
        for (const taken of bucket) {
          if ((taken.x - candidate.x) ** 2 + (taken.z - candidate.z) ** 2 < spacingSq) {
            blocked = true;
            break;
          }
        }
      }
    }
    if (blocked) continue;

    const site: SettlementSite = {
      id: sites.length,
      name: nameFor(candidate.biome, SETTLEMENT_ID_BASE + sites.length),
      x: candidate.x,
      z: candidate.z,
      height: candidate.height,
      areaId: candidate.areaId,
      biome: candidate.biome,
      style: candidate.biome.settlementStyle!,
      score: candidate.score,
      tier: tierFor(candidate.score),
      radius: candidate.biome.settlementStyle!.tiers[tierFor(candidate.score)].radius,
    };
    sites.push(site);
    const key = bucketKey(gx, gz);
    const bucket = claimed.get(key);
    if (bucket) bucket.push(site);
    else claimed.set(key, [site]);
  }

  return sites;
}
