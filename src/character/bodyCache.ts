import { buildBody, type BodyGeometry } from "./bodyMesh";
import { layoutAtlas, type AtlasLayout } from "./atlas";
import { paintLookSliced, paintLook, preparePaint, preparePaintSliced, type Appearance, type PaintBase } from "./paint";
import { bakeGearMaterial, type BakedGearMaterial, type GearMaterialDef } from "./gearMaterial";
import type { GearDef } from "./gearDef";
import type { RaceDef } from "./raceDef";
import { addTime, registerCacheStats, timed } from "./bodyTiming";
import { coversFor, paintMaterials, type BodyRecipe } from "./bodyMake";
import { buildInWorker } from "./bodyBuildPool";

export type { BodyRecipe } from "./bodyMake";

/**
 * Bodies kept for the characters that share them (CHARACTERS.md, *Caches*). A character's body is
 * its race's and sex's own shape - the one default mesh, whatever its height and build, which scale
 * it - dressed in its gear, so every guard in a village is the same mesh, atlas layout, light and
 * shadow, and what is worn painted on it. Only who they are - skin, face, hair, beard - is painted
 * per character, and that too is kept for the next time the same one is seen.
 *
 * Both caches hold promises, so characters asked for at once share one build, and are bounded by
 * size, least recently used out first. A race, gear piece or material edited in the workbench is a
 * new object with new content, so it is a new key: nothing here needs clearing for it. Code that
 * changes how a body is built or painted needs `clearBodyCaches()` only in a page already open.
 */

/** Bytes the kept bodies (geometry, layout, paint bases) and the kept atlases may take each. */
const BODY_BUDGET = 96 * 1024 * 1024;
const ATLAS_BUDGET = 64 * 1024 * 1024;

/** A body made, and everything about it that is the same for every character wearing it. */
export interface CanonicalBody {
  key: string;
  /** The race as its sex has it: no height or build, which are the character's scale. */
  race: RaceDef;
  body: BodyGeometry;
  layout: AtlasLayout | null;
  base: PaintBase | null;
  baked: Map<string, BakedGearMaterial>;
  bytes: number;
}

interface Kept<T> {
  promise: Promise<T>;
  bytes: number;
  used: number;
}

const bodies = new Map<string, Kept<CanonicalBody>>();
const atlases = new Map<string, Kept<Uint8Array>>();
let clock = 0;
const stats = { bodyHits: 0, bodyMisses: 0, atlasHits: 0, atlasMisses: 0 };

/** The body a recipe makes, built once however many ask. Sliced between frames with `pause`. */
export function canonicalBody(recipe: BodyRecipe, forSexRace: RaceDef, materials: Map<string, GearMaterialDef>, worldSeed: number, pause?: () => Promise<void>): Promise<CanonicalBody> {
  const key = bodyKey(recipe, materials, worldSeed);
  const found = bodies.get(key);
  if (found) {
    found.used = ++clock;
    stats.bodyHits++;
    return found.promise;
  }
  stats.bodyMisses++;
  const entry: Kept<CanonicalBody> = { promise: build(key, recipe, forSexRace, materials, worldSeed, pause), bytes: 0, used: ++clock };
  bodies.set(key, entry);
  entry.promise.then(
    (made) => {
      entry.bytes = made.bytes;
      trim(bodies, BODY_BUDGET);
    },
    () => bodies.delete(key),
  );
  return entry.promise;
}

/** A layout with what a character's painting reads of the body let go (it is in the paint base now);
 *  the Atlas view needs which region a texel is in, so that stays. */
function withoutTexelPlaces(layout: AtlasLayout): AtlasLayout {
  return { ...layout, texels: { region: layout.texels.region, position: new Float32Array(0), normal: new Float32Array(0), surface: new Float32Array(0) } };
}

function sizeOf(body: BodyGeometry, layout: AtlasLayout | null, base: PaintBase | null): number {
  let bytes = body.positions.length * 8 * 2 + body.indices.length * 8 + body.gearUVs.length * 8 + body.triangles * 24;
  if (layout && base) bytes += layout.uvs.byteLength + layout.texels.region.byteLength + base.shade.byteLength + base.mottle.byteLength + base.worn.byteLength + base.source.byteLength + base.covered.byteLength + base.head.values.byteLength + base.nipples.distance.byteLength;
  return bytes;
}

