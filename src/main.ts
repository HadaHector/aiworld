import { createEngine, createScene } from "./core/engine";
import { createWorld } from "./world/world";
import { createCharacter } from "./player/characterController";
import { createThirdPersonCamera } from "./player/thirdPersonCamera";
import { createDebugMap } from "./debug/debugMap";

const canvas = document.getElementById("renderCanvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Expected a #renderCanvas canvas element in index.html");
}

const engine = createEngine(canvas);
const scene = createScene(engine);

const world = createWorld(scene);
const character = createCharacter(scene, world.heightAt);
const camera = createThirdPersonCamera(scene, canvas, character.mesh);
const debugMap = createDebugMap(world.sampleTerrain, world.worldExtent);

window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "m") {
    debugMap.toggle();
  }
});

scene.onBeforeRenderObservable.add(() => {
  character.update(engine.getDeltaTime() / 1000, camera);
  world.updateChunks(character.mesh.position.x, character.mesh.position.z);
  debugMap.updateMarker(character.mesh.position.x, character.mesh.position.z);
});

engine.runRenderLoop(() => {
  scene.render();
});

window.addEventListener("resize", () => {
  engine.resize();
});
