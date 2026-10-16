import { collisionStats, createCharacterMotor, type CharacterMotor, type Vec3 } from "../world/collision/index";
import type { WorldCollision } from "../world/worldCollision";

/** Walking pace, and running - metres a second. */
export const WALK_SPEED = 6;
export const RUN_SPEED = 12;

/** What a player wants this step: a world-space direction (length 0-1), running, jumping. */
export interface BodyInput {
  moveX: number;
  moveZ: number;
  run: boolean;
  jump: boolean;
}

export interface PlayerBody {
  /** The capsule it walks as, on the server's collision world (see COLLISION.md). */
  readonly motor: CharacterMotor;
  /** Radians about y, 0 facing +z: the way it last moved. */
  readonly facing: number;
  /** `speedScale` multiplies walking and running pace: the entity's `speed` stat (see ENTITIES.md). */
  step: (deltaSeconds: number, input: BodyInput, speedScale?: number) => void;
  /** Puts it on the ground at a point. */
  teleport: (x: number, z: number) => void;
  /** Puts its feet at a point - on a roof, a floor, anywhere - pushed out of whatever is there. */
  teleportTo: (feet: Vec3) => void;
}

/**
 * A player's body on the server: a capsule walking and jumping through the world's collision - its
 * ground, trees and buildings. Where the ground under it is not in the collision world yet (its chunk
 * not built near enough), it stands on the terrain's own height instead of falling.
 */
export function createPlayerBody(
  collision: WorldCollision,
  heightAt: (x: number, z: number) => number,
  /** What is stood on at a point with the feet at a height: a building's floor, or the ground. */
  groundAt: (x: number, z: number, feet: number) => number,
  start: { x: number; z: number },
): PlayerBody {
  const motor = createCharacterMotor(collision.world, {}, { x: start.x, y: heightAt(start.x, start.z), z: start.z });
  let facing = 0;

  function step(deltaSeconds: number, input: BodyInput, speedScale = 1): void {
    const speed = (input.run ? RUN_SPEED : WALK_SPEED) * speedScale;
    const moveX = input.moveX * speed;
    const moveZ = input.moveZ * speed;
    const feet = motor.state.feet;
    if (!collision.hasGroundAt(feet.x, feet.z)) {
      // No collision here yet: stand on the terrain itself until it comes.
      motor.teleport({ x: feet.x + moveX * deltaSeconds, y: heightAt(feet.x, feet.z), z: feet.z + moveZ * deltaSeconds });
    } else {
      const started = performance.now();
      motor.update(Math.min(deltaSeconds, 0.1), { move: { x: moveX, y: 0, z: moveZ }, jump: input.jump });
      collisionStats.motorMs += performance.now() - started;
      // Through the ground somehow - a chunk swapped under it mid-step: back on top of it. A cellar's
      // floor counts as the ground there.
      const at = motor.state.feet;
      const ground = groundAt(at.x, at.z, at.y + 0.5);
      if (at.y < ground - 1) motor.teleport({ x: at.x, y: ground, z: at.z });
    }
    if (moveX * moveX + moveZ * moveZ > 0) facing = Math.atan2(moveX, moveZ);
  }

  return {
    motor,
    get facing() {
      return facing;
    },
    step,
    teleport: (x, z) => motor.teleport({ x, y: heightAt(x, z), z }),
    teleportTo: (feet) => motor.teleport({ x: feet.x, y: feet.y, z: feet.z }),
  };
}
