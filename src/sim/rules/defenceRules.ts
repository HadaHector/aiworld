// The defence model (SLICE.md 3a, *Full defence*; ABILITIES.md, *Defence*): the parts a blow goes
// through on its way to health - armour, block (shields), dodge, parry, per-school resistance, a
// ward that absorbs, crowd-control avoidance - each switchable in `rules/combat.json5`. Pure: read
// here, rolled in sim/skills/combat.ts.
//
// Each part is an **effective-health multiplier**: how many times more raw damage it takes to bring a
// unit down with it than without. `defenceMultiplier` states them for a unit's stats at a level, so
// the balance curves and the duel tool can read them; `defenceFor` goes the other way, sharing a
// target multiplier (a role's or the player's mitigation curve) out among the parts that are on, so
// a pack can turn any part off and the product still lands on the curve.

import type { StatDef } from "./gameRules";
import { joinPath, Reader, type RawObject } from "../../world/content/contentReader";

export const DEFENCE_PARTS = ["armor", "dodge", "parry", "block", "resist", "absorb", "control"] as const;
export type DefencePart = (typeof DEFENCE_PARTS)[number];
/** What a roll set's blows meet: weapons the physical parts, spells resistance, "none" neither. */
export const DEFENCE_AGAINST = ["physical", "spell", "none"] as const;
export type DefenceAgainst = (typeof DEFENCE_AGAINST)[number];

/** The stats the parts read, by id. A stat the packs do not define reads as 0 (its part is inert). */
export const DEFENCE_STATS = {
  armor: "armor",
  agility: "agility",
  dodge: "dodge",
  parry: "parry",
  defenceSkill: "defenceSkill",
  blockChance: "blockChance",
  blockValue: "blockValue",
  ward: "ward",
  controlAvoid: "controlAvoid",
} as const;
/** A school's resistance stat: `fireResist` for `school.fire`. */
export const resistStat = (school: string): string => `${school}Resist`;

export interface DefenceRules {
  on: Record<DefencePart, boolean>;
  /** A part's share of the effective-health budget `defenceFor` hands out (block: gear only, 0). */
  weight: Record<DefencePart, number>;
  /** The most a part's chance (or reduction) can be. */
  cap: Record<DefencePart, number>;
  /** Armour and resistance: rating / (rating + base + perLevel * the attacker's level). */
  armor: { base: number; perLevel: number };
  resist: { base: number; perLevel: number; schools: string[] };
  /** Dodge chance: dodge / 100 + agility * perAgility. Parry: parry / 100 + defenceSkill * perDefence. */
  dodge: { perAgility: number };
  parry: { perDefence: number };
  /** Crowd-control avoidance: the share of a fight's damage taken while controlled, which an avoided
   *  stun or root is worth (its effective health is 1 / (1 - chance * damageShare)). */
  control: { damageShare: number };
  /** The share (as a power) of the physical budget spells meet: 1 the same, 0 spells unmitigated. */
  spellBudget: number;
  /** The stats' indices in a stat block, -1 where the packs have none. */
  stats: Record<keyof typeof DEFENCE_STATS, number>;
  resistStats: Map<string, number>;
}

const DEFAULTS = {
  on: { armor: true, dodge: true, parry: true, block: true, resist: true, absorb: false, control: true },
  weight: { armor: 1, dodge: 0.12, parry: 0.08, block: 0, resist: 1, absorb: 0.1, control: 0.04 },
  cap: { armor: 0.75, dodge: 0.3, parry: 0.25, block: 0.6, resist: 0.75, absorb: Infinity, control: 0.5 },
};
const SCHOOLS = ["fire", "frost", "nature", "arcane", "shadow", "holy"];

/** Defence as before the model: armour only, at Classic's constants (a pack without `defence`). */
export function armourOnly(stats: readonly StatDef[]): DefenceRules {
  return readDefence(undefined, new Reader([], "rules/combat.json5"), stats, { armorOnly: true });
}

