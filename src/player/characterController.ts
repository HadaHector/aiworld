import { Color3, MeshBuilder, StandardMaterial, Vector3, type ArcRotateCamera, type Mesh, type Scene } from "@babylonjs/core";
import { createCharacterMotor, type CharacterMotor } from "../world/collision/index";
import type { WorldCollision } from "../world/worldCollision";
import type { HeightSampler } from "../world/terrain/noise";
import { createInput } from "./input";

/** Walking pace, and with Shift held, running - metres a second. */
const WALK_SPEED = 6;
const RUN_SPEED = 12;

export interface Character {
  mesh: Mesh;
  /** The capsule it walks as, on the world's collision (see COLLISION.md). */
  motor: CharacterMotor;
  update: (deltaSeconds: number, camera: ArcRotateCamera) => void;
  teleport: (worldX: number, worldZ: number) => void;
  dispose: () => void;
}

/**
 * The player: a capsule walking and jumping (Space) through the world's collision - its ground and
 * its trees - steered relative to the camera with WASD or the arrows, Shift to run. Where the
 * ground under it is not in the collision world yet (its chunk not built near enough), it waits on
 * the terrain's own height instead of falling.
 */
export function createCharacter(scene: Scene, collision: WorldCollision, heightAt: HeightSampler): Character {
  const motor = createCharacterMotor(collision.world, {}, { x: 0, y: heightAt(0, 0), z: 0 });
  const { height, radius } = motor.settings;
  const mesh = MeshBuilder.CreateCapsule("player", { height, radius }, scene);
  const material = new StandardMaterial("playerMaterial", scene);
  material.diffuseColor = new Color3(0.2, 0.5, 0.9);
  mesh.material = material;
  mesh.isPickable = false;

  const input = createInput();
  const forward = new Vector3();
  const right = new Vector3();
  const move = new Vector3();

  function place(): void {
    const feet = motor.state.feet;
    mesh.position.set(feet.x, feet.y + height / 2, feet.z);
  }

  function update(deltaSeconds: number, camera: ArcRotateCamera): void {
    const axis = input.getMoveAxis();
    camera.getDirectionToRef(Vector3.Forward(), forward);
    forward.y = 0;
    forward.normalize();
    camera.getDirectionToRef(Vector3.Right(), right);
    right.y = 0;
    right.normalize();
    const speed = input.running() ? RUN_SPEED : WALK_SPEED;
    move.copyFrom(forward).scaleInPlace(axis.y).addInPlace(right.scale(axis.x)).scaleInPlace(speed);
    const jump = input.takeJump();

    const feet = motor.state.feet;
    if (!collision.hasGroundAt(feet.x, feet.z)) {
      // No collision here yet: stand on the terrain itself until it comes.
      motor.teleport({ x: feet.x + move.x * deltaSeconds, y: heightAt(feet.x, feet.z), z: feet.z + move.z * deltaSeconds });
    } else {
      motor.update(Math.min(deltaSeconds, 0.1), { move: { x: move.x, y: 0, z: move.z }, jump });
      // Through the ground somehow - a chunk swapped under it mid-step: back on top of it.
      const ground = heightAt(motor.state.feet.x, motor.state.feet.z);
      if (motor.state.feet.y < ground - 1) motor.teleport({ x: motor.state.feet.x, y: ground, z: motor.state.feet.z });
    }
    if (move.lengthSquared() > 0) mesh.rotation.y = Math.atan2(move.x, move.z);
    place();
  }

  function teleport(worldX: number, worldZ: number): void {
    motor.teleport({ x: worldX, y: heightAt(worldX, worldZ), z: worldZ });
    place();
  }

  function dispose(): void {
    input.dispose();
  }

  place();
  return { mesh, motor, update, teleport, dispose };
}
