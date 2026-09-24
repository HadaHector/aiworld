import type { Engine, Scene } from "@babylonjs/core";

const REFRESH_MS = 250;

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}k`;
  return String(count);
}

/**
 * FPS and how many vertices were drawn last frame.
 *
 * The vertex count is Babylon's active-index counter: one per triangle corner submitted, so it is
 * vertex-shader work rather than unique vertices, and it includes thin instances (trees). It counts
 * every pass in the frame, so it is split into the main view and everything rendered before the
 * main draw phase starts - in practice the shadow map's cascades, which redraw terrain and trees
 * once per cascade.
 */
export function createStatsPanel(scene: Scene, engine: Engine): void {
  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed; top: 124px; left: 16px; z-index: 900;
    background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;
    padding: 6px 10px; font-family: sans-serif; font-size: 11px; color: #eee;
    white-space: nowrap; font-variant-numeric: tabular-nums;
  `;
  container.textContent = "-";
  document.body.appendChild(container);

  let beforeMain = 0;
  let mainDrawn = 0;
  let totalDrawn = 0;
  scene.onBeforeDrawPhaseObservable.add(() => {
    beforeMain = scene.getActiveIndices();
  });
  scene.onAfterDrawPhaseObservable.add(() => {
    totalDrawn = scene.getActiveIndices();
    mainDrawn = totalDrawn - beforeMain;
  });

  let lastRefresh = 0;
  scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    if (now - lastRefresh < REFRESH_MS) return;
    lastRefresh = now;
    container.textContent =
      `${engine.getFps().toFixed(0)} fps · ${formatCount(totalDrawn)} verts drawn ` +
      `(view ${formatCount(mainDrawn)}, shadows ${formatCount(totalDrawn - mainDrawn)})`;
  });
}
