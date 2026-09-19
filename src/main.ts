import { createEngine, createScene } from "./core/engine";
import { createWorld, DEFAULT_DRAW_DISTANCE, MIN_DRAW_DISTANCE, MAX_DRAW_DISTANCE } from "./world/world";
import { createCharacter } from "./player/characterController";
import { createThirdPersonCamera } from "./player/thirdPersonCamera";
import { createDebugMap } from "./debug/debugMap";
import { createSettingsPanel } from "./debug/settingsPanel";
import { createZoneLabel } from "./debug/zoneLabel";
import { createTextureBrowser } from "./debug/textureBrowser";
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
const debugMap = createDebugMap(world.sampleTerrain, world.worldExtent, world.continents, world.materialLibrary, (worldX, worldZ) => {
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
  zoneLabel.update(world.sampleTerrain(character.mesh.position.x, character.mesh.position.z).primaryBiome.name);
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
