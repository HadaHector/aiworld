import { ContentError, isObject, joinPath, Reader, describe, type ContentIssue, type RawObject } from "../../world/content/contentReader";
import { actionKind, actionKinds, type Action, type CheckContext } from "../skills/actions";
import { FLAG_INDEX, FLAG_NAMES } from "../skills/flags";
import { compileFormula, type CompiledFormula } from "./formula";
import type { StatDef } from "./gameRules";

/**
 * Skills (`skills/<id>.json5`) and the combat rules (`rules/combat.json5`), read into the game rules
 * (see ABILITIES.md). Every expression is compiled against its skill's scope, every action checked
 * by its kind in the registry, and every name a skill uses - states, groups, areas, vars, other
 * skills, stats, resources, flags - resolved to an index here, so nothing is looked up by name while
 * the game runs.
 */

// --- the scope every skill expression reads (ABILITIES.md, *Attributes in expressions*) ---

/** Names every skill expression may read besides attributes and vars, in their slots. */
export const LOCALS = ["level", "stacks", "random", "distance", "amount"] as const;
export const LOCAL = { level: 0, stacks: 1, random: 2, distance: 3, amount: 4 } as const;

/** Where each part of a scope starts in the array an expression reads: the locals, the caster's,
 *  the target's and the host's attributes, then the skill's vars. */
export interface ScopeLayout {
  caster: number;
  target: number;
  host: number;
  vars: number;
  size: number;
}

export function scopeLayout(statCount: number, varCount: number): ScopeLayout {
  const caster = LOCALS.length;
  return { caster, target: caster + statCount, host: caster + 2 * statCount, vars: caster + 3 * statCount, size: caster + 3 * statCount + varCount };
}

function scopeNames(stats: readonly StatDef[], vars: readonly string[]): Map<string, number> {
  const layout = scopeLayout(stats.length, vars.length);
  const names = new Map<string, number>(LOCALS.map((name, i) => [name, i]));
  for (const stat of stats) {
    names.set(`caster.${stat.id}`, layout.caster + stat.index);
    names.set(`target.${stat.id}`, layout.target + stat.index);
    names.set(`host.${stat.id}`, layout.host + stat.index);
  }
  vars.forEach((name, i) => names.set(`var.${name}`, layout.vars + i));
  return names;
}

// --- combat rules ---

export interface RollSet {
  id: string;
  /** Chances from 0 to 1. */
  hit: CompiledFormula;
  crit: CompiledFormula;
  critMultiplier: CompiledFormula;
  /** The amount after armour or resistance, from `amount`. */
  mitigate: CompiledFormula;
}

export interface CombatRules {
  gcd: number;
  queueWindow: number;
  rangeLeeway: number;
  /** How high above the feet line of sight is taken from and to. */
  losHeight: number;
  rolls: RollSet[];
  rollIndex: ReadonlyMap<string, number>;
  threat: { damage: number; heal: number; forgetAfter: number };
  combatTimeout: number;
  /** The scope roll expressions read: attributes and locals, no vars. */
  scope: ScopeLayout;
}

// --- skills ---

export type SkillType = "spell" | "physical" | "none";
export type TargetKind = "enemy" | "ally" | "self" | "point" | "none";
export type Relation = "enemy" | "ally" | "any";

/** A skill, or a tag that skills carry: what `requires`, `blockedBy`, filters and triggers match. */
export interface SkillMatch {
  skill: number;
  tag: string;
}

export interface AreaDef {
  id: string;
  shape: "circle" | "cone" | "rect" | "ring";
  radius: CompiledFormula;
  inner: CompiledFormula;
  angle: CompiledFormula;
  length: CompiledFormula;
  width: CompiledFormula;
  at: "caster" | "host" | "target" | "point";
}

export interface FilterDef {
  relation: Relation;
  /** Only the living (true), only the dead (false), or either (null). */
  alive: boolean | null;
  /** Magics the unit must have hosted on it, or must not. */
  has: SkillMatch[];
  hasNot: SkillMatch[];
  flags: number[];
  notFlags: number[];
  /** Whether the caster itself may be in the group. */
  self: boolean;
  los: boolean;
  range: CompiledFormula | null;
  facing: boolean;
}

