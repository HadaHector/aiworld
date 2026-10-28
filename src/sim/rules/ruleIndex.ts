import type { CompiledFormula } from "./formula";
import { formulaText } from "./formulaText";
import type { GameRules } from "./gameRules";
import type { ItemRules } from "./itemRules";
import type { ProgressionRules, UnlockModifier } from "./progressionRules";
import type { SkillDef } from "./skillRules";

/**
 * Who reads each stat and what changes it, found in the rules themselves (PROGRESSION.md, the rule
 * book): derived stats, resources, skills, combat rolls, item requirements and disciplines that read
 * it; disciplines, unlocks, talents, origins, items and skills that raise or lower it. So the book can
 * say what Intellect does and where more of it comes from, for any packs, without a word written by
 * hand.
 */
export interface StatUse {
  /** What reads or changes it: "Fireball", "Max mana", "Talent: Insight (Fire)". */
  what: string;
  /** How: a formula as text, or a short phrase. */
  how: string;
  /** For links: `skill:<id>`, `stat:<id>`, `disc:<id>`, `origin:<id>`, `tree:<id>`, "". */
  key: string;
}

export interface RuleIndex {
  readBy: Map<number, StatUse[]>;
  changedBy: Map<number, StatUse[]>;
  /** The discipline whose level is this stat, by stat index. */
  discipline: Map<number, number>;
}

const isFormula = (o: unknown): o is CompiledFormula =>
  typeof o === "object" && o !== null && typeof (o as CompiledFormula).run === "function" && Array.isArray((o as CompiledFormula).reads);

/** Every name a formula tree reads. */
function namesIn(tree: unknown, out: Set<string>): Set<string> {
  if (typeof tree === "string") out.add(tree);
  else if (Array.isArray(tree)) for (const t of tree) namesIn(t, out);
  else if (typeof tree === "object" && tree !== null) for (const v of Object.values(tree)) namesIn(v, out);
  return out;
}

/** Every compiled formula inside a value, however deep - a skill's costs, lengths, actions. */
function formulasIn(value: unknown, out: CompiledFormula[], seen = new Set<unknown>()): CompiledFormula[] {
  if (typeof value !== "object" || value === null || seen.has(value)) return out;
  seen.add(value);
  if (isFormula(value)) {
    out.push(value);
    return out;
  }
  for (const [k, v] of Object.entries(value)) if (k !== "scope") formulasIn(v, out, seen);
  return out;
}

/** A modifier's change in words: "+5%", "level × 4", "×1.1". */
export function changeText(m: UnlockModifier, game: GameRules, variable: Record<string, string>): string {
  const kind = game.modifierKinds[m.kind]?.id ?? "";
  const constant = m.value.constant;
  const value = constant !== null ? `${constant > 0 ? "+" : ""}${constant}` : formulaText(m.value.source, variable);
  return kind === "percent" ? `${value}%` : kind === "multiplier" ? `×${value}` : value;
}

