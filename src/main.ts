import { createEngine, createScene } from "./core/engine";
import { createWorld, DEFAULT_DRAW_DISTANCE, MIN_DRAW_DISTANCE, MAX_DRAW_DISTANCE } from "./world/world";
import { createCharacter } from "./player/characterController";
import { createThirdPersonCamera } from "./player/thirdPersonCamera";
import { createDebugMap } from "./debug/debugMap";
import { createSettingsPanel } from "./debug/settingsPanel";
import { createZoneLabel } from "./debug/zoneLabel";
import { createTextureBrowser } from "./debug/textureBrowser";

const canvas = document.getElementById("renderCanvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Expected a #renderCanvas canvas element in index.html");
}

const engine = createEngine(canvas);
const scene = createScene(engine);

const world = createWorld(scene);
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

engine.runRenderLoop(() => {
  scene.render();
});

window.addEventListener("resize", () => {
  engine.resize();
});
