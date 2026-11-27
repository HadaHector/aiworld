import { ContentError, Reader, isObject, type ContentIssue, type RawObject } from "../../world/content/contentReader";
import { defenceFor } from "./defenceRules";
import { orderPacks, parseFile, type PackSource } from "../../world/content/resolveContent";
import type { GameRules } from "./gameRules";
import { addModifier, explainStat, removeSource, setBase, statValue, type StatBlock } from "../stats";

/** The source of the one modifier the balance puts on a creature (health a role has less of than the level alone gives). */
const BALANCE_SOURCE = "balance";

// The balance rules (SLICE.md, 3a; `rules/balance.json5`): target curves by level, from which
// creature stats, money, prices and item budgets are derived. A creature, item or quest still
// carries its own offsets; the baseline is where it starts, not a cage.

/** A target by level. See `readCurve` for the four ways to write one. */
export interface Curve {
  /** The value at a level (fractions allowed); levels under 1 read as 1. */
  at(level: number): number;
}

/** What an enemy role is, by ratios of the curves: how long it takes to kill, how long it takes to die to it. */
export interface RoleDef {
  id: string;
  /** Seconds a same-level player (on the dps curve) takes to kill one. */
  ttk: number;
  /** Seconds an undamaged same-level player (on the health curve) takes to die to one. 0: it does no damage. */
  ttd: number;
  /** Share of weapon damage its armour stops (0-0.9), against a same-level attacker. */
  mitigation: number;
  /** Factors on money and XP per kill. */
  money: number;
  xp: number;
  /** Share of its damage that its tactics deal (the rest is its auto-attack). */
  tacticShare: number;
}

/** What a creature kind says of itself: a role, and offsets over the baseline. */
export interface CreatureBalance {
  role: string;
  /** Factors on the baseline: health, damage, armour (as a share stopped), money, XP. All 1 by default. */
  scale: { health: number; damage: number; armour: number; money: number; xp: number };
}

/** What the curves say a creature of a role and level has. */
export interface CreatureBaseline {
  health: number;
  /** Raw damage a second (before the target's armour), auto-attack and tactics together. */
  dps: number;
  /** The `armor` stat that stops `mitigation` of a same-level attacker's damage. */
  armor: number;
  mitigation: number;
  /** Per kill, in the main currency. */
  money: number;
  xp: number;
}

export interface BalanceRules {
  /** A curve by name (playerHealth, playerDps...): throws on an unknown name. */
  curve(name: string, level: number): number;
  curveNames: readonly string[];
  roles: ReadonlyMap<string, RoleDef>;
  /** The player's dps curve for a combat role: melee, ranged, caster, hybrid. A factor on `playerDps`. */
  dpsRoles: ReadonlyMap<string, number>;
  /** Item slot weights: a slot's share of a level's item budget, and of its price (a weapon is 1). */
  slotWeights: ReadonlyMap<string, number>;
  /** Kills in an hour of play: money and XP per kill follow from it. */
  killsPerHour: number;
  /** Shares of income from kills, quests and chests. */
  incomeSplit: { kills: number; quests: number; chests: number };
  /** Minutes of income: a health potion, a weapon of the level band. */
  priceMinutes: { potion: number; weapon: number };
  /** A vendor pays this share of the price. */
  sellRate: number;
  /** Repairing a fully worn item costs this share of its price (the item rules' repair formula may read it). */
  repairShare: number;
  /** Out of combat regeneration: seconds after combat before it starts, share of maximum health a second. */
  regen: { delay: number; share: number };
  /** Levels over the two hours: the minute each is reached by. */
  pace: ReadonlyMap<number, number>;
  /** The share of XP kills give; quests the rest. */
  xpSplit: { kills: number; quests: number };
  /** Zone creature roles' reference attacker armour formula: armour / (armour + base + perLevel * level). */
  armourFormula: { base: number; perLevel: number };

