/**
 * Every message between the client and the server (see SIMULATION.md). Each is a closed, flat
 * record: a `type` tag, then fields of known kinds, so a binary codec can be written for every one
 * of them - widths are noted where a codec would need them. Nothing here is a class, a function, or a
 * Babylon type.
 */

/** Bumped whenever a message changes shape. */
export const PROTOCOL_VERSION = 1;

// --- Client to server ------------------------------------------------------------------------

/** Joins the server; answered with a Welcome. */
export interface Hello {
  type: "hello";
  protocol: number; // u16
  name: string;
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

export type ClientMessage = Hello | Intent | Teleport | TeleportTo;

// --- Server to client ------------------------------------------------------------------------

/** The server's answer to a Hello: who the client is, and what world it is in. */
export interface Welcome {
  type: "welcome";
  protocol: number; // u16
  playerId: number; // u32
  seed: number; // u32
  /** Which packs the server runs, by id - so a client can tell the player what differs. */
  packs: string[];
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

/** Where everything is, after a step. */
export interface Snapshot {
  type: "snapshot";
  tick: number; // u32
  /** The last Intent seq the server had taken from this client by then. */
  ackSeq: number; // u16
  players: PlayerState[];
}

export type ServerMessage = Welcome | Snapshot;
