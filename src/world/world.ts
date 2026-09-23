import type { Camera, Scene } from "@babylonjs/core";
import { createChunkManager } from "./terrain/chunkManager";
import { createTerrainSampler, type TerrainSampler } from "./terrain/terrainSampler";
import { createOceanPlane } from "./terrain/ocean";
import { createMaterialLibrary, type MaterialLibrary } from "./materials/materialLibrary";
import { createTreeScatter } from "./foliage/treeScatter";
import { createTreeField, type TreeField } from "./foliage/treeField";
import { createSunLighting } from "./lighting/sunLighting";
import type { ContinentPlan } from "./cells/continentLayout";
import type { AreaBounds } from "./cells/areaField";
import type { SettlementSite } from "./settlements/settlementSites";
import type { RoadNetwork } from "./roads/roadNetwork";

/** Coarse progress for the loading screen. `total` is 0 for phases with no countable steps. */
export interface WorldLoadProgress {
  phase: string;
  completed: number;
  total: number;
}

export interface World {
  heightAt: (worldX: number, worldZ: number) => number;
  sampleTerrain: TerrainSampler;
  updateChunks: (playerX: number, playerZ: number) => void;
  setDrawDistance: (loadRadius: number) => void;
  worldExtent: number;
  continents: ContinentPlan[];
  areaBounds: Map<number, AreaBounds>;
  areaNames: Map<number, string>;
  settlements: SettlementSite[];
  roads: RoadNetwork;
  materialLibrary: MaterialLibrary;
  trees: TreeField;
  /** Camera near/far and the shadow generator's own frustum both depend on the real camera, which
   *  main.ts creates after the world exists - call this once it does. */
  attachCamera: (camera: Camera) => void;
  setShadowsEnabled: (enabled: boolean) => void;
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
/**
 * Resolves after the browser has had a chance to paint - two frames, one to flush the style/layout
 * change and one to be sure it reached the screen.
 *
 * The timeout is not belt-and-braces: requestAnimationFrame does not fire at all in a background
 * tab, so without it, loading the page in one would hang world creation indefinitely rather than
 * merely skipping a repaint. Whichever fires first wins; missing a paint is fine, hanging is not.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 60);
  });
}

export async function createWorld(scene: Scene, onProgress?: (progress: WorldLoadProgress) => void): Promise<World> {
  const sunLighting = createSunLighting(scene);

  onProgress?.({ phase: "Shaping continents", completed: 0, total: 0 });
  const { sampleTerrain, worldExtent, continents, areaBounds, areaNames, settlements, roads } = createTerrainSampler(WORLD_SEED);

  const materialLibrary = await createMaterialLibrary(scene, WORLD_SEED, sunLighting, (done, total) => {
    onProgress?.({ phase: "Baking material textures", completed: done, total });
  });

  const trees = createTreeField(scene, sunLighting.shadowGenerator);

  const chunkManager = createChunkManager({
    scene,
    sampleTerrain,
    materialLibrary,
    scatterTrees: createTreeScatter(WORLD_SEED),
    trees,
    shadowGenerator: sunLighting.shadowGenerator,
    chunkSize: CHUNK_SIZE,
    chunkSubdivisions: CHUNK_SUBDIVISIONS,
    loadRadius: DEFAULT_DRAW_DISTANCE,
    unloadRadius: DEFAULT_DRAW_DISTANCE + UNLOAD_HYSTERESIS,
  });
  // loadInitial blocks for a few hundred ms, so give the browser a frame to actually paint the
  // "building terrain" message before it starts - otherwise the loading screen sits on the
  // previous phase for the whole thing.
  onProgress?.({ phase: "Building terrain", completed: 0, total: 0 });
  await nextPaint();
  chunkManager.loadInitial(0, 0);

  createOceanPlane(scene, { size: worldExtent });

  const heightAt = (worldX: number, worldZ: number) => sampleTerrain(worldX, worldZ).height;
  const updateChunks = (playerX: number, playerZ: number) => chunkManager.update(playerX, playerZ);
  const setDrawDistance = (loadRadius: number) => chunkManager.setRadii(loadRadius, loadRadius + UNLOAD_HYSTERESIS);
  const setShadowsEnabled = (enabled: boolean) => {
    sunLighting.setShadowsEnabled(enabled);
    materialLibrary.setShadowsEnabled(enabled);
  };

  return {
    heightAt,
    sampleTerrain,
    updateChunks,
    setDrawDistance,
    worldExtent,
    continents,
    areaBounds,
    areaNames,
    settlements,
    roads,
    materialLibrary,
    trees,
    attachCamera: sunLighting.attachCamera,
    setShadowsEnabled,
  };
}