export type GroupSource =
  | { kind: "target" | "caster" | "host" | "threat" | "owner" | "summons" | "attacking" }
  | { kind: "area"; area: number }
  | { kind: "group"; group: number };

export interface GroupDef {
  id: string;
  from: GroupSource;
  filter: FilterDef;
  sort: "none" | "nearest" | "farthest" | "lowestHealth" | "random";
  max: CompiledFormula | null;
  chain: { jumps: CompiledFormula; radius: CompiledFormula; filter: FilterDef } | null;
}

/** The groups every skill has without defining them, by index. */
export const GROUP = { host: 0, caster: 1, target: 2 } as const;

export const MAGIC_EVENTS = ["moved", "interrupted", "targetLost", "hostDied", "absorbedOut", "stacksGone"] as const;
export const COMBAT_TRIGGERS = ["hitDealt", "hitTaken", "critDealt", "healDealt", "healTaken", "castDone", "killed", "died"] as const;
export const STATE_EVENTS: readonly string[] = [...MAGIC_EVENTS, ...COMBAT_TRIGGERS];

export interface Transition {
  event: string;
  /** A state index, or -1 to end. */
  to: number;
  /** For combat triggers: the other side's skill must match one of these (any skill when empty). */
  filter: SkillMatch[];
}

export type StateLength = { kind: "fixed"; length: CompiledFormula } | { kind: "travel"; speed: CompiledFormula } | { kind: "forever" };

export interface StateDef {
  id: string;
  index: number;
  length: StateLength;
  period: CompiledFormula | null;
  enter: Action[];
  tick: Action[];
  exit: Action[];
  hold: Action[];
  /** Where it goes when its length runs out: a state index, or -1 to end. */
  next: number;
  on: Transition[];
  bar: "" | "cast" | "channel";
  breakOnMove: boolean;
  interruptible: boolean;
  commit: boolean;
  /** Groups filled again before each tick. */
  refill: number[];
}

export interface StackingDef {
  group: string;
  per: "host" | "caster";
  max: CompiledFormula;
  add: "stack" | "replace" | "keep" | "separate";
  duration: "restart" | "extend" | "keep" | "longer";
  extendCap: CompiledFormula | null;
  value: "newest" | "stronger" | "keep";
  strength: CompiledFormula | null;
}

export interface SkillDef {
  id: string;
  index: number;
  name: string;
  tags: string[];
  type: SkillType;
  weapon: boolean;
  /** Whether casting it at an enemy turns auto-attack on against it (and turns the caster to face
   *  it). Default: physical skills cast at an enemy - Charge, Heroic Strike - but not spells. */
  startsAttack: boolean;
  passive: boolean;
  target: TargetKind;
  /** Where its magic lives: on its caster (a cast, a passive) or on its target (a buff cast on an ally). */
  hostOn: "caster" | "target";
  range: CompiledFormula | null;
  minRange: CompiledFormula | null;
  los: boolean;
  facing: boolean;
  cost: { resource: number; amount: CompiledFormula }[];
  cooldown: CompiledFormula;
  category: string;
  /** `global`: the rules' GCD; `own`: `gcdLength`; `none`. */
  gcd: "global" | "own" | "none";
  gcdLength: CompiledFormula | null;
  requires: SkillMatch[];
  blockedBy: SkillMatch[];
  targetRequires: SkillMatch[];
  targetBlockedBy: SkillMatch[];
  display: "buff" | "debuff" | "hidden";
  dispel: string;
  keepOnDeath: boolean;
  stacking: StackingDef;
  areas: AreaDef[];
  groups: GroupDef[];
  vars: string[];
  /** Each var's value when a magic starts, unless a `cast` action sets it. */
  varDefaults: CompiledFormula[];
  states: StateDef[];
  start: number;
  scope: ScopeLayout;
  /** Phase → cue id (FEEDBACK.md): for the client alone, which checks them against its cues. */
  cues: Readonly<Record<string, string>>;
}

