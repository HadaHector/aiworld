import { ContentError, Reader, type ContentIssue } from "../../world/content/contentReader";
import { orderPacks, parseFile, type PackSource } from "../../world/content/resolveContent";
import type { BalanceRules } from "./balanceRules";
import type { BankSkill, SkillBank } from "./skillBank";

// Class templates and the generator (SLICE.md 3b, task I6; SKILLBANK.md). A class template says what a
// class is - ratios of purposes at key levels, its resources, schools, weapon and liked reach, and
// limits on long cooldowns - and the generator picks its skills out of the bank, level by level, to
// the counts of the `skillsActive` and `skillsPassive` curves. A template may pin picks by hand; the
// generator fills the rest. The same description makes the hand-picked classes and generated ones.

export interface ClassTemplate {
  id: string;
  file: string;
  name: string;
  axis: number;
  distance: string;
  resources: string[];
  schools: string[];
  weapon: string;
  /** The stats it builds on: a buff or passive raising none of them is not for it. */
  stats: string[];
  reach: Map<string, number>;
  /** Key level to purpose shares (adding to 1). */
  ratios: { level: number; shares: Map<string, number> }[];
  /** Cooldown class to the most a class may have by its last level. */
  limits: Map<string, number>;
  /** Set-up and pay-off pairs it should have by its last level (Heroic Strike's sunder and Mortal Strike). */
  combos: number;
  /** Hand picks: skill and the level it is learned at. */
  picks: { skill: string; at: number }[];
}

const TEMPLATE_KEYS = ["name", "axis", "distance", "resources", "schools", "weapon", "stats", "reach", "ratios", "limits", "combos", "picks"];

/** Reads `classTemplates/*.json5` against the bank. */
export function readClassTemplates(packs: PackSource[], bank: SkillBank): ClassTemplate[] {
  const issues: ContentIssue[] = [];
  const found = new Map<string, { file: string; data: unknown }>();
  for (const pack of orderPacks(packs, issues)) {
    for (const entry of pack.files) {
      const parts = entry.path.split("/");
      if (parts.length !== 2 || parts[0] !== "classTemplates") continue;
      const file = `${pack.id}/${entry.path}`;
      const data = parseFile(file, entry.text, issues);
      if (data !== undefined) found.set(parts[1].replace(/\.json5$/, ""), { file, data });
    }
  }
  const out: ClassTemplate[] = [];
  for (const [id, { file, data }] of [...found].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const reader = new Reader(issues, file);
    const obj = reader.object(data, "");
    reader.onlyKeys(obj, "", TEMPLATE_KEYS);
    const reach = new Map<string, number>();
    const reachRaw = reader.object(obj.reach ?? { melee: 1, ranged: 1 }, "reach");
    for (const k of Object.keys(reachRaw)) reach.set(k, reader.number(reachRaw, k, "reach", { min: 0 }));
    const ratios: ClassTemplate["ratios"] = [];
    const ratiosRaw = reader.object(obj.ratios, "ratios");
    for (const key of Object.keys(ratiosRaw)) {
      const level = Number(key);
      if (!Number.isInteger(level) || level < 1) reader.fail(`ratios.${key}`, "a key level is a whole number from 1");
      const raw = reader.object(ratiosRaw[key], `ratios.${key}`);
      const shares = new Map<string, number>();
      let sum = 0;
      for (const p of Object.keys(raw)) {
        if (!bank.purposes.includes(p)) reader.fail(`ratios.${key}.${p}`, `not a purpose (known: ${bank.purposes.join(", ")})`);
        const v = reader.number(raw, p, `ratios.${key}`, { min: 0 });
        shares.set(p, v);
        sum += v;
      }
      if (Math.abs(sum - 1) > 0.01) reader.fail(`ratios.${key}`, `shares add to ${sum}, not 1`);
      ratios.push({ level, shares });
    }
    ratios.sort((a, b) => a.level - b.level);
    if (ratios.length === 0) reader.fail("ratios", "a template needs ratios at one level at least");
    const limits = new Map<string, number>();
    const limitsRaw = reader.object(obj.limits ?? {}, "limits");
    for (const k of Object.keys(limitsRaw)) limits.set(k, reader.number(limitsRaw, k, "limits", { min: 0, integer: true }));
    const picks: ClassTemplate["picks"] = [];
    const picksRaw = obj.picks === undefined ? [] : reader.array(obj, "picks", "");
    picksRaw.forEach((p, i) => {
      const raw = reader.object(p, `picks[${i}]`);
      reader.onlyKeys(raw, `picks[${i}]`, ["skill", "at"]);
      const skill = reader.string(raw, "skill", `picks[${i}]`);
      if (!bank.byId.has(skill)) reader.fail(`picks[${i}].skill`, `no skill "${skill}" in the bank`);
      picks.push({ skill, at: reader.number(raw, "at", `picks[${i}]`, { min: 1, integer: true }) });
    });
    out.push({
      id,
      file,
      name: reader.string(obj, "name", ""),
      axis: reader.optionalNumber(obj, "axis", "", 0.5, { min: 0, max: 1 }),
      distance: obj.distance === undefined ? "holds" : reader.string(obj, "distance", ""),
      resources: obj.resources === undefined ? [] : reader.stringList(obj, "resources", ""),
      schools: obj.schools === undefined ? [] : reader.stringList(obj, "schools", ""),
      weapon: obj.weapon === undefined ? "" : reader.string(obj, "weapon", ""),
      stats: obj.stats === undefined ? [] : reader.stringList(obj, "stats", ""),
      reach,
      ratios,
      limits,
      combos: reader.optionalNumber(obj, "combos", "", 0, { min: 0, integer: true }),
      picks,
    });
  }
  if (issues.length > 0) throw new ContentError(issues);
  return out;
}

