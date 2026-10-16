import type { ArcRotateCamera, Engine, Scene } from "@babylonjs/core";
import { createScene } from "../core/engine";
import { createWorldData } from "../world/worldData";
import { createChunkBuildPool, createWorld, MAX_DRAW_DISTANCE, MIN_DRAW_DISTANCE, nextPaint, type World } from "../world/world";
import type { WorldContent } from "../world/content/worldContent";
import type { DimensionWorld } from "../sim/dimension";
import { createCharacter, type Character } from "../player/characterController";
import { createCameraCollision, createThirdPersonCamera } from "../player/thirdPersonCamera";
import { createSpectatorCamera, type SpectatorCamera } from "../player/spectatorCamera";
import { createDebugMap, type DebugMap } from "../debug/debugMap";
import { createSettingsPanel, type SettingsPanel } from "../debug/settingsPanel";
import { createPlaceLabels, type PlaceLabels } from "../ui/placeLabels";
import { createTextureBrowser, type TextureBrowser } from "../debug/textureBrowser";
import type { ViewSnapshot } from "../debug/positionPanel";
import { createLastView, type LastView } from "../debug/lastView";
import { createStatsPanel } from "../debug/statsPanel";
import { createCollisionPanel, type CollisionPanel } from "../debug/collisionPanel";
import { createMemoryPanel } from "../debug/memoryPanel";
import type { PlayerLights } from "../world/lighting/playerLights";

/** What the settings panel sets that outlasts a dimension: the next one starts with them. */
export interface ViewSettings {
  drawDistance: number;
  trees: boolean;
  grass: boolean;
  shadows: boolean;
  wireframe: boolean;
  /** The hour, so travelling does not jump the clock. */
  timeOfDay: number;
}

export interface DimensionViewOptions {
  engine: Engine;
  canvas: HTMLCanvasElement;
  content: WorldContent;
  seed: number;
  /** Where the player arrives. */
  arrival: { x: number; z: number };
  settings: ViewSettings;
  onProgress: (phase: string, completed: number, total: number) => void;
  /** Puts the player on the ground at a point - through the server. */
  teleport: (x: number, z: number) => void;
  /** Asks the server to go to another dimension (the settings panel's choice). */
  travel: (dimension: string) => void;
}

/**
 * One dimension as the page draws it (see DIMENSIONS.md): its own Babylon scene, its world built
 * from its content and seed, the player's capsule and cameras in it, and the debug panels that show
 * it. Travelling disposes the view and builds the next one; what lasts the whole page - the engine,
 * the server, music, the HUD's labels - is main.ts's.
 */
export interface DimensionView {
  readonly scene: Scene;
  readonly world: World;
  /** What the server takes rather than generating it again (see sim/dimension.ts). */
  readonly shared: DimensionWorld;
  readonly character: Character;
  readonly camera: ArcRotateCamera;
  readonly spectator: SpectatorCamera;
  readonly playerLights: PlayerLights;
  readonly cameraCollision: { update: (deltaSeconds: number) => void };
  readonly debugMap: DebugMap;
  readonly placeLabels: PlaceLabels;
  readonly textureBrowser: TextureBrowser;
  readonly collisionPanel: CollisionPanel;
  readonly lastView: LastView;
  setSpectating: (on: boolean) => void;
  /** Moves the player - and, while flying, the spectator camera with it, as high over the new
   *  ground as it was over the old. */
  teleport: (x: number, z: number) => void;
  /** Teleports, and turns the camera as a view snapshot says. */
  gotoView: (view: Partial<ViewSnapshot> & { x: number; z: number }) => void;
  dispose: () => void;
}

