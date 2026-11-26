import { sampleCounter, timed } from "../loadTimings";
import { deriveSeed } from "../rng";
import { smoothstep, lerp } from "../mathUtils";
import { createAreaSampler, SEA_LEVEL, type AreaWeight, type AreaBounds } from "../cells/areaField";
import { createBedrockSampler } from "../bedrock";
import { generateSettlementSites, type SettlementSite } from "../settlements/settlementSites";
import { generateRoadNetwork, type RoadNetwork } from "../roads/roadNetwork";
import { createRoadField, type RoadField } from "../roads/roadField";
import { planBridges, type Bridge } from "../roads/bridges";
import { generateSettlementLayouts, type SettlementLayout } from "../settlements/settlementLayout";
import { compoundPads, createPadField, propPads, settlementPads, type PadField } from "../settlements/padField";
import { aditFixtures, dropSteepProps, layoutCompounds, settleProps, settleOnGround, type CompoundLayout } from "../features/compound";
import { createSpillField, spillMaterials, type SpillField } from "../features/spill";
import { createTreeCover } from "../foliage/treeScatter";
import { PAD_PAINT_OFFSET } from "../settlements/settlementConfig";
import { CellTrace, type CellPlacement } from "../features/placementWhy";
import { NO_ROLL, placeFeatures, placeRoadsideFeatures, rollCellFeatures, type FeatureSite } from "../features/featureSites";
import { createFeatureField, type FeatureField } from "../features/featureField";
import {
  ROAD_HALF_WIDTH,
  ROAD_SIDE_SLOPE,
  ROAD_SHOULDER_MIN,
  ROAD_SHOULDER_MAX,
  ROAD_QUERY_RADIUS,
  roadMiddleShare,
  roadProfileOffset,
  ROAD_GRADE_END_TAPER,
} from "../roads/roadConfig";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import { caveMouthClearance, siteCaveMouths, type CaveMouthSite } from "../dungeons/caveMouths";
import { ROAD_HALF_WIDTH as MOUTH_PAINT_EDGE } from "../roads/roadConfig";
import type { WorldContent } from "../content/worldContent";
import { createBaseNoise2D } from "./noise";
import { compilePipeline, type CompiledPipeline } from "./pipeline/pipelineCompiler";
import { createBoundaryHillEvaluator } from "./boundaryHills/boundaryHillsEvaluator";
import { createRiverEvaluator } from "./rivers/riverEvaluator";
import { buildRiverProfiles, riverProfileAt, riverSprings, type RiverProfile, type RiverWaterSample } from "./rivers/riverLevels";
import { RIVER_SPRING_ROCKS, RIVER_WATERLINE_FADE } from "./rivers/riverConfig";
import { WATER_SURFACE, createFlatWaters, type FlatWaters } from "../water";
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
  /** How much of a point lies on a road's unpaved middle - between a carriage way's wheel tracks -
   *  0-1 (see RoadProfile.median); 0 off a road, and on a street. */
  roadMiddle: number;
  /** 0-1: how much the nearest road is an abandoned one (roadConfig's `abandoned` profile), there. */
  roadAbandoned: number;
  /** The nearest feature in reach (a quarry): its kind's index into WorldContent.featureKinds, or
   *  -1; the distance past its edge (0 inside, Infinity with none); how far it cut or filled the
   *  ground here; and how far plants are cleared, 0-1. See features/featureField.ts. */
  featureKind: number;
  featureGap: number;
  featureDepth: number;
  featureClear: number;
  /** The share of the trees cleared here left as stumps, 0-1 (see FeatureGround.stumps). */
  featureStumps: number;
  /** Distance past the nearest levelled pad's edge - a house's, a compound's building's or prop's -
   *  0 on it, Infinity with none near: nothing grows on one (see PadField.level). */
  padGap: number;
  /** How long ago a tree cut here was felled, 0-1 (see FeatureGround.stumpAge). */
  featureStumpAge: number;
  /** How far (0-1) a prop's or building's spill paints the ground here, and which of
   *  spillMaterials it is (-1 for none) - see features/spill.ts. */
  spill: number;
  spillMaterial: number;
  /** The surface of the water that stands over this point: the river's own where the point lies in its
   *  valley (WATER.md, water at its own level), else the sea's, WATER_SURFACE. The point is under water
   *  when its height is below this. */
  waterSurface: number;
  /** Distance to the nearest river's spring (its source), Infinity past a few tens of metres or with no
   *  rivers at their own level - boulders gather round one (foliage/treeScatter.ts). */
  springGap: number;
  /** The level "how high above the water" is read from here (the layer input `aboveWater` is the height
   *  less this): SEA_LEVEL, or by a river at its own level that river's surface, fading back to the sea's
   *  away from it - so waterside layers (reeds, wet stones) follow a river up a hill. */
  waterLine: number;
}