/** The purpose shares a template asks for at a level: straight lines between its key levels. */
export function ratiosAt(template: ClassTemplate, level: number): Map<string, number> {
  const r = template.ratios;
  if (level <= r[0].level) return new Map(r[0].shares);
  const last = r[r.length - 1];
  if (level >= last.level) return new Map(last.shares);
  const i = r.findIndex((k) => k.level > level);
  const a = r[i - 1];
  const b = r[i];
  const t = (level - a.level) / (b.level - a.level);
  const out = new Map<string, number>();
  for (const p of new Set([...a.shares.keys(), ...b.shares.keys()])) out.set(p, (a.shares.get(p) ?? 0) * (1 - t) + (b.shares.get(p) ?? 0) * t);
  return out;
}

export interface ClassPick {
  skill: BankSkill;
  at: number;
  passive: boolean;
  pinned: boolean;
  /** Its share of the class's power at the last level (adding to 1 over the class). */
  share: number;
}

export interface GeneratedClass {
  template: ClassTemplate;
  picks: ClassPick[];
  /** Each active's later ranks: the level it reaches each (bank `ranks`). */
  ranks: { skill: BankSkill; level: number; rank: number }[];
  /** Pay-offs whose set-up the class has: [pay-off, the skill that sets it up]. */
  combos: [BankSkill, BankSkill][];
  /** Level to how many actives and passives it knows there. */
  counts: { level: number; active: number; passive: number }[];
  /** The class's purpose shares at a level, from its picks. */
  sharesAt(level: number): Map<string, number>;
  /** Sum of |picked - asked| over the purposes at a level (0 is exact, 2 is all wrong). */
  errorAt(level: number): number;
  /** What did not fit: a pinned skill out of its levels, no candidate for a slot. */
  problems: string[];
}

