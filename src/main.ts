import { createEngine, createScene } from "./core/engine";
import { createWorld, DEFAULT_DRAW_DISTANCE, MIN_DRAW_DISTANCE, MAX_DRAW_DISTANCE } from "./world/world";
import { createCharacter } from "./player/characterController";
import { createThirdPersonCamera } from "./player/thirdPersonCamera";
import { createDebugMap } from "./debug/debugMap";
import { createSettingsPanel } from "./debug/settingsPanel";
import { createZoneLabel } from "./debug/zoneLabel";
import { createTextureBrowser } from "./debug/textureBrowser";
import { createPositionPanel, type ViewSnapshot } from "./debug/positionPanel";
import { createStatsPanel } from "./debug/statsPanel";
import { createLoadingScreen } from "./ui/loadingScreen";

const canvas = document.getElementById("renderCanvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Expected a #renderCanvas canvas element in index.html");
}

const loadingScreen = createLoadingScreen();

const engine = createEngine(canvas);
const scene = createScene(engine);

// World creation is async because material textures are baked across a worker pool (see
// textureBakePool.ts), which is the bulk of startup time.
const world = await createWorld(scene, ({ phase, completed, total }) => {
  loadingScreen.update(phase, completed, total);
});

const character = createCharacter(scene, world.heightAt);
const camera = createThirdPersonCamera(scene, canvas, character.mesh);
// Camera near/far and the shadow generator's own frustum both need the real camera, which does
// not exist until here - see World.attachCamera.
world.attachCamera(camera);
const debugMap = createDebugMap(world.sampleTerrain, world.worldExtent, world.continents, world.materialLibrary, world.areaBounds, world.areaNames, world.settlements, world.roads, (worldX, worldZ) => {
  character.teleport(worldX, worldZ);
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
    { label: "Shadows", initial: true, onChange: (on) => world.setShadowsEnabled(on) },
    { label: "Wireframe", initial: false, onChange: (on) => world.setWireframe(on) },
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
});

const zoneLabel = createZoneLabel();
const textureBrowser = createTextureBrowser(world.materialLibrary);
const positionPanel = createPositionPanel();
createStatsPanel(scene, engine);

/**
 * A deliberate, permanent debug surface. `goto` restores a view captured by the position panel's
 * copy button, which is what makes a reported location reproducible rather than a set of numbers
 * someone has to translate by hand; the rest is here so the console can poke at the live world
 * without the app having to be re-instrumented to investigate anything.
 */
function gotoView({ x, z, alpha, beta, radius }: Partial<ViewSnapshot> & { x: number; z: number }): void {
  character.teleport(x, z);
  if (alpha !== undefined) camera.alpha = alpha;
  if (beta !== undefined) camera.beta = beta;
  if (radius !== undefined) camera.radius = radius;
}

(window as unknown as { __aiworld: unknown }).__aiworld = {
  goto: gotoView,
  /**
   * `goto`, then force every chunk around the new position to build right away instead of
   * streaming in over many frames - what a console session testing a spot always wants and `goto`
   * alone never gave it, so every session was hand-writing the same `for` loop calling
   * `updateChunks` a few thousand times afterward. `updateChunks` is already a no-op once its
   * queue is empty (see chunkManager.ts's `takeNearestQueued`), so an iteration count generous
   * enough for the worst case (a couple thousand chunks at the top of the draw-distance slider)
   * costs nothing extra once the ordinary case (a few hundred) has already drained.
   */
  gotoLoaded(view: Partial<ViewSnapshot> & { x: number; z: number }, iterations = 6000): void {
    gotoView(view);
    for (let i = 0; i < iterations; i++) {
      world.updateChunks(view.x, view.z, true);
    }
  },
  world,
  character,
  camera,
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
  character.update(deltaSeconds, camera);
  world.updateChunks(character.mesh.position.x, character.mesh.position.z);
  debugMap.updateMarker(character.mesh.position.x, character.mesh.position.z, camera.alpha);
  const here = world.sampleTerrain(character.mesh.position.x, character.mesh.position.z);
  const zoneName = world.areaNames.get(here.primaryAreaId) ?? "Uncharted";
  zoneLabel.update(zoneName, here.primaryBiome.name);
  positionPanel.update(character.mesh.position, camera, zoneName, here.primaryBiome.name);
  // Day-night first: it owns the clock, and updateAtmosphere reads that clock's current value
  // (world.ts's updateAtmosphere calls sunLighting.getTimeHours() itself) - calling it after this
  // is what makes that read this frame's time rather than last frame's.
  world.updateDayNight(deltaSeconds, here.areaWeights);
  world.updateAtmosphere(here.areaWeights);
});

// Render one frame explicitly before revealing the world, so the overlay never fades to a blank
// canvas. Deliberately not hooked to onAfterRenderObservable/the render loop: those are driven by
// requestAnimationFrame, which the browser pauses in a background tab - loading the page in one
// would otherwise leave the loading screen up indefinitely.
scene.render();
loadingScreen.hide();

engine.runRenderLoop(() => {
  scene.render();
});

window.addEventListener("resize", () => {
  engine.resize();
});
