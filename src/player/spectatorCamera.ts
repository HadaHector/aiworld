import { UniversalCamera, Vector3, type ArcRotateCamera, type Scene } from "@babylonjs/core";

/** Flying speed to start with - Babylon's camera speed, about metres a frame - how far the mouse
 *  wheel can take it either way, how much one notch changes it, and how much faster Shift goes. */
const SPEED = 4;
const MIN_SPEED = 0.25;
const MAX_SPEED = 200;
const WHEEL_STEP = 1.25;
const FAST = 5;

export interface SpectatorCamera {
  camera: UniversalCamera;
  /** Takes over from the player's camera, from where it is and looking where it looks. */
  enter: (from: ArcRotateCamera) => void;
  /** Hands back to the player's camera. */
  leave: (to: ArcRotateCamera) => void;
  /** Flies straight to somewhere else, looking the same way. */
  moveTo: (x: number, y: number, z: number) => void;
  readonly active: boolean;
  dispose: () => void;
}

/**
 * A free-flying camera with no body: through anything, never held to the ground. WASD to fly
 * where it looks, E or Space to rise, Q or C to sink, Shift to go faster; drag to look about, and
 * the mouse wheel to set the speed.
 */
export function createSpectatorCamera(scene: Scene, canvas: HTMLCanvasElement): SpectatorCamera {
  const camera = new UniversalCamera("spectator", new Vector3(0, 50, 0), scene);
  camera.keysUp = [87, 38];
  camera.keysDown = [83, 40];
  camera.keysLeft = [65, 37];
  camera.keysRight = [68, 39];
  camera.keysUpward = [69, 32];
  camera.keysDownward = [81, 67];
  camera.angularSensibility = 2500;
  camera.inertia = 0.75;
  // The wheel sets the speed here rather than nudging the camera along.
  camera.inputs.removeByType("FreeCameraMouseWheelInput");
  let active = false;

  let speed = SPEED;
  let fast = false;
  const apply = (): void => {
    camera.speed = speed * (fast ? FAST : 1);
  };
  apply();

  // A moment's readout of the speed, as it changes.
  const label = document.createElement("div");
  label.style.cssText = `
    position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%); z-index: 900;
    background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;
    padding: 4px 10px; font-family: sans-serif; font-size: 12px; color: #eee; pointer-events: none;
    transition: opacity 0.3s; opacity: 0;
  `;
  document.body.appendChild(label);
  let labelTimer = 0;
  const showSpeed = (): void => {
    label.textContent = `Flying speed ${camera.speed < 10 ? camera.speed.toFixed(1) : camera.speed.toFixed(0)}`;
    label.style.opacity = "1";
    clearTimeout(labelTimer);
    labelTimer = window.setTimeout(() => (label.style.opacity = "0"), 1200);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Shift") return;
    fast = e.type === "keydown";
    apply();
  };
  const onWheel = (e: WheelEvent): void => {
    if (!active) return;
    e.preventDefault();
    speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed * Math.pow(WHEEL_STEP, -Math.sign(e.deltaY))));
    apply();
    showSpeed();
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  canvas.addEventListener("wheel", onWheel, { passive: false });

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
    moveTo(x, y, z) {
      // The target moves with it, or the camera would turn to keep looking at the old spot.
      const ahead = camera.getTarget().subtract(camera.position);
      camera.position.set(x, y, z);
      camera.setTarget(camera.position.add(ahead));
    },
    get active() {
      return active;
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      canvas.removeEventListener("wheel", onWheel);
      label.remove();
      camera.dispose();
    },
  };
}
