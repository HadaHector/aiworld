import type { EntityMirror, MirroredEntity } from "./entityMirror";
import { FLAG } from "../sim/skills/flags";

/** How far Tab looks for an enemy, metres. */
const TAB_RANGE = 40;

/**
 * Tab targeting (see ABILITIES.md, *The test*): the living hostile units within reach, those in
 * front of the camera first, nearest first; each press takes the next one after the current target,
 * round again at the end. The server checks everything a cast needs - this only picks.
 */
export function nextEnemy(mirror: EntityMirror, ownId: number, current: number, forward: { x: number; z: number }): number {
  const own = mirror.entities.get(ownId);
  if (!own) return 0;
  const candidates: { entity: MirroredEntity; score: number }[] = [];
  for (const entity of mirror.entities.values()) {
    if (entity.id === ownId || entity.template?.hostility !== "hostile" || entity.flags & (1 << FLAG.dead)) continue;
    const dx = entity.x - own.x;
    const dz = entity.z - own.z;
    const distance = Math.hypot(dx, dz);
    if (distance > TAB_RANGE) continue;
    const ahead = distance < 1e-6 ? 1 : (dx * forward.x + dz * forward.z) / distance;
    // Behind the camera counts as much farther away.
    candidates.push({ entity, score: distance + (ahead < 0.3 ? 1000 : 0) });
  }
  candidates.sort((a, b) => a.score - b.score || a.entity.id - b.entity.id);
  if (candidates.length === 0) return 0;
  const at = candidates.findIndex((c) => c.entity.id === current);
  return candidates[(at + 1) % candidates.length].entity.id;
}
