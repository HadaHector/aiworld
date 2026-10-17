import { Color3, MeshBuilder, StandardMaterial, type Mesh, type Scene } from "@babylonjs/core";
import { FLAG } from "../sim/skills/flags";
import type { EntityMirror, MirroredEntity } from "./entityMirror";
import { PLAYER_TEMPLATE, type EntityLook, type GameRules } from "../sim/rules/gameRules";
import { createCharacterBody, type BodyKit, type BodyLook, type CharacterBody } from "./characterBody";
import type { ItemRules } from "../sim/rules/itemRules";
import { gearOfItems } from "./itemGear";

export interface EntityMeshes {
  /** Moves every drawn entity to where the mirror has it, and animates its body - each frame. */
  update: () => void;
  /** The entity a mesh draws, for picking - null for any other mesh. */
  entityOf: (mesh: unknown) => number | null;
  /** Plays a melee swing on an entity's body: the server says when. */
  swing: (id: number) => void;
  /** Rings the selected unit on the ground - red for one that fights players, green otherwise. */
  setTarget: (id: number) => void;
  dispose: () => void;
}

export interface EntityBodies {
  /** Races, gear and outfits, from the page's packs. */
  kit: BodyKit;
  /** The dimension's seed: gear materials are baked from it, as the player's are. */
  worldSeed: number;
  /** Each body's meshes as it is made - for shadows. */
  onBody?: (meshes: Mesh[]) => void;
  /** Item types, so what an entity wears can be put on its body (ITEMS.md, *Equipment*). */
  items?: ItemRules;
}

interface Drawn {
  /** The template's capsule (or box): drawn until the body is ready, or for good when the look
   *  names no race; afterwards unseen but still what a click hits. */
  capsule: Mesh;
  body: CharacterBody | null;
  gone: boolean;
  /** The look it wants a body for, null for none; what its body was last built for; and whether a
   *  build is under way. A body is built in `update`, after the step's gear has arrived, and built
   *  again when what it wears changes. */
  wanted: BodyLook | null;
  built: string;
  building: boolean;
  /** A glint over it while it has loot to take. */
  sparkle: Mesh | null;
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
  // The selection ring: a flat torus at the target's feet.
  const ring = MeshBuilder.CreateTorus("targetRing", { diameter: 1, thickness: 0.06, tessellation: 40 }, scene);
  const ringMaterial = new StandardMaterial("targetRingMaterial", scene);
  ringMaterial.disableLighting = true;
  ring.material = ringMaterial;
  ring.isPickable = false;
  ring.isVisible = false;
  let targetId = 0;
  function placeRing(): void {
    const entity = targetId ? mirror.entities.get(targetId) : undefined;
    const own = targetId === ownId();
    if (!entity) {
      ring.isVisible = false;
      return;
    }
    const look = entity.template?.look ?? fallback;
    ring.isVisible = true;
    ring.position.set(entity.x, entity.y + 0.05, entity.z);
    ring.scaling.setAll(look.radius * 2.6);
    const hostile = !own && entity.template?.hostility === "hostile";
    const dead = (entity.flags & (1 << FLAG.dead)) !== 0;
    ringMaterial.emissiveColor = dead ? new Color3(0.4, 0.4, 0.4) : hostile ? new Color3(0.95, 0.2, 0.15) : new Color3(0.3, 0.9, 0.35);
  }

  function add(entity: MirroredEntity): void {
    if (entity.id === ownId() || drawn.has(entity.id)) return;
    const look: EntityLook = entity.template?.look ?? fallback;
    const capsule =
      look.shape === "box"
        ? MeshBuilder.CreateBox(`entity${entity.id}`, { width: look.radius * 2, depth: look.radius * 1.4, height: look.height }, scene)
        : MeshBuilder.CreateCapsule(`entity${entity.id}`, { height: look.height, radius: look.radius }, scene);
    const material = new StandardMaterial(`entity${entity.id}Material`, scene);
    material.diffuseColor = new Color3(...look.color);
    material.maxSimultaneousLights = 6;
    capsule.material = material;
    capsule.metadata = { entity: entity.id, halfHeight: look.height / 2 };
    // The entity's own choices over its template's - a player's race, outfit and sex.
    const race = entity.look.race || look.race;
    const sex = entity.look.sex || look.sex;
    const wanted: BodyLook | null = race ? { race, outfit: entity.look.outfit || look.outfit, sex: sex === "male" || sex === "female" ? sex : undefined, seed: entity.look.seed } : null;
    if (race && !bodies.kit.races.has(race)) console.warn(`Entity #${entity.id} (${entity.templateId}) wants race "${race}", which these packs lack - a stand-in race is drawn.`);
    const entry: Drawn = { capsule, body: null, gone: false, wanted, built: "", building: false, sparkle: null };
    drawn.set(entity.id, entry);
    ids.set(capsule, entity.id);
    place(entity, entry);
  }

