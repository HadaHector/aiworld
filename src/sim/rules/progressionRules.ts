import { ContentError, isObject, joinPath, Reader, type ContentIssue, type RawObject } from "../../world/content/contentReader";
import { PROGRESSION_FOLDERS, orderPacks, parseFile, type PackSource } from "../../world/content/resolveContent";
import { hashString } from "../../world/content/dimensions";
import { compileFormula, type CompiledFormula } from "./formula";
import { makeTemplate, mergeTemplate, PLAYER_TEMPLATE, type GameRules, type TemplateDef } from "./gameRules";
import type { Action } from "../skills/actions";
import type { ItemRules } from "./itemRules";
import { expandTemplates } from "./progressionTemplates";

/**
 * Progression (see PROGRESSION.md): disciplines with their curves, XP sources and unlocks, talent
 * trees, and origins - the slots a character is made from. Read from the packs with the world seed,
 * since templates generate disciplines and origins per seed, as item templates generate item types.
 */

/** Who is told of a discipline's level-ups. */
export type Visibility = "owner" | "all";

/** Where XP comes from (PROGRESSION.md, *XP sources*). */
export const SOURCE_KINDS = ["kill", "defeat", "hitDealt", "hitTaken", "healDealt", "cast", "skill", "gather", "craft", "quest"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Who of those on a victim's table earns a kill's XP. */
export const CREDITS = ["all", "split", "damage", "first", "top"] as const;
export type Credit = (typeof CREDITS)[number];

/** What a source's `weapon` matches: the earner's main-hand item. */
export type WeaponMatch = { template: string } | { type: string } | { kind: string } | "none";

export interface SourceDef {
  on: SourceKind;
  /** A formula in the source scope (`ProgressionRules.sourceScope`). */
  amount: CompiledFormula;
  when: CompiledFormula | null;
  rate: CompiledFormula | null;
  credit: Credit;
  tags: string[];
  notTags: string[];
  weapon: WeaponMatch | null;
  periodic: boolean | null;
  /** `cast`: a prefix the spell's source must start with ("origin:class"). */
  spellSource: string;
}

/** Ways an ability unlock is learned (PROGRESSION.md, *Learning*). */
export const HOWS = ["auto", "trainer", "item", "talent", "quest"] as const;
export type How = (typeof HOWS)[number];

export interface UnlockModifier {
  stat: number;
  kind: number;
  /** A formula of `own`, the discipline's level - or, on a talent node, `rank`. */
  value: CompiledFormula;
}

/** One entry of a discipline's (or an origin's) unlocks: what some of its levels give. */
export interface UnlockDef {
  /** The levels it applies at: exactly these, or `from`..`to` every `every`. */
  at: number[] | null;
  from: number;
  to: number;
  every: number;
  skill: number;
  spellLevel: number;
  how: How;
  cost: number;
  /** Held under `disc:<id>` and worked out again on each level-up. */
  modifiers: UnlockModifier[];
  points: { pool: string; amount: number }[];
  resource: number;
  disciplines: { discipline: number; level: number }[];
  knows: string[];
}

export interface DisciplineDef {
  id: string;
  index: number;
  name: string;
  /** The stat its level is the base of; -1 for none. */
  stat: number;
  start: number;
  /** Formulas in the discipline scope: the earner's stats, `own`, `disc.<id>`, `var.<name>`. */
  cap: CompiledFormula;
  next: CompiledFormula;
  overflow: "lose" | "keep";
  /** A stat every gain is multiplied by; -1 for none. */
  rate: number;
  sources: SourceDef[];
  unlocks: UnlockDef[];
  visible: Visibility;
  group: string;
  order: number;
  /** Its rolled vars, by the scope's var slots (`DisciplineScope.vars`). */
  vars: number[];
  varNames: string[];
  /** The template that made it, "" for an authored one. */
  template: string;
  file: string;
}

export interface TalentNodeDef {
  id: string;
  index: number;
  name: string;
  tier: number;
  ranks: number;
  cost: number;
  /** Nodes that must be at full rank first. */
  requires: number[];
  /** Formulas of `rank`. */
  modifiers: UnlockModifier[];
  skill: number;
  resource: number;
  points: { pool: string; amount: number }[];
}

export interface TalentTierDef {
  /** Points spent in the tree to open it. */
  requires: number;
  /** How many of its nodes may be taken; Infinity for all. */
  pick: number;
  /** A level of the tree's discipline needed; 0 for none. */
  level: number;
}

export interface TalentTreeDef {
  id: string;
  index: number;
  name: string;
  points: string;
  discipline: number;
  tiers: TalentTierDef[];
  nodes: TalentNodeDef[];
  file: string;
}

export interface OriginDef {
  id: string;
  index: number;
  slot: string;
  name: string;
  /** Template fields merged over the player's (stats add, lists add, `look` merges). */
  raw: RawObject;
  disciplines: { discipline: number; level: number }[];
  /** By discipline index. */
  unlocks: Map<number, UnlockDef[]>;
  trees: number[];
  only: string[];
  never: string[];
  template: string;
  file: string;
}

export interface SlotDef {
  id: string;
  required: boolean;
  default: string;
}

export interface ProgressionConfig {
  slots: SlotDef[];
  /** The template every combination of origins is made over. */
  base: string;
  /** The discipline shown as "the" level; -1 for none. */
  level: number;
  trainRange: number;
  /** Money to reset a tree: a formula of `spent`. */
  respecCost: CompiledFormula;
  /** Templates that teach, by template id: the skills each teaches (null: any). */
  trainers: Map<string, Set<number> | null>;
  never: string[];
}

/** Value layouts of the formula scopes. */
export interface DisciplineScope {
  stats: number;
  own: number;
  /** `disc.<id>` levels start here, one per discipline. */
  levels: number;
  /** `var.<name>` slots start here. */
  vars: number;
  size: number;
}
export interface SourceScope {
  earner: number;
  other: number;
  amount: number;
  earners: number;
  share: number;
  own: number;
  spellLevel: number;
  size: number;
}

export interface ProgressionRules {
  disciplines: DisciplineDef[];
  disciplineIndex: ReadonlyMap<string, number>;
  trees: TalentTreeDef[];
  treeIndex: ReadonlyMap<string, number>;
  origins: OriginDef[];
  originIndex: ReadonlyMap<string, number>;
  config: ProgressionConfig;
  /** Every allowed combination of origins (one per slot, in slot order) to its template id. */
  combinations: Map<string, string>;
  disciplineScope: DisciplineScope;
  sourceScope: SourceScope;
  /** Every point pool any unlock or node names, sorted - what `PointState.pool` indexes. */
  pools: string[];
  /** Item ids and templates sources and books name, checked against the item rules afterwards. */
  itemRefs: { file: string; path: string; id: string; what: "template" | "type" }[];
  hash: number;
}

interface Entry {
  id: string;
  file: string;
  data: unknown;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const known = (keys: Iterable<string>): string => [...keys].join(", ") || "none";

const DISCIPLINE_KEYS = ["name", "stat", "start", "cap", "next", "overflow", "rate", "xp", "unlocks", "visible", "group", "order", "vars"];
const SOURCE_KEYS = ["on", "amount", "when", "rate", "credit", "tags", "notTags", "weapon", "periodic", "spellSource"];
const UNLOCK_KEYS = ["at", "from", "to", "every", "skill", "level", "how", "cost", "modifiers", "points", "resource", "disciplines", "knows"];
const TREE_KEYS = ["name", "points", "discipline", "tiers", "nodes"];
const NODE_KEYS = ["name", "tier", "ranks", "cost", "requires", "modifiers", "skill", "resource", "points"];
export const ORIGIN_KEYS = ["slot", "name", "look", "stats", "modifiers", "resources", "spells", "disciplines", "unlocks", "trees", "only", "never"];
/** The highest level any discipline may have: levels are sent as u16. */
const LEVEL_LIMIT = 1000;

/** What the readers share. */
export interface ReadContext {
  game: GameRules;
  disciplineIndex: ReadonlyMap<string, number>;
  treeIndex: ReadonlyMap<string, number>;
  disciplineScope: DisciplineScope;
  sourceScope: SourceScope;
  sourceNames: ReadonlyMap<string, number>;
  issues: ContentIssue[];
  itemRefs: ProgressionRules["itemRefs"];
}

/**
 * Reads the packs' progression folders into ProgressionRules for a world seed, which the templates
 * read. Every allowed combination of origins becomes a player template (`player.<people>.<class>`)
 * and joins `game.templates`, so call this before the item rules, which check templates' start
 * items. Throws a ContentError listing every problem found.
 */
export function resolveProgressionRules(packs: PackSource[], game: GameRules, seed: number): ProgressionRules {
  const issues: ContentIssue[] = [];
  const folders = new Map<string, Map<string, Entry>>([...PROGRESSION_FOLDERS, "rules"].map((folder) => [folder, new Map()]));
  for (const pack of orderPacks(packs, issues)) {
    for (const { path, text } of pack.files) {
      const parts = path.split("/");
      if (parts.length !== 2 || !folders.has(parts[0])) continue;
      const id = parts[1].replace(/\.json5$/, "");
      if (parts[0] === "rules" && id !== "progression") continue;
      const file = `${pack.id}/${path}`;
      if (!ID_PATTERN.test(id)) {
        issues.push({ file, path: "", message: "file names (which are ids) may only use letters, digits, - and _" });
        continue;
      }
      const data = parseFile(file, text, issues);
      if (data !== undefined) folders.get(parts[0])!.set(id, { id, file, data });
    }
  }
  const entries = (folder: string): Entry[] => [...folders.get(folder)!.values()].sort(byId);
  const configEntry = folders.get("rules")!.get("progression");
  const never = new Set<string>();
  if (configEntry && isObject(configEntry.data) && Array.isArray(configEntry.data.never)) for (const id of configEntry.data.never) if (typeof id === "string") never.add(id);

  // Templates expand into the same raw objects authored files are, so one reader serves both.
  const generated = expandTemplates(entries("disciplineTemplates"), entries("originTemplates"), entries("talentPools"), seed, never, issues);
  const disciplineEntries = [...entries("disciplines").map((e) => ({ ...e, template: "" })), ...generated.disciplines]
    .filter((e) => !never.has(e.id) && !never.has(e.template))
    .sort(byId);
  const treeEntries = [...entries("talentTrees"), ...generated.trees].filter((e) => !never.has(e.id)).sort(byId);
  const originEntries = [...entries("origins").map((e) => ({ ...e, template: "" })), ...generated.origins]
    .filter((e) => !never.has(e.id) && !never.has(e.template))
    .sort(byId);

  const disciplineIndex = new Map(disciplineEntries.map((e, i) => [e.id, i]));
  const treeIndex = new Map(treeEntries.map((e, i) => [e.id, i]));

  // --- scopes ---
  const n = game.stats.length;
  const D = disciplineEntries.length;
  const disciplineScope: DisciplineScope = { stats: 0, own: n, levels: n + 1, vars: n + 1 + D, size: n + 1 + D };
  const sourceScope: SourceScope = { earner: 0, other: n, amount: 2 * n, earners: 2 * n + 1, share: 2 * n + 2, own: 2 * n + 3, spellLevel: 2 * n + 4, size: 2 * n + 5 };
  const sourceNames = new Map<string, number>();
  for (const stat of game.stats) {
    sourceNames.set(`earner.${stat.id}`, stat.index);
    sourceNames.set(`other.${stat.id}`, n + stat.index);
    sourceNames.set(`victim.${stat.id}`, n + stat.index);
  }
  for (const key of ["amount", "earners", "share", "own", "spellLevel"] as const) sourceNames.set(key, sourceScope[key]);

  const itemRefs: ProgressionRules["itemRefs"] = [];
  const ctx: ReadContext = { game, disciplineIndex, treeIndex, disciplineScope, sourceScope, sourceNames, issues, itemRefs };

  const disciplines = disciplineEntries.map((entry, index) => readDiscipline(entry, index, ctx));
  disciplineScope.size = disciplineScope.vars + Math.max(0, ...disciplines.map((d) => d.varNames.length));
  const trees = treeEntries.map((entry, index) => readTree(entry, index, ctx));
  const origins = originEntries.map((entry, index) => readOrigin(entry, index, ctx));
  const originIndex = new Map(origins.map((o) => [o.id, o.index]));
  const config = readConfig(configEntry, ctx, origins);

  // Origins name each other in `only` and `never`, and fill slots the config has.
  const slotIds = new Set(config.slots.map((s) => s.id));
  for (const origin of origins) {
    const reader = new Reader(issues, origin.file);
    if (!slotIds.has(origin.slot)) reader.fail("slot", `no slot "${origin.slot}" in rules/progression.json5 (known: ${known(slotIds)})`);
    for (const key of ["only", "never"] as const) {
      origin[key].forEach((id, i) => {
        if (!originIndex.has(id)) reader.fail(`${key}[${i}]`, `no origin "${id}" (known: ${known(originIndex.keys())})`);
      });
    }
  }
  for (const slot of config.slots) {
    const origin = origins.find((o) => o.id === slot.default);
    if (slot.default && (!origin || origin.slot !== slot.id)) issues.push({ file: configEntry?.file ?? "rules/progression.json5", path: `slots.${slot.id}.default`, message: `no origin "${slot.default}" for the slot "${slot.id}"` });
    if (slot.required && !origins.some((o) => o.slot === slot.id)) issues.push({ file: configEntry?.file ?? "rules/progression.json5", path: `slots.${slot.id}`, message: "a required slot that no origin fills" });
  }
  checkSkillXp(game, disciplineIndex, issues);

  // --- every allowed combination of origins becomes a player template ---
  const combinations = new Map<string, string>();
  const player = game.rawTemplates.get(config.base);
  const byOriginId = new Map(origins.map((o) => [o.id, o]));
  if (issues.length === 0 && player && config.slots.length > 0) {
    for (const combo of combine(config.slots, origins)) {
      if (!allowed(combo, byOriginId)) continue;
      const key = combo.map((o) => o?.id ?? "").join(".");
      const id = `${PLAYER_TEMPLATE}.${key}`;
      const template = originTemplate(game, id, player.obj, combo.filter((o): o is OriginDef => o !== null), issues);
      if (!template) continue;
      game.templates.set(id, template);
      combinations.set(key, id);
    }
  }

  if (issues.length > 0) throw new ContentError(issues);

  const pools = new Set<string>();
  const notePools = (list: { pool: string }[]): void => list.forEach((p) => pools.add(p.pool));
  for (const d of disciplines) for (const u of d.unlocks) notePools(u.points);
  for (const o of origins) for (const list of o.unlocks.values()) for (const u of list) notePools(u.points);
  for (const t of trees) {
    pools.add(t.points);
    for (const node of t.nodes) notePools(node.points);
  }
  const signature = [
    disciplines.map((d) => `${d.id}:${d.stat}:${d.visible}:${d.vars.join("/")}`).join(","),
    trees.map((t) => `${t.id}:${t.nodes.map((nd) => nd.id).join("+")}`).join(","),
    origins.map((o) => `${o.id}:${o.slot}`).join(","),
  ].join("|");
  return {
    disciplines, disciplineIndex, trees, treeIndex, origins, originIndex, config, combinations, disciplineScope, sourceScope,
    pools: [...pools].sort(), itemRefs, hash: hashString(signature),
  };
}

/** The template a character with these origins is made from: the player's, with each origin merged
 *  over it - stats add to its bases, modifiers, resources and spells add, `look` merges. */
function originTemplate(game: GameRules, id: string, player: RawObject, origins: OriginDef[], issues: ContentIssue[]): TemplateDef | null {
  let obj: RawObject = { ...player };
  for (const origin of origins) {
    const raw = origin.raw;
    const stats: Record<string, number> = { ...(isObject(obj.stats) ? (obj.stats as Record<string, number>) : {}) };
    if (isObject(raw.stats)) for (const [key, value] of Object.entries(raw.stats)) stats[key] = (stats[key] ?? 0) + (typeof value === "number" ? value : 0);
    const list = (key: string): unknown[] => [...(Array.isArray(obj[key]) ? (obj[key] as unknown[]) : []), ...(Array.isArray(raw[key]) ? (raw[key] as unknown[]) : [])];
    const resources = [...new Set(list("resources"))];
    // A spell an origin repeats (two give autoAttack) is kept once.
    const seen = new Set<string>();
    const spells = list("spells").filter((s) => {
      const skill = isObject(s) ? String(s.skill) : String(s);
      if (seen.has(skill)) return false;
      seen.add(skill);
      return true;
    });
    // An origin's modifiers sit under the template's source: the entity's standing modifiers.
    const own: RawObject = { stats, resources, spells, modifiers: list("modifiers") };
    if (raw.look !== undefined) own.look = raw.look;
    obj = mergeTemplate(obj, own);
  }
  obj.name = player.name ?? "Adventurer";
  delete obj.abstract;
  delete obj.extends;
  const reader = new Reader(issues, origins.map((o) => o.file).join(" + ") || "entities/player.json5");
  return makeTemplate(game, id, obj, reader);
}

/** Every pick of one origin per slot (null for an optional slot left empty). */
function combine(slots: SlotDef[], origins: OriginDef[]): (OriginDef | null)[][] {
  let combos: (OriginDef | null)[][] = [[]];
  for (const slot of slots) {
    const options: (OriginDef | null)[] = origins.filter((o) => o.slot === slot.id);
    if (!slot.required) options.push(null);
    combos = combos.flatMap((combo) => options.map((o) => [...combo, o]));
  }
  return combos;
}

/** Whether a pick of origins may go together: no `never` between them, and an origin with `only`
 *  takes, from each other slot it names origins of, only those. */
function allowed(combo: (OriginDef | null)[], byId: ReadonlyMap<string, OriginDef>): boolean {
  const picked = combo.filter((o): o is OriginDef => o !== null);
  for (const origin of picked) {
    if (origin.never.some((id) => picked.some((o) => o.id === id))) return false;
    const onlySlots = new Set(origin.only.map((id) => byId.get(id)?.slot));
    for (const other of picked) {
      if (other !== origin && onlySlots.has(other.slot) && !origin.only.includes(other.id)) return false;
    }
  }
  return true;
}

// --- readers ---

function levelsOf(reader: Reader, raw: RawObject, path: string): Pick<UnlockDef, "at" | "from" | "to" | "every"> {
  if (raw.at !== undefined) {
    const list = Array.isArray(raw.at) ? raw.at : [raw.at];
    const at = list.map((v, i) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) reader.fail(joinPath(path, Array.isArray(raw.at) ? `at[${i}]` : "at"), "expected a whole level");
      return typeof v === "number" ? v : 0;
    });
    if (raw.from !== undefined || raw.every !== undefined || raw.to !== undefined) reader.fail(path, "give `at`, or `from` with `every` and `to` - not both");
    return { at, from: 0, to: 0, every: 1 };
  }
  if (raw.from === undefined) reader.fail(path, "needs `at` (a level or a list) or `from`");
  return {
    at: null,
    from: reader.optionalNumber(raw, "from", path, 1, { integer: true, min: 0 }),
    to: reader.optionalNumber(raw, "to", path, LEVEL_LIMIT, { integer: true, min: 0 }),
    every: reader.optionalNumber(raw, "every", path, 1, { integer: true, min: 1 }),
  };
}