export function indexRules(game: GameRules, progression: ProgressionRules | null, items: ItemRules | null): RuleIndex {
  const readBy = new Map<number, StatUse[]>();
  const changedBy = new Map<number, StatUse[]>();
  const discipline = new Map<number, number>();
  const read = (stat: number | undefined, use: StatUse): void => {
    if (stat === undefined || stat < 0) return;
    if (!readBy.has(stat)) readBy.set(stat, []);
    const list = readBy.get(stat)!;
    if (!list.some((u) => u.what === use.what && u.how === use.how)) list.push(use);
  };
  const change = (stat: number | undefined, use: StatUse): void => {
    if (stat === undefined || stat < 0) return;
    if (!changedBy.has(stat)) changedBy.set(stat, []);
    changedBy.get(stat)!.push(use);
  };
  const names = statNames(game);
  const skillWords = skillNames(game);
  const text = (formula: CompiledFormula): string => formulaText(formula.source, names);
  /** The stats a formula reads, through any prefix (`caster.`, `victim.`...) or none - or, in a skill's
   *  or a roll's formulas (`prefixed`), only through a prefix: a bare `level` there is the spell's rank. */
  const statsRead = (formula: CompiledFormula, prefixed = false): number[] => {
    const out: number[] = [];
    for (const name of namesIn(formula.source, new Set())) {
      if (prefixed && !name.includes(".")) continue;
      const id = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
      const stat = game.statIndex.get(id);
      if (stat !== undefined && !out.includes(stat)) out.push(stat);
    }
    return out;
  };

  for (const stat of game.stats) {
    if (stat.formula) for (const s of statsRead(stat.formula)) if (s !== stat.index) read(s, { what: stat.name, how: text(stat.formula), key: `stat:${stat.id}` });
  }
  for (const r of game.resources) {
    read(r.max, { what: r.name, how: `the most ${r.name} you can have`, key: "" });
    for (const [when, f] of [["out of combat", r.regenOutOfCombat], ["in combat", r.regenInCombat]] as const) {
      for (const s of statsRead(f)) read(s, { what: `${r.name} coming back ${when}`, how: `${text(f)} a second`, key: "" });
    }
  }
  for (const roll of game.combat.rolls) {
    for (const [what, f] of [["chance to hit", roll.hit], ["chance to crit", roll.crit], ["crit damage", roll.critMultiplier], ["damage after armour", roll.mitigate]] as const) {
      for (const s of statsRead(f, true)) read(s, { what: `${what} (${roll.id} rolls)`, how: formulaText(f.source, skillWords), key: "" });
    }
  }
  for (const skill of game.skills) indexSkill(skill);
  function indexSkill(skill: SkillDef): void {
    for (const f of formulasIn({ cost: skill.cost, cooldown: skill.cooldown, range: skill.range, states: skill.states, groups: skill.groups, areas: skill.areas, stacking: skill.stacking }, [])) {
      for (const s of statsRead(f, true)) read(s, { what: skill.name, how: formulaText(f.source, skillWords), key: `skill:${skill.id}` });
    }
    // Held modifiers: what a skill does to a stat while it lasts.
    for (const state of skill.states) {
      for (const action of state.hold) {
        if (action.kind !== "modifier") continue;
        const m = action.data as { stat: number; kind: number; value: CompiledFormula };
        change(m.stat, { what: skill.name, how: `${changeText(m, game, {})} while it lasts`, key: `skill:${skill.id}` });
      }
    }
  }

  if (items) {
    // Requirements and stats by item: generated types grouped by their template, so a sword's nine
    // makes are one line.
    const requires = new Map<string, { names: string[]; how: string; stats: number[] }>();
    const gives = new Map<number, string[]>();
    for (const type of items.types) {
      if (type.requires) {
        // A template's types with the same requirement are one line: iron swords apart from bronze.
        const group = `${type.template || type.id}:${JSON.stringify(type.requires.source)}`;
        if (!requires.has(group)) requires.set(group, { names: [], how: formulaText(type.requires.source, { ...names, itemLevel: "the item's level" }), stats: statsRead(type.requires) });
        const entry = requires.get(group)!;
        entry.names.push(type.name);
        for (const s of statsRead(type.requires)) if (!entry.stats.includes(s)) entry.stats.push(s);
      }
      for (const m of type.stats) {
        if (!gives.has(m.stat)) gives.set(m.stat, []);
        gives.get(m.stat)!.push(type.name);
      }
    }
    for (const [, entry] of requires) {
      const names = [...new Set(entry.names)];
      const what = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
      for (const s of entry.stats) read(s, { what: `To use ${what}`, how: entry.how, key: "" });
    }
    for (const [stat, names] of gives) {
      const unique = [...new Set(names)];
      change(stat, { what: unique.length > 3 ? `${unique.length} items, such as ${unique.slice(0, 3).join(", ")}` : unique.join(", "), how: "while worn", key: "" });
    }
  }

  if (progression) {
    const own = { own: "level" };
    for (const d of progression.disciplines) {
      if (d.stat >= 0) {
        discipline.set(d.stat, d.index);
        change(d.stat, { what: `Your ${d.name} level`, how: "is this stat", key: `disc:${d.id}` });
      }
      for (const f of [d.cap, d.next]) for (const s of statsRead(f)) if (s !== d.stat) read(s, { what: d.name, how: `${f === d.cap ? "its highest level" : "XP to the next level"}: ${text(f)}`, key: `disc:${d.id}` });
      for (const u of d.unlocks) for (const m of u.modifiers) change(m.stat, { what: `${d.name} levels`, how: changeText(m, game, own), key: `disc:${d.id}` });
    }
    for (const o of progression.origins) {
      const stats = (o.raw.stats ?? {}) as Record<string, number>;
      for (const [id, v] of Object.entries(stats)) change(game.statIndex.get(id), { what: o.name, how: `${v > 0 ? "+" : ""}${v}`, key: `origin:${o.id}` });
      const modifiers = (Array.isArray(o.raw.modifiers) ? o.raw.modifiers : []) as { stat: string; kind?: string; value: number }[];
      for (const m of modifiers) change(game.statIndex.get(m.stat), { what: o.name, how: `${m.value > 0 ? "+" : ""}${m.value}${m.kind === "percent" ? "%" : m.kind === "multiplier" ? "×" : ""}`, key: `origin:${o.id}` });
      for (const [d, list] of o.unlocks) for (const u of list) for (const m of u.modifiers) change(m.stat, { what: `${o.name}: ${progression.disciplines[d].name} levels`, how: changeText(m, game, own), key: `origin:${o.id}` });
    }
    for (const t of progression.trees) {
      for (const n of t.nodes) for (const m of n.modifiers) change(m.stat, { what: `Talent ${n.name} (${t.name})`, how: `${changeText(m, game, { rank: "rank" })}${n.ranks > 1 ? ` (${n.ranks} ranks)` : ""}`, key: `tree:${t.id}` });
    }
  }
  return { readBy, changedBy, discipline };
}

/** How a skill's (or a roll's) formula names read in the book: `caster.intellect` is "your
 *  Intellect", and a bare `level` is the spell's rank. */
export function skillNames(game: GameRules): Record<string, string> {
  const names: Record<string, string> = { level: "rank", random: "a random 0-1", stacks: "stacks", distance: "distance", amount: "the amount" };
  for (const s of game.stats) {
    names[`caster.${s.id}`] = `your ${s.name}`;
    names[`earner.${s.id}`] = `your ${s.name}`;
    names[`target.${s.id}`] = `the target's ${s.name}`;
    names[`victim.${s.id}`] = `the victim's ${s.name}`;
    names[`host.${s.id}`] = `its host's ${s.name}`;
  }
  return names;
}

/** How a stat formula's names read: a bare `intellect` is "your Intellect" - and `level` your Level. */
export function statNames(game: GameRules): Record<string, string> {
  const names = skillNames(game);
  for (const s of game.stats) names[s.id] = `your ${s.name}`;
  return names;
}
