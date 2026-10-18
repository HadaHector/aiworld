import type { DimensionDef } from "../../world/content/dimensions";
import { hashString } from "../../world/content/dimensions";
import { deriveSeed, mulberry32 } from "../../world/rng";
import type { Dimension } from "../dimension";
import { entityStat, type Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import type { CreatureKind, CreatureRules } from "../rules/creatureRules";
import type { SkillSystem } from "../skills/system";
import { setBase } from "../stats";
import { restore, syncMaxima } from "../resources";
import { isAlive } from "../skills/unit";
import { createBrain, stepBrain, type BrainWorld } from "./brain";
import type { CreaturePart } from "./creature";
import { createSpawnPointField, respawnSpot, type SpawnMember, type SpawnPoint, type SpawnPointField } from "./spawnPoints";
import type { WorldDelta } from "./worldDelta";
import { createZones, type Zone } from "./zones";

/** A creature died: who gets the credit - what progression (step 8) will turn into XP. */
export interface KillRecord {
  creature: number;
  kind: string;
  level: number;
  dimension: string;
  /** Everyone on its threat table when it died, most threat first. */
  credit: number[];
  time: number;
}

/** What the server gives the creature system. */
export interface CreatureWorld {
  seed: number;
  time(): number;
  entity(id: number): Entity | undefined;
  /** Makes an entity of a template on the ground at a point, under a stable key. */
  spawn(dimension: string, template: string, x: number, z: number, facing: number, key?: string): Entity | undefined;
  /** Takes an entity out of its dimension: off every table, its loot freed. */
  despawn(entity: Entity): void;
  /** The players standing in a dimension (with a body). */
  playersIn(dimension: string): readonly Entity[];
  lineOfSight(dimension: string, from: Entity, to: Entity): boolean;
  /** Whether a corpse still holds loot nobody has taken. */
  hasLoot(entity: Entity): boolean;
  delta: WorldDelta;
}

export interface CreatureSystem {
  /** A dimension has loaded: its zones and spawn points. */
  load(dimension: Dimension, definition: DimensionDef): void;
  /** ...and is dropped: its creatures went with its entities. */
  unload(id: string): void;
  /** Fills points near players, drops those nobody is near, steps every brain and body, lays out
   *  corpses and brings the dead back. Before the skill system's step. */
  step(deltaSeconds: number): void;
  /** Kills since the last drain. */
  drainKills(): KillRecord[];
  readonly debug: {
    /** A dimension's zones. */
    zones(dimension: string): readonly Zone[];
    /** The zone at a point. */
    zoneAt(dimension: string, x: number, z: number): Zone | undefined;
    /** Spawn points near a point. */
    points(dimension: string, x: number, z: number, radius: number): SpawnPoint[];
    /** Makes a creature of a kind at a point, belonging to no spawn point. */
    spawn(dimension: string, kind: string, x: number, z: number, level?: number): Entity | undefined;
    /** Every creature in a dimension. */
    creatures(dimension: string): Entity[];
  };
}

/** A spawn point a player is near: which of its members stand, by member index. */
interface Active {
  point: SpawnPoint;
  members: (Entity | null)[];
  /** Server time a player was last within the release radius. */
  lastNear: number;
}

interface DimensionState {
  dimension: Dimension;
  definition: DimensionDef;
  zones: Zone[];
  field: SpawnPointField;
  active: Map<string, Active>;
  /** Creatures made by debug, belonging to no point. */
  loose: Set<Entity>;
  /** When a player was last near each loose one. */
  looseNear: Map<Entity, number>;
}

/** Seconds between the spawner's looks round: points filling and releasing need not be every step. */
const SPAWN_EVERY = 0.5;
/** Seconds between drops of passed delta entries. */
const PRUNE_EVERY = 10;

export function createCreatureSystem(rules: GameRules, creatures: CreatureRules, skills: SkillSystem, world: CreatureWorld): CreatureSystem {
  const { config } = creatures;
  const states = new Map<string, DimensionState>();
  const kills: KillRecord[] = [];
  const streams = new WeakMap<Entity, () => number>();
  /** How many times each member has come back - part of where it comes back. */
  const comebacks = new Map<string, number>();
  let nextSpawnLook = 0;
  let nextPrune = 0;
  const levelStat = rules.statIndex.get("level");

  /** Makes a creature of a kind at a level, standing on the ground, with a brain. */
  function make(state: DimensionState, kind: CreatureKind, level: number, x: number, z: number, key: string, point: SpawnPoint | null, member: SpawnMember | null): Entity | undefined {
    const random = mulberry32(deriveSeed(world.seed, hashString(`${key}#${comebacks.get(key) ?? 0}`)));
    const entity = world.spawn(state.dimension.id, kind.id, x, z, random() * Math.PI * 2, key || undefined);
    if (!entity) return undefined;
    // Its level, and what each level adds to its stats.
    if (entity.stats) {
      if (levelStat !== undefined) setBase(entity.stats, levelStat, level);
      for (const { stat, value } of kind.perLevel) {
        const base = kind.template.stats.find((s) => s.stat === stat)?.value ?? rules.stats[stat].default;
        setBase(entity.stats, stat, base + value * (level - 1));
      }
      if (entity.resources) {
        syncMaxima(entity.resources, entity.stats);
        for (const r of entity.resources.has) restore(entity.resources, r, rules.resources[r].start * entity.resources.max[r] - entity.resources.current[r]);
      }
    }
    if (member?.name) entity.name = member.name;
    entity.body = state.dimension.createBody(x, z);
    entity.body.face(entity.facing);
    follow(entity);
    const part: CreaturePart = {
      kind,
      point,
      member,
      group: point ? point.key : `#${entity.id}`,
      level,
      home: { x, z },
      wander: member?.wander ?? kind.wander,
      brain: createBrain(world.time()),
      input: { moveX: 0, moveZ: 0, run: false, jump: false },
      diedAt: -1,
      emptiedAt: -1,
    };
    part.brain.until = world.time() + random() * 4;
    entity.creature = part;
    streams.set(entity, random);
    return entity;
  }

  function follow(entity: Entity): void {
    if (!entity.body) return;
    const { feet, grounded } = entity.body.motor.state;
    entity.x = feet.x;
    entity.y = feet.y;
    entity.z = feet.z;
    entity.facing = entity.body.facing;
    entity.grounded = grounded;
  }

  function makeMember(state: DimensionState, active: Active, index: number): void {
    const member = active.point.members[index];
    const back = comebacks.get(member.key) ?? 0;
    const at = back === 0 ? { x: member.homeX, z: member.homeZ } : respawnSpot(active.point, member, back, state.field.open);
    active.members[index] = make(state, member.kind, member.level, at.x, at.z, member.key, active.point, member) ?? null;
  }

  /** Whether a creature is busy with a fight - not to be dropped from under it. */
  const fighting = (entity: Entity): boolean => !entity.combat?.dead && (entity.creature!.brain.state === "combat" || entity.creature!.brain.state === "evade" || entity.creature!.brain.state === "flee");

  /** A creature has died: the delta says when it comes back, and its killers get the credit. */
  function died(entity: Entity, now: number): void {
    const part = entity.creature!;
    part.diedAt = now;
    const member = part.member;
    if (member) {
      const random = streams.get(entity) ?? Math.random;
      world.delta.set(member.key, now + member.respawn[0] + random() * (member.respawn[1] - member.respawn[0]));
      comebacks.set(member.key, (comebacks.get(member.key) ?? 0) + 1);
    }
    // Nobody reading them (no progression yet): only the latest are kept.
    if (kills.length >= 256) kills.shift();
    kills.push({ creature: entity.id, kind: part.kind.id, level: part.level, dimension: entity.dimension, credit: [...(entity.combat?.killers ?? [])], time: now });
  }

  /** Whether a corpse has lain long enough: its time, or a while once emptied. */
  function corpseGone(entity: Entity, now: number): boolean {
    const part = entity.creature!;
    if (part.emptiedAt < 0 && !world.hasLoot(entity) && now - part.diedAt > 0.5) part.emptiedAt = now;
    return now - part.diedAt > config.corpse.time || (part.emptiedAt >= 0 && now - part.emptiedAt > config.corpse.emptied);
  }

  function brainWorld(state: DimensionState, now: number): BrainWorld {
    return {
      rules,
      creatures,
      skills,
      now,
      entity: world.entity,
      playersIn: world.playersIn,
      lineOfSight: world.lineOfSight,
      open: state.field.open,
      random: (creature) => (streams.get(creature) ?? Math.random)(),
      groupOf(creature) {
        const point = creature.creature?.point;
        const active = point && state.active.get(point.key);
        return active ? active.members.filter((m): m is Entity => m !== null && m !== creature && isAlive(m)) : [];
      },
    };
  }

  function stepDimension(state: DimensionState, deltaSeconds: number, now: number, look: boolean): void {
    const players = world.playersIn(state.dimension.id);
    if (look) {
      // Points near a player fill; points nobody is near for long enough are dropped.
      for (const player of players) {
        for (const point of state.field.near(player.x, player.z, config.activeRadius)) {
          if (!state.active.has(point.key)) state.active.set(point.key, { point, members: point.members.map(() => null), lastNear: now });
        }
      }
      for (const [key, active] of state.active) {
        if (players.some((p) => Math.hypot(p.x - active.point.x, p.z - active.point.z) <= config.releaseRadius)) active.lastNear = now;
        else if (now - active.lastNear > config.releaseAfter && !active.members.some((m) => m && fighting(m))) {
          for (const m of active.members) if (m) world.despawn(m);
          state.active.delete(key);
        }
      }
      for (const entity of state.loose) {
        if (players.some((p) => Math.hypot(p.x - entity.x, p.z - entity.z) <= config.releaseRadius)) state.looseNear.set(entity, now);
        else if (now - (state.looseNear.get(entity) ?? now) > config.releaseAfter && !fighting(entity)) {
          world.despawn(entity);
          state.loose.delete(entity);
          state.looseNear.delete(entity);
        }
      }
    }

    const think = brainWorld(state, now);
    const each = (entity: Entity): boolean => {
      // Gone from under it (despawned by debug): forget it.
      if (state.dimension.entities.get(entity.id) !== entity) return false;
      const part = entity.creature!;
      if (entity.combat?.dead) {
        if (part.diedAt < 0) died(entity, now);
        if (corpseGone(entity, now)) {
          world.despawn(entity);
          return false;
        }
        return true;
      }
      stepBrain(think, entity);
      if (entity.body) {
        const { x, y, z } = entity;
        const speed = entityStat(rules, entity, "speed", 1);
        const input = part.input;
        const still = input.moveX === 0 && input.moveZ === 0 && !entity.body.pushed && entity.grounded;
        if (!still) {
          entity.body.step(deltaSeconds, input, speed);
          const facing = entity.body.facing;
          follow(entity);
          entity.facing = facing;
          if (entity.combat && !entity.body.pushed && (input.moveX !== 0 || input.moveZ !== 0) && Math.hypot(entity.x - x, entity.y - y, entity.z - z) > 0.02) entity.combat.moved = true;
        } else {
          entity.facing = entity.body.facing;
        }
      }
      return true;
    };
    for (const active of state.active.values()) {
      active.members.forEach((entity, i) => {
        if (entity && !each(entity)) active.members[i] = null;
        // Not standing, and the delta does not hold it back: made (again).
        if (!active.members[i] && look && world.delta.get(active.point.members[i].key) === undefined) makeMember(state, active, i);
      });
    }
    for (const entity of state.loose) {
      if (!each(entity)) {
        state.loose.delete(entity);
        state.looseNear.delete(entity);
      }
    }
  }

  return {
    load(dimension, definition) {
      const zones = createZones(dimension.world, creatures, definition.spawn);
      const keepOut = [definition.spawn, ...definition.links.map((l) => l.at), ...definition.entities.map((e) => e.at)];
      const field = createSpawnPointField(dimension.id, dimension.world, creatures, zones, keepOut);
      states.set(dimension.id, { dimension, definition, zones, field, active: new Map(), loose: new Set(), looseNear: new Map() });
    },
    unload(id) {
      states.delete(id);
    },
    step(deltaSeconds) {
      const now = world.time();
      const look = now >= nextSpawnLook;
      if (look) nextSpawnLook = now + SPAWN_EVERY;
      if (now >= nextPrune) {
        nextPrune = now + PRUNE_EVERY;
        world.delta.prune(now);
      }
      for (const state of states.values()) stepDimension(state, deltaSeconds, now, look);
    },
    drainKills: () => kills.splice(0, kills.length),
    debug: {
      zones: (dimension) => states.get(dimension)?.zones ?? [],
      zoneAt(dimension, x, z) {
        const state = states.get(dimension);
        return state?.zones[state.dimension.world.sampleTerrain(x, z).primaryAreaId];
      },
      points: (dimension, x, z, radius) => states.get(dimension)?.field.near(x, z, radius) ?? [],
      spawn(dimension, kindId, x, z, level) {
        const state = states.get(dimension);
        const kind = creatures.kinds.get(kindId);
        if (!state || !kind) return undefined;
        const zone = state.zones[state.dimension.world.sampleTerrain(x, z).primaryAreaId];
        const entity = make(state, kind, Math.max(1, Math.floor(level ?? zone?.levels[0] ?? 1)), x, z, "", null, null);
        if (entity) {
          state.loose.add(entity);
          state.looseNear.set(entity, world.time());
        }
        return entity;
      },
      creatures(dimension) {
        const state = states.get(dimension);
        if (!state) return [];
        return [...state.dimension.entities.values()].filter((e) => e.creature);
      },
    },
  };
}
