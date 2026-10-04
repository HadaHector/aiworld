import { ArcRotateCamera, type Mesh, type Scene } from "@babylonjs/core";

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
  camera.upperRadiusLimit = 800; // generous zoom-out range for dev/exploration, whole continent should fit
  camera.lowerBetaLimit = 0.05; // allow near top-down for inspecting large-scale shape
  camera.upperBetaLimit = Math.PI / 1.9;
  camera.wheelPrecision = 40;
  camera.panningSensibility = 0; // disable panning, orbit only

  camera.attachControl(canvas, true);

  return camera;
}

/** How close the camera comes in behind the player indoors - inside the room, not out past its
 *  walls - and the least it may zoom to there. */
const INDOOR_RADIUS = 4;
const INDOOR_LOWER_LIMIT = 1.5;

/**
 * Brings the camera in close while the player is inside a building's rooms, and lets it back out to
 * where it was on the way out. No collision yet: this only keeps it from sitting outside the walls.
 */
export function createIndoorCamera(camera: ArcRotateCamera, indoors: () => boolean): { update: () => void } {
  const outdoorLimit = camera.lowerRadiusLimit ?? 6;
  let outdoorRadius: number | null = null;
  return {
    update() {
      const inside = indoors();
      if (inside && outdoorRadius === null) {
        outdoorRadius = camera.radius;
        camera.lowerRadiusLimit = INDOOR_LOWER_LIMIT;
        camera.radius = Math.min(camera.radius, INDOOR_RADIUS);
      } else if (!inside && outdoorRadius !== null) {
        camera.lowerRadiusLimit = outdoorLimit;
        camera.radius = Math.max(outdoorRadius, outdoorLimit);
        outdoorRadius = null;
      }
    },
  };
}
