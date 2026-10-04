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

/** What one stands on at a point, with one's feet at `feet` - a building's floor, or the ground. */
export type GroundSampler = (worldX: number, worldZ: number, feet: number) => number;
import { createInput } from "./input";

const SPEED = 60; // world units per second (10x boosted for dev/exploration convenience)
const CAPSULE_HEIGHT = 1.8;
const CAPSULE_RADIUS = 0.4;

export interface Character {
  mesh: Mesh;
  update: (deltaSeconds: number, camera: ArcRotateCamera) => void;
  teleport: (worldX: number, worldZ: number) => void;
  dispose: () => void;
}

/** Placeholder capsule "body" that walks on the terrain surface using the same height sampler that
 *  built it - and on the floors and stairs of a building it walks into (`groundAt`). */
export function createCharacter(scene: Scene, heightAt: HeightSampler, groundAt: GroundSampler = (x, z) => heightAt(x, z)): Character {
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

    const feet = mesh.position.y - CAPSULE_HEIGHT / 2;
    mesh.position.y = groundAt(mesh.position.x, mesh.position.z, feet) + CAPSULE_HEIGHT / 2;
  }

  function teleport(worldX: number, worldZ: number): void {
    mesh.position.x = worldX;
    mesh.position.z = worldZ;
    mesh.position.y = heightAt(worldX, worldZ) + CAPSULE_HEIGHT / 2;
  }

  function dispose(): void {
    input.dispose();
  }

  return { mesh, update, teleport, dispose };
}
