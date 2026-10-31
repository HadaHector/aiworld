import { deriveSeed } from "../rng";
import { worldExtentFor } from "../cells/worldLayout";
import { Reader, type ContentIssue, type RawObject } from "./contentReader";
import { DEFAULT_WORLD_SHAPE, readWorldShape, type WorldShape } from "./worldConfig";

/**
 * A dimension: one whole generated world - a continent, an island chain, later an underworld or a
 * dungeon - with its own seed, size and biomes, centred on its own 0, 0 (see DIMENSIONS.md). Defined
 * in a pack's `dimensions/` folder; a world config picks which ones a run uses.
 */
export interface DimensionDef {
  id: string;
  name: string;
  /** The dimension a player is in when nothing else says. Exactly one kept dimension has it. */
  start: boolean;
  /** Where a player arrives when nothing else says (a debug travel, a first join). */
  spawn: { x: number; z: number };
  /** Its own size - a field left out is the full game's. A config's `world` goes over it. */
  world: Partial<WorldShape>;
  /** Which biomes its zones roll from: only these, all but these, or (null) all of them. */
  biomes: { only: string[] } | { except: string[] } | null;
  links: DimensionLink[];
  /** Entities that stand in it from the moment it loads: a training dummy, later portals and chests
   *  (see ENTITIES.md). Their templates are checked against the game rules by the host. */
  entities: PlacedEntity[];
  /** Where new characters start (NPCS.md, *The starting site*): fixed points, or rules a generated
   *  settlement is chosen by. Empty: one start at `spawn`. */
  starts: StartDef[];
}

/** A place in a starting settlement, named because the layout is generated: its square, the gate
 *  nearest the world's centre, in front of a building's door - or a fixed point. */
export type StartAnchor = { kind: "square" } | { kind: "gate" } | { kind: "building"; building: string } | { kind: "point"; x: number; z: number };

/** Where something stands at a start: an anchor, moved by `offset` (metres, x and z). */
export interface StartSpot {
  at: StartAnchor;
  offset: { x: number; z: number };
}

/** What a rule asks of the settlement a start is chosen as. */
export interface StartRule {
  /** Tiers it may be ("hamlet", "village", "town"); null for any. */
  tiers: string[] | null;
  /** Buildings (by id) it must have one of each of. */
  buildings: string[];
  biomes: { only: string[] } | { except: string[] } | null;
  /** Within this share of the world's half-extent from 0, 0; null for anywhere. */
  centre: number | null;
  /** How the candidates are ranked: weights on nearness to the centre and on the site's own score. */
  prefer: { centre: number; score: number };
}

/** One starting place in a dimension's definition. */
export interface StartDef {
  id: string;
  /** Who starts here, by origin slot: the ids a character's origin in that slot must be among.
   *  Null: everyone. */
  for: Record<string, string[]> | null;
  /** A settlement to choose by, or null for a fixed point. */
  rule: StartRule | null;
  /** Where a new character appears, and what it faces: radians, or toward an anchor. */
  arrive: StartSpot;
  facing: number | StartAnchor;
  /** Its first home: where it comes back when it dies (PROGRESSION.md). */
  home: StartSpot;
  /** What stands there for the start: the dummy, the chest... */
  entities: { template: string; spot: StartSpot; facing: number | StartAnchor }[];
  /** The intro chain's plots, in order (QUESTS.md). Read and kept; nothing uses them yet. */
  intro: string[];
}

/** An entity a dimension's definition places. */
export interface PlacedEntity {
  /** Its template, by id (`entities/<id>.json5`). */
  template: string;
  at: { x: number; z: number };
  /** Radians about y, 0 facing +z - written in degrees in the file. */
  facing: number;
}

/** A way from one dimension to another: a portal, a dock. Data only for now - nothing stands at
 *  `at` yet (see DIMENSIONS.md). */
export interface DimensionLink {
  id: string;
  /** The dimension it leads to. */
  to: string;
  /** Where it stands in its own dimension. */
  at: { x: number; z: number };
  /** Where it comes out in `to`. */
  arrive: { x: number; z: number };
}

/** What a pack set with no `dimensions` folder at all gets: one world with the defaults, so a pack
 *  that only adds biomes still makes one. */
