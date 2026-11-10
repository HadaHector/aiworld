import { Engine, Scene, Color4, Color3 } from "@babylonjs/core";

export function createEngine(canvas: HTMLCanvasElement): Engine {
  // doNotHandleContextLost: otherwise Babylon keeps a CPU copy of every raw texture it uploads, to
  // upload again should the GPU context be lost - over a gigabyte of baked atlases in the full world,
  // which on top of everything else ran the page out of heap. A lost context now needs a reload.
  return new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, doNotHandleContextLost: true });
}

export function createScene(engine: Engine): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.53, 0.75, 0.92, 1);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  // fogStart/fogEnd are set from the draw distance and fogColor from the player's own zone - see
  // world.ts's setDrawDistance and sky/skyDome.ts's update. These are just a sane initial state for
  // the one frame between scene creation and the world's first update.
  scene.fogStart = 300.0;
  scene.fogEnd = 1500;
  scene.fogColor = new Color3(0.9, 0.9, 0.85);
  return scene;
}
