import type { Camera, Scene } from "@babylonjs/core";
import { createChunkManager, type ChunkLodLevel } from "./terrain/chunkManager";
import { createChunkBuildPool } from "./terrain/chunkBuildPool";
import { createTerrainSampler, type TerrainSampler } from "./terrain/terrainSampler";
import { createOceanPlane } from "./terrain/ocean";
import { createMaterialLibrary, type MaterialLibrary } from "./materials/materialLibrary";
import { createTreeScatter } from "./foliage/treeScatter";
import { createTreeField, type TreeField } from "./foliage/treeField";
import { createGrassField, type GrassField } from "./foliage/grassField";
import { createSettlementRenderer } from "./settlements/settlementRenderer";
import type { SettlementLayout } from "./settlements/settlementLayout";
import { createSunLighting, DEFAULT_DAY_NIGHT_CYCLE_MINUTES } from "./lighting/sunLighting";
import { createSkyDome } from "./sky/skyDome";
import type { ContinentPlan } from "./cells/continentLayout";
import type { AreaBounds, AreaWeight } from "./cells/areaField";
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
  /** `immediate` builds whatever is queued on this thread now instead of handing it to the chunk
   *  build workers - see ChunkManager.update. */
  updateChunks: (playerX: number, playerZ: number, immediate?: boolean) => void;
  setDrawDistance: (loadRadius: number) => void;
  worldExtent: number;
  continents: ContinentPlan[];
  areaBounds: Map<number, AreaBounds>;
  areaNames: Map<number, string>;
  settlements: SettlementSite[];
  roads: RoadNetwork;
  /** Streets, squares and houses per settlement - see settlements/settlementLayout.ts. */
  settlementLayouts: SettlementLayout[];
  materialLibrary: MaterialLibrary;
  trees: TreeField;
  grass: GrassField;
  /** Camera near/far and the shadow generator's own frustum both depend on the real camera, which
   *  main.ts creates after the world exists - call this once it does. */
  attachCamera: (camera: Camera) => void;
  setShadowsEnabled: (enabled: boolean) => void;
  /** Draws the terrain as wireframe, to see mesh density and where each level of detail starts. */
  setWireframe: (enabled: boolean) => void;
  /** Re-blends the sky, fog colour and fog-start distance for wherever the player is now - see
   *  sky/skyDome.ts. Cheap (a handful of Color3/float lerps over however many areas are in range),
   *  so this is meant to be called every frame from the same sampleTerrain result main.ts already
   *  takes for the zone label, not gated behind any dirty check of its own. */
  updateAtmosphere: (areaWeights: AreaWeight[]) => void;
  /** Advances the day-night cycle and re-blends lighting for wherever the player is now - see
   *  lighting/sunLighting.ts's updateDayNight. Meant to be called every frame alongside
   *  updateAtmosphere, with the same areaWeights and the frame's own delta time. */
  updateDayNight: (deltaSeconds: number, areaWeights: AreaWeight[]) => void;
  /** Jumps the clock to a given hour (0-24, wrapping) - what the settings-panel time-of-day slider
   *  drives, so previewing the far side of a slow cycle doesn't mean actually waiting for it. */
  setTimeOfDay: (hours: number) => void;
  getTimeOfDay: () => number;
}

const WORLD_SEED = 1337;

const CHUNK_SIZE = 64;
// Grid spacing doubles as distance doubles, which keeps a triangle about the same size on screen.
// The last level runs out to the draw distance.
const CHUNK_LOD_LEVELS: ChunkLodLevel[] = [
  { subdivisions: 24, maxDistance: 200 },
  { subdivisions: 12, maxDistance: 400 },
  { subdivisions: 6, maxDistance: Infinity },
];
const UNLOAD_HYSTERESIS = CHUNK_SIZE; // unload radius = load radius + this, a 1-chunk buffer band

export const DEFAULT_DRAW_DISTANCE = 800;
export const MIN_DRAW_DISTANCE = 100;
export const MAX_DRAW_DISTANCE = 2000;

// Re-exported so main.ts's settings panel can label the time-of-day slider without reaching past
// World's own public surface into lighting/sunLighting.ts directly.
export { DEFAULT_DAY_NIGHT_CYCLE_MINUTES };

