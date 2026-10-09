import { treeTintRules } from "./foliage/treeTints";
import { Color3, type Camera, type Scene } from "@babylonjs/core";
import { createChunkManager, type ChunkLodLevel } from "./terrain/chunkManager";
import { createWorldCollision, type WorldCollision } from "./worldCollision";
import { createChunkBuildPool } from "./terrain/chunkBuildPool";
import { createTerrainSampler, type TerrainSampler } from "./terrain/terrainSampler";
import { createOceanPlane } from "./terrain/ocean";
import { createMaterialLibrary, type MaterialLibrary } from "./materials/materialLibrary";
import { createBushScatter, createRockScatter, createTreeCover, createTreeScatter } from "./foliage/treeScatter";
import { createTreeField, type TreeField } from "./foliage/treeField";
import { createGrassField, type GrassField } from "./foliage/grassField";
import { createBuildingRenderer } from "./buildings/buildingRenderer";
import { bakeBuildingTextures, createBuildingMaterial } from "./buildings/buildingMesh";
import type { SettlementLayout } from "./settlements/settlementLayout";
import { createSunLighting, DEFAULT_DAY_NIGHT_CYCLE_MINUTES } from "./lighting/sunLighting";
import { createSkyDome } from "./sky/skyDome";
import { createWeatherSystem, type WeatherSystem } from "./weather/weatherSystem";
import { NO_WEATHER, type WeatherBlend } from "./weather/weatherTypes";
import { setWindStrength } from "./foliage/wind";
import { createPrecipitation } from "./weather/precipitation";
import type { ContinentPlan } from "./cells/continentLayout";
import type { AreaBounds, AreaWeight } from "./cells/areaField";
import type { SettlementSite } from "./settlements/settlementSites";
import type { FeatureSite } from "./features/featureSites";
import type { RoadNetwork } from "./roads/roadNetwork";
import type { WorldContent } from "./content/worldContent";

/** Coarse progress for the loading screen. `total` is 0 for phases with no countable steps. */
export interface WorldLoadProgress {
  phase: string;
  completed: number;
  total: number;
}

export interface World {
  heightAt: (worldX: number, worldZ: number) => number;
  /** What one stands on at a point with one's feet at `feet`: a floor inside a building where there
   *  is one under them - see buildings/buildingRenderer.ts - otherwise the ground. */
  groundAt: (worldX: number, worldZ: number, feet: number) => number;
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
  /** Each cell's major feature other than a settlement (a quarry) - see features/featureSites.ts. */
  features: FeatureSite[];
  roads: RoadNetwork;
  /** Streets, squares and houses per settlement - see settlements/settlementLayout.ts. */
  settlementLayouts: SettlementLayout[];
  materialLibrary: MaterialLibrary;
  trees: TreeField;
  grass: GrassField;
  /** Camera near/far and the shadow generator's own frustum both depend on the real camera, which
   *  main.ts creates after the world exists - call this once it does. */
  /** What the player collides with: the ground and trees around it (see worldCollision.ts). */
  collision: WorldCollision;
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
  /** Advances every in-range zone's weather and hands the blend to the light and the wind - see
   *  weather/weatherSystem.ts. Every frame, before updateDayNight and updateAtmosphere, which use it. */
  updateWeather: (deltaSeconds: number, areaWeights: AreaWeight[], playerX?: number, playerZ?: number) => void;
  /** The zones' weather: what one area's is now (for the HUD), and picking one by hand to look at. */
  weather: WeatherSystem;
  /** Jumps the clock to a given hour (0-24, wrapping) - what the settings-panel time-of-day slider
   *  drives, so previewing the far side of a slow cycle doesn't mean actually waiting for it. */
  setTimeOfDay: (hours: number) => void;
  getTimeOfDay: () => number;
}

/** The world's seed - also what the workbench previews with until told otherwise. */
export const WORLD_SEED = 1338;

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

