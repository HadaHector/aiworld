import { HemisphericLight, Vector3, type Scene } from "@babylonjs/core";
import { createChunkManager } from "./terrain/chunkManager";
import { createTerrainSampler, type TerrainSampler } from "./terrain/terrainSampler";
import { createOceanPlane } from "./terrain/ocean";
import { WORLD_EXTENT } from "./cells/config";

export interface World {
  heightAt: (worldX: number, worldZ: number) => number;
  sampleTerrain: TerrainSampler;
  updateChunks: (playerX: number, playerZ: number) => void;
}

const WORLD_SEED = 1337;
const TERRAIN_SIZE = WORLD_EXTENT;

const CHUNK_SIZE = 50;
const CHUNK_SUBDIVISIONS = 20;
const LOAD_RADIUS = 150;
const UNLOAD_RADIUS = 200;

/**
 * Orchestrates world content: the cell-based continent/area system, and terrain streamed in as
 * chunks around the player. sampleTerrain is exposed for future props/structures/gameplay systems
 * to query biome/land at a point.
 */
export function createWorld(scene: Scene): World {
  const light = new HemisphericLight("sunLight", new Vector3(0.3, 1, 0.2), scene);
  light.intensity = 0.9;

  const sampleTerrain = createTerrainSampler(WORLD_SEED);

  const chunkManager = createChunkManager({
    scene,
    sampleTerrain,
    chunkSize: CHUNK_SIZE,
    chunkSubdivisions: CHUNK_SUBDIVISIONS,
    loadRadius: LOAD_RADIUS,
    unloadRadius: UNLOAD_RADIUS,
  });
  chunkManager.loadInitial(0, 0);

  createOceanPlane(scene, { size: TERRAIN_SIZE });

  const heightAt = (worldX: number, worldZ: number) => sampleTerrain(worldX, worldZ).height;
  const updateChunks = (playerX: number, playerZ: number) => chunkManager.update(playerX, playerZ);

  return { heightAt, sampleTerrain, updateChunks };
}
