import type { ArcRotateCamera, Vector3 } from "@babylonjs/core";

export interface PositionPanel {
  update: (position: Vector3, camera: ArcRotateCamera, biomeName: string) => void;
}

/** A location precise enough to put the camera back exactly where it was. */
export interface ViewSnapshot {
  x: number;
  z: number;
  alpha: number;
  beta: number;
  radius: number;
}

const DEGREES = 180 / Math.PI;

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * The clipboard text is deliberately two lines with different audiences: a readable summary for a
 * human to paste into a conversation, and an executable call that restores this exact view. The
 * second line is why `__aiworld` exists as a real, permanent debug surface (see main.ts) rather
 * than something bolted on ad hoc - a reported location is only useful if it can be reproduced
 * without hand-translating numbers into a teleport.
 */
function formatSnapshot(snapshot: ViewSnapshot, biomeName: string, y: number): string {
  const summary = `aiworld @ x=${snapshot.x} z=${snapshot.z} y=${round(y, 1)} | camera alpha=${snapshot.alpha} beta=${snapshot.beta} radius=${snapshot.radius} | biome=${biomeName}`;
  const call = `__aiworld.goto({ x: ${snapshot.x}, z: ${snapshot.z}, alpha: ${snapshot.alpha}, beta: ${snapshot.beta}, radius: ${snapshot.radius} })`;
  return `${summary}\n${call}`;
}

/**
 * Shows where the player is and which way the camera is pointing, with a button that copies both.
 *
 * Angles are shown in degrees because that is what a person reads, but copied in radians because
 * that is what Babylon's ArcRotateCamera takes - rounding to degrees for display and keeping full
 * precision for the copy avoids a reported view landing slightly off the one that was reported.
 */
export function createPositionPanel(): PositionPanel {
  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed; top: 88px; left: 16px; z-index: 900;
    background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;
    padding: 6px 10px; font-family: sans-serif; font-size: 11px; color: #eee;
    display: flex; align-items: center; gap: 10px;
  `;

  const readout = document.createElement("span");
  readout.style.cssText = "white-space: nowrap; font-variant-numeric: tabular-nums;";
  readout.textContent = "-";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "Copy";
  copyButton.style.cssText = `
    background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.3); border-radius: 3px;
    color: #eee; font-family: inherit; font-size: 10px; padding: 3px 8px; cursor: pointer;
  `;

  container.appendChild(readout);
  container.appendChild(copyButton);
  document.body.appendChild(container);

  let current: { snapshot: ViewSnapshot; biomeName: string; y: number } | null = null;
  let resetLabel: number | undefined;

  function flash(text: string): void {
    copyButton.textContent = text;
    window.clearTimeout(resetLabel);
    resetLabel = window.setTimeout(() => {
      copyButton.textContent = "Copy";
    }, 1200);
  }

  /** Last-resort path: show the text in a real, pre-selected field so Ctrl+C works. Deliberately
   *  not window.prompt - that blocks the render loop and some browsers suppress it outright. */
  function showManualCopy(text: string): void {
    const existing = container.querySelector("input");
    existing?.remove();

    const field = document.createElement("input");
    field.type = "text";
    field.readOnly = true;
    field.value = text.split("\n")[0];
    field.style.cssText = `
      width: 260px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.35);
      border-radius: 3px; color: #eee; font-family: inherit; font-size: 10px; padding: 2px 4px;
    `;
    field.addEventListener("blur", () => field.remove());
    container.appendChild(field);
    field.focus();
    field.select();
    flash("Ctrl+C");
  }

  copyButton.addEventListener("click", () => {
    if (!current) return;
    const text = formatSnapshot(current.snapshot, current.biomeName, current.y);

    // navigator.clipboard is the only path that copies both lines, but it is unavailable on
    // insecure origins and rejects when the document is not focused - so it needs a real fallback
    // rather than failing silently.
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        flash("Copied");
      } catch {
        showManualCopy(text);
      }
    })();
  });

  // The camera is dragged every frame, so the readout would otherwise rewrite the DOM constantly.
  let lastText = "";

  const update = (position: Vector3, camera: ArcRotateCamera, biomeName: string): void => {
    const snapshot: ViewSnapshot = {
      x: round(position.x, 1),
      z: round(position.z, 1),
      alpha: round(camera.alpha, 3),
      beta: round(camera.beta, 3),
      radius: round(camera.radius, 1),
    };
    current = { snapshot, biomeName, y: position.y };

    // Heading is measured so that it reads like a compass bearing rather than a raw alpha, and
    // pitch as degrees above the horizon: 0 looking level, 90 looking straight down.
    const heading = ((-camera.alpha * DEGREES - 90) % 360 + 360) % 360;
    const pitch = 90 - camera.beta * DEGREES;
    const text = `x ${snapshot.x}  z ${snapshot.z}  y ${round(position.y, 1)}   ·   ${Math.round(heading)}° / ${Math.round(pitch)}°   ·   ${Math.round(camera.radius)}m`;

    if (text === lastText) return;
    lastText = text;
    readout.textContent = text;
  };

  return { update };
}
