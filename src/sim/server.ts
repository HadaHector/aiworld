import { dimensionSeed, type DimensionDef } from "../world/content/dimensions";
import { createDimension, type Dimension, type DimensionWorld } from "./dimension";
import type { BodyInput } from "./playerBody";
import { PROTOCOL_VERSION, type ClientMessage, type EntityAppearance } from "./protocol";
import { createReplicator, type Replicator } from "./replication";
import { addModifier, removeSource } from "./stats";
import { restore } from "./resources";
import type { ServerEnd } from "./channel";
import { PLAYER_TEMPLATE, type GameRules } from "./rules/gameRules";
import { createEntity, entityStat, stepResources, type Entity } from "./entity";
import { createSkillSystem, type SkillSystem } from "./skills/system";
import { canMove } from "./skills/flags";
import { Layers } from "../world/collision/shapes";
import type { ItemRules } from "./rules/itemRules";
import { createItemSystem, type ItemSystem } from "./items/itemSystem";
import { createItemReplicator, type ItemReplicator } from "./items/itemReplication";
import { handleItemMessage } from "./items/itemMessages";
import type { ItemHooks } from "./items/itemHooks";

/** Each step spends at most this long bringing in collision chunks per dimension (always at least one). */
const CHUNK_BUDGET_MS = 2;

/** One connected client and the player it plays. */
interface Connection {
  end: ServerEnd;
  player: Player | null;
  /** What this client has been told of the entities around its player. */
  replicator: Replicator;
  /** ...and of items: its own, and the gear and loot of what it sees (null without item rules). */
  items: ItemReplicator | null;
}

/** A connected player: its entity, and what its client has said. */
export interface Player {
  /** Its entity: made on Hello, kept until it leaves, from one dimension to the next. Its `body` is
   *  null while travelling - from a Transfer until its client has Arrived and the dimension is loaded. */
  readonly entity: Entity;
  /** Where the body goes once it can be made. */
  arrival: { x: number; z: number };
  /** Whether the client has said Arrived since the last Transfer. */
  arrived: boolean;
  /** The latest intent; a jump stays set until a step takes it. */
  input: BodyInput;
  ackSeq: number;
}

/** A dimension the server has asked its host for: loading, then loaded. */
interface Slot {
  dimension: Dimension | null;
  /** Set when nobody wants it any more: a load still running is thrown away when it finishes. */
  dropped: boolean;
}

export interface ServerOptions {
  /** The world seed: the start dimension's own, and the root of every other's (see DIMENSIONS.md). */
  seed: number;
  /** Which world config the server runs, by name - told to every client that joins. */
  config: string;
  /** Which packs it runs, by id - told to every client that joins. */
  packs?: string[];
  /** Every dimension the config keeps. */
  dimensions: readonly DimensionDef[];
  /** Stats, resources and entity templates (see ENTITIES.md). */
  rules: GameRules;
  /**
   * Makes a dimension's world, when the first player heads for it. The host's: in Node, it resolves
   * the dimension's content from disk and generates it; in the page, it hands over the page's own
   * build of it, so nothing is generated twice.
   */
  loadDimension: (definition: DimensionDef, seed: number) => DimensionWorld | Promise<DimensionWorld>;
  /** Called when a load fails; the players waiting for it stay waiting. */
  onLoadError?: (definition: DimensionDef, error: unknown) => void;
  /** Item types, slots, currencies and loot (see ITEMS.md); left out, nobody has items. */
  items?: ItemRules;
  /** How items cast skills - the ability system's own hooks unless a host says otherwise. */
  itemHooks?: ItemHooks;
}

export interface Server {
  /** Takes a client: it says Hello, and is a player from the next step. */
  connect: (end: ServerEnd) => void;
  /** Reads every client's messages, moves every player, and sends each client a snapshot. */
  step: (deltaSeconds: number) => void;
  readonly tick: number;
  /** For hosts and debugging - not for clients, which only see messages. */
  readonly debug: {
    readonly rules: GameRules;
    /** The dimensions loaded now, by id. */
    readonly dimensions: ReadonlyMap<string, Dimension>;
    /** Every connected player, by its entity's id. */
    readonly players: ReadonlyMap<number, Player>;
    /** Any entity by id - a player's (wherever it is), or one in a loaded dimension. */
    entity: (id: number) => Entity | undefined;
    /** The ability system (ABILITIES.md). */
    readonly skills: SkillSystem;
    /** The item system (ITEMS.md), null without item rules. */
    readonly items: ItemSystem | null;
  };
  /** The server's clock: seconds stepped since it started. */
  readonly time: number;
}

