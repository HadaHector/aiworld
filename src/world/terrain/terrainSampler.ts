import { deriveSeed } from "../rng";
import { smoothstep, lerp } from "../mathUtils";
import { createAreaSampler, SEA_LEVEL, type AreaWeight, type AreaBounds } from "../cells/areaField";
import { createBedrockSampler } from "../bedrock";
import type { ContinentPlan } from "../cells/continentLayout";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import { BIOME_REGISTRY } from "../biomes/biomeDefinitions";
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
  /** True distance to the nearest river centreline, Infinity past riverField's search radius.
   *  Continuous everywhere, so it is the signal to use for anything that has to vary smoothly. */
  riverGap: number;
}

export type TerrainSampler = (worldX: number, worldZ: number) => TerrainSample;

export interface TerrainWorld {
  sampleTerrain: TerrainSampler;
  worldExtent: number;
  continents: ContinentPlan[];
  areaBounds: Map<number, AreaBounds>;
  areaNames: Map<number, string>;
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

function compileHeightPipelines(seed: number): Map<string, CompiledPipeline> {
  const compiled = new Map<string, CompiledPipeline>();
  for (const biome of BIOME_REGISTRY) {
    compiled.set(biome.id, compilePipeline(biome.outputs.height, seed, biome.id));
  }
  return compiled;
}

/** Composes continent shape + biome zoning + height noise into one queryable per-position sample. */
export function createTerrainSampler(seed: number): TerrainWorld {
  const { sampleArea, worldExtent, continents, areaBounds, areaNames } = createAreaSampler(seed);
  const bedrock = createBedrockSampler(seed);
  const oceanNoise2D = createBaseNoise2D(deriveSeed(seed, OCEAN_SALT));
  const heightPipelines = compileHeightPipelines(seed);
  const evaluateBoundaryHill = createBoundaryHillEvaluator(seed);
  const carveRiver = createRiverEvaluator(seed);

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

    const oceanNoise = oceanNoise2D(worldX * OCEAN_FLOOR_NOISE_FREQUENCY, worldZ * OCEAN_FLOOR_NOISE_FREQUENCY) * OCEAN_FLOOR_NOISE_SCALE;
    const oceanFloorHeight = SEA_LEVEL + OCEAN_FLOOR_DEPTH + oceanNoise;
    const landBlend = smoothstep(-1, 1, area.landmass);
    const height = lerp(oceanFloorHeight, landHeight, landBlend);

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
      isRiverEdge: area.isRiverEdge,
      riverGap: area.riverGap,
    };
  }

  return { sampleTerrain, worldExtent, continents, areaBounds, areaNames };
}
