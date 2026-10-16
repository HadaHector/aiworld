/**
 * Every message between the client and the server (see SIMULATION.md). Each is a closed, flat
 * record: a `type` tag, then fields of known kinds, so a binary codec can be written for every one
 * of them - widths are noted where a codec would need them. Nothing here is a class, a function, or a
 * Babylon type.
 */

/** Bumped whenever a message changes shape. */
export const PROTOCOL_VERSION = 4;

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

// Debug commands on entities (see ENTITIES.md) - a real game would not take these from a client.
// `entity` 0 is the sender's own player. Stats, kinds and resources are indices into the game rules.

/** Debug: adds a modifier. */
export interface DebugModifier {
  type: "debugModifier";
  entity: number; // u32
  stat: number; // u16
  kind: number; // u16
  value: number; // f64
  source: string;
}

/** Debug: removes every modifier from a source. */
export interface DebugRemoveSource {
  type: "debugRemoveSource";
  entity: number; // u32
  source: string;
}

/** Debug: puts an entity in or out of combat. */
export interface DebugCombat {
  type: "debugCombat";
  entity: number; // u32
  inCombat: boolean;
}

/** Debug: changes a resource - negative spends, positive restores. */
export interface DebugResource {
  type: "debugResource";
  entity: number; // u32
  resource: number; // u16
  delta: number; // f64
}

/** Debug: makes an entity from a template, on the ground at a point in the sender's dimension. */
export interface DebugSpawn {
  type: "debugSpawn";
  template: string;
  x: number; // f64
  z: number; // f64
}

/** Debug: removes an entity (not a player). */
export interface DebugDespawn {
  type: "debugDespawn";
  entity: number; // u32
}

export type ClientMessage =
  | Hello
  | Intent
  | Teleport
  | TeleportTo
  | Travel
  | Arrived
  | DebugModifier
  | DebugRemoveSource
  | DebugCombat
  | DebugResource
  | DebugSpawn
  | DebugDespawn;

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
  /** A hash of the game rules' tables (see ENTITIES.md): stats and resources are sent by index, so
   *  a client whose own packs hash differently would show the wrong names. */
  rules: number; // u32
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

/** Where one entity is, as the server has it. */
export interface EntityMotion {
  id: number; // u32
  x: number; // f64
  y: number; // f64
  z: number; // f64
  /** Radians about y, 0 facing +z. */
  facing: number; // f32 (or u16, quantised)
  grounded: boolean;
}

/** One stat's final value, by its index in the game rules. */
export interface StatValue {
  stat: number; // u16
  value: number; // f64
}

/** One resource's current value and maximum, by its index in the game rules. */
export interface ResourceValue {
  resource: number; // u16
  current: number; // f64
  max: number; // f64
}

/** One modifier on the receiver's own player. */
export interface ModifierState {
  stat: number; // u16
  kind: number; // u16
  value: number; // f64
  source: string;
}

/**
 * An entity has come into the receiver's view (see ENTITIES.md, *Replication*): what it is, where,
 * and every value the receiver may see of it - all of them for its own player, else only those the
 * game rules mark `visible: "all"`.
 */
export interface EntitySpawn {
  type: "entitySpawn";
  id: number; // u32
  /** Its template's id: the client looks it up in its own packs for a look. */
  template: string;
  name: string;
  x: number; // f64
  y: number; // f64
  z: number; // f64
  facing: number; // f32
  stats: StatValue[];
  resources: ResourceValue[];
}

/** Values the receiver may see of an entity have changed since it was last told: only those. */
export interface EntityValues {
  type: "entityValues";
  id: number; // u32
  stats: StatValue[];
  resources: ResourceValue[];
}

/** The receiver's own player's modifier stack has changed: the whole of it. */
export interface EntityModifiers {
  type: "entityModifiers";
  id: number; // u32
  modifiers: ModifierState[];
}

/** An entity has left the receiver's view, or is gone. */
export interface EntityDespawn {
  type: "entityDespawn";
  id: number; // u32
}

/** Where everything in view has moved to, after a step: every entity that moved, and always the
 *  receiver's own player. Spawns, values and despawns of the same step come before it. */
export interface Snapshot {
  type: "snapshot";
  tick: number; // u32
  /** The last Intent seq the server had taken from this client by then. */
  ackSeq: number; // u16
  entities: EntityMotion[];
}

export type ServerMessage = Welcome | Transfer | EntitySpawn | EntityValues | EntityModifiers | EntityDespawn | Snapshot;