/** `defence` in `rules/combat.json5`. */
export function readDefence(raw: unknown, reader: Reader, stats: readonly StatDef[], options: { armorOnly?: boolean } = {}): DefenceRules {
  const obj: RawObject = raw === undefined ? {} : reader.object(raw, "defence");
  reader.onlyKeys(obj, "defence", ["parts", "spellBudget"]);
  const partsRaw: RawObject = obj.parts === undefined ? {} : reader.object(obj.parts, "defence.parts");
  for (const key of Object.keys(partsRaw)) if (!(DEFENCE_PARTS as readonly string[]).includes(key)) reader.fail(joinPath("defence.parts", key), `unknown part (known: ${DEFENCE_PARTS.join(", ")})`);
  const part = (id: DefencePart): RawObject => (partsRaw[id] === undefined ? {} : reader.object(partsRaw[id], joinPath("defence.parts", id)));
  const extra: Record<DefencePart, string[]> = { armor: ["base", "perLevel"], dodge: ["perAgility"], parry: ["perDefence"], block: [], resist: ["base", "perLevel", "schools"], absorb: [], control: ["damageShare"] };
  const on = { ...DEFAULTS.on };
  const weight = { ...DEFAULTS.weight };
  const cap = { ...DEFAULTS.cap };
  const raws = {} as Record<DefencePart, RawObject>;
  for (const id of DEFENCE_PARTS) {
    const path = joinPath("defence.parts", id);
    const p = part(id);
    raws[id] = p;
    reader.onlyKeys(p, path, ["on", "weight", "cap", ...extra[id]]);
    on[id] = options.armorOnly ? id === "armor" : reader.boolean(p, "on", path, DEFAULTS.on[id]);
    weight[id] = reader.optionalNumber(p, "weight", path, DEFAULTS.weight[id], { min: 0 });
    if (p.cap !== undefined) cap[id] = reader.number(p, "cap", path, { min: 0, max: id === "absorb" ? Infinity : 0.95 });
  }
  const num = (id: DefencePart, key: string, fallback: number): number => reader.optionalNumber(raws[id], key, joinPath("defence.parts", id), fallback, { min: 0 });
  const schools = raws.resist.schools === undefined ? SCHOOLS : reader.stringList(raws.resist, "schools", "defence.parts.resist");
  const index = new Map(stats.map((s) => [s.id, s.index]));
  const statIndex = Object.fromEntries(Object.entries(DEFENCE_STATS).map(([k, id]) => [k, index.get(id) ?? -1])) as DefenceRules["stats"];
  return {
    on,
    weight,
    cap,
    armor: { base: num("armor", "base", 400), perLevel: num("armor", "perLevel", 85) },
    resist: { base: num("resist", "base", 400), perLevel: num("resist", "perLevel", 85), schools },
    dodge: { perAgility: num("dodge", "perAgility", 0.0005) },
    parry: { perDefence: num("parry", "perDefence", 0.005) },
    control: { damageShare: reader.optionalNumber(raws.control, "damageShare", "defence.parts.control", 0.2, { min: 0, max: 1 }) },
    spellBudget: reader.optionalNumber(obj, "spellBudget", "defence", 0.5, { min: 0, max: 1 }),
    stats: statIndex,
    resistStats: new Map(schools.map((s) => [s, index.get(resistStat(s)) ?? -1])),
  };
}

// --- what each part does, from a unit's stats ---

/** A unit's stats by id (0 for one it does not have). */
export type StatReader = (id: string) => number;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
/** Rating against a level: armour's and resistance's share stopped. */
const reduction = (rating: number, f: { base: number; perLevel: number }, level: number, cap: number): number => {
  const k = f.base + f.perLevel * Math.max(1, level);
  return rating <= 0 || k <= 0 ? 0 : Math.min(cap, rating / (rating + k));
};

/** Each part's chance or share for a unit, against an attacker of `attackerLevel` (0 where off). */
export interface DefenceValues {
  dodge: number;
  parry: number;
  block: number;
  blockValue: number;
  armor: number;
  /** By school, the share resisted. */
  resist: (school: string) => number;
  ward: number;
  control: number;
}

