import { deriveSeed } from "../rng";
import { smoothstep, lerp } from "../mathUtils";
import { createAreaSampler, SEA_LEVEL } from "../cells/areaField";
import { createBedrockSampler } from "../bedrock";
import type { BiomeDefinition, BiomeHeightParams } from "../biomes/biomeTypes";
import { createBaseNoise2D, fbm, DEFAULT_FBM_PARAMS, type FbmParams } from "./noise";

export interface TerrainSample {
  height: number;
  primaryBiome: BiomeDefinition;
  secondaryBiome: BiomeDefinition;
  biomeBlend: number;
  isLand: boolean;
  landmass: number;
}

export type TerrainSampler = (worldX: number, worldZ: number) => TerrainSample;

export interface TerrainWorld {
  sampleTerrain: TerrainSampler;
  worldExtent: number;
}

const OCEAN_FLOOR_DEPTH = -14;
const OCEAN_FLOOR_NOISE_FREQUENCY = 0.03;
const OCEAN_FLOOR_NOISE_SCALE = 1.5;

const HEIGHT_SALT = 401;
const OCEAN_SALT = 402;

function paramsFor(heightParams: BiomeHeightParams): FbmParams {
  return {
    ...DEFAULT_FBM_PARAMS,
    baseAmplitude: DEFAULT_FBM_PARAMS.baseAmplitude * heightParams.amplitudeScale,
    baseFrequency: DEFAULT_FBM_PARAMS.baseFrequency * heightParams.frequencyScale,
    offset: heightParams.baseElevation,
    persistence: heightParams.persistence ?? DEFAULT_FBM_PARAMS.persistence,
    octaves: heightParams.octaves ?? DEFAULT_FBM_PARAMS.octaves,
  };
}

/** Composes continent shape + biome zoning + height noise into one queryable per-position sample. */
export function createTerrainSampler(seed: number): TerrainWorld {
  const { sampleArea, worldExtent } = createAreaSampler(seed);
  const bedrock = createBedrockSampler(seed);
  const noise2D = createBaseNoise2D(deriveSeed(seed, HEIGHT_SALT));
  const oceanNoise2D = createBaseNoise2D(deriveSeed(seed, OCEAN_SALT));

  function sampleTerrain(worldX: number, worldZ: number): TerrainSample {
    const area = sampleArea(worldX, worldZ);

    const primaryDetail = fbm(noise2D, worldX, worldZ, paramsFor(area.primaryBiome.height));
    const blendedDetail =
      area.biomeBlend > 0
        ? lerp(primaryDetail, fbm(noise2D, worldX, worldZ, paramsFor(area.secondaryBiome.height)), area.biomeBlend)
        : primaryDetail;

    const bedrockHeight = bedrock(worldX, worldZ);
    const landHeight = bedrockHeight + blendedDetail;

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
    };
  }

  return { sampleTerrain, worldExtent };
}
