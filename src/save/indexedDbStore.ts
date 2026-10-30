import { migrateCharacter, migrateWorld } from "./migrate";
import { byPlayed, type SaveStore } from "./store";

const DATABASE = "aiworld";
const VERSION = 1;
const WORLDS = "worlds";
const CHARACTERS = "characters";

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

/**
 * The browser's store for single player: database `aiworld`, a `worlds` store keyed by id and a
 * `characters` store keyed by [world, id]. Each write is a transaction of its own, so a page closed
 * halfway leaves the last whole record (FRONTEND.md, *The save store*).
 */
export function createIndexedDbStore(): SaveStore {
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(WORLDS)) db.createObjectStore(WORLDS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(CHARACTERS)) db.createObjectStore(CHARACTERS, { keyPath: ["world", "record.id"] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return opening;
  };
  const store = async (name: string, mode: IDBTransactionMode): Promise<{ store: IDBObjectStore; transaction: IDBTransaction }> => {
    const transaction = (await open()).transaction(name, mode);
    return { store: transaction.objectStore(name), transaction };
  };

  return {
    async listWorlds() {
      const { store: worlds } = await store(WORLDS, "readonly");
      return (await done(worlds.getAll())).map(migrateWorld).sort(byPlayed);
    },
    async readWorld(id) {
      const { store: worlds } = await store(WORLDS, "readonly");
      const raw = await done(worlds.get(id));
      return raw === undefined ? null : migrateWorld(raw);
    },
    async writeWorld(world) {
      const { store: worlds, transaction } = await store(WORLDS, "readwrite");
      worlds.put(world);
      await finished(transaction);
    },
    async deleteWorld(id) {
      const transaction = (await open()).transaction([WORLDS, CHARACTERS], "readwrite");
      transaction.objectStore(WORLDS).delete(id);
      transaction.objectStore(CHARACTERS).delete(IDBKeyRange.bound([id, ""], [id, "￿"]));
      await finished(transaction);
    },
    async readCharacter(world, id) {
      const { store: characters } = await store(CHARACTERS, "readonly");
      const raw = (await done(characters.get([world, id]))) as { record: unknown } | undefined;
      return raw === undefined ? null : migrateCharacter(raw.record);
    },
    async writeCharacter(world, character) {
      const { store: characters, transaction } = await store(CHARACTERS, "readwrite");
      characters.put({ world, record: character });
      await finished(transaction);
    },
    async deleteCharacter(world, id) {
      const { store: characters, transaction } = await store(CHARACTERS, "readwrite");
      characters.delete([world, id]);
      await finished(transaction);
    },
  };
}