export interface SkillRules {
  skills: SkillDef[];
  skillIndex: ReadonlyMap<string, number>;
  combat: CombatRules;
}

/** What the skill reader needs from the rest of the game rules. */
export interface SkillContext {
  stats: readonly StatDef[];
  statIndex: ReadonlyMap<string, number>;
  kindIndex: ReadonlyMap<string, number>;
  resourceIndex: ReadonlyMap<string, number>;
}

interface Entry {
  id: string;
  file: string;
  data: unknown;
}

const SKILL_KEYS = [
  "name", "tags", "type", "weapon", "startsAttack", "passive", "target", "hostOn", "range", "minRange", "los", "facing", "cost", "cooldown", "category", "gcd",
  "requires", "blockedBy", "targetRequires", "targetBlockedBy", "display", "dispel", "keepOnDeath", "stacking", "areas", "groups", "vars", "start", "states",
  "cues",
];
const STATE_KEYS = ["length", "period", "enter", "tick", "exit", "hold", "next", "on", "bar", "breakOnMove", "interruptible", "commit", "refill"];
const FILTER_KEYS = ["relation", "alive", "has", "hasNot", "flags", "notFlags", "self", "los", "range", "facing"];

const known = (names: Iterable<string>): string => [...names].join(", ") || "none";

/** Reads `rules/combat.json5` (every field has a default, so a pack may leave it out). */
export function readCombatRules(entry: Entry | undefined, stats: readonly StatDef[], issues: ContentIssue[]): CombatRules {
  const scope = scopeLayout(stats.length, 0);
  const names = scopeNames(stats, []);
  const reader = new Reader(issues, entry?.file ?? "rules/combat.json5");
  const obj = entry ? reader.object(entry.data, "") : {};
  reader.onlyKeys(obj, "", ["gcd", "queueWindow", "rangeLeeway", "losHeight", "rolls", "threat", "combatTimeout"]);
  const rolls: RollSet[] = [];
  const rawRolls = obj.rolls === undefined ? {} : reader.object(obj.rolls, "rolls");
  for (const [id, value] of Object.entries(rawRolls)) {
    const path = joinPath("rolls", id);
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["hit", "crit", "critMultiplier", "mitigate"]);
    const expr = (key: string, fallback: unknown): CompiledFormula => compileFormula(raw[key] ?? fallback, joinPath(path, key), reader, names);
    rolls.push({ id, hit: expr("hit", 1), crit: expr("crit", 0), critMultiplier: expr("critMultiplier", 1.5), mitigate: expr("mitigate", "amount") });
  }
  const threat = obj.threat === undefined ? {} : reader.object(obj.threat, "threat");
  reader.onlyKeys(threat, "threat", ["damage", "heal", "forgetAfter"]);
  return {
    gcd: reader.optionalNumber(obj, "gcd", "", 1.5, { min: 0 }),
    queueWindow: reader.optionalNumber(obj, "queueWindow", "", 0.4, { min: 0 }),
    rangeLeeway: reader.optionalNumber(obj, "rangeLeeway", "", 1, { min: 0 }),
    losHeight: reader.optionalNumber(obj, "losHeight", "", 1.6, { min: 0 }),
    rolls,
    rollIndex: new Map(rolls.map((r, i) => [r.id, i])),
    threat: {
      damage: reader.optionalNumber(threat, "damage", "threat", 1),
      heal: reader.optionalNumber(threat, "heal", "threat", 0.5),
      forgetAfter: reader.optionalNumber(threat, "forgetAfter", "threat", 6, { min: 0 }),
    },
    combatTimeout: reader.optionalNumber(obj, "combatTimeout", "", 5, { min: 0 }),
    scope,
  };
}

/**
 * Reads every skill. Two passes: the first learns every skill's id, vars and states, so a skill can
 * name another's vars (a `cast` action's `vars`) whatever order they are in; the second reads each
 * fully. `templates` are checked by the caller once templates are read: `templateRefs` lists them.
 */
