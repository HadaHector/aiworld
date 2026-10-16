import { Matrix, Vector3, type Camera, type Scene } from "@babylonjs/core";
import type { PlaceLabel } from "../world/worldData";

export type { PlaceLabel };

export interface PlaceLabels {
  /** Shows the label nearest `player` if it is close enough to read, over its point on screen - each
   *  frame. */
  update: (player: Vector3, camera: Camera | null) => void;
  /** Takes it off the page, for the next dimension's (see DIMENSIONS.md). */
  dispose: () => void;
}

/** How near (metres, across the ground) a player must stand to read a label - or, one read by
 *  pointing at it, to point at it; and how near the pointer must come to its point on screen (CSS
 *  pixels). */
const READ_DISTANCE = 7;
const HOVER_DISTANCE = 16;
const HOVER_PIXELS = 45;

/**
 * The labels of the world's things, read by walking up to them: the nearest within READ_DISTANCE of
 * the player is shown as a small card over its point, fading in as the player comes close - text
 * the game has no texture for, without a texture. One read by pointing (PlaceLabel.hover) shows
 * instead while the pointer is over it, the player near enough.
 */
export function createPlaceLabels(scene: Scene, labels: PlaceLabel[]): PlaceLabels {
  const card = document.createElement("div");
  card.style.cssText = `
    position: fixed; left: 0; top: 0; z-index: 800; pointer-events: none; display: none;
    transform: translate(-50%, -100%);
    background: rgba(40, 30, 20, 0.82); border: 1px solid rgba(230, 200, 150, 0.6); border-radius: 3px;
    padding: 5px 12px; font-family: Georgia, "Times New Roman", serif; font-size: 15px; color: #f2e6cc;
    white-space: nowrap; text-shadow: 0 1px 2px #000;
  `;
  document.body.appendChild(card);
  const at = new Vector3();
  const onScreen = new Vector3();
  let shown: PlaceLabel | null = null;

  function update(player: Vector3, camera: Camera | null): void {
    const engine = scene.getEngine();
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    const canvas = engine.getRenderingCanvasClientRect();
    const scaleX = canvas ? canvas.width / width : 1;
    const scaleY = canvas ? canvas.height / height : 1;
    /** A point's place on screen, in render pixels - z outside 0-1 behind the camera. */
    const project = (label: PlaceLabel): Vector3 => {
      at.set(label.x, label.y, label.z);
      Vector3.ProjectToRef(at, Matrix.IdentityReadOnly, scene.getTransformMatrix(), camera!.viewport.toGlobal(width, height), onScreen);
      return onScreen;
    };
    let nearest: PlaceLabel | null = null;
    let nearestDistance = READ_DISTANCE;
    let pointed = false;
    // One pointed at first: the nearest on screen to the pointer, near enough to it.
    if (camera) {
      let closest = HOVER_PIXELS;
      for (const label of labels) {
        if (!label.hover || Math.hypot(label.x - player.x, label.z - player.z) > HOVER_DISTANCE) continue;
        const p = project(label);
        if (p.z < 0 || p.z > 1) continue;
        const off = Math.hypot((p.x - scene.pointerX / scaleX) * scaleX, (p.y - scene.pointerY / scaleY) * scaleY);
        if (off < closest) {
          closest = off;
          nearest = label;
          pointed = true;
        }
      }
    }
    if (!nearest) {
      for (const label of labels) {
        if (label.hover) continue;
        const distance = Math.hypot(label.x - player.x, label.z - player.z);
        if (distance < nearestDistance) {
          nearest = label;
          nearestDistance = distance;
        }
      }
    }
    if (!nearest || !camera) {
      if (shown) card.style.display = "none";
      shown = null;
      return;
    }
    project(nearest);
    // Behind the camera: nothing to point at.
    if (onScreen.z < 0 || onScreen.z > 1) {
      card.style.display = "none";
      shown = null;
      return;
    }
    if (shown !== nearest) {
      card.textContent = nearest.text;
      shown = nearest;
    }
    card.style.display = "block";
    card.style.left = `${(canvas?.left ?? 0) + onScreen.x * scaleX}px`;
    card.style.top = `${(canvas?.top ?? 0) + onScreen.y * scaleY}px`;
    // Clearer the nearer - one pointed at, clear.
    card.style.opacity = pointed ? "1" : String(Math.min(1, (READ_DISTANCE - nearestDistance) / 2));
  }

  return { update, dispose: () => card.remove() };
}
