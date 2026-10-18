import { ContentError, isObject, joinPath, Reader, type ContentIssue, type RawObject } from "../../world/content/contentReader";
import { CREATURE_FOLDERS, orderPacks, parseFile, type PackSource } from "../../world/content/resolveContent";
import { hashString } from "../../world/content/dimensions";
import { deriveSeed, mulberry32 } from "../../world/rng";
import { compileFormula, type CompiledFormula } from "./formula";
import { makeTemplate, mergeTemplate, type GameRules, type TemplateDef } from "./gameRules";

/** A skill the brain uses (see CREATURES.md, *The brain*). */
export interface TacticDef {
  skill: number;
  /** Seconds between uses, rolled each time: the brain's own spacing on top of the skill's cooldown. */
  every: [number, number];
  /** Must not be 0 for it to be used: a formula of `caster.*`, `target.*` (stats, and `healthPct`)
   *  and `distance`. Null: always. */
  when: CompiledFormula | null;
  /** Cast at its target, or at itself. */
  at: "target" | "self";
}

/** One creature kind: a species' variant with this world's traits, made into an entity template. */
export interface CreatureKind {
  /** Its template's id: `<species>.<variant>`, or the species' id when it has no variants. */
  id: string;
  species: string;
  variant: string;
  family: string;
  /** What each level above 1 adds to a stat's base, flat. */
  perLevel: { stat: number; value: number }[];
  tactics: TacticDef[];
  /** Shares of the body's walk and run speeds: wandering, and chasing or fleeing. */
  speed: { walk: number; run: number };
  /** How many stand at a point when it holds a group of this kind, and how far apart. */
  group: { size: [number, number]; spread: number };
  /** Biome id to weight: where it lives. */
  habitat: ReadonlyMap<string, number>;
  /** False: it only comes in camps, never alone in a roster. */
  roster: boolean;
  levelOffset: number;
  respawn: [number, number];
  /** A factor on the rules' aggro radius; 0 never aggroes by proximity (neutral kinds anyway). */
  aggro: number;
  /** Runs at this share of its health, for `time` seconds, once per pull - null: fights to the end. */
  flee: { at: number; time: number } | null;
  /** Metres it keeps from its target when it fights (a caster); 0 closes to melee. */
  keepRange: number;
  /** How far from home it wanders. */
  wander: number;
  /** This world's traits, by id. */
  traits: string[];
  template: TemplateDef;
}

/** A camp member: which kind (a kind id, or a species to take the variant the zone fits), how many. */
export interface CampMember {
  kinds: string[];
  count: [number, number];
  levelOffset: number;
  name: string;
  centre: boolean;
}

/** A camp (`camps/<id>.json5`): one group of members around a centre. */
export interface CampDef {
  id: string;
  habitat: ReadonlyMap<string, number>;
  radius: number;
  members: CampMember[];
  respawn: [number, number];
  wander: number;
}

/** `rules/creatures.json5`. */
export interface CreatureConfig {
  /** How many kinds a zone keeps. */
  rosterSize: [number, number];
  /** How many camps a zone keeps, of those whose habitat fits. */
  campsPerZone: [number, number];
  /** Spawn points: grid spacing, and how far from the world's spawn they keep. */
  spacing: number;
  emptyChance: number;
  campChance: number;
  /** Shares of points holding one creature, two, or a group. */
  groups: { single: number; pair: number; group: number };
  /** Steepest ground a point stands on, as rise over run. */
  maxSlope: number;
  safeRadius: number;
  /** Points within this of a player are active; none within `releaseRadius` for `releaseAfter`
   *  seconds, they are released. */
  activeRadius: number;
  releaseRadius: number;
  releaseAfter: number;
  corpse: { time: number; emptied: number };
  /** Metres from where a pull started before a creature evades. */
  leash: number;
  /** Seconds a chase may make no progress before the creature evades. */
  stuck: number;
  /** The aggro radius: a formula of `caster.*` (the creature) and `target.*` (the player). */
  aggro: CompiledFormula;
  /** The skill an evading creature is given (it ends it on arriving home). */
  evadeSkill: number;
  /** Zone levels until world generation sets them: ring 0 is `start`, each ring `step` higher. */
  levels: ZoneLevels;
  /** Species, variants or traits a game turns off. */
  never: string[];
}

