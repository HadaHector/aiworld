import { HemisphericLight, Vector3, type Scene } from "@babylonjs/core";
import { createTerrainChunk } from "./terrain/terrainMesh";
import { createTerrainSampler, type TerrainSampler } from "./terrain/terrainSampler";
import { createOceanPlane } from "./terrain/ocean";
import { WORLD_EXTENT } from "./cells/config";

export interface World {
  heightAt: (worldX: number, worldZ: number) => number;
  sampleTerrain: TerrainSampler;
}

const WORLD_SEED = 1337;
const TERRAIN_SIZE = WORLD_EXTENT;
const TERRAIN_SUBDIVISIONS = 320;

/**
 * Orchestrates world content: the cell-based continent/area system, and terrain built from it.
 * sampleTerrain is exposed for future props/structures/gameplay systems to query biome/land at a point.
 */
export function createWorld(scene: Scene): World {
  const light = new HemisphericLight("sunLight", new Vector3(0.3, 1, 0.2), scene);
  light.intensity = 0.9;

  const sampleTerrain = createTerrainSampler(WORLD_SEED);
  createTerrainChunk(scene, {
    size: TERRAIN_SIZE,
    subdivisions: TERRAIN_SUBDIVISIONS,
    sampleTerrain,
  });
  createOceanPlane(scene, { size: TERRAIN_SIZE });

  const heightAt = (worldX: number, worldZ: number) => sampleTerrain(worldX, worldZ).height;

  return { heightAt, sampleTerrain };
}
