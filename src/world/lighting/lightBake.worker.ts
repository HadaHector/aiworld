import type { ModelLight } from "../buildings/buildingTypes";
import { bakeLightmap, halfTexels } from "./lightBake";
import { lightKey, loadLightmap, saveLightmap } from "./lightCache";

/**
 * Bakes one house's lights off the main thread (see lightBake.ts): its mesh's own vertex data in,
 * its lightmap out as half floats and a place on it per vertex - read from the lightmap cache
 * (lightCache.ts) where it was baked before, and kept there when it is baked now.
 */
export interface LightBakeRequest {
  id: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per vertex, its building material's layer (-1 plain); per layer, whether it casts shadow. */
  layers: Float32Array;
  casts: boolean[];
  lights: ModelLight[];
}

export interface LightBakeResponse {
  id: number;
  width: number;
  height: number;
  half: Uint16Array;
  uvs: Float32Array;
  ms: number;
  /** Read from the cache, not baked. */
  cached: boolean;
}

const post = (response: LightBakeResponse): void => (self as unknown as Worker).postMessage(response, [response.half.buffer, response.uvs.buffer]);

self.onmessage = async (event: MessageEvent<LightBakeRequest>): Promise<void> => {
  const { id, positions, normals, indices, layers, casts, lights } = event.data;
  const start = performance.now();
  const key = await lightKey(event.data).catch(() => null);
  const kept = key ? await loadLightmap(key) : undefined;
  if (kept) {
    post({ id, width: kept.width, height: kept.height, half: new Uint16Array(kept.half), uvs: new Float32Array(kept.uvs), ms: performance.now() - start, cached: true });
    return;
  }
  const slots = Array.from(layers, (layer) => Math.round(layer));
  const map = bakeLightmap({ positions, normals, indices, materialSlots: slots, materials: casts.map((_, i) => String(i)) }, lights, (layer) => layer === null || casts[Number(layer)]);
  const half = halfTexels(map.texels);
  // Copies kept: the buffers themselves go to the page.
  const keep = key ? { width: map.width, height: map.height, half: half.slice().buffer, uvs: map.uvs.slice().buffer } : null;
  post({ id, width: map.width, height: map.height, half, uvs: map.uvs, ms: performance.now() - start, cached: false });
  if (key && keep) await saveLightmap(key, keep);
};
