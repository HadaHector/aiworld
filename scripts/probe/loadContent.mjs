import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPackIndex } from "../packIndex.mjs";
import { resolveContent } from "../../src/world/content/resolveContent.ts";

const PACKS_DIR = fileURLToPath(new URL("../../public/packs/", import.meta.url));

/**
 * The same WorldContent the game loads, read straight from public/packs - what a probe passes to
 * createTerrainSampler and friends:
 *
 *   import { loadContent } from "./loadContent.mjs";
 *   const world = createTerrainSampler(1337, loadContent());
 */
export function loadContent(root = PACKS_DIR) {
  const { packs } = buildPackIndex(root);
  return resolveContent(
    packs.map((pack) => ({
      id: pack.id,
      files: pack.files.map((path) => ({ path, text: readFileSync(`${root}/${pack.id}/${path}`, "utf8") })),
    })),
  );
}
