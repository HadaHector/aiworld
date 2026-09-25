import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Lists every content pack under `root` (public/packs) and the .json5 files in each, by path inside
 * the pack with forward slashes. A browser cannot list a directory, so this is what the game fetches
 * first to learn what there is to load - served live by the dev server and written into the build
 * (see vite.config.ts), and used directly by the probe loader.
 */
export function buildPackIndex(root) {
  if (!existsSync(root)) return { packs: [] };
  const packs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, files: listFiles(join(root, entry.name), "") }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { packs };
}

function listFiles(dir, prefix) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(join(dir, entry.name), path));
    else if (entry.name.endsWith(".json5")) files.push(path);
  }
  return files.sort();
}
