import { Engine, Scene, Color4, Color3 } from "@babylonjs/core";

export function createEngine(canvas: HTMLCanvasElement): Engine {
  return new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
}

export function createScene(engine: Engine): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.53, 0.75, 0.92, 1);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogStart = 300.0;
  scene.fogEnd = 1500;
  scene.fogColor = new Color3(0.9,0.9,0.85);
  return scene;
}
