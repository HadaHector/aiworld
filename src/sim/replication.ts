import type { Entity } from "./entity";
import type { GameRules } from "./rules/gameRules";
import type { AuraState, CombatEvent, EntityMotion, ResourceValue, ServerMessage, StatValue } from "./protocol";
import { statValues } from "./stats";
import { EVENT_KIND } from "./skills/events";

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
  /** What it was last told of the unit's combat (ABILITIES.md, *Messages*), as short signatures. */
  cast: string;
  auras: string;
  flags: number;
  target: number;
  spells: string;
}

/** A combat event, and where it happened. */
export interface PlacedEvent {
  event: CombatEvent;
  dimension: string;
}

/**
 * What one client is told of the entities around its player (see ENTITIES.md, *Replication*): spawns
 * as they come into view, the values it may see as they change, its own modifiers, despawns as they
 * leave, and a snapshot of what moved. Keeps the set of entities the client knows.
 */
export interface Replicator {
  /** Every message for this step, in order: despawns, spawns, values, modifiers, then the snapshot.
   *  `viewer` is the client's player, null while it has no body (travelling). */
  update: (viewer: Entity | null, entities: Iterable<Entity>, tick: number, ackSeq: number, time: number, events: readonly PlacedEvent[]) => ServerMessage[];
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
      cast: "",
      auras: "",
      flags: 0,
      target: 0,
      spells: "",
    };
    if (entity.stats) k.stats.set(statValues(entity.stats));
    if (entity.resources) {
      k.current.set(entity.resources.current);
      k.max.set(entity.resources.max);
    }
    return k;
  }

  /** Cast bars, auras, flags and targets of a unit that have changed since the client was told. */
  function combatMessages(entity: Entity, own: boolean, k: Known, out: ServerMessage[]): void {
    const combat = entity.combat;
    if (!combat) return;
    const casting = combat.casting;
    const castSig = casting ? `${casting.id}:${casting.state}` : "";
    if (castSig !== k.cast) {
      k.cast = castSig;
      if (casting) {
        const state = casting.skill.states[casting.state];
        out.push({ type: "entityCast", id: entity.id, skill: casting.skill.index, start: casting.stateStart, length: casting.stateEnds - casting.stateStart, channel: state.bar === "channel" });
      } else out.push({ type: "entityCast", id: entity.id, skill: -1, start: 0, length: 0, channel: false });
    }
    const auras: AuraState[] = [];
    for (const m of combat.magics) {
      if (m.ended || m.skill.display === "hidden") continue;
      auras.push({ magic: m.id, skill: m.skill.index, caster: m.caster, stacks: m.stacks, start: m.stateStart, ends: Number.isFinite(m.stateEnds) ? m.stateEnds : 0 });
    }
    const auraSig = auras.map((a) => `${a.magic}:${a.stacks}:${a.start}:${a.ends}`).join(",");
    if (auraSig !== k.auras) {
      k.auras = auraSig;
      out.push({ type: "entityAuras", id: entity.id, auras });
    }
    if (combat.flags.bits !== k.flags) {
      k.flags = combat.flags.bits;
      out.push({ type: "entityFlags", id: entity.id, flags: combat.flags.bits });
    }
    if (combat.target !== k.target) {
      k.target = combat.target;
      out.push({ type: "entityTarget", id: entity.id, target: combat.target });
    }
    if (own) {
      const spellSig = `${combat.gcdUntil}|${combat.attacking}|${combat.spells.map((sp) => `${sp.skill}:${sp.level}:${sp.ready}`).join(",")}`;
      if (spellSig !== k.spells) {
        k.spells = spellSig;
        out.push({ type: "entitySpells", id: entity.id, spells: combat.spells.map(({ skill, level, ready }) => ({ skill, level, ready })), gcdUntil: combat.gcdUntil, attacking: combat.attacking });
      }
    }
  }

  function update(viewer: Entity | null, entities: Iterable<Entity>, tick: number, ackSeq: number, time: number, events: readonly PlacedEvent[]): ServerMessage[] {
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
      combatMessages(entity, own, k, valueMessages);
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
    // Events the client may see: those whose source or target it has in view, and its own failed casts.
    if (viewer) {
      const seen = events
        .filter(({ event, dimension }) => dimension === viewer.dimension && (event.kind === EVENT_KIND.castFailed ? event.source === viewer.id : inView.has(event.source) || inView.has(event.target)))
        .map(({ event }) => event);
      if (seen.length > 0) out.push({ type: "combatEvents", events: seen });
    }
    out.push({ type: "snapshot", tick, time, ackSeq, entities: motion });
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
