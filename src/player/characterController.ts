import {
  Color3,
  MeshBuilder,
  StandardMaterial,
  Vector3,
  type ArcRotateCamera,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import type { HeightSampler } from "../world/terrain/noise";
import { createInput } from "./input";

const SPEED = 60; // world units per second (10x boosted for dev/exploration convenience)
const CAPSULE_HEIGHT = 1.8;
const CAPSULE_RADIUS = 0.4;

export interface Character {
  mesh: Mesh;
  update: (deltaSeconds: number, camera: ArcRotateCamera) => void;
  dispose: () => void;
}

/** Placeholder capsule "body" that walks on the terrain surface using the same height sampler that built it. */
export function createCharacter(scene: Scene, heightAt: HeightSampler): Character {
  const mesh = MeshBuilder.CreateCapsule("player", { height: CAPSULE_HEIGHT, radius: CAPSULE_RADIUS }, scene);
  const material = new StandardMaterial("playerMaterial", scene);
  material.diffuseColor = new Color3(0.2, 0.5, 0.9);
  mesh.material = material;

  mesh.position.x = 0;
  mesh.position.z = 0;
  mesh.position.y = heightAt(0, 0) + CAPSULE_HEIGHT / 2;

  const input = createInput();
  const forward = new Vector3();
  const right = new Vector3();
  const move = new Vector3();

  function update(deltaSeconds: number, camera: ArcRotateCamera): void {
    const axis = input.getMoveAxis();

    if (axis.lengthSquared() > 0) {
      camera.getDirectionToRef(Vector3.Forward(), forward);
      forward.y = 0;
      forward.normalize();

      camera.getDirectionToRef(Vector3.Right(), right);
      right.y = 0;
      right.normalize();

      move.copyFrom(forward).scaleInPlace(axis.y).addInPlace(right.scale(axis.x)).scaleInPlace(SPEED * deltaSeconds);

      mesh.position.addInPlace(move);
      mesh.rotation.y = Math.atan2(move.x, move.z);
    }

    mesh.position.y = heightAt(mesh.position.x, mesh.position.z) + CAPSULE_HEIGHT / 2;
  }

  function dispose(): void {
    input.dispose();
  }

  return { mesh, update, dispose };
}
