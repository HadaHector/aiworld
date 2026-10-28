import type { Entity } from "../entity";
import type { Progress, ProgressEvents } from "../protocol";
import { capOf, nextOf, type ProgressContext, type ProgressEvent } from "./progress";

/**
 * What a client is told of its own player's progress (PROGRESSION.md, *Messages*): the whole of it
 * whenever it changed - a few dozen numbers - and the step's events. Nobody else is told: others see
 * level-ups as combat events, and levels through stats marked `visible: "all"`.
 */
export function progressMessages(ctx: ProgressContext, entity: Entity, events: readonly ProgressEvent[] | undefined, force: boolean): (Progress | ProgressEvents)[] {
  const part = entity.progress;
  if (!part) return [];
  const out: (Progress | ProgressEvents)[] = [];
  if (part.dirty || force) {
    part.dirty = false;
    const { rules } = ctx;
    out.push({
      type: "progress",
      origins: rules.config.slots.map((slot) => part.origins.get(slot.id) ?? -1),
      disciplines: [...part.disciplines]
        .sort((a, b) => a[0] - b[0])
        .map(([discipline, p]) => ({ discipline, level: p.level, xp: p.xp, next: nextOf(ctx, entity, discipline), cap: capOf(ctx, entity, discipline), banked: p.banked })),
      points: rules.pools.map((pool) => ({ pool, left: part.left.get(pool) ?? 0, total: part.totals.get(pool) ?? 0 })),
      trees: [...part.trees].sort((a, b) => a - b),
      talents: [...part.talents].flatMap(([tree, ranks]) => [...ranks].filter(([, rank]) => rank > 0).map(([node, rank]) => ({ tree, node, rank }))),
      learned: [...part.learned].map(([skill, how]) => ({ skill, how })),
      available: [...part.available].map(([skill, unlock]) => ({ skill, how: unlock.how, cost: unlock.cost })),
    });
  }
  if (events && events.length > 0) out.push({ type: "progressEvents", events: events.map((e) => ({ ...e })) });
  return out;
}