/** Whether a bank skill may go to a class of this template at all. */
export function fits(template: ClassTemplate, s: BankSkill, bank: SkillBank): boolean {
  if (s.pool !== "class" || bank.free.includes(s.id)) return false;
  if (s.resources.some((r) => !template.resources.includes(r))) return false;
  if (template.schools.length > 0 && !template.schools.includes(s.school)) return false;
  if (s.weapon && s.weapon !== template.weapon) return false;
  if (s.stats.length > 0 && !s.stats.some((st) => template.stats.includes(st))) return false;
  if (s.reach !== "self" && (template.reach.get(s.reach) ?? 0) <= 0) return false;
  return true;
}

/**
 * Picks a class's skills, level by level up to `top`: at each level the curves add active and passive
 * slots; a slot takes a pinned skill of that level, else the candidate (fitting the template, its
 * levels holding this one, within the cooldown limits) that brings the class's purpose shares closest
 * to what the template asks there, liked reach and a closing level window breaking ties, and never a
 * second skill of the same shape (timing, shape and first effect) while another will do.
 */
export function generateClass(template: ClassTemplate, bank: SkillBank, balance: BalanceRules, top = 10): GeneratedClass {
  const picks: ClassPick[] = [];
  const problems: string[] = [];
  const counts: GeneratedClass["counts"] = [];
  const taken = new Set<string>();
  const used = new Map<string, number>();
  const shapeOf = (s: BankSkill): string => `${s.timing}/${s.shape}/${s.effects[0] ?? ""}`;
  const sum = (list: BankSkill[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const s of list) for (const [p, v] of s.power) out.set(p, (out.get(p) ?? 0) + v);
    const total = [...out.values()].reduce((a, b) => a + b, 0) || 1;
    for (const [p, v] of out) out.set(p, v / total);
    return out;
  };
  const error = (have: Map<string, number>, want: Map<string, number>): number => {
    let e = 0;
    for (const p of new Set([...have.keys(), ...want.keys()])) e += Math.abs((have.get(p) ?? 0) - (want.get(p) ?? 0));
    return e;
  };
  const add = (s: BankSkill, at: number, pinned: boolean): void => {
    picks.push({ skill: s, at, passive: s.passive, pinned, share: 0 });
    taken.add(s.id);
    used.set(s.cooldownClass, (used.get(s.cooldownClass) ?? 0) + 1);
  };
  const round = (name: string, level: number): number => Math.round(balance.curve(name, level));
  for (let level = 1; level <= top; level++) {
    for (const passive of [false, true]) {
      const want = round(passive ? "skillsPassive" : "skillsActive", level);
      const pinned = template.picks.filter((p) => p.at === level).map((p) => bank.byId.get(p.skill)!).filter((s) => s.passive === passive);
      for (const s of pinned) {
        if (taken.has(s.id)) continue;
        if (level < s.levels[0] || level > s.levels[1]) problems.push(`${s.id} is pinned at ${level}, outside its levels ${s.levels[0]}-${s.levels[1]}`);
        if (!fits(template, s, bank)) problems.push(`${s.id} is pinned but does not fit the template (resource, school, weapon or reach)`);
        add(s, level, true);
      }
      let have = picks.filter((p) => p.passive === passive).length;
      while (have < want) {
        const target = ratiosAt(template, level);
        const known = picks.map((p) => p.skill);
        const pinnedLater = new Set(template.picks.filter((p) => p.at > level).map((p) => p.skill));
        const candidates = bank.skills.filter((s) =>
          s.passive === passive && !taken.has(s.id) && !pinnedLater.has(s.id) && fits(template, s, bank) &&
          level >= s.levels[0] && level <= s.levels[1] &&
          (template.limits.get(s.cooldownClass) ?? Infinity) > (used.get(s.cooldownClass) ?? 0));
        if (candidates.length === 0) {
          problems.push(`no ${passive ? "passive" : "active"} skill fits level ${level}`);
          break;
        }
        const shapes = new Set(known.map(shapeOf));
        const score = (s: BankSkill): number => {
          const e = error(sum([...known, s]), target);
          const reach = s.reach === "self" ? 0.5 : (template.reach.get(s.reach) ?? 0);
          const closing = 1 / (s.levels[1] - level + 1);
          const repeat = shapes.has(shapeOf(s)) ? 0.3 : 0;
          // A pay-off whose set-up the class has (or a set-up for a pay-off it has) makes a combination.
          const sets = (k: BankSkill, effect: string): boolean => k.applies.includes(effect) || k.id === effect;
          const combo = (s.combo && known.some((k) => sets(k, s.combo))) || known.some((k) => k.combo && sets(s, k.combo)) ? 0.2 : 0;
          return -e + 0.15 * reach + 0.1 * closing - repeat + combo;
        };
        candidates.sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1));
        add(candidates[0], level, false);
        have++;
      }
    }
    counts.push({ level, active: picks.filter((p) => !p.passive).length, passive: picks.filter((p) => p.passive).length });
  }
  // Power shares at the top: each purpose's share of the class split over the skills that serve it.
  const want = ratiosAt(template, top);
  const served = new Map<string, number>();
  for (const p of picks) for (const [k, v] of p.skill.power) served.set(k, (served.get(k) ?? 0) + v);
  for (const p of picks) {
    let share = 0;
    for (const [k, v] of p.skill.power) share += (v / (served.get(k) ?? 1)) * (want.get(k) ?? 0);
    p.share = share;
  }
  const totalShare = picks.reduce((a, p) => a + p.share, 0) || 1;
  for (const p of picks) p.share /= totalShare;
  for (const [k, v] of want) if (v > 0 && !served.has(k)) problems.push(`nothing serves ${k}, which the template asks ${Math.round(v * 100)}% of`);
  const ranks: GeneratedClass["ranks"] = [];
  if (bank.ranks.every > 0) {
    for (const p of picks) {
      if (p.passive) continue;
      for (let rank = 2; rank <= bank.ranks.max; rank++) {
        const level = p.at + (rank - 1) * bank.ranks.every;
        if (level > top) break;
        ranks.push({ skill: p.skill, level, rank });
      }
    }
    ranks.sort((a, b) => a.level - b.level);
  }
  const combos: [BankSkill, BankSkill][] = [];
  for (const p of picks) {
    if (!p.skill.combo) continue;
    const setup = picks.find((q) => q !== p && (q.skill.applies.includes(p.skill.combo) || q.skill.id === p.skill.combo));
    if (setup) combos.push([p.skill, setup.skill]);
  }
  if (combos.length < template.combos) problems.push(`${combos.length} combination${combos.length === 1 ? "" : "s"}, the template asks ${template.combos}`);
  const sharesAt = (level: number): Map<string, number> => sum(picks.filter((p) => p.at <= level).map((p) => p.skill));
  return { template, picks, ranks, combos, counts, sharesAt, errorAt: (level) => error(sharesAt(level), ratiosAt(template, level)), problems };
}

/** A class's progression in lines: per level, what it learns. */
export function progressionLines(c: GeneratedClass): string[] {
  const lines: string[] = [];
  const top = c.counts.length;
  for (let level = 1; level <= top; level++) {
    const now = c.picks.filter((p) => p.at === level).map((p) => `${p.skill.name}${p.skill.skill ? "" : "*"}${p.passive ? " (passive)" : ""}${p.pinned ? " [pinned]" : ""}`);
    const ranked = c.ranks.filter((r) => r.level === level).map((r) => `${r.skill.name} ${r.rank}`);
    if (now.length === 0 && ranked.length === 0) continue;
    lines.push(`  ${String(level).padStart(2)}  ${now.join(", ")}${ranked.length ? `${now.length ? "   " : ""}ranks: ${ranked.join(", ")}` : ""}`);
  }
  return lines;
}

export const percent = (m: Map<string, number>): string => [...m].filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]).map(([p, v]) => `${p} ${Math.round(v * 100)}%`).join(", ");
