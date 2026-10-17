import type { Mesh, Scene } from "@babylonjs/core";
import type { PackSource } from "../world/content/resolveContent";
import { resolveRaces, type Sex } from "../character/raceDef";
import { resolveGear, resolveOutfits } from "../character/gearDef";
import { resolveGearMaterials } from "../character/gearMaterial";
import { dressCharacter } from "../character/character";
import { createCharacterMesh, type CharacterMesh } from "../character/characterMesh";
import { createAnimator, type Animator } from "../character/animation";
import type { EntityMotion } from "../sim/protocol";

/**
 * Who the player is, as far as their body goes. Character creation and saves come later (see
 * GAMEPLAY.md), so for the spike it comes from the page's address: `?race=dwarf&outfit=knight&sex=
 * female&look=7` - the look being the character's seed.
 */
export interface PlayerLook {
  race: string;
  outfit: string;
  sex?: Sex;
  seed: number;
}

export function lookFromUrl(search = location.search): PlayerLook {
  const params = new URLSearchParams(search);
  const sex = params.get("sex");
  return {
    race: params.get("race") ?? "human",
    outfit: params.get("outfit") ?? "scout",
    sex: sex === "male" || sex === "female" ? sex : undefined,
    seed: Number(params.get("look")) || 7,
  };
}

/** The player's body (CHARACTERS.md, build step 6): drawn where the server has the player, and
 *  animated from how it moves between snapshots. */
export interface PlayerBody {
  meshes: Mesh[];
  /** Moves the body to where the server says the player is, and animates it - each frame. */
  show: (state: EntityMotion) => void;
  /** Plays a melee swing. */
  swing: () => void;
  dispose: () => void;
}

/** How fast the body turns to face where the player faces, per second - the server turns at once. */
const TURN_RATE = 14;
/** A move longer than this between two snapshots is a teleport, not a stride. */
const TELEPORT = 3;

/**
 * Builds the player's body from the packs - race, outfit and looks as `look` says - and draws it in
 * place of the capsule. The animator is fed what the client knows: where the player is, which way
 * it faces, whether it stands on the ground; speed and vertical speed are worked out from how far it
 * moved since the last snapshot, eased so a frame's jitter does not show in the gait.
 */
export async function createPlayerBody(scene: Scene, packs: PackSource[], look: PlayerLook, worldSeed: number): Promise<PlayerBody> {
  const races = resolveRaces(packs);
  const race = races.get(look.race) ?? races.get("human") ?? [...races.values()][0];
  const gear = resolveGear(packs);
  const outfit = resolveOutfits(packs, gear).get(look.outfit);
  const dressed = await dressCharacter(
    { race, seed: look.seed, sex: look.sex, gear: (outfit?.gear ?? []).map((id) => gear.get(id)!), smallclothes: true },
    resolveGearMaterials(packs),
    worldSeed,
  );
  const character: CharacterMesh = createCharacterMesh(scene, "playerBody", dressed.body, { pixels: dressed.pixels!, size: dressed.layout!.size, uvs: dressed.layout!.uvs, nearest: false }, dressed.baked);
  for (const mesh of character.meshes) mesh.isPickable = false;
  const animator: Animator = createAnimator(dressed.race.skeleton);

  let last: { x: number; y: number; z: number; at: number } | null = null;
  let speed = 0;
  let rise = 0;
  let facing: number | null = null;
  let swinging = false;

  return {
    meshes: character.meshes,
    show(state) {
      const now = performance.now() / 1000;
      const dt = last ? Math.min(0.1, now - last.at) : 0;
      if (last && dt > 0) {
        const moved = Math.hypot(state.x - last.x, state.z - last.z);
        const ease = Math.min(1, dt * 12);
        const groundSpeed = moved > TELEPORT ? 0 : moved / dt;
        speed += (groundSpeed - speed) * ease;
        rise += ((moved > TELEPORT ? 0 : (state.y - last.y) / dt) - rise) * ease;
      }
      last = { x: state.x, y: state.y, z: state.z, at: now };
      // Turned toward where the player faces, the short way round.
      if (facing === null) facing = state.facing;
      const turn = Math.atan2(Math.sin(state.facing - facing), Math.cos(state.facing - facing));
      facing += turn * Math.min(1, dt * TURN_RATE);
      const { pose, offset } = animator.update({ speed, grounded: state.grounded, verticalSpeed: rise, swimming: false, swing: swinging }, dt);
      swinging = false;
      character.setPose(pose, offset);
      character.mesh.position.set(state.x, state.y, state.z);
      character.mesh.rotation.y = facing;
    },
    swing() {
      swinging = true;
    },
    dispose: () => character.dispose(),
  };
}