// Fog's far edge is sized off the draw distance rather than a fixed world-unit band, so it always
// meets the far edge of loaded chunks at the same fraction of the way there, whatever the slider
// is set to - a fixed band either fogs out ground well short of the load radius (small setting) or
// never reaches full fog before chunks stop loading at all (large setting). Where fog STARTS is a
// per-biome fraction of this same draw distance instead - see BiomeAtmosphere.fogStartFraction.
const FOG_END_FRACTION = 0.95;

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

  // Started first: each worker spends a few seconds building its own copy of the world (see
  // chunkBuild.worker.ts), which overlaps with this thread building its own below.
  let buildPool = createChunkBuildPool(WORLD_SEED);

  onProgress?.({ phase: "Shaping continents", completed: 0, total: 0 });
  const { sampleTerrain, worldExtent, continents, areaBounds, areaNames, settlements, roads, settlementLayouts } = createTerrainSampler(WORLD_SEED);

  const materialLibrary = await createMaterialLibrary(scene, WORLD_SEED, sunLighting, (done, total) => {
    onProgress?.({ phase: "Baking material textures", completed: done, total });
  });

  const trees = createTreeField(scene, sunLighting.shadowGenerator);
  const grass = createGrassField(scene, WORLD_SEED, materialLibrary.litShading);
  const buildings = createSettlementRenderer(
    scene,
    settlementLayouts,
    WORLD_SEED,
    materialLibrary.litShading,
    sunLighting.shadowGenerator,
    DEFAULT_DRAW_DISTANCE,
  );
  const sky = createSkyDome(scene);

  if (buildPool) {
    onProgress?.({ phase: "Starting terrain workers", completed: 0, total: 0 });
    try {
      await buildPool.ready;
    } catch (error) {
      console.error("Chunk build workers failed to start; building terrain on the main thread.", error);
      buildPool.dispose();
      buildPool = null;
    }
  }

  const chunkManager = createChunkManager({
    scene,
    buildContext: { sampleTerrain, materialBlender: materialLibrary.blender, scatterTrees: createTreeScatter(WORLD_SEED), seed: WORLD_SEED },
    buildPool,
    materialLibrary,
    trees,
    grass,
    shadowGenerator: sunLighting.shadowGenerator,
    chunkSize: CHUNK_SIZE,
    lodLevels: CHUNK_LOD_LEVELS,
    loadRadius: DEFAULT_DRAW_DISTANCE,
    unloadRadius: DEFAULT_DRAW_DISTANCE + UNLOAD_HYSTERESIS,
  });
  // loadInitial blocks for a few hundred ms, so give the browser a frame to actually paint the
  // "building terrain" message before it starts - otherwise the loading screen sits on the
  // previous phase for the whole thing.
  onProgress?.({ phase: "Building terrain", completed: 0, total: 0 });
  await nextPaint();
  chunkManager.loadInitial(0, 0);

  // Only needs to reach past the farthest fog - it follows the camera (see ocean.ts).
  createOceanPlane(scene, sunLighting, sky, materialLibrary.terrainMaterial, { size: MAX_DRAW_DISTANCE * 2.5 });

  // Tracked so updateAtmosphere can turn a biome's fogStartFraction into an actual distance without
  // main.ts having to know or pass the draw distance itself every frame.
  let drawDistance = DEFAULT_DRAW_DISTANCE;

  const heightAt = (worldX: number, worldZ: number) => sampleTerrain(worldX, worldZ).height;
  const updateChunks = (playerX: number, playerZ: number, immediate?: boolean) => chunkManager.update(playerX, playerZ, immediate);
  const setDrawDistance = (loadRadius: number) => {
    drawDistance = loadRadius;
    chunkManager.setRadii(loadRadius, loadRadius + UNLOAD_HYSTERESIS);
    buildings.setDrawDistance(loadRadius);
    scene.fogEnd = loadRadius * FOG_END_FRACTION;
  };
  // Sets the initial fog-end directly rather than through setDrawDistance, which would otherwise
  // re-run chunkManager's own enqueue/unload pass a second time against the (0,0) it already
  // loaded via loadInitial above. fogStart is set by the first updateAtmosphere call instead of
  // here - it depends on the player's own zone, which does not exist until main.ts's first frame.
  scene.fogEnd = DEFAULT_DRAW_DISTANCE * FOG_END_FRACTION;
  const setShadowsEnabled = (enabled: boolean) => {
    sunLighting.setShadowsEnabled(enabled);
    materialLibrary.setShadowsEnabled(enabled);
  };
  // Reads sunLighting's own clock rather than taking timeHours as a parameter, so main.ts doesn't
  // have to thread it through - callers just need to call updateDayNight first each frame (main.ts
  // does) so this reads the frame's current time rather than the previous frame's.
  const updateAtmosphere = (areaWeights: AreaWeight[]) => sky.update(areaWeights, drawDistance, sunLighting.getTimeHours(), sunLighting.direction);

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
    settlementLayouts,
    materialLibrary,
    trees,
    grass,
    attachCamera: sunLighting.attachCamera,
    setShadowsEnabled,
    setWireframe: materialLibrary.setWireframe,
    updateAtmosphere,
    updateDayNight: sunLighting.updateDayNight,
    setTimeOfDay: sunLighting.setTimeHours,
    getTimeOfDay: sunLighting.getTimeHours,
  };
}
