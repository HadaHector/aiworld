import type { Mesh, Scene } from "@babylonjs/core";
import type { PackSource } from "../world/content/resolveContent";
import { resolveRaces, type RaceDef, type Sex } from "../character/raceDef";
import { resolveGear, resolveOutfits, type GearDef, type OutfitDef } from "../character/gearDef";
import { resolveGearMaterials, type GearMaterialDef } from "../character/gearMaterial";
import { dressCharacter } from "../character/character";
import { createCharacterMesh, type CharacterMesh } from "../character/characterMesh";
import { createAnimator, type Animator } from "../character/animation";
import type { EntityMotion } from "../sim/protocol";

/** Who a character is, as far as its body goes - a race, an outfit and its seed, by their ids. */
export interface BodyLook {
  race: string;
  outfit: string;
  sex?: Sex;
  seed: number;
}

/** What bodies are built from, resolved from the packs once and shared by every body. */
export interface BodyKit {
  races: Map<string, RaceDef>;
  gear: Map<string, GearDef>;
  outfits: Map<string, OutfitDef>;
  materials: Map<string, GearMaterialDef>;
}

export function createBodyKit(packs: PackSource[]): BodyKit {
  const gear = resolveGear(packs);
  return { races: resolveRaces(packs), gear, outfits: resolveOutfits(packs, gear), materials: resolveGearMaterials(packs) };
}

/** A character's body (CHARACTERS.md) drawn where the server has its entity, and animated from how
 *  it moves between snapshots. */
export interface CharacterBody {
  meshes: Mesh[];
  /** Moves the body to where the server says the entity is, and animates it - each frame. */
  show: (state: Pick<EntityMotion, "x" | "y" | "z" | "facing" | "grounded">) => void;
  /** Plays a melee swing. */
  swing: () => void;
  dispose: () => void;
}

/** How fast the body turns to face where the entity faces, per second - the server turns at once. */
const TURN_RATE = 14;
/** A move longer than this between two snapshots is a teleport, not a stride. */
const TELEPORT = 3;

/**
 * Builds a body from the packs - race, outfit and looks as `look` says (an unknown race is the
 * first one's, an unknown outfit none). The animator is fed what the client knows: where the entity
 * is, which way it faces, whether it stands on the ground; speed and vertical speed are worked out
 * from how far it moved since the last snapshot, eased so a frame's jitter does not show in the gait.
 */
export async function createCharacterBody(scene: Scene, name: string, kit: BodyKit, look: BodyLook, worldSeed: number): Promise<CharacterBody> {
  const race = kit.races.get(look.race) ?? kit.races.get("human") ?? [...kit.races.values()][0];
  const outfit = kit.outfits.get(look.outfit);
  const dressed = await dressCharacter(
    { race, seed: look.seed, sex: look.sex, gear: (outfit?.gear ?? []).map((id) => kit.gear.get(id)!), smallclothes: true },
    kit.materials,
    worldSeed,
  );
  const character: CharacterMesh = createCharacterMesh(scene, name, dressed.body, { pixels: dressed.pixels!, size: dressed.layout!.size, uvs: dressed.layout!.uvs, nearest: false }, dressed.baked);
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
      // Turned toward where the entity faces, the short way round.
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
