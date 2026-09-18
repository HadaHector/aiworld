import { HemisphericLight, Vector3, type Scene } from "@babylonjs/core";
import { createChunkManager } from "./terrain/chunkManager";
import { createTerrainSampler, type TerrainSampler } from "./terrain/terrainSampler";
import { createOceanPlane } from "./terrain/ocean";
import { createMaterialLibrary, type MaterialLibrary } from "./materials/materialLibrary";
import type { ContinentPlan } from "./cells/continentLayout";

export interface World {
  heightAt: (worldX: number, worldZ: number) => number;
  sampleTerrain: TerrainSampler;
  updateChunks: (playerX: number, playerZ: number) => void;
  setDrawDistance: (loadRadius: number) => void;
  worldExtent: number;
  continents: ContinentPlan[];
  materialLibrary: MaterialLibrary;
}

const WORLD_SEED = 1337;

const CHUNK_SIZE = 50;
const CHUNK_SUBDIVISIONS = 20;
const UNLOAD_HYSTERESIS = CHUNK_SIZE; // unload radius = load radius + this, a 1-chunk buffer band

export const DEFAULT_DRAW_DISTANCE = 400;
export const MIN_DRAW_DISTANCE = 100;
export const MAX_DRAW_DISTANCE = 2000;

/**
 * Orchestrates world content: the cell-based continent/area system, and terrain streamed in as
 * chunks around the player. World size is derived from generated content (see
 * cells/continentLayout.ts), not manually set. sampleTerrain is exposed for future
 * props/structures/gameplay systems to query biome/land at a point.
 */
export function createWorld(scene: Scene): World {
  const light = new HemisphericLight("sunLight", new Vector3(0.3, 1, 0.2), scene);
  light.intensity = 0.9;

  const { sampleTerrain, worldExtent, continents } = createTerrainSampler(WORLD_SEED);
  const materialLibrary = createMaterialLibrary(scene, WORLD_SEED, light.direction, light.intensity);

  const chunkManager = createChunkManager({
    scene,
    sampleTerrain,
    materialLibrary,
    chunkSize: CHUNK_SIZE,
    chunkSubdivisions: CHUNK_SUBDIVISIONS,
    loadRadius: DEFAULT_DRAW_DISTANCE,
    unloadRadius: DEFAULT_DRAW_DISTANCE + UNLOAD_HYSTERESIS,
  });
  chunkManager.loadInitial(0, 0);

  createOceanPlane(scene, { size: worldExtent });

  const heightAt = (worldX: number, worldZ: number) => sampleTerrain(worldX, worldZ).height;
  const updateChunks = (playerX: number, playerZ: number) => chunkManager.update(playerX, playerZ);
  const setDrawDistance = (loadRadius: number) => chunkManager.setRadii(loadRadius, loadRadius + UNLOAD_HYSTERESIS);

  return { heightAt, sampleTerrain, updateChunks, setDrawDistance, worldExtent, continents, materialLibrary };
}
