import { ContentError, isObject, joinPath, Reader, type ContentIssue, type RawObject } from "../../world/content/contentReader";
import { GAME_FOLDERS, orderPacks, parseFile, type PackSource } from "../../world/content/resolveContent";
import { hashString } from "../../world/content/dimensions";
import type { ColorTuple } from "../../world/terrain/pipeline/pipelineTypes";
import { compileFormula, type CompiledFormula } from "./formula";
import { readCombatRules, readSkills, type CombatRules, type SkillDef } from "./skillRules";

/** Who a stat's or a resource's value is sent to (see ENTITIES.md, *Replication*). */
export type Visibility = "owner" | "all";
const VISIBILITIES: readonly Visibility[] = ["owner", "all"];

export type StatRounding = "none" | "floor" | "round" | "ceil";
const ROUNDINGS: readonly StatRounding[] = ["none", "floor", "round", "ceil"];

/** One stat (`stats/<id>.json5`). */
export interface StatDef {
  id: string;
  /** Its place in `GameRules.stats` - what it is sent as, and its slot in every stat block. */
  index: number;
  name: string;
  /** A primary stat's base where a template does not set it. */
  default: number;
  /** A derived stat's base: a formula of other stats' final values. Null for a primary stat. */
  formula: CompiledFormula | null;
  min: number;
  max: number;
  round: StatRounding;
  visible: Visibility;
}

export type Gather = "sum" | "product" | "max" | "min";
const GATHERS: readonly Gather[] = ["sum", "product", "max", "min"];

/** A kind of modifier (`modifiers/<id>.json5`): where it applies, and what it does. */
export interface ModifierKindDef {
  id: string;
  index: number;
  name: string;
  order: number;
  gather: Gather;
  /** The stat after this kind, from `value` (index 0: the stat so far) and `total` (index 1). */
  apply: CompiledFormula;
}

export type OnMaxChange = "keep" | "scale";

/** A resource (`resources/<id>.json5`): health, mana, rage... */
export interface ResourceDef {
  id: string;
  index: number;
  name: string;
  /** The stat that is its maximum, by index. */
  max: number;
  /** The fraction of the maximum it starts at. */
  start: number;
  onMaxChange: OnMaxChange;
  /** Per second, negative for decay - formulas of the entity's stats. */
  regenOutOfCombat: CompiledFormula;
  regenInCombat: CompiledFormula;
  /** Seconds between regen ticks; 0 for every step. */
  interval: number;
  visible: Visibility;
}

/** How the client draws an entity: a body of a race (CHARACTERS.md) when it names one, else a
 *  capsule. The capsule's size is also what a click on the entity hits. */
export interface EntityLook {
  shape: "capsule";
  height: number;
  radius: number;
  color: ColorTuple;
  /** A race in the packs' `races/` - for the client alone, which finds it there. "" for a capsule. */
  race: string;
  /** An outfit in `outfits/` its body wears; "" for none. */
  outfit: string;
  /** A sex instead of the entity's seed's; "" to leave it to the seed. */
  sex: "male" | "female" | "";
}

/** A standing modifier a template gives the entities made from it. */
export interface TemplateModifier {
  stat: number;
  kind: number;
  value: number;
}

/** An entity template (`entities/<id>.json5`), with its `extends` chain already merged in. */
export interface TemplateDef {
  id: string;
  name: string;
  /** Base values of primary stats, by stat index - the ones it sets. */
  stats: { stat: number; value: number }[];
  /** Whether entities made from it have stats and resources at all. */
  hasStats: boolean;
  /** The resources it has, by index, `health` among them. Empty for an entity without resources. */
  resources: number[];
  modifiers: TemplateModifier[];
  look: EntityLook;
  /** Skills its entities know (ABILITIES.md, *Spells*), by index. */
  spells: { skill: number; level: number }[];
  /** How it stands toward players until factions come: who may attack it, and whom it attacks. */
  hostility: Hostility;
  /** Whether its entities keep a threat table. */
  threat: boolean;
  /** False: it does not die at 0 health (the training dummy). */
  mortal: boolean;
}

export type Hostility = "hostile" | "neutral" | "friendly";

