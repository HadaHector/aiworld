// The save store on disk, for a dedicated server (FRONTEND.md, *The save store*):
//   <root>/<world>/world.json
//   <root>/<world>/characters/<id>.json
// Each file is written to a temporary name and renamed over the old one, so a crash never leaves
// half a file. The same SaveStore as the browser's IndexedDB one (src/save/store.ts).
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateCharacter, migrateWorld } from "../../src/save/migrate.ts";
import { byPlayed } from "../../src/save/store.ts";

/** Ids become folder and file names: nothing that could climb out of the root. */
function safe(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`Not a save id: ${JSON.stringify(id)}`);
  return id;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 1));
  await rename(temporary, path);
}

/** @returns {import("../../src/save/store.ts").SaveStore} */
export function createFileStore(root) {
  const worldDir = (id) => join(root, safe(id));
  const characterDir = (world) => join(worldDir(world), "characters");
  return {
    async listWorlds() {
      let names = [];
      try {
        names = await readdir(root);
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      const worlds = [];
      for (const name of names) {
        const raw = await readJson(join(root, name, "world.json"));
        if (raw) worlds.push(migrateWorld(raw));
      }
      return worlds.sort(byPlayed);
    },
    async readWorld(id) {
      const raw = await readJson(join(worldDir(id), "world.json"));
      return raw && migrateWorld(raw);
    },
    async writeWorld(world) {
      await mkdir(characterDir(world.id), { recursive: true });
      await writeJson(join(worldDir(world.id), "world.json"), world);
    },
    async deleteWorld(id) {
      await rm(worldDir(id), { recursive: true, force: true });
    },
    async readCharacter(world, id) {
      const raw = await readJson(join(characterDir(world), `${safe(id)}.json`));
      return raw && migrateCharacter(raw);
    },
    async writeCharacter(world, character) {
      await mkdir(characterDir(world), { recursive: true });
      await writeJson(join(characterDir(world), `${safe(character.id)}.json`), character);
    },
    async deleteCharacter(world, id) {
      await rm(join(characterDir(world), `${safe(id)}.json`), { force: true });
    },
  };
}
