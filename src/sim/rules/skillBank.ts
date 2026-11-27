import { ContentError, Reader, type ContentIssue } from "../../world/content/contentReader";
import { orderPacks, parseFile, type PackSource } from "../../world/content/resolveContent";
import type { Action, CastData, FlagData, ModifierData, MoveData } from "../skills/actions";
import { FLAG_NAMES } from "../skills/flags";
import type { GameRules } from "./gameRules";
import type { SkillDef } from "./skillRules";

// The skill bank (SLICE.md 3b, task I6; SKILLBANK.md): every skill tagged, so class templates can
// pick from it by ratios. Two kinds of tags:
// - **read from the skill file** (what it does and how it is cast): its effects, timing, shape, reach,
//   target, cooldown class, school and resource. They cannot drift from what the skill really does.
// - **hand-written** in `rules/skillBank.json5`: the pool it belongs to, the levels it fits, and how its
//   power splits between purposes when the derived split is not right.
// A bank entry may be a **draft**: a planned skill with no file yet, whose tags are written by hand,
// so a class's progression can be seen and agreed before the skill is made.

/** What a skill does. A skill may do several (a poisoned arrow: an attack and a damage over time). */
export const EFFECTS = [
  "attack", // direct damage
  "debuff.dot", // damage over time on an enemy
  "debuff.flag", // stun, root, slow, silence, interrupt, knock-back
  "debuff.stat", // an enemy stat lowered (armour)
  "debuff.special", // a mark that makes other skills hurt more (hand-tagged: nothing to read it from yet)
  "buff.long", // minutes to an hour, no cooldown
  "buff.short", // seconds, with a cooldown
  "buff.aura", // an absorb or a shield
  "buff.passive", // always on while known
  "heal", // direct healing
  "heal.hot", // healing over time
  "mobility",
  "summon",
  "resource",
  "taunt",
  "resurrect",
] as const;
export type Effect = (typeof EFFECTS)[number];

export const TIMINGS = ["instant", "cast", "channel", "passive"] as const;
export const SHAPES = ["single", "around", "point", "cone", "chain", "self"] as const;
export const REACHES = ["melee", "ranged", "self"] as const;
export const TARGETS = ["enemy", "ally", "self", "none", "point"] as const;
export const POOLS = ["class", "creature", "item", "effect", "test"] as const;

export type Timing = (typeof TIMINGS)[number];
export type Shape = (typeof SHAPES)[number];
export type Reach = (typeof REACHES)[number];
export type Pool = (typeof POOLS)[number];

/** One skill in the bank: the derived tags (or a draft's hand-written ones) and the hand tags. */
export interface BankSkill {
  id: string;
  name: string;
  /** Null for a draft. */
  skill: SkillDef | null;
  /** A draft's one line: what the planned skill does. */
  draft: string;
  pool: Pool;
  effects: Effect[];
  timing: Timing;
  shape: Shape;
  reach: Reach;
  target: string;
  /** Seconds, the constant part (0 for none). */
  cooldown: number;
  cooldownClass: string;
  school: string;
  resources: string[];
  /** A weapon family it needs ("bow"), "" for any. */
  weapon: string;
  /** Stats it raises on its caster or an ally (a passive's, a buff's): a class template takes it only
   *  if it lists one of them. */
  stats: string[];
  /** The levels it is learned at, at the earliest and the latest (a class template picks it there). */
  levels: [number, number];
  /** Purpose to share of its power, adding to 1: damage, control, defence, healing, mobility, support. */
  power: Map<string, number>;
  passive: boolean;
}

export interface SkillBank {
  skills: BankSkill[];
  byId: ReadonlyMap<string, BankSkill>;
  purposes: readonly string[];
  /** Named groups of purposes a template's ratios may use ("defence" might be shield + armour later). */
  free: readonly string[];
  cooldownClasses: { id: string; upTo: number }[];
  /** The levels a cooldown class is learned at when a skill says nothing. */
  defaultLevels: ReadonlyMap<string, [number, number]>;
}

const TOP_KEYS = ["purposes", "free", "cooldowns", "levels", "statPurpose", "effectPurpose", "skills"];
const ENTRY_KEYS = ["pool", "levels", "power", "weapon", "effects", "draft", "name", "timing", "shape", "reach", "target", "cooldown", "school", "resources", "passive", "stats"];

/** Reads `rules/skillBank.json5` over the game's skills. Null for packs without one. */
export function readSkillBank(packs: PackSource[], game: GameRules): SkillBank | null {
  const issues: ContentIssue[] = [];
  let file = "rules/skillBank.json5";
  let data: unknown;
  for (const pack of orderPacks(packs, issues)) {
    for (const entry of pack.files) {
      if (entry.path !== "rules/skillBank.json5") continue;
      file = `${pack.id}/${entry.path}`;
      data = parseFile(file, entry.text, issues);
    }
  }
  if (issues.length > 0) throw new ContentError(issues);
  if (data === undefined) return null;
  const bank = makeBank(data, file, game, issues);
  if (issues.length > 0) throw new ContentError(issues);
  return bank;
}

