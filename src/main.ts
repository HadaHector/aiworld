import { createEngine, createScene } from "./core/engine";
import { createWorld, DEFAULT_DRAW_DISTANCE, MIN_DRAW_DISTANCE, MAX_DRAW_DISTANCE } from "./world/world";
import { createCharacter } from "./player/characterController";
import { createIndoorCamera, createThirdPersonCamera } from "./player/thirdPersonCamera";
import { createSpectatorCamera } from "./player/spectatorCamera";
import { createDebugMap } from "./debug/debugMap";
import { createSettingsPanel } from "./debug/settingsPanel";
import { createZoneLabel } from "./debug/zoneLabel";
import { createTextureBrowser } from "./debug/textureBrowser";
import { createPositionPanel, type ViewSnapshot } from "./debug/positionPanel";
import { createLastView } from "./debug/lastView";
import { createStatsPanel } from "./debug/statsPanel";
import { createCollisionPanel } from "./debug/collisionPanel";
import { createLoadingScreen } from "./ui/loadingScreen";
import { loadContent } from "./world/content/loadContent";
import { ContentError, formatIssue } from "./world/content/contentReader";
import type { WorldContent } from "./world/content/worldContent";

const canvas = document.getElementById("renderCanvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Expected a #renderCanvas canvas element in index.html");
}

const loadingScreen = createLoadingScreen();

// Everything the world is generated from that is content rather than code - biomes, materials,
// plants - comes from the packs in public/packs. A broken pack stops here, with every problem listed
// on the loading screen, rather than halfway through generating a world from it.
let content: WorldContent;
try {
  loadingScreen.update("Loading content packs", 0, 0);
  content = await loadContent();
} catch (error) {
  loadingScreen.fail(
    "The content packs could not be loaded",
    error instanceof ContentError ? error.issues.map(formatIssue) : [String(error)],
  );
  throw error;
}

const engine = createEngine(canvas);
const scene = createScene(engine);

// World creation is async because material textures are baked across a worker pool (see
// textureBakePool.ts), which is the bulk of startup time unless the texture cache already has them.
const world = await createWorld(scene, content, ({ phase, completed, total }) => {
  loadingScreen.update(phase, completed, total);
});

loadingScreen.update("Placing the player", 0, 0);
const character = createCharacter(scene, world.collision, world.heightAt);
const camera = createThirdPersonCamera(scene, canvas, character.mesh);
const indoorCamera = createIndoorCamera(camera, () => world.indoors(character.mesh.position.x, character.mesh.position.z, character.mesh.position.y - 0.9));
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
/**
 * Moves the player - and, while flying, the spectator camera with it, as high over the new ground
 * as it was over the old.
 */
function teleport(x: number, z: number): void {
  if (spectator.active) {
    const from = spectator.camera.position;
    const above = from.y - world.heightAt(from.x, from.z);
    spectator.moveTo(x, world.heightAt(x, z) + Math.max(2, above), z);
  }
  character.teleport(x, z);
}

const debugMap = createDebugMap(world.sampleTerrain, world.worldExtent, world.continents, world.materialLibrary, world.areaBounds, world.areaNames, world.settlements, world.features, world.roads, (worldX, worldZ) => {
  teleport(worldX, worldZ);
});

