import { Color3, Scene } from "@babylonjs/core";
import type { WaterRules } from "../sim/rules/waterRules";

/**
 * The view from under the surface (WATER.md): while the camera is under water the scene's fog turns
 * to the water's tint and closes in, the sky is hidden behind it, and a faint wash lies over the
 * screen. Applied just before each camera renders, after the sky has set its own fog for the frame,
 * and put back when the camera comes up.
 */
export interface UnderwaterLook {
  set: (under: boolean) => void;
  dispose: () => void;
}

export function createUnderwaterLook(scene: Scene, look: WaterRules["look"]): UnderwaterLook {
  const tint = new Color3(look.tint[0], look.tint[1], look.tint[2]);
  const wash = document.createElement("div");
  const [r, g, b] = look.tint.map((c) => Math.round(Math.min(1, c * 2.2) * 255));
  wash.style.cssText = `position: fixed; inset: 0; pointer-events: none; z-index: 5; opacity: 0; transition: opacity 0.25s; background: radial-gradient(ellipse at center, rgba(${r},${g},${b},0.18) 0%, rgba(${r},${g},${b},0.42) 100%);`;
  document.body.appendChild(wash);
  let under = false;
  let saved: { mode: number; density: number } | null = null;
  const observer = scene.onBeforeCameraRenderObservable.add(() => {
    if (!under) return;
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = look.density;
    scene.fogColor.copyFrom(tint);
  });
  return {
    set(next) {
      if (next === under) return;
      under = next;
      wash.style.opacity = next ? "1" : "0";
      if (next) saved = { mode: scene.fogMode, density: scene.fogDensity };
      else if (saved) {
        scene.fogMode = saved.mode;
        scene.fogDensity = saved.density;
        saved = null;
      }
    },
    dispose() {
      scene.onBeforeCameraRenderObservable.remove(observer);
      wash.remove();
    },
  };
}
