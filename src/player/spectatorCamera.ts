import { UniversalCamera, Vector3, type ArcRotateCamera, type Scene } from "@babylonjs/core";

/** Flying speed, and with Shift held - Babylon's camera speed, a little under metres a frame. */
const SPEED = 1;
const FAST_SPEED = 6;

export interface SpectatorCamera {
  camera: UniversalCamera;
  /** Takes over from the player's camera, from where it is and looking where it looks. */
  enter: (from: ArcRotateCamera) => void;
  /** Hands back to the player's camera. */
  leave: (to: ArcRotateCamera) => void;
  readonly active: boolean;
  dispose: () => void;
}

/**
 * A free-flying camera with no body: through anything, never held to the ground. WASD to fly
 * where it looks, E or Space to rise, Q or C to sink, Shift to go fast; drag to look about.
 */
export function createSpectatorCamera(scene: Scene, canvas: HTMLCanvasElement): SpectatorCamera {
  const camera = new UniversalCamera("spectator", new Vector3(0, 50, 0), scene);
  camera.keysUp = [87, 38];
  camera.keysDown = [83, 40];
  camera.keysLeft = [65, 37];
  camera.keysRight = [68, 39];
  camera.keysUpward = [69, 32];
  camera.keysDownward = [81, 67];
  camera.speed = SPEED;
  camera.angularSensibility = 2500;
  camera.inertia = 0.75;
  let active = false;

  let fast = false;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Shift") return;
    fast = e.type === "keydown";
    camera.speed = fast ? FAST_SPEED : SPEED;
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);

  function enter(from: ArcRotateCamera): void {
    camera.position.copyFrom(from.position);
    camera.setTarget(from.target.clone());
    camera.minZ = from.minZ;
    camera.maxZ = from.maxZ;
    camera.fov = from.fov;
    from.detachControl();
    camera.attachControl(canvas, true);
    scene.activeCamera = camera;
    active = true;
  }

  function leave(to: ArcRotateCamera): void {
    camera.detachControl();
    to.attachControl(canvas, true);
    scene.activeCamera = to;
    active = false;
  }

  return {
    camera,
    enter,
    leave,
    get active() {
      return active;
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      camera.dispose();
    },
  };
}
