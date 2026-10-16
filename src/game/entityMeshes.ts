import { Color3, MeshBuilder, StandardMaterial, type Mesh, type Scene } from "@babylonjs/core";
import type { EntityMirror, MirroredEntity } from "./entityMirror";
import { PLAYER_TEMPLATE, type EntityLook, type GameRules } from "../sim/rules/gameRules";

export interface EntityMeshes {
  /** Moves every drawn entity to where the mirror has it - each frame. */
  update: () => void;
  /** The entity a mesh draws, for picking - null for any other mesh. */
  entityOf: (mesh: unknown) => number | null;
  dispose: () => void;
}

/**
 * Every entity the client knows, except its own player, drawn in one dimension's scene from its
 * template's `look` (see ENTITIES.md): a capsule of its size and colour until bodies are built from
 * parts. Other players use the player template's look.
 */
export function createEntityMeshes(scene: Scene, mirror: EntityMirror, rules: GameRules, ownId: () => number): EntityMeshes {
  const meshes = new Map<number, Mesh>();
  const ids = new Map<unknown, number>();
  const fallback = rules.templates.get(PLAYER_TEMPLATE)!.look;

  function add(entity: MirroredEntity): void {
    if (entity.id === ownId() || meshes.has(entity.id)) return;
    const look: EntityLook = entity.template?.look ?? fallback;
    const mesh = MeshBuilder.CreateCapsule(`entity${entity.id}`, { height: look.height, radius: look.radius }, scene);
    const material = new StandardMaterial(`entity${entity.id}Material`, scene);
    material.diffuseColor = new Color3(...look.color);
    material.maxSimultaneousLights = 6;
    mesh.material = material;
    mesh.metadata = { entity: entity.id, halfHeight: look.height / 2 };
    meshes.set(entity.id, mesh);
    ids.set(mesh, entity.id);
    place(entity, mesh);
  }
  function remove(entity: MirroredEntity): void {
    const mesh = meshes.get(entity.id);
    if (!mesh) return;
    meshes.delete(entity.id);
    ids.delete(mesh);
    mesh.material?.dispose();
    mesh.dispose();
  }
  function place(entity: MirroredEntity, mesh: Mesh): void {
    mesh.position.set(entity.x, entity.y + (mesh.metadata as { halfHeight: number }).halfHeight, entity.z);
    mesh.rotation.y = entity.facing;
  }

  for (const entity of mirror.entities.values()) add(entity);
  const offSpawn = mirror.onSpawn(add);
  const offDespawn = mirror.onDespawn(remove);

  return {
    update: () => {
      for (const [id, mesh] of meshes) {
        const entity = mirror.entities.get(id);
        if (entity) place(entity, mesh);
      }
    },
    entityOf: (mesh) => ids.get(mesh) ?? null,
    dispose: () => {
      offSpawn();
      offDespawn();
      for (const entity of [...mirror.entities.values()]) remove(entity);
      for (const mesh of meshes.values()) mesh.dispose();
      meshes.clear();
    },
  };
}