export function readSkills(entries: Entry[], context: SkillContext, combat: CombatRules, issues: ContentIssue[]): SkillRules & { templateRefs: { file: string; path: string; id: string }[] } {
  const skillIndex = new Map(entries.map((e, i) => [e.id, i]));
  const varsOf = entries.map((entry) => {
    const data = isObject(entry.data) ? entry.data : {};
    return isObject(data.vars) ? Object.keys(data.vars) : [];
  });
  const templateRefs: { file: string; path: string; id: string }[] = [];
  const skills = entries.map((entry, index) => readSkill(entry, index, varsOf[index], { context, combat, skillIndex, varsOf, templateRefs }, issues));
  return { skills, skillIndex, combat, templateRefs };
}

interface ReadContext {
  context: SkillContext;
  combat: CombatRules;
  skillIndex: ReadonlyMap<string, number>;
  varsOf: string[][];
  templateRefs: { file: string; path: string; id: string }[];
}

function readSkill(entry: Entry, index: number, vars: string[], read: ReadContext, issues: ContentIssue[]): SkillDef {
  const { context, combat, skillIndex, varsOf } = read;
  const reader = new Reader(issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", SKILL_KEYS);
  const scope = scopeLayout(context.stats.length, vars.length);
  const names = scopeNames(context.stats, vars);
  const expr = (value: unknown, path: string): CompiledFormula => {
    if (value === undefined) {
      reader.fail(path, "required expression is missing");
      return compileFormula(0, path, reader, names);
    }
    return compileFormula(value, path, reader, names);
  };
  const optionalExpr = (o: RawObject, key: string, path: string, fallback: number): CompiledFormula =>
    compileFormula(o[key] ?? fallback, joinPath(path, key), reader, names);

  // Names first, so anything may refer to anything in the file.
  const rawStates = obj.states === undefined ? {} : reader.object(obj.states, "states");
  const stateIndex = new Map(Object.keys(rawStates).map((id, i) => [id, i]));
  if (stateIndex.size === 0) reader.fail("states", "a skill needs at least one state");
  const rawAreas = obj.areas === undefined ? {} : reader.object(obj.areas, "areas");
  const areaIndex = new Map(Object.keys(rawAreas).map((id, i) => [id, i]));
  const rawGroups = obj.groups === undefined ? {} : reader.object(obj.groups, "groups");
  const groupIndex = new Map<string, number>([["host", GROUP.host], ["caster", GROUP.caster], ["target", GROUP.target]]);
  for (const id of Object.keys(rawGroups)) {
    if (groupIndex.has(id)) reader.fail(joinPath("groups", id), `"${id}" exists without being defined`);
    else groupIndex.set(id, groupIndex.size);
  }
  const varIndex = new Map(vars.map((name, i) => [name, i]));

  const lookup = (map: ReadonlyMap<string, number>, what: string) => (id: unknown, path: string): number => {
    const found = typeof id === "string" ? map.get(id) : undefined;
    if (found === undefined) {
      reader.fail(path, `no ${what} ${describe(id)} (known: ${known(map.keys())})`);
      return 0;
    }
    return found;
  };
  const stateRef = (id: unknown, path: string): number => (id === "end" ? -1 : lookup(stateIndex, "state")(id, path));

  const ctx: CheckContext = {
    reader,
    expr,
    optionalExpr,
    actions: (value, path) => readActions(value, path, ctx, false),
    skill: lookup(skillIndex, "skill"),
    skillVar: (skill, name, path) => {
      const at = varsOf[skill]?.indexOf(name) ?? -1;
      if (at < 0) reader.fail(path, `the skill has no var "${name}" (known: ${known(varsOf[skill] ?? [])})`);
      return Math.max(at, 0);
    },
    state: stateRef,
    ownVar: lookup(varIndex, "var"),
    stat: lookup(context.statIndex, "stat"),
    modifierKind: lookup(context.kindIndex, "modifier kind"),
    resource: lookup(context.resourceIndex, "resource"),
    flag: lookup(FLAG_INDEX, "flag"),
    area: lookup(areaIndex, "area"),
    group: lookup(groupIndex, "group"),
    roll: (id, path) => (id === "none" ? -1 : lookup(combat.rollIndex, "roll set")(id, path)),
    template: (id, path) => {
      if (typeof id !== "string" || !id) reader.fail(path, `expected a template id, got ${describe(id)}`);
      else read.templateRefs.push({ file: entry.file, path, id });
      return typeof id === "string" ? id : "";
    },
  };

  const matches = (key: string): SkillMatch[] => readMatches(obj, key, "", reader, skillIndex);

  // --- areas ---
  const areas: AreaDef[] = Object.entries(rawAreas).map(([id, value]) => {
    const path = joinPath("areas", id);
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["shape", "radius", "inner", "angle", "length", "width", "at"]);
    return {
      id,
      shape: reader.oneOf(raw, "shape", path, ["circle", "cone", "rect", "ring"] as const),
      radius: optionalExpr(raw, "radius", path, 5),
      inner: optionalExpr(raw, "inner", path, 0),
      angle: optionalExpr(raw, "angle", path, 90),
      length: optionalExpr(raw, "length", path, 10),
      width: optionalExpr(raw, "width", path, 4),
      at: raw.at === undefined ? "caster" : reader.oneOf(raw, "at", path, ["caster", "host", "target", "point"] as const),
    };
  });

  // --- groups ---
  const readFilter = (value: unknown, path: string): FilterDef => {
    const raw = value === undefined ? {} : reader.object(value, path);
    reader.onlyKeys(raw, path, FILTER_KEYS);
    const flagList = (key: string): number[] => (raw[key] === undefined ? [] : reader.stringList(raw, key, path).map((f, i) => ctx.flag(f, `${path}.${key}[${i}]`)));
    return {
      relation: raw.relation === undefined ? "any" : reader.oneOf(raw, "relation", path, ["enemy", "ally", "any"] as const),
      alive: raw.alive === undefined ? true : typeof raw.alive === "boolean" ? raw.alive : (reader.fail(joinPath(path, "alive"), "expected true or false"), true),
      has: readMatches(raw, "has", path, reader, skillIndex),
      hasNot: readMatches(raw, "hasNot", path, reader, skillIndex),
      flags: flagList("flags"),
      notFlags: flagList("notFlags"),
      self: reader.boolean(raw, "self", path, true),
      los: reader.boolean(raw, "los", path, false),
      range: raw.range === undefined ? null : expr(raw.range, joinPath(path, "range")),
      facing: reader.boolean(raw, "facing", path, false),
    };
  };
  const groups: GroupDef[] = [
    { id: "host", from: { kind: "host" }, filter: readFilter({ alive: true }, "(host)"), sort: "none", max: null, chain: null },
    { id: "caster", from: { kind: "caster" }, filter: readFilter({}, "(caster)"), sort: "none", max: null, chain: null },
    { id: "target", from: { kind: "target" }, filter: readFilter({}, "(target)"), sort: "none", max: null, chain: null },
  ];
  // The built-ins keep whoever is there, living or dead: what a skill does to the dead is its own business.
  for (const g of groups) g.filter.alive = null;
  for (const [id, value] of Object.entries(rawGroups)) {
    const path = joinPath("groups", id);
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["from", "filter", "sort", "max", "chain"]);
    const fromText = reader.string(raw, "from", path);
    let from: GroupSource = { kind: "target" };
    if (fromText.startsWith("area:")) from = { kind: "area", area: ctx.area(fromText.slice(5), joinPath(path, "from")) };
    else if (fromText.startsWith("group:")) {
      const other = ctx.group(fromText.slice(6), joinPath(path, "from"));
      if (other >= groupIndex.get(id)!) reader.fail(joinPath(path, "from"), "a group can only be made from one defined before it");
      from = { kind: "group", group: other };
    } else if (["target", "caster", "host", "threat", "owner", "summons", "attacking"].includes(fromText)) from = { kind: fromText as "target" };
    else if (fromText) reader.fail(joinPath(path, "from"), `expected target, caster, host, threat, owner, summons, attacking, area:<name> or group:<name>, got "${fromText}"`);
    let chain: GroupDef["chain"] = null;
    if (raw.chain !== undefined) {
      const c = reader.object(raw.chain, joinPath(path, "chain"));
      reader.onlyKeys(c, joinPath(path, "chain"), ["jumps", "radius", "filter"]);
      chain = { jumps: optionalExpr(c, "jumps", joinPath(path, "chain"), 2), radius: optionalExpr(c, "radius", joinPath(path, "chain"), 10), filter: readFilter(c.filter, joinPath(path, "chain.filter")) };
    }
    groups.push({
      id,
      from,
      filter: readFilter(raw.filter, joinPath(path, "filter")),
      sort: raw.sort === undefined ? "none" : reader.oneOf(raw, "sort", path, ["none", "nearest", "farthest", "lowestHealth", "random"] as const),
      max: raw.max === undefined ? null : expr(raw.max, joinPath(path, "max")),
      chain,
    });
  }

  // --- vars ---
  const rawVars = obj.vars === undefined ? {} : reader.object(obj.vars, "vars");
  const varDefaults = vars.map((name) => expr(rawVars[name], joinPath("vars", name)));

  // --- states ---
  const states: StateDef[] = Object.entries(rawStates).map(([id, value], i) => {
    const path = joinPath("states", id);
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, STATE_KEYS);
    // Left out, a length is 0 - an instant step - unless something keeps the state going: an event
    // to wait for, something held, or ticks. Then it lasts until an event moves it on.
    const waits = raw.on !== undefined || raw.hold !== undefined || raw.period !== undefined;
    let length: StateLength = waits ? { kind: "forever" } : { kind: "fixed", length: compileFormula(0, joinPath(path, "length"), reader, names) };
    if (isObject(raw.length) && "travel" in raw.length) {
      reader.onlyKeys(raw.length, joinPath(path, "length"), ["travel"]);
      length = { kind: "travel", speed: expr(raw.length.travel, joinPath(path, "length.travel")) };
    } else if (raw.length !== undefined) length = { kind: "fixed", length: expr(raw.length, joinPath(path, "length")) };
    const on: Transition[] = [];
    const rawOn = raw.on === undefined ? {} : reader.object(raw.on, joinPath(path, "on"));
    for (const [event, target] of Object.entries(rawOn)) {
      const at = joinPath(path, `on.${event}`);
      if (!STATE_EVENTS.includes(event)) reader.fail(at, `no event "${event}" (known: ${STATE_EVENTS.join(", ")})`);
      if (typeof target === "string") on.push({ event, to: stateRef(target, at), filter: [] });
      else {
        const t = reader.object(target, at);
        reader.onlyKeys(t, at, ["to", "filter"]);
        on.push({ event, to: stateRef(t.to, joinPath(at, "to")), filter: readMatches(t, "filter", at, reader, skillIndex) });
      }
    }
    const bar = raw.bar === undefined ? "" : reader.oneOf(raw, "bar", path, ["cast", "channel"] as const);
    const refill = raw.refill === undefined ? [] : reader.stringList(raw, "refill", path).map((g, j) => ctx.group(g, `${path}.refill[${j}]`));
    return {
      id,
      index: i,
      length,
      period: raw.period === undefined ? null : expr(raw.period, joinPath(path, "period")),
      enter: readActions(raw.enter, joinPath(path, "enter"), ctx, false),
      tick: readActions(raw.tick, joinPath(path, "tick"), ctx, false),
      exit: readActions(raw.exit, joinPath(path, "exit"), ctx, false),
      hold: readActions(raw.hold, joinPath(path, "hold"), ctx, true),
      next: raw.next === undefined ? -1 : stateRef(raw.next, joinPath(path, "next")),
      on,
      bar,
      breakOnMove: reader.boolean(raw, "breakOnMove", path, false),
      interruptible: reader.boolean(raw, "interruptible", path, false),
      commit: reader.boolean(raw, "commit", path, false),
      refill,
    };
  });
  if (states.some((s) => s.tick.length > 0 && s.period === null)) {
    states.forEach((s) => s.tick.length > 0 && s.period === null && reader.fail(joinPath("states", s.id), "has `tick` actions but no `period`"));
  }

  // --- the rest ---
  const passive = reader.boolean(obj, "passive", "", false);
  const hostOn = obj.hostOn === undefined ? "caster" : reader.oneOf(obj, "hostOn", "", ["caster", "target"] as const);
  if (hostOn === "target") states.forEach((s) => s.bar && reader.fail(joinPath("states", s.id), "a cast or channel bar belongs to a skill hosted on its caster"));
  if (passive) states.forEach((s) => s.bar && reader.fail(joinPath("states", s.id), "a passive has no cast bar"));
  if (states.filter((s) => s.commit).length > 1) reader.fail("states", "only one state may `commit`");

  const cost = obj.cost === undefined ? [] : Object.entries(reader.object(obj.cost, "cost")).map(([id, amount]) => ({
    resource: ctx.resource(id, joinPath("cost", id)),
    amount: expr(amount, joinPath("cost", id)),
  }));
  let gcd: SkillDef["gcd"] = passive ? "none" : "global";
  let gcdLength: CompiledFormula | null = null;
  if (obj.gcd === false) gcd = "none";
  else if (obj.gcd !== undefined && obj.gcd !== true) {
    gcd = "own";
    gcdLength = expr(obj.gcd, "gcd");
  }

  // Without a `stacking`, magics of the skill run side by side, as many as are started (two
  // fireballs in flight); with one, they combine, one stack by default.
  const declared = obj.stacking !== undefined;
  const stack = declared ? reader.object(obj.stacking, "stacking") : {};
  reader.onlyKeys(stack, "stacking", ["group", "per", "max", "add", "duration", "extendCap", "value", "strength"]);
  const stacking: StackingDef = {
    group: reader.optionalString(stack, "group", "stacking") ?? entry.id,
    per: stack.per === undefined ? "caster" : reader.oneOf(stack, "per", "stacking", ["host", "caster"] as const),
    max: optionalExpr(stack, "max", "stacking", declared ? 1 : 1e9),
    add: !declared ? "separate" : stack.add === undefined ? "stack" : reader.oneOf(stack, "add", "stacking", ["stack", "replace", "keep", "separate"] as const),
    duration: stack.duration === undefined ? "restart" : reader.oneOf(stack, "duration", "stacking", ["restart", "extend", "keep", "longer"] as const),
    extendCap: stack.extendCap === undefined ? null : expr(stack.extendCap, "stacking.extendCap"),
    value: stack.value === undefined ? "newest" : reader.oneOf(stack, "value", "stacking", ["newest", "stronger", "keep"] as const),
    strength: stack.strength === undefined ? null : expr(stack.strength, "stacking.strength"),
  };

  const type = obj.type === undefined ? "none" : reader.oneOf(obj, "type", "", ["spell", "physical", "none"] as const);
  const target = obj.target === undefined ? (passive ? "none" : "self") : reader.oneOf(obj, "target", "", ["enemy", "ally", "self", "point", "none"] as const);
  return {
    id: entry.id,
    index,
    name: reader.optionalString(obj, "name", "") ?? entry.id,
    tags: obj.tags === undefined ? [] : reader.stringList(obj, "tags", ""),
    type,
    weapon: reader.boolean(obj, "weapon", "", false),
    startsAttack: reader.boolean(obj, "startsAttack", "", type === "physical" && target === "enemy"),
    passive,
    target,
    hostOn,
    range: obj.range === undefined ? null : expr(obj.range, "range"),
    minRange: obj.minRange === undefined ? null : expr(obj.minRange, "minRange"),
    los: reader.boolean(obj, "los", "", false),
    facing: reader.boolean(obj, "facing", "", false),
    cost,
    cooldown: optionalExpr(obj, "cooldown", "", 0),
    category: reader.optionalString(obj, "category", "") ?? "",
    gcd,
    gcdLength,
    requires: matches("requires"),
    blockedBy: matches("blockedBy"),
    targetRequires: matches("targetRequires"),
    targetBlockedBy: matches("targetBlockedBy"),
    display: obj.display === undefined ? "hidden" : reader.oneOf(obj, "display", "", ["buff", "debuff", "hidden"] as const),
    dispel: reader.optionalString(obj, "dispel", "") ?? "",
    keepOnDeath: reader.boolean(obj, "keepOnDeath", "", false),
    stacking,
    areas,
    groups,
    vars,
    varDefaults,
    states,
    start: obj.start === undefined ? 0 : Math.max(stateRef(obj.start, "start"), 0),
    scope,
    cues: stringMap(reader, obj, "cues"),
  };
}