/** Whether an unlock applies at a level. */
export function unlockAt(unlock: Pick<UnlockDef, "at" | "from" | "to" | "every">, level: number): boolean {
  if (unlock.at) return unlock.at.includes(level);
  return level >= unlock.from && level <= unlock.to && (level - unlock.from) % unlock.every === 0;
}

function readPoints(reader: Reader, raw: RawObject, path: string): { pool: string; amount: number }[] {
  if (raw.points === undefined) return [];
  const obj = reader.object(raw.points, joinPath(path, "points"));
  return Object.keys(obj).map((pool) => ({ pool, amount: reader.number(obj, pool, joinPath(path, "points"), { integer: true }) }));
}

function readModifiers(reader: Reader, raw: RawObject, path: string, game: GameRules, names: ReadonlyMap<string, number>): UnlockModifier[] {
  return reader.optionalArray(raw, "modifiers", path).map((value, i) => {
    const at = joinPath(path, `modifiers[${i}]`);
    const m = reader.object(value, at);
    reader.onlyKeys(m, at, ["stat", "kind", "value"]);
    const statId = reader.string(m, "stat", at);
    const kindId = m.kind === undefined ? "flat" : reader.string(m, "kind", at);
    const stat = game.statIndex.get(statId);
    const kind = game.kindIndex.get(kindId);
    if (statId && stat === undefined) reader.fail(`${at}.stat`, `no stat "${statId}" (known: ${known(game.statIndex.keys())})`);
    if (kind === undefined) reader.fail(`${at}.kind`, `no modifier kind "${kindId}" (known: ${known(game.kindIndex.keys())})`);
    return { stat: stat ?? 0, kind: kind ?? 0, value: compileFormula(m.value ?? 0, `${at}.value`, reader, names) };
  });
}

