import type { BodyInput } from "../playerBody";
import type { CreatureKind } from "../rules/creatureRules";
import type { SpawnMember, SpawnPoint } from "./spawnPoints";

export type BrainState = "idle" | "wander" | "combat" | "flee" | "evade";

/** What a creature thinks (see CREATURES.md, *The brain*). */
export interface Brain {
  state: BrainState;
  /** Why it last evaded: "leash", "stuck", "no foes left" - for the inspector. */
  why: string;
  /** When the current idle, wander or flee ends. */
  until: number;
  /** Where it is walking to, wandering or going home. */
  goal: { x: number; z: number } | null;
  /** Where the pull started: what the leash measures from. */
  pulledAt: { x: number; z: number };
  /** The nearest it has got to its target this chase, and when - for giving up when stuck. */
  closest: number;
  /** Where it was when it last made progress. */
  lastPos: { x: number; z: number };
  lastProgress: number;
  /** Per tactic, the server time it may next be used. */
  tactics: number[];
  /** When it next looks round for players to aggro, and next thinks of its tactics. */
  nextLook: number;
  nextTactic: number;
  /** Whether it has fled this pull already. */
  fled: boolean;
}

/** The creature part of an entity: its kind, where it belongs, and its brain. */
export interface CreaturePart {
  kind: CreatureKind;
  /** The spawn point and member it is, or null for one made by debug. */
  point: SpawnPoint | null;
  member: SpawnMember | null;
  /** Who comes when it is pulled: its point's key, or its own id. */
  group: string;
  level: number;
  /** Where it stands, wanders about and evades back to. */
  home: { x: number; z: number };
  wander: number;
  brain: Brain;
  /** What its brain asks of its body this step. */
  input: BodyInput;
  /** Server time it died (-1 alive), and when its corpse was first seen empty (-1 not yet). */
  diedAt: number;
  emptiedAt: number;
}
