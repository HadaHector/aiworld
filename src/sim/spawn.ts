import type { DimensionDef } from "../world/content/dimensions";

/** Where a character stands: a dimension, a point in it and which way it faces (radians). */
export interface Place {
  dimension: string;
  x: number;
  z: number;
  facing: number;
}

/**
 * Where a new character starts, and its first home (FRONTEND.md, *Where a new character starts*).
 * The one place this is decided: today the start dimension's `spawn`; step 9 makes it the generated
 * starting village of the character's people, and nothing else changes.
 */
export function startingPlace(start: DimensionDef, _origins: Readonly<Record<string, string>>): Place {
  return { dimension: start.id, x: start.spawn.x, z: start.spawn.z, facing: 0 };
}
