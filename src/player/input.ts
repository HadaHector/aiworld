const FORWARD_KEYS = new Set(["w", "arrowup"]);
const BACK_KEYS = new Set(["s", "arrowdown"]);
const LEFT_KEYS = new Set(["a", "arrowleft"]);
const RIGHT_KEYS = new Set(["d", "arrowright"]);

/** How long a press of Space waits to be taken as a jump - one not taken by then (nobody was
 *  walking: say the spectator camera was flying) is dropped rather than jumped much later. */
const JUMP_KEPT_MS = 200;

/** Tracks WASD/arrow key state and exposes a normalized movement axis (x = strafe, y = forward) -
 *  and Space, as a jump to take once per press, and Shift held, to run. */
export function createInput() {
  const pressed = new Set<string>();
  let jumpAt = -Infinity;

  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (key === " " && !pressed.has(key)) jumpAt = performance.now();
    pressed.add(key);
  };
  const onKeyUp = (e: KeyboardEvent) => pressed.delete(e.key.toLowerCase());

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function getMoveAxis(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const key of pressed) {
      if (FORWARD_KEYS.has(key)) y += 1;
      if (BACK_KEYS.has(key)) y -= 1;
      if (RIGHT_KEYS.has(key)) x += 1;
      if (LEFT_KEYS.has(key)) x -= 1;
    }
    const length = Math.hypot(x, y);
    return length > 1 ? { x: x / length, y: y / length } : { x, y };
  }

  /** Whether Space was pressed (lately) since this was last asked. */
  function takeJump(): boolean {
    const taken = performance.now() - jumpAt <= JUMP_KEPT_MS;
    jumpAt = -Infinity;
    return taken;
  }

  function running(): boolean {
    return pressed.has("shift");
  }

  function dispose() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  }

  return { getMoveAxis, takeJump, running, dispose };
}
