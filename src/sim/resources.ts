import type { GameRules, TemplateDef } from "./rules/gameRules";
import { statValues, type StatBlock } from "./stats";

/**
 * An entity's resources part: health and whatever else its template lists (see ENTITIES.md,
 * *Resources*) - each one's current value, its maximum from a stat, and its regen ticks.
 */
export interface ResourceBlock {
  readonly rules: GameRules;
  /** The resources it has, by index into the game rules' resources, in that order. */
  readonly has: readonly number[];
  /** By resource index; 0 for one it does not have. */
  readonly current: Float64Array;
  readonly max: Float64Array;
  /** Seconds until each resource's next regen tick. */
  readonly untilTick: Float64Array;
}

/**
 * Resources as a template makes them, each at its `start` fraction of its maximum. `phase` (0-1)
 * staggers the regen ticks, so a crowd made on one step does not all tick on the same step.
 */
export function createResourceBlock(rules: GameRules, template: TemplateDef, stats: StatBlock, phase: number): ResourceBlock {
  const count = rules.resources.length;
  const block: ResourceBlock = { rules, has: template.resources, current: new Float64Array(count), max: new Float64Array(count), untilTick: new Float64Array(count) };
  const values = statValues(stats);
  for (const index of block.has) {
    const def = rules.resources[index];
    block.max[index] = Math.max(0, values[def.max]);
    block.current[index] = block.max[index] * def.start;
    block.untilTick[index] = def.interval * (1 - phase);
  }
  return block;
}

/** A phase from an entity's id, spread evenly by the golden ratio. */
export function tickPhase(id: number): number {
  return (id * 0.6180339887498949) % 1;
}

/** Takes each maximum from its stat again, keeping or scaling the current value as its resource says. */
export function syncMaxima(block: ResourceBlock, stats: StatBlock): void {
  const values = statValues(stats);
  for (const index of block.has) {
    const def = block.rules.resources[index];
    const max = Math.max(0, values[def.max]);
    const old = block.max[index];
    if (max === old) continue;
    block.max[index] = max;
    if (def.onMaxChange === "scale") block.current[index] = old > 0 ? (block.current[index] * max) / old : max * def.start;
    block.current[index] = Math.min(block.current[index], max);
  }
}

/** One step of regen and decay for every resource, in or out of combat. */
export function stepResourceBlock(block: ResourceBlock, stats: StatBlock, inCombat: boolean, deltaSeconds: number): void {
  syncMaxima(block, stats);
  const values = statValues(stats);
  for (const index of block.has) {
    const def = block.rules.resources[index];
    const rate = (inCombat ? def.regenInCombat : def.regenOutOfCombat).run(values);
    let change = 0;
    if (def.interval === 0) change = rate * deltaSeconds;
    else {
      block.untilTick[index] -= deltaSeconds;
      while (block.untilTick[index] <= 0) {
        block.untilTick[index] += def.interval;
        change += rate * def.interval;
      }
    }
    if (change !== 0) block.current[index] = Math.min(Math.max(block.current[index] + change, 0), block.max[index]);
  }
}

/** Takes `amount` of a resource if there is that much; returns whether it did. */
export function spend(block: ResourceBlock, resource: number, amount: number): boolean {
  if (!block.has.includes(resource) || block.current[resource] < amount) return false;
  block.current[resource] -= amount;
  return true;
}

/** Adds to a resource (negative takes away, as damage will), kept within 0 to its maximum. */
export function restore(block: ResourceBlock, resource: number, amount: number): void {
  if (!block.has.includes(resource)) return;
  block.current[resource] = Math.min(Math.max(block.current[resource] + amount, 0), block.max[resource]);
}
