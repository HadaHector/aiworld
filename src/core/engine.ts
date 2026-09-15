import { Engine, Scene, Color4 } from "@babylonjs/core";

export function createEngine(canvas: HTMLCanvasElement): Engine {
  return new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
}

export function createScene(engine: Engine): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.53, 0.75, 0.92, 1);
  return scene;
}
