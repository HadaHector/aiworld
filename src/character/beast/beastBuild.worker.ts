import type { BeastDef } from "./beastDef";
import { makeBeastNow, type BeastRecipe, type MadeBeast } from "./beastMake";

/**
 * Makes a beast off the main thread (BEASTS.md, *Performance*): its body, atlas and baked gaits are
 * plain numbers from plain data, so the worker does exactly what the page would, and sends the
 * arrays back without copying them.
 */
export interface BeastRequest {
  id: number;
  def: BeastDef;
  recipe: BeastRecipe;
}

export interface BeastResponse {
  id: number;
  error?: string;
  made?: MadeBeast;
}

self.onmessage = (event: MessageEvent<BeastRequest>): void => {
  const { id, def, recipe } = event.data;
  try {
    const made = makeBeastNow(def, recipe);
    const transfer: ArrayBuffer[] = [];
    const b = made.body;
    for (const array of [b.positions, b.normals, b.uvs, b.joints, b.weights, b.indices, b.cards.positions, b.cards.normals, b.cards.uvs, b.cards.joints, b.cards.weights, b.cards.indices, b.cards.sway]) transfer.push(array.buffer as ArrayBuffer);
    transfer.push(made.painted.atlas.buffer as ArrayBuffer);
    if (made.painted.cards) transfer.push(made.painted.cards.pixels.buffer as ArrayBuffer);
    for (const pose of made.baked.poses) transfer.push(pose.buffer as ArrayBuffer);
    // The tubes' grids were for the painter: the page has no use for them.
    const body = { ...b, tubes: b.tubes.map((t) => ({ ...t, positions: new Float32Array(0), normals: new Float32Array(0) })) };
    (self as unknown as Worker).postMessage({ id, made: { ...made, body } } satisfies BeastResponse, transfer);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies BeastResponse);
  }
};
