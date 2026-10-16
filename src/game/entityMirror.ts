import type { GameRules, TemplateDef } from "../sim/rules/gameRules";
import type { EntityMotion, ModifierState, ServerMessage } from "../sim/protocol";

/** One entity as the client knows it: only what the server has told it (see ENTITIES.md). */
export interface MirroredEntity {
  id: number;
  /** Its template from the client's own packs - null if they lack it (different packs). */
  template: TemplateDef | null;
  templateId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  facing: number;
  grounded: boolean;
  /** Stat values by index; only those the client may see are set. */
  stats: Map<number, number>;
  /** Resources by index: current and maximum. */
  resources: Map<number, { current: number; max: number }>;
  /** The modifier stack - the client's own player only. */
  modifiers: ModifierState[];
}

/**
 * Every entity the client knows, as the server's spawn, values, modifiers, despawn and snapshot
 * messages have said - page-wide, cleared on a Transfer. The client's only source for anything
 * about an entity: it never works a value out itself.
 */
export interface EntityMirror {
  readonly entities: ReadonlyMap<number, MirroredEntity>;
  /** Takes one message from the server; returns whether it was one of the mirror's. */
  apply: (message: ServerMessage) => boolean;
  clear: () => void;
  /** Called with each entity as it is added and removed - what draws them listens. */
  onSpawn: (listener: (entity: MirroredEntity) => void) => () => void;
  onDespawn: (listener: (entity: MirroredEntity) => void) => () => void;
}

export function createEntityMirror(rules: GameRules): EntityMirror {
  const entities = new Map<number, MirroredEntity>();
  const spawnListeners = new Set<(entity: MirroredEntity) => void>();
  const despawnListeners = new Set<(entity: MirroredEntity) => void>();

  const move = (entity: MirroredEntity, m: EntityMotion): void => {
    entity.x = m.x;
    entity.y = m.y;
    entity.z = m.z;
    entity.facing = m.facing;
    entity.grounded = m.grounded;
  };
  const remove = (id: number): void => {
    const gone = entities.get(id);
    if (!gone) return;
    entities.delete(id);
    for (const listener of despawnListeners) listener(gone);
  };

  function apply(message: ServerMessage): boolean {
    switch (message.type) {
      case "entitySpawn": {
        remove(message.id);
        const entity: MirroredEntity = {
          id: message.id,
          template: rules.templates.get(message.template) ?? null,
          templateId: message.template,
          name: message.name,
          x: message.x,
          y: message.y,
          z: message.z,
          facing: message.facing,
          grounded: true,
          stats: new Map(message.stats.map((s) => [s.stat, s.value])),
          resources: new Map(message.resources.map((r) => [r.resource, { current: r.current, max: r.max }])),
          modifiers: [],
        };
        entities.set(entity.id, entity);
        for (const listener of spawnListeners) listener(entity);
        return true;
      }
      case "entityValues": {
        const entity = entities.get(message.id);
        if (!entity) return true;
        for (const s of message.stats) entity.stats.set(s.stat, s.value);
        for (const r of message.resources) entity.resources.set(r.resource, { current: r.current, max: r.max });
        return true;
      }
      case "entityModifiers": {
        const entity = entities.get(message.id);
        if (entity) entity.modifiers = message.modifiers;
        return true;
      }
      case "entityDespawn":
        remove(message.id);
        return true;
      case "snapshot":
        for (const m of message.entities) {
          const entity = entities.get(m.id);
          if (entity) move(entity, m);
        }
        return false; // the page reads its own player's motion from it too
      default:
        return false;
    }
  }

  const listen = <T>(set: Set<T>, listener: T): (() => void) => {
    set.add(listener);
    return () => set.delete(listener);
  };

  return {
    entities,
    apply,
    clear: () => {
      for (const id of [...entities.keys()]) remove(id);
    },
    onSpawn: (listener) => listen(spawnListeners, listener),
    onDespawn: (listener) => listen(despawnListeners, listener),
  };
}