export async function createWorld(
  scene: Scene,
  content: WorldContent,
  onProgress?: (progress: WorldLoadProgress) => void,
): Promise<World> {
  const sunLighting = createSunLighting(scene);

  // Started first: each worker spends a few seconds building its own copy of the world (see
  // chunkBuild.worker.ts), which overlaps with this thread building its own below.
  let buildPool = createChunkBuildPool(WORLD_SEED, content);

  /** Says what comes next, and lets it be painted before the (synchronous) work starts. */
  const phase = async (text: string): Promise<void> => {
    onProgress?.({ phase: text, completed: 0, total: 0 });
    await nextPaint();
  };

  await phase("Shaping the world: continents, zones, rivers, roads and settlements");
  const { sampleTerrain, worldExtent, continents, areaBounds, areaNames, settlements, features, roads, settlementLayouts, compoundLayouts, areaBiomes } = createTerrainSampler(WORLD_SEED, content);

  const materialLibrary = await createMaterialLibrary(scene, WORLD_SEED, content, areaBiomes, sunLighting, (done, total) => {
    onProgress?.({ phase: "Baking material textures", completed: done, total });
  });

  // Bushes and boulders are drawn by the same field as the trees - thin instances all.
  await phase(`Growing ${content.treeKinds.length} kinds of tree, ${content.bushKinds.length} of bush and ${content.rockKinds.length} of boulder`);
  const trees = await createTreeField(
    scene,
    sunLighting.shadowGenerator,
    [...content.treeKinds, ...content.rockKinds, ...content.bushKinds],
    WORLD_SEED,
    materialLibrary.litShading,
    undefined,
    areaBiomes.map((biome, areaId) => treeTintRules(WORLD_SEED, areaId, biome)),
  );
  await phase(`Sowing ${content.grassKinds.length} kinds of grass`);
  const grass = createGrassField(scene, WORLD_SEED, materialLibrary.litShading, content.grassKinds);
  await phase(`Baking ${content.buildingMaterials.length} building materials`);
  const buildingMaterial = createBuildingMaterial(scene, materialLibrary.litShading, await bakeBuildingTextures(WORLD_SEED, content.buildingMaterials));
  await phase(`Planning the buildings of ${settlementLayouts.length} settlements and ${compoundLayouts.length} compounds`);
  const buildings = createBuildingRenderer(
    scene,
    [
      ...settlementLayouts.map((layout) => ({ key: `settlement:${layout.siteId}`, x: layout.x, z: layout.z, houses: layout.houses })),
      ...compoundLayouts.map((layout) => ({ key: `compound:${layout.featureId}`, x: layout.x, z: layout.z, houses: layout.buildings })),
    ],
    WORLD_SEED,
    buildingMaterial,
    sunLighting.shadowGenerator,
    DEFAULT_DRAW_DISTANCE,
    materialLibrary.setTerrainCuts,
  );
  await phase("Raising the sky");
  const sky = createSkyDome(scene);

  // Sent now that the textures are baked; queued behind each worker's own world building if it is
  // still busy with that, and ahead of any chunk it is asked to build.
  buildPool?.setGroundColors(materialLibrary.averageColors);

  if (buildPool) {
    await phase("Waiting for the terrain workers to build their own copy of the world");
    try {
      await buildPool.ready;
    } catch (error) {
      console.error("Chunk build workers failed to start; building terrain on the main thread.", error);
      buildPool.dispose();
      buildPool = null;
    }
  }

  const collision = createWorldCollision(trees, CHUNK_SIZE, buildings.cellarCuts);
  const chunkManager = createChunkManager({
    scene,
    buildContext: {
      sampleTerrain,
      materialBlender: materialLibrary.blender,
      scatterTrees: createTreeScatter(WORLD_SEED, content),
      scatterBushes: createBushScatter(WORLD_SEED, content, sampleTerrain),
      scatterRocks: createRockScatter(WORLD_SEED, content, sampleTerrain),
      treeCover: createTreeCover(WORLD_SEED, content),
      grassKinds: content.grassKinds,
      seed: WORLD_SEED,
      groundColors: materialLibrary.averageColors,
    },
    buildPool,
    materialLibrary,
    trees,
    grass,
    collision,
    shadowGenerator: sunLighting.shadowGenerator,
    chunkSize: CHUNK_SIZE,
    lodLevels: CHUNK_LOD_LEVELS,
    loadRadius: DEFAULT_DRAW_DISTANCE,
    unloadRadius: DEFAULT_DRAW_DISTANCE + UNLOAD_HYSTERESIS,
  });
  // loadInitial blocks for a few hundred ms, so give the browser a frame to actually paint the
  // "building terrain" message before it starts - otherwise the loading screen sits on the
  // previous phase for the whole thing.
  await phase("Building the terrain around the start: ground, trees, grass and collision");
  chunkManager.loadInitial(0, 0);
  await phase("Flooding the ocean");

  // Only needs to reach past the farthest fog - it follows the camera (see ocean.ts).
  const ocean = createOceanPlane(scene, sunLighting, sky, [materialLibrary.terrainMaterial, materialLibrary.floatingMaterial], { size: MAX_DRAW_DISTANCE * 2.5 });

  // Tracked so updateAtmosphere can turn a biome's fogStartFraction into an actual distance without
  // main.ts having to know or pass the draw distance itself every frame.
  let drawDistance = DEFAULT_DRAW_DISTANCE;

  const heightAt = (worldX: number, worldZ: number) => sampleTerrain(worldX, worldZ).height;
  const groundAt = (worldX: number, worldZ: number, feet: number) => buildings.floorAt(worldX, worldZ, feet) ?? heightAt(worldX, worldZ);
  const updateChunks = (playerX: number, playerZ: number, immediate?: boolean) => {
    chunkManager.update(playerX, playerZ, immediate);
    buildings.updateCollision(playerX, playerZ, collision.setExtra, collision.clearExtra);
  };
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
  const weather = createWeatherSystem(WORLD_SEED, content.weathers);
  let weatherNow: WeatherBlend = NO_WEATHER;
  const precipitation = createPrecipitation(scene, heightAt);
  // The light the rain and snow are seen by: the sky's fill and some of the sun's - so they are
  // bright by day, grey under a dark sky and dim at night.
  const fallLight = new Color3();
  const updateWeather = (deltaSeconds: number, areaWeights: AreaWeight[], playerX = 0, playerZ = 0) => {
    precipitation.setCentre(playerX, playerZ);
    weatherNow = weather.update(deltaSeconds, areaWeights);
    sunLighting.setWeather(weatherNow.sun, weatherNow.ambient);
    setWindStrength(weatherNow.wind);
    sunLighting.ambientColor.scaleToRef(sunLighting.ambientIntensity * 1.3, fallLight);
    fallLight.r = Math.min(1.1, fallLight.r + sunLighting.color.r * sunLighting.intensity * 0.5);
    fallLight.g = Math.min(1.1, fallLight.g + sunLighting.color.g * sunLighting.intensity * 0.5);
    fallLight.b = Math.min(1.1, fallLight.b + sunLighting.color.b * sunLighting.intensity * 0.5);
    precipitation.update(weatherNow.rain, weatherNow.snow, fallLight);
    ocean.setRain(weatherNow.rain);
  };
  const updateAtmosphere = (areaWeights: AreaWeight[]) => sky.update(areaWeights, drawDistance, sunLighting.getTimeHours(), sunLighting.direction, weatherNow);

  return {
    heightAt,
    groundAt,
    sampleTerrain,
    updateChunks,
    setDrawDistance,
    worldExtent,
    continents,
    areaBounds,
    areaNames,
    settlements,
    features,
    roads,
    settlementLayouts,
    materialLibrary,
    trees,
    grass,
    collision,
    attachCamera: sunLighting.attachCamera,
    setShadowsEnabled,
    setWireframe: materialLibrary.setWireframe,
    updateAtmosphere,
    updateDayNight: sunLighting.updateDayNight,
    updateWeather,
    weather,
    setTimeOfDay: sunLighting.setTimeHours,
    getTimeOfDay: sunLighting.getTimeHours,
  };
}
