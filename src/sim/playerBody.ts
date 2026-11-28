import { collisionStats, createCharacterMotor, type CharacterMotor, type Vec3 } from "../world/collision/index";
import type { WorldCollision } from "../world/worldCollision";
import type { ForcedMotion } from "./skills/types";
import type { WaterRules } from "./rules/waterRules";
import type { WaterSample } from "../world/water";

/** How a body stands in water (WATER.md): dry, wading, swimming, or with its head under. */
export const WATER_DRY = 0;
export const WATER_WADING = 1;
export const WATER_SWIMMING = 2;
export const WATER_SUBMERGED = 3;

/** The pace a body moves at, metres a second: a player's, and what creatures' `speed` shares are of
 *  (CREATURES.md). There is no sprint. */
export const MOVE_SPEED = 6;

/** What a body wants this step: a world-space direction (its length the share of MOVE_SPEED, 1 for a
 *  player at full pace; a creature's may be more), jumping. */
export interface BodyInput {
  moveX: number;
  moveZ: number;
  jump: boolean;
  /** Swimming up and down (WATER.md), held; a jump from the surface hops out. */
  rise?: boolean;
  dive?: boolean;
}

export interface PlayerBody {
  /** The capsule it walks as, on the server's collision world (see COLLISION.md). */
  readonly motor: CharacterMotor;
  /** Radians about y, 0 facing +z: the way it last moved. */
  readonly facing: number;
  /** `speedScale` multiplies the pace: the entity's `speed` stat (see ENTITIES.md). */
  step: (deltaSeconds: number, input: BodyInput, speedScale?: number) => void;
  /** Turns it to a facing where it stands - a creature turning to its target (CREATURES.md). */
  face: (facing: number) => void;
  /** Puts it on the ground at a point. */
  teleport: (x: number, z: number) => void;
  /** Puts its feet at a point - on a roof, a floor, anywhere - pushed out of whatever is there. */
  teleportTo: (feet: Vec3) => void;
  /** Carries it along a forced motion - a dash, a leap, a knockback (ABILITIES.md, `move`) - its
   *  own input ignored until the motion ends. */
  push: (motion: ForcedMotion) => void;
  /** Whether a forced motion carries it now. */
  readonly pushed: boolean;
  /** How it stands in water: WATER_DRY to WATER_SUBMERGED. */
  readonly water: number;
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
  /** Water: where it is and how a body meets it - left out, there is none. */
  water?: { at: (x: number, z: number) => WaterSample; rules: () => WaterRules | null },
  /** Whether the feet are in a space under the ground (a dungeon - DUNGEONS.md): there the ground
   *  above and its water are not underfoot, and the body walks the collision as it is. */
  underground?: (x: number, y: number, z: number) => boolean,
): PlayerBody {
  const motor = createCharacterMotor(collision.world, {}, { x: start.x, y: heightAt(start.x, start.z), z: start.z });
  let facing = 0;
  let forced: (ForcedMotion & { left: number }) | null = null;
  let waterState = WATER_DRY;
  /** Seconds left of a hop out of the water: no swimming while it lasts. */
  let hop = 0;

  function step(deltaSeconds: number, input: BodyInput, speedScale = 1): void {
    const speed = MOVE_SPEED * speedScale;
    let moveX = input.moveX * speed;
    let moveZ = input.moveZ * speed;
    const feet = motor.state.feet;
    if (forced) {
      // A forced motion: its own pace, whatever the keys say, until it runs out or arrives.
      const near = forced.stopAt && Math.hypot(forced.stopAt.x - feet.x, forced.stopAt.z - feet.z) <= forced.stopAt.within;
      if (forced.left <= 0 || near) forced = null;
      else {
        forced.left -= deltaSeconds;
        moveX = forced.vx;
        moveZ = forced.vz;
        input = { ...input, jump: false };
      }
    }
    const rules = water?.rules() ?? null;
    // Where the feet were: the motor moves the same object in an update.
    const y0 = feet.y;
    hop = Math.max(0, hop - deltaSeconds);
    const below = underground?.(feet.x, feet.y, feet.z) ?? false;
    const here = rules && water && !below ? water.at(feet.x, feet.z) : null;
    const swimming = here !== null && rules !== null && hop === 0 && here.surface - y0 > rules.swimDepth && (here.depth >= rules.swimDepth || waterState >= WATER_SWIMMING);
    if (swimming && here && rules && collision.hasGroundAt(feet.x, feet.z)) {
      // Swimming: it floats, rise swims up, dive swims down, and pace is a share of walking's.
      // Combat is not limited (WATER.md): only where the body goes changes.
      const floor = groundAt(feet.x, feet.z, y0 + 0.5);
      const floatY = here.surface - rules.floatDepth;
      const atSurface = y0 >= floatY - 0.2;
      if (input.jump && atSurface && !forced) {
        // From the surface a jump is a hop: out over a bank.
        hop = 0.6;
        motor.update(Math.min(deltaSeconds, 0.1), { move: { x: moveX * rules.swimSpeed, y: 0, z: moveZ * rules.swimSpeed }, jump: true });
      } else {
        const planar = Math.hypot(moveX, moveZ);
        const scale = forced ? 1 : Math.min(1, (MOVE_SPEED * speedScale * rules.swimSpeed) / Math.max(1e-6, planar));
        motor.update(Math.min(deltaSeconds, 0.1), { move: { x: moveX * scale, y: 0, z: moveZ * scale }, jump: false });
        const at = motor.state.feet;
        const wanted = input.dive ? -rules.verticalSpeed : input.rise ? rules.verticalSpeed : Math.max(-rules.verticalSpeed, Math.min(rules.verticalSpeed, (floatY - y0) * 3));
        const y = Math.max(floor, Math.min(floatY, y0 + wanted * deltaSeconds));
        // Set straight on the state: a teleport would snap it down onto the ground below.
        motor.state.feet = { x: at.x, y, z: at.z };
        // Its swimming pace carried, so the next update does not start from rest (air control is slow).
        motor.state.velocity = { x: moveX * scale, y: 0, z: moveZ * scale };
        motor.state.grounded = y <= floor + 0.05;
      }
    } else if (!below && !collision.hasGroundAt(feet.x, feet.z)) {
      // No collision here yet: stand on the terrain itself until it comes.
      // (Afloat, it floats there too.)
      const scale = swimming && rules ? Math.min(1, (MOVE_SPEED * speedScale * rules.swimSpeed) / Math.max(1e-6, Math.hypot(moveX, moveZ))) : 1;
      const ground = heightAt(feet.x, feet.z);
      motor.teleport({ x: feet.x + moveX * scale * deltaSeconds, y: swimming && here && rules ? Math.max(ground, here.surface - rules.floatDepth) : ground, z: feet.z + moveZ * scale * deltaSeconds });
    } else {
      const started = performance.now();
      motor.update(Math.min(deltaSeconds, 0.1), { move: { x: moveX, y: 0, z: moveZ }, jump: input.jump });
      collisionStats.motorMs += performance.now() - started;
      // Through the ground somehow - a chunk swapped under it mid-step: back on top of it. A cellar's
      // floor counts as the ground there.
      const at = motor.state.feet;
      const ground = groundAt(at.x, at.z, at.y + 0.5);
      if (!below && at.y < ground - 1) motor.teleport({ x: at.x, y: ground, z: at.z });
    }
    if (moveX * moveX + moveZ * moveZ > 0) facing = Math.atan2(moveX, moveZ);
    waterState = WATER_DRY;
    if (rules && water && !below) {
      const now = motor.state.feet;
      const sample = water.at(now.x, now.z);
      const deep = sample.surface - now.y;
      if (sample.depth > 0 && deep > rules.wadeDepth) waterState = deep > rules.headDepth ? WATER_SUBMERGED : deep > rules.swimDepth && hop === 0 ? WATER_SWIMMING : WATER_WADING;
    }
  }

  return {
    motor,
    get facing() {
      return facing;
    },
    step,
    face: (to) => {
      facing = to;
    },
    teleport: (x, z) => {
      forced = null;
      motor.teleport({ x, y: heightAt(x, z), z });
    },
    teleportTo: (feet) => {
      forced = null;
      motor.teleport({ x: feet.x, y: feet.y, z: feet.z });
    },
    push(motion) {
      forced = { ...motion, left: motion.duration };
      if (motion.vy > 0) {
        motor.state.velocity.y = motion.vy;
        motor.state.grounded = false;
      }
    },
    get pushed() {
      return forced !== null;
    },
    get water() {
      return waterState;
    },
  };
}