export function defenceValues(d: DefenceRules, get: StatReader, attackerLevel: number): DefenceValues {
  const s = DEFENCE_STATS;
  return {
    dodge: d.on.dodge ? clamp(get(s.dodge) / 100 + get(s.agility) * d.dodge.perAgility, 0, d.cap.dodge) : 0,
    parry: d.on.parry ? clamp(get(s.parry) / 100 + get(s.defenceSkill) * d.parry.perDefence, 0, d.cap.parry) : 0,
    block: d.on.block ? clamp(get(s.blockChance) / 100, 0, d.cap.block) : 0,
    blockValue: d.on.block ? Math.max(0, get(s.blockValue)) : 0,
    armor: d.on.armor ? reduction(get(s.armor), d.armor, attackerLevel, d.cap.armor) : 0,
    resist: (school) => (d.on.resist ? reduction(get(resistStat(school)), d.resist, attackerLevel, d.cap.resist) : 0),
    ward: d.on.absorb ? Math.max(0, get(s.ward)) : 0,
    control: d.on.control ? clamp(get(s.controlAvoid) / 100, 0, d.cap.control) : 0,
  };
}

/** The effective-health multipliers of a unit's defence, by part and in all. */
export interface DefenceReport {
  /** Each part's multiplier: 1 where it is off or the unit has none of it. Their product over the
   *  physical parts (armour, dodge, parry, block, absorb, control) is `physical`; over resist,
   *  absorb and control, `spell`. */
  parts: Record<DefencePart, number>;
  physical: number;
  spell: number;
}

export interface DefenceOptions {
  /** The attacker's level, for armour and resistance (the unit's own by default). */
  attackerLevel?: number;
  /** The unit's health, for the ward's worth (a ward of 50 on 200 health is 1.25). */
  health?: number;
  /** A typical physical blow, for a block's worth (by default 7% of health: a same-level normal
   *  creature's swing, by the balance curves). */
  hit?: number;
  /** The spell's school (by default the mean over the schools). */
  school?: string;
  /** Whether the blows can be parried (melee); true by default. */
  melee?: boolean;
}

/**
 * The effective-health multiplier of each part for a unit's stats at a level (SLICE.md B8): the
 * number the balance curves (rules/balance.json5) and the duel tool (B7) read. Sequential, as the
 * blow is rolled: dodge, then parry, then block, then armour - so the physical product is exact.
 */
export function defenceMultiplier(d: DefenceRules, get: StatReader, level: number, options: DefenceOptions = {}): DefenceReport {
  const v = defenceValues(d, get, options.attackerLevel ?? level);
  const health = Math.max(1, options.health ?? 100);
  const hit = Math.max(1e-6, options.hit ?? health * 0.07);
  const melee = options.melee ?? true;
  const dodge = v.dodge;
  const parry = melee ? Math.min(v.parry, 0.999 - dodge) : 0;
  const resist = options.school ? v.resist(options.school) : d.resist.schools.reduce((sum, s) => sum + v.resist(s), 0) / Math.max(1, d.resist.schools.length);
  const parts: Record<DefencePart, number> = {
    dodge: 1 / (1 - dodge),
    parry: (1 - dodge) / (1 - dodge - parry),
    block: 1 / (1 - v.block * Math.min(1, v.blockValue / hit)),
    armor: 1 / (1 - v.armor),
    resist: 1 / (1 - resist),
    absorb: 1 + v.ward / health,
    control: 1 / (1 - v.control * d.control.damageShare),
  };
  const shared = parts.absorb * parts.control;
  return { parts, physical: parts.dodge * parts.parry * parts.block * parts.armor * shared, spell: parts.resist * shared };
}

/** The physical parts `defenceFor` shares the budget out among (block is gear's: a shield). */
const PHYSICAL: DefencePart[] = ["dodge", "parry", "absorb", "control", "armor"];

