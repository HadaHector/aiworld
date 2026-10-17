import { ContentError, isObject, joinPath, Reader, type ContentIssue, type RawObject } from "../../world/content/contentReader";
import { formatIssue } from "../../world/content/contentReader";
import { ITEM_FOLDERS, orderPacks, parseFile, type PackSource } from "../../world/content/resolveContent";
import { hashString } from "../../world/content/dimensions";
import { deriveSeed, mulberry32 } from "../../world/rng";
import { compileFormula, type CompiledFormula } from "./formula";
import type { GameRules } from "./gameRules";

/** A rarity tier (`rarities/<id>.json5`). */
export interface RarityDef {
  id: string;
  /** Its rank: rarities are in `order`, so a higher index is rarer. */
  index: number;
  name: string;
  order: number;
  /** "#rrggbb": an item's name on screen. */
  color: string;
  /** What a generated type's stats are multiplied by. */
  budget: number;
  /** How many stats a generated type of this rarity draws from its template's `extra` pool. */
  extraStats: number;
}

/** An equipment slot (`equipSlots/<id>.json5`). */
export interface EquipSlotDef {
  id: string;
  /** Its place in `ItemRules.slots`, in `order`: where it is in a belongings' equipment. */
  index: number;
  name: string;
  order: number;
  /** Whether what is worn there shows on the body. */
  visible: boolean;
}

/** A way a currency's amount is shown: `per` of the denomination before it make one of these. */
export interface Denomination {
  name: string;
  short: string;
  per: number;
}

/** A currency (`currencies/<id>.json5`): an integer of its smallest unit. */
export interface CurrencyDef {
  id: string;
  index: number;
  name: string;
  main: boolean;
  /** Smallest first; empty for a plain number. */
  denominations: Denomination[];
}

/** One stat an item gives while worn: a modifier of a kind, rolled per instance within a range. */
export interface ItemStatDef {
  stat: number;
  kind: number;
  min: number;
  max: number;
  /** Rolled to whole numbers (both ends are whole). */
  whole: boolean;
}

/** An item type: authored (`items/<id>.json5`) or generated from a template (`itemTemplates/`). */
export interface ItemTypeDef {
  id: string;
  index: number;
  name: string;
  kind: string;
  rarity: number;
  /** The equipment slots it may go in, any one of them; empty when it is not worn. */
  slots: number[];
  /** Slots it fills besides the one it is in - a two-handed weapon's off hand. */
  fills: number[];
  /** Gear pieces (CHARACTERS.md) it shows on the body while worn in a visible slot. */
  gear: string[];
  /** "#rrggbb" over its gear's own tints, or "". */
  tint: string;
  stats: ItemStatDef[];
  /** Must not be 0, of the wearer's stats and `itemLevel`, to equip it. */
  requires: CompiledFormula | null;
  /** Its maximum durability; 0 when it does not wear. */
  durability: number;
  stack: number;
  quest: boolean;
  use: { skill: string; consume: boolean } | null;
  equip: { skill: string } | null;
  /** Base price, in the main currency's smallest unit. */
  value: number;
  itemLevel: number;
  /** The template it was made from and its parts by axis; "" and {} for an authored type. */
  template: string;
  parts: Record<string, string>;
}

export type LootWhat =
  | { kind: "item"; type: number }
  | { kind: "table"; table: string }
  | { kind: "types"; types: number[] }
  | { kind: "money"; currency: number; amount: [number, number] }
  | { kind: "nothing" };

export interface LootEntry {
  weight: number;
  /** A formula of `source.<stat>` and `looter.<stat>`: left out when 0. */
  when: CompiledFormula | null;
  count: [number, number];
  what: LootWhat;
}

/** A loot table (`lootTables/<id>.json5`). */
export interface LootTableDef {
  id: string;
  rolls: [number, number];
  pick: LootEntry[];
  always: LootEntry[];
}

/** What an entity template's `items` field gives its entities. */
export interface EntityItemsDef {
  /** Slots in its bag and its bank: a player's. 0 for none. */
  bag: number;
  bank: number;
  /** What it starts with in its bag. */
  start: { type: number; count: number }[];
  /** The loot table rolled when it reaches 0 health, or when it is first opened (a container). */
  loot: string;
  /** A chest: opened, not killed. */
  container: boolean;
  /** Seconds of world time an emptied container stays empty. */
  respawn: number;
  /** A strongbox: the bank is reached near it, and it repairs. */
  banker: boolean;
}

/** `rules/items.json5`. */
export interface ItemConfig {
  wear: { onDeath: number; onHit: number; onHitTaken: number; hitChance: number };
  /** Per item, in the main currency: of `missing`, `max`, `value` and `itemLevel`. */
  repairCost: CompiledFormula;
  bankRange: number;
  pickUpRange: number;
  lootRange: number;
  groundLifetime: number;
  maxGenerated: number;
}

/**
 * Everything items are made of (see ITEMS.md): read once per server, from the packs and the world
 * seed - generated types depend on it - by both ends, so an item can be sent as its type's id and a
 * roll and each end works out the rest.
 */
