import { TEXTURE_RESOLUTION, writeProceduralTexturePixels, type TextureDef } from "./textureGen";
import type { BakeRequest, BakeResponse } from "./textureBake.worker";

export interface BakeJob {
  id: string;
  texture: TextureDef;
}

export interface BakeResult {
  /** Averaged RGB of each material's baked color texture, in job order. */
  averageColors: [number, number, number][];
}

/**
 * Peak memory, not core count, is what caps this. Every in-flight job holds its own 8MB result
 * (two 1024x1024 RGBA buffers) on top of the ~144MB shared atlas, so more workers than this buys
 * little and costs a lot of transient memory on a many-core machine.
 */
const MAX_WORKERS = 8;

function createWorker(): Worker {
  return new Worker(new URL("./textureBake.worker.ts", import.meta.url), { type: "module" });
}

/** The original single-threaded path, kept as a fallback for any environment where constructing a
 *  module worker fails (and used directly by tests/tools that want a synchronous bake). */
function bakeSerially(jobs: BakeJob[], seed: number, colorBuffer: Uint8Array, normalBuffer: Uint8Array, onProgress?: (done: number, total: number) => void): BakeResult {
  const pixelCount = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION;
  const averageColors: [number, number, number][] = [];

  for (let i = 0; i < jobs.length; i++) {
    writeProceduralTexturePixels(colorBuffer, normalBuffer, i, seed, jobs[i].id, jobs[i].texture);

    const layerOffset = i * pixelCount * 4;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let p = 0; p < pixelCount; p++) {
      r += colorBuffer[layerOffset + p * 4];
      g += colorBuffer[layerOffset + p * 4 + 1];
      b += colorBuffer[layerOffset + p * 4 + 2];
    }
    averageColors.push([r / pixelCount / 255, g / pixelCount / 255, b / pixelCount / 255]);
    onProgress?.(i + 1, jobs.length);
  }

  return { averageColors };
}

/**
 * Bakes every material in parallel across a small worker pool, writing each result into its own
 * slice of the shared atlas buffers.
 *
 * Output is identical to baking serially: a material's noise is seeded from
 * (seed, "texture-<materialId>", noiseName), so it depends on neither completion order nor which
 * worker ran it. Results are therefore written by layer index as they arrive, in whatever order
 * that happens to be.
 */
export async function bakeMaterialTextures(
  jobs: BakeJob[],
  seed: number,
  colorBuffer: Uint8Array,
  normalBuffer: Uint8Array,
  onProgress?: (done: number, total: number) => void,
): Promise<BakeResult> {
  if (jobs.length === 0) return { averageColors: [] };

  let workers: Worker[];
  try {
    const count = Math.max(1, Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 4, jobs.length));
    workers = Array.from({ length: count }, createWorker);
  } catch {
    return bakeSerially(jobs, seed, colorBuffer, normalBuffer, onProgress);
  }

  const layerSize = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;
  const averageColors: [number, number, number][] = new Array(jobs.length);

  try {
    await new Promise<void>((resolve, reject) => {
      let nextJob = 0;
      let completed = 0;

      const dispatch = (worker: Worker): void => {
        if (nextJob >= jobs.length) return;
        const layerIndex = nextJob++;
        const request: BakeRequest = {
          jobId: layerIndex,
          layerIndex,
          seed,
          materialId: jobs[layerIndex].id,
          texture: jobs[layerIndex].texture,
        };
        worker.postMessage(request);
      };

      for (const worker of workers) {
        worker.onerror = (event): void => reject(new Error(`Texture bake worker failed: ${event.message}`));
        worker.onmessage = (event: MessageEvent<BakeResponse>): void => {
          const { layerIndex, averageColor, color, normal } = event.data;
          colorBuffer.set(new Uint8Array(color), layerIndex * layerSize);
          normalBuffer.set(new Uint8Array(normal), layerIndex * layerSize);
          averageColors[layerIndex] = averageColor;

          completed++;
          onProgress?.(completed, jobs.length);
          if (completed === jobs.length) {
            resolve();
            return;
          }
          dispatch(worker);
        };
        dispatch(worker);
      }
    });
  } catch {
    // A worker that dies mid-bake would leave the atlas half-written, so redo the whole thing on
    // the main thread rather than shipping a partially-baked world.
    for (const worker of workers) worker.terminate();
    return bakeSerially(jobs, seed, colorBuffer, normalBuffer, onProgress);
  }

  for (const worker of workers) worker.terminate();
  return { averageColors };
}