export const IMPLICIT_DIMENSION: DimensionDef = { id: "main", name: "The World", start: true, spawn: { x: 0, z: 0 }, world: {}, biomes: null, links: [], entities: [], starts: [] };

/** Passed as the dimension to resolve: no dimension's biome list applies, every biome the config
 *  keeps is resolved - what the workbench wants, to preview any of them. */
export const ALL_DIMENSIONS = "*";

/** FNV-1a over a string's UTF-16 code units: a dimension's id as a number, for its seed. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A dimension's seed. The start dimension uses the world seed as it is - that is what keeps the
 * world it has always been. Every other one is derived from its id, so it does not change when
 * dimensions are added, dropped or reordered.
 */
export function dimensionSeed(worldSeed: number, dimension: DimensionDef): number {
  return dimension.start ? worldSeed : deriveSeed(worldSeed, hashString(dimension.id));
}

/** The shape a dimension's world is generated with: the full game's, then the dimension's, then
 *  the config's. */
export function dimensionShape(dimension: DimensionDef, configWorld: Partial<WorldShape>): WorldShape {
  return { ...DEFAULT_WORLD_SHAPE, ...dimension.world, ...configWorld };
}

function readPoint(reader: Reader, obj: RawObject, key: string, path: string, fallback?: { x: number; z: number }): { x: number; z: number } {
  if (obj[key] === undefined && fallback) return fallback;
  const at = path ? `${path}.${key}` : key;
  const value = obj[key];
  if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    reader.fail(at, "expected [x, z]");
    return { x: 0, z: 0 };
  }
  return { x: value[0], z: value[1] };
}

/** Reads one `dimensions/<id>.json5`. References to biomes and other dimensions are checked by
 *  `checkDimensions`, once every definition is known. */
export function readDimension(id: string, obj: RawObject, reader: Reader): DimensionDef {
  reader.onlyKeys(obj, "", ["name", "start", "spawn", "world", "biomes", "links", "entities", "starts"]);
  const name = reader.optionalString(obj, "name", "") ?? id;
  const start = reader.boolean(obj, "start", "", false);
  const spawn = readPoint(reader, obj, "spawn", "", { x: 0, z: 0 });
  const world = obj.world === undefined ? {} : readWorldShape(reader.object(obj.world, "world"), reader, "world");
  const biomes = readBiomeList(reader, obj, "biomes", "");

  const links: DimensionLink[] = [];
  reader.optionalArray(obj, "links", "").forEach((value, i) => {
    const path = `links[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["id", "to", "at", "arrive"]);
    links.push({
      id: reader.string(raw, "id", path),
      to: reader.string(raw, "to", path),
      at: readPoint(reader, raw, "at", path),
      arrive: readPoint(reader, raw, "arrive", path),
    });
  });
  const entities: PlacedEntity[] = [];
  reader.optionalArray(obj, "entities", "").forEach((value, i) => {
    const path = `entities[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["template", "at", "facing"]);
    entities.push({
      template: reader.string(raw, "template", path),
      at: readPoint(reader, raw, "at", path),
      facing: (reader.optionalNumber(raw, "facing", path, 0) * Math.PI) / 180,
    });
  });
  const starts = reader.optionalArray(obj, "starts", "").map((value, i) => readStart(reader, reader.object(value, `starts[${i}]`), `starts[${i}]`, spawn));
  if (new Set(starts.map((s) => s.id)).size !== starts.length) reader.fail("starts", "two starts share an id");
  return { id, name, start, spawn, world, biomes, links, entities, starts };
}

/** `only: [...]` or `except: [...]` under `key`, or null when it is left out. */
function readBiomeList(reader: Reader, obj: RawObject, key: string, path: string): DimensionDef["biomes"] {
  if (obj[key] === undefined) return null;
  const at = path ? `${path}.${key}` : key;
  const raw = reader.object(obj[key], at);
  reader.onlyKeys(raw, at, ["only", "except"]);
  if (raw.only !== undefined && raw.except !== undefined) reader.fail(at, "a whitelist (only) or a blacklist (except), not both");
  else if (raw.only !== undefined) return { only: reader.stringList(raw, "only", at) };
  else if (raw.except !== undefined) return { except: reader.stringList(raw, "except", at) };
  else reader.fail(at, "expected only: [...] or except: [...]");
  return null;
}

