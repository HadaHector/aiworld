import { makeBody, type BodyRecipe } from "./bodyMake";
import type { BakedGearMaterial } from "./gearMaterial";
import type { BodyGeometry } from "./bodyMesh";
import type { AtlasLayout } from "./atlas";
import type { PaintBase } from "./paint";

/**
 * Builds a body off the main thread (CHARACTERS.md, *Caches*): its geometry, its atlas layout and
 * the painting that does not depend on who wears it - all of it plain numbers from plain data, so a
 * worker does exactly what the page would have done, and the page gets only the result.
 */
export interface BuildRequest {
  id: number;
  recipe: BodyRecipe;
  /** The race as its sex has it. */
  race: BodyRecipe["race"];
  /** The gear materials the painting reads, by a key that says which bake they are; `color` is
   *  left out for one this worker was sent before. */
  materials: { id: string; key: string; size: number; color: Uint8Array | null }[];
}

export interface BuildResponse {
  id: number;
  error?: string;
  body?: BodyGeometry;
  layout?: AtlasLayout | null;
  base?: PaintBase | null;
}

/** The materials this worker has been sent, by key. */
const known = new Map<string, BakedGearMaterial>();

self.onmessage = (event: MessageEvent<BuildRequest>): void => {
  const { id, recipe, race, materials } = event.data;
  try {
    const byId = new Map<string, BakedGearMaterial>();
    for (const m of materials) {
      let found = known.get(m.key);
      if (!found && m.color) known.set(m.key, (found = { def: { size: m.size } as BakedGearMaterial["def"], color: m.color, normal: new Uint8Array(0) }));
      if (found) byId.set(m.id, found);
    }
    const made = makeBody(recipe, race, (name) => byId.get(name) ?? null);
    // The lattice is a set of functions; the page has no use for it (the workbench builds in place).
    const body: BodyGeometry = { ...made.body, lattice: null };
    const transfer: ArrayBuffer[] = [];
    if (made.layout) transfer.push(made.layout.uvs.buffer as ArrayBuffer, made.layout.texels.region.buffer as ArrayBuffer);
    if (made.base) {
      const b = made.base;
      for (const array of [b.shade, b.mottle, b.covered, b.worn, b.source, b.head.index, b.head.values, b.nipples.index, b.nipples.distance]) transfer.push(array.buffer as ArrayBuffer);
    }
    // The per-texel places are not needed past the painting base.
    const layout = made.layout ? { ...made.layout, texels: { region: made.layout.texels.region, position: new Float32Array(0), normal: new Float32Array(0), surface: new Float32Array(0) } } : null;
    (self as unknown as Worker).postMessage({ id, body, layout, base: made.base } satisfies BuildResponse, transfer);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies BuildResponse);
  }
};
