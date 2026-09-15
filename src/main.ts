import { createEngine, createScene } from "./core/engine";
import { createWorld } from "./world/world";
import { createCharacter } from "./player/characterController";
import { createThirdPersonCamera } from "./player/thirdPersonCamera";

const canvas = document.getElementById("renderCanvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Expected a #renderCanvas canvas element in index.html");
}

const engine = createEngine(canvas);
const scene = createScene(engine);

const world = createWorld(scene);
const character = createCharacter(scene, world.heightAt);
const camera = createThirdPersonCamera(scene, canvas, character.mesh);

scene.onBeforeRenderObservable.add(() => {
  character.update(engine.getDeltaTime() / 1000, camera);
});

engine.runRenderLoop(() => {
  scene.render();
});

window.addEventListener("resize", () => {
  engine.resize();
});
