import type { MaterialDef } from "../world/materials/materialTypes";
import type { TreeKindDef } from "../world/foliage/foliageConfig";
import type { BakedBark } from "../world/foliage/treeModels";
import { bakeLeafAtlas } from "../world/foliage/treeModels";
import { bakeBarks } from "../world/foliage/treeField";
import { bakeTerrainTextures, type TerrainTextures } from "../world/materials/materialLibrary";

/**
 * Every bake the workbench has made, keyed by exactly what it was baked from - the definition's
 * own JSON, its id (which seeds its noises) and the seed - so switching views, stepping variants or
 * previewing an edit elsewhere in the file reuses a bake, and only an edit that changes what is
 * baked bakes again. Holds the last few of each; a bake is megabytes.
 */
const LIMIT = 16;

class Memo<T> {
  private readonly entries = new Map<string, T>();

  get(key: string, make: () => T): T {
    const found = this.entries.get(key);
    if (found !== undefined) {
      // Most recently used last, so the oldest is the first to go.
      this.entries.delete(key);
      this.entries.set(key, found);
      return found;
    }
    const made = make();
    this.entries.set(key, made);
    if (this.entries.size > LIMIT) this.entries.delete(this.entries.keys().next().value!);
    return made;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  forget(key: string): void {
    this.entries.delete(key);
  }
}

const grounds = new Memo<Promise<TerrainTextures>>();
const barks = new Memo<Promise<BakedBark | undefined>>();
const atlases = new Memo<Uint8Array | null>();

/** A failed bake is not kept, so the next preview tries again rather than failing from memory. */
function remembered<T>(memo: Memo<Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  const promise = memo.get(key, make);
  promise.catch(() => memo.forget(key));
  return promise;
}

function groundKey(def: MaterialDef, seed: number): string {
  // The texture's own id: a material borrowing another's texture shares its bake.
  return `${seed}|${def.textureId}|${JSON.stringify(def.texture)}`;
}

/** A material's texture, baked as the terrain shader takes it (one layer), not yet recoloured. */
export function bakedGround(def: MaterialDef, seed: number): Promise<TerrainTextures> {
  return remembered(grounds, groundKey(def, seed), () => bakeTerrainTextures(seed, [def]));
}

/** Whether bakedGround would answer from the cache - so the status can say "baking" only when it is. */
export function isGroundBaked(def: MaterialDef, seed: number): boolean {
  return grounds.has(groundKey(def, seed));
}

/** A generated tree's bark, or undefined for a kind without one. */
export function bakedBark(def: TreeKindDef, seed: number): Promise<BakedBark | undefined> {
  const bark = "bark" in def.shape ? def.shape.bark : null;
  if (!bark) return Promise.resolve(undefined);
  return remembered(barks, `${seed}|${def.id}|${JSON.stringify(bark)}`, async () => (await bakeBarks([def], seed)).get(def.id));
}

/** A kind's leaf atlas, or null for a primitive tree. */
export function bakedAtlas(def: TreeKindDef, seed: number): Uint8Array | null {
  const foliage = "foliage" in def.shape ? def.shape.foliage : null;
  if (!foliage) return null;
  return atlases.get(`${seed}|${def.id}|${JSON.stringify(foliage)}`, () => bakeLeafAtlas(def, seed));
}
