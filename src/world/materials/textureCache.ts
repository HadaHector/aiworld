import codeHash from "virtual:texture-code-hash";
import type { TextureDef } from "./textureGen";

/**
 * Baked textures kept in IndexedDB between visits, raw - exactly the bytes a bake produces - so a
 * start that has baked these textures before reads them back instead of baking again.
 *
 * Raw rather than PNG or WebP: the alpha channels are data (roughness, height), which an image
 * encoded through a canvas loses to premultiplication, and noise compresses too poorly to be worth
 * a second of decoding on every start. A 1024² layer is 8 MB with its normals.
 *
 * A texture is keyed by what it is baked from: the seed, the material id (which seeds its noises),
 * its definition, and `codeHash` - a hash of the code that bakes it (see textureCodeHash in
 * vite.config.ts). Changing the noise or the pipeline compiler therefore bakes everything again
 * rather than quietly serving textures the current code would not make.
 *
 * Every failure here - no IndexedDB, a full disk, a private window - is a miss, never an error: the
 * cache can only make a start faster.
 */

const DB_NAME = "aiworld-textures";
const DB_VERSION = 1;
/** key -> CachedTexture: the pixels. */
const TEXTURES = "textures";
/** key -> CacheEntry: what the size and eviction are worked out from, without reading the pixels. */
const ENTRIES = "entries";

/** Least recently used textures go past this; about 128 layers. */
const LIMIT_BYTES = 1024 ** 3;

export interface CachedTexture {
  color: ArrayBuffer;
  normal: ArrayBuffer;
  averageColor: [number, number, number];
}

interface CacheEntry {
  key: string;
  /** The codeHash it was baked by - one from other code is never read again, so it goes on open. */
  code: string;
  id: string;
  bytes: number;
  usedAt: number;
}

export interface TextureCacheUsage {
  bytes: number;
  count: number;
}

const listeners = new Set<() => void>();

/** Calls `listener` whenever textures are added or the cache is cleared; returns its removal. */
export function onTextureCacheChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
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
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(TEXTURES);
        request.result.createObjectStore(ENTRIES, { keyPath: "key" });
      };
      const db = await done(request);
      await evict(db);
      return db;
    } catch (error) {
      console.warn("Texture cache unavailable; baking every texture.", error);
      return null;
    }
  })();
  return opening;
}

/** Drops textures baked by other code, then the least recently used past LIMIT_BYTES. */
async function evict(db: IDBDatabase): Promise<void> {
  const transaction = db.transaction([TEXTURES, ENTRIES], "readwrite");
  let dropped = 0;
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
      transaction.objectStore(TEXTURES).delete(entry.key);
      transaction.objectStore(ENTRIES).delete(entry.key);
      dropped++;
    }
  };
  await finished(transaction);
  if (dropped > 0) changed();
}

/** One key per texture, or null when this browser cannot hash (crypto.subtle needs a secure
 *  context - localhost counts). */
export async function textureKeys(seed: number, textures: { id: string; texture: TextureDef }[]): Promise<string[] | null> {
  if (!globalThis.crypto?.subtle) return null;
  const encoder = new TextEncoder();
  return Promise.all(
    textures.map(async ({ id, texture }) => {
      const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${codeHash}\n${seed}\n${id}\n${JSON.stringify(texture)}`));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }),
  );
}

/** The cached texture for each key, or undefined where there is none. */
export async function loadTextures(keys: string[]): Promise<(CachedTexture | undefined)[]> {
  const db = await database();
  if (!db) return keys.map(() => undefined);
  try {
    const transaction = db.transaction([TEXTURES, ENTRIES], "readwrite");
    const textures = transaction.objectStore(TEXTURES);
    const entries = transaction.objectStore(ENTRIES);
    const now = Date.now();
    // Requests made in callbacks rather than after an await: a transaction commits as soon as it
    // has nothing pending, so it must never wait on anything but its own requests.
    const found: (CachedTexture | undefined)[] = keys.map(() => undefined);
    keys.forEach((key, i) => {
      const texture = textures.get(key);
      texture.onsuccess = () => (found[i] = texture.result as CachedTexture | undefined);
      const entry = entries.get(key);
      entry.onsuccess = () => {
        if (entry.result) entries.put({ ...(entry.result as CacheEntry), usedAt: now });
      };
    });
    await finished(transaction);
    return found;
  } catch (error) {
    console.warn("Texture cache read failed; baking instead.", error);
    return keys.map(() => undefined);
  }
}

/** Keeps a freshly baked texture. Not awaited by the bake - a start never waits on the disk. */
export async function saveTexture(key: string, id: string, texture: CachedTexture): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    const transaction = db.transaction([TEXTURES, ENTRIES], "readwrite");
    transaction.objectStore(TEXTURES).put(texture, key);
    const entry: CacheEntry = { key, code: codeHash, id, bytes: texture.color.byteLength + texture.normal.byteLength, usedAt: Date.now() };
    transaction.objectStore(ENTRIES).put(entry);
    await finished(transaction);
    scheduleEviction(db);
    changed();
  } catch (error) {
    console.warn(`Texture cache could not keep "${id}".`, error);
  }
}

let evictionQueued = false;

/** One eviction after a burst of saves, not one per texture. */
function scheduleEviction(db: IDBDatabase): void {
  if (evictionQueued) return;
  evictionQueued = true;
  setTimeout(() => {
    evictionQueued = false;
    evict(db).catch((error) => console.warn("Texture cache eviction failed.", error));
  }, 1000);
}

export async function textureCacheUsage(): Promise<TextureCacheUsage> {
  const db = await database();
  if (!db) return { bytes: 0, count: 0 };
  const entries = await done(db.transaction(ENTRIES).objectStore(ENTRIES).getAll() as IDBRequest<CacheEntry[]>);
  return { bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), count: entries.length };
}

export async function clearTextureCache(): Promise<void> {
  const db = await database();
  if (!db) return;
  const transaction = db.transaction([TEXTURES, ENTRIES], "readwrite");
  transaction.objectStore(TEXTURES).clear();
  transaction.objectStore(ENTRIES).clear();
  await finished(transaction);
  changed();
}