/**
 * The stats that put a unit's defence on a target multiplier (a creature's role, the player's
 * mitigation curve): the target shared out among the physical parts that are on by their weights
 * (as powers: each part's multiplier is target^(weight / sum)); where a part's cap bites, the others
 * make up the rest (as far as their own caps let them). Spells meet target^spellBudget: resistance
 * gives what absorb and control do not.
 * `base` gives the stats the unit has already (agility, defence skill) that the chances add to.
 */
export function defenceFor(d: DefenceRules, level: number, target: number, options: { health?: number; base?: StatReader; attackerLevel?: number } = {}): Record<string, number> {
  const s = DEFENCE_STATS;
  const base = options.base ?? (() => 0);
  const health = Math.max(1, options.health ?? 100);
  const attacker = Math.max(1, options.attackerLevel ?? level);
  const out: Record<string, number> = {};
  const T = Math.max(1, target);
  const on = PHYSICAL.filter((p) => d.on[p] && d.weight[p] > 0);
  const W = on.reduce((sum, p) => sum + d.weight[p], 0);
  let dodge = 0;
  const give = (p: DefencePart, e: number): number => {
    e = Math.max(1, e);
    switch (p) {
      case "dodge": {
        const c = Math.min(d.cap.dodge, 1 - 1 / e);
        out[s.dodge] = Math.max(0, c - base(s.agility) * d.dodge.perAgility) * 100;
        dodge = Math.min(d.cap.dodge, Math.max(c, base(s.agility) * d.dodge.perAgility));
        return 1 / (1 - dodge);
      }
      case "parry": {
        const c = Math.min(d.cap.parry, (1 - dodge) * (1 - 1 / e));
        out[s.parry] = Math.max(0, c - base(s.defenceSkill) * d.parry.perDefence) * 100;
        const real = Math.min(d.cap.parry, Math.max(c, base(s.defenceSkill) * d.parry.perDefence));
        return (1 - dodge) / (1 - dodge - real);
      }
      case "absorb": {
        out[s.ward] = (e - 1) * health;
        return e;
      }
      case "control": {
        const c = Math.min(d.cap.control, (1 - 1 / e) / Math.max(1e-6, d.control.damageShare));
        out[s.controlAvoid] = c * 100;
        return 1 / (1 - c * d.control.damageShare);
      }
      case "armor": {
        const a = Math.min(d.cap.armor, 1 - 1 / e);
        const k = d.armor.base + d.armor.perLevel * attacker;
        out[s.armor] = a <= 0 ? 0 : (a * k) / (1 - a);
        return 1 / (1 - a);
      }
      default:
        return 1;
    }
  };
  // Each part target^(k * weight / sum), in roll order (dodge before parry); k = 1 unless a cap
  // bites, then raised until the parts that still have room make up the rest (or all are capped).
  const share = (k: number): number => {
    dodge = 0;
    let got = 1;
    for (const p of on) got *= give(p, T ** ((k * d.weight[p]) / W));
    return got;
  };
  if (on.length > 0 && share(1) < T * (1 - 1e-12)) {
    let lo = 1;
    let hi = 2;
    while (share(hi) < T && hi < 1e4) hi *= 2;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (share(mid) < T) lo = mid;
      else hi = mid;
    }
    share(hi);
  }
  // Spells: what absorb and control give, and resistance the rest of target^spellBudget.
  if (d.on.resist) {
    const shared = (d.on.absorb ? 1 + (out[s.ward] ?? 0) / health : 1) * (d.on.control ? 1 / (1 - ((out[s.controlAvoid] ?? 0) / 100) * d.control.damageShare) : 1);
    const r = Math.min(d.cap.resist, Math.max(0, 1 - shared / T ** d.spellBudget));
    const k = d.resist.base + d.resist.perLevel * attacker;
    for (const school of d.resist.schools) out[resistStat(school)] = r <= 0 ? 0 : (r * k) / (1 - r);
  }
  return out;
}