export interface ItemRules {
  /** Authored and generated, in id order. */
  types: ItemTypeDef[];
  typeIndex: ReadonlyMap<string, number>;
  /** In rank order. */
  rarities: RarityDef[];
  rarityIndex: ReadonlyMap<string, number>;
  /** In `order`. */
  slots: EquipSlotDef[];
  slotIndex: ReadonlyMap<string, number>;
  /** In id order. */
  currencies: CurrencyDef[];
  currencyIndex: ReadonlyMap<string, number>;
  /** The main currency's index. */
  main: number;
  lootTables: ReadonlyMap<string, LootTableDef>;
  /** Every item template's generated types, by the template's id. */
  generated: ReadonlyMap<string, number[]>;
  /** Entity templates with an `items` field, by template id. */
  entities: ReadonlyMap<string, EntityItemsDef>;
  config: ItemConfig;
  /** Every skill items name, where - the skill rules check them (`checkSkillRefs`). */
  abilityRefs: { file: string; path: string; id: string }[];
  /** For `requires` and loot conditions: how many stats there are. */
  statCount: number;
  seed: number;
  /** A hash of the tables' ids - in Welcome, as the game rules' is. */
  hash: number;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ITEM_KEYS = ["name", "kind", "rarity", "slot", "fills", "gear", "tint", "stats", "modifiers", "requires", "durability", "stack", "quest", "use", "equip", "value", "level"];
const TEMPLATE_ONLY_KEYS = ["axes", "rarities", "extra", "only", "never", "unscaled"];
const PART_ONLY_KEYS = ["id", "name", "level", "budget", "stats"];

interface Entry {
  id: string;
  file: string;
  data: unknown;
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const known = (keys: Iterable<string>): string => [...keys].join(", ");

/**
 * Reads the packs' item folders into ItemRules (see ITEMS.md): rarities, slots and currencies, the
 * authored types and every type the templates make for this seed, loot tables, and what entity
 * templates' `items` fields say. Throws a ContentError with every problem found.
 */
export function resolveItemRules(packs: PackSource[], game: GameRules, seed: number): ItemRules {
  const issues: ContentIssue[] = [];
  const folders = new Map<string, Map<string, Entry>>([...ITEM_FOLDERS, "rules"].map((folder) => [folder, new Map()]));
  const gearIds = new Set<string>();
  for (const pack of orderPacks(packs, issues)) {
    for (const { path, text } of pack.files) {
      const parts = path.split("/");
      if (parts.length !== 2) continue;
      const id = parts[1].replace(/\.json5$/, "");
      if (parts[0] === "gear") gearIds.add(id);
      if (!folders.has(parts[0]) || (parts[0] === "rules" && id !== "items")) continue;
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

  // --- rarities, slots, currencies ---
  const rarities: RarityDef[] = entries("rarities")
    .map((entry) => {
      const reader = new Reader(issues, entry.file);
      const obj = reader.object(entry.data, "");
      reader.onlyKeys(obj, "", ["name", "order", "color", "budget", "extraStats"]);
      if (obj.color !== undefined) reader.color(obj, "color", "");
      return {
        id: entry.id,
        index: 0,
        name: reader.optionalString(obj, "name", "") ?? entry.id,
        order: reader.number(obj, "order", ""),
        color: typeof obj.color === "string" ? obj.color : "#ffffff",
        budget: reader.optionalNumber(obj, "budget", "", 1, { min: 0 }),
        extraStats: reader.optionalNumber(obj, "extraStats", "", 0, { min: 0, integer: true }),
      };
    })
    .sort((a, b) => a.order - b.order || byId(a, b));
  rarities.forEach((r, i) => (r.index = i));
  if (rarities.length === 0) issues.push({ file: "(all packs)", path: "", message: "no pack defines a rarity (rarities/<id>.json5): every item has one" });
  const rarityIndex = new Map(rarities.map((r) => [r.id, r.index]));

  const slots: EquipSlotDef[] = entries("equipSlots")
    .map((entry) => {
      const reader = new Reader(issues, entry.file);
      const obj = reader.object(entry.data, "");
      reader.onlyKeys(obj, "", ["name", "order", "visible"]);
      return { id: entry.id, index: 0, name: reader.optionalString(obj, "name", "") ?? entry.id, order: reader.number(obj, "order", ""), visible: reader.boolean(obj, "visible", "", true) };
    })
    .sort((a, b) => a.order - b.order || byId(a, b));
  slots.forEach((s, i) => (s.index = i));
  const slotIndex = new Map(slots.map((s) => [s.id, s.index]));

  const currencies: CurrencyDef[] = entries("currencies").map((entry, index) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["name", "main", "denominations"]);
    const denominations = reader.optionalArray(obj, "denominations", "").map((value, i) => {
      const path = `denominations[${i}]`;
      const raw = reader.object(value, path);
      reader.onlyKeys(raw, path, ["name", "short", "per"]);
      const name = reader.string(raw, "name", path);
      return { name, short: reader.optionalString(raw, "short", path) ?? name, per: reader.optionalNumber(raw, "per", path, 1, { min: 1, integer: true }) };
    });
    if (denominations.length > 0 && denominations[0].per !== 1) reader.fail("denominations[0].per", "the smallest denomination is the unit: its `per` is 1");
    return { id: entry.id, index, name: reader.optionalString(obj, "name", "") ?? entry.id, main: reader.boolean(obj, "main", "", false), denominations };
  });
  const currencyIndex = new Map(currencies.map((c) => [c.id, c.index]));
  const mains = currencies.filter((c) => c.main);
  if (mains.length !== 1) {
    issues.push({ file: "(all packs)", path: "", message: `exactly one currency has \`main: true\`, found ${mains.length === 0 ? "none" : mains.map((c) => c.id).join(", ")}` });
  }

  // --- the config ---
  const configEntry = folders.get("rules")!.get("items");
  const config = readConfig(configEntry, issues);

  // --- types: authored, then generated ---
  const statNames = new Map(game.stats.map((s) => [s.id, s.index]));
  const requireNames = new Map([...statNames, ["itemLevel", game.stats.length]]);
  const context: TypeContext = { game, rarityIndex, slotIndex, gearIds, requireNames, abilityRefs: [] };
  const raw: { id: string; obj: RawObject; reader: Reader; template: string; parts: Record<string, string> }[] = [];
  for (const entry of entries("items")) {
    const reader = new Reader(issues, entry.file);
    raw.push({ id: entry.id, obj: reader.object(entry.data, ""), reader, template: "", parts: {} });
  }
  for (const entry of entries("itemTemplates")) {
    const reader = new Reader(issues, entry.file);
    for (const made of generateTypes(entry.id, reader.object(entry.data, ""), reader, rarities, seed, config.maxGenerated)) raw.push({ ...made, reader });
  }
  raw.sort(byId);
  const types: ItemTypeDef[] = [];
  const typeIndex = new Map<string, number>();
  for (const { id, obj, reader, template, parts } of raw) {
    if (typeIndex.has(id)) {
      reader.fail("", `an item type "${id}" is defined twice (an authored one and a generated one share the id)`);
      continue;
    }
    typeIndex.set(id, types.length);
    types.push(readType(id, types.length, obj, reader, context, template, parts));
  }
  const generated = new Map<string, number[]>();
  for (const type of types) if (type.template) generated.set(type.template, [...(generated.get(type.template) ?? []), type.index]);

  // --- loot tables ---
  const lootNames = new Map<string, number>();
  for (const stat of game.stats) {
    lootNames.set(`source.${stat.id}`, stat.index);
    lootNames.set(`looter.${stat.id}`, game.stats.length + stat.index);
  }
  const lootEntries = entries("lootTables");
  const tableIds = new Set(lootEntries.map((e) => e.id));
  const lootTables = new Map<string, LootTableDef>();
  const lootContext: LootContext = { typeIndex, types, generated, rarityIndex, currencyIndex, main: mains[0]?.index ?? 0, tableIds, lootNames };
  for (const entry of lootEntries) lootTables.set(entry.id, readLootTable(entry, new Reader(issues, entry.file), lootContext));
  checkLootCycles(lootTables, lootEntries, issues);

  // --- entity templates' `items` ---
  const entities = new Map<string, EntityItemsDef>();
  for (const template of game.templates.values()) {
    if (!template.items) continue;
    const reader = new Reader(issues, template.file);
    entities.set(template.id, readEntityItems(template.items, reader, typeIndex, tableIds));
  }

  if (issues.length > 0) {
    // A broken template reports the same problem once for every type it makes: once is enough.
    const seen = new Set<string>();
    throw new ContentError(issues.filter((issue) => !seen.has(formatIssue(issue)) && !!seen.add(formatIssue(issue))));
  }

  const signature = [types.map((t) => t.id).join(","), rarities.map((r) => r.id).join(","), slots.map((s) => s.id).join(","), currencies.map((c) => c.id).join(",")].join("|");
  return {
    types,
    typeIndex,
    rarities,
    rarityIndex,
    slots,
    slotIndex,
    currencies,
    currencyIndex,
    main: mains[0].index,
    lootTables,
    generated,
    entities,
    config,
    abilityRefs: context.abilityRefs,
    statCount: game.stats.length,
    seed: seed >>> 0,
    hash: hashString(signature),
  };
}

function readConfig(entry: Entry | undefined, issues: ContentIssue[]): ItemConfig {
  const reader = new Reader(issues, entry?.file ?? "rules/items.json5");
  const obj = entry ? reader.object(entry.data, "") : {};
  reader.onlyKeys(obj, "", ["wear", "repair", "bankRange", "pickUpRange", "lootRange", "groundLifetime", "maxGenerated"]);
  const wear = obj.wear === undefined ? {} : reader.object(obj.wear, "wear");
  reader.onlyKeys(wear, "wear", ["onDeath", "onHit", "onHitTaken", "hitChance"]);
  const repair = obj.repair === undefined ? {} : reader.object(obj.repair, "repair");
  reader.onlyKeys(repair, "repair", ["cost"]);
  const repairNames = new Map([["missing", 0], ["max", 1], ["value", 2], ["itemLevel", 3]]);
  return {
    wear: {
      onDeath: reader.optionalNumber(wear, "onDeath", "wear", 0.1, { min: 0, max: 1 }),
      onHit: reader.optionalNumber(wear, "onHit", "wear", 1, { min: 0, integer: true }),
      onHitTaken: reader.optionalNumber(wear, "onHitTaken", "wear", 1, { min: 0, integer: true }),
      hitChance: reader.optionalNumber(wear, "hitChance", "wear", 0.2, { min: 0, max: 1 }),
    },
    repairCost: compileFormula(repair.cost ?? { mul: ["missing", "value", 0.02] }, "repair.cost", reader, repairNames),
    bankRange: reader.optionalNumber(obj, "bankRange", "", 4, { min: 0 }),
    pickUpRange: reader.optionalNumber(obj, "pickUpRange", "", 3, { min: 0 }),
    lootRange: reader.optionalNumber(obj, "lootRange", "", 4, { min: 0 }),
    groundLifetime: reader.optionalNumber(obj, "groundLifetime", "", 300, { min: 0 }),
    maxGenerated: reader.optionalNumber(obj, "maxGenerated", "", 2000, { min: 1, integer: true }),
  };
}

interface TypeContext {
  game: GameRules;
  rarityIndex: ReadonlyMap<string, number>;
  slotIndex: ReadonlyMap<string, number>;
  gearIds: ReadonlySet<string>;
  requireNames: ReadonlyMap<string, number>;
  abilityRefs: { file: string; path: string; id: string }[];
}

/** A stat's amount as written: a number, or a [min, max] range (min may equal max). */
function readAmount(value: unknown, path: string, reader: Reader): [number, number] {
  if (typeof value === "number" && Number.isFinite(value)) return [value, value];
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && Number.isFinite(v)) && value[0] <= value[1]) return [value[0], value[1]];
  reader.fail(path, "expected a number or a [min, max] range with min at most max");
  return [0, 0];
}