/**
 * Everything gameplay is made of that is content rather than code (see ENTITIES.md): read once per
 * server from the same packs as the world, by both ends, so a stat can be sent as its index.
 */
export interface GameRules {
  /** In id order: a stat's index is its place here. */
  stats: StatDef[];
  /** Every stat's index, in an order where each derived stat comes after those it reads. */
  statOrder: number[];
  /** In id order. */
  modifierKinds: ModifierKindDef[];
  /** Modifier kind indices in the order they apply: by `order`, then id. */
  applyOrder: number[];
  /** In id order. */
  resources: ResourceDef[];
  /** Every template that can be made, by id - abstract ones left out. */
  templates: Map<string, TemplateDef>;
  statIndex: ReadonlyMap<string, number>;
  kindIndex: ReadonlyMap<string, number>;
  resourceIndex: ReadonlyMap<string, number>;
  /** The resource every entity with resources has (see ENTITIES.md). */
  health: number;
  /** In id order: a skill's index is its place here (ABILITIES.md). */
  skills: SkillDef[];
  skillIndex: ReadonlyMap<string, number>;
  /** `rules/combat.json5`. */
  combat: CombatRules;
  /** A hash of the tables' ids and visibility - in Welcome, so a client can tell its packs differ. */
  hash: number;
}

/** The resource the engine knows by name: every entity with resources has it. */
export const HEALTH = "health";
/** The template players are made from, by convention. */
export const PLAYER_TEMPLATE = "player";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_LOOK: EntityLook = { shape: "capsule", height: 1.8, radius: 0.4, color: [0.7, 0.7, 0.7], race: "", outfit: "", sex: "" };

