import { ArcRotateCamera, type Mesh, type Scene } from "@babylonjs/core";
import type { CollisionWorld } from "../world/collision/index";

/** Mouse-orbit third-person camera that follows a target mesh's position. */
export function createThirdPersonCamera(scene: Scene, canvas: HTMLCanvasElement, target: Mesh): ArcRotateCamera {
  const camera = new ArcRotateCamera(
    "thirdPersonCamera",
    -Math.PI / 2,
    1.05,
    22,
    target.position,
    scene,
  );

  camera.lockedTarget = target;
  camera.lowerRadiusLimit = 6;
  camera.upperRadiusLimit = 800; // generous zoom-out range for dev/exploration, whole world should fit
  camera.lowerBetaLimit = 0.05; // allow near top-down for inspecting large-scale shape
  camera.upperBetaLimit = Math.PI / 1.9;
  camera.wheelPrecision = 40;
  camera.panningSensibility = 0; // disable panning, orbit only

  camera.attachControl(canvas, true);

  return camera;
}

/** The camera's own size, as the collision sees it - kept clear of walls by this much, near the
 *  camera's near plane (1 m, see lighting/sunLighting.ts), so a wall it stops at is not cut open. */
const CAMERA_RADIUS = 0.8;
/** The sweep sets off this far over the camera's target (the middle of the player's capsule) - from
 *  the head, clear of the floor, which a sphere this size would start inside. */
const HEAD = 0.7;
/** The nearest the player may zoom in, and the nearest a wall may push the camera. */
const MIN_ZOOM = 6;
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
