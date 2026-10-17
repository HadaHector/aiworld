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

/** Each step spends at most this long bringing in collision chunks per dimension (always at least one). */
const CHUNK_BUDGET_MS = 2;

/** One connected client and the player it plays. */
interface Connection {
  end: ServerEnd;
  player: Player | null;
  /** What this client has been told of the entities around its player. */
  replicator: Replicator;
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
  };
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

  /** Makes the entities a dimension's definition places, standing on its ground. */
  function placeEntities(dimension: Dimension, definition: DimensionDef): void {
    definition.entities.forEach((placed, i) => {
      const template = rules.templates.get(placed.template);
      if (!template) return; // checked when the rules were loaded (checkPlacements)
      const { x, z } = placed.at;
      const id = nextId++;
      dimension.entities.set(id, createEntity(rules, template, id, { dimension: dimension.id, x, y: dimension.groundAt(x, z), z, facing: placed.facing, key: `${dimension.id}/${i}` }));
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
    switch (message.type) {
      case "hello": {
        if (player || message.protocol !== PROTOCOL_VERSION) return;
        const first = definitions.get(message.dimension) ?? start;
        const entity = createEntity(rules, playerTemplate!, nextId++, { dimension: "", x: first.spawn.x, y: 0, z: first.spawn.z, facing: 0, name: message.name, look: message.look && cleanLook(message.look) });
        const joined: Player = { entity, arrival: first.spawn, arrived: false, input: { moveX: 0, moveZ: 0, run: false, jump: false }, ackSeq: 0 };
        players.set(entity.id, joined);
        connection.player = joined;
        connection.end.send({ type: "welcome", protocol: PROTOCOL_VERSION, playerId: entity.id, config: options.config, packs: options.packs ?? [], rules: rules.hash });
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
        if (target) target.inCombat = message.inCombat;
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
        const id = nextId++;
        dimension.entities.set(id, createEntity(rules, template, id, { dimension: dimension.id, x, y: dimension.groundAt(x, z), z, facing: Math.atan2(player!.entity.x - x, player!.entity.z - z) }));
        return;
      }
      case "debugDespawn": {
        const dimension = player && loaded.get(player.entity.dimension);
        if (dimension && !players.has(message.entity)) dimension.entities.delete(message.entity);
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
    for (const player of players.values()) {
      const entity = player.entity;
      if (!entity.body) continue;
      entity.body.step(deltaSeconds, player.input, entityStat(rules, entity, "speed", 1));
      player.input = { ...player.input, jump: false };
      follow(entity);
    }
    for (const dimension of loaded.values()) stepResources(dimension.entities.values(), deltaSeconds);
    tick++;
    // What each client is told: the entities around its player, then where they have moved to.
    for (const connection of connections) {
      const entity = connection.player?.entity;
      const viewer = entity?.body ? entity : null;
      const around = viewer ? loaded.get(viewer.dimension)?.entities.values() ?? [] : [];
      for (const message of connection.replicator.update(viewer, around, tick, connection.player?.ackSeq ?? 0)) connection.end.send(message);
    }
  }

  return {
    connect: (end) => {
      connections.push({ end, player: null, replicator: createReplicator(rules) });
    },
    step,
    get tick() {
      return tick;
    },
    debug: {
      rules,
      dimensions: loaded,
      players,
      entity: (id) => {
        const player = players.get(id);
        if (player) return player.entity;
        for (const dimension of loaded.values()) {
          const entity = dimension.entities.get(id);
          if (entity) return entity;
        }
        return undefined;
      },
    },
  };
}

/** A look a client asked for, kept to what one can be: names of a few plain characters, a u32 seed.
 *  Whether the names are races and outfits is the clients' business - the server never reads them. */
function cleanLook(look: EntityAppearance): EntityAppearance {
  const name = (s: unknown): string => (typeof s === "string" && /^[A-Za-z0-9_-]{0,32}$/.test(s) ? s : "");
  return { seed: Number(look.seed) >>> 0, race: name(look.race), outfit: name(look.outfit), sex: look.sex === "male" || look.sex === "female" ? look.sex : "" };
}
