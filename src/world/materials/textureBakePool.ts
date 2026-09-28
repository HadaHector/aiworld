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

/** The cache, only where there is IndexedDB - loaded on demand so Node probes, which bake through
 *  here too, never import it (its code hash is a Vite virtual module). */
async function textureCache(): Promise<typeof import("./textureCache") | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    return await import("./textureCache");
  } catch {
    return null;
  }
}

/**
 * Bakes every material in parallel across a small worker pool, writing each result into its own
 * slice of the shared atlas buffers. A texture baked before with the same definition, seed and code
 * is read from the texture cache instead (textureCache.ts), and a fresh bake is kept there for next
 * time.
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

  const layerSize = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;
  const averageColors: [number, number, number][] = new Array(jobs.length);
  let completed = 0;

  const cache = await textureCache();
  const keys = cache ? await cache.textureKeys(seed, jobs) : null;
  const cached = cache && keys ? await cache.loadTextures(keys) : [];
  const pending: number[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const hit = cached[i];
    if (hit && hit.color.byteLength === layerSize && hit.normal.byteLength === layerSize) {
      colorBuffer.set(new Uint8Array(hit.color), i * layerSize);
      normalBuffer.set(new Uint8Array(hit.normal), i * layerSize);
      averageColors[i] = hit.averageColor;
      onProgress?.(++completed, jobs.length);
    } else {
      pending.push(i);
    }
  }
  if (pending.length === 0) return { averageColors };

  const pendingJobs = pending.map((i) => jobs[i]);
  let workers: Worker[];
  try {
    const count = Math.max(1, Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 4, pending.length));
    workers = Array.from({ length: count }, createWorker);
  } catch {
    return bakeRestSerially();
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let next = 0;
      let baked = 0;

      const dispatch = (worker: Worker): void => {
        if (next >= pending.length) return;
        const layerIndex = pending[next++];
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
          // The worker's own buffers, handed over, so keeping them costs no copy here.
          if (cache && keys) void cache.saveTexture(keys[layerIndex], jobs[layerIndex].id, { color, normal, averageColor });

          onProgress?.(++completed, jobs.length);
          if (++baked === pending.length) {
            resolve();
            return;
          }
          dispatch(worker);
        };
        dispatch(worker);
      }
    });
  } catch {
    // A worker that dies mid-bake would leave the atlas half-written, so redo the rest on the main
    // thread rather than shipping a partially-baked world.
    for (const worker of workers) worker.terminate();
    return bakeRestSerially();
  }

  for (const worker of workers) worker.terminate();
  return { averageColors };

  /** The textures the cache did not have, on this thread - into their own layers, then copied. */
  function bakeRestSerially(): BakeResult {
    const color = new Uint8Array(layerSize * pendingJobs.length);
    const normal = new Uint8Array(layerSize * pendingJobs.length);
    const baked = bakeSerially(pendingJobs, seed, color, normal, (done) => onProgress?.(completed + done, jobs.length));
    pending.forEach((layerIndex, i) => {
      colorBuffer.set(color.subarray(i * layerSize, (i + 1) * layerSize), layerIndex * layerSize);
      normalBuffer.set(normal.subarray(i * layerSize, (i + 1) * layerSize), layerIndex * layerSize);
      averageColors[layerIndex] = baked.averageColors[i];
    });
    return { averageColors };
  }
}