function skillOf(reader: Reader, raw: RawObject, key: string, path: string, game: GameRules): number {
  if (raw[key] === undefined) return -1;
  const id = reader.string(raw, key, path);
  const skill = game.skillIndex.get(id);
  if (id && skill === undefined) reader.fail(joinPath(path, key), `no skill "${id}" (known: ${known(game.skillIndex.keys())})`);
  return skill ?? -1;
}

function resourceOf(reader: Reader, raw: RawObject, path: string, game: GameRules): number {
  if (raw.resource === undefined) return -1;
  const id = reader.string(raw, "resource", path);
  const resource = game.resourceIndex.get(id);
  if (id && resource === undefined) reader.fail(joinPath(path, "resource"), `no resource "${id}" (known: ${known(game.resourceIndex.keys())})`);
  return resource ?? -1;
}

function readStartingDisciplines(reader: Reader, raw: RawObject, path: string, ctx: ReadContext): { discipline: number; level: number }[] {
  if (raw.disciplines === undefined) return [];
  const obj = reader.object(raw.disciplines, joinPath(path, "disciplines"));
  return Object.keys(obj).flatMap((id) => {
    const discipline = ctx.disciplineIndex.get(id);
    if (discipline === undefined) {
      reader.fail(joinPath(path, `disciplines.${id}`), `no discipline "${id}" (known: ${known(ctx.disciplineIndex.keys())})`);
      return [];
    }
    return [{ discipline, level: reader.number(obj, id, joinPath(path, "disciplines"), { integer: true, min: 1, max: LEVEL_LIMIT }) }];
  });
}

