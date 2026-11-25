// Hashes the world's layout and some built chunks, to check a refactor changes nothing.
//   npm run probe -- scripts/tools/worldHash.mjs [config]
import { createHash } from "node:crypto";
import { loadContent } from "../probe/loadContent.mjs";
import { createTerrainSampler } from "../../src/world/terrain/terrainSampler.ts";
import { createMaterialBlender } from "../../src/world/materials/materialBlend.ts";
import { createBushScatter, createRockScatter, createTreeCover, createTreeScatter } from "../../src/world/foliage/treeScatter.ts";
import { buildChunkGeometry } from "../../src/world/terrain/chunkGeometry.ts";

const SEED = 1338;
const content = loadContent(...(process.argv[2] ? [{ config: process.argv[2] }] : []));
const started = performance.now();
const world = createTerrainSampler(SEED, content);
const shapedMs = performance.now() - started;
const { sampleTerrain, areaBiomes, settlements } = world;
const context = {
  sampleTerrain,
  materialBlender: createMaterialBlender(SEED, content, areaBiomes),
  scatterTrees: createTreeScatter(SEED, content),
  scatterBushes: createBushScatter(SEED, content, sampleTerrain),
  scatterRocks: createRockScatter(SEED, content, sampleTerrain),
  treeCover: createTreeCover(SEED, content),
  grassKinds: content.grassKinds,
  seed: SEED,
  groundColors: null,
};
const h = createHash("sha256");
h.update(JSON.stringify([[...world.areaNames], settlements.map((s) => [s.name, s.x, s.z]), world.roads.links.length, world.worldExtent]));
for (const spot of [{ x: 0, z: 0 }, ...settlements.slice(0, 3)]) {
  for (const subdivisions of [24, 6]) {
    const g = buildChunkGeometry({ size: 64, subdivisions, detailSubdivisions: 24, originX: (Math.floor(spot.x / 64) + 0.5) * 64, originZ: (Math.floor(spot.z / 64) + 0.5) * 64 }, context);
    for (const key of ["positions", "normals", "matIndices", "matWeights", "shadowPositions"]) h.update(Buffer.from(g[key].buffer));
    h.update(JSON.stringify([g.trees, g.bushes, g.rocks]));
  }
}
console.log(`areas ${world.areaNames.size}, settlements ${settlements.length}, biomes ${content.biomes.length}, materials ${content.materials.length}, trees ${content.treeKinds.length}, buildings ${content.buildings.length}; shaped in ${(shapedMs / 1000).toFixed(1)} s; hash ${h.digest("hex").slice(0, 16)}`);
