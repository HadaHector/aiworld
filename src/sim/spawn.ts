import type { DimensionDef } from "../world/content/dimensions";
import { startAllows, type ChosenStart } from "../world/settlements/starts";

/** Where a character stands: a dimension, a point in it and which way it faces (radians). */
export interface Place {
  dimension: string;
  x: number;
  z: number;
  facing: number;
}

/**
 * Where a new character starts, and its first home (FRONTEND.md, *Where a new character starts*):
 * the one place this is decided. It picks one of the start dimension's `starts` by the character's
 * origins - the first whose `for` allows them - and needs no generated world, so a character can be
 * made before its dimension is loaded. The point comes from `startPoint` once it is.
 */
export function startingPlace(start: DimensionDef, origins: Readonly<Record<string, string>>): { dimension: string; start: string } {
  const chosen = start.starts.find((s) => startAllows(s, origins)) ?? start.starts[0];
  return { dimension: start.id, start: chosen?.id ?? "default" };
}

/** A start's point and first home, from the starts its dimension's world placed (`chooseStarts`);
 *  an id it does not have gets the first. */
export function startPoint(starts: readonly ChosenStart[], id: string): ChosenStart {
  return starts.find((s) => s.id === id) ?? starts[0];
}
