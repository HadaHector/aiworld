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
  camera.upperRadiusLimit = 35;
  camera.lowerBetaLimit = 0.2;
  camera.upperBetaLimit = Math.PI / 2.3;
  camera.wheelPrecision = 40;
  camera.panningSensibility = 0; // disable panning, orbit only

  camera.attachControl(canvas, true);

  return camera;
}
