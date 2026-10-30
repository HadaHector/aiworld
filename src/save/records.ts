import type { SavedProgress } from "../sim/progression/save";
import type { SavedBelongings } from "../sim/items/save";
import type { CharacterEntry, EntityAppearance } from "../sim/protocol";

/**
 * What is saved (GAMEPLAY.md, *Saved state*; FRONTEND.md, *Saves*): a world and the characters in it.
 * Plain JSON - ids and numbers - so a save outlives packs being reordered, and the same records go
 * to IndexedDB in the browser and to files for a dedicated server.
 */

/** The version records are written at; older ones are migrated forward (migrate.ts). */
export const SAVE_VERSION = 1;

/** A character as the lists show it (the protocol's CharacterEntry), kept in its world's record so a
 *  list needs no other read. */
export type CharacterSummary = CharacterEntry;

export interface WorldRecord {
  version: number;
  id: string;
  name: string;
  /** u32. */
  seed: number;
  /** The world config (CONFIG.md): "default", "small", "tiny". */
  config: string;
  /** The packs it was made with, and the hashes of the rules they made - for warning when they change. */
  packs: string[];
  hashes: { rules: number; items: number; creatures: number; progression: number };
  created: number;
  played: number;
  /** The world clock, in seconds: it runs only while the server does (GAMEPLAY.md, *World delta*). */
  time: number;
  /** The world delta's entries: generated key -> the world time it comes back. */
  delta: [string, number][];
  /** The item store's next id (ITEMS.md), so ids stay unique from run to run. */
  nextItemId: number;
  characters: CharacterSummary[];
}

/** A character's look, as spawns carry it (ENTITIES.md, *Looks*). */
export type SavedLook = EntityAppearance;

export interface CharacterRecord {
  version: number;
  id: string;
  name: string;
  /** Slot -> origin id. Its progress says the same once it has been played. */
  origins: Record<string, string>;
  look: SavedLook;
  created: number;
  played: number;
  /** Seconds played. */
  playedSeconds: number;
  /** Null until it has been played: it then starts as a new character of its origins does. */
  progress: SavedProgress | null;
  belongings: SavedBelongings | null;
  /** Resource id -> current value, so a fight is not undone by logging out. */
  resources: Record<string, number>;
  /** Logged out dead: it comes back at home, alive. */
  dead: boolean;
  travel: {
    dimension: string;
    x: number;
    z: number;
    /** Radians. */
    facing: number;
    home: { dimension: string; x: number; z: number };
  };
  /** The client's own layout (the action bar), as JSON text: kept by the server, never read by it. */
  interface: string;
}

/** A new world, before anything has been played in it. */
export function createWorldRecord(fields: Pick<WorldRecord, "id" | "name" | "seed" | "config" | "packs" | "hashes">, now = Date.now()): WorldRecord {
  return { version: SAVE_VERSION, ...fields, seed: fields.seed >>> 0, created: now, played: now, time: 0, delta: [], nextItemId: 1, characters: [] };
}

/** An id for a new world or character: its name made safe for a file name, and enough of the time
 *  and chance to keep two with one name apart. */
export function makeSaveId(name: string, now = Date.now()): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "save";
  return `${slug}-${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

/** Why a character name will not do, or "" when it will: 2-16 letters, with an apostrophe or a
 *  hyphen allowed between letters. Names are compared without case, so it is also checked against
 *  the world's others. */
export function nameProblem(name: string, taken: readonly string[], limits = { min: 2, max: 16 }): string {
  if (name.length < limits.min) return `A name needs at least ${limits.min} letters.`;
  if (name.length > limits.max) return `A name can have at most ${limits.max} letters.`;
  if (!/^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(name)) return "A name is letters only, with an apostrophe or a hyphen between them.";
  if (taken.some((other) => other.toLowerCase() === name.toLowerCase())) return `${name} is already a character in this world.`;
  return "";
}

/** A name as it is kept: its first letter capitalised. */
export const tidyName = (name: string): string => name.trim().charAt(0).toUpperCase() + name.trim().slice(1);
