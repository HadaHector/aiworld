import { ArcRotateCamera, TransformNode, type Mesh, type Scene } from "@babylonjs/core";
import type { CollisionWorld } from "../world/collision/index";

/** How far one wheel notch zooms: Babylon divides the wheel's delta by this (smaller is faster).
 *  8 is five times the old 40 (owner, 2026-11-28). */
const WHEEL_PRECISION = 8;
/** Pixels of mouse travel per radian of turn (smaller is stronger). Babylon's default is 1000; 500
 *  turns twice as far (owner, 2026-11-28). A candidate for the options screen. */
const TURN_SENSIBILITY = 500;
/** A press that travels further than this is a drag that turns the camera, not a click. */
const DRAG_PIXELS = 4;

/** Mouse travel since the last press on each canvas: what tells a click from a drag that turns the
 *  camera. clientX can't tell once the pointer is locked (it stays put), movementX still can. */
const travel = new WeakMap<HTMLCanvasElement, { pixels: number }>();
export function pointerTravel(canvas: HTMLCanvasElement): number {
  return travel.get(canvas)?.pixels ?? 0;
}

/**
 * Mouse-orbit third-person camera that follows a target mesh. With `lookHeight` it looks at a point
 * that far over the target's origin - the head, for the player's capsule - instead of its middle.
 */
export function createThirdPersonCamera(scene: Scene, canvas: HTMLCanvasElement, target: Mesh, lookHeight = 0): ArcRotateCamera {
  let look: Mesh | TransformNode = target;
  if (lookHeight) {
    const node = new TransformNode("cameraLook", scene);
    node.parent = target;
    node.position.set(0, lookHeight, 0);
    look = node;
  }
  const camera = new ArcRotateCamera(
    "thirdPersonCamera",
    -Math.PI / 2,
    1.05,
    22,
    // Live, not a copy: camera.target follows the look point (the wall sweep below reads it).
    look === target ? target.position : look.getAbsolutePosition(),
    scene,
  );

  camera.lockedTarget = look;
  camera.lowerRadiusLimit = 2;
  camera.upperRadiusLimit = 800; // generous zoom-out range for dev/exploration, whole world should fit
  camera.lowerBetaLimit = 0.05; // allow near top-down for inspecting large-scale shape
  camera.upperBetaLimit = Math.PI / 1.9;
  camera.wheelPrecision = WHEEL_PRECISION;
  camera.angularSensibilityX = TURN_SENSIBILITY;
  camera.angularSensibilityY = TURN_SENSIBILITY;
  camera.panningSensibility = 0; // disable panning, orbit only
  grabPointerWhileTurning(scene, canvas, camera);

  camera.attachControl(canvas, true);
  // Both mouse buttons turn the camera (a click without a drag still targets or interacts -
  // game/session.ts). Babylon's input map has the left button turn it and the right pan, which is off
  // here, so the right button is set to turn too.
  camera.movement.input.setInteraction("pointer", { button: 2 }, "rotate");
  // No inertia: the camera stops the moment the mouse does, instead of coasting on (Babylon's default
  // is 0.9 for turning and zooming).
  camera.inertia = 0;
  camera.movement.rotationInertia = 0;
  camera.movement.zoomInertia = 0;
  camera.movement.panInertia = 0;

  return camera;
}

/**
 * Hides and holds the cursor while a drag turns the camera, so only the view moves: once a press
 * has travelled past a click the pointer is locked to the canvas, and let go on release, the cursor
 * back where the drag began. A plain click never locks it (clicks still target and interact).
 */
function grabPointerWhileTurning(scene: Scene, canvas: HTMLCanvasElement, camera: ArcRotateCamera): void {
  const state = { pixels: 0 };
  travel.set(canvas, state);
  let pressed = false;
  // Gone with the camera (a new game makes a new one on the same canvas).
  const stop = new AbortController();
  const signal = stop.signal;
  camera.onDisposeObservable.addOnce(() => stop.abort());
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    pressed = true;
    state.pixels = 0;
  }, { signal });
  canvas.addEventListener("pointermove", (e) => {
    if (!pressed) return;
    if (e.buttons === 0) {
      pressed = false;
      return;
    }
    state.pixels += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (state.pixels > DRAG_PIXELS && scene.activeCamera === camera && document.pointerLockElement !== canvas) {
      // Some browsers return a promise that rejects (no recent click, say): the drag still turns.
      try {
        const asked = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        asked?.catch?.(() => {});
      } catch {
        // as above
      }
    }
  }, { signal });
  const release = (): void => {
    pressed = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  };
  window.addEventListener("pointerup", (e) => {
    if (e.buttons === 0) release();
  }, { signal });
  window.addEventListener("blur", release, { signal });
}

/** The camera's own size, as the collision sees it - kept clear of walls by this much, near the
 *  camera's near plane (1 m, see lighting/sunLighting.ts), so a wall it stops at is not cut open. */
const CAMERA_RADIUS = 0.8;
/** The sweep sets off this far over the camera's target. The target is the player's head now
 *  (createThirdPersonCamera's lookHeight), clear of the floor a sphere this size would start inside. */
const HEAD = 0;
/** The nearest the player may zoom in, and the nearest a wall may push the camera. */
const MIN_ZOOM = 2;
const MIN_PUSHED = 0.8;
/** How quickly the camera eases back out once a wall stops pushing it in (per second). */
const EASE_OUT = 6;

/**
 * Keeps the camera out of walls: each frame a small sphere is swept from the player out to where
 * the camera wants to be, and the camera stops where it first touches something - a wall, a roof, a
 * tree - easing back out once the way is clear. The zoom the player chose (the wheel) is kept and
 * returned to; only what is in the way brings the camera nearer.
 */
export function createCameraCollision(camera: ArcRotateCamera, world: CollisionWorld): { update: (deltaSeconds: number) => void } {
  // The camera's own limit would stop a wall pushing it in: the zoom's floor is kept here instead.
  camera.lowerRadiusLimit = MIN_PUSHED;
  let wanted = Math.max(camera.radius, MIN_ZOOM);
  let set = camera.radius;
  return {
    update(deltaSeconds) {
      // A change not made here is the player's zoom.
      if (Math.abs(camera.radius - set) > 1e-6) wanted = Math.max(camera.radius, MIN_ZOOM);
      const target = camera.target;
      const sinBeta = Math.sin(camera.beta);
      const out = { x: Math.cos(camera.alpha) * sinBeta, y: Math.cos(camera.beta), z: Math.sin(camera.alpha) * sinBeta };
      // From the head to where the camera wants to be.
      const head = { x: target.x, y: target.y + HEAD, z: target.z };
      const to = { x: target.x + out.x * wanted - head.x, y: target.y + out.y * wanted - head.y, z: target.z + out.z * wanted - head.z };
      const hit = world.sweep({ kind: "sphere", center: head, radius: CAMERA_RADIUS }, to);
      let reach = wanted;
      if (hit && !hit.startedInside) {
        // Where it stopped, as a distance from the target along the camera's own line.
        const f = hit.fraction;
        const at = { x: head.x + to.x * f - target.x, y: head.y + to.y * f - target.y, z: head.z + to.z * f - target.z };
        reach = Math.max(MIN_PUSHED, Math.hypot(at.x, at.y, at.z));
      } else if (hit) {
        reach = MIN_PUSHED;
      }
      // In at once, out gently.
      const radius = reach < camera.radius ? reach : Math.min(reach, camera.radius + (reach - camera.radius) * Math.min(1, EASE_OUT * deltaSeconds));
      camera.radius = radius;
      set = radius;
    },
  };
}
