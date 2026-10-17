import type { Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import type { SkillDef, StateDef } from "../rules/skillRules";
import type { CombatEvent, Reason } from "./events";
import type { FlagBlock } from "./flags";

/** A skill given to a unit (ABILITIES.md, *Spells*). */
export interface Spell {
  skill: number;
  level: number;
  /** "template", "item:mainHand", "debug": taken away together, as modifiers are. */
  source: string;
  /** Server time its cooldown ends. */
  ready: number;
  /** A passive's running magic. */
  passive: Magic | null;
}

/** A cast asked for while the unit was busy, fired when it is free (the queue window). */
export interface CastRequest {
  skill: number;
  target: number;
  point: { x: number; z: number } | null;
}

/** An absorb held on a unit by a magic's state. */
export interface AbsorbRecord {
  magic: Magic;
  remaining: number;
  tags: readonly string[];
}

export interface ThreatEntry {
  amount: number;
  /** Server time of the last thing it did to the table's owner. */
  last: number;
}

/**
 * A unit's combat part: what it knows, what is running on it, the flags it holds, its threat table,
 * whom it targets. Every entity with stats has one (made with it in `createEntity`).
 */
export interface CombatPart {
  spells: Spell[];
  gcdUntil: number;
  /** Shared cooldowns by category: server time each ends. */
  categories: Map<string, number>;
  queued: CastRequest | null;
  /** Magics hosted on it, in the order they started. */
  magics: Magic[];
  flags: FlagBlock;
  /** Tags of skills it cannot start until a time: an interrupt's lockout. */
  lockouts: { tag: string; until: number }[];
  absorbs: AbsorbRecord[];
  /** Unit id → threat, for templates with `threat: true`; null for the rest. */
  threat: Map<number, ThreatEntry> | null;
  /** The unit it has selected (0 for none) and whether it is auto-attacking it. */
  target: number;
  attacking: boolean;
  /** Who summoned it (0 for nobody): it takes that unit's side. */
  owner: number;
  summons: number[];
  /** The magic of its own whose state shows a cast bar, if any. */
  casting: Magic | null;
  /** Counts the casts it has started: part of each magic's random seed. */
  castCounter: number;
  /** Server time of the last hostile thing it did or had done to it. */
  lastHostile: number;
  /** Forced into combat by debug. */
  forceCombat: boolean;
  dead: boolean;
  /** Server time a summon goes, Infinity for a unit that stays. */
  expires: number;
  /** Set by the server's step when the unit moved by its own input since the last step. */
  moved: boolean;
}

export type StateLengthValue = number;

/** One running instance of a skill (ABILITIES.md, *Magics*). */
export interface Magic {
  readonly id: number;
  readonly skill: SkillDef;
  caster: number;
  /** The unit it lives on, or 0 for one at a point. */
  readonly host: number;
  /** Its host's dimension (kept up as the host travels), or its point's. */
  dimension: string;
  x: number;
  y: number;
  z: number;
  /** The unit it was cast at, 0 for none. */
  readonly target: number;
  readonly level: number;
  state: number;
  stateStart: number;
  /** Server time the current state's length runs out: Infinity for one that lasts until an event. */
  stateEnds: number;
  nextTick: number;
  stacks: number;
  readonly vars: Float64Array;
  /** Each group's members for this state, by id; null until something uses it. */
  groups: (number[] | null)[];
  readonly random: () => number;
  /** What the current state's holds did, to undo it. */
  held: { kind: string; data: unknown; target: number; record: unknown }[];
  /** Bumped on every change of state: an action list stops when the state it ran in is left. */
  serial: number;
  ended: boolean;
  committed: boolean;
  /** The spell it was cast from, for its cooldown at commit; null for one a cast action applied. */
  spell: Spell | null;
  /** How deep in nested casts it was started: a guard against skills that cast each other forever. */
  readonly depth: number;
}

/** What the server gives the skill system: the world it runs in. */
export interface SkillWorld {
  readonly seed: number;
  time(): number;
  tick(): number;
  /** An entity by id, wherever it is. */
  entity(id: number): Entity | undefined;
  /** Every entity in a dimension. */
  entitiesIn(dimension: string): Iterable<Entity>;
  /** Whether nothing solid stands between two points, at the rules' sight height. */
  lineOfSight(dimension: string, from: Entity, to: Entity): boolean;
  /** Makes an entity of a template standing at a point; undefined when the dimension is not loaded. */
  spawn(dimension: string, template: string, x: number, z: number, facing: number): Entity | undefined;
  despawn(entity: Entity): void;
  /** Pushes a unit: a dash, a leap or a knockback (see `move`). */
  push(entity: Entity, motion: ForcedMotion): void;
}

export interface ForcedMotion {
  /** Metres a second, in the world. */
  vx: number;
  vy: number;
  vz: number;
  /** Seconds it lasts at most. */
  duration: number;
  /** Stops early within this distance of the point, for a dash at a target. */
  stopAt: { x: number; z: number; within: number } | null;
  /** A teleport: put down here at once (the rest is ignored). */
  to: { x: number; z: number } | null;
}

/** The skill system's own state, shared by its modules. */
export interface Sys {
  readonly rules: GameRules;
  readonly world: SkillWorld;
  /** Events made this step, handed to the server to send. */
  readonly events: { event: CombatEvent; dimension: string; x: number; z: number }[];
  /** Magics at a point (host 0), by dimension. */
  readonly pointMagics: Map<string, Magic[]>;
  nextMagic: number;
  /** Whether the actions running now are a state's ticks: damage and healing then are periodic. */
  ticking: boolean;
  /** What casting does as magics move: commit, cast bars, a queued cast (casting.ts). */
  readonly hooks: {
    onEnter(magic: Magic, state: StateDef): void;
    onEnd(magic: Magic, reason: Reason): void;
    /** A cast whose magic combines with one already there commits at once; false if it cannot. */
    commitNow(magic: Magic): boolean;
  };
}