export type TerrainSampler = (worldX: number, worldZ: number) => TerrainSample;

export interface TerrainWorld {
  sampleTerrain: TerrainSampler;
  worldExtent: number;
  areaBounds: Map<number, AreaBounds>;
  areaNames: Map<number, string>;
  /** Sites of every land cell that is not a lake (creature levels by cell, SLICE.md B2). */
  landCellSites: { x: number; z: number }[];
  settlements: SettlementSite[];
  /** Each cell's major feature, other than a settlement - see features/featureSites.ts. */
  features: FeatureSite[];
  roads: RoadNetwork;
  /** Streets, squares and houses, one per settlement, in settlement id order. */
  settlementLayouts: SettlementLayout[];
  /** Each compound's yard, entrances and buildings - see features/compound.ts. */
  compoundLayouts: CompoundLayout[];
  /** The roads' bridges over the rivers they cross - see roads/bridges.ts. */
  bridges: Bridge[];
  /** Each area's own roll of its biome, by area id (see cells/areaField.ts). */
  areaBiomes: BiomeDefinition[];
  /** Which areas touch each area, by area id (see cells/areaField.ts). */
  areaNeighbours: Map<number, number[]>;
  /** Where natural caves open on steep hillsides - see dungeons/caveMouths.ts. */
  caveMouths: CaveMouthSite[];
  /** What each land cell rolled and why it did or did not place it, by cell - features/placementWhy.ts. */
  cellPlacements: CellPlacement[];
  /** Each river's water at its own level, mouth first - empty unless the world asks for `riverLevels`. */
  riverProfiles: RiverProfile[];
  /** The flat bodies of water (ponds, pools) features add as they are placed - see water.ts. */
  waters: FlatWaters;
}

const OCEAN_FLOOR_DEPTH = -14;
const OCEAN_FLOOR_NOISE_FREQUENCY = 0.03;
const OCEAN_FLOOR_NOISE_SCALE = 1.5;

// Absolute target lake-surface height, applied via lerp (not a relative carve like rivers/boundary
// hills) so a lake reads as a clean, flat, undisturbed body of water at its core and fringe
// regardless of what the surrounding terrain is doing - real lakes are level, unlike hills.
const LAKE_TARGET_HEIGHT = SEA_LEVEL - 10;

const OCEAN_SALT = 402;

/** Each biome's height graph, compiled the first time an area of it is sampled - one per area, since
 *  each area rolls its own (see content/biomeRolls.ts) and seeds its own noise. */
function heightPipelineCache(seed: number): (biome: BiomeDefinition) => CompiledPipeline {
  const compiled = new Map<BiomeDefinition, CompiledPipeline>();
  return (biome) => {
    let pipeline = compiled.get(biome);
    if (!pipeline) {
      pipeline = compilePipeline(biome.outputs.height, seed, biome.seedKey);
      compiled.set(biome, pipeline);
    }
    return pipeline;
  };
}

/** How far either way the ground is looked at to tell how steep it is, for a zone's relief. */
const RELIEF_STEEPNESS_STEP = 1.5;

/**
 * The ground's height from the zones alone, before rivers, lakes, borders and roads: the world's
 * bedrock, each area's own height weighted by its say, and then - where an area has one - its rock
 * relief (BiomeOutputs.relief), read against that height and how steep it is. Shared with the
 * workbench's maps, so a zone previews as it is built.
 *
 * A zone's height graph can read the bedrock under it (input `bedrock`), for a level that is level
 * in the world rather than over the bedrock's swells - a salt flat's floor, filled up to one height.
 */
