import { migrateCharacter, migrateWorld } from "./migrate";
import { byPlayed, type SaveStore } from "./store";

/** A store in memory, gone with the page or process: for `?play`, probes and tests. Records are
 *  copied in and out, as a real store's would be, so nobody shares an object with it. */
export function createMemoryStore(): SaveStore {
  const worlds = new Map<string, string>();
  const characters = new Map<string, string>();
  const key = (world: string, id: string): string => `${world}\n${id}`;
  return {
    listWorlds: async () => [...worlds.values()].map((text) => migrateWorld(JSON.parse(text))).sort(byPlayed),
    readWorld: async (id) => {
      const text = worlds.get(id);
      return text === undefined ? null : migrateWorld(JSON.parse(text));
    },
    writeWorld: async (world) => void worlds.set(world.id, JSON.stringify(world)),
    deleteWorld: async (id) => {
      worlds.delete(id);
      for (const k of [...characters.keys()]) if (k.startsWith(`${id}\n`)) characters.delete(k);
    },
    readCharacter: async (world, id) => {
      const text = characters.get(key(world, id));
      return text === undefined ? null : migrateCharacter(JSON.parse(text));
    },
    writeCharacter: async (world, character) => void characters.set(key(world, character.id), JSON.stringify(character)),
    deleteCharacter: async (world, id) => void characters.delete(key(world, id)),
  };
}
