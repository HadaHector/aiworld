/**
 * Every message between the client and the server (see SIMULATION.md). Each is a closed, flat
 * record: a `type` tag, then fields of known kinds, so a binary codec can be written for every one
 * of them - widths are noted where a codec would need them. Nothing here is a class, a function, or a
 * Babylon type.
 */

/** Bumped whenever a message changes shape. */
export const PROTOCOL_VERSION = 3;

// --- Client to server ------------------------------------------------------------------------

/** Joins the server; answered with a Welcome, then a Transfer to the first dimension. */
export interface Hello {
  type: "hello";
  protocol: number; // u16
  name: string;
  /** Debug: the dimension to start in, by id - "" for the server's choice (see DIMENSIONS.md). */
  dimension: string;
}

/**
 * What the player wants to do now - sent every frame. The direction is in the world's own x and z,
 * the client having turned its keys and camera into it; its length (0-1) is how hard. The server
 * keeps the latest until the next arrives; a jump is kept until a step takes it.
 */
export interface Intent {
  type: "intent";
  seq: number; // u16, wrapping
  moveX: number; // f32
  moveZ: number; // f32
  run: boolean;
  jump: boolean;
}

/** Debug: puts the player on the ground at a point (the map, `goto`). */
export interface Teleport {
  type: "teleport";
  x: number; // f64
  z: number; // f64
}

/** Debug: puts the player's feet at a point - on a roof, a floor - pushed out of whatever is there. */
export interface TeleportTo {
  type: "teleportTo";
  x: number; // f64
  y: number; // f64
  z: number; // f64
}

/** Debug: go to another dimension - by a link from this one if one leads there, else to its spawn.
 *  Answered with a Transfer. */
export interface Travel {
  type: "travel";
  dimension: string;
}

/** The client has built the dimension a Transfer sent it to, and is ready to be put in it. */
export interface Arrived {
  type: "arrived";
}

export type ClientMessage = Hello | Intent | Teleport | TeleportTo | Travel | Arrived;

// --- Server to client ------------------------------------------------------------------------

/** The server's answer to a Hello: who the client is, and what it runs. A Transfer follows. */
export interface Welcome {
  type: "welcome";
  protocol: number; // u16
  playerId: number; // u32
  /** Which world config (see CONFIG.md) and packs the server runs, by name and id - so a client can
   *  tell the player what differs. */
  config: string;
  packs: string[];
}

/**
 * The player is now in this dimension, at this point (see DIMENSIONS.md) - on joining, and on every
 * travel. The client builds the dimension from its own packs and the seed, then says Arrived; until
 * then the player has no body and no snapshot includes it.
 */
export interface Transfer {
  type: "transfer";
  dimension: string;
  seed: number; // u32
  x: number; // f64
  z: number; // f64
}

/** One player as the server has it. */
export interface PlayerState {
  id: number; // u32
  x: number; // f64
  y: number; // f64
  z: number; // f64
  /** Radians about y, 0 facing +z. */
  facing: number; // f32 (or u16, quantised)
  grounded: boolean;
}

/** Where everything is in the receiver's dimension, after a step. */
export interface Snapshot {
  type: "snapshot";
  tick: number; // u32
  /** The last Intent seq the server had taken from this client by then. */
  ackSeq: number; // u16
  players: PlayerState[];
}

export type ServerMessage = Welcome | Transfer | Snapshot;
