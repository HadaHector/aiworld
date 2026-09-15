import { HemisphericLight, Vector3, type Scene } from "@babylonjs/core";
import { createHeightSampler, type HeightSampler } from "./terrain/noise";
import { createTerrainChunk } from "./terrain/terrainMesh";

export interface World {
  heightAt: HeightSampler;
}

const TERRAIN_SEED = 1337;
const TERRAIN_SIZE = 200;
const TERRAIN_SUBDIVISIONS = 150;

/**
 * Orchestrates world content. Currently just terrain — this is the extension point for
 * biomes, structures, props, and eventually a curation workflow over generated variations.
 */
export function createWorld(scene: Scene): World {
  const light = new HemisphericLight("sunLight", new Vector3(0.3, 1, 0.2), scene);
  light.intensity = 0.9;

  const heightAt = createHeightSampler(TERRAIN_SEED);
  createTerrainChunk(scene, {
    size: TERRAIN_SIZE,
    subdivisions: TERRAIN_SUBDIVISIONS,
    heightSampler: heightAt,
  });

  return { heightAt };
}