  /** The role's baseline at a level. Throws on an unknown role. */
  baseline(role: string, level: number): CreatureBaseline;
  /** A kind's baseline at a level: its role's, with its own scale (what `applyCreature` puts on its stats, before traits). */
  creatureBaseline(balance: CreatureBalance, level: number): CreatureBaseline;
  /** Money for a kill of a role at a level (average), before a loot table's own spread. */
  moneyPerKill(role: string, level: number): number;
  /** Income, in the main currency, per hour at a level. */
  income(level: number): number;
  /** An item's stat budget: how many points of stats it may carry. `rarityBudget` is the rarity's multiplier. */
  itemBudget(level: number, slot: string, rarityBudget: number): number;
  /** An item's price, in the main currency. */
  itemPrice(level: number, slot: string, rarityBudget: number): number;
  /** A consumable's price (a potion of the level). */
  potionPrice(level: number): number;
  /** The `armor` stat of a worn set that stops `share` of a same-level attacker's damage. */
  armourFor(level: number, share: number): number;
  /** A creature's level-L stats applied to its stat block (health, weapon, armour, XP value). */
  applyCreature(block: StatBlock, game: GameRules, balance: CreatureBalance, level: number): void;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOP_KEYS = [
  "curves", "roles", "dpsRoles", "slotWeights", "killsPerHour", "incomeSplit", "priceMinutes", "sellRate", "repairShare", "regen", "pace", "xpSplit",
  "armourFormula",
];

/** One curve: `{ value }`, `{ table: [...], growth? }`, `{ from, to, at?, shape? }` or `{ poly: [a, b, c] }`,
 *  with optional `min` and `max`. Beyond a table, its last value grows by `growth` a level (by default
 *  as the last step did); `from`/`to` mean the values at level 1 and `at` (10), geometric or linear,
 *  carried on past it; `poly` is `a*L^2 + b*L + c`. */
function readCurve(raw: unknown, reader: Reader, path: string): Curve {
  const obj = reader.object(raw, path);
  reader.onlyKeys(obj, path, ["value", "table", "growth", "from", "to", "at", "shape", "poly", "min", "max"]);
  const min = reader.optionalNumber(obj, "min", path, -Infinity);
  const max = reader.optionalNumber(obj, "max", path, Infinity);
  const clamp = (v: number): number => Math.min(max, Math.max(min, v));
  const forms = ["value", "table", "from", "poly"].filter((k) => obj[k] !== undefined);
  if (forms.length !== 1) {
    reader.fail(path, `a curve is exactly one of value, table, from/to or poly (got ${forms.join(", ") || "none"})`);
    return { at: () => 0 };
  }
  if (obj.value !== undefined) {
    const v = reader.number(obj, "value", path);
    return { at: () => clamp(v) };
  }
  if (obj.poly !== undefined) {
    const p = reader.array(obj, "poly", path);
    if (p.length !== 3 || p.some((n) => typeof n !== "number")) reader.fail(`${path}.poly`, "expected three numbers [a, b, c]");
    const [a, b, c] = p.map((n) => (typeof n === "number" ? n : 0));
    return { at: (level) => clamp(a * level * level + b * level + c) };
  }
  if (obj.table !== undefined) {
    const t = reader.array(obj, "table", path);
    if (t.length === 0 || t.some((n) => typeof n !== "number")) reader.fail(`${path}.table`, "expected a list of numbers, one a level from 1");
    const table = t.map((n) => (typeof n === "number" ? n : 0));
    if (table.length === 0) table.push(0);
    const last = table.length - 1;
    const growth = reader.optionalNumber(obj, "growth", path, last > 0 && table[last - 1] !== 0 ? table[last] / table[last - 1] : 1, { min: 0 });
    return {
      at: (level) => {
        const x = Math.max(1, level) - 1;
        if (x >= last) return clamp(table[last] * growth ** (x - last));
        const i = Math.floor(x);
        return clamp(table[i] + (table[i + 1] - table[i]) * (x - i));
      },
    };
  }
  const from = reader.number(obj, "from", path);
  const to = reader.number(obj, "to", path);
  const at = reader.optionalNumber(obj, "at", path, 10, { min: 2 });
  const shape = obj.shape === undefined ? "geometric" : reader.oneOf(obj, "shape", path, ["geometric", "linear"] as const);
  if (shape === "geometric" && (from <= 0 || to <= 0)) reader.fail(path, "a geometric curve needs positive ends");
  const step = shape === "linear" ? (to - from) / (at - 1) : Math.log(to / from || 1) / (at - 1);
  return { at: (level) => clamp(shape === "linear" ? from + step * (Math.max(1, level) - 1) : from * Math.exp(step * (Math.max(1, level) - 1))) };
}

const cache = new WeakMap<PackSource[], BalanceRules>();

/** Reads `rules/balance.json5` of the packs (the last pack's wins) into BalanceRules. A pack set
 *  without one gets none: `null`. Throws a ContentError listing every problem. */
export function readBalanceRules(packs: PackSource[]): BalanceRules | null {
  const hit = cache.get(packs);
  if (hit) return hit;
  const issues: ContentIssue[] = [];
  let file = "rules/balance.json5";
  let data: unknown;
  for (const pack of orderPacks(packs, issues)) {
    for (const entry of pack.files) {
      if (entry.path !== "rules/balance.json5") continue;
      file = `${pack.id}/${entry.path}`;
      data = parseFile(file, entry.text, issues);
    }
  }
  if (issues.length > 0) throw new ContentError(issues);
  if (data === undefined) return null;
  const rules = makeBalance(data, file, issues);
  if (issues.length > 0) throw new ContentError(issues);
  cache.set(packs, rules);
  return rules;
}

function makeBalance(data: unknown, file: string, issues: ContentIssue[]): BalanceRules {
  const reader = new Reader(issues, file);
  const obj = reader.object(data, "");
  reader.onlyKeys(obj, "", TOP_KEYS);

  const curves = new Map<string, Curve>();
  const curveRaw = reader.object(obj.curves ?? {}, "curves");
  for (const id of Object.keys(curveRaw)) curves.set(id, readCurve(curveRaw[id], reader, `curves.${id}`));
  const curve = (name: string, level: number): number => {
    const c = curves.get(name);
    if (!c) throw new Error(`no balance curve "${name}" (known: ${[...curves.keys()].join(", ")})`);
    return c.at(level);
  };
  for (const needed of ["playerHealth", "playerDps", "playerMitigation", "income", "itemBudget"]) {
    if (!curves.has(needed)) reader.fail(`curves.${needed}`, "the balance rules need this curve");
  }

  const roles = new Map<string, RoleDef>();
  const rolesRaw = reader.object(obj.roles ?? {}, "roles");
  for (const id of Object.keys(rolesRaw)) {
    const path = `roles.${id}`;
    if (!ID_PATTERN.test(id)) reader.fail(path, "role ids may only use letters, digits, - and _");
    const r = reader.object(rolesRaw[id], path);
    reader.onlyKeys(r, path, ["ttk", "ttd", "mitigation", "money", "xp", "tacticShare"]);
    roles.set(id, {
      id,
      ttk: reader.number(r, "ttk", path, { min: 0.1 }),
      ttd: reader.optionalNumber(r, "ttd", path, 0, { min: 0 }),
      mitigation: reader.optionalNumber(r, "mitigation", path, 0, { min: 0, max: 0.9 }),
      money: reader.optionalNumber(r, "money", path, 1, { min: 0 }),
      xp: reader.optionalNumber(r, "xp", path, 1, { min: 0 }),
      tacticShare: reader.optionalNumber(r, "tacticShare", path, 0.2, { min: 0, max: 0.9 }),
    });
  }
  if (!roles.has("normal")) reader.fail("roles.normal", "the balance rules need a `normal` role: the reference every other is read against");

  const numberMap = (key: string, fallback: Record<string, number>): Map<string, number> => {
    const raw = obj[key] === undefined ? fallback : reader.object(obj[key], key);
    const out = new Map<string, number>();
    for (const id of Object.keys(raw)) out.set(id, reader.number(raw, id, key, { min: 0 }));
    return out;
  };
  const dpsRoles = numberMap("dpsRoles", { melee: 1, ranged: 1, caster: 1, hybrid: 1 });
  const slotWeights = numberMap("slotWeights", {});

  const section = (key: string, keys: string[]): RawObject => {
    const raw = obj[key] === undefined ? {} : reader.object(obj[key], key);
    reader.onlyKeys(raw, key, keys);
    return raw;
  };
  const split = section("incomeSplit", ["kills", "quests", "chests"]);
  const incomeSplit = {
    kills: reader.optionalNumber(split, "kills", "incomeSplit", 0.4, { min: 0 }),
    quests: reader.optionalNumber(split, "quests", "incomeSplit", 0.35, { min: 0 }),
    chests: reader.optionalNumber(split, "chests", "incomeSplit", 0.25, { min: 0 }),
  };
  const minutes = section("priceMinutes", ["potion", "weapon"]);
  const priceMinutes = {
    potion: reader.optionalNumber(minutes, "potion", "priceMinutes", 3, { min: 0 }),
    weapon: reader.optionalNumber(minutes, "weapon", "priceMinutes", 25, { min: 0 }),
  };
  const regenRaw = section("regen", ["delay", "share"]);
  const regen = {
    delay: reader.optionalNumber(regenRaw, "delay", "regen", 6, { min: 0 }),
    share: reader.optionalNumber(regenRaw, "share", "regen", 0.02, { min: 0 }),
  };
  const xpRaw = section("xpSplit", ["kills", "quests"]);
  const xpSplit = { kills: reader.optionalNumber(xpRaw, "kills", "xpSplit", 0.55, { min: 0 }), quests: reader.optionalNumber(xpRaw, "quests", "xpSplit", 0.45, { min: 0 }) };
  const armourRaw = section("armourFormula", ["base", "perLevel"]);
  const armourFormula = { base: reader.optionalNumber(armourRaw, "base", "armourFormula", 400, { min: 0 }), perLevel: reader.optionalNumber(armourRaw, "perLevel", "armourFormula", 85, { min: 0 }) };
  const pace = new Map<number, number>();
  const paceRaw = obj.pace === undefined ? {} : reader.object(obj.pace, "pace");
  for (const level of Object.keys(paceRaw)) pace.set(Number(level), reader.number(paceRaw, level, "pace", { min: 0 }));
  const sellRate = reader.optionalNumber(obj, "sellRate", "", 0.25, { min: 0, max: 1 });
  const repairShare = reader.optionalNumber(obj, "repairShare", "", 0.05, { min: 0 });
  const killsPerHour = reader.optionalNumber(obj, "killsPerHour", "", 100, { min: 1 });

  const role = (id: string): RoleDef => {
    const r = roles.get(id);
    if (!r) throw new Error(`no balance role "${id}" (known: ${[...roles.keys()].join(", ")})`);
    return r;
  };
  const armourFor = (level: number, share: number): number => (share <= 0 ? 0 : (share * (armourFormula.base + armourFormula.perLevel * level)) / (1 - share));
  const income = (level: number): number => curve("income", level);
  const moneyPerKill = (id: string, level: number): number => (income(level) * incomeSplit.kills * role(id).money) / killsPerHour;
  const slotWeight = (slot: string): number => slotWeights.get(slot) ?? 1;

  const baseline = (id: string, level: number, scale?: CreatureBalance["scale"]): CreatureBaseline => {
    const r = role(id);
    const s = scale ?? { health: 1, damage: 1, armour: 1, money: 1, xp: 1 };
    const mitigation = Math.min(0.9, r.mitigation * s.armour);
    // Health: what the player's dps does in `ttk` seconds against that armour.
    const health = r.ttk * curve("playerDps", level) * (1 - mitigation) * s.health;
    // Damage: what takes the player's health in `ttd` seconds through the player's armour.
    const dps = r.ttd > 0 ? ((curve("playerHealth", level) / r.ttd) / Math.max(0.05, 1 - curve("playerMitigation", level))) * s.damage : 0;
    return { health, dps, armor: armourFor(level, mitigation), mitigation, money: moneyPerKill(id, level) * s.money, xp: r.xp * s.xp };
  };

  return {
    curve,
    curveNames: [...curves.keys()],
    roles,
    dpsRoles,
    slotWeights,
    killsPerHour,
    incomeSplit,
    priceMinutes,
    sellRate,
    repairShare,
    regen,
    pace,
    xpSplit,
    armourFormula,
    baseline: (id, level) => baseline(id, level),
    creatureBaseline: (b, level) => baseline(b.role, level, b.scale),
    moneyPerKill,
    income,
    itemBudget: (level, slot, rarityBudget) => curve("itemBudget", level) * slotWeight(slot) * rarityBudget,
    itemPrice: (level, slot, rarityBudget) => Math.max(1, Math.round(((income(level) / 60) * priceMinutes.weapon * slotWeight(slot) * rarityBudget))),
    potionPrice: (level) => Math.max(1, Math.round((income(level) / 60) * priceMinutes.potion)),
    armourFor,
    applyCreature(block, game, balance, level) {
      const b = baseline(balance.role, level, balance.scale);
      const stat = (id: string): number | undefined => game.statIndex.get(id);
      const stamina = stat("stamina");
      const maxHealth = stat("maxHealth");
      // Health: stamina is what max health is made of - solve for the stamina that gives the baseline,
      // by the rules' own formula (two evaluations of its base, before any modifier: a trait's
      // percent stays on top; the default formula is linear in stamina).
      if (stamina !== undefined && maxHealth !== undefined) {
        setBase(block, stamina, 0);
        const base = explainStat(block, maxHealth).base;
        setBase(block, stamina, 1);
        const slope = explainStat(block, maxHealth).base - base;
        const raw = slope > 0 ? (b.health - base) / slope : 0;
        setBase(block, stamina, Math.max(0, raw));
        // A swarm's small health, at a level where the level term alone is more: the rest comes off flat.
        const flat = game.kindIndex.get("flat");
        removeSource(block, BALANCE_SOURCE);
        if (raw < 0 && flat !== undefined) addModifier(block, { stat: maxHealth, kind: flat, value: b.health - base, source: BALANCE_SOURCE });
      }
      // Defence (rules/combat.json5, *defence*): the role's mitigation as an effective-health target,
      // shared out among the parts that are on - armour alone in a pack without the model, as before.
      const own = (id: string): number => {
        const i = stat(id);
        return i === undefined ? 0 : statValue(block, i);
      };
      const defence = defenceFor(game.combat.defence, level, 1 / (1 - b.mitigation), { health: b.health, base: own });
      for (const [id, value] of Object.entries(defence)) {
        const i = stat(id);
        if (i !== undefined && !game.stats[i].formula) setBase(block, i, value);
      }
      const xpValue = stat("xpValue");
      if (xpValue !== undefined) setBase(block, xpValue, b.xp);
      // Weapon: auto-attack damage a swing is the kind's `dps` less its tactics' share, times the
      // swing's length, less what strength adds; spread 80%-120% around the mean.
      const min = stat("weaponMin");
      const maxW = stat("weaponMax");
      const speed = stat("weaponSpeed");
      if (min !== undefined && maxW !== undefined && speed !== undefined) {
        const swing = statValue(block, speed);
        const strength = stat("strength");
        const add = strength !== undefined ? statValue(block, strength) / 7 : 0;
        const perSwing = b.dps * (1 - role(balance.role).tacticShare) * swing;
        const mean = Math.max(0, perSwing - add);
        setBase(block, min, mean * 0.8);
        setBase(block, maxW, mean * 1.2);
      }
    },
  };
}

/** What a kind's `role` and `scale` say, read and checked. Null for a kind without a role. */
export function readCreatureBalance(species: RawObject, variant: RawObject | null, reader: Reader, vpath: string, balance: BalanceRules | null): CreatureBalance | null {
  const roleId = variant?.role !== undefined ? reader.string(variant, "role", vpath) : species.role !== undefined ? reader.string(species, "role", "") : undefined;
  if (roleId === undefined) return null;
  if (!balance) {
    reader.fail("role", "a creature with a role needs the packs' rules/balance.json5");
    return null;
  }
  if (!balance.roles.has(roleId)) reader.fail("role", `no balance role "${roleId}" (known: ${[...balance.roles.keys()].join(", ")})`);
  const scale = { health: 1, damage: 1, armour: 1, money: 1, xp: 1 };
  for (const [part, path] of [[species, ""], ...(variant ? [[variant, vpath] as const] : [])] as const) {
    if (part.scale === undefined) continue;
    const raw = reader.object(part.scale, `${path ? `${path}.` : ""}scale`);
    reader.onlyKeys(raw, "scale", Object.keys(scale));
    for (const key of Object.keys(scale) as (keyof typeof scale)[]) scale[key] *= reader.optionalNumber(raw, key, "scale", 1, { min: 0 });
  }
  return { role: roleId, scale };
}

export { isObject };