export function createZoneHeight(seed: number): (worldX: number, worldZ: number, areaWeights: readonly AreaWeight[]) => number {
  const bedrock = createBedrockSampler(seed);
  const heightPipelineOf = heightPipelineCache(seed);
  const reliefOf = new Map<BiomeDefinition, CompiledPipeline>();
  const relief = (biome: BiomeDefinition): CompiledPipeline => {
    let pipeline = reliefOf.get(biome);
    if (!pipeline) {
      pipeline = compilePipeline(biome.outputs.relief!, seed, `${biome.seedKey}:relief`);
      reliefOf.set(biome, pipeline);
    }
    return pipeline;
  };
  const shaped = (x: number, z: number, areaWeights: readonly AreaWeight[]): number => {
    const base = bedrock(x, z);
    const context = { bedrock: base };
    let detail = 0;
    for (const { biome, weight } of areaWeights) detail += heightPipelineOf(biome)(x, z, context) * weight;
    return base + detail;
  };
  return (worldX, worldZ, areaWeights) => {
    const height = shaped(worldX, worldZ, areaWeights);
    if (!areaWeights.some(({ biome }) => biome.outputs.relief)) return height;
    // How steep the shaped ground is - the same areas' say a step away either way, near enough.
    const e = RELIEF_STEEPNESS_STEP;
    const gx = (shaped(worldX + e, worldZ, areaWeights) - height) / e;
    const gz = (shaped(worldX, worldZ + e, areaWeights) - height) / e;
    const g = Math.hypot(gx, gz);
    const context = { height, steepness: g / Math.sqrt(1 + g * g) };
    let added = 0;
    for (const { biome, weight } of areaWeights) {
      if (biome.outputs.relief) added += relief(biome)(worldX, worldZ, context) * weight;
    }
    return height + added;
  };
}