interface Entry {
  id: string;
  file: string;
  data: unknown;
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Reads the packs' gameplay folders - stats, modifier kinds, resources, entity templates - into
 * GameRules: later packs replace earlier ones' definitions by id, formulas are compiled, templates'
 * chains merged, and every reference checked. Throws a ContentError listing every problem found.
 */
export function resolveGameRules(packs: PackSource[]): GameRules {
  const issues: ContentIssue[] = [];
  const folders = new Map<string, Map<string, Entry>>(GAME_FOLDERS.map((folder) => [folder, new Map()]));
  for (const pack of orderPacks(packs, issues)) {
    for (const { path, text } of pack.files) {
      const parts = path.split("/");
      if (parts.length !== 2 || !folders.has(parts[0])) continue;
      const file = `${pack.id}/${path}`;
      const id = parts[1].replace(/\.json5$/, "");
      if (!ID_PATTERN.test(id)) {
        issues.push({ file, path: "", message: "file names (which are ids) may only use letters, digits, - and _" });
        continue;
      }
      const data = parseFile(file, text, issues);
      if (data !== undefined) folders.get(parts[0])!.set(id, { id, file, data });
    }
  }
  const entries = (folder: string): Entry[] => [...folders.get(folder)!.values()].sort(byId);

  // --- stats: ids first, so formulas can name any of them ---
  const statEntries = entries("stats");
  const statIndex = new Map(statEntries.map((e, i) => [e.id, i]));
  const stats: StatDef[] = statEntries.map((entry, index) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["name", "default", "formula", "min", "max", "round", "visible"]);
    const formula = obj.formula === undefined ? null : compileFormula(obj.formula, "formula", reader, statIndex);
    if (formula && obj.default !== undefined) reader.fail("default", "a derived stat (one with a formula) has no default: its base is the formula");
    const min = reader.optionalNumber(obj, "min", "", -Infinity);
    const max = reader.optionalNumber(obj, "max", "", Infinity);
    if (min > max) reader.fail("max", `must be at least min (${min})`);
    return {
      id: entry.id,
      index,
      name: reader.optionalString(obj, "name", "") ?? entry.id,
      default: reader.optionalNumber(obj, "default", "", 0),
      formula,
      min,
      max,
      round: obj.round === undefined ? "none" : reader.oneOf(obj, "round", "", ROUNDINGS),
      visible: obj.visible === undefined ? "owner" : reader.oneOf(obj, "visible", "", VISIBILITIES),
    };
  });
  const statOrder = orderStats(stats, statEntries, issues);

  // --- modifier kinds ---
  const kindNames = new Map([["value", 0], ["total", 1]]);
  const modifierKinds: ModifierKindDef[] = entries("modifiers").map((entry, index) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["name", "order", "gather", "apply"]);
    if (obj.apply === undefined) reader.fail("apply", "required formula is missing: what this kind does to the stat (`value`) with its modifiers' `total`");
    return {
      id: entry.id,
      index,
      name: reader.optionalString(obj, "name", "") ?? entry.id,
      order: reader.number(obj, "order", ""),
      gather: reader.oneOf(obj, "gather", "", GATHERS),
      apply: compileFormula(obj.apply ?? 0, "apply", reader, kindNames),
    };
  });
  const kindIndex = new Map(modifierKinds.map((k) => [k.id, k.index]));
  const applyOrder = [...modifierKinds].sort((a, b) => a.order - b.order || byId(a, b)).map((k) => k.index);

  // --- resources ---
  const resourceEntries = entries("resources");
  const resourceIndex = new Map(resourceEntries.map((e, i) => [e.id, i]));
  const resources: ResourceDef[] = resourceEntries.map((entry, index) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["name", "max", "start", "onMaxChange", "regen", "interval", "visible"]);
    const maxId = reader.string(obj, "max", "");
    const max = statIndex.get(maxId);
    if (maxId && max === undefined) reader.fail("max", `no stat "${maxId}" (known: ${[...statIndex.keys()].join(", ")})`);
    const regen = obj.regen === undefined ? {} : reader.object(obj.regen, "regen");
    reader.onlyKeys(regen, "regen", ["outOfCombat", "inCombat"]);
    return {
      id: entry.id,
      index,
      name: reader.optionalString(obj, "name", "") ?? entry.id,
      max: max ?? 0,
      start: reader.optionalNumber(obj, "start", "", 1, { min: 0, max: 1 }),
      onMaxChange: obj.onMaxChange === undefined ? "keep" : reader.oneOf(obj, "onMaxChange", "", ["keep", "scale"] as const),
      regenOutOfCombat: compileFormula(regen.outOfCombat ?? 0, "regen.outOfCombat", reader, statIndex),
      regenInCombat: compileFormula(regen.inCombat ?? 0, "regen.inCombat", reader, statIndex),
      interval: reader.optionalNumber(obj, "interval", "", 0, { min: 0 }),
      visible: obj.visible === undefined ? "all" : reader.oneOf(obj, "visible", "", VISIBILITIES),
    };
  });
  const health = resourceIndex.get(HEALTH);
  if (health === undefined) issues.push({ file: "(all packs)", path: "", message: `no pack defines resources/${HEALTH}.json5 - every entity with resources has health` });

  // --- combat rules and skills ---
  const combat = readCombatRules(folders.get("rules")!.get("combat"), stats, issues);
  const { skills, skillIndex, templateRefs } = readSkills(entries("skills"), { stats, statIndex, kindIndex, resourceIndex }, combat, issues);

  // --- templates ---
  const templates = resolveTemplates(entries("entities"), { statIndex, kindIndex, resourceIndex, skillIndex, stats, health: health ?? 0 }, issues);
  if (!templates.has(PLAYER_TEMPLATE)) issues.push({ file: "(all packs)", path: "", message: `no pack defines entities/${PLAYER_TEMPLATE}.json5 - what players are made from` });
  for (const ref of templateRefs) {
    if (!templates.has(ref.id)) issues.push({ file: ref.file, path: ref.path, message: `no template "${ref.id}" that can be made (known: ${[...templates.keys()].join(", ")})` });
  }

  if (issues.length > 0) throw new ContentError(issues);

  const signature = [
    stats.map((s) => `${s.id}:${s.visible}`).join(","),
    modifierKinds.map((k) => k.id).join(","),
    resources.map((r) => `${r.id}:${r.visible}`).join(","),
    skills.map((s) => s.id).join(","),
  ].join("|");
  return {
    stats, statOrder, modifierKinds, applyOrder, resources, templates, statIndex, kindIndex, resourceIndex, health: health!,
    skills, skillIndex, combat, hash: hashString(signature),
  };
}

/** Checks that every entity the dimensions place names a template that can be made. Throws a
 *  ContentError listing every one that does not. */
