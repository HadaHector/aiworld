import type { GameRules, TemplateDef } from "../sim/rules/gameRules";
import type { AuraState, EntityAppearance, EntityMotion, ModifierState, ServerMessage, SpellState } from "../sim/protocol";

/** One entity as the client knows it: only what the server has told it (see ENTITIES.md). */
export interface MirroredEntity {
  id: number;
  /** Its template from the client's own packs - null if they lack it (different packs). */
  template: TemplateDef | null;
  templateId: string;
  name: string;
  /** Who it is to look at, over its template's look: its seed, and a player's race and outfit. */
  look: EntityAppearance;
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
  /** Its cast bar, if it is casting (ABILITIES.md, *Messages*): times are the server's. */
  cast: { skill: number; start: number; length: number; channel: boolean } | null;
  /** The buffs and debuffs shown on it. */
  auras: AuraState[];
  /** The control flags it holds, a bit each (FLAG_NAMES' order). */
  flags: number;
  /** Whom it has selected, 0 for nobody. */
  target: number;
  /** The item types it shows on its body (ITEMS.md, *Equipment*); null until told - its template's
   *  outfit shows. */
  gear: string[] | null;
  /** Whether it has loot to take: a corpse, a chest, an item on the ground. */
  lootable: boolean;
}

/** What the client's own player knows and can do: its spells, its GCD, whether it auto-attacks. */
export interface OwnSpells {
  spells: SpellState[];
  gcdUntil: number;
  attacking: boolean;
}

/**
 * Every entity the client knows, as the server's spawn, values, modifiers, despawn and snapshot
 * messages have said - page-wide, cleared on a Transfer. The client's only source for anything
 * about an entity: it never works a value out itself.
 */
export interface EntityMirror {
  readonly entities: ReadonlyMap<number, MirroredEntity>;
  /** The own player's spells, as the server last said. */
  readonly own: OwnSpells;
  /** The server's clock now, as near as the client can tell: the last snapshot's time, run on. */
  serverTime: () => number;
  /** Takes one message from the server; returns whether it was one of the mirror's. */
  apply: (message: ServerMessage) => boolean;
  clear: () => void;
  /** Called with each entity as it is added and removed - what draws them listens. */
  onSpawn: (listener: (entity: MirroredEntity) => void) => () => void;
  onDespawn: (listener: (entity: MirroredEntity) => void) => () => void;
}

export function createEntityMirror(rules: GameRules): EntityMirror {
  const entities = new Map<number, MirroredEntity>();
  const own: OwnSpells = { spells: [], gcdUntil: 0, attacking: false };
  let time = 0;
  let timeAt = performance.now();
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
          look: message.look,
          x: message.x,
          y: message.y,
          z: message.z,
          facing: message.facing,
          grounded: true,
          stats: new Map(message.stats.map((s) => [s.stat, s.value])),
          resources: new Map(message.resources.map((r) => [r.resource, { current: r.current, max: r.max }])),
          modifiers: [],
          cast: null,
          auras: [],
          flags: 0,
          target: 0,
          gear: null,
          lootable: false,
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
      case "entityCast": {
        const entity = entities.get(message.id);
        if (entity) entity.cast = message.skill < 0 ? null : { skill: message.skill, start: message.start, length: message.length, channel: message.channel };
        return true;
      }
      case "entityAuras": {
        const entity = entities.get(message.id);
        if (entity) entity.auras = message.auras;
        return true;
      }
      case "entityFlags": {
        const entity = entities.get(message.id);
        if (entity) entity.flags = message.flags;
        return true;
      }
      case "entityGear": {
        const entity = entities.get(message.id);
        if (entity) entity.gear = message.gear;
        return true;
      }
      case "entityLootable": {
        const entity = entities.get(message.id);
        if (entity) entity.lootable = message.lootable;
        return true;
      }
      case "entityTarget": {
        const entity = entities.get(message.id);
        if (entity) entity.target = message.target;
        return true;
      }
      case "entitySpells":
        own.spells = message.spells;
        own.gcdUntil = message.gcdUntil;
        own.attacking = message.attacking;
        return true;
      case "snapshot":
        time = message.time;
        timeAt = performance.now();
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
    own,
    serverTime: () => time + (performance.now() - timeAt) / 1000,
    apply,
    clear: () => {
      for (const id of [...entities.keys()]) remove(id);
      own.spells = [];
      own.attacking = false;
    },
    onSpawn: (listener) => listen(spawnListeners, listener),
    onDespawn: (listener) => listen(despawnListeners, listener),
  };
}