async function build(key: string, recipe: BodyRecipe, race: RaceDef, materials: Map<string, GearMaterialDef>, worldSeed: number, pause?: () => Promise<void>): Promise<CanonicalBody> {
  const baked = new Map<string, BakedGearMaterial>();
  const bake = async (id: string): Promise<BakedGearMaterial | null> => {
    const def = materials.get(id);
    if (!def) return null;
    if (!baked.has(id)) {
      const started = performance.now();
      baked.set(id, await bakeGearMaterial(worldSeed, def));
      addTime("2 gearMaterial (wall, cached after the first)", performance.now() - started);
    }
    return baked.get(id)!;
  };
  // Off the main thread when there are workers to do it and the page is drawing frames (a probe or
  // the workbench builds in place).
  if (pause && recipe.atlas > 0) {
    for (const id of paintMaterials(recipe)) await bake(id);
    const started = performance.now();
    const made = await buildInWorker({ ...recipe, race }, race, [...baked.entries()].map(([id, m]) => ({ id, key: `${worldSeed}|${id}|${hash(JSON.stringify(m.def.texture))}`, size: m.def.size, color: m.color })));
    if (made) {
      addTime("1-4 built in a worker (wall)", performance.now() - started);
      for (const layer of made.body.layers) await bake(layer.material);
      const layout = withoutTexelPlaces(made.layout!);
      return { key, race, body: made.body, layout, base: made.base, baked, bytes: sizeOf(made.body, layout, made.base) };
    }
  }

  const body = timed("1 buildBody", () => buildBody(race, { detail: recipe.detail, lattice: recipe.lattice, gear: recipe.gear }));
  await pause?.();
  for (const layer of body.layers) await bake(layer.material);
  for (const id of paintMaterials(recipe)) await bake(id);
  if (recipe.atlas <= 0) return { key, race, body, layout: null, base: null, baked, bytes: sizeOf(body, null, null) };

  const layout = timed("3 layoutAtlas", () => layoutAtlas(body, recipe.atlas));
  await pause?.();
  const covers = coversFor(recipe, race, body, (id) => baked.get(id) ?? null);
  const started = performance.now();
  const base = pause ? await preparePaintSliced(body, layout, race, covers, pause) : preparePaint(body, layout, race, covers);
  addTime("4b paint base (wall)", performance.now() - started);
  const kept = withoutTexelPlaces(layout);
  return { key, race, body, layout: kept, base, baked, bytes: sizeOf(body, kept, base) };
}

/** The atlas a character's looks paint on a body, kept for the next time they are asked for. */
export function paintedAtlas(canon: CanonicalBody, look: Appearance, pause?: () => Promise<void>): Promise<Uint8Array> {
  const key = `${canon.key}|${lookKey(look)}`;
  const found = atlases.get(key);
  if (found) {
    found.used = ++clock;
    stats.atlasHits++;
    return found.promise;
  }
  stats.atlasMisses++;
  const { layout, base, race } = canon;
  const started = performance.now();
  const made = pause ? paintLookSliced(base!, layout!, race, look, pause) : Promise.resolve(paintLook(base!, layout!, race, look));
  const entry: Kept<Uint8Array> = { promise: made.then((pixels) => (addTime("4 paint look (wall)", performance.now() - started), pixels)), bytes: layout!.size * layout!.size * 4, used: ++clock };
  atlases.set(key, entry);
  entry.promise.then(
    () => trim(atlases, ATLAS_BUDGET),
    () => atlases.delete(key),
  );
  return entry.promise;
}

/** Drops least recently used entries until the rest fit the budget. Unfinished ones are not counted. */
function trim<T>(kept: Map<string, Kept<T>>, budget: number): void {
  let total = 0;
  for (const entry of kept.values()) total += entry.bytes;
  if (total <= budget) return;
  for (const [key, entry] of [...kept].filter(([, e]) => e.bytes > 0).sort((a, b) => a[1].used - b[1].used)) {
    if (total <= budget) break;
    kept.delete(key);
    total -= entry.bytes;
  }
}

/** Forgets every kept body and atlas. */
export function clearBodyCaches(): void {
  bodies.clear();
  atlases.clear();
}

export function bodyCacheStats(): typeof stats & { bodies: number; bodyBytes: number; atlases: number; atlasBytes: number } {
  const sum = (kept: Map<string, Kept<unknown>>): number => [...kept.values()].reduce((total, e) => total + e.bytes, 0);
  return { ...stats, bodies: bodies.size, bodyBytes: sum(bodies), atlases: atlases.size, atlasBytes: sum(atlases) };
}

registerCacheStats(bodyCacheStats);

// --- keys ---

/** Numbers standing for objects that are not copied: a race def edited is a new object, so a new key. */
const identities = new WeakMap<object, number>();
let nextIdentity = 1;
function identity(thing: object): number {
  let id = identities.get(thing);
  if (!id) identities.set(thing, (id = nextIdentity++));
  return id;
}

/** A short hash of a piece of gear's whole content (its tint included), by value. */
const gearHashes = new WeakMap<GearDef, string>();
function gearHash(piece: GearDef): string {
  let found = gearHashes.get(piece);
  if (!found) gearHashes.set(piece, (found = hash(JSON.stringify(piece))));
  return found;
}

function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193);
    b = Math.imul(b + text.charCodeAt(i), 0x85ebca6b) ^ (b >>> 13);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

function bodyKey(recipe: BodyRecipe, materials: Map<string, GearMaterialDef>, worldSeed: number): string {
  return [recipe.race.id, identity(recipe.race), identity(materials), recipe.sex, recipe.gear.map(gearHash).join("+"), recipe.smallclothes ? 1 : 0, recipe.detail, recipe.lattice ? 1 : 0, recipe.atlas, worldSeed].join("|");
}

function lookKey(look: Appearance): string {
  return hash(JSON.stringify([look.skin, look.hair, look.eyes, look.beard, look.eyeSpacing, look.browTilt, look.mouthWidth, look.hairStyle]));
}