export function checkPlacements(rules: GameRules, dimensions: readonly { id: string; entities: readonly { template: string }[] }[]): void {
  const issues: ContentIssue[] = [];
  for (const dimension of dimensions) {
    dimension.entities.forEach((placed, i) => {
      if (!rules.templates.has(placed.template)) {
        issues.push({ file: `dimensions/${dimension.id}.json5`, path: `entities[${i}].template`, message: `no template "${placed.template}" that can be made (known: ${[...rules.templates.keys()].join(", ")})` });
      }
    });
  }
  if (issues.length > 0) throw new ContentError(issues);
}

/** Every stat in an order where each derived stat comes after the stats its formula reads; a cycle
 *  between derived stats is reported against each stat in it. */
function orderStats(stats: StatDef[], entries: Entry[], issues: ContentIssue[]): number[] {
  const order: number[] = [];
  const state = new Uint8Array(stats.length); // 0 unvisited, 1 on the path, 2 done
  const path: number[] = [];
  const visit = (index: number): void => {
    if (state[index] === 2) return;
    if (state[index] === 1) {
      const cycle = path.slice(path.indexOf(index)).map((i) => stats[i].id);
      issues.push({ file: entries[index].file, path: "formula", message: `stats depend on each other in a circle: ${[...cycle, stats[index].id].join(" → ")}` });
      return;
    }
    state[index] = 1;
    path.push(index);
    for (const read of stats[index].formula?.reads ?? []) visit(read);
    path.pop();
    state[index] = 2;
    order.push(index);
  };
  for (let i = 0; i < stats.length; i++) visit(i);
  return order;
}

interface TemplateContext {
  statIndex: ReadonlyMap<string, number>;
  kindIndex: ReadonlyMap<string, number>;
  resourceIndex: ReadonlyMap<string, number>;
  skillIndex: ReadonlyMap<string, number>;
  stats: StatDef[];
  health: number;
}

const TEMPLATE_KEYS = ["extends", "abstract", "name", "stats", "resources", "modifiers", "look", "spells", "hostility", "threat", "mortal"];

/** Merges each template's `extends` chain - objects key by key, the child winning; lists whole - and
 *  reads the result. Abstract templates are left out of what is returned. */
function resolveTemplates(entries: Entry[], context: TemplateContext, issues: ContentIssue[]): Map<string, TemplateDef> {
  const raw = new Map(entries.map((e) => [e.id, e]));
  const merged = new Map<string, RawObject | null>();

  const flatten = (id: string, chain: string[]): RawObject | null => {
    if (merged.has(id)) return merged.get(id)!;
    const entry = raw.get(id)!;
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", TEMPLATE_KEYS);
    let result: RawObject = { ...obj };
    if (obj.extends !== undefined) {
      const parent = reader.string(obj, "extends", "");
      if (chain.includes(parent)) {
        reader.fail("extends", `templates extend each other in a circle: ${[...chain, id, parent].join(" → ")}`);
      } else if (!raw.has(parent)) {
        if (parent) reader.fail("extends", `no template "${parent}" (known: ${[...raw.keys()].join(", ")})`);
      } else {
        const base = flatten(parent, [...chain, id]);
        if (base) result = mergeTemplate(base, obj);
      }
    }
    delete result.extends;
    result.abstract = obj.abstract;
    merged.set(id, result);
    return result;
  };

  const templates = new Map<string, TemplateDef>();
  for (const entry of entries) {
    const obj = flatten(entry.id, []);
    if (!obj) continue;
    const reader = new Reader(issues, entry.file);
    if (reader.boolean(obj, "abstract", "", false)) continue;
    templates.set(entry.id, readTemplate(entry.id, obj, reader, context));
  }
  return templates;
}

function mergeTemplate(base: RawObject, child: RawObject): RawObject {
  const result: RawObject = { ...base };
  for (const [key, value] of Object.entries(child)) {
    const under = base[key];
    result[key] = isObject(value) && isObject(under) ? { ...under, ...value } : value;
  }
  return result;
}

