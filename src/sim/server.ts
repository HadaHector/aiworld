import { dimensionSeed, type DimensionDef } from "../world/content/dimensions";
import { createDimension, type Dimension, type DimensionWorld } from "./dimension";
import type { BodyInput, PlayerBody } from "./playerBody";
import { PROTOCOL_VERSION, type ClientMessage, type PlayerState, type ServerMessage } from "./protocol";
import type { ServerEnd } from "./channel";

/** Each step spends at most this long bringing in collision chunks per dimension (always at least one). */
const CHUNK_BUDGET_MS = 2;

/** One connected client and the player it plays. */
interface Connection {
  end: ServerEnd;
  player: Player | null;
}

interface Player {
  id: number;
  name: string;
  /** The dimension it is in - or on its way to, while `body` is null. */
  dimension: string;
  /** Null while travelling: from a Transfer until its client has Arrived and the dimension is loaded. */
  body: PlayerBody | null;
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
    /** The dimensions loaded now, by id. */
    readonly dimensions: ReadonlyMap<string, Dimension>;
    readonly players: ReadonlyMap<number, { name: string; dimension: string; body: PlayerBody | null }>;
  };
}

/**
 * The simulation: the players, the dimensions they are in, and each dimension's collision around
 * them (see DIMENSIONS.md). A dimension is loaded when the first player heads for it and dropped
 * when the last one leaves. Everything it knows comes from its host (the seed, the packs, the worlds
 * it is handed) and from its clients' messages; everything it tells them goes out as messages. No
 * Babylon, no browser: the same server runs inside the page for single player and on its own in Node
 * (see SIMULATION.md).
 */
export function createServer(options: ServerOptions): Server {
  const definitions = new Map(options.dimensions.map((def) => [def.id, def]));
  const start = options.dimensions.find((def) => def.start) ?? options.dimensions[0];
  if (!start) throw new Error("A server needs at least one dimension");

  const connections: Connection[] = [];
  const players = new Map<number, Player>();
  const slots = new Map<string, Slot>();
  const loaded = new Map<string, Dimension>();
  let nextId = 1;
  let tick = 0;

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
          loaded.set(id, slot.dimension);
        },
        (error) => {
          if (slots.get(id) === slot) slots.delete(id);
          options.onLoadError?.(definition, error);
        },
      );
  }

  /** Drops a dimension nobody is in or heading for. */
  function release(id: string): void {
    for (const player of players.values()) if (player.dimension === id) return;
    const slot = slots.get(id);
    if (!slot) return;
    slot.dropped = true;
    slots.delete(id);
    loaded.delete(id);
  }

  /** Takes a player out of where it is and sends it to a dimension, at a point. */
  function transfer(connection: Connection, player: Player, to: DimensionDef, at: { x: number; z: number }): void {
    const from = player.dimension;
    player.dimension = to.id;
    player.body = null;
    player.arrival = at;
    player.arrived = false;
    player.input = { moveX: 0, moveZ: 0, run: false, jump: false };
    want(to.id);
    if (from !== to.id) release(from);
    connection.end.send({ type: "transfer", dimension: to.id, seed: dimensionSeed(options.seed, to), x: at.x, z: at.z });
  }

  const pointsIn = (id: string): { x: number; z: number }[] =>
    [...players.values()].filter((p) => p.dimension === id && p.body).map((p) => ({ x: p.body!.motor.state.feet.x, z: p.body!.motor.state.feet.z }));

  function handle(connection: Connection, message: ClientMessage): void {
    const player = connection.player;
    switch (message.type) {
      case "hello": {
        if (player || message.protocol !== PROTOCOL_VERSION) return;
        const id = nextId++;
        const first = definitions.get(message.dimension) ?? start;
        const joined: Player = { id, name: message.name, dimension: "", body: null, arrival: first.spawn, arrived: false, input: { moveX: 0, moveZ: 0, run: false, jump: false }, ackSeq: 0 };
        players.set(id, joined);
        connection.player = joined;
        connection.end.send({ type: "welcome", protocol: PROTOCOL_VERSION, playerId: id, config: options.config, packs: options.packs ?? [] });
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
        if (!player?.body) return;
        player.body.teleport(message.x, message.z);
        loaded.get(player.dimension)!.streamer.loadAround(message.x, message.z, pointsIn(player.dimension));
        return;
      }
      case "teleportTo": {
        if (!player?.body) return;
        player.body.teleportTo({ x: message.x, y: message.y, z: message.z });
        loaded.get(player.dimension)!.streamer.loadAround(message.x, message.z, pointsIn(player.dimension));
        return;
      }
      case "travel": {
        const to = definitions.get(message.dimension);
        if (!player || !to) return;
        const link = definitions.get(player.dimension)?.links.find((l) => l.to === to.id);
        transfer(connection, player, to, link ? link.arrive : to.spawn);
        return;
      }
      case "arrived": {
        if (player) player.arrived = true;
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
          players.delete(gone.id);
          release(gone.dimension);
        }
      }
    }
    // Into the world: every player whose client is ready and whose dimension has loaded.
    for (const player of players.values()) {
      const dimension = loaded.get(player.dimension);
      if (player.body || !player.arrived || !dimension) continue;
      player.body = dimension.createBody(player.arrival.x, player.arrival.z);
      dimension.streamer.loadAround(player.arrival.x, player.arrival.z, pointsIn(player.dimension));
    }
    for (const [id, dimension] of loaded) dimension.streamer.update(pointsIn(id), CHUNK_BUDGET_MS);
    for (const player of players.values()) {
      if (!player.body) continue;
      player.body.step(deltaSeconds, player.input);
      player.input = { ...player.input, jump: false };
    }
    tick++;
    const statesIn = new Map<string, PlayerState[]>();
    for (const { id, dimension, body } of players.values()) {
      if (!body) continue;
      const { feet, grounded } = body.motor.state;
      if (!statesIn.has(dimension)) statesIn.set(dimension, []);
      statesIn.get(dimension)!.push({ id, x: feet.x, y: feet.y, z: feet.z, facing: body.facing, grounded });
    }
    for (const connection of connections) {
      const player = connection.player;
      const message: ServerMessage = { type: "snapshot", tick, ackSeq: player?.ackSeq ?? 0, players: (player && statesIn.get(player.dimension)) ?? [] };
      connection.end.send(message);
    }
  }

  return {
    connect: (end) => {
      connections.push({ end, player: null });
    },
    step,
    get tick() {
      return tick;
    },
    debug: { dimensions: loaded, players },
  };
}
