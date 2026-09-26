import type { ArcRotateCamera, Vector3 } from "@babylonjs/core";
import type { ViewSnapshot } from "./positionPanel";

const STORAGE_KEY = "aiworld.lastView";
/** How often the view is written down - often enough that a reload lands where you were, rarely
 *  enough that walking around is not a stream of storage writes. */
const SAVE_INTERVAL_MS = 1000;

export interface LastView {
  /** The view the page was last left at, if one was saved and still reads as one. */
  restore: () => ViewSnapshot | null;
  /** Call every frame; saves at most once per SAVE_INTERVAL_MS. */
  remember: (position: Vector3, camera: ArcRotateCamera) => void;
}

/**
 * Keeps the last view in localStorage, so a reload - after every content or code change - comes
 * back to the spot being looked at instead of the world's origin. Storage can be missing or throw
 * (private windows, blocked site data); the page then simply starts at the origin as before.
 */
export function createLastView(): LastView {
  let lastSave = 0;
  return {
    restore() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const view = JSON.parse(raw) as Partial<ViewSnapshot>;
        const keys = ["x", "z", "alpha", "beta", "radius"] as const;
        return keys.every((key) => typeof view[key] === "number" && Number.isFinite(view[key])) ? (view as ViewSnapshot) : null;
      } catch {
        return null;
      }
    },
    remember(position, camera) {
      const now = performance.now();
      if (now - lastSave < SAVE_INTERVAL_MS) return;
      lastSave = now;
      const view: ViewSnapshot = { x: position.x, z: position.z, alpha: camera.alpha, beta: camera.beta, radius: camera.radius };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
      } catch {
        // No storage here - nothing to remember with.
      }
    },
  };
}
