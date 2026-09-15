import { Vector2 } from "@babylonjs/core";

const FORWARD_KEYS = new Set(["w", "arrowup"]);
const BACK_KEYS = new Set(["s", "arrowdown"]);
const LEFT_KEYS = new Set(["a", "arrowleft"]);
const RIGHT_KEYS = new Set(["d", "arrowright"]);

/** Tracks WASD/arrow key state and exposes a normalized movement axis (x = strafe, y = forward). */
export function createInput() {
  const pressed = new Set<string>();

  const onKeyDown = (e: KeyboardEvent) => pressed.add(e.key.toLowerCase());
  const onKeyUp = (e: KeyboardEvent) => pressed.delete(e.key.toLowerCase());

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function getMoveAxis(): Vector2 {
    let x = 0;
    let y = 0;
    for (const key of pressed) {
      if (FORWARD_KEYS.has(key)) y += 1;
      if (BACK_KEYS.has(key)) y -= 1;
      if (RIGHT_KEYS.has(key)) x += 1;
      if (LEFT_KEYS.has(key)) x -= 1;
    }
    const axis = new Vector2(x, y);
    return axis.lengthSquared() > 1 ? axis.normalize() : axis;
  }

  function dispose() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  }

  return { getMoveAxis, dispose };
}
