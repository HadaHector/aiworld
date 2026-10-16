import type { Engine, Scene } from "@babylonjs/core";
import { createTextureCacheLabel } from "./textureCacheLabel";

const REFRESH_MS = 250;

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}k`;
  return String(count);
}

/**
 * FPS and how many vertices were drawn last frame - and, behind a button, sections of more detail
 * other panels add to it (see addSection).
 *
 * The vertex count is Babylon's active-index counter: one per triangle corner submitted, so it is
 * vertex-shader work rather than unique vertices, and it includes thin instances (trees). It counts
 * every pass in the frame, so it is split into the main view and everything rendered before the
 * main draw phase starts - in practice the shadow map's cascades, which redraw terrain and trees
 * once per cascade.
 *
 * Under it, how much the texture cache keeps on disk (textureCacheLabel.ts).
 */
export interface StatsPanel {
  /**
   * A section of more detail, under a button of its own that shows and hides it (hidden to begin
   * with). `onToggle` hears whether it is shown.
   */
  addSection: (label: string, content: HTMLElement, onToggle?: (shown: boolean) => void) => void;
  /** Takes it off the page, for the next dimension's (see DIMENSIONS.md). */
  dispose: () => void;
}

export function createStatsPanel(scene: Scene, engine: Engine): StatsPanel {
  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed; top: 124px; left: 16px; z-index: 900;
    background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;
    padding: 6px 10px; font-family: sans-serif; font-size: 11px; color: #eee;
    white-space: nowrap; font-variant-numeric: tabular-nums;
    display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  `;
  const readout = document.createElement("span");
  readout.textContent = "-";
  const buttons = document.createElement("div");
  buttons.style.cssText = "display: flex; gap: 4px;";
  container.append(readout, createTextureCacheLabel(), buttons);
  document.body.appendChild(container);

  function addSection(label: string, content: HTMLElement, onToggle?: (shown: boolean) => void): void {
    const button = document.createElement("button");
    button.type = "button";
    button.style.cssText = `
      font: inherit; color: #eee; background: rgba(255,255,255,0.08); cursor: pointer;
      border: 1px solid rgba(255,255,255,0.3); border-radius: 3px; padding: 1px 6px;
    `;
    content.style.display = "none";
    const show = (shown: boolean): void => {
      content.style.display = shown ? "" : "none";
      button.textContent = `${label} ${shown ? "▾" : "▸"}`;
      onToggle?.(shown);
    };
    button.addEventListener("click", () => {
      show(content.style.display === "none");
      // Off the button, so Space - a jump - does not press it again.
      button.blur();
    });
    show(false);
    buttons.append(button);
    container.append(content);
  }

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
    readout.textContent =
      `${engine.getFps().toFixed(0)} fps · ${formatCount(totalDrawn)} verts drawn ` +
      `(view ${formatCount(mainDrawn)}, shadows ${formatCount(totalDrawn - mainDrawn)})`;
  });

  return { addSection, dispose: () => container.remove() };
}
