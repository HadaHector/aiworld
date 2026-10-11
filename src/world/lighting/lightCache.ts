import codeHash from "virtual:light-bake-code-hash";
import type { ModelLight } from "../buildings/buildingTypes";

/**
 * Houses' baked lightmaps kept in IndexedDB between visits (see LIGHTS.md), so a house baked once
 * is read back rather than baked again. Used from the bake worker (lightBake.worker.ts).
 *
 * A lightmap is keyed by exactly what it is baked from - the house's mesh (positions, normals,
 * triangles, materials), which materials cast shadow, and its lights - and `codeHash`, a hash of
 * the code that bakes it (see vite.config.ts). The same input bakes the same lightmap, whatever
 * built the house; a change to the house, its content or the bake bakes it again.
 *
 * Every failure here - no IndexedDB, a full disk, a private window - is a miss, never an error.
 */

const DB_NAME = "aiworld-lightmaps";
const DB_VERSION = 1;
/** key -> CachedLightmap. */
const MAPS = "maps";
/** key -> CacheEntry: what the size and eviction are worked out from, without reading the maps. */
const ENTRIES = "entries";

/** Least recently used lightmaps go past this - some hundreds of houses. */
const LIMIT_BYTES = 256 * 1024 ** 2;

export interface CachedLightmap {
  width: number;
  height: number;
  half: ArrayBuffer;
  uvs: ArrayBuffer;
}

interface CacheEntry {
  key: string;
  code: string;
  bytes: number;
  usedAt: number;
}

/** What a lightmap is baked from. */
export interface LightInput {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  layers: Float32Array;
  casts: boolean[];
  lights: ModelLight[];
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

let opening: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  opening ??= (async () => {
    if (typeof indexedDB === "undefined") return null;
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(MAPS);
        request.result.createObjectStore(ENTRIES, { keyPath: "key" });
      };
      const db = await done(request);
      await evict(db);
      return db;
    } catch (error) {
      console.warn("Lightmap cache unavailable; baking every house's lights.", error);
      return null;
    }
  })();
  return opening;
}

/** Drops lightmaps baked by other code, then the least recently used past LIMIT_BYTES. */
async function evict(db: IDBDatabase): Promise<void> {
  const transaction = db.transaction([MAPS, ENTRIES], "readwrite");
  const all = transaction.objectStore(ENTRIES).getAll() as IDBRequest<CacheEntry[]>;
  all.onsuccess = () => {
    const current = all.result.filter((entry) => entry.code === codeHash).sort((a, b) => b.usedAt - a.usedAt);
    let total = 0;
    const kept = new Set<string>();
    for (const entry of current) {
      total += entry.bytes;
      if (total <= LIMIT_BYTES) kept.add(entry.key);
    }
    for (const entry of all.result) {
      if (kept.has(entry.key)) continue;
      transaction.objectStore(MAPS).delete(entry.key);
      transaction.objectStore(ENTRIES).delete(entry.key);
    }
  };
  await finished(transaction);
}

/** The key a lightmap baked from `input` is kept under, or null where this browser cannot hash
 *  (crypto.subtle needs a secure context - localhost counts). */
export async function lightKey(input: LightInput): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const head = new TextEncoder().encode(`${codeHash}\n${JSON.stringify(input.casts)}\n${JSON.stringify(input.lights)}\n`);
  const parts = [head, input.positions, input.normals, input.indices, input.layers].map((part) => new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", all);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The lightmap kept under `key`, or undefined. */
export async function loadLightmap(key: string): Promise<CachedLightmap | undefined> {
  const db = await database();
  if (!db) return undefined;
  try {
    const transaction = db.transaction([MAPS, ENTRIES], "readwrite");
    const map = transaction.objectStore(MAPS).get(key);
    let found: CachedLightmap | undefined;
    map.onsuccess = () => (found = map.result as CachedLightmap | undefined);
    const entries = transaction.objectStore(ENTRIES);
    const entry = entries.get(key);
    entry.onsuccess = () => {
      if (entry.result) entries.put({ ...(entry.result as CacheEntry), usedAt: Date.now() });
    };
    await finished(transaction);
    return found;
  } catch (error) {
    console.warn("Lightmap cache read failed; baking instead.", error);
    return undefined;
  }
}

/** Keeps a freshly baked lightmap. */
export async function saveLightmap(key: string, map: CachedLightmap): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    const transaction = db.transaction([MAPS, ENTRIES], "readwrite");
    transaction.objectStore(MAPS).put(map, key);
    const entry: CacheEntry = { key, code: codeHash, bytes: map.half.byteLength + map.uvs.byteLength, usedAt: Date.now() };
    transaction.objectStore(ENTRIES).put(entry);
    await finished(transaction);
    scheduleEviction(db);
  } catch (error) {
    console.warn("Lightmap cache could not keep a house's lights.", error);
  }
}

let evictionQueued = false;

/** One eviction after a burst of saves, not one per house. */
function scheduleEviction(db: IDBDatabase): void {
  if (evictionQueued) return;
  evictionQueued = true;
  setTimeout(() => {
    evictionQueued = false;
    evict(db).catch((error) => console.warn("Lightmap cache eviction failed.", error));
  }, 1000);
}

export async function clearLightCache(): Promise<void> {
  const db = await database();
  if (!db) return;
  const transaction = db.transaction([MAPS, ENTRIES], "readwrite");
  transaction.objectStore(MAPS).clear();
  transaction.objectStore(ENTRIES).clear();
  await finished(transaction);
}