// "14:06" rather than a raw "14.1" - the slider steps in hundredths of an hour (step 0.1 below is
// six minutes), which reads as noise unless it is put back into clock form.
function formatClockHours(hours: number): string {
  const wrapped = ((hours % 24) + 24) % 24;
  const h = Math.floor(wrapped);
  const m = Math.floor((wrapped - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

createSettingsPanel({
  min: MIN_DRAW_DISTANCE,
  max: MAX_DRAW_DISTANCE,
  initial: DEFAULT_DRAW_DISTANCE,
  onChange: (value) => world.setDrawDistance(value),
  toggles: [
    { label: "Trees", initial: true, onChange: (on) => world.trees.setVisible(on) },
    { label: "Grass", initial: true, onChange: (on) => world.grass.setVisible(on) },
    { label: "Shadows", initial: true, onChange: (on) => world.setShadowsEnabled(on) },
    { label: "Wireframe", initial: false, onChange: (on) => world.setWireframe(on) },
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
  ],
});

const zoneLabel = createZoneLabel();
const textureBrowser = createTextureBrowser(world.materialLibrary);
const statsPanel = createStatsPanel(scene, engine);
const collisionPanel = createCollisionPanel(scene, world.collision, statsPanel);

/**
 * A deliberate, permanent debug surface. `goto` restores a view captured by the position panel's
 * copy button, which is what makes a reported location reproducible rather than a set of numbers
 * someone has to translate by hand; the rest is here so the console can poke at the live world
 * without the app having to be re-instrumented to investigate anything.
 */
function gotoView({ x, z, alpha, beta, radius }: Partial<ViewSnapshot> & { x: number; z: number }): void {
  teleport(x, z);
  if (alpha !== undefined) camera.alpha = alpha;
  if (beta !== undefined) camera.beta = beta;
  if (radius !== undefined) camera.radius = radius;
}

const positionPanel = createPositionPanel(gotoView);

// Back where the page was last left, so a reload after a change shows the same spot.
const lastView = createLastView();
const resumeView = lastView.restore();
if (resumeView) gotoView(resumeView);

/**
 * `goto`, then force every chunk around the new position to build right away instead of
 * streaming in over many frames - what a console session testing a spot always wants and `goto`
 * alone never gave it, so every session was hand-writing the same `for` loop calling
 * `updateChunks` a few thousand times afterward. `updateChunks` is already a no-op once its
 * queue is empty (see chunkManager.ts's `takeNearestQueued`), so an iteration count generous
 * enough for the worst case (a couple thousand chunks at the top of the draw-distance slider)
 * costs nothing extra once the ordinary case (a few hundred) has already drained.
 */
function gotoLoaded(view: Partial<ViewSnapshot> & { x: number; z: number }, iterations = 6000): void {
  gotoView(view);
  for (let i = 0; i < iterations; i++) {
    world.updateChunks(view.x, view.z, true);
  }
}

(window as unknown as { __aiworld: unknown }).__aiworld = {
  goto: gotoView,
  gotoLoaded,
  /** Goes to feature `id` (world.features): a settlement's square, or in front of a quarry looking
   *  into it - its floor, its face. */
  gotoFeature(id: number): void {
    const feature = world.features[id];
    if (!feature) return;
    const q = feature.quarry;
    if (!q) {
      gotoLoaded({ x: feature.x, z: feature.z, beta: 1.1, radius: 60 });
      return;
    }
    const x = q.x + q.ax * (q.halfLength + 25);
    const z = q.z + q.az * (q.halfLength + 25);
    // The camera's alpha is measured from +x; it sits behind the character, so it looks along -dir.
    gotoLoaded({ x, z, alpha: Math.atan2(q.az, q.ax), beta: 1.25, radius: 30 });
  },
  world,
  character,
  camera,
  spectator,
  /** The collision profiler's last half second (see debug/collisionPanel.ts). */
  collisionProfile: () => collisionPanel.last,
  scene,
  engine,
};

window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "m") {
    debugMap.toggle();
  }
  if (e.key.toLowerCase() === "t") {
    textureBrowser.toggle();
  }
});

scene.onBeforeRenderObservable.add(() => {
  const deltaSeconds = engine.getDeltaTime() / 1000;
  // The world streams, and its weather and light follow, wherever is being looked from: the player,
  // or the spectator camera while it flies.
  if (!spectator.active) {
    const started = performance.now();
    character.update(deltaSeconds, camera);
    collisionPanel.addPlayerMs(performance.now() - started);
    indoorCamera.update();
  }
  const focus = spectator.active ? spectator.camera.position : character.mesh.position;
  world.updateChunks(focus.x, focus.z);
  debugMap.updateMarker(focus.x, focus.z, camera.alpha);
  const here = world.sampleTerrain(focus.x, focus.z);
  const zoneName = world.areaNames.get(here.primaryAreaId) ?? "Uncharted";
  zoneLabel.update(zoneName, here.primaryBiome.name, world.weather.describe(here.primaryAreaId));
  positionPanel.update(character.mesh.position, camera, zoneName, here.primaryBiome.name);
  lastView.remember(character.mesh.position, camera);
  // Day-night first: it owns the clock, and updateAtmosphere reads that clock's current value
  // (world.ts's updateAtmosphere calls sunLighting.getTimeHours() itself) - calling it after this
  // is what makes that read this frame's time rather than last frame's.
  world.updateWeather(deltaSeconds, here.areaWeights, focus.x, focus.z);
  world.updateDayNight(deltaSeconds, here.areaWeights);
  world.updateAtmosphere(here.areaWeights);
});

// Render one frame explicitly before revealing the world, so the overlay never fades to a blank
// canvas. Deliberately not hooked to onAfterRenderObservable/the render loop: those are driven by
// requestAnimationFrame, which the browser pauses in a background tab - loading the page in one
// would otherwise leave the loading screen up indefinitely.
loadingScreen.update("Compiling shaders and drawing the first frame", 0, 0);
// A paint for that line first - or a moment's wait, in a background tab, which never paints.
await new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  setTimeout(resolve, 60);
});
scene.render();
loadingScreen.hide();

engine.runRenderLoop(() => {
  scene.render();
});

window.addEventListener("resize", () => {
  engine.resize();
});