/** An anchor: "square", "gate", { building: id }, or [x, z]. */
function readAnchor(reader: Reader, raw: RawObject, key: string, path: string): StartAnchor {
  const value = raw[key];
  if (value === "square" || value === "gate") return { kind: value };
  if (Array.isArray(value)) return { kind: "point", ...readPoint(reader, raw, key, path) };
  if (value && typeof value === "object") {
    const at = `${path}.${key}`;
    const building = reader.object(value, at);
    reader.onlyKeys(building, at, ["building"]);
    return { kind: "building", building: reader.string(building, "building", at) };
  }
  reader.fail(`${path}.${key}`, 'expected "square", "gate", { building: id } or [x, z]');
  return { kind: "square" };
}

function readSpot(reader: Reader, raw: RawObject, path: string, fallback: StartAnchor): StartSpot {
  return {
    at: raw.at === undefined ? fallback : readAnchor(reader, raw, "at", path),
    offset: raw.offset === undefined ? { x: 0, z: 0 } : readPoint(reader, raw, "offset", path),
  };
}

/** Degrees, or an anchor to face toward. */
function readFacing(reader: Reader, raw: RawObject, path: string, fallback: number | StartAnchor): number | StartAnchor {
  if (raw.facing === undefined) return fallback;
  if (typeof raw.facing === "number") return (raw.facing * Math.PI) / 180;
  return readAnchor(reader, raw, "facing", path);
}

function readStart(reader: Reader, raw: RawObject, path: string, spawn: { x: number; z: number }): StartDef {
  reader.onlyKeys(raw, path, ["id", "for", "at", "facing", "rule", "arrive", "home", "entities", "intro"]);
  const id = reader.string(raw, "id", path);
  let who: StartDef["for"] = null;
  if (raw.for !== undefined) {
    const list = reader.object(raw.for, `${path}.for`);
    who = Object.fromEntries(Object.keys(list).map((slot) => [slot, reader.stringList(list, slot, `${path}.for`)]));
  }
  let rule: StartRule | null = null;
  if (raw.rule !== undefined) {
    const at = `${path}.rule`;
    const r = reader.object(raw.rule, at);
    reader.onlyKeys(r, at, ["tiers", "buildings", "biomes", "centre", "prefer"]);
    const prefer = r.prefer === undefined ? {} : reader.object(r.prefer, `${at}.prefer`);
    reader.onlyKeys(prefer, `${at}.prefer`, ["centre", "score"]);
    rule = {
      tiers: r.tiers === undefined ? null : reader.stringList(r, "tiers", at),
      buildings: r.buildings === undefined ? [] : reader.stringList(r, "buildings", at),
      biomes: readBiomeList(reader, r, "biomes", at),
      centre: r.centre === undefined ? null : reader.optionalNumber(r, "centre", at, 1, { min: 0, max: 1 }),
      prefer: { centre: reader.optionalNumber(prefer, "centre", `${at}.prefer`, 0.5, { min: 0 }), score: reader.optionalNumber(prefer, "score", `${at}.prefer`, 0.5, { min: 0 }) },
    };
    if (raw.at !== undefined) reader.fail(`${path}.at`, "a start has a fixed point (at) or a rule, not both");
  }
  // A fixed start stands at its point; a settlement's on its square, with its home by the inn.
  const fixed: StartAnchor = rule ? { kind: "square" } : { kind: "point", ...readPoint(reader, raw, "at", path, spawn) };
  const arriveRaw = raw.arrive === undefined ? {} : reader.object(raw.arrive, `${path}.arrive`);
  reader.onlyKeys(arriveRaw, `${path}.arrive`, ["at", "offset", "facing"]);
  const arrive = readSpot(reader, arriveRaw, `${path}.arrive`, fixed);
  const facing = readFacing(reader, arriveRaw, `${path}.arrive`, readFacing(reader, raw, path, rule ? { kind: "gate" } : 0));
  const homeRaw = raw.home === undefined ? {} : reader.object(raw.home, `${path}.home`);
  reader.onlyKeys(homeRaw, `${path}.home`, ["at", "offset"]);
  const home = readSpot(reader, homeRaw, `${path}.home`, rule ? { kind: "building", building: "inn" } : fixed);
  const entities = reader.optionalArray(raw, "entities", path).map((value, i) => {
    const at = `${path}.entities[${i}]`;
    const e = reader.object(value, at);
    reader.onlyKeys(e, at, ["template", "at", "offset", "facing"]);
    return { template: reader.string(e, "template", at), spot: readSpot(reader, e, at, fixed), facing: readFacing(reader, e, at, 0) };
  });
  return { id, for: who, rule, arrive, facing, home, entities, intro: raw.intro === undefined ? [] : reader.stringList(raw, "intro", path) };
}

