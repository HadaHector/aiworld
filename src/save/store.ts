import type { CharacterRecord, WorldRecord } from "./records";

/**
 * Where worlds and characters are kept (FRONTEND.md, *The save store*). The server writes through
 * it; the menu reads the world list from it. IndexedDB in the browser, files on a dedicated server,
 * a Map in tests. Every call is async, and a write replaces the whole record.
 */
export interface SaveStore {
  /** Every world, newest played first. */
  listWorlds(): Promise<WorldRecord[]>;
  readWorld(id: string): Promise<WorldRecord | null>;
  writeWorld(world: WorldRecord): Promise<void>;
  /** The world and every character in it. */
  deleteWorld(id: string): Promise<void>;
  readCharacter(world: string, id: string): Promise<CharacterRecord | null>;
  writeCharacter(world: string, character: CharacterRecord): Promise<void>;
  deleteCharacter(world: string, id: string): Promise<void>;
}

export const byPlayed = (a: WorldRecord, b: WorldRecord): number => b.played - a.played;
