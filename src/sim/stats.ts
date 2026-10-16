import type { GameRules, StatDef, TemplateDef } from "./rules/gameRules";

/** One change to one stat of one entity (see ENTITIES.md, *Modifiers*). */
export interface Modifier {
  /** Index into the game rules' stats. */
  stat: number;
  /** Index into the game rules' modifier kinds. */
  kind: number;
  value: number;
  /** Who put it there - "template", "gear:chest", "aura:812", "debug". Removing a source removes every
   *  modifier it put on the entity. */
  source: string;
}

/** The source of the modifiers a template gives the entities made from it. */
export const TEMPLATE_SOURCE = "template";

/**
 * An entity's stats part: every stat the game rules define, its base, the modifiers on it, and the
 * final values worked out from them - again only when something has changed.
 */
export interface StatBlock {
  readonly rules: GameRules;
  /** Primary stats' bases by stat index (a derived stat's slot is unused: its base is its formula). */
  readonly base: Float64Array;
  /** Every modifier on the entity, in the order they were added. */
  readonly modifiers: readonly Modifier[];
  /** Bumped whenever the modifiers change - what replication watches for the owner's stack. */
  readonly modifierVersion: number;
}

interface StatBlockState extends StatBlock {
  base: Float64Array;
  modifiers: Modifier[];
  modifierVersion: number;
  values: Float64Array;
  dirty: boolean;
}

/** A stat block as a template makes it: its bases over the stats' defaults, and its standing
 *  modifiers under the source "template". */
export function createStatBlock(rules: GameRules, template: TemplateDef): StatBlock {
  const base = new Float64Array(rules.stats.length);
  for (const stat of rules.stats) base[stat.index] = stat.default;
  for (const { stat, value } of template.stats) base[stat] = value;
  const block: StatBlockState = {
    rules,
    base,
    modifiers: template.modifiers.map((m) => ({ ...m, source: TEMPLATE_SOURCE })),
    modifierVersion: 0,
    values: new Float64Array(rules.stats.length),
    dirty: true,
  };
  return block;
}

const state = (block: StatBlock): StatBlockState => block as StatBlockState;

/** Every stat's final value, by index - worked out again first if anything changed. The array is the
 *  block's own: read it, do not keep or change it. */
export function statValues(block: StatBlock): Float64Array {
  const s = state(block);
  if (s.dirty) recompute(s);
  return s.values;
}

export function statValue(block: StatBlock, stat: number): number {
  return statValues(block)[stat];
}

/** Sets a primary stat's base (a level up, later). */
export function setBase(block: StatBlock, stat: number, value: number): void {
  if (block.rules.stats[stat].formula) throw new Error(`"${block.rules.stats[stat].id}" is derived: its base is its formula`);
  const s = state(block);
  s.base[stat] = value;
  s.dirty = true;
}

export function addModifier(block: StatBlock, modifier: Modifier): void {
  const { stats, modifierKinds } = block.rules;
  if (!stats[modifier.stat]) throw new Error(`no stat ${modifier.stat}`);
  if (!modifierKinds[modifier.kind]) throw new Error(`no modifier kind ${modifier.kind}`);
  if (!Number.isFinite(modifier.value)) throw new Error(`a modifier's value must be finite, got ${modifier.value}`);
  const s = state(block);
  s.modifiers.push({ ...modifier });
  s.modifierVersion++;
  s.dirty = true;
}

/** Removes every modifier from a source, whatever stat it is on. Returns how many went. */
export function removeSource(block: StatBlock, source: string): number {
  const s = state(block);
  const before = s.modifiers.length;
  s.modifiers = s.modifiers.filter((m) => m.source !== source);
  const removed = before - s.modifiers.length;
  if (removed > 0) {
    s.modifierVersion++;
    s.dirty = true;
  }
  return removed;
}

/** How one modifier kind changed a stat: its modifiers gathered into a total, and the stat after. */
export interface StatStep {
  kind: number;
  total: number;
  after: number;
  modifiers: Modifier[];
}

/** How a stat's final value came about - for the inspector. */
export interface StatBreakdown {
  stat: StatDef;
  base: number;
  steps: StatStep[];
  /** After clamping and rounding. */
  value: number;
}

const kindInput = new Float64Array(2);

/** Works out one stat from its base and its modifiers, with the values it reads from `values`. */
function evaluate(rules: GameRules, def: StatDef, base: number, modifiers: readonly Modifier[], values: ArrayLike<number>, steps: StatStep[] | null): number {
  let value = def.formula ? def.formula.run(values) : base;
  if (modifiers.length > 0) {
    for (const kindIndex of rules.applyOrder) {
      const kind = rules.modifierKinds[kindIndex];
      let total = kind.gather === "product" ? 1 : kind.gather === "sum" ? 0 : NaN;
      let count = 0;
      for (const m of modifiers) {
        if (m.kind !== kindIndex) continue;
        count++;
        if (kind.gather === "sum") total += m.value;
        else if (kind.gather === "product") total *= m.value;
        else if (kind.gather === "max") total = count === 1 ? m.value : Math.max(total, m.value);
        else total = count === 1 ? m.value : Math.min(total, m.value);
      }
      if (count === 0) continue;
      kindInput[0] = value;
      kindInput[1] = total;
      value = kind.apply.run(kindInput);
      steps?.push({ kind: kindIndex, total, after: value, modifiers: modifiers.filter((m) => m.kind === kindIndex) });
    }
  }
  value = Math.min(Math.max(value, def.min), def.max);
  if (def.round === "floor") value = Math.floor(value);
  else if (def.round === "round") value = Math.round(value);
  else if (def.round === "ceil") value = Math.ceil(value);
  return value;
}

function recompute(s: StatBlockState): void {
  const { rules } = s;
  const byStat: Modifier[][] = rules.stats.map(() => []);
  for (const m of s.modifiers) byStat[m.stat].push(m);
  for (const index of rules.statOrder) s.values[index] = evaluate(rules, rules.stats[index], s.base[index], byStat[index], s.values, null);
  s.dirty = false;
}

/** One stat's base, each modifier kind's effect on it, and its final value. */
export function explainStat(block: StatBlock, stat: number): StatBreakdown {
  const values = statValues(block);
  const def = block.rules.stats[stat];
  const base = def.formula ? def.formula.run(values) : block.base[stat];
  const steps: StatStep[] = [];
  const value = evaluate(block.rules, def, block.base[stat], block.modifiers.filter((m) => m.stat === stat), values, steps);
  return { stat: def, base, steps, value };
}
