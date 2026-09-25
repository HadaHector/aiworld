import { deriveSeed } from "../rng";
import { smoothstep, lerp } from "../mathUtils";
import { createAreaSampler, SEA_LEVEL, type AreaWeight, type AreaBounds } from "../cells/areaField";
import { createBedrockSampler } from "../bedrock";
import { generateSettlementSites, type SettlementSite } from "../settlements/settlementSites";
import { generateRoadNetwork, type RoadNetwork } from "../roads/roadNetwork";
import { createRoadField, type RoadField } from "../roads/roadField";
import { generateSettlementLayouts, type SettlementLayout } from "../settlements/settlementLayout";
import { createPadField, type PadField } from "../settlements/padField";
import { PAD_BLEND_MAX, PAD_BLEND_MIN, PAD_PAINT_OFFSET, PAD_SIDE_SLOPE } from "../settlements/settlementConfig";
import {
  ROAD_HALF_WIDTH,
  ROAD_SIDE_SLOPE,
  ROAD_SHOULDER_MIN,
  ROAD_SHOULDER_MAX,
  ROAD_QUERY_RADIUS,
  ROAD_GRADE_END_TAPER,
} from "../roads/roadConfig";
import type { ContinentPlan } from "../cells/continentLayout";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import type { WorldContent } from "../content/worldContent";
import { createBaseNoise2D } from "./noise";
import { compilePipeline, type CompiledPipeline } from "./pipeline/pipelineCompiler";
import { createBoundaryHillEvaluator } from "./boundaryHills/boundaryHillsEvaluator";
import { createRiverEvaluator } from "./rivers/riverEvaluator";
import { RIVER_HILL_SUPPRESSION_INNER, RIVER_HILL_SUPPRESSION_OUTER } from "./rivers/riverConfig";

export interface TerrainSample {
  height: number;
  /** The area owning the nearest cell - see AreaSample. */
  primaryAreaId: number;
  primaryBiome: BiomeDefinition;
  secondaryBiome: BiomeDefinition;
  biomeBlend: number;
  /** Every area with a say at this point, strongest first, summing to 1 - see AreaSample. */
  areaWeights: AreaWeight[];
  isLand: boolean;
  landmass: number;
  lakeFactor: number;
  /** Only "close enough for a river valley to reach here" - the carve fades to nothing before this
   *  goes false, so it is no longer a switch anything visible depends on. */
  isRiverEdge: boolean;
  /** Distance past the nearest cell to the nearest cell of a DIFFERENT area - continuous, and
   *  Infinity when no other area is within the boundary hills reach. See AreaSample. */
  areaBorderGap: number;
  /** True distance to the nearest river centreline, Infinity past riverField's search radius.
   *  Continuous everywhere, so it is the signal to use for anything that has to vary smoothly. */
  riverGap: number;
  /** True distance to the nearest road centreline, Infinity past the road field's search radius.
   *  The material pipeline paints the road surface from this - there is no road mesh. */
  roadGap: number;
}

export type TerrainSampler = (worldX: number, worldZ: number) => TerrainSample;

export interface TerrainWorld {
  sampleTerrain: TerrainSampler;
  worldExtent: number;
  continents: ContinentPlan[];
  areaBounds: Map<number, AreaBounds>;
  areaNames: Map<number, string>;
  settlements: SettlementSite[];
  roads: RoadNetwork;
  /** Streets, squares and houses, one per settlement, in settlement id order. */
  settlementLayouts: SettlementLayout[];
}

const OCEAN_FLOOR_DEPTH = -14;
const OCEAN_FLOOR_NOISE_FREQUENCY = 0.03;
const OCEAN_FLOOR_NOISE_SCALE = 1.5;

// Hard floor on solid-land height: bedrock + biome detail noise are two independent fbm signals,
// and raising bedrock's offset only makes a below-sea-level dip rare, not impossible - in the tail
// of the distribution both signals can still occasionally dip low at the same point. A puddle every
// 10-20m across every biome (including deserts) looked wrong regardless of how rare "rare" was, so
// this is a genuine floor, not a tuning knob: land height can never read below this, guaranteed.
const MIN_LAND_HEIGHT = -1;