export interface ZoneLevels {
  start: [number, number];
  step: number;
  width: number;
  cap: number;
}

export interface CreatureRules {
  /** Every kind, by id (also in the game rules' templates). */
  kinds: ReadonlyMap<string, CreatureKind>;
  /** Kinds in id order - a roster's candidates are drawn in this order. */
  kindList: readonly CreatureKind[];
  /** Variants by species, for camps naming a species. */
  speciesKinds: ReadonlyMap<string, readonly CreatureKind[]>;
  camps: readonly CampDef[];
  config: CreatureConfig;
  /** The scope `when` and `aggro` formulas read: caster stats, target stats, then the extras. */
  scope: { stats: number; casterHealth: number; targetHealth: number; distance: number; size: number };
  hash: number;
}

interface Entry {
  id: string;
  file: string;
  data: unknown;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const SPECIES_KEYS = [
  "entity", "name", "family", "hostility", "stats", "perLevel", "modifiers", "spells", "tactics", "speed", "group", "habitat", "roster",
  "levelOffset", "respawn", "aggro", "flee", "keepRange", "wander", "loot", "look", "variants", "traits",
];
const VARIANT_KEYS = ["id", "name", "habitat", "stats", "perLevel", "modifiers", "spells", "tactics", "look", "never", "levelOffset", "speed", "flee", "keepRange", "aggro"];
const TRAIT_KEYS = ["name", "stats", "modifiers", "spells", "tactics", "speed"];

/**
 * Reads the packs' creature folders (see CREATURES.md) - species, traits, camps and
 * `rules/creatures.json5` - into CreatureRules for a world seed, which picks each kind's traits. Every
 * kind becomes an entity template and joins `game.templates`, so call this before the item rules,
 * which check templates' loot. Throws a ContentError listing every problem found.
 */
export function resolveCreatureRules(packs: PackSource[], game: GameRules, seed: number): CreatureRules {
  const issues: ContentIssue[] = [];
  const folders = new Map<string, Map<string, Entry>>([...CREATURE_FOLDERS, "rules"].map((folder) => [folder, new Map()]));
  const biomes = new Set<string>();
  for (const pack of orderPacks(packs, issues)) {
    for (const { path, text } of pack.files) {
      const parts = path.split("/");
      if (parts.length !== 2) continue;
      const id = parts[1].replace(/\.json5$/, "");
      if (parts[0] === "biomes") biomes.add(id);
      if (!folders.has(parts[0]) || (parts[0] === "rules" && id !== "creatures")) continue;
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

  // Formulas the brain runs: the creature's stats, the other's, then health shares and distance.
  const n = game.stats.length;
  const scope = { stats: n, casterHealth: 2 * n, targetHealth: 2 * n + 1, distance: 2 * n + 2, size: 2 * n + 3 };
  const names = new Map<string, number>();
  for (const stat of game.stats) {
    names.set(`caster.${stat.id}`, stat.index);
    names.set(`target.${stat.id}`, n + stat.index);
  }
  names.set("caster.healthPct", scope.casterHealth);
  names.set("target.healthPct", scope.targetHealth);
  names.set("distance", scope.distance);

  const config = readConfig(folders.get("rules")!.get("creatures"), game, names, issues);
  const never = new Set(config.never);

  // --- traits ---
  const traits = new Map<string, { obj: RawObject; reader: Reader }>();
  for (const entry of entries("creatureTraits")) {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", TRAIT_KEYS);
    traits.set(entry.id, { obj, reader });
  }

  // --- species to kinds ---
  const kinds = new Map<string, CreatureKind>();
  const speciesKinds = new Map<string, CreatureKind[]>();
  for (const entry of entries("creatures")) {
    if (never.has(entry.id)) continue;
    const reader = new Reader(issues, entry.file);
    const species = reader.object(entry.data, "");
    reader.onlyKeys(species, "", SPECIES_KEYS);
    const baseId = reader.string(species, "entity", "");
    const base = game.rawTemplates.get(baseId);
    if (baseId && !base) reader.fail("entity", `no entity template "${baseId}" (known: ${[...game.rawTemplates.keys()].join(", ")})`);
    if (!base) continue;
    const variants = reader.optionalArray(species, "variants", "");
    const pool = species.traits === undefined ? null : reader.object(species.traits, "traits");
    if (pool) reader.onlyKeys(pool, "traits", ["pick", "pool"]);
    const poolIds = pool ? reader.stringList(pool, "pool", "traits") : [];
    poolIds.forEach((id, i) => {
      if (!traits.has(id)) reader.fail(`traits.pool[${i}]`, `no trait "${id}" (known: ${[...traits.keys()].join(", ")})`);
    });
    const pick: [number, number] = pool?.pick === undefined ? [0, 0] : typeof pool.pick === "number" ? [pool.pick, pool.pick] : reader.range(pool, "pick", "traits", { allowEqual: true });
    const made: CreatureKind[] = [];
    const variantList: (RawObject | null)[] = variants.length === 0 ? [null] : variants.map((v, i) => reader.object(v, `variants[${i}]`));
    variantList.forEach((variant, i) => {
      const vpath = `variants[${i}]`;
      if (variant) reader.onlyKeys(variant, vpath, VARIANT_KEYS);
      const variantId = variant ? reader.string(variant, "id", vpath) : "";
      if (variantId && !ID_PATTERN.test(variantId)) reader.fail(`${vpath}.id`, "may only use letters, digits, - and _");
      const id = variantId ? `${entry.id}.${variantId}` : entry.id;
      if (never.has(id)) return;
      // This world's traits for the kind: from the seed and the kind's id.
      const banned = new Set([...never, ...(variant && variant.never !== undefined ? reader.stringList(variant, "never", vpath) : [])]);
      const candidates = poolIds.filter((t) => traits.has(t) && !banned.has(t));
      const random = mulberry32(deriveSeed(seed, hashString(`creature:${id}`)));
      const count = Math.min(candidates.length, pick[0] + Math.floor(random() * (pick[1] - pick[0] + 1)));
      const chosen: string[] = [];
      for (let k = 0; k < count; k++) chosen.push(candidates.splice(Math.floor(random() * candidates.length), 1)[0]);
      chosen.sort();
      const kind = makeKind(id, entry.id, variantId, species, variant, vpath, chosen.map((t) => ({ id: t, ...traits.get(t)! })), base.obj, reader, game, biomes, names);
      if (kind) {
        kinds.set(id, kind);
        made.push(kind);
      }
    });
    if (made.length > 0) speciesKinds.set(entry.id, made);
  }

  // --- camps ---
  const camps: CampDef[] = [];
  for (const entry of entries("camps")) {
    if (never.has(entry.id)) continue;
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["habitat", "radius", "members", "respawn", "wander"]);
    const members = reader.array(obj, "members", "").map((value, i): CampMember => {
      const path = `members[${i}]`;
      const raw = reader.object(value, path);
      reader.onlyKeys(raw, path, ["kind", "count", "levelOffset", "name", "at"]);
      const kindId = reader.string(raw, "kind", path);
      const list = kinds.has(kindId) ? [kindId] : (speciesKinds.get(kindId) ?? []).map((k) => k.id);
      if (kindId && list.length === 0) reader.fail(`${path}.kind`, `no creature kind or species "${kindId}" (kinds: ${[...kinds.keys()].join(", ")})`);
      return {
        kinds: list,
        count: raw.count === undefined ? [1, 1] : typeof raw.count === "number" ? [raw.count, raw.count] : reader.range(raw, "count", path, { allowEqual: true }),
        levelOffset: reader.optionalNumber(raw, "levelOffset", path, 0, { integer: true }),
        name: reader.optionalString(raw, "name", path) ?? "",
        centre: raw.at === undefined ? false : reader.oneOf(raw, "at", path, ["centre"] as const) === "centre",
      };
    });
    camps.push({
      id: entry.id,
      habitat: readHabitat(obj, reader, "", biomes),
      radius: reader.optionalNumber(obj, "radius", "", 12, { min: 1 }),
      members,
      respawn: obj.respawn === undefined ? [480, 600] : reader.range(obj, "respawn", "", { allowEqual: true }),
      wander: reader.optionalNumber(obj, "wander", "", 4, { min: 0 }),
    });
  }

  if (issues.length > 0) throw new ContentError(issues);

  const kindList = [...kinds.values()].sort(byId);
  for (const kind of kindList) game.templates.set(kind.id, kind.template);
  const signature = [kindList.map((k) => `${k.id}:${k.traits.join("+")}`).join(","), camps.map((c) => c.id).join(",")].join("|");
  return { kinds, kindList, speciesKinds, camps, config, scope, hash: hashString(signature) };
}

/** Where a species, a variant or a camp lives: `{ biome: weight }`, or a list of biomes (weight 1). */
function readHabitat(obj: RawObject, reader: Reader, path: string, biomes: ReadonlySet<string>, fallback?: ReadonlyMap<string, number>): Map<string, number> {
  const habitat = new Map<string, number>();
  if (obj.habitat === undefined) return new Map(fallback ?? []);
  const at = joinPath(path, "habitat");
  if (Array.isArray(obj.habitat)) {
    reader.stringList(obj, "habitat", path).forEach((id) => habitat.set(id, fallback?.get(id) ?? 1));
  } else {
    const raw = reader.object(obj.habitat, at);
    for (const id of Object.keys(raw)) habitat.set(id, reader.number(raw, id, at, { min: 0 }));
  }
  for (const id of habitat.keys()) if (!biomes.has(id)) reader.fail(joinPath(at, id), `no biome "${id}" in any pack`);
  return habitat;
}

/** Stat id to number, as a template's `stats` - added onto `into`. */
function addStats(into: Map<string, number>, obj: RawObject, key: string, reader: Reader, path: string): void {
  if (obj[key] === undefined) return;
  const raw = reader.object(obj[key], joinPath(path, key));
  for (const id of Object.keys(raw)) into.set(id, (into.get(id) ?? 0) + reader.number(raw, id, joinPath(path, key)));
}

function makeKind(
  id: string,
  speciesId: string,
  variantId: string,
  species: RawObject,
  variant: RawObject | null,
  vpath: string,
  traits: { id: string; obj: RawObject; reader: Reader }[],
  base: RawObject,
  reader: Reader,
  game: GameRules,
  biomes: ReadonlySet<string>,
  names: ReadonlyMap<string, number>,
): CreatureKind | null {
  const parts: { obj: RawObject; reader: Reader; path: string }[] = [
    { obj: species, reader, path: "" },
    ...(variant ? [{ obj: variant, reader, path: vpath }] : []),
    ...traits.map((t) => ({ obj: t.obj, reader: t.reader, path: "" })),
  ];
  // Stats: the species', then the variant's and the traits' on top (variants set, traits add).
  const stats = new Map<string, number>();
  addStats(stats, species, "stats", reader, "");
  if (variant?.stats !== undefined) {
    const raw = reader.object(variant.stats, joinPath(vpath, "stats"));
    for (const key of Object.keys(raw)) stats.set(key, reader.number(raw, key, joinPath(vpath, "stats")));
  }
  for (const t of traits) addStats(stats, t.obj, "stats", t.reader, "");
  const perLevel = new Map<string, number>();
  addStats(perLevel, species, "perLevel", reader, "");
  if (variant) addStats(perLevel, variant, "perLevel", reader, vpath);

  const modifiers: unknown[] = [];
  const spells: unknown[] = [];
  const tacticsRaw: { value: unknown; reader: Reader; path: string }[] = [];
  for (const part of parts) {
    for (const m of part.reader.optionalArray(part.obj, "modifiers", part.path)) modifiers.push(m);
    for (const s of part.reader.optionalArray(part.obj, "spells", part.path)) spells.push(s);
    part.reader.optionalArray(part.obj, "tactics", part.path).forEach((value, i) => tacticsRaw.push({ value, reader: part.reader, path: joinPath(part.path, `tactics[${i}]`) }));
  }

  // The name: traits' prefixes, then the species' pattern filled with the variant's name.
  const pattern = reader.optionalString(species, "name", "") ?? speciesId;
  const variantName = variant ? (reader.optionalString(variant, "name", vpath) ?? variantId) : "";
  const prefixes = traits.map((t) => t.reader.optionalString(t.obj, "name", "")).filter((s): s is string => !!s);
  const name = [...prefixes, pattern.replace("{variant}", variantName).replace(/\s+/g, " ").trim()].join(" ");

  let look: RawObject = isObject(base.look) ? { ...base.look } : {};
  if (species.look !== undefined) look = { ...look, ...reader.object(species.look, "look") };
  if (variant?.look !== undefined) look = { ...look, ...reader.object(variant.look, joinPath(vpath, "look")) };

  const own: RawObject = {
    name,
    stats: Object.fromEntries(stats),
    look,
    hostility: species.hostility ?? base.hostility ?? "hostile",
    threat: true,
  };
  if (spells.length > 0) own.spells = [...(Array.isArray(base.spells) ? base.spells : []), ...spells];
  if (modifiers.length > 0) own.modifiers = [...(Array.isArray(base.modifiers) ? base.modifiers : []), ...modifiers];
  if (species.loot !== undefined) own.items = { ...(isObject(base.items) ? base.items : {}), loot: reader.string(species, "loot", "") };
  const merged = mergeTemplate(base, own);
  delete merged.abstract;
  delete merged.extends;
  const template = makeTemplate(game, id, merged, reader);

  for (const [stat] of perLevel) if (!game.statIndex.has(stat)) reader.fail(joinPath(variant && variant.perLevel ? vpath : "", `perLevel.${stat}`), `no stat "${stat}"`);

  const tactics = tacticsRaw.map(({ value, reader: r, path }): TacticDef | null => {
    const raw = r.object(value, path);
    r.onlyKeys(raw, path, ["skill", "every", "when", "at"]);
    const skillId = r.string(raw, "skill", path);
    const skill = game.skillIndex.get(skillId);
    if (skillId && skill === undefined) r.fail(`${path}.skill`, `no skill "${skillId}"`);
    else if (skill !== undefined && !template.spells.some((s) => s.skill === skill)) r.fail(`${path}.skill`, `"${skillId}" is not one of the kind's spells: add it to \`spells\``);
    const every: [number, number] = raw.every === undefined ? [0, 0] : typeof raw.every === "number" ? [raw.every, raw.every] : r.range(raw, "every", path, { allowEqual: true });
    const when = raw.when === undefined ? null : compileFormula(raw.when, `${path}.when`, r, names);
    const at = raw.at === undefined ? "target" : r.oneOf(raw, "at", path, ["target", "self"] as const);
    return skill === undefined ? null : { skill, every, when, at };
  });

  // Fields the variant may set over the species'.
  const pick = <T,>(key: string, read: (obj: RawObject, path: string) => T, fallback: T): T =>
    variant && variant[key] !== undefined ? read(variant, vpath) : species[key] !== undefined ? read(species, "") : fallback;
  const speed = pick("speed", (obj, path) => {
    const raw = reader.object(obj.speed, joinPath(path, "speed"));
    reader.onlyKeys(raw, joinPath(path, "speed"), ["walk", "run"]);
    return { walk: reader.optionalNumber(raw, "walk", joinPath(path, "speed"), 0.25, { min: 0 }), run: reader.optionalNumber(raw, "run", joinPath(path, "speed"), 1, { min: 0 }) };
  }, { walk: 0.25, run: 1 });
  for (const t of traits) {
    if (t.obj.speed !== undefined) speed.run *= t.reader.number(t.obj, "speed", "");
  }
  const flee = pick("flee", (obj, path) => {
    if (obj.flee === false) return null;
    const raw = reader.object(obj.flee, joinPath(path, "flee"));
    reader.onlyKeys(raw, joinPath(path, "flee"), ["at", "time"]);
    return { at: reader.number(raw, "at", joinPath(path, "flee"), { min: 0, max: 1 }), time: reader.optionalNumber(raw, "time", joinPath(path, "flee"), 6, { min: 0 }) };
  }, null as { at: number; time: number } | null);
  const groupRaw = species.group === undefined ? {} : reader.object(species.group, "group");
  reader.onlyKeys(groupRaw, "group", ["size", "spread"]);
  const speciesHabitat = readHabitat(species, reader, "", biomes);

  return {
    id,
    species: speciesId,
    variant: variantId,
    family: reader.optionalString(species, "family", "") ?? "",
    perLevel: [...perLevel].filter(([stat]) => game.statIndex.has(stat)).map(([stat, value]) => ({ stat: game.statIndex.get(stat)!, value })),
    tactics: tactics.filter((t): t is TacticDef => t !== null),
    speed,
    group: {
      size: groupRaw.size === undefined ? [2, 3] : typeof groupRaw.size === "number" ? [groupRaw.size, groupRaw.size] : reader.range(groupRaw, "size", "group", { allowEqual: true }),
      spread: reader.optionalNumber(groupRaw, "spread", "group", 5, { min: 0 }),
    },
    habitat: variant ? readHabitat(variant, reader, vpath, biomes, speciesHabitat) : speciesHabitat,
    roster: reader.boolean(species, "roster", "", true),
    levelOffset: pick("levelOffset", (obj, path) => reader.number(obj, "levelOffset", path, { integer: true }), 0),
    respawn: species.respawn === undefined ? [240, 360] : reader.range(species, "respawn", "", { allowEqual: true }),
    aggro: pick("aggro", (obj, path) => reader.number(obj, "aggro", path, { min: 0 }), 1),
    flee,
    keepRange: pick("keepRange", (obj, path) => reader.number(obj, "keepRange", path, { min: 0 }), 0),
    wander: reader.optionalNumber(species, "wander", "", 8, { min: 0 }),
    traits: traits.map((t) => t.id),
    template,
  };
}

function readConfig(entry: Entry | undefined, game: GameRules, names: ReadonlyMap<string, number>, issues: ContentIssue[]): CreatureConfig {
  const reader = new Reader(issues, entry?.file ?? "rules/creatures.json5");
  const obj = entry ? reader.object(entry.data, "") : {};
  reader.onlyKeys(obj, "", [
    "rosterSize", "campsPerZone", "spacing", "emptyChance", "campChance", "groups", "maxSlope", "safeRadius", "activeRadius", "releaseRadius",
    "releaseAfter", "corpse", "leash", "stuck", "aggro", "evadeSkill", "levels", "never",
  ]);
  const range = (key: string, fallback: [number, number]): [number, number] =>
    obj[key] === undefined ? fallback : typeof obj[key] === "number" ? [obj[key] as number, obj[key] as number] : reader.range(obj, key, "", { allowEqual: true });
  const groups = obj.groups === undefined ? {} : reader.object(obj.groups, "groups");
  reader.onlyKeys(groups, "groups", ["single", "pair", "group"]);
  const corpse = obj.corpse === undefined ? {} : reader.object(obj.corpse, "corpse");
  reader.onlyKeys(corpse, "corpse", ["time", "emptied"]);
  const levels = obj.levels === undefined ? {} : reader.object(obj.levels, "levels");
  reader.onlyKeys(levels, "levels", ["start", "step", "width", "cap"]);
  const evadeId = obj.evadeSkill === undefined ? "evade" : reader.string(obj, "evadeSkill", "");
  const evadeSkill = game.skillIndex.get(evadeId);
  if (evadeSkill === undefined) reader.fail("evadeSkill", `no skill "${evadeId}": what an evading creature is given (core's is \`evade\`)`);
  const activeRadius = reader.optionalNumber(obj, "activeRadius", "", 140, { min: 1 });
  const releaseRadius = reader.optionalNumber(obj, "releaseRadius", "", 180, { min: 1 });
  if (releaseRadius < activeRadius) reader.fail("releaseRadius", `must be at least activeRadius (${activeRadius})`);
  return {
    rosterSize: range("rosterSize", [3, 5]),
    campsPerZone: range("campsPerZone", [1, 2]),
    spacing: reader.optionalNumber(obj, "spacing", "", 80, { min: 10 }),
    emptyChance: reader.optionalNumber(obj, "emptyChance", "", 0.15, { min: 0, max: 1 }),
    campChance: reader.optionalNumber(obj, "campChance", "", 0.08, { min: 0, max: 1 }),
    groups: {
      single: reader.optionalNumber(groups, "single", "groups", 0.35, { min: 0 }),
      pair: reader.optionalNumber(groups, "pair", "groups", 0.3, { min: 0 }),
      group: reader.optionalNumber(groups, "group", "groups", 0.35, { min: 0 }),
    },
    maxSlope: reader.optionalNumber(obj, "maxSlope", "", 0.7, { min: 0 }),
    safeRadius: reader.optionalNumber(obj, "safeRadius", "", 60, { min: 0 }),
    activeRadius,
    releaseRadius,
    releaseAfter: reader.optionalNumber(obj, "releaseAfter", "", 30, { min: 0 }),
    corpse: { time: reader.optionalNumber(corpse, "time", "corpse", 120, { min: 0 }), emptied: reader.optionalNumber(corpse, "emptied", "corpse", 30, { min: 0 }) },
    leash: reader.optionalNumber(obj, "leash", "", 60, { min: 1 }),
    stuck: reader.optionalNumber(obj, "stuck", "", 4, { min: 0.5 }),
    aggro: compileFormula(obj.aggro ?? { clamp: [{ add: [20, { sub: ["caster.level", "target.level"] }] }, 5, 45] }, "aggro", reader, names),
    evadeSkill: evadeSkill ?? 0,
    levels: {
      start: levels.start === undefined ? [1, 4] : reader.range(levels, "start", "levels", { allowEqual: true }),
      step: reader.optionalNumber(levels, "step", "levels", 3, { min: 0 }),
      width: reader.optionalNumber(levels, "width", "levels", 3, { min: 0 }),
      cap: reader.optionalNumber(levels, "cap", "levels", 60, { min: 1 }),
    },
    never: obj.never === undefined ? [] : reader.stringList(obj, "never", ""),
  };
}

/** A zone's level band for its ring (see CREATURES.md, *Zones*). */
export function levelBand(levels: ZoneLevels, ring: number): [number, number] {
  const lo = Math.min(levels.cap, levels.start[0] + ring * levels.step);
  const hi = Math.min(levels.cap, Math.max(lo, ring === 0 ? levels.start[1] : lo + levels.width));
  return [lo, hi];
}
