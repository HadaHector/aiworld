import { createWorldOctaveSampler, fbm, type FbmParams } from "./terrain/noise";
import { deriveSeed } from "./rng";

export type BedrockSampler = (worldX: number, worldZ: number) => number;

const BEDROCK_SALT = 501;

const BEDROCK_PARAMS: FbmParams = {
  octaves: 3,
  baseFrequency: 0.005,
  baseAmplitude: 2.5,
  persistence: 0.5,
  lacunarity: 2.0,
  offset: 6, // raised so bedrock alone rarely approaches sea level - where it does, with the biome detail, a pond forms
};

/**
 * Large-scale, low-frequency base elevation — the "geology" of the continent (highlands,
 * lowlands, basins). Biomes layer local detail texture on top of this rather than each
 * carrying their own macro elevation, so the big-picture landform shape can be read and
 * tuned independently of which biome happens to occupy a given cell.
 */
export function createBedrockSampler(seed: number): BedrockSampler {
  const sample = createWorldOctaveSampler(deriveSeed(seed, BEDROCK_SALT));

  return function sampleBedrock(worldX: number, worldZ: number): number {
    return fbm(sample, worldX, worldZ, BEDROCK_PARAMS);
  };
}
