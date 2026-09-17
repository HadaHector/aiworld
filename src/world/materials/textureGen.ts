import { Color3, DynamicTexture, Texture, type Scene } from "@babylonjs/core";
import { deriveSeed } from "../rng";
import { createBaseNoise2D, fbm, type FbmParams } from "../terrain/noise";

const TEXTURE_RESOLUTION = 256;
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
  /** Derives this material's own noise seed and texture-cache key; must be unique per MaterialDef. */
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

/** Generates a small tileable, mottled-noise texture - no image assets, matching this project's
 *  fully-procedural convention. Deterministic per (seed, materialId). */
export function generateProceduralTexture(scene: Scene, seed: number, materialId: string, params: ProceduralTextureParams): Texture {
  const noise2D = createBaseNoise2D(deriveSeed(seed, hashString(materialId) ^ params.salt));

  const texture = new DynamicTexture(`material_${materialId}`, { width: TEXTURE_RESOLUTION, height: TEXTURE_RESOLUTION }, scene, false);
  const context = texture.getContext();
  const imageData = new ImageData(TEXTURE_RESOLUTION, TEXTURE_RESOLUTION);

  for (let y = 0; y < TEXTURE_RESOLUTION; y++) {
    for (let x = 0; x < TEXTURE_RESOLUTION; x++) {
      const raw = fbm(noise2D, x, y, TEXTURE_NOISE_PARAMS);
      const t = Math.min(1, Math.max(0, raw * 0.5 + 0.5));

      const pixelIndex = (y * TEXTURE_RESOLUTION + x) * 4;
      imageData.data[pixelIndex] = (params.baseColor.r + (params.variationColor.r - params.baseColor.r) * t) * 255;
      imageData.data[pixelIndex + 1] = (params.baseColor.g + (params.variationColor.g - params.baseColor.g) * t) * 255;
      imageData.data[pixelIndex + 2] = (params.baseColor.b + (params.variationColor.b - params.baseColor.b) * t) * 255;
      imageData.data[pixelIndex + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
  texture.update(false);

  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;

  return texture;
}
