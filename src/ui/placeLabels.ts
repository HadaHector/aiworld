import { Matrix, Vector3, type Camera, type Scene } from "@babylonjs/core";

/** Something in the world that says something to a player standing by it - a wayside sign, its
 *  inn's name - at a point over it. */
export interface PlaceLabel {
  x: number;
  y: number;
  z: number;
  text: string;
}

export interface PlaceLabels {
  /** Shows the label nearest `player` if it is close enough to read, over its point on screen - each
   *  frame. */
  update: (player: Vector3, camera: Camera | null) => void;
}

/** How near (metres, across the ground) a player must stand to read a label. */
const READ_DISTANCE = 7;

/**
 * The labels of the world's things, read by walking up to them: the nearest within READ_DISTANCE of
 * the player is shown as a small card over its point, fading in as the player comes close - text
 * the game has no texture for, without a texture.
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
    let nearest: PlaceLabel | null = null;
    let nearestDistance = READ_DISTANCE;
    for (const label of labels) {
      const distance = Math.hypot(label.x - player.x, label.z - player.z);
      if (distance < nearestDistance) {
        nearest = label;
        nearestDistance = distance;
      }
    }
    if (!nearest || !camera) {
      if (shown) card.style.display = "none";
      shown = null;
      return;
    }
    const engine = scene.getEngine();
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    at.set(nearest.x, nearest.y, nearest.z);
    Vector3.ProjectToRef(at, Matrix.IdentityReadOnly, scene.getTransformMatrix(), camera.viewport.toGlobal(width, height), onScreen);
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
    const canvas = engine.getRenderingCanvasClientRect();
    const scaleX = canvas ? canvas.width / width : 1;
    const scaleY = canvas ? canvas.height / height : 1;
    card.style.display = "block";
    card.style.left = `${(canvas?.left ?? 0) + onScreen.x * scaleX}px`;
    card.style.top = `${(canvas?.top ?? 0) + onScreen.y * scaleY}px`;
    // Clearer the nearer.
    card.style.opacity = String(Math.min(1, (READ_DISTANCE - nearestDistance) / 2));
  }

  return { update };
}
