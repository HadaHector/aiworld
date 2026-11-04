import { FLAG } from "../sim/skills/flags";
import type { MirroredEntity } from "./entityMirror";

/**
 * Which units count as enemies for the player's eyes: the one rule that Tab targeting and the
 * floating health bars share, so a unit with a bar over its head is one Tab can take.
 *
 * Hostile units are enemies within `ENEMY_RANGE`. Neutral ones (deer, a dog - they fight only when
 * struck) are not: Tab skips them, and their bar shows only when they are the target or have turned
 * on the player, so a field of grazing animals is not a field of bars.
 */

/** How far an enemy is looked for and drawn, metres. */
export const ENEMY_RANGE = 40;

export function isAlive(entity: MirroredEntity): boolean {
  return (entity.flags & (1 << FLAG.dead)) === 0;
}

/** Whether a unit is hostile and alive: what Tab takes (when also within `ENEMY_RANGE`). */
export function isEnemy(entity: MirroredEntity): boolean {
  return entity.template?.hostility === "hostile" && isAlive(entity);
}
