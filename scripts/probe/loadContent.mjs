import { loadContentFromDisk } from "../diskContent.mjs";

/**
 * The same WorldContent the game loads, read straight from public/packs - what a probe passes to
 * createTerrainSampler and friends:
 *
 *   import { loadContent } from "./loadContent.mjs";
 *   const world = createTerrainSampler(1337, loadContent());
 *   const small = createTerrainSampler(1337, loadContent({ config: "small" }));  // see CONFIG.md
 *   const isles = loadContent({ dimension: "isles" });  // see DIMENSIONS.md (seed: dimensionSeed)
 */
export function loadContent({ config, dimension } = {}) {
  return loadContentFromDisk(config, dimension).content;
}