function makeBank(data: unknown, file: string, game: GameRules, issues: ContentIssue[]): SkillBank {
  const reader = new Reader(issues, file);
  const obj = reader.object(data, "");
  reader.onlyKeys(obj, "", TOP_KEYS);
  const purposes = reader.stringList(obj, "purposes", "");
  const free = obj.free === undefined ? [] : reader.stringList(obj, "free", "");
  const cooldownRaw = reader.object(obj.cooldowns ?? {}, "cooldowns");
  const cooldownClasses = Object.keys(cooldownRaw).map((id) => ({ id, upTo: reader.number(cooldownRaw, id, "cooldowns", { min: 0 }) })).sort((a, b) => a.upTo - b.upTo);
  const levelsRaw = reader.object(obj.levels ?? {}, "levels");
  const defaultLevels = new Map<string, [number, number]>();
  for (const id of Object.keys(levelsRaw)) defaultLevels.set(id, reader.range(levelsRaw, id, "levels", { allowEqual: true }));
  const purposeMap = (key: string): Map<string, string> => {
    const raw = reader.object(obj[key] ?? {}, key);
    const out = new Map<string, string>();
    for (const id of Object.keys(raw)) {
      const p = reader.string(raw, id, key);
      if (!purposes.includes(p)) reader.fail(`${key}.${id}`, `"${p}" is not a purpose (known: ${purposes.join(", ")})`);
      out.set(id, p);
    }
    return out;
  };
  const statPurpose = purposeMap("statPurpose");
  const effectPurpose = purposeMap("effectPurpose");
  for (const e of effectPurpose.keys()) if (!(EFFECTS as readonly string[]).includes(e)) reader.fail(`effectPurpose.${e}`, `not an effect (known: ${EFFECTS.join(", ")})`);
  const classOf = (cooldown: number, effects: Effect[], passive: boolean): string => {
    if (passive) return "passive";
    if (cooldown <= 0 && effects.length > 0 && effects.every((e) => e === "buff.long")) return "none";
    return cooldownClasses.find((c) => cooldown <= c.upTo)?.id ?? cooldownClasses[cooldownClasses.length - 1]?.id ?? "";
  };

  const entries = reader.object(obj.skills ?? {}, "skills");
  const skills: BankSkill[] = [];
  for (const id of Object.keys(entries)) {
    const path = `skills.${id}`;
    const raw = reader.object(entries[id], path);
    reader.onlyKeys(raw, path, ENTRY_KEYS);
    const pool = reader.string(raw, "pool", path) as Pool;
    if (!(POOLS as readonly string[]).includes(pool)) reader.fail(`${path}.pool`, `not a pool (known: ${POOLS.join(", ")})`);
    const index = game.skillIndex.get(id);
    const draft = raw.draft === undefined ? "" : reader.string(raw, "draft", path);
    if (index === undefined && !draft) {
      reader.fail(path, `no skill "${id}" in skills/, and no \`draft\` line to make it a planned one`);
      continue;
    }
    if (index !== undefined && draft) reader.fail(`${path}.draft`, "the skill exists: drop its draft tags, they are read from the file now");
    const skill = index === undefined ? null : game.skills[index];
    const derived = skill ? deriveTags(game, skill, statPurpose) : null;
    const handEffects = raw.effects === undefined ? null : reader.stringList(raw, "effects", path);
    for (const e of handEffects ?? []) if (!(EFFECTS as readonly string[]).includes(e)) reader.fail(`${path}.effects`, `"${e}" is not an effect (known: ${EFFECTS.join(", ")})`);
    // A real skill's effects are read; hand ones only add what cannot be read (debuff.special).
    const effects = [...new Set([...(derived?.effects ?? []), ...((handEffects ?? []) as Effect[])])];
    const pick = <T extends string>(key: string, list: readonly T[], read: T | undefined, fallback: T): T => {
      if (raw[key] === undefined) return read ?? fallback;
      const v = reader.string(raw, key, path) as T;
      if (!list.includes(v)) reader.fail(`${path}.${key}`, `"${v}" is not one of ${list.join(", ")}`);
      return v;
    };
    const passive = raw.passive === undefined ? (derived?.passive ?? false) : reader.boolean(raw, "passive", path, false);
    const cooldown = raw.cooldown === undefined ? (derived?.cooldown ?? 0) : reader.number(raw, "cooldown", path, { min: 0 });
    const cooldownClass = classOf(cooldown, effects, passive);
    const levels = raw.levels === undefined ? (defaultLevels.get(cooldownClass) ?? [1, 60]) : reader.range(raw, "levels", path, { allowEqual: true });
    // Power: the hand split if there is one, else even over the purposes its effects serve.
    const power = new Map<string, number>();
    if (raw.power !== undefined) {
      const p = reader.object(raw.power, `${path}.power`);
      let sum = 0;
      for (const k of Object.keys(p)) {
        if (!purposes.includes(k)) reader.fail(`${path}.power.${k}`, `not a purpose (known: ${purposes.join(", ")})`);
        const v = reader.number(p, k, `${path}.power`, { min: 0 });
        power.set(k, v);
        sum += v;
      }
      if (Math.abs(sum - 1) > 0.01) reader.fail(`${path}.power`, `shares add to ${sum}, not 1`);
    } else {
      const served = [...new Set([...(derived?.purposes ?? []), ...effects.map((e) => effectPurpose.get(e)).filter((p): p is string => !!p)])];
      for (const p of served) power.set(p, 1 / served.length);
    }
    skills.push({
      id,
      name: skill?.name ?? (raw.name === undefined ? id : reader.string(raw, "name", path)),
      skill,
      draft,
      pool,
      effects,
      timing: pick("timing", TIMINGS, derived?.timing, "instant"),
      shape: pick("shape", SHAPES, derived?.shape, "single"),
      reach: pick("reach", REACHES, derived?.reach, "ranged"),
      target: pick("target", TARGETS, derived?.target as never, "enemy"),
      cooldown,
      cooldownClass,
      school: raw.school === undefined ? (derived?.school ?? "physical") : reader.string(raw, "school", path),
      resources: raw.resources === undefined ? (derived?.resources ?? []) : reader.stringList(raw, "resources", path),
      weapon: raw.weapon === undefined ? "" : reader.string(raw, "weapon", path),
      stats: raw.stats === undefined ? (derived?.stats ?? []) : reader.stringList(raw, "stats", path),
      levels,
      power,
      passive,
    });
    if (pool === "class" && power.size === 0) reader.fail(path, "a class skill needs a purpose: give it `power` or effects that map to one");
  }
  for (const s of game.skills) if (!(s.id in entries)) reader.fail("skills", `skill "${s.id}" is not in the bank: give it at least a pool`);
  return { skills, byId: new Map(skills.map((s) => [s.id, s])), purposes, free, cooldownClasses, defaultLevels };
}

