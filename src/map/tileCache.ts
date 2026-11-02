import { MAP_TILE_PIXELS, mapTileKey } from "./tiles";

/** Bitmaps kept in memory, most recently drawn last (about 256 KB each in the GPU process). */
const MEMORY_TILES = 120;
/** Tiles being made at once: one per chunk worker keeps both busy without queueing stale ones. */
const IN_FLIGHT = 2;
/** Tiles kept in IndexedDB before the oldest go. */
const STORED_TILES = 1500;
const DATABASE = "aiworld-map";
const STORE = "tiles";

/**
 * The map's tiles for one dimension (MAP.md, *Building and caching them*): kept in memory as
 * bitmaps, in IndexedDB as small images, and made - by `build`, a chunk worker - when neither has
 * one. Views say each frame which tiles they want, nearest first; only those are fetched or made, so
 * walking away from a tile that was waiting drops it.
 */
export interface MapTileCache {
  /** The tile's bitmap, if it is ready. */
  get: (tx: number, tz: number) => ImageBitmap | null;
  /** The tiles a view wants now, most wanted first - replaces what that view wanted before. */
  want: (view: string, tiles: readonly { tx: number; tz: number }[]) => void;
  /** Called whenever a tile becomes ready. Returns what stops the calls. */
  onTile: (listener: () => void) => () => void;
  /** Tiles in memory, for the Memory panel. */
  readonly size: number;
  dispose: () => void;
}

export function createMapTileCache(world: string, dimension: string, build: (tx: number, tz: number) => Promise<Uint8ClampedArray>): MapTileCache {
  const memory = new Map<string, ImageBitmap>();
  const wanted = new Map<string, { tx: number; tz: number; key: string }[]>();
  const busy = new Set<string>();
  const listeners = new Set<() => void>();
  let disposed = false;
  let writes = 0;
  const key = (tx: number, tz: number): string => mapTileKey(world, dimension, tx, tz);

  function keep(k: string, bitmap: ImageBitmap): void {
    if (disposed) {
      bitmap.close();
      return;
    }
    memory.set(k, bitmap);
    if (memory.size > MEMORY_TILES) {
      // The oldest first, never one still wanted: a view would show a hole and ask again at once.
      const still = new Set([...wanted.values()].flatMap((list) => list.map((t) => t.key)));
      for (const [oldest, old] of memory) {
        if (memory.size <= MEMORY_TILES) break;
        if (still.has(oldest)) continue;
        memory.delete(oldest);
        old.close();
      }
    }
    for (const listener of listeners) listener();
  }

  async function fetchTile(tile: { tx: number; tz: number; key: string }): Promise<void> {
    const stored = await readStored(tile.key).catch(() => null);
    if (stored) {
      keep(tile.key, await createImageBitmap(stored));
      return;
    }
    const pixels = await build(tile.tx, tile.tz);
    const image = new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.length), MAP_TILE_PIXELS, MAP_TILE_PIXELS);
    keep(tile.key, await createImageBitmap(image));
    void store(tile.key, image);
  }

  function pump(): void {
    if (disposed) return;
    // Round the views, the first wanted tile of each in turn, so one view does not starve another.
    const lists = [...wanted.values()];
    for (let depth = 0; busy.size < IN_FLIGHT; depth++) {
      let any = false;
      for (const list of lists) {
        const tile = list[depth];
        if (!tile) continue;
        any = true;
        if (busy.size >= IN_FLIGHT) break;
        if (memory.has(tile.key) || busy.has(tile.key)) continue;
        busy.add(tile.key);
        fetchTile(tile)
          .catch((error) => console.warn(`Map tile ${tile.key} failed:`, error))
          .finally(() => {
            busy.delete(tile.key);
            pump();
          });
      }
      if (!any) break;
    }
  }

  async function store(k: string, image: ImageData): Promise<void> {
    if (typeof OffscreenCanvas === "undefined") return;
    try {
      const canvas = new OffscreenCanvas(MAP_TILE_PIXELS, MAP_TILE_PIXELS);
      canvas.getContext("2d")!.putImageData(image, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.92 });
      await writeStored(k, blob);
      if (++writes % 50 === 0) await pruneStored();
    } catch {
      // Not kept: it is made again next time.
    }
  }

  return {
    get(tx, tz) {
      const k = key(tx, tz);
      const bitmap = memory.get(k);
      if (!bitmap) return null;
      memory.delete(k);
      memory.set(k, bitmap);
      return bitmap;
    },
    want(view, tiles) {
      wanted.set(view, tiles.map((t) => ({ ...t, key: key(t.tx, t.tz) })));
      pump();
    },
    onTile(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get size() {
      return memory.size;
    },
    dispose() {
      disposed = true;
      for (const bitmap of memory.values()) bitmap.close();
      memory.clear();
      wanted.clear();
      listeners.clear();
    },
  };
}

let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("No IndexedDB"));
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE);
      store.createIndex("time", "time");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

function done(request: IDBRequest | IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    if (request instanceof IDBTransaction) {
      request.oncomplete = () => resolve();
      request.onerror = () => reject(request.error);
    } else {
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }
  });
}

async function readStored(key: string): Promise<Blob | null> {
  const store = (await open()).transaction(STORE, "readonly").objectStore(STORE);
  const request = store.get(key);
  await done(request);
  return (request.result as { blob: Blob } | undefined)?.blob ?? null;
}

async function writeStored(key: string, blob: Blob): Promise<void> {
  const transaction = (await open()).transaction(STORE, "readwrite");
  transaction.objectStore(STORE).put({ blob, time: Date.now() }, key);
  await done(transaction);
}

/** Drops the oldest tiles past STORED_TILES. */
async function pruneStored(): Promise<void> {
  const transaction = (await open()).transaction(STORE, "readwrite");
  const store = transaction.objectStore(STORE);
  const count = store.count();
  await done(count);
  let extra = count.result - STORED_TILES;
  if (extra <= 0) return;
  const cursor = store.index("time").openCursor();
  await new Promise<void>((resolve, reject) => {
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c || extra-- <= 0) return resolve();
      c.delete();
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}
