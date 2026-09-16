import { createBaseNoise2D, fbm, type FbmParams } from "./terrain/noise";
import { deriveSeed } from "./rng";

export type BedrockSampler = (worldX: number, worldZ: number) => number;

const BEDROCK_SALT = 501;

const BEDROCK_PARAMS: FbmParams = {
  octaves: 3,
  baseFrequency: 0.005,
  baseAmplitude: 2.5,
  persistence: 0.5,
  lacunarity: 2.0,
  offset: 6, // raised so bedrock alone rarely approaches sea level; see MIN_LAND_HEIGHT in terrainSampler.ts
};

/**
 * Large-scale, low-frequency base elevation — the "geology" of the continent (highlands,
 * lowlands, basins). Biomes layer local detail texture on top of this rather than each
 * carrying their own macro elevation, so the big-picture landform shape can be read and
 * tuned independently of which biome happens to occupy a given cell.
 */
export function createBedrockSampler(seed: number): BedrockSampler {
  const noise2D = createBaseNoise2D(deriveSeed(seed, BEDROCK_SALT));

  return function sampleBedrock(worldX: number, worldZ: number): number {
    return fbm(noise2D, worldX, worldZ, BEDROCK_PARAMS);
  };
}