const OWN = new Map([["own", 0]]);
const RANK = new Map([["rank", 0]]);

export function readUnlocks(reader: Reader, list: unknown[], path: string, ctx: ReadContext): UnlockDef[] {
  return list.map((value, i) => {
    const at = `${path}[${i}]`;
    const raw = reader.object(value, at);
    reader.onlyKeys(raw, at, UNLOCK_KEYS);
    const skill = skillOf(reader, raw, "skill", at, ctx.game);
    const how = raw.how === undefined ? "auto" : reader.oneOf(raw, "how", at, HOWS);
    if (raw.how !== undefined && raw.skill === undefined) reader.fail(`${at}.how`, "only an unlock of a `skill` is learned some way");
    return {
      ...levelsOf(reader, raw, at),
      skill,
      spellLevel: reader.optionalNumber(raw, "level", at, 1, { integer: true, min: 1 }),
      how,
      cost: reader.optionalNumber(raw, "cost", at, 0, { min: 0, integer: true }),
      modifiers: readModifiers(reader, raw, at, ctx.game, OWN),
      points: readPoints(reader, raw, at),
      resource: resourceOf(reader, raw, at, ctx.game),
      disciplines: readStartingDisciplines(reader, raw, at, ctx),
      knows: raw.knows === undefined ? [] : reader.stringList(raw, "knows", at),
    };
  });
}