/** An optional object of strings, passed through unread: fields only the client uses. */
export function stringMap(reader: Reader, obj: RawObject, key: string, path = ""): Record<string, string> {
  if (obj[key] === undefined) return {};
  const at = joinPath(path, key);
  const raw = reader.object(obj[key], at);
  const out: Record<string, string> = {};
  for (const name of Object.keys(raw)) {
    if (typeof raw[name] === "string") out[name] = raw[name] as string;
    else reader.fail(joinPath(at, name), "expected text");
  }
  return out;
}

/** A list of actions. In a `hold` only held kinds may stand, and held kinds only there. */
function readActions(value: unknown, path: string, ctx: CheckContext, hold: boolean): Action[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    ctx.reader.fail(path, `expected a list of actions, got ${describe(value)}`);
    return [];
  }
  const actions: Action[] = [];
  value.forEach((item, i) => {
    const at = `${path}[${i}]`;
    const obj = ctx.reader.object(item, at);
    const kindName = obj.do;
    const kind = typeof kindName === "string" ? actionKind(kindName) : undefined;
    if (!kind) {
      ctx.reader.fail(joinPath(at, "do"), `no action ${describe(kindName)} (known: ${actionKinds().join(", ")})`);
      return;
    }
    if (hold && !kind.held) ctx.reader.fail(at, `"${kindName}" cannot be held: only ${actionKinds().filter((k) => actionKind(k)!.held).join(", ")} can`);
    if (!hold && kind.held) ctx.reader.fail(at, `"${kindName}" lasts as long as its state: put it in the state's \`hold\``);
    ctx.reader.onlyKeys(obj, at, ["do", "group", ...kind.keys]);
    const group = obj.group === undefined ? GROUP.host : ctx.group(obj.group, joinPath(at, "group"));
    actions.push({ kind: kindName as string, group, data: kind.check(obj, at, ctx) });
  });
  return actions;
}