const slotList = (value: unknown, path: string, reader: Reader, slotIndex: ReadonlyMap<string, number>): number[] => {
  const ids = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!ids) {
    reader.fail(path, "expected a slot id or a list of them");
    return [];
  }
  const out: number[] = [];
  ids.forEach((id, i) => {
    const index = typeof id === "string" ? slotIndex.get(id) : undefined;
    if (index === undefined) reader.fail(Array.isArray(value) ? `${path}[${i}]` : path, `no equipment slot ${JSON.stringify(id)} (known: ${known(slotIndex.keys())})`);
    else out.push(index);
  });
  return out;
};

function readType(id: string, index: number, obj: RawObject, reader: Reader, ctx: TypeContext, template: string, parts: Record<string, string>): ItemTypeDef {
  const { game } = ctx;
  if (!template) reader.onlyKeys(obj, "", ITEM_KEYS);
  const stats: ItemStatDef[] = [];
  const flat = game.kindIndex.get("flat");
  if (obj.stats !== undefined) {
    const raw = reader.object(obj.stats, "stats");
    for (const [key, value] of Object.entries(raw)) {
      const stat = game.statIndex.get(key);
      const [min, max] = readAmount(value, joinPath("stats", key), reader);
      if (stat === undefined) reader.fail(joinPath("stats", key), `no stat "${key}" (known: ${known(game.statIndex.keys())})`);
      else if (flat === undefined) reader.fail("stats", 'a stat given as `stats` is a "flat" modifier, and no pack defines modifiers/flat.json5: use `modifiers`');
      else stats.push({ stat, kind: flat, min, max, whole: Number.isInteger(min) && Number.isInteger(max) });
    }
  }
  reader.optionalArray(obj, "modifiers", "").forEach((value, i) => {
    const path = `modifiers[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["stat", "kind", "value"]);
    const stat = game.statIndex.get(reader.string(raw, "stat", path));
    const kind = game.kindIndex.get(reader.string(raw, "kind", path));
    if (stat === undefined) reader.fail(`${path}.stat`, `no stat ${JSON.stringify(raw.stat)}`);
    if (kind === undefined) reader.fail(`${path}.kind`, `no modifier kind ${JSON.stringify(raw.kind)} (known: ${known(game.kindIndex.keys())})`);
    const [min, max] = readAmount(raw.value, `${path}.value`, reader);
    if (stat !== undefined && kind !== undefined) stats.push({ stat, kind, min, max, whole: Number.isInteger(min) && Number.isInteger(max) });
  });

  const rarityId = reader.optionalString(obj, "rarity", "");
  const rarity = rarityId === undefined ? 0 : ctx.rarityIndex.get(rarityId);
  if (rarity === undefined) reader.fail("rarity", `no rarity "${rarityId}" (known: ${known(ctx.rarityIndex.keys())})`);
  const slots = obj.slot === undefined ? [] : slotList(obj.slot, "slot", reader, ctx.slotIndex);
  const fills = obj.fills === undefined ? [] : slotList(obj.fills, "fills", reader, ctx.slotIndex);
  if (fills.length > 0 && slots.length !== 1) reader.fail("fills", "an item that fills other slots goes in exactly one `slot`");
  const gear = obj.gear === undefined ? [] : reader.stringList(obj, "gear", "");
  gear.forEach((g, i) => {
    if (!ctx.gearIds.has(g)) reader.fail(`gear[${i}]`, `no gear piece "${g}" (known: ${known([...ctx.gearIds].sort())})`);
  });
  if (obj.tint !== undefined) reader.color(obj, "tint", "");

  const stack = reader.optionalNumber(obj, "stack", "", 1, { min: 1, max: 65535, integer: true });
  const durability = reader.optionalNumber(obj, "durability", "", 0, { min: 0, max: 65535, integer: true });
  if (stack > 1) {
    if (stats.some((s) => s.min !== s.max)) reader.fail("stack", "a stacking type has no stat ranges: every item in a stack is the same");
    if (durability > 0) reader.fail("stack", "a stacking type does not wear (no `durability`)");
    if (slots.length > 0) reader.fail("stack", "a stacking type is not worn (no `slot`)");
  }
  const kind = reader.optionalString(obj, "kind", "") ?? "misc";

  const hook = (key: "use" | "equip"): RawObject | null => {
    if (obj[key] === undefined) return null;
    const raw = reader.object(obj[key], key);
    reader.onlyKeys(raw, key, key === "use" ? ["skill", "consume"] : ["skill"]);
    const skill = reader.string(raw, "skill", key);
    if (skill) ctx.abilityRefs.push({ file: reader.file, path: `${key}.skill`, id: skill });
    return raw;
  };
  const use = hook("use");
  const equip = hook("equip");
  if (equip && slots.length === 0) reader.fail("equip", "only an item that is worn (has a `slot`) has an `equip` skill");

  return {
    id,
    index,
    name: reader.string(obj, "name", ""),
    kind,
    rarity: rarity ?? 0,
    slots,
    fills,
    gear,
    tint: typeof obj.tint === "string" ? obj.tint : "",
    stats,
    requires: obj.requires === undefined ? null : compileFormula(obj.requires, "requires", reader, ctx.requireNames),
    durability,
    stack,
    quest: reader.boolean(obj, "quest", "", false) || kind === "quest",
    use: use ? { skill: String(use.skill ?? ""), consume: reader.boolean(use, "consume", "use", true) } : null,
    equip: equip ? { skill: String(equip.skill ?? "") } : null,
    value: reader.optionalNumber(obj, "value", "", 0, { min: 0, integer: true }),
    itemLevel: reader.optionalNumber(obj, "level", "", 1, { integer: true }),
    template,
    parts,
  };
}

/** Whether a combination matches an `only` or `never` entry: every key it names agrees. */
const matches = (rule: unknown, choice: Record<string, string>): boolean =>
  isObject(rule) && Object.entries(rule).every(([key, value]) => (Array.isArray(value) ? value.includes(choice[key]) : choice[key] === value));

/**
 * The item types a template makes (see ITEMS.md, *Generated item types*): one per choice from every
 * axis and rarity, as a raw item for `readType` - fields merged from the template and its parts,
 * stats summed and multiplied by the parts' and the rarity's budgets, extra stats drawn from the
 * world seed and the type's id.
 */
function generateTypes(
  templateId: string,
  obj: RawObject,
  reader: Reader,
  rarities: readonly RarityDef[],
  seed: number,
  maxGenerated: number,
): { id: string; obj: RawObject; template: string; parts: Record<string, string> }[] {
  reader.onlyKeys(obj, "", [...ITEM_KEYS, ...TEMPLATE_ONLY_KEYS]);
  const name = reader.string(obj, "name", "");
  const axesRaw = obj.axes === undefined ? {} : reader.object(obj.axes, "axes");
  const axes: { axis: string; parts: RawObject[] }[] = [];
  for (const [axis, value] of Object.entries(axesRaw)) {
    const parts = Array.isArray(value) ? value : [];
    if (!Array.isArray(value) || value.length === 0) reader.fail(joinPath("axes", axis), "expected a list of parts, at least one");
    const ids = new Set<string>();
    const read = parts.map((part, i) => {
      const path = `axes.${axis}[${i}]`;
      const raw = reader.object(part, path);
      reader.onlyKeys(raw, path, [...PART_ONLY_KEYS, ...ITEM_KEYS.filter((k) => k !== "name" && k !== "rarity")]);
      const id = reader.string(raw, "id", path);
      if (id && !ID_PATTERN.test(id)) reader.fail(`${path}.id`, "ids may only use letters, digits, - and _");
      if (ids.has(id)) reader.fail(`${path}.id`, `two parts of axis "${axis}" are both "${id}"`);
      ids.add(id);
      return raw;
    });
    axes.push({ axis, parts: read });
  }
  const rarityIds = obj.rarities === undefined ? [rarities[0]?.id ?? ""] : reader.stringList(obj, "rarities", "");
  const tiers = rarityIds.map((id, i) => {
    const tier = rarities.find((r) => r.id === id);
    if (!tier) reader.fail(`rarities[${i}]`, `no rarity "${id}" (known: ${known(rarities.map((r) => r.id))})`);
    return tier;
  });
  const extra = obj.extra === undefined ? {} : reader.object(obj.extra, "extra");
  const only = reader.optionalArray(obj, "only", "");
  const never = reader.optionalArray(obj, "never", "");
  // Stats the budgets leave alone - a weapon's speed is not better for being bigger.
  const unscaled = obj.unscaled === undefined ? [] : reader.stringList(obj, "unscaled", "");

  const count = axes.reduce((n, a) => n * Math.max(1, a.parts.length), 1) * tiers.length;
  if (count > maxGenerated) {
    reader.fail("axes", `would make ${count} item types, more than rules/items.json5's maxGenerated (${maxGenerated})`);
    return [];
  }
  const base: RawObject = {};
  for (const [key, value] of Object.entries(obj)) if (!TEMPLATE_ONLY_KEYS.includes(key) && key !== "stats") base[key] = value;

  const made: { id: string; obj: RawObject; template: string; parts: Record<string, string> }[] = [];
  const combine = (at: number, chosen: RawObject[]): void => {
    if (at < axes.length) {
      for (const part of axes[at].parts) combine(at + 1, [...chosen, part]);
      return;
    }
    for (const tier of tiers) {
      if (!tier) continue;
      const parts: Record<string, string> = {};
      axes.forEach((a, i) => (parts[a.axis] = String(chosen[i].id ?? "")));
      const choice = { ...parts, rarity: tier.id };
      if (never.some((rule) => matches(rule, choice))) continue;
      if (only.length > 0 && !only.some((rule) => matches(rule, choice))) continue;
      const id = [templateId, ...axes.map((a) => parts[a.axis]), tier.id].join(".");

      const item: RawObject = { ...base, rarity: tier.id };
      const ranges = new Map<string, [number, number]>();
      const addStats = (stats: unknown, path: string): void => {
        if (stats === undefined) return;
        for (const [stat, value] of Object.entries(reader.object(stats, path))) {
          const [lo, hi] = readAmount(value, joinPath(path, stat), reader);
          const was = ranges.get(stat) ?? [0, 0];
          ranges.set(stat, [was[0] + lo, was[1] + hi]);
        }
      };
      addStats(obj.stats, "stats");
      let budget = tier.budget;
      let level = typeof obj.level === "number" ? obj.level : 1;
      let label = name;
      chosen.forEach((part, i) => {
        for (const [key, value] of Object.entries(part)) if (!PART_ONLY_KEYS.includes(key)) item[key] = value;
        addStats(part.stats, `axes.${axes[i].axis}.stats`);
        if (typeof part.budget === "number") budget *= part.budget;
        if (typeof part.level === "number") level = Math.max(level, part.level);
        label = label.split(`{${axes[i].axis}}`).join(typeof part.name === "string" ? part.name : String(part.id ?? ""));
      });
      // The rarer tiers' extra stats: which ones, from the seed and the id.
      const pool = Object.keys(extra);
      const random = mulberry32(deriveSeed(seed >>> 0, hashString(id)));
      for (let n = 0; n < tier.extraStats && pool.length > 0; n++) {
        const [stat] = pool.splice(Math.floor(random() * pool.length), 1);
        const [lo, hi] = readAmount(extra[stat], joinPath("extra", stat), reader);
        const was = ranges.get(stat) ?? [0, 0];
        ranges.set(stat, [was[0] + lo, was[1] + hi]);
      }
      const stats: RawObject = {};
      for (const [stat, [lo, hi]] of ranges) {
        if (unscaled.includes(stat)) {
          stats[stat] = [lo, hi];
          continue;
        }
        const whole = Number.isInteger(lo) && Number.isInteger(hi);
        const min = whole ? Math.round(lo * budget) : Math.round(lo * budget * 100) / 100;
        const max = whole ? Math.max(min, Math.round(hi * budget)) : Math.max(min, Math.round(hi * budget * 100) / 100);
        stats[stat] = [min, max];
      }
      item.stats = stats;
      item.level = level;
      item.name = label;
      if (typeof item.value === "number") item.value = Math.round(item.value * budget);
      made.push({ id, obj: item, template: templateId, parts });
    }
  };
  combine(0, []);
  return made;
}

interface LootContext {
  typeIndex: ReadonlyMap<string, number>;
  types: readonly ItemTypeDef[];
  generated: ReadonlyMap<string, number[]>;
  rarityIndex: ReadonlyMap<string, number>;
  currencyIndex: ReadonlyMap<string, number>;
  main: number;
  tableIds: ReadonlySet<string>;
  lootNames: ReadonlyMap<string, number>;
}

/** A count as written: a whole number or a [min, max] range of them. */
function readCount(obj: RawObject, key: string, path: string, reader: Reader, fallback: number): [number, number] {
  const value = obj[key];
  if (value === undefined) return [fallback, fallback];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return [value, value];
  if (Array.isArray(value) && value.length === 2 && value.every((v) => Number.isInteger(v) && v >= 0) && value[0] <= value[1]) return [value[0], value[1]];
  reader.fail(joinPath(path, key), "expected a whole number or a [min, max] range of them");
  return [fallback, fallback];
}

function readLootTable(entry: Entry, reader: Reader, ctx: LootContext): LootTableDef {
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", ["rolls", "pick", "always"]);
  const read = (value: unknown, path: string): LootEntry => {
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["weight", "when", "count", "item", "table", "template", "rarity", "where", "money", "currency"]);
    const named = ["item", "table", "template", "money"].filter((k) => raw[k] !== undefined);
    if (named.length > 1) reader.fail(path, `an entry is one of item, table, template or money, not ${named.join(" and ")}`);
    let what: LootWhat = { kind: "nothing" };
    if (raw.item !== undefined) {
      const id = reader.string(raw, "item", path);
      const type = ctx.typeIndex.get(id);
      if (type === undefined) reader.fail(`${path}.item`, `no item type "${id}"`);
      else what = { kind: "item", type };
    } else if (raw.table !== undefined) {
      const table = reader.string(raw, "table", path);
      if (!ctx.tableIds.has(table)) reader.fail(`${path}.table`, `no loot table "${table}" (known: ${known(ctx.tableIds)})`);
      what = { kind: "table", table };
    } else if (raw.template !== undefined) {
      const template = reader.string(raw, "template", path);
      const made = ctx.generated.get(template);
      if (!made) reader.fail(`${path}.template`, `no item template "${template}" (known: ${known(ctx.generated.keys())})`);
      const rarity = raw.rarity === undefined ? null : typeof raw.rarity === "string" ? [raw.rarity] : reader.stringList(raw, "rarity", path);
      const where = raw.where === undefined ? {} : reader.object(raw.where, `${path}.where`);
      const typesOf = (made ?? []).filter((t) => {
        const type = ctx.types[t];
        if (rarity && !rarity.some((r) => ctx.rarityIndex.get(r) === type.rarity)) return false;
        return Object.entries(where).every(([axis, part]) => (Array.isArray(part) ? part.includes(type.parts[axis]) : type.parts[axis] === part));
      });
      if (made && typesOf.length === 0) reader.fail(path, `template "${template}" makes no type with that rarity and those parts`);
      what = { kind: "types", types: typesOf };
    } else if (raw.money !== undefined) {
      const amount = readCount(raw, "money", path, reader, 0);
      const id = reader.optionalString(raw, "currency", path);
      const currency = id === undefined ? ctx.main : ctx.currencyIndex.get(id);
      if (currency === undefined) reader.fail(`${path}.currency`, `no currency "${id}" (known: ${known(ctx.currencyIndex.keys())})`);
      what = { kind: "money", currency: currency ?? ctx.main, amount };
    }
    if (what.kind !== "types" && (raw.rarity !== undefined || raw.where !== undefined)) reader.fail(path, "`rarity` and `where` go with `template`");
    return {
      weight: reader.optionalNumber(raw, "weight", path, 1, { min: 0 }),
      when: raw.when === undefined ? null : compileFormula(raw.when, `${path}.when`, reader, ctx.lootNames),
      count: readCount(raw, "count", path, reader, 1),
      what,
    };
  };
  return {
    id: entry.id,
    rolls: readCount(obj, "rolls", "", reader, 1),
    pick: reader.optionalArray(obj, "pick", "").map((v, i) => read(v, `pick[${i}]`)),
    always: reader.optionalArray(obj, "always", "").map((v, i) => read(v, `always[${i}]`)),
  };
}

