import type { Entity } from "./entity";
import type { GameRules } from "./rules/gameRules";
import type { EntityMotion, ResourceValue, ServerMessage, StatValue } from "./protocol";
import { statValues } from "./stats";

/** Entities come into a client's view this close to its player, metres... */
export const INTEREST_IN = 150;
/** ...and leave it past this far, so one standing on the edge does not flicker in and out. */
export const INTEREST_OUT = 170;

/** What a client has been told of one entity: the values it was last sent, to send only changes. */
interface Known {
  stats: Float64Array;
  current: Float64Array;
  max: Float64Array;
  modifierVersion: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  grounded: boolean;
}

/**
 * What one client is told of the entities around its player (see ENTITIES.md, *Replication*): spawns
 * as they come into view, the values it may see as they change, its own modifiers, despawns as they
 * leave, and a snapshot of what moved. Keeps the set of entities the client knows.
 */
export interface Replicator {
  /** Every message for this step, in order: despawns, spawns, values, modifiers, then the snapshot.
   *  `viewer` is the client's player, null while it has no body (travelling). */
  update: (viewer: Entity | null, entities: Iterable<Entity>, tick: number, ackSeq: number) => ServerMessage[];
  /** Forgets everything the client was told - on a Transfer, which clears the client's own mirror. */
  reset: () => void;
  /** The ids the client knows now. */
  readonly known: ReadonlySet<number>;
}

export function createReplicator(rules: GameRules): Replicator {
  const known = new Map<number, Known>();
  const ids = new Set<number>();
  const statsAll = rules.stats.filter((s) => s.visible === "all").map((s) => s.index);
  const statsOwner = rules.stats.map((s) => s.index);
  const resourcesAll = new Set(rules.resources.filter((r) => r.visible === "all").map((r) => r.index));

  /** The values `viewer` may see of `entity`, and those that differ from `last` (all of them if null). */
  function values(entity: Entity, own: boolean, last: Known | null): { stats: StatValue[]; resources: ResourceValue[] } {
    const stats: StatValue[] = [];
    const resources: ResourceValue[] = [];
    if (entity.stats) {
      const v = statValues(entity.stats);
      for (const stat of own ? statsOwner : statsAll) if (!last || last.stats[stat] !== v[stat]) stats.push({ stat, value: v[stat] });
    }
    const block = entity.resources;
    if (block) {
      for (const resource of block.has) {
        if (!own && !resourcesAll.has(resource)) continue;
        const current = block.current[resource];
        const max = block.max[resource];
        if (!last || last.current[resource] !== current || last.max[resource] !== max) resources.push({ resource, current, max });
      }
    }
    return { stats, resources };
  }

  function remember(entity: Entity, into: Known | null): Known {
    const k = into ?? {
      stats: new Float64Array(rules.stats.length),
      current: new Float64Array(rules.resources.length),
      max: new Float64Array(rules.resources.length),
      modifierVersion: -1,
      x: 0,
      y: 0,
      z: 0,
      facing: 0,
      grounded: false,
    };
    if (entity.stats) k.stats.set(statValues(entity.stats));
    if (entity.resources) {
      k.current.set(entity.resources.current);
      k.max.set(entity.resources.max);
    }
    return k;
  }

  function update(viewer: Entity | null, entities: Iterable<Entity>, tick: number, ackSeq: number): ServerMessage[] {
    const out: ServerMessage[] = [];
    // Who is in view: everything near the viewer, with some slack for what it already knows.
    const inView = new Map<number, Entity>();
    if (viewer) {
      for (const entity of entities) {
        const distance = Math.hypot(entity.x - viewer.x, entity.z - viewer.z);
        if (entity === viewer || distance <= INTEREST_IN || (known.has(entity.id) && distance <= INTEREST_OUT)) inView.set(entity.id, entity);
      }
    }
    for (const id of [...known.keys()]) {
      if (inView.has(id)) continue;
      out.push({ type: "entityDespawn", id });
      known.delete(id);
      ids.delete(id);
    }
    const valueMessages: ServerMessage[] = [];
    const motion: EntityMotion[] = [];
    let modifiers: ServerMessage | null = null;
    for (const entity of inView.values()) {
      const own = entity === viewer;
      const last = known.get(entity.id) ?? null;
      if (!last) {
        const { stats, resources } = values(entity, own, null);
        out.push({ type: "entitySpawn", id: entity.id, template: entity.template.id, name: entity.name, look: entity.look, x: entity.x, y: entity.y, z: entity.z, facing: entity.facing, stats, resources });
      } else {
        const { stats, resources } = values(entity, own, last);
        if (stats.length > 0 || resources.length > 0) valueMessages.push({ type: "entityValues", id: entity.id, stats, resources });
      }
      const k = remember(entity, last);
      known.set(entity.id, k);
      ids.add(entity.id);
      if (own && entity.stats && entity.stats.modifierVersion !== k.modifierVersion) {
        k.modifierVersion = entity.stats.modifierVersion;
        modifiers = { type: "entityModifiers", id: entity.id, modifiers: entity.stats.modifiers.map(({ stat, kind, value, source }) => ({ stat, kind, value, source })) };
      }
      const moved = !last || own || k.x !== entity.x || k.y !== entity.y || k.z !== entity.z || k.facing !== entity.facing || k.grounded !== entity.grounded;
      if (moved && last) motion.push({ id: entity.id, x: entity.x, y: entity.y, z: entity.z, facing: entity.facing, grounded: entity.grounded });
      k.x = entity.x;
      k.y = entity.y;
      k.z = entity.z;
      k.facing = entity.facing;
      k.grounded = entity.grounded;
    }
    // The own player's motion goes in every snapshot, even on the step it spawns.
    if (viewer && !motion.some((m) => m.id === viewer.id)) motion.push({ id: viewer.id, x: viewer.x, y: viewer.y, z: viewer.z, facing: viewer.facing, grounded: viewer.grounded });
    out.push(...valueMessages);
    if (modifiers) out.push(modifiers);
    out.push({ type: "snapshot", tick, ackSeq, entities: motion });
    return out;
  }

  return {
    update,
    reset: () => {
      known.clear();
      ids.clear();
    },
    known: ids,
  };
}
