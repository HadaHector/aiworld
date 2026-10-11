import type { ModelLight } from "../buildings/buildingTypes";
import { bakeLightmap, halfTexels } from "./lightBake";

/**
 * Bakes one house's lights off the main thread (see lightBake.ts): its mesh's own vertex data in,
 * its lightmap out as half floats and a place on it per vertex.
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
}

self.onmessage = (event: MessageEvent<LightBakeRequest>): void => {
  const { id, positions, normals, indices, layers, casts, lights } = event.data;
  const start = performance.now();
  const slots = Array.from(layers, (layer) => Math.round(layer));
  const map = bakeLightmap({ positions, normals, indices, materialSlots: slots, materials: casts.map((_, i) => String(i)) }, lights, (layer) => layer === null || casts[Number(layer)]);
  const half = halfTexels(map.texels);
  const response: LightBakeResponse = { id, width: map.width, height: map.height, half, uvs: map.uvs, ms: performance.now() - start };
  (self as unknown as Worker).postMessage(response, [half.buffer, map.uvs.buffer]);
};
