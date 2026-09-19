import { TEXTURE_RESOLUTION, writeProceduralTexturePixels, type TextureDef } from "./textureGen";

/**
 * Bakes one material's textures off the main thread. Each material is fully independent - its
 * noise is seeded from (seed, "texture-<materialId>", noiseName), so nothing depends on which
 * order materials are baked in or which worker handles one. That is what makes this safe to
 * parallelise without changing a single output pixel.
 */
export interface BakeRequest {
  jobId: number;
  layerIndex: number;
  seed: number;
  materialId: string;
  texture: TextureDef;
}

export interface BakeResponse {
  jobId: number;
  layerIndex: number;
  /** Averaged RGB of the baked color texture, for the debug map's flat swatches. */
  averageColor: [number, number, number];
  color: ArrayBuffer;
  normal: ArrayBuffer;
}

self.onmessage = (event: MessageEvent<BakeRequest>): void => {
  const { jobId, layerIndex, seed, materialId, texture } = event.data;

  const pixelCount = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION;
  const color = new Uint8Array(pixelCount * 4);
  const normal = new Uint8Array(pixelCount * 4);

  // layerIndex 0: these buffers hold exactly one material, and get copied into the shared atlas
  // slice by the pool on the main thread.
  writeProceduralTexturePixels(color, normal, 0, seed, materialId, texture);

  let r = 0;
  let g = 0;
  let b = 0;
  for (let p = 0; p < pixelCount; p++) {
    r += color[p * 4];
    g += color[p * 4 + 1];
    b += color[p * 4 + 2];
  }

  const response: BakeResponse = {
    jobId,
    layerIndex,
    averageColor: [r / pixelCount / 255, g / pixelCount / 255, b / pixelCount / 255],
    color: color.buffer,
    normal: normal.buffer,
  };

  // Transferred, not copied - ownership moves to the main thread, so an 8MB result costs nothing
  // to hand back. (SharedArrayBuffer would avoid the hand-back entirely but needs COOP/COEP
  // headers in both dev and production, which this does not.)
  (self as unknown as Worker).postMessage(response, [response.color, response.normal]);
};
