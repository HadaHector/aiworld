import { SAVE_VERSION, type CharacterRecord, type WorldRecord } from "./records";

/**
 * Brings a record read from a store up to SAVE_VERSION, one version step at a time - none yet, as
 * version 1 is the first. A record newer than this code knows is refused with a message that says
 * so, rather than read wrongly.
 */
function check(raw: unknown, what: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new Error(`The ${what} save is not a record.`);
  const record = raw as Record<string, unknown>;
  const version = Number(record.version);
  if (!Number.isInteger(version) || version < 1) throw new Error(`The ${what} save has no version.`);
  if (version > SAVE_VERSION) throw new Error(`The ${what} save was written by a newer version of the game (save version ${version}; this one reads up to ${SAVE_VERSION}).`);
  return record;
}

export function migrateWorld(raw: unknown): WorldRecord {
  return check(raw, "world") as unknown as WorldRecord;
}

export function migrateCharacter(raw: unknown): CharacterRecord {
  return check(raw, "character") as unknown as CharacterRecord;
}