function readSource(reader: Reader, value: unknown, path: string, ctx: ReadContext): SourceDef {
  const raw = reader.object(value, path);
  reader.onlyKeys(raw, path, SOURCE_KEYS);
  const on = reader.oneOf(raw, "on", path, SOURCE_KINDS);
  let weapon: WeaponMatch | null = null;
  if (raw.weapon !== undefined) {
    if (raw.weapon === "none") weapon = "none";
    else {
      const w = reader.object(raw.weapon, `${path}.weapon`);
      reader.onlyKeys(w, `${path}.weapon`, ["template", "type", "kind"]);
      if (Object.keys(w).length !== 1) reader.fail(`${path}.weapon`, "match one of `template`, `type` or `kind`, or write \"none\" for bare hands");
      if (w.template !== undefined) {
        weapon = { template: reader.string(w, "template", `${path}.weapon`) };
        ctx.itemRefs.push({ file: reader.file, path: `${path}.weapon.template`, id: weapon.template, what: "template" });
      } else if (w.type !== undefined) {
        weapon = { type: reader.string(w, "type", `${path}.weapon`) };
        ctx.itemRefs.push({ file: reader.file, path: `${path}.weapon.type`, id: weapon.type, what: "type" });
      } else if (w.kind !== undefined) weapon = { kind: reader.string(w, "kind", `${path}.weapon`) };
    }
    if (on !== "hitDealt") reader.fail(`${path}.weapon`, "only a `hitDealt` source matches a weapon");
  }
  if (raw.credit !== undefined && on !== "kill" && on !== "defeat") reader.fail(`${path}.credit`, "only `kill` and `defeat` have credit");
  return {
    on,
    amount: compileFormula(raw.amount ?? (on === "skill" || on === "gather" || on === "craft" || on === "quest" ? "amount" : 0), `${path}.amount`, reader, ctx.sourceNames),
    when: raw.when === undefined ? null : compileFormula(raw.when, `${path}.when`, reader, ctx.sourceNames),
    rate: raw.rate === undefined ? null : compileFormula(raw.rate, `${path}.rate`, reader, ctx.sourceNames),
    credit: raw.credit === undefined ? "all" : reader.oneOf(raw, "credit", path, CREDITS),
    tags: raw.tags === undefined ? [] : reader.stringList(raw, "tags", path),
    notTags: raw.notTags === undefined ? [] : reader.stringList(raw, "notTags", path),
    weapon,
    periodic: raw.periodic === undefined ? null : reader.boolean(raw, "periodic", path, false),
    spellSource: raw.spellSource === undefined ? "" : reader.string(raw, "spellSource", path),
  };
}