/**
 * Checks what the dimensions refer to - biomes by id, and each other through their links - and that
 * every point lies inside its world, now that `kept` (the dimensions a config keeps) is known. A
 * link to a dimension that is defined but not kept is no mistake: the caller drops it. Returns the
 * start dimension.
 */
export function checkDimensions(
  kept: readonly { file: string; def: DimensionDef }[],
  definedIds: ReadonlySet<string>,
  biomeIds: ReadonlySet<string>,
  configWorld: Partial<WorldShape>,
  issues: ContentIssue[],
): DimensionDef {
  const byId = new Map(kept.map(({ def }) => [def.id, def]));
  const halfWidth = (def: DimensionDef): number => worldExtentFor(dimensionShape(def, configWorld).areas[1]) / 2;
  const inside = (def: DimensionDef, p: { x: number; z: number }): boolean => Math.max(Math.abs(p.x), Math.abs(p.z)) <= halfWidth(def);
  for (const { file, def } of kept) {
    const list = def.biomes && ("only" in def.biomes ? { key: "only", ids: def.biomes.only } : { key: "except", ids: def.biomes.except });
    list?.ids.forEach((id, i) => {
      if (!biomeIds.has(id)) issues.push({ file, path: `biomes.${list.key}[${i}]`, message: `no biome "${id}" (known: ${[...biomeIds].join(", ")})` });
    });
    def.starts.forEach((s, i) => {
      const biomes = s.rule?.biomes;
      const ids = biomes ? ("only" in biomes ? biomes.only : biomes.except) : [];
      for (const id of ids) if (!biomeIds.has(id)) issues.push({ file, path: `starts[${i}].rule.biomes`, message: `no biome "${id}"` });
    });
    if (!inside(def, def.spawn)) issues.push({ file, path: "spawn", message: `outside the world (${halfWidth(def).toFixed(0)} m from 0 at most)` });
    def.entities.forEach((placed, i) => {
      if (!inside(def, placed.at)) issues.push({ file, path: `entities[${i}].at`, message: `outside the world (${halfWidth(def).toFixed(0)} m from 0 at most)` });
    });
    def.links.forEach((link, i) => {
      const path = `links[${i}]`;
      const target = byId.get(link.to);
      if (!target) {
        if (!definedIds.has(link.to)) issues.push({ file, path: `${path}.to`, message: `no dimension "${link.to}" (known: ${[...definedIds].join(", ")})` });
        return;
      }
      if (!inside(def, link.at)) issues.push({ file, path: `${path}.at`, message: `outside the world (${halfWidth(def).toFixed(0)} m from 0 at most)` });
      if (!inside(target, link.arrive)) issues.push({ file, path: `${path}.arrive`, message: `outside "${target.id}" (${halfWidth(target).toFixed(0)} m from 0 at most)` });
    });
    if (new Set(def.links.map((l) => l.id)).size !== def.links.length) issues.push({ file, path: "links", message: "two links share an id" });
  }
  const starts = kept.filter(({ def }) => def.start);
  if (kept.length === 1) return kept[0].def;
  if (starts.length !== 1) {
    issues.push({ file: starts[1]?.file ?? "(all packs)", path: "start", message: `exactly one dimension must be the start (start: true), found ${starts.length}: ${starts.map(({ def }) => def.id).join(", ") || "none"}` });
    return kept[0]?.def ?? IMPLICIT_DIMENSION;
  }
  return starts[0].def;
}

/** The biomes a dimension's zones roll from, out of `available` (the config's), in their order. A
 *  list that leaves none uses all of `available`: a test config's world is its own anyway. */
export function dimensionBiomes(dimension: DimensionDef, available: readonly string[]): string[] {
  const biomes = dimension.biomes;
  if (!biomes) return [...available];
  const chosen = available.filter((id) => ("only" in biomes ? biomes.only.includes(id) : !biomes.except.includes(id)));
  return chosen.length > 0 ? chosen : [...available];
}
