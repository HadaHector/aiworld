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
export const IMPLICIT_DIMENSION: DimensionDef = { id: "main", name: "The World", start: true, spawn: { x: 0, z: 0 }, world: {}, biomes: null, links: [] };

/** Passed as the dimension to resolve: no dimension's biome list applies, every biome the config
 *  keeps is resolved - what the workbench wants, to preview any of them. */
export const ALL_DIMENSIONS = "*";

/** FNV-1a over a string's UTF-16 code units: a dimension's id as a number, for its seed. */
function hashString(text: string): number {
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
  reader.onlyKeys(obj, "", ["name", "start", "spawn", "world", "biomes", "links"]);
  const name = reader.optionalString(obj, "name", "") ?? id;
  const start = reader.boolean(obj, "start", "", false);
  const spawn = readPoint(reader, obj, "spawn", "", { x: 0, z: 0 });
  const world = obj.world === undefined ? {} : readWorldShape(reader.object(obj.world, "world"), reader, "world");

  let biomes: DimensionDef["biomes"] = null;
  if (obj.biomes !== undefined) {
    const raw = reader.object(obj.biomes, "biomes");
    reader.onlyKeys(raw, "biomes", ["only", "except"]);
    if (raw.only !== undefined && raw.except !== undefined) reader.fail("biomes", "a whitelist (only) or a blacklist (except), not both");
    else if (raw.only !== undefined) biomes = { only: reader.stringList(raw, "only", "biomes") };
    else if (raw.except !== undefined) biomes = { except: reader.stringList(raw, "except", "biomes") };
    else reader.fail("biomes", "expected only: [...] or except: [...]");
  }

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
  return { id, name, start, spawn, world, biomes, links };
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
    if (!inside(def, def.spawn)) issues.push({ file, path: "spawn", message: `outside the world (${halfWidth(def).toFixed(0)} m from 0 at most)` });
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
