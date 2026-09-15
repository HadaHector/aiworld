import { deriveSeed } from "../rng";
import { smoothstep, lerp } from "../mathUtils";
import { createContinentSampler, SEA_LEVEL } from "../continent";
import { createBiomeField } from "../biomes/biomeMap";
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
export function createTerrainSampler(seed: number): TerrainSampler {
  const continent = createContinentSampler(seed);
  const biomeField = createBiomeField(seed, continent);
  const noise2D = createBaseNoise2D(deriveSeed(seed, HEIGHT_SALT));
  const oceanNoise2D = createBaseNoise2D(deriveSeed(seed, OCEAN_SALT));

  return function sampleTerrain(worldX: number, worldZ: number): TerrainSample {
    const continentSample = continent(worldX, worldZ);
    const biomeSample = biomeField.sampleAt(worldX, worldZ);

    const primaryHeight = fbm(noise2D, worldX, worldZ, paramsFor(biomeSample.primary.height));
    const blendedHeight =
      biomeSample.blend > 0
        ? lerp(primaryHeight, fbm(noise2D, worldX, worldZ, paramsFor(biomeSample.secondary.height)), biomeSample.blend)
        : primaryHeight;

    const oceanNoise = oceanNoise2D(worldX * OCEAN_FLOOR_NOISE_FREQUENCY, worldZ * OCEAN_FLOOR_NOISE_FREQUENCY) * OCEAN_FLOOR_NOISE_SCALE;
    const oceanFloorHeight = SEA_LEVEL + OCEAN_FLOOR_DEPTH + oceanNoise;
    const landBlend = smoothstep(-1, 1, continentSample.landmass);
    const height = lerp(oceanFloorHeight, blendedHeight, landBlend);

    return {
      height,
      primaryBiome: biomeSample.primary,
      secondaryBiome: biomeSample.secondary,
      biomeBlend: biomeSample.blend,
      isLand: continentSample.isLand,
      landmass: continentSample.landmass,
    };
  };
}
