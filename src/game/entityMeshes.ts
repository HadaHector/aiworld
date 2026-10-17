import { Color3, MeshBuilder, StandardMaterial, type Mesh, type Scene } from "@babylonjs/core";
import type { EntityMirror, MirroredEntity } from "./entityMirror";
import { PLAYER_TEMPLATE, type EntityLook, type GameRules } from "../sim/rules/gameRules";
import { createCharacterBody, type BodyKit, type BodyLook, type CharacterBody } from "./characterBody";

export interface EntityMeshes {
  /** Moves every drawn entity to where the mirror has it, and animates its body - each frame. */
  update: () => void;
  /** The entity a mesh draws, for picking - null for any other mesh. */
  entityOf: (mesh: unknown) => number | null;
  dispose: () => void;
}

export interface EntityBodies {
  /** Races, gear and outfits, from the page's packs. */
  kit: BodyKit;
  /** The dimension's seed: gear materials are baked from it, as the player's are. */
  worldSeed: number;
  /** Each body's meshes as it is made - for shadows. */
  onBody?: (meshes: Mesh[]) => void;
}

interface Drawn {
  /** The template's capsule: drawn until the body is ready, or for good when the look names no
   *  race; afterwards unseen but still what a click hits. */
  capsule: Mesh;
  body: CharacterBody | null;
  gone: boolean;
}

/**
 * Every entity the client knows, except its own player, drawn in one dimension's scene from its
 * template's `look` and its own (see ENTITIES.md): a body (CHARACTERS.md) when the look names a race,
 * animated from how the mirror has it move, else a capsule of the look's size and colour. Other
 * players use the player template's look under the race, outfit and seed they chose.
 */
export function createEntityMeshes(scene: Scene, mirror: EntityMirror, rules: GameRules, ownId: () => number, bodies: EntityBodies): EntityMeshes {
  const drawn = new Map<number, Drawn>();
  const ids = new Map<unknown, number>();
  const fallback = rules.templates.get(PLAYER_TEMPLATE)!.look;

  function add(entity: MirroredEntity): void {
    if (entity.id === ownId() || drawn.has(entity.id)) return;
    const look: EntityLook = entity.template?.look ?? fallback;
    const capsule = MeshBuilder.CreateCapsule(`entity${entity.id}`, { height: look.height, radius: look.radius }, scene);
    const material = new StandardMaterial(`entity${entity.id}Material`, scene);
    material.diffuseColor = new Color3(...look.color);
    material.maxSimultaneousLights = 6;
    capsule.material = material;
    capsule.metadata = { entity: entity.id, halfHeight: look.height / 2 };
    const entry: Drawn = { capsule, body: null, gone: false };
    drawn.set(entity.id, entry);
    ids.set(capsule, entity.id);
    place(entity, entry);

    // The entity's own choices over its template's - a player's race, outfit and sex.
    const race = entity.look.race || look.race;
    if (!race) return;
    const sex = entity.look.sex || look.sex;
    const wanted: BodyLook = { race, outfit: entity.look.outfit || look.outfit, sex: sex === "male" || sex === "female" ? sex : undefined, seed: entity.look.seed };
    if (!bodies.kit.races.has(race)) console.warn(`Entity #${entity.id} (${entity.templateId}) wants race "${race}", which these packs lack - a stand-in race is drawn.`);
    createCharacterBody(scene, `entity${entity.id}Body`, bodies.kit, wanted, bodies.worldSeed)
      .then((body) => {
        if (entry.gone) return body.dispose();
        entry.body = body;
        capsule.isVisible = false;
        bodies.onBody?.(body.meshes);
        place(entity, entry);
      })
      .catch((error) => console.error(`Entity #${entity.id}'s body could not be built - its capsule stays.`, error));
  }
  function remove(entity: MirroredEntity): void {
    const entry = drawn.get(entity.id);
    if (!entry) return;
    drawn.delete(entity.id);
    ids.delete(entry.capsule);
    entry.gone = true;
    entry.capsule.material?.dispose();
    entry.capsule.dispose();
    entry.body?.dispose();
  }
  function place(entity: MirroredEntity, entry: Drawn): void {
    entry.capsule.position.set(entity.x, entity.y + (entry.capsule.metadata as { halfHeight: number }).halfHeight, entity.z);
    entry.capsule.rotation.y = entity.facing;
    entry.body?.show(entity);
  }

  for (const entity of mirror.entities.values()) add(entity);
  const offSpawn = mirror.onSpawn(add);
  const offDespawn = mirror.onDespawn(remove);

  return {
    update: () => {
      for (const [id, entry] of drawn) {
        const entity = mirror.entities.get(id);
        if (entity) place(entity, entry);
      }
    },
    entityOf: (mesh) => ids.get(mesh) ?? null,
    dispose: () => {
      offSpawn();
      offDespawn();
      for (const entity of [...mirror.entities.values()]) remove(entity);
      for (const entry of drawn.values()) {
        entry.gone = true;
        entry.capsule.dispose();
        entry.body?.dispose();
      }
      drawn.clear();
    },
  };
}