function checkLootCycles(tables: ReadonlyMap<string, LootTableDef>, entries: Entry[], issues: ContentIssue[]): void {
  const file = new Map(entries.map((e) => [e.id, e.file]));
  const state = new Map<string, number>(); // 1 on the path, 2 done
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      issues.push({ file: file.get(id) ?? id, path: "", message: `loot tables nest each other in a circle: ${[...path.slice(path.indexOf(id)), id].join(" → ")}` });
      return;
    }
    state.set(id, 1);
    const table = tables.get(id);
    for (const entry of table ? [...table.pick, ...table.always] : []) if (entry.what.kind === "table") visit(entry.what.table, [...path, id]);
    state.set(id, 2);
  };
  for (const id of tables.keys()) visit(id, []);
}

function readEntityItems(obj: RawObject, reader: Reader, typeIndex: ReadonlyMap<string, number>, tableIds: ReadonlySet<string>): EntityItemsDef {
  reader.onlyKeys(obj, "items", ["bag", "bank", "start", "loot", "container", "respawn", "banker"]);
  const start = reader.optionalArray(obj, "start", "items").map((value, i) => {
    const path = `items.start[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["item", "count"]);
    const id = reader.string(raw, "item", path);
    const type = typeIndex.get(id);
    if (id && type === undefined) reader.fail(`${path}.item`, `no item type "${id}"`);
    return { type: type ?? 0, count: reader.optionalNumber(raw, "count", path, 1, { min: 1, integer: true }) };
  });
  const loot = reader.optionalString(obj, "loot", "items") ?? "";
  if (loot && !tableIds.has(loot)) reader.fail("items.loot", `no loot table "${loot}" (known: ${known(tableIds)})`);
  const container = reader.boolean(obj, "container", "items", false);
  if (container && !loot) reader.fail("items.container", "a container holds loot: give it a `loot` table");
  return {
    bag: reader.optionalNumber(obj, "bag", "items", 0, { min: 0, max: 255, integer: true }),
    bank: reader.optionalNumber(obj, "bank", "items", 0, { min: 0, max: 255, integer: true }),
    start,
    loot,
    container,
    respawn: reader.optionalNumber(obj, "respawn", "items", 600, { min: 0 }),
    banker: reader.boolean(obj, "banker", "items", false),
  };
}

// --- Working an item out from its type and roll: the same on both ends ---------------------------

/** One stat's value for a roll: its own draw from the roll, evenly over its range. */
export function rollStat(stat: ItemStatDef, roll: number, i: number): number {
  if (stat.min === stat.max) return stat.min;
  const u = mulberry32(deriveSeed(roll >>> 0, i + 1))();
  if (stat.whole) return stat.min + Math.min(stat.max - stat.min, Math.floor(u * (stat.max - stat.min + 1)));
  return Math.round((stat.min + u * (stat.max - stat.min)) * 100) / 100;
}

/** What an instance of a type with this roll gives, stat by stat (in the type's `stats` order). */
export function itemStats(type: ItemTypeDef, roll: number): number[] {
  return type.stats.map((stat, i) => rollStat(stat, roll, i));
}

/** How well a roll fell, 0 (every stat at its low end) to 1 (every one at its high end); null for a
 *  type with nothing rolled. */
export function rollQuality(type: ItemTypeDef, roll: number): number | null {
  const ranged = type.stats.map((s, i) => [s, i] as const).filter(([s]) => s.min !== s.max);
  if (ranged.length === 0) return null;
  return ranged.reduce((sum, [s, i]) => sum + (rollStat(s, roll, i) - s.min) / (s.max - s.min), 0) / ranged.length;
}

/** What a loot table gives: types and counts, and money. */
export type LootDrop = { type: number; count: number } | { currency: number; amount: number };

const MAX_LOOT_DEPTH = 16;

/**
 * Rolls a loot table (see ITEMS.md, *Loot*): its `always` entries, then `rolls` picks by weight
 * among the `pick` entries whose `when` holds. `context` holds `source.<stat>` then `looter.<stat>`
 * (twice the stat count); `random` is the loot's own stream, so the same seed gives the same drop.
 */
export function rollLoot(rules: ItemRules, table: string, context: ArrayLike<number>, random: () => number, depth = 0): LootDrop[] {
  const def = rules.lootTables.get(table);
  if (!def || depth > MAX_LOOT_DEPTH) return [];
  const out: LootDrop[] = [];
  const between = ([lo, hi]: [number, number]): number => lo + Math.min(hi - lo, Math.floor(random() * (hi - lo + 1)));
  const give = (entry: LootEntry): void => {
    const what = entry.what;
    if (what.kind === "money") {
      const amount = between(what.amount);
      if (amount > 0) out.push({ currency: what.currency, amount });
      return;
    }
    const count = between(entry.count);
    if (what.kind === "table") {
      for (let n = 0; n < count; n++) out.push(...rollLoot(rules, what.table, context, random, depth + 1));
    } else if (what.kind === "item") {
      if (count > 0) out.push({ type: what.type, count });
    } else if (what.kind === "types" && what.types.length > 0) {
      if (count > 0) out.push({ type: what.types[Math.floor(random() * what.types.length)], count });
    }
  };
  const holds = (entry: LootEntry): boolean => !entry.when || entry.when.run(context) !== 0;
  for (const entry of def.always) if (holds(entry)) give(entry);
  const choices = def.pick.filter((e) => e.weight > 0 && holds(e));
  const total = choices.reduce((sum, e) => sum + e.weight, 0);
  const rolls = between(def.rolls);
  for (let n = 0; n < rolls && total > 0; n++) {
    let at = random() * total;
    const chosen = choices.find((e) => (at -= e.weight) < 0) ?? choices[choices.length - 1];
    give(chosen);
  }
  return out;
}

/** An amount of a currency as the screens show it: "1g 20s 5c", or a plain number. */
export function formatMoney(currency: CurrencyDef, amount: number): string {
  const { denominations } = currency;
  if (denominations.length === 0) return String(amount);
  const units: number[] = [];
  let unit = 1;
  for (const d of denominations) units.push((unit *= d.per));
  const parts: string[] = [];
  let left = Math.max(0, Math.floor(amount));
  for (let i = denominations.length - 1; i >= 0; i--) {
    const n = Math.floor(left / units[i]);
    left -= n * units[i];
    if (n > 0 || (i === 0 && parts.length === 0)) parts.push(`${n}${denominations[i].short}`);
  }
  return parts.join(" ");
}