// Absolute target lake-surface height, applied via lerp (not a relative carve like rivers/boundary
// hills) so a lake reads as a clean, flat, undisturbed body of water at its core and fringe
// regardless of what the surrounding terrain is doing - real lakes are level, unlike hills.
const LAKE_TARGET_HEIGHT = SEA_LEVEL - 10;

const OCEAN_SALT = 402;

function compileHeightPipelines(seed: number, biomes: BiomeDefinition[]): Map<string, CompiledPipeline> {
  const compiled = new Map<string, CompiledPipeline>();
  for (const biome of biomes) {
    compiled.set(biome.id, compilePipeline(biome.outputs.height, seed, biome.id));
  }
  return compiled;
}

/** Composes continent shape + biome zoning + height noise into one queryable per-position sample. */
export function createTerrainSampler(seed: number, content: WorldContent): TerrainWorld {
  const { sampleArea, worldExtent, continents, areaBounds, areaNames, landCellSites, nameGenerator } =
    createAreaSampler(seed, content);
  const bedrock = createBedrockSampler(seed);
  const oceanNoise2D = createBaseNoise2D(deriveSeed(seed, OCEAN_SALT));
  const heightPipelines = compileHeightPipelines(seed, content.biomes);
  const evaluateBoundaryHill = createBoundaryHillEvaluator(seed, content.boundaryHillStyles);
  const carveRiver = createRiverEvaluator(seed);

  // Bound after the fact, because roads are routed over the terrain as it is before any of them
  // exist and then the terrain is brought to them - survey the land, then build the road. Until
  // the network is generated below this is null and sampleTerrain simply reports ungraded ground,
  // which is exactly what the router has to see.
  let roadField: RoadField | null = null;
  // Bound last of all, for the same reason: settlements are laid out on the graded terrain, then
  // the ground is levelled under their houses.
  let padField: PadField | null = null;

  function sampleTerrain(worldX: number, worldZ: number): TerrainSample {
    const area = sampleArea(worldX, worldZ);

    // Weighted sum over every area with a say here, using the same weights the materials blend by,
    // so height and texture always agree about where a border is. This replaced a two-way lerp on
    // biomeBlend, which was driven by a cell identity that flipped abruptly and so left ~half of
    // all real biome borders with no height blend at all - a hard switch between two biomes' noise.
    let blendedDetail = 0;
    for (const { biome, weight } of area.areaWeights) {
      blendedDetail += heightPipelines.get(biome.id)!(worldX, worldZ) * weight;
    }
    // Faded out near a river rather than switched off by one - see RIVER_HILL_SUPPRESSION_INNER.
    // riverGap is Infinity where there is no river within reach, which smoothstep clamps to 1.
    const riverHillFade = smoothstep(RIVER_HILL_SUPPRESSION_INNER, RIVER_HILL_SUPPRESSION_OUTER, area.riverGap);
    const boundaryHill =
      evaluateBoundaryHill(area.boundaryHillStyle, area.areaBorderGap, worldX, worldZ) * riverHillFade;

    const bedrockHeight = bedrock(worldX, worldZ);
    const landHeightFloored = Math.max(bedrockHeight + blendedDetail + boundaryHill, MIN_LAND_HEIGHT);

    // Both water carves apply AFTER the floor above (that clamp is unconditional - anything summed
    // inside it just gets clamped back up), and both are now absolute rather than relative: the
    // river clips the terrain down to a valley profile and the lake lerps it to a level surface, so
    // neither carries the surrounding terrain's own shape into the water. River before lake means a
    // river's valley gets smoothly swallowed as it approaches the lake it feeds - reading correctly
    // as the river disappearing into the lake, not a competing dip on top of it.
    const landHeightRivered = carveRiver(
      area.isRiverEdge, area.riverTaper, area.riverGap, worldX, worldZ, landHeightFloored,
    );
    const landHeight = lerp(landHeightRivered, LAKE_TARGET_HEIGHT, area.lakeFactor);

    // Roads are graded into the terrain rather than laid on top of it, so this is the last thing
    // to touch the land height: a road cuts through a boundary hill and fills a dip, and it should
    // win over both. It is deliberately above the ocean blend below, so a road can never raise the
    // seabed - a road running into water simply disappears under it.
    let gradedHeight = landHeight;
    let roadGap = Infinity;
    if (roadField) {
      const road = roadField.query(worldX, worldZ);
      roadGap = road.distance;
      if (road.distance < ROAD_QUERY_RADIUS) {
        // The shoulder is as wide as it has to be to get from the road's level back to the
        // ground's at ROAD_SIDE_SLOPE, so its gradient is the constant and its width follows.
        // A fixed width would be a wall wherever the cut or fill happened to be deep.
        const drop = Math.abs(landHeight - road.height);
        const shoulder = Math.min(ROAD_SHOULDER_MAX, Math.max(ROAD_SHOULDER_MIN, drop / ROAD_SIDE_SLOPE));
        const blend = (1 - smoothstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + shoulder, road.distance)) * road.taper;
        gradedHeight = lerp(landHeight, road.height, blend);
      }
    }

    const oceanNoise = oceanNoise2D(worldX * OCEAN_FLOOR_NOISE_FREQUENCY, worldZ * OCEAN_FLOOR_NOISE_FREQUENCY) * OCEAN_FLOOR_NOISE_SCALE;
    const oceanFloorHeight = SEA_LEVEL + OCEAN_FLOOR_DEPTH + oceanNoise;
    const landBlend = smoothstep(-1, 1, area.landmass);
    let height = lerp(oceanFloorHeight, gradedHeight, landBlend);

    // House plots and squares: brought to their own level, returning to the ground's over a margin
    // as wide as PAD_SIDE_SLOPE needs (like a road shoulder), and painted as trodden earth - the
    // road surface - by reporting a road gap just past the pad's edge. After the ocean blend, which
    // otherwise pulls a plot near the coast a little way down toward the seabed: a plot is only ever
    // placed on dry land, so there is no seabed for it to fight.
    // The levelling never reaches onto a road's or street's own level ground (roadGap is in
    // road-width units, so ROAD_HALF_WIDTH is that edge for every width): a house stands close enough
    // to its street for its margin to overlap it, and the street would otherwise dip or bulge toward
    // every house it passes.
    if (padField) {
      const pad = padField.query(worldX, worldZ);
      if (pad) {
        const margin = Math.min(PAD_BLEND_MAX, Math.max(PAD_BLEND_MIN, Math.abs(height - pad.height) / PAD_SIDE_SLOPE));
        const clearOfRoad = smoothstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 3, roadGap);
        if (pad.gap < margin) height = lerp(height, pad.height, (1 - smoothstep(0, margin, pad.gap)) * clearOfRoad);
        roadGap = Math.min(roadGap, pad.gap + PAD_PAINT_OFFSET);
      }
    }

    return {
      height,
      primaryAreaId: area.primaryAreaId,
      primaryBiome: area.primaryBiome,
      secondaryBiome: area.secondaryBiome,
      biomeBlend: area.biomeBlend,
      areaWeights: area.areaWeights,
      isLand: area.isLand,
      landmass: area.landmass,
      lakeFactor: area.lakeFactor,
      areaBorderGap: area.areaBorderGap,
      isRiverEdge: area.isRiverEdge,
      riverGap: area.riverGap,
      roadGap,
    };
  }

  // After sampleTerrain exists, because choosing a site is entirely a question about the finished
  // terrain - how level it is, how far above the water, how near a river.
  const settlements = generateSettlementSites({
    seed,
    cellSites: landCellSites,
    sampleTerrain,
    nameFor: (biome, id) => nameGenerator.settlementNameFor(biome.voiceId, id),
  });

  // Roads need the settlements to connect and the finished terrain to route over, so they come
  // last of all.
  const roads = generateRoadNetwork(seed, settlements, sampleTerrain);
  roadField = createRoadField(roads.links, ROAD_QUERY_RADIUS, ROAD_GRADE_END_TAPER);

  // Settlements are laid out on the terrain as the roads left it, then their streets join the road
  // field (graded and painted like roads, narrower) and their plots are levelled.
  const settlementLayouts = generateSettlementLayouts(seed, settlements, roads.gates, roads.links, sampleTerrain);
  roadField = createRoadField(
    [...roads.links, ...settlementLayouts.flatMap((layout) => layout.streets)],
    ROAD_QUERY_RADIUS,
    ROAD_GRADE_END_TAPER,
  );
  padField = createPadField(settlementLayouts);

  return { sampleTerrain, worldExtent, continents, areaBounds, areaNames, settlements, roads, settlementLayouts };
}