// "14:06" rather than a raw "14.1" - the slider steps in hundredths of an hour (step 0.1 below is
// six minutes), which reads as noise unless it is put back into clock form.
function formatClockHours(hours: number): string {
  const wrapped = ((hours % 24) + 24) % 24;
  const h = Math.floor(wrapped);
  const m = Math.floor((wrapped - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Builds a dimension's scene and world, behind the loading screen `onProgress` writes to. */
export async function createDimensionView(options: DimensionViewOptions): Promise<DimensionView> {
  const { engine, canvas, content, seed, arrival, settings, onProgress } = options;
  const scene = createScene(engine);

  // Started first: each terrain worker spends a few seconds building its own copy of the world,
  // which overlaps with this thread building its own below.
  const chunkBuildPool = createChunkBuildPool(seed, content);
  onProgress(`${content.dimension.name}: shaping the land, zones, rivers, roads and settlements`, 0, 0);
  // A paint for that line first - or a moment's wait, in a background tab, which never paints.
  await nextPaint();
  const worldData = createWorldData(seed, content);
  // World creation is async because material textures are baked across a worker pool (see
  // textureBakePool.ts), which is the bulk of startup time unless the texture cache already has them.
  const world = await createWorld(scene, worldData, ({ phase, completed, total }) => onProgress(phase, completed, total), chunkBuildPool, arrival);

  onProgress("Placing the player", 0, 0);
  const character = createCharacter(scene, { x: arrival.x, y: world.heightAt(arrival.x, arrival.z), z: arrival.z });
  const playerLights = world.lightMover(character.mesh);
  const camera = createThirdPersonCamera(scene, canvas, character.mesh);
  const cameraCollision = createCameraCollision(camera, world.collision.world);
  // Camera near/far and the shadow generator's own frustum both need the real camera, which does
  // not exist until here - see World.attachCamera.
  world.attachCamera(camera);
  // A camera to fly about in, with no body - the settings panel's "Spectator" switches to it and back.
  const spectator = createSpectatorCamera(scene, canvas);
  function setSpectating(on: boolean): void {
    if (on === spectator.active) return;
    if (on) spectator.enter(camera);
    else spectator.leave(camera);
    world.attachCamera(on ? spectator.camera : camera);
  }
  function teleport(x: number, z: number): void {
    if (spectator.active) {
      const from = spectator.camera.position;
      const above = from.y - world.heightAt(from.x, from.z);
      spectator.moveTo(x, world.heightAt(x, z) + Math.max(2, above), z);
    }
    options.teleport(x, z);
  }
  function gotoView({ x, z, alpha, beta, radius }: Partial<ViewSnapshot> & { x: number; z: number }): void {
    teleport(x, z);
    if (alpha !== undefined) camera.alpha = alpha;
    if (beta !== undefined) camera.beta = beta;
    if (radius !== undefined) camera.radius = radius;
  }

  // What the last dimension's panel was set to.
  world.setDrawDistance(settings.drawDistance);
  world.trees.setVisible(settings.trees);
  world.grass.setVisible(settings.grass);
  world.setShadowsEnabled(settings.shadows);
  world.setWireframe(settings.wireframe);
  world.setTimeOfDay(settings.timeOfDay);

  const debugMap = createDebugMap(world.sampleTerrain, world.worldExtent, world.materialLibrary, world.areaBounds, world.areaNames, world.settlements, world.features, world.roads, content.dimension.links, (x, z) => teleport(x, z), options.travel);
  const settingsPanel: SettingsPanel = createSettingsPanel({
    min: MIN_DRAW_DISTANCE,
    max: MAX_DRAW_DISTANCE,
    initial: settings.drawDistance,
    onChange: (value) => {
      settings.drawDistance = value;
      world.setDrawDistance(value);
    },
    toggles: [
      { label: "Trees", initial: settings.trees, onChange: (on) => world.trees.setVisible((settings.trees = on)) },
      { label: "Grass", initial: settings.grass, onChange: (on) => world.grass.setVisible((settings.grass = on)) },
      { label: "Shadows", initial: settings.shadows, onChange: (on) => world.setShadowsEnabled((settings.shadows = on)) },
      { label: "Wireframe", initial: settings.wireframe, onChange: (on) => world.setWireframe((settings.wireframe = on)) },
      {
        label: "Spectator",
        initial: false,
        onChange: (on) => {
          setSpectating(on);
          // Off the checkbox, or Space - up, while flying - would tick it again.
          (document.activeElement as HTMLElement | null)?.blur();
          canvas.focus();
        },
      },
    ],
    sliders: [
      {
        label: "Time",
        min: 0,
        max: 24,
        step: 0.1,
        initial: world.getTimeOfDay(),
        format: formatClockHours,
        onChange: (hours) => world.setTimeOfDay(hours),
      },
    ],
    selects: [
      {
        // Each zone's own weather, or one held everywhere to look at - blending in over a few seconds.
        label: "Weather",
        options: [{ value: "", label: "Natural" }, ...world.weather.weathers.map((w) => ({ value: w.id, label: w.name }))],
        initial: "",
        onChange: (id) => world.weather.force(id === "" ? null : id),
      },
      {
        // Debug travel (see DIMENSIONS.md): the server moves the player, and this view is rebuilt.
        label: "Dimension",
        options: content.dimensions.map((d) => ({ value: d.id, label: d.name })),
        initial: content.dimension.id,
        onChange: (id) => {
          (document.activeElement as HTMLElement | null)?.blur();
          options.travel(id);
        },
      },
    ],
  });

  const placeLabels = createPlaceLabels(scene, world.labels);
  const textureBrowser = createTextureBrowser(world.materialLibrary);
  const statsPanel = createStatsPanel(scene, engine);
  const collisionPanel = createCollisionPanel(scene, world.collision, statsPanel);
  createMemoryPanel(engine, scene, statsPanel);
  // Each config's and dimension's own: a spot in one world is open sea in another.
  const lastView = createLastView(content.config, content.dimension.start ? null : content.dimension.id);

  return {
    scene,
    world,
    shared: { world: worldData, treeHulls: world.trees.hulls, buildingModels: world.buildingModels },
    character,
    camera,
    spectator,
    playerLights,
    cameraCollision,
    debugMap,
    placeLabels,
    textureBrowser,
    collisionPanel,
    lastView,
    setSpectating,
    teleport,
    gotoView,
    dispose() {
      // Out of the scene first - workers, chunks still coming - then the scene, which takes every
      // mesh, material, texture, camera and observer in it.
      world.dispose();
      character.dispose();
      spectator.dispose();
      debugMap.dispose();
      settingsPanel.dispose();
      placeLabels.dispose();
      textureBrowser.dispose();
      statsPanel.dispose();
      scene.dispose();
    },
  };
}