/** `requires: ["weakenedSoul", { tag: "dot" }]`: a plain name is a skill, `{ tag }` a tag. */
function readMatches(obj: RawObject, key: string, path: string, reader: Reader, skillIndex: ReadonlyMap<string, number>): SkillMatch[] {
  return reader.optionalArray(obj, key, path).map((item, i) => {
    const at = `${joinPath(path, key)}[${i}]`;
    if (typeof item === "string") {
      const skill = skillIndex.get(item);
      if (skill === undefined) reader.fail(at, `no skill "${item}" (a tag is written { tag: "${item}" })`);
      return { skill: skill ?? -1, tag: "" };
    }
    const raw = reader.object(item, at);
    reader.onlyKeys(raw, at, ["tag"]);
    return { skill: -1, tag: reader.string(raw, "tag", at) };
  });
}

/** The flags, in bit order: for the inspector and messages. */
export { FLAG_NAMES };

/**
 * Checks skill ids other content names - items' `use` and `equip` (ITEMS.md, *Abilities*) - so a
 * typo is a content error naming the item's file. Throws a ContentError listing every unknown one.
 */
export function checkSkillRefs(rules: { skillIndex: ReadonlyMap<string, number> }, refs: readonly { file: string; path: string; id: string }[]): void {
  const issues: ContentIssue[] = refs
    .filter((ref) => !rules.skillIndex.has(ref.id))
    .map((ref) => ({ file: ref.file, path: ref.path, message: `no skill "${ref.id}" (known: ${known(rules.skillIndex.keys())})` }));
  if (issues.length > 0) throw new ContentError(issues);
}