  /** Builds (or builds again) an entity's body when what it should wear differs from what it has. */
  function dress(entity: MirroredEntity, entry: Drawn): void {
    if (!entry.wanted || entry.building) return;
    const gear = entity.gear && bodies.items ? gearOfItems(bodies.items, entity.gear) : undefined;
    const signature = gear ? gear.map((g) => `${g.piece}${g.tint}`).join() : `outfit:${entry.wanted.outfit}`;
    if (signature === entry.built) return;
    entry.building = true;
    createCharacterBody(scene, `entity${entity.id}Body`, bodies.kit, { ...entry.wanted, gear }, bodies.worldSeed)
      .then((body) => {
        entry.building = false;
        if (entry.gone) return body.dispose();
        entry.body?.dispose();
        entry.body = body;
        entry.built = signature;
        entry.capsule.isVisible = false;
        bodies.onBody?.(body.meshes);
        place(entity, entry);
      })
      .catch((error) => {
        entry.building = false;
        entry.built = signature;
        console.error(`Entity #${entity.id}'s body could not be built - its capsule stays.`, error);
      });
  }

  /** A slowly turning glint above an entity with loot, so a corpse or chest shows from afar. */
  function glint(entity: MirroredEntity, entry: Drawn): void {
    if (entity.lootable && !entry.sparkle) {
      const sparkle = MeshBuilder.CreatePolyhedron(`entity${entity.id}Loot`, { type: 1, size: 0.12 }, scene);
      const material = new StandardMaterial(`entity${entity.id}LootMaterial`, scene);
      material.disableLighting = true;
      material.emissiveColor = new Color3(1, 0.85, 0.3);
      sparkle.material = material;
      sparkle.isPickable = false;
      entry.sparkle = sparkle;
    } else if (!entity.lootable && entry.sparkle) {
      entry.sparkle.material?.dispose();
      entry.sparkle.dispose();
      entry.sparkle = null;
    }
    if (entry.sparkle) {
      const look = entity.template?.look ?? fallback;
      const t = performance.now() / 1000;
      entry.sparkle.position.set(entity.x, entity.y + look.height + 0.35 + Math.sin(t * 2.5) * 0.08, entity.z);
      entry.sparkle.rotation.y = t * 1.5;
    }
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
    entry.sparkle?.material?.dispose();
    entry.sparkle?.dispose();
  }
  function place(entity: MirroredEntity, entry: Drawn): void {
    entry.capsule.position.set(entity.x, entity.y + (entry.capsule.metadata as { halfHeight: number }).halfHeight, entity.z);
    entry.capsule.rotation.y = entity.facing;
    entry.body?.show({ ...entity, dead: (entity.flags & (1 << FLAG.dead)) !== 0 });
  }

  for (const entity of mirror.entities.values()) add(entity);
  const offSpawn = mirror.onSpawn(add);
  const offDespawn = mirror.onDespawn(remove);

  return {
    update: () => {
      for (const [id, entry] of drawn) {
        const entity = mirror.entities.get(id);
        if (!entity) continue;
        dress(entity, entry);
        glint(entity, entry);
        place(entity, entry);
      }
      placeRing();
    },
    entityOf: (mesh) => ids.get(mesh) ?? null,
    swing: (id) => drawn.get(id)?.body?.swing(),
    setTarget: (id) => {
      targetId = id;
      placeRing();
    },
    dispose: () => {
      offSpawn();
      offDespawn();
      ring.material?.dispose();
      ring.dispose();
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