/**
 * The simulation: the players, the dimensions they are in, the entities in those (see ENTITIES.md),
 * and each dimension's collision around them (see DIMENSIONS.md). A dimension is loaded when the
 * first player heads for it and dropped when the last one leaves. Everything it knows comes from its
 * host (the seed, the packs, the worlds it is handed) and from its clients' messages; everything it
 * tells them goes out as messages. No Babylon, no browser: the same server runs inside the page for
 * single player and on its own in Node (see SIMULATION.md).
 */
export function createServer(options: ServerOptions): Server {
  const { rules } = options;
  const definitions = new Map(options.dimensions.map((def) => [def.id, def]));
  const start = options.dimensions.find((def) => def.start) ?? options.dimensions[0];
  if (!start) throw new Error("A server needs at least one dimension");
  const playerTemplate = rules.templates.get(PLAYER_TEMPLATE);
  if (!playerTemplate) throw new Error(`The game rules have no "${PLAYER_TEMPLATE}" template`);

  const connections: Connection[] = [];
  const players = new Map<number, Player>();
  const slots = new Map<string, Slot>();
  const loaded = new Map<string, Dimension>();
  let nextId = 1;
  let tick = 0;
  let time = 0;

  /** Any entity by id: a player's wherever it is, or one in a loaded dimension. */
  function findEntity(id: number): Entity | undefined {
    const player = players.get(id);
    if (player) return player.entity;
    for (const dimension of loaded.values()) {
      const entity = dimension.entities.get(id);
      if (entity) return entity;
    }
    return undefined;
  }

  /** Makes an entity of a template standing on the ground at a point, with its spells. */
  function spawnIn(dimension: Dimension, template: string, x: number, z: number, facing: number, key?: string): Entity | undefined {
    const def = rules.templates.get(template);
    if (!def) return undefined;
    const id = nextId++;
    const entity = createEntity(rules, def, id, { dimension: dimension.id, x, y: dimension.groundAt(x, z), z, facing, key });
    dimension.entities.set(id, entity);
    skills.adopt(entity);
    itemSystem?.adopt(entity);
    return entity;
  }

  const skills = createSkillSystem(rules, {
    seed: options.seed,
    time: () => time,
    tick: () => tick,
    entity: findEntity,
    entitiesIn: (dimension) => loaded.get(dimension)?.entities.values() ?? [],
    lineOfSight(dimension, from, to) {
      const world = loaded.get(dimension)?.collision.world;
      if (!world) return true;
      const eye = (e: Entity) => Math.min(rules.combat.losHeight, e.template.look.height * 0.9);
      const origin = { x: from.x, y: from.y + eye(from), z: from.z };
      const dx = to.x - from.x;
      const dy = to.y + eye(to) - origin.y;
      const dz = to.z - from.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance < 1e-6) return true;
      return !world.raycastAny(origin, { x: dx / distance, y: dy / distance, z: dz / distance }, distance, Layers.sight);
    },
    spawn: (dimension, template, x, z, facing) => {
      const dim = loaded.get(dimension);
      return dim ? spawnIn(dim, template, x, z, facing) : undefined;
    },
    despawn: (entity) => {
      skills.leave(entity, true);
      loaded.get(entity.dimension)?.entities.delete(entity.id);
    },
    push(entity, motion) {
      if (motion.to) {
        if (entity.body) {
          entity.body.teleport(motion.to.x, motion.to.z);
          follow(entity);
        } else {
          entity.x = motion.to.x;
          entity.z = motion.to.z;
        }
        return;
      }
      if (entity.body) entity.body.push(motion);
      else {
        // No body to carry it: it lands where the motion would have taken it.
        let t = motion.duration;
        const speed = Math.max(Math.hypot(motion.vx, motion.vz), 1e-6);
        if (motion.stopAt) t = Math.min(t, Math.max(0, Math.hypot(motion.stopAt.x - entity.x, motion.stopAt.z - entity.z) - motion.stopAt.within) / speed);
        entity.x += motion.vx * t;
        entity.z += motion.vz * t;
        const dimension = loaded.get(entity.dimension);
        if (dimension) entity.y = dimension.groundAt(entity.x, entity.z);
      }
    },
  });

  const itemSystem: ItemSystem | null = options.items
    ? createItemSystem(
        rules,
        options.items,
        {
          seed: options.seed,
          time: () => time,
          entity: findEntity,
          entitiesIn: (dimension) => loaded.get(dimension)?.entities.values() ?? [],
          spawn: (dimension, template, x, z, facing) => {
            const dim = loaded.get(dimension);
            return dim ? spawnIn(dim, template, x, z, facing) : undefined;
          },
          despawn: (entity) => {
            skills.leave(entity, true);
            loaded.get(entity.dimension)?.entities.delete(entity.id);
          },
        },
        options.itemHooks ?? skills.items,
      )
    : null;

  /** Makes the entities a dimension's definition places, standing on its ground. */
  function placeEntities(dimension: Dimension, definition: DimensionDef): void {
    definition.entities.forEach((placed, i) => {
      const template = rules.templates.get(placed.template);
      if (!template) return; // checked when the rules were loaded (checkPlacements)
      spawnIn(dimension, template.id, placed.at.x, placed.at.z, placed.facing, `${dimension.id}/${i}`);
    });
  }

  /** Asks the host for a dimension, unless it is loaded or on its way. */
  function want(id: string): void {
    if (slots.has(id)) return;
    const definition = definitions.get(id)!;
    const slot: Slot = { dimension: null, dropped: false };
    slots.set(id, slot);
    Promise.resolve()
      .then(() => options.loadDimension(definition, dimensionSeed(options.seed, definition)))
      .then(
        (world) => {
          if (slot.dropped) return;
          slot.dimension = createDimension(id, world);
          placeEntities(slot.dimension, definition);
          loaded.set(id, slot.dimension);
        },
        (error) => {
          if (slots.get(id) === slot) slots.delete(id);
          options.onLoadError?.(definition, error);
        },
      );
  }

  /** Drops a dimension nobody is in or heading for - and every entity in it. */
  function release(id: string): void {
    for (const player of players.values()) if (player.entity.dimension === id) return;
    const slot = slots.get(id);
    if (!slot) return;
    slot.dropped = true;
    slots.delete(id);
    loaded.delete(id);
  }

  /** Takes a player out of where it is and sends it to a dimension, at a point. */
  function transfer(connection: Connection, player: Player, to: DimensionDef, at: { x: number; z: number }): void {
    const entity = player.entity;
    const from = entity.dimension;
    skills.leave(entity);
    loaded.get(from)?.entities.delete(entity.id);
    entity.dimension = to.id;
    entity.body = null;
    player.arrival = at;
    player.arrived = false;
    player.input = { moveX: 0, moveZ: 0, run: false, jump: false };
    want(to.id);
    if (from !== to.id) release(from);
    // The client clears what it knows of entities on a Transfer; so does what tells it of them.
    connection.replicator.reset();
    connection.items?.reset();
    connection.end.send({ type: "transfer", dimension: to.id, seed: dimensionSeed(options.seed, to), x: at.x, z: at.z });
  }

  const pointsIn = (id: string): { x: number; z: number }[] =>
    [...players.values()].filter((p) => p.entity.dimension === id && p.entity.body).map((p) => ({ x: p.entity.x, z: p.entity.z }));

  /** Copies a body's capsule into its entity's position. */
  function follow(entity: Entity): void {
    if (!entity.body) return;
    const { feet, grounded } = entity.body.motor.state;
    entity.x = feet.x;
    entity.y = feet.y;
    entity.z = feet.z;
    entity.facing = entity.body.facing;
    entity.grounded = grounded;
  }

  /** A debug command's target: the sender's own player for 0, else an entity in its dimension. */
  function targetOf(player: Player, id: number): Entity | undefined {
    return id === 0 || id === player.entity.id ? player.entity : loaded.get(player.entity.dimension)?.entities.get(id);
  }

  function handle(connection: Connection, message: ClientMessage): void {
    const player = connection.player;
    const body = player?.entity.body;
    // Items (see ITEMS.md): only for a player standing in a dimension.
    if (message.type.startsWith("item") || message.type.startsWith("loot") || message.type === "debugItem" || message.type === "debugWear") {
      if (!itemSystem || !player || !body) return;
      const why = handleItemMessage(itemSystem, player.entity, message);
      if (why) connection.end.send({ type: "itemRefused", reason: why });
      return;
    }
    switch (message.type) {
      case "hello": {
        if (player || message.protocol !== PROTOCOL_VERSION) return;
        const first = definitions.get(message.dimension) ?? start;
        const entity = createEntity(rules, playerTemplate!, nextId++, { dimension: "", x: first.spawn.x, y: 0, z: first.spawn.z, facing: 0, name: message.name, look: message.look && cleanLook(message.look) });
        skills.adopt(entity);
        itemSystem?.adopt(entity);
        const joined: Player = { entity, arrival: first.spawn, arrived: false, input: { moveX: 0, moveZ: 0, run: false, jump: false }, ackSeq: 0 };
        players.set(entity.id, joined);
        connection.player = joined;
        connection.end.send({ type: "welcome", protocol: PROTOCOL_VERSION, playerId: entity.id, config: options.config, packs: options.packs ?? [], rules: rules.hash, items: options.items?.hash ?? 0, seed: options.seed >>> 0 });
        transfer(connection, joined, first, first.spawn);
        return;
      }
      case "intent": {
        if (!player) return;
        const length = Math.hypot(message.moveX, message.moveZ);
        const scale = length > 1 ? 1 / length : 1;
        player.input = { moveX: message.moveX * scale, moveZ: message.moveZ * scale, run: message.run, jump: player.input.jump || message.jump };
        player.ackSeq = message.seq;
        return;
      }
      case "teleport": {
        if (!player || !body) return;
        body.teleport(message.x, message.z);
        follow(player.entity);
        loaded.get(player.entity.dimension)!.streamer.loadAround(message.x, message.z, pointsIn(player.entity.dimension));
        return;
      }
      case "teleportTo": {
        if (!player || !body) return;
        body.teleportTo({ x: message.x, y: message.y, z: message.z });
        follow(player.entity);
        loaded.get(player.entity.dimension)!.streamer.loadAround(message.x, message.z, pointsIn(player.entity.dimension));
        return;
      }
      case "travel": {
        const to = definitions.get(message.dimension);
        if (!player || !to) return;
        const link = definitions.get(player.entity.dimension)?.links.find((l) => l.to === to.id);
        transfer(connection, player, to, link ? link.arrive : to.spawn);
        return;
      }
      case "arrived": {
        if (player) player.arrived = true;
        return;
      }
      // Debug commands on entities (see ENTITIES.md): 0 is the sender's own player.
      case "debugModifier": {
        const target = player && targetOf(player, message.entity);
        if (!target?.stats || !rules.stats[message.stat] || !rules.modifierKinds[message.kind] || !Number.isFinite(message.value)) return;
        addModifier(target.stats, { stat: message.stat, kind: message.kind, value: message.value, source: message.source });
        return;
      }
      case "debugRemoveSource": {
        const target = player && targetOf(player, message.entity);
        if (target?.stats) removeSource(target.stats, message.source);
        return;
      }
      case "debugCombat": {
        const target = player && targetOf(player, message.entity);
        if (target?.combat) target.combat.forceCombat = message.inCombat;
        return;
      }
      case "debugResource": {
        const target = player && targetOf(player, message.entity);
        if (target?.resources && Number.isFinite(message.delta)) restore(target.resources, message.resource, message.delta);
        return;
      }
      case "debugSpawn": {
        const dimension = player && loaded.get(player.entity.dimension);
        const template = rules.templates.get(message.template);
        if (!dimension || !template) return;
        const { x, z } = message;
        spawnIn(dimension, template.id, x, z, Math.atan2(player!.entity.x - x, player!.entity.z - z));
        return;
      }
      case "debugDespawn": {
        const dimension = player && loaded.get(player.entity.dimension);
        const gone = dimension?.entities.get(message.entity);
        if (gone && !players.has(message.entity)) {
          skills.leave(gone, true);
          dimension!.entities.delete(message.entity);
        }
        return;
      }
      case "debugApply": {
        const target = player && targetOf(player, message.entity);
        if (target && rules.skills[message.skill]) skills.apply(message.skill, player!.entity, target);
        return;
      }
      case "debugKill": {
        const target = player && targetOf(player, message.entity);
        if (!target) return;
        if (message.revive) skills.revive(target);
        else skills.kill(target);
        return;
      }
      // Combat (see ABILITIES.md, *Casting*).
      case "target": {
        if (!player) return;
        const id = message.id >>> 0;
        const target = id ? targetOf(player, id) : undefined;
        skills.setTarget(player.entity, target ? target.id : 0);
        return;
      }
      case "cast": {
        if (!player || !player.entity.body || !rules.skills[message.skill]) return;
        const point = Number.isFinite(message.x) && Number.isFinite(message.z) ? { x: message.x, z: message.z } : null;
        skills.cast(player.entity, message.skill, message.target >>> 0, { point, queue: true });
        return;
      }
      case "stopCast": {
        if (player) skills.stopCast(player.entity);
        return;
      }
      case "attack": {
        if (player) skills.setAttacking(player.entity, message.on);
        return;
      }
      case "respawn": {
        if (!player?.entity.combat?.dead || !body) return;
        const spawn = definitions.get(player.entity.dimension)?.spawn ?? start.spawn;
        skills.revive(player.entity);
        body.teleport(spawn.x, spawn.z);
        follow(player.entity);
        loaded.get(player.entity.dimension)?.streamer.loadAround(spawn.x, spawn.z, pointsIn(player.entity.dimension));
        return;
      }
    }
  }

  function step(deltaSeconds: number): void {
    for (let i = connections.length - 1; i >= 0; i--) {
      const connection = connections[i];
      for (const message of connection.end.receive()) handle(connection, message);
      if (connection.end.closed) {
        const gone = connection.player;
        connections.splice(i, 1);
        if (gone) {
          skills.leave(gone.entity);
          players.delete(gone.entity.id);
          loaded.get(gone.entity.dimension)?.entities.delete(gone.entity.id);
          release(gone.entity.dimension);
        }
      }
    }
    // Into the world: every player whose client is ready and whose dimension has loaded.
    for (const player of players.values()) {
      const entity = player.entity;
      const dimension = loaded.get(entity.dimension);
      if (entity.body || !player.arrived || !dimension) continue;
      entity.body = dimension.createBody(player.arrival.x, player.arrival.z);
      follow(entity);
      dimension.entities.set(entity.id, entity);
      dimension.streamer.loadAround(player.arrival.x, player.arrival.z, pointsIn(entity.dimension));
    }
    for (const [id, dimension] of loaded) dimension.streamer.update(pointsIn(id), CHUNK_BUDGET_MS);
    time += deltaSeconds;
    for (const player of players.values()) {
      const entity = player.entity;
      if (!entity.body) continue;
      // Stunned, rooted or dead: the body stands (ABILITIES.md, *States on a unit*).
      const free = canMove(entity.combat?.flags);
      const input = free ? player.input : { moveX: 0, moveZ: 0, run: false, jump: false };
      const { x, y, z } = entity;
      entity.body.step(deltaSeconds, input, entityStat(rules, entity, "speed", 1));
      player.input = { ...player.input, jump: false };
      follow(entity);
      // Moved by its own doing - not pushed - breaks a cast that moving breaks.
      const tried = input.jump || input.moveX !== 0 || input.moveZ !== 0;
      if (entity.combat && tried && !entity.body.pushed && Math.hypot(entity.x - x, entity.y - y, entity.z - z) > 0.02) entity.combat.moved = true;
    }
    skills.step(loaded.values());
    const events = skills.drainEvents();
    itemSystem?.combatEvents(events);
    itemSystem?.step(loaded.values());
    for (const dimension of loaded.values()) stepResources(dimension.entities.values(), deltaSeconds);
    tick++;
    // What each client is told: the entities around its player, then where they have moved to.
    for (const connection of connections) {
      const entity = connection.player?.entity;
      const viewer = entity?.body ? entity : null;
      const around = viewer ? loaded.get(viewer.dimension)?.entities.values() ?? [] : [];
      const messages = connection.replicator.update(viewer, around, tick, connection.player?.ackSeq ?? 0, time, events);
      // Items go after the entity messages and before the snapshot, which is last.
      const snapshot = messages.pop()!;
      if (connection.items) messages.push(...connection.items.update(viewer, connection.replicator.known, findEntity));
      messages.push(snapshot);
      for (const message of messages) connection.end.send(message);
    }
  }

  return {
    connect: (end) => {
      connections.push({ end, player: null, replicator: createReplicator(rules), items: itemSystem && options.items ? createItemReplicator(options.items, itemSystem) : null });
    },
    step,
    get tick() {
      return tick;
    },
    get time() {
      return time;
    },
    debug: {
      rules,
      dimensions: loaded,
      players,
      entity: findEntity,
      skills,
      items: itemSystem,
    },
  };
}

/** A look a client asked for, kept to what one can be: names of a few plain characters, a u32 seed.
 *  Whether the names are races and outfits is the clients' business - the server never reads them. */
function cleanLook(look: EntityAppearance): EntityAppearance {
  const name = (s: unknown): string => (typeof s === "string" && /^[A-Za-z0-9_-]{0,32}$/.test(s) ? s : "");
  return { seed: Number(look.seed) >>> 0, race: name(look.race), outfit: name(look.outfit), sex: look.sex === "male" || look.sex === "female" ? look.sex : "" };
}
