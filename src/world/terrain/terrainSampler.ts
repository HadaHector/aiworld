import { deriveSeed } from "../rng";
import { smoothstep, lerp } from "../mathUtils";
import { createAreaSampler, SEA_LEVEL } from "../cells/areaField";
import { createBedrockSampler } from "../bedrock";
import type { ContinentPlan } from "../cells/continentLayout";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import { BIOME_REGISTRY } from "../biomes/biomeDefinitions";
import { createBaseNoise2D } from "./noise";
import { compilePipeline, type CompiledPipeline } from "./pipeline/pipelineCompiler";
import { createBoundaryHillEvaluator } from "./boundaryHills/boundaryHillsEvaluator";
import { createRiverEvaluator } from "./rivers/riverEvaluator";

export interface TerrainSample {
  height: number;
  primaryBiome: BiomeDefinition;
  secondaryBiome: BiomeDefinition;
  biomeBlend: number;
  isLand: boolean;
  landmass: number;
  lakeFactor: number;
  isRiverEdge: boolean;
  /** Distance to the river's own carve envelope - Infinity wherever isRiverEdge is false. Unlike
   *  isRiverEdge (flat true/false across the entire, possibly ~100-unit-wide, river corridor -
   *  see riverConfig.ts's RIVER_WIDTH_MOUTH), this is the continuous signal to use for anything
   *  that should hug the actual waterline, not the whole channel. */
  riverGap: number;
}

export type TerrainSampler = (worldX: number, worldZ: number) => TerrainSample;

export interface TerrainWorld {
  sampleTerrain: TerrainSampler;
  worldExtent: number;
  continents: ContinentPlan[];
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
  const { sampleArea, worldExtent, continents } = createAreaSampler(seed);
  const bedrock = createBedrockSampler(seed);
  const oceanNoise2D = createBaseNoise2D(deriveSeed(seed, OCEAN_SALT));
  const heightPipelines = compileHeightPipelines(seed);
  const evaluateBoundaryHill = createBoundaryHillEvaluator(seed);
  const evaluateRiver = createRiverEvaluator(seed);

  function sampleTerrain(worldX: number, worldZ: number): TerrainSample {
    const area = sampleArea(worldX, worldZ);

    const primaryDetail = heightPipelines.get(area.primaryBiome.id)!(worldX, worldZ);
    const blendedDetail =
      area.biomeBlend > 0
        ? lerp(primaryDetail, heightPipelines.get(area.secondaryBiome.id)!(worldX, worldZ), area.biomeBlend)
        : primaryDetail;
    const boundaryHill = evaluateBoundaryHill(area.boundaryHillStyle, area.borderGap, worldX, worldZ);

    const bedrockHeight = bedrock(worldX, worldZ);
    const landHeightFloored = Math.max(bedrockHeight + blendedDetail + boundaryHill, MIN_LAND_HEIGHT);

    // Both water carves apply AFTER the floor above (that clamp is unconditional - anything summed
    // inside it just gets clamped back up). River (relative carve) before lake (absolute target):
    // lake-lerp last guarantees a lake reads as a clean flat body regardless of what a river/hill
    // did nearby, and a river's carve gets smoothly swallowed as it approaches a lake it feeds -
    // reading correctly as the river disappearing into the lake, not a competing dip on top of it.
    const riverCarve = evaluateRiver(area.isRiverEdge, area.riverTaper, area.riverGap, worldX, worldZ);
    const landHeightRivered = landHeightFloored - riverCarve;
    const landHeight = lerp(landHeightRivered, LAKE_TARGET_HEIGHT, area.lakeFactor);

    const oceanNoise = oceanNoise2D(worldX * OCEAN_FLOOR_NOISE_FREQUENCY, worldZ * OCEAN_FLOOR_NOISE_FREQUENCY) * OCEAN_FLOOR_NOISE_SCALE;
    const oceanFloorHeight = SEA_LEVEL + OCEAN_FLOOR_DEPTH + oceanNoise;
    const landBlend = smoothstep(-1, 1, area.landmass);
    const height = lerp(oceanFloorHeight, landHeight, landBlend);

    return {
      height,
      primaryBiome: area.primaryBiome,
      secondaryBiome: area.secondaryBiome,
      biomeBlend: area.biomeBlend,
      isLand: area.isLand,
      landmass: area.landmass,
      lakeFactor: area.lakeFactor,
      isRiverEdge: area.isRiverEdge,
      riverGap: area.riverGap,
    };
  }

  return { sampleTerrain, worldExtent, continents };
}
