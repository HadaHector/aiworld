import { createEngine, createScene } from "./core/engine";
import { createWorld, DEFAULT_DRAW_DISTANCE, MIN_DRAW_DISTANCE, MAX_DRAW_DISTANCE } from "./world/world";
import { createCharacter } from "./player/characterController";
import { createThirdPersonCamera } from "./player/thirdPersonCamera";
import { createDebugMap } from "./debug/debugMap";
import { createSettingsPanel } from "./debug/settingsPanel";
import { createZoneLabel } from "./debug/zoneLabel";
import { createTextureBrowser } from "./debug/textureBrowser";
import { createPositionPanel, type ViewSnapshot } from "./debug/positionPanel";
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
const debugMap = createDebugMap(world.sampleTerrain, world.worldExtent, world.continents, world.materialLibrary, world.areaBounds, (worldX, worldZ) => {
  character.teleport(worldX, worldZ);
});

createSettingsPanel({
  min: MIN_DRAW_DISTANCE,
  max: MAX_DRAW_DISTANCE,
  initial: DEFAULT_DRAW_DISTANCE,
  onChange: (value) => world.setDrawDistance(value),
});

const zoneLabel = createZoneLabel();
const textureBrowser = createTextureBrowser(world.materialLibrary);
const positionPanel = createPositionPanel();

/**
 * A deliberate, permanent debug surface. `goto` restores a view captured by the position panel's
 * copy button, which is what makes a reported location reproducible rather than a set of numbers
 * someone has to translate by hand; the rest is here so the console can poke at the live world
 * without the app having to be re-instrumented to investigate anything.
 */
(window as unknown as { __aiworld: unknown }).__aiworld = {
  goto({ x, z, alpha, beta, radius }: Partial<ViewSnapshot> & { x: number; z: number }): void {
    character.teleport(x, z);
    if (alpha !== undefined) camera.alpha = alpha;
    if (beta !== undefined) camera.beta = beta;
    if (radius !== undefined) camera.radius = radius;
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
  character.update(engine.getDeltaTime() / 1000, camera);
  world.updateChunks(character.mesh.position.x, character.mesh.position.z);
  debugMap.updateMarker(character.mesh.position.x, character.mesh.position.z, camera.alpha);
  const biomeName = world.sampleTerrain(character.mesh.position.x, character.mesh.position.z).primaryBiome.name;
  zoneLabel.update(biomeName);
  positionPanel.update(character.mesh.position, camera, biomeName);
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
