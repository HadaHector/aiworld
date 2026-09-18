import { Color3 } from "@babylonjs/core";
import { deriveSeed } from "../rng";
import { createBaseNoise2D, fbm, type FbmParams } from "../terrain/noise";

export const TEXTURE_RESOLUTION = 256;
const TEXTURE_NOISE_PARAMS: FbmParams = {
  octaves: 3,
  baseFrequency: 0.05,
  baseAmplitude: 1,
  persistence: 0.5,
  lacunarity: 2.0,
  offset: 0,
};

export interface ProceduralTextureParams {
  baseColor: Color3;
  variationColor: Color3;
  /** Derives this material's own noise seed; must be unique per MaterialDef. */
  salt: number;
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Writes one material's tileable, mottled-noise texture (no image assets, matching this
 *  project's fully-procedural convention) into layer `layerIndex` of a shared RGBA buffer sized
 *  for a `RawTexture2DArray` (materialLibrary.ts) - every material's texture is one layer of one
 *  combined array texture, so the terrain shader can sample any of them via a single sampler.
 *  Deterministic per (seed, materialId). */
export function writeProceduralTexturePixels(buffer: Uint8Array, layerIndex: number, seed: number, materialId: string, params: ProceduralTextureParams): void {
  const noise2D = createBaseNoise2D(deriveSeed(seed, hashString(materialId) ^ params.salt));
  const layerOffset = layerIndex * TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;

  for (let y = 0; y < TEXTURE_RESOLUTION; y++) {
    for (let x = 0; x < TEXTURE_RESOLUTION; x++) {
      const raw = fbm(noise2D, x, y, TEXTURE_NOISE_PARAMS);
      const t = Math.min(1, Math.max(0, raw * 0.5 + 0.5));

      const pixelIndex = layerOffset + (y * TEXTURE_RESOLUTION + x) * 4;
      buffer[pixelIndex] = (params.baseColor.r + (params.variationColor.r - params.baseColor.r) * t) * 255;
      buffer[pixelIndex + 1] = (params.baseColor.g + (params.variationColor.g - params.baseColor.g) * t) * 255;
      buffer[pixelIndex + 2] = (params.baseColor.b + (params.variationColor.b - params.baseColor.b) * t) * 255;
      buffer[pixelIndex + 3] = 255;
    }
  }
}