/** Composes the land's shape + biome zoning + height noise into one queryable per-position sample. */
export function createTerrainSampler(seed: number, content: WorldContent): TerrainWorld {
  const { sampleArea, riverField, worldExtent, areaBounds, areaNames, landCellSites, nameGenerator, areaBiomes, areaNeighbours } =
    createAreaSampler(seed, content);
  const oceanNoise2D = createBaseNoise2D(deriveSeed(seed, OCEAN_SALT));
  const zoneHeight = createZoneHeight(seed);
  const evaluateBoundaryHill = createBoundaryHillEvaluator(seed, content.boundaryHillStyles);
  const carveRiver = createRiverEvaluator(seed);

  // Water at its own level (riverLevels.ts): each river's surface runs from the ground it rises on down
  // to the sea. Worked out from the ground as the river finds it - before its own cut, after the coast
  // and the lakes - so it needs none of the river's own answers. Off, every river is legacy, as ever.
  const oceanFloorAt = (x: number, z: number): number => SEA_LEVEL + OCEAN_FLOOR_DEPTH + oceanNoise2D(x * OCEAN_FLOOR_NOISE_FREQUENCY, z * OCEAN_FLOOR_NOISE_FREQUENCY) * OCEAN_FLOOR_NOISE_SCALE;
  const groundBeforeRiver = (x: number, z: number): number => {
    const area = sampleArea(x, z);
    const hillFade = smoothstep(RIVER_HILL_SUPPRESSION_INNER, RIVER_HILL_SUPPRESSION_OUTER, area.riverGap);
    const land = zoneHeight(x, z, area.areaWeights) + evaluateBoundaryHill(area.boundaryHillStyle, area.areaBorderGap, x, z) * hillFade;
    return lerp(oceanFloorAt(x, z), lerp(land, LAKE_TARGET_HEIGHT, area.lakeFactor), smoothstep(-1, 1, area.landmass));
  };
  const riverProfiles: RiverProfile[] = content.world.riverLevels ? timed("Levelling rivers", () => buildRiverProfiles(riverField.polylines, groundBeforeRiver, WATER_SURFACE, seed)) : [];
  const waters = createFlatWaters();
  const riverWater: RiverWaterSample = { level: 0, depth: 0, halfWidth: 0, reach: 0 };
  const springs = riverSprings(riverProfiles);
  const springReach = RIVER_SPRING_ROCKS[1];

  // Bound after the fact, because roads are routed over the terrain as it is before any of them
  // exist and then the terrain is brought to them - survey the land, then build the road. Until
  // the network is generated below this is null and sampleTerrain simply reports ungraded ground,
  // which is exactly what the router has to see.
  let roadField: RoadField | null = null;
  // Bound last of all, for the same reason: settlements are laid out on the graded terrain, then
  // the ground is levelled under their houses.
  let padField: PadField | null = null;
  // Bound once the features are placed and before the roads are routed: a feature takes its ground
  // first, and the roads (its own track among them) are laid over what it left.
  let featureField: FeatureField | null = null;
  // Bound with the pads: the ground the compounds' props and buildings spill over.
  let spillField: SpillField | null = null;
  // Bound last: the caves' mouths, sited on the finished ground, kept bare of trees and grass.
  let mouthClear: ((x: number, z: number) => number) | null = null;

  const NO_SPILL = { spill: 0, spillMaterial: -1 };
  function spillAt(x: number, z: number): { spill: number; spillMaterial: number } {
    const spill = spillField?.at(x, z);
    return spill ? { spill: spill.weight, spillMaterial: spill.material } : NO_SPILL;
  }

  function springGapAt(x: number, z: number): number {
    let gap = Infinity;
    for (const s of springs) {
      const dx = s.x - x;
      const dz = s.z - z;
      if (Math.abs(dx) < springReach && Math.abs(dz) < springReach) gap = Math.min(gap, Math.hypot(dx, dz));
    }
    return gap;
  }

  function sampleTerrain(worldX: number, worldZ: number): TerrainSample {
    sampleCounter.count++;
    const area = sampleArea(worldX, worldZ);

    // Weighted sum over every area with a say here, using the same weights the materials blend by,
    // so height and texture always agree about where a border is. This replaced a two-way lerp on
    // biomeBlend, which was driven by a cell identity that flipped abruptly and so left ~half of
    // all real biome borders with no height blend at all - a hard switch between two biomes' noise.
    // (See createZoneHeight: the bedrock and the zones' own heights and relief.)
    const zoneHeightHere = zoneHeight(worldX, worldZ, area.areaWeights);
    // Faded out near a river rather than switched off by one - see RIVER_HILL_SUPPRESSION_INNER.
    // riverGap is Infinity where there is no river within reach, which smoothstep clamps to 1.
    const riverHillFade = smoothstep(RIVER_HILL_SUPPRESSION_INNER, RIVER_HILL_SUPPRESSION_OUTER, area.riverGap);
    const boundaryHill =
      evaluateBoundaryHill(area.boundaryHillStyle, area.areaBorderGap, worldX, worldZ) * riverHillFade;

    // Unclamped: where bedrock and the biome's detail dip below the sea together, the hollow fills
    // and is a pond - as deep as the ground goes, with its shore and shallows painted by the
    // biomes' waterside layers. (It used to be floored at -1, which left every pond a flat plate.)
    const landHeightUncarved = zoneHeightHere + boundaryHill;

    // Both water carves are absolute rather than relative: the
    // river clips the terrain down to a valley profile and the lake lerps it to a level surface, so
    // neither carries the surrounding terrain's own shape into the water. River before lake means a
    // river's valley gets smoothly swallowed as it approaches the lake it feeds - reading correctly
    // as the river disappearing into the lake, not a competing dip on top of it.
    // At their own level every river segment in reach clips the ground on its own and the lowest wins:
    // a min of continuous carves is continuous, where the nearest segment's bed alone would step
    // wherever two stretches' levels differ (the inside of a bend, a tributary beside its trunk). The
    // water over the point is the nearest segment's, where the point is in its reach: in a steep
    // stretch the reach of one upstream would otherwise lift the water over the ground.
    // Rivers at their own level cut the ground after the coast's blend (below), which their levels
    // were worked out from: cut before it, a bed near the coast was pulled down toward the seabed with
    // the land, far under its own water.
    let waterSurface = WATER_SURFACE;
    let waterLine = SEA_LEVEL;
    const ownLevels = riverProfiles.length > 0;
    const carveOwnLevels = (ground: number): number => {
      let carved = ground;
      let reached = -Infinity;
      let nearest = Infinity;
      const noise = carveRiver.edgeNoise(worldX, worldZ);
      riverField.querySegments(worldX, worldZ, (distance, taper, river) => {
        const water = riverProfileAt(riverProfiles[river], taper, riverWater);
        if (distance < nearest) {
          nearest = distance;
          reached = distance < water.reach ? water.level : -Infinity;
          waterLine = Math.max(SEA_LEVEL, water.level - RIVER_WATERLINE_FADE * Math.max(0, distance - water.reach));
        }
        carved = Math.min(carved, carveRiver(true, taper, distance, worldX, worldZ, ground, water, noise));
      });
      if (reached > waterSurface) waterSurface = reached;
      return carved;
    };
    const landHeightRivered = ownLevels ? landHeightUncarved : carveRiver(area.isRiverEdge, area.riverTaper, area.riverGap, worldX, worldZ, landHeightUncarved);
    const landHeightNatural = lerp(landHeightRivered, LAKE_TARGET_HEIGHT, area.lakeFactor);
    const feature = featureField?.apply(worldX, worldZ, landHeightNatural);
    const landHeight = feature ? feature.height : landHeightNatural;

    // The land blended into the seabed toward the coast. Roads are graded after this blend, from
    // the ground as it then lies - the ground the roads were routed over and bridged against: a
    // road cut through a coastal hill was pulled down by the blend after the cut, below the water
    // (WATER.md, *Roads*). A road over the water is bridged (bridges.ts), which grades nothing.
    const oceanFloorHeight = oceanFloorAt(worldX, worldZ);
    const landBlend = smoothstep(-1, 1, area.landmass);
    const blendedHeight = ownLevels ? carveOwnLevels(lerp(oceanFloorHeight, landHeight, landBlend)) : lerp(oceanFloorHeight, landHeight, landBlend);
    let height = blendedHeight;
    let roadGap = Infinity;
    let roadMiddle = 0;
    let roadAbandoned = 0;
    if (roadField) {
      const road = roadField.query(worldX, worldZ);
      // A road on a bridge leaves the ground under it be - nor is it painted there.
      roadGap = road.bridged ? Infinity : road.distance;
      // Graded to the nearest road off a bridge, even where a deck is nearer: an approach's bank runs
      // on round its end at the bridge, or its fill stood as a wall where the deck took over as the
      // nearest road (seed 7, by 865, 192: 6.4 to 2.8 m in a metre, with the polygon logging camp).
      if (road.groundDistance < ROAD_QUERY_RADIUS) {
        // The shoulder is as wide as it has to be to get from the road's level back to the
        // ground's at ROAD_SIDE_SLOPE, so its gradient is the constant and its width follows.
        // A fixed width would be a wall wherever the cut or fill happened to be deep.
        const drop = Math.abs(blendedHeight - road.groundHeight);
        const shoulder = Math.min(ROAD_SHOULDER_MAX, Math.max(ROAD_SHOULDER_MIN, drop / ROAD_SIDE_SLOPE));
        const blend = (1 - smoothstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + shoulder, road.groundDistance)) * road.groundTaper;
        height = lerp(blendedHeight, road.groundHeight, blend);
      }
      if (!road.bridged && road.distance < ROAD_QUERY_RADIUS) {
        // Its cross-section on top: a crown, ditches, a track worn down into the ground.
        if (road.profile) {
          height += roadProfileOffset(road.profile, road.distance) * road.taper * road.profileWeight;
          roadMiddle = roadMiddleShare(road.profile, road.distance) * road.profileWeight;
          if (road.profile.abandoned) roadAbandoned = road.profileWeight;
        }
      }
    }


    // House plots and squares: brought to their own level, returning to the ground's over a margin
    // as wide as PAD_SIDE_SLOPE needs (like a road shoulder), and painted as trodden earth - the
    // road surface - by reporting a road gap just past the pad's edge. After the ocean blend, which
    // otherwise pulls a plot near the coast a little way down toward the seabed: a plot is only ever
    // placed on dry land, so there is no seabed for it to fight.
    // The levelling never reaches onto a road's or street's own level ground (roadGap is in
    // road-width units, so ROAD_HALF_WIDTH is that edge for every width): a house stands close enough
    // to its street for its margin to overlap it, and the street would otherwise dip or bulge toward
    // every house it passes.
    // Where two pads' blends overlap, the ground runs smoothly between their levels (see
    // PadField.level).
    let padGap = Infinity;
    if (padField) {
      const levelled = padField.level(worldX, worldZ, height, smoothstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 3, roadGap));
      if (levelled) {
        height = levelled.height;
        roadGap = Math.min(roadGap, levelled.gap + PAD_PAINT_OFFSET);
        // A pad's own ground is paved all over.
        if (levelled.gap + PAD_PAINT_OFFSET < ROAD_HALF_WIDTH) { roadMiddle = 0; roadAbandoned = 0; }
        padGap = levelled.edge;
      }
    }
    // A cave's mouth: its slip and the ground round it bare - trodden earth, no trees or grass (its
    // ground is taken out over the slip, and its boulders stand round it).
    if (mouthClear) {
      const gap = mouthClear(worldX, worldZ);
      if (gap < Infinity) {
        padGap = Math.min(padGap, gap);
        if (gap + MOUTH_PAINT_EDGE < roadGap) {
          roadGap = gap + MOUTH_PAINT_EDGE;
          if (gap < 0) { roadMiddle = 0; roadAbandoned = 0; }
        }
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
      roadMiddle,
      roadAbandoned,
      featureKind: feature ? feature.kind : -1,
      featureGap: feature ? feature.gap : Infinity,
      featureDepth: feature ? feature.depth : 0,
      featureClear: feature ? feature.clear : 0,
      featureStumps: feature ? feature.stumps : 0,
      featureStumpAge: feature ? feature.stumpAge : 0,
      padGap,
      ...spillAt(worldX, worldZ),
      waterSurface,
      springGap: springGapAt(worldX, worldZ),
      waterLine,
    };
  }

  // Each land cell rolls its one major feature from its biome's list. After sampleTerrain exists,
  // because placing one is entirely a question about the finished terrain - how level it is, how
  // far above the water, how near a river.
  const kinds = content.featureKinds;
  const rolls = timed("Rolling each cell's feature", () => rollCellFeatures(seed, landCellSites, sampleTerrain, kinds));
  // What each cell rolled and why it did or did not place (features/placementWhy.ts).
  const traces = rolls.map((roll, cell) => new CellTrace(cell, roll === NO_ROLL ? "none" : kinds[roll].id));
  // The settlements first, in the cells that rolled one: they choose their ground by their own rules,
  // and everything else keeps clear of them.
  const settledCells = rolls.flatMap((roll, cell) => (roll !== NO_ROLL && kinds[roll].type === "settlement" ? [cell] : []));
  const settlements = timed("Siting settlements", () =>
    generateSettlementSites({
      seed,
      cellSites: settledCells.map((cell) => landCellSites[cell]),
      cellIds: settledCells,
      sampleTerrain,
      nameFor: (biome, id) => nameGenerator.settlementNameFor(biome.voiceId, id),
      traces,
    }),
  );

  // Then every other cell's feature, and their ground edits bound.
  const treeCover = createTreeCover(seed, content);
  let features = timed("Placing features", () => placeFeatures({ seed, cellSites: landCellSites, sampleTerrain, kinds, rolls, settlements, treeCover, traces }));
  featureField = createFeatureField(features);

  // Roads need the settlements to connect and the finished terrain to route over, so they come
  // last of all - joining the settlements and the features that want roads, and keeping off the
  // rest of the features' ground.
  const roads = timed("Routing roads", () => generateRoadNetwork(seed, settlements, sampleTerrain, features));
  // Over the rivers they cross, carried on bridges rather than run under the water - before they are
  // graded into the ground.
  const propById = new Map(content.props.map((prop) => [prop.id, prop]));
  const bridges = timed("Bridging rivers", () => planBridges(roads.stretches, sampleTerrain, (x, z) => propById.get(sampleTerrain(x, z).primaryBiome.roadBridgeId) ?? null));
  roadField = createRoadField(roads.stretches, ROAD_QUERY_RADIUS, ROAD_GRADE_END_TAPER);

  // Settlements are laid out on the terrain as the roads left it, then their streets join the road
  // field (graded and painted like roads, narrower) and their plots are levelled.
  const settlementLayouts = timed("Laying out settlements", () => generateSettlementLayouts(seed, settlements, roads.gates, roads.stretches, sampleTerrain));
  // Compounds the same way: laid out round the gates their roads arrived at, their lanes and trails
  // joining the road field and their yards and buildings levelled.
  // A compound no road could reach - its ground boxed in by slopes no road can climb - is not one:
  // its cell is left empty, its clearing with it.
  const roadless = new Set(
    roads.places.filter((place) => place.feature?.compound && !roads.links.some((link) => link.from === place.id || link.to === place.id)).map((place) => place.feature!),
  );
  if (roadless.size > 0) {
    // (Its cell is the one it rolled it in: the nearest site to where it stood.)
    for (const feature of roadless) {
      let cell = 0;
      landCellSites.forEach((site, i) => {
        if (Math.hypot(site.x - feature.x, site.z - feature.z) < Math.hypot(landCellSites[cell].x - feature.x, landCellSites[cell].z - feature.z)) cell = i;
      });
      traces[cell].placed = false;
      traces[cell].note = "placed, then dropped: no road could reach it";
    }
    const kept = features.filter((feature) => !roadless.has(feature));
    const newId = new Map(kept.map((feature, id) => [feature.id, id]));
    for (const link of roads.links) if (link.featureId !== undefined) link.featureId = newId.get(link.featureId);
    kept.forEach((feature, id) => (feature.id = id));
    features = kept;
    featureField = createFeatureField(features);
  }
  // Then the compounds that stand on a road already laid (a coaching inn): placed now, on it.
  const roadside = timed("Placing roadside features", () => placeRoadsideFeatures({ seed, cellSites: landCellSites, sampleTerrain, kinds, rolls, settlements, treeCover, features, stretches: roads.stretches, traces }));
  if (roadside.length > 0) {
    features = [...features, ...roadside];
    features.forEach((feature, id) => (feature.id = id));
    featureField = createFeatureField(features);
  }
  // Each feature of a kind that names its own, named in its ground's voice.
  for (const feature of features) {
    if (feature.kind.names && !feature.settlement) feature.name = nameGenerator.featureNameFor(feature.kind.names, sampleTerrain(feature.x, feature.z).primaryBiome.voiceId, feature.id);
  }
  const compoundLayouts = timed("Laying out compounds", () => layoutCompounds(features, roads, sampleTerrain, seed));
  roadField = createRoadField(
    [...roads.stretches, ...settlementLayouts.flatMap((layout) => layout.streets), ...compoundLayouts.flatMap((layout) => [...layout.lanes, ...layout.trails])],
    ROAD_QUERY_RADIUS,
    ROAD_GRADE_END_TAPER,
  );
  padField = createPadField([...settlementPads(settlementLayouts), ...compoundPads(compoundLayouts)]);
  // The compounds' props stand on the ground as it now is, levelled - those where it is too steep
  // taken out - and then the ground under each is levelled to it.
  dropSteepProps(compoundLayouts, sampleTerrain);
  settleProps(compoundLayouts, sampleTerrain);
  padField = createPadField([...propPads(compoundLayouts), ...settlementPads(settlementLayouts), ...compoundPads(compoundLayouts)]);
  // A mine's rails run from its yard's middle out to its adit (laid on the ground, as a wall is) -
  // the line its layout kept its buildings and props off and stood its carts on.
  const adits = features.flatMap((feature) => (feature.compound?.adit ? [{ feature, mouth: feature.compound.adit }] : []));
  const propById2 = new Map(content.props.map((prop) => [prop.id, prop]));
  for (const { feature } of adits) {
    const layout = compoundLayouts.find((l) => l.featureId === feature.id);
    const rails = propById2.get("railTrack");
    if (layout?.rails && rails) layout.walls.push({ prop: rails, variant: 0, points: layout.rails, heights: [], ends: ["free", "join"], breach: false });
  }
  settleOnGround(compoundLayouts, sampleTerrain);
  // Its timber portal at the slip's back wall and its track on along the slip's floor, after the
  // ground is settled: at the adit's own floor, not on the ground.
  for (const { feature, mouth } of adits) {
    const layout = compoundLayouts.find((l) => l.featureId === feature.id);
    if (!layout) continue;
    const fixtures = aditFixtures(mouth, propById2.get("timberSet"), propById2.get("railTrack"), seed);
    layout.props.push(...fixtures.props);
    layout.walls.push(...fixtures.walls);
  }
  spillField = createSpillField(compoundLayouts, spillMaterials(content));
  // Last, the caves' mouths: found on the ground as everything else has left it.
  const sited = timed("Finding cave mouths", () => {
    const caveCells = rolls.flatMap((roll, cell) => (roll !== NO_ROLL && kinds[roll].type === "cave" ? [cell] : []));
    return siteCaveMouths(seed, worldExtent, sampleTerrain, settlements, caveCells.map((cell) => landCellSites[cell]), caveCells.map((cell) => traces[cell]));
  });
  // (And the mines' adits, which their features sited.)
  const caveMouths = [...sited, ...adits.map((a) => a.mouth)].map((m, id) => ({ ...m, id }));
  mouthClear = caveMouthClearance(caveMouths);

  return { sampleTerrain, worldExtent, areaBounds, areaNames, landCellSites, settlements, features, roads, settlementLayouts, compoundLayouts, bridges, areaBiomes, areaNeighbours, caveMouths, riverProfiles, waters, cellPlacements: traces.map((trace) => trace.record()) };
}