function readTemplate(id: string, obj: RawObject, reader: Reader, { statIndex, kindIndex, resourceIndex, skillIndex, stats, health }: TemplateContext): TemplateDef {
  const statValues: TemplateDef["stats"] = [];
  const hasStats = obj.stats !== undefined || obj.resources !== undefined || obj.modifiers !== undefined;
  if (obj.stats !== undefined) {
    const raw = reader.object(obj.stats, "stats");
    for (const key of Object.keys(raw)) {
      const stat = statIndex.get(key);
      if (stat === undefined) {
        reader.fail(joinPath("stats", key), `no stat "${key}" (known: ${[...statIndex.keys()].join(", ")})`);
        continue;
      }
      if (stats[stat].formula) {
        reader.fail(joinPath("stats", key), "a derived stat's base is its formula: change it with a modifier");
        continue;
      }
      statValues.push({ stat, value: reader.number(raw, key, "stats") });
    }
  }

  const resources = new Set<number>();
  if (hasStats) resources.add(health);
  reader.optionalArray(obj, "resources", "").forEach((value, i) => {
    const index = typeof value === "string" ? resourceIndex.get(value) : undefined;
    if (index === undefined) reader.fail(`resources[${i}]`, `no resource ${JSON.stringify(value)} (known: ${[...resourceIndex.keys()].join(", ")})`);
    else resources.add(index);
  });

  const modifiers: TemplateModifier[] = [];
  reader.optionalArray(obj, "modifiers", "").forEach((value, i) => {
    const path = `modifiers[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["stat", "kind", "value"]);
    const statId = reader.string(raw, "stat", path);
    const kindId = reader.string(raw, "kind", path);
    const stat = statIndex.get(statId);
    const kind = kindIndex.get(kindId);
    if (statId && stat === undefined) reader.fail(`${path}.stat`, `no stat "${statId}"`);
    if (kindId && kind === undefined) reader.fail(`${path}.kind`, `no modifier kind "${kindId}" (known: ${[...kindIndex.keys()].join(", ")})`);
    const amount = reader.number(raw, "value", path);
    if (stat !== undefined && kind !== undefined) modifiers.push({ stat, kind, value: amount });
  });

  let look = DEFAULT_LOOK;
  if (obj.look !== undefined) {
    const raw = reader.object(obj.look, "look");
    reader.onlyKeys(raw, "look", ["shape", "height", "radius", "color", "race", "outfit", "sex"]);
    look = {
      shape: raw.shape === undefined ? "capsule" : reader.oneOf(raw, "shape", "look", ["capsule"] as const),
      height: reader.optionalNumber(raw, "height", "look", DEFAULT_LOOK.height, { min: 0.1 }),
      radius: reader.optionalNumber(raw, "radius", "look", DEFAULT_LOOK.radius, { min: 0.05 }),
      color: raw.color === undefined ? DEFAULT_LOOK.color : reader.color(raw, "color", "look"),
      race: reader.optionalString(raw, "race", "look") ?? "",
      outfit: reader.optionalString(raw, "outfit", "look") ?? "",
      sex: raw.sex === undefined ? "" : reader.oneOf(raw, "sex", "look", ["male", "female"] as const),
    };
  }

  const spells: TemplateDef["spells"] = [];
  reader.optionalArray(obj, "spells", "").forEach((value, i) => {
    const path = `spells[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["skill", "level"]);
    const skillId = reader.string(raw, "skill", path);
    const skill = skillIndex.get(skillId);
    if (skillId && skill === undefined) reader.fail(`${path}.skill`, `no skill "${skillId}" (known: ${[...skillIndex.keys()].join(", ")})`);
    const level = reader.optionalNumber(raw, "level", path, 1, { min: 0, integer: true });
    if (skill !== undefined) spells.push({ skill, level });
  });
  if (spells.length > 0 && !hasStats) reader.fail("spells", "an entity with spells needs stats and resources");

  return {
    id,
    name: reader.optionalString(obj, "name", "") ?? id,
    stats: statValues,
    hasStats,
    resources: [...resources].sort((a, b) => a - b),
    modifiers,
    look,
    spells,
    hostility: obj.hostility === undefined ? "neutral" : reader.oneOf(obj, "hostility", "", ["hostile", "neutral", "friendly"] as const),
    threat: reader.boolean(obj, "threat", "", false),
    mortal: reader.boolean(obj, "mortal", "", true),
  };
}
