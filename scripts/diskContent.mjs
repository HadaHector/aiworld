import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPackIndex } from "./packIndex.mjs";
import { resolveContent } from "../src/world/content/resolveContent.ts";
import { DEFAULT_CONFIG, readWorldConfig, selectPacks } from "../src/world/content/worldConfig.ts";
import { ContentError } from "../src/world/content/contentReader.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

/**
 * The world config by name from public/configs (see CONFIG.md) - "default", the full game, needs no
 * file - read from disk, for Node: the headless server and the probes.
 */
export function readConfigFromDisk(name = DEFAULT_CONFIG.name) {
  if (name === DEFAULT_CONFIG.name) return DEFAULT_CONFIG;
  const path = `${PUBLIC_DIR}configs/${name}.json5`;
  if (!existsSync(path)) throw new ContentError([{ file: `configs/${name}.json5`, path: "", message: "no such config" }]);
  return readWorldConfig(name, readFileSync(path, "utf8"));
}

/**
 * The same WorldContent the game loads under a config, read straight from public/packs. Returns
 * the pack ids it was made from too, for a server's welcome.
 */
export function loadContentFromDisk(configName = DEFAULT_CONFIG.name) {
  const config = readConfigFromDisk(configName);
  const root = `${PUBLIC_DIR}packs`;
  const packs = selectPacks(buildPackIndex(root).packs, config);
  const content = resolveContent(
    packs.map((pack) => ({ id: pack.id, files: pack.files.map((path) => ({ path, text: readFileSync(`${root}/${pack.id}/${path}`, "utf8") })) })),
    config,
  );
  return { content, packs: packs.map((pack) => pack.id) };
}