/** What a skill's file says of it, read from its fields and actions. */
export interface DerivedTags {
  effects: Effect[];
  /** Purposes its stat changes serve (by `statPurpose`): a passive's or a buff's. */
  purposes: string[];
  timing: Timing;
  shape: Shape;
  reach: Reach;
  target: string;
  cooldown: number;
  school: string;
  resources: string[];
  stats: string[];
  passive: boolean;
}

const LONG_BUFF = 300; // seconds: a buff that lasts this long is a long one
const MELEE = 6; // metres

/**
 * Reads a skill's tags from its definition: every action of every state, and of the skills it
 * applies (a strike that applies a burn is an attack and a damage over time), each judged by who it
 * lands on - an enemy, an ally or the caster.
 */
export function deriveTags(game: GameRules, skill: SkillDef, statPurpose: ReadonlyMap<string, string>): DerivedTags {
  const effects = new Set<Effect>();
  const purposes = new Set<string>();
  const shapes = new Set<Shape>();
  const raised = new Set<string>();
  const resources = new Set(skill.cost.map((c) => game.resources[c.resource]?.id ?? "?"));
  const seen = new Set<number>();
  const relationOf = (s: SkillDef, groupIndex: number, hostRelation: string): string => {
    const g = s.groups[groupIndex];
    if (!g) return hostRelation;
    switch (g.from.kind) {
      case "caster":
        return "self";
      case "target":
        return s.target === "enemy" ? "enemy" : s.target === "ally" ? "ally" : s.target === "self" ? "self" : g.filter.relation === "enemy" ? "enemy" : "ally";
      case "host":
        return hostRelation;
      case "area": {
        const area = s.areas[g.from.area];
        if (area) shapes.add(area.at === "caster" ? "around" : area.at === "point" ? "point" : area.shape === "cone" ? "cone" : "around");
        return g.filter.relation === "enemy" ? "enemy" : g.filter.relation === "ally" ? "ally" : "enemy";
      }
      default:
        if (g.chain) shapes.add("chain");
        return g.filter.relation === "ally" ? "ally" : "enemy";
    }
  };
  const lengthOf = (s: SkillDef): number => {
    let total = 0;
    for (const st of s.states) if (st.length.kind === "fixed") total += st.length.length.constant ?? 0;
    else if (st.length.kind === "forever") total = Infinity;
    return total;
  };
  const walk = (s: SkillDef, hostRelation: string, applied: boolean): void => {
    if (seen.has(s.index)) return;
    seen.add(s.index);
    const lasting = lengthOf(s);
    for (const st of s.states) {
      const visit = (actions: readonly Action[], ticking: boolean, held: boolean): void => {
        for (const a of actions) {
          const to = relationOf(s, a.group, hostRelation);
          const d = a.data as Record<string, unknown>;
          switch (a.kind) {
            case "damage":
              if (to !== "self") effects.add(ticking ? "debuff.dot" : "attack");
              break;
            case "heal":
              effects.add(ticking ? "heal.hot" : "heal");
              break;
            case "absorb":
              effects.add("buff.aura");
              break;
            case "resource":
              if (to === "self") {
                effects.add("resource");
                resources.add(game.resources[(d.resource as number)]?.id ?? "?");
              }
              break;
            case "modifier": {
              const m = a.data as ModifierData;
              const stat = game.stats[m.stat]?.id ?? "";
              const negative = (m.value.constant ?? 1) < 0;
              if (to === "enemy") effects.add(stat === "speed" && negative ? "debuff.flag" : "debuff.stat");
              else {
                effects.add(s.passive && !applied ? "buff.passive" : lasting >= LONG_BUFF ? "buff.long" : "buff.short");
                const p = statPurpose.get(stat);
                if (p) purposes.add(p);
                if (!negative) raised.add(stat);
              }
              break;
            }
            case "flag": {
              const flags = (a.data as FlagData).flags.map((f) => FLAG_NAMES[f]);
              if (to === "enemy") effects.add("debuff.flag");
              else if (flags.some((f) => f.startsWith("immune"))) effects.add("buff.short");
              break;
            }
            case "interrupt":
              effects.add("debuff.flag");
              break;
            case "move": {
              const kind = (a.data as MoveData).kind;
              effects.add(kind === "knockback" || kind === "pull" ? "debuff.flag" : "mobility");
              break;
            }
            case "summon":
              effects.add("summon");
              break;
            case "threat":
              if ((a.data as { taunt: boolean }).taunt) effects.add("taunt");
              break;
            case "cast": {
              const c = a.data as CastData;
              const other = game.skills[c.skill];
              if (other) walk(other, to, true);
              break;
            }
            case "if":
            case "chance":
              visit((d.then as Action[]) ?? [], ticking, held);
              visit((d.otherwise as Action[]) ?? [], ticking, held);
              break;
          }
        }
      };
      visit(st.enter, false, false);
      visit(st.tick, true, false);
      visit(st.exit, false, false);
      visit(st.hold, false, true);
    }
  };
  // Who has its magic: its target for a cast-on buff, a victim for an effect shown as a debuff (a
  // burn, read on its own), else the caster.
  const host = skill.hostOn === "target" ? (skill.target === "ally" ? "ally" : "enemy") : skill.display === "debuff" ? "enemy" : "self";
  walk(skill, host, skill.display === "debuff");
  // A creature's summon (the totem) carries its damage in its own passive: the summon is the effect.
  const timing: Timing = skill.passive ? "passive" : skill.states.some((st) => st.bar === "channel") ? "channel" : skill.states.some((st) => st.bar === "cast") ? "cast" : "instant";
  const range = skill.range?.constant ?? null;
  const shape: Shape = shapes.has("point") ? "point" : shapes.has("cone") ? "cone" : shapes.has("chain") ? "chain" : shapes.has("around") ? "around" : skill.target === "enemy" || skill.target === "ally" ? "single" : "self";
  const reach: Reach = skill.target === "enemy" ? (range !== null && range <= MELEE ? "melee" : "ranged") : shape === "around" && skill.target !== "point" ? "melee" : skill.target === "ally" ? "ranged" : skill.target === "point" ? "ranged" : "self";
  const school = skill.tags.find((t) => t.startsWith("school."))?.slice("school.".length) ?? (skill.type === "physical" ? "physical" : "arcane");
  return {
    effects: EFFECTS.filter((e) => effects.has(e)),
    purposes: [...purposes],
    timing,
    shape,
    reach,
    target: skill.target,
    cooldown: skill.cooldown.constant ?? 0,
    school,
    resources: [...resources],
    stats: [...raised],
    passive: skill.passive,
  };
}

/** One line of a bank skill's tags, for reports and the rule book. */
export function bankLine(s: BankSkill): string {
  const power = [...s.power].map(([p, v]) => (s.power.size > 1 ? `${p} ${Math.round(v * 100)}%` : p)).join(" + ");
  const what = s.effects.join(" + ") || "-";
  const how = s.passive ? "passive" : `${s.timing}, ${s.shape === "single" ? s.reach : s.shape}${s.cooldownClass ? `, ${s.cooldownClass}` : ""}`;
  return `${s.name}${s.skill ? "" : " (draft)"}: ${what} | ${how} | ${power} | levels ${s.levels[0]}-${s.levels[1]}`;
}
