import { createWorldCollision, type WorldCollision } from "../world/worldCollision";
import { createTreeScatter } from "../world/foliage/treeScatter";
import { generateTreeHulls, treeColliders, type TreeHulls } from "../world/foliage/treeColliders";
import { createPlacedBuildings, modelGroups, type ModelledGroup, type PlacedBuildings } from "../world/buildings/buildingCollision";
import type { WorldData } from "../world/worldData";
import { COLLISION_CHUNK_SIZE, createCollisionStreamer, type CollisionStreamer } from "./collisionStreamer";
import { createPlayerBody, type BodyInput, type PlayerBody } from "./playerBody";
import { PROTOCOL_VERSION, type ClientMessage, type PlayerState, type ServerMessage } from "./protocol";
import type { ServerEnd } from "./channel";

/** Each step spends at most this long bringing in collision chunks (always at least one). */
const CHUNK_BUDGET_MS = 2;

/** One connected client and the player it plays. */
interface Connection {
  end: ServerEnd;
  player: Player | null;
}

interface Player {
  id: number;
  name: string;
  body: PlayerBody;
  /** The latest intent; a jump stays set until a step takes it. */
  input: BodyInput;
  ackSeq: number;
}

export interface ServerOptions {
  /** Which packs `world` was made from, by id - told to every client that joins. */
  packs?: string[];
  // What a host can hand the server that it has already made, in the same process. Each is pure,
  // read-only data generated from the seed - the server would make exactly the same itself.
  /** Every tree kind's hulls (see foliage/treeColliders.ts). */
  treeHulls?: TreeHulls;
  /** Every building group with its near models made (see buildings/buildingCollision.ts). */
  buildingModels?: readonly ModelledGroup[];
}

export interface Server {
  /** Takes a client: it says Hello, and is a player from the next step. */
  connect: (end: ServerEnd) => void;
  /** Reads every client's messages, moves every player, and sends each client a snapshot. */
  step: (deltaSeconds: number) => void;
  readonly tick: number;
  /** For hosts and debugging - not for clients, which only see messages. */
  readonly debug: {
    readonly collision: WorldCollision;
    readonly streamer: CollisionStreamer;
    readonly buildings: PlacedBuildings;
    readonly players: ReadonlyMap<number, { name: string; body: PlayerBody }>;
  };
}

/**
 * The simulation: the world's collision around its players, and the players themselves - their
 * bodies walking it. Everything it knows comes from `world` (the seed and the packs) and from its
 * clients' messages; everything it tells them goes out as messages. No Babylon, no browser: the same
 * server runs inside the page for single player and on its own in Node (see SIMULATION.md).
 */
export function createServer(world: WorldData, shared: ServerOptions = {}): Server {
  const { seed, content } = world;
  const hulls = shared.treeHulls ?? generateTreeHulls(content.treeKinds, seed);
  const buildings = createPlacedBuildings(shared.buildingModels ?? modelGroups(world.buildingGroups));
  const collision = createWorldCollision({ colliders: (trees) => treeColliders(hulls, trees) }, COLLISION_CHUNK_SIZE, buildings.cellarCuts);
  const streamer = createCollisionStreamer({ sampleTerrain: world.sampleTerrain, scatterTrees: createTreeScatter(seed, content) }, collision, buildings);
  const groundAt = (x: number, z: number, feet: number): number => buildings.floorAt(x, z, feet) ?? world.heightAt(x, z);

  const connections: Connection[] = [];
  const players = new Map<number, Player>();
  let nextId = 1;
  let tick = 0;

  const points = (): { x: number; z: number }[] => [...players.values()].map((p) => ({ x: p.body.motor.state.feet.x, z: p.body.motor.state.feet.z }));

  function handle(connection: Connection, message: ClientMessage): void {
    const player = connection.player;
    switch (message.type) {
      case "hello": {
        if (player || message.protocol !== PROTOCOL_VERSION) return;
        const id = nextId++;
        const body = createPlayerBody(collision, world.heightAt, groundAt, { x: 0, z: 0 });
        const joined: Player = { id, name: message.name, body, input: { moveX: 0, moveZ: 0, run: false, jump: false }, ackSeq: 0 };
        players.set(id, joined);
        connection.player = joined;
        streamer.loadAround(0, 0, points());
        connection.end.send({ type: "welcome", protocol: PROTOCOL_VERSION, playerId: id, seed, config: content.config, packs: shared.packs ?? [] });
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
        if (!player) return;
        player.body.teleport(message.x, message.z);
        streamer.loadAround(message.x, message.z, points());
        return;
      }
      case "teleportTo": {
        if (!player) return;
        player.body.teleportTo({ x: message.x, y: message.y, z: message.z });
        streamer.loadAround(message.x, message.z, points());
        return;
      }
    }
  }

  function step(deltaSeconds: number): void {
    for (let i = connections.length - 1; i >= 0; i--) {
      const connection = connections[i];
      for (const message of connection.end.receive()) handle(connection, message);
      if (connection.end.closed) {
        if (connection.player) players.delete(connection.player.id);
        connections.splice(i, 1);
      }
    }
    streamer.update(points(), CHUNK_BUDGET_MS);
    for (const player of players.values()) {
      player.body.step(deltaSeconds, player.input);
      player.input = { ...player.input, jump: false };
    }
    tick++;
    const states: PlayerState[] = [...players.values()].map(({ id, body }) => {
      const { feet, grounded } = body.motor.state;
      return { id, x: feet.x, y: feet.y, z: feet.z, facing: body.facing, grounded };
    });
    for (const connection of connections) {
      const message: ServerMessage = { type: "snapshot", tick, ackSeq: connection.player?.ackSeq ?? 0, players: states };
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
    debug: { collision, streamer, buildings, players },
  };
}