function readDiscipline(entry: Entry & { template: string }, index: number, ctx: ReadContext): DisciplineDef {
  const reader = new Reader(ctx.issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", DISCIPLINE_KEYS);
  const { game, disciplineScope: scope } = ctx;
  // Vars: generated ones arrive rolled, as numbers; an authored discipline may give its own.
  const varsRaw = obj.vars === undefined ? {} : reader.object(obj.vars, "vars");
  const varNames = Object.keys(varsRaw).sort();
  const vars = varNames.map((name) => reader.number(varsRaw, name, "vars"));
  const names = new Map<string, number>();
  for (const stat of game.stats) names.set(stat.id, scope.stats + stat.index);
  names.set("own", scope.own);
  for (const [id, i] of ctx.disciplineIndex) names.set(`disc.${id}`, scope.levels + i);
  varNames.forEach((name, i) => names.set(`var.${name}`, scope.vars + i));

  const statId = obj.stat === undefined ? "" : reader.string(obj, "stat", "");
  const stat = statId ? game.statIndex.get(statId) : -1;
  if (statId && stat === undefined) reader.fail("stat", `no stat "${statId}" (known: ${known(game.statIndex.keys())})`);
  else if (stat !== undefined && stat >= 0 && game.stats[stat].formula) reader.fail("stat", `"${statId}" is a derived stat: a discipline sets a primary stat's base`);
  const rateId = obj.rate === undefined ? "" : reader.string(obj, "rate", "");
  const rate = rateId ? game.statIndex.get(rateId) : -1;
  if (rateId && rate === undefined) reader.fail("rate", `no stat "${rateId}"`);
  if (obj.next === undefined) reader.fail("next", "required formula is missing: the XP from `own` level to the next");
  const next = compileFormula(obj.next ?? 1, "next", reader, names);
  if (next.constant !== null && next.constant <= 0) reader.fail("next", "must be more than 0");
  const start = reader.optionalNumber(obj, "start", "", 1, { integer: true, min: 0, max: LEVEL_LIMIT });
  return {
    id: entry.id,
    index,
    name: reader.optionalString(obj, "name", "") ?? entry.id,
    stat: stat ?? -1,
    start,
    cap: compileFormula(obj.cap ?? LEVEL_LIMIT, "cap", reader, names),
    next,
    overflow: obj.overflow === undefined ? "lose" : reader.oneOf(obj, "overflow", "", ["lose", "keep"] as const),
    rate: rate ?? -1,
    sources: reader.optionalArray(obj, "xp", "").map((value, i) => readSource(reader, value, `xp[${i}]`, ctx)),
    unlocks: readUnlocks(reader, reader.optionalArray(obj, "unlocks", ""), "unlocks", ctx),
    visible: obj.visible === undefined ? "owner" : reader.oneOf(obj, "visible", "", ["owner", "all"] as const),
    group: reader.optionalString(obj, "group", "") ?? "",
    order: reader.optionalNumber(obj, "order", "", 0),
    vars,
    varNames,
    template: entry.template,
    file: entry.file,
  };
}

export function readTree(entry: Entry, index: number, ctx: ReadContext): TalentTreeDef {
  const reader = new Reader(ctx.issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", TREE_KEYS);
  const { game } = ctx;
  const disciplineId = obj.discipline === undefined ? "" : reader.string(obj, "discipline", "");
  const discipline = disciplineId ? ctx.disciplineIndex.get(disciplineId) : -1;
  if (disciplineId && discipline === undefined) reader.fail("discipline", `no discipline "${disciplineId}" (known: ${known(ctx.disciplineIndex.keys())})`);
  const tiers = reader.array(obj, "tiers", "").map((value, i): TalentTierDef => {
    const at = `tiers[${i}]`;
    const raw = reader.object(value, at);
    reader.onlyKeys(raw, at, ["requires", "pick", "level"]);
    const level = reader.optionalNumber(raw, "level", at, 0, { integer: true, min: 0 });
    if (level > 0 && !disciplineId) reader.fail(`${at}.level`, "a tier with a level needs the tree's `discipline`");
    return { requires: reader.optionalNumber(raw, "requires", at, 0, { integer: true, min: 0 }), pick: raw.pick === undefined ? Infinity : reader.number(raw, "pick", at, { integer: true, min: 1 }), level };
  });
  const nodesRaw = reader.object(obj.nodes, "nodes");
  const nodeIds = Object.keys(nodesRaw).sort();
  const nodeIndex = new Map(nodeIds.map((id, i) => [id, i]));
  const nodes = nodeIds.map((id, i): TalentNodeDef => {
    const at = `nodes.${id}`;
    const raw = reader.object(nodesRaw[id], at);
    reader.onlyKeys(raw, at, NODE_KEYS);
    const tier = reader.number(raw, "tier", at, { integer: true, min: 0 });
    if (tier >= tiers.length) reader.fail(`${at}.tier`, `the tree has ${tiers.length} tiers (0 to ${tiers.length - 1})`);
    const requires = raw.requires === undefined ? [] : reader.stringList(raw, "requires", at).flatMap((other, k) => {
      const j = nodeIndex.get(other);
      if (j === undefined) {
        reader.fail(`${at}.requires[${k}]`, `no node "${other}" in this tree (known: ${known(nodeIds)})`);
        return [];
      }
      return [j];
    });
    return {
      id,
      index: i,
      name: reader.optionalString(raw, "name", at) ?? id,
      tier,
      ranks: reader.optionalNumber(raw, "ranks", at, 1, { integer: true, min: 1, max: 255 }),
      cost: reader.optionalNumber(raw, "cost", at, 1, { integer: true, min: 0 }),
      requires,
      modifiers: readModifiers(reader, raw, at, game, RANK),
      skill: skillOf(reader, raw, "skill", at, game),
      resource: resourceOf(reader, raw, at, game),
      points: readPoints(reader, raw, at),
    };
  });
  // A node that needs one in a later tier, or a circle of them, can never be taken.
  for (const node of nodes) {
    for (const r of node.requires) if (nodes[r].tier > node.tier) reader.fail(`nodes.${node.id}.requires`, `"${nodes[r].id}" is in a later tier`);
  }
  const state = new Uint8Array(nodes.length);
  const visit = (k: number, path: number[]): void => {
    if (state[k] === 2) return;
    if (state[k] === 1) {
      reader.fail(`nodes.${nodes[k].id}.requires`, `nodes require each other in a circle: ${[...path.slice(path.indexOf(k)), k].map((j) => nodes[j].id).join(" → ")}`);
      return;
    }
    state[k] = 1;
    for (const r of nodes[k].requires) visit(r, [...path, k]);
    state[k] = 2;
  };
  nodes.forEach((_, k) => visit(k, []));
  tiers.forEach((tier, t) => {
    if (!nodes.some((nd) => nd.tier === t)) reader.fail(`tiers[${t}]`, "no node is in this tier");
    // A tier needing more points than the tiers below it can ever take cannot open.
    const below = nodes.filter((nd) => nd.tier < t).reduce((sum, nd) => sum + nd.ranks * nd.cost, 0);
    if (tier.requires > below) reader.fail(`tiers[${t}].requires`, `needs ${tier.requires} points spent, but the tiers below hold only ${below}`);
  });
  return {
    id: entry.id,
    index,
    name: reader.optionalString(obj, "name", "") ?? entry.id,
    points: reader.optionalString(obj, "points", "") ?? "talent",
    discipline: discipline ?? -1,
    tiers,
    nodes,
    file: entry.file,
  };
}

function readOrigin(entry: Entry & { template: string }, index: number, ctx: ReadContext): OriginDef {
  const reader = new Reader(ctx.issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", ORIGIN_KEYS);
  const unlocks = new Map<number, UnlockDef[]>();
  if (obj.unlocks !== undefined) {
    const raw = reader.object(obj.unlocks, "unlocks");
    for (const id of Object.keys(raw)) {
      const discipline = ctx.disciplineIndex.get(id);
      if (discipline === undefined) {
        reader.fail(`unlocks.${id}`, `no discipline "${id}" (known: ${known(ctx.disciplineIndex.keys())})`);
        continue;
      }
      unlocks.set(discipline, readUnlocks(reader, reader.array(raw, id, "unlocks"), `unlocks.${id}`, ctx));
    }
  }
  const trees = (obj.trees === undefined ? [] : reader.stringList(obj, "trees", "")).flatMap((id, i) => {
    const tree = ctx.treeIndex.get(id);
    if (tree === undefined) {
      reader.fail(`trees[${i}]`, `no talent tree "${id}" (known: ${known(ctx.treeIndex.keys())})`);
      return [];
    }
    return [tree];
  });
  const raw: RawObject = {};
  for (const key of ["look", "stats", "modifiers", "resources", "spells"]) if (obj[key] !== undefined) raw[key] = obj[key];
  return {
    id: entry.id,
    index,
    slot: reader.string(obj, "slot", ""),
    name: reader.optionalString(obj, "name", "") ?? entry.id,
    raw,
    disciplines: readStartingDisciplines(reader, obj, "", ctx),
    unlocks,
    trees,
    only: obj.only === undefined ? [] : reader.stringList(obj, "only", ""),
    never: obj.never === undefined ? [] : reader.stringList(obj, "never", ""),
    template: entry.template,
    file: entry.file,
  };
}

function readConfig(entry: Entry | undefined, ctx: ReadContext, origins: OriginDef[]): ProgressionConfig {
  const config: ProgressionConfig = { slots: [], base: PLAYER_TEMPLATE, level: -1, trainRange: 4, respecCost: compileFormula(0, "", new Reader([], ""), new Map()), trainers: new Map(), never: [] };
  if (!entry) return config;
  const reader = new Reader(ctx.issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", ["slots", "base", "level", "trainRange", "respec", "trainers", "never"]);
  config.base = reader.optionalString(obj, "base", "") ?? PLAYER_TEMPLATE;
  if (!ctx.game.rawTemplates.has(config.base)) reader.fail("base", `no entity template "${config.base}" (known: ${known(ctx.game.rawTemplates.keys())})`);
  if (obj.slots !== undefined) {
    const slots = reader.object(obj.slots, "slots");
    for (const id of Object.keys(slots)) {
      const raw = reader.object(slots[id], `slots.${id}`);
      reader.onlyKeys(raw, `slots.${id}`, ["required", "default"]);
      const required = reader.boolean(raw, "required", `slots.${id}`, true);
      const fallback = reader.optionalString(raw, "default", `slots.${id}`) ?? "";
      if (required && !fallback) reader.fail(`slots.${id}.default`, "a required slot needs a default origin");
      config.slots.push({ id, required, default: fallback });
    }
  }
  if (obj.level !== undefined) {
    const id = reader.string(obj, "level", "");
    const level = ctx.disciplineIndex.get(id);
    if (level === undefined) reader.fail("level", `no discipline "${id}" (known: ${known(ctx.disciplineIndex.keys())})`);
    config.level = level ?? -1;
  }
  config.trainRange = reader.optionalNumber(obj, "trainRange", "", 4, { min: 0 });
  if (obj.respec !== undefined) {
    const respec = reader.object(obj.respec, "respec");
    reader.onlyKeys(respec, "respec", ["cost"]);
    config.respecCost = compileFormula(respec.cost ?? 0, "respec.cost", reader, new Map([["spent", 0]]));
  }
  if (obj.trainers !== undefined) {
    const trainers = reader.object(obj.trainers, "trainers");
    for (const id of Object.keys(trainers)) {
      const at = `trainers.${id}`;
      if (!ctx.game.templates.has(id)) reader.fail(at, `no template "${id}" that can be made`);
      const raw = reader.object(trainers[id], at);
      reader.onlyKeys(raw, at, ["teaches"]);
      if (raw.teaches === "*") config.trainers.set(id, null);
      else {
        const skills = new Set<number>();
        reader.stringList(raw, "teaches", at).forEach((skillId, i) => {
          const skill = ctx.game.skillIndex.get(skillId);
          if (skill === undefined) reader.fail(`${at}.teaches[${i}]`, `no skill "${skillId}"`);
          else skills.add(skill);
        });
        config.trainers.set(id, skills);
      }
    }
  }
  config.never = obj.never === undefined ? [] : reader.stringList(obj, "never", "");
  void origins;
  return config;
}

/** Every `xp` action in a skill must name a discipline that exists. */
function checkSkillXp(game: GameRules, disciplineIndex: ReadonlyMap<string, number>, issues: ContentIssue[]): void {
  const walk = (actions: readonly Action[], skill: string, state: string): void => {
    for (const action of actions) {
      if (action.kind === "xp") {
        const id = (action.data as { discipline: string }).discipline;
        if (!disciplineIndex.has(id)) issues.push({ file: `skills/${skill}.json5`, path: `states.${state}`, message: `an \`xp\` action names no discipline "${id}" (known: ${known(disciplineIndex.keys())})` });
      }
      const data = action.data as { then?: Action[]; otherwise?: Action[] } | null;
      if (data && Array.isArray(data.then)) walk(data.then, skill, state);
      if (data && Array.isArray(data.otherwise)) walk(data.otherwise, skill, state);
    }
  };
  for (const skill of game.skills) {
    for (const state of skill.states) for (const list of [state.enter, state.tick, state.exit, state.hold]) walk(list, skill.id, state.id);
  }
}

/** Checks the items progression names - weapons sources match, books - once the item rules are in.
 *  Throws a ContentError listing every one that is not there. */
export function checkProgressionItems(rules: ProgressionRules, items: Pick<ItemRules, "typeIndex" | "generated">): void {
  const issues: ContentIssue[] = rules.itemRefs
    .filter((ref) => (ref.what === "type" ? !items.typeIndex.has(ref.id) : !items.generated.has(ref.id)))
    .map((ref) => ({ file: ref.file, path: ref.path, message: `no item ${ref.what === "type" ? "type" : "template"} "${ref.id}"` }));
  if (issues.length > 0) throw new ContentError(issues);
}
