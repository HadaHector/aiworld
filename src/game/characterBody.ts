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
  /** Gear pieces from what it wears (ITEMS.md, *Equipment*), in place of the outfit when given. */
  gear?: BodyGear[];
}

/** A gear piece an item puts on the body, and the item's tint over the piece's own ("" for none). */
export interface BodyGear {
  piece: string;
  tint: string;
}

/** A gear piece with a tint over its surfaces' own colours - not over rims or a hilt. */
function tinted(piece: GearDef, tint: string): GearDef {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(tint);
  if (!match) return piece;
  const color: [number, number, number] = [parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255];
  return {
    ...piece,
    paint: piece.paint.map((p) => ({ ...p, tint: color })),
    shells: piece.shells.map((s) => ({ ...s, tint: color })),
    skirts: piece.skirts.map((s) => ({ ...s, tint: color })),
    pieces: piece.pieces.map((p) => ({ ...p, tint: color })),
  };
}

/** The gear a body wears: its items' pieces when it has them, else its outfit's. Unknown pieces
 *  are left out. */
function gearOf(kit: BodyKit, look: BodyLook): GearDef[] {
  if (look.gear) return look.gear.flatMap(({ piece, tint }) => (kit.gear.has(piece) ? [tinted(kit.gear.get(piece)!, tint)] : []));
  return (kit.outfits.get(look.outfit)?.gear ?? []).map((id) => kit.gear.get(id)!);
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
  /** Moves the body to where the server says the entity is, and animates it - each frame. `dead`:
   *  it falls and lies (ABILITIES.md, *The death animation*). */
  show: (state: Pick<EntityMotion, "x" | "y" | "z" | "facing" | "grounded"> & { dead?: boolean }) => void;
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
  const dressed = await dressCharacter(
    { race, seed: look.seed, sex: look.sex, gear: gearOf(kit, look), smallclothes: true },
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
  let wasDead: boolean | null = null;

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
      // Seen for the first time already dead, it lies there; back to life somewhere else (a respawn),
      // it stands there. Dying or getting up in view plays out.
      const dead = state.dead ?? false;
      const jumped = last !== null && dt > 0 && Math.hypot(state.x - last.x, state.z - last.z) > TELEPORT;
      const snap = (wasDead === null && dead) || (wasDead === true && !dead && jumped);
      wasDead = dead;
      const { pose, offset } = animator.update({ speed, grounded: state.grounded, verticalSpeed: rise, swimming: false, swing: swinging, dead, snap }, dt);
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
