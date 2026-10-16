import JSON5 from "json5";
import { ContentError, Reader, type ContentIssue, type RawObject } from "./contentReader";
import { MAX_WORLD_EXTENT, worldExtentFor } from "../cells/worldLayout";

/**
 * A world config: how big the world is and which content goes into it (see CONFIG.md). It filters
 * what the packs provide - which pack folders load, and whitelists of root kinds, everything they
 * use kept with them - and never defines content of its own.
 */

/** How big the world is - each a [low, high] range rolled per seed. */
export interface WorldShape {
  /** How many zones. */
  areas: [number, number];
  rivers: [number, number];
  /** Cells a river's path walks. */
  riverLength: [number, number];
}

/** Kinds used for their own sake, which a config's `only` may name. Everything else is kept only
 *  when something kept uses it. */
export const ROOT_KINDS = ["dimensions", "biomes", "borderHills", "voices"] as const;
export type RootKind = (typeof ROOT_KINDS)[number];

export interface WorldConfig {
  name: string;
  /** What it sets of the world's size - over every dimension's own (see DIMENSIONS.md). */
  world: Partial<WorldShape>;
  /** Which pack folders load, by id - null for all of them. */
  packs: string[] | null;
  /** Per root kind, the ids to keep; a kind not here is kept whole. */
  only: Partial<Record<RootKind, string[]>>;
}

/** Keys a config's `world` once had, and what became of them (null: gone). */
const RENAMED_SHAPE_KEYS: Record<string, string | null> = { continents: null, areasPerContinent: "areas", riversPerContinent: "rivers" };

/** The full game's world - what a config leaves out of `world` it gets from here. */
export const DEFAULT_WORLD_SHAPE: WorldShape = {
  areas: [20, 30],
  rivers: [3, 5],
  riverLength: [8, 10],
};

/** The config every caller that names none gets: the full game. */
export const DEFAULT_CONFIG: WorldConfig = { name: "default", world: {}, packs: null, only: {} };

/** A config's name: what goes in `?config=` and `--config`, and its file name. */
export const CONFIG_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Reads a `world` block - a config's or a dimension's: the size fields it sets, each checked. */
export function readWorldShape(raw: RawObject, reader: Reader, path: string): Partial<WorldShape> {
  const world: Partial<WorldShape> = {};
  for (const [old, now] of Object.entries(RENAMED_SHAPE_KEYS)) {
    if (raw[old] !== undefined) reader.fail(`${path}.${old}`, now ? `renamed to "${now}"` : "gone: a world is one landmass, more land is another dimension (see DIMENSIONS.md)");
  }
  const keys = Object.keys(DEFAULT_WORLD_SHAPE) as (keyof WorldShape)[];
  reader.onlyKeys(raw, path, [...keys, ...Object.keys(RENAMED_SHAPE_KEYS)]);
  for (const key of keys) {
    if (raw[key] === undefined) continue;
    const range = reader.range(raw, key, path, { allowEqual: true });
    if (range.some((v) => !Number.isInteger(v) || v < (key === "rivers" ? 0 : 1))) {
      reader.fail(`${path}.${key}`, `expected whole numbers of at least ${key === "rivers" ? 0 : 1}, got [${range.join(", ")}]`);
    } else if (key === "areas" && worldExtentFor(range[1]) > MAX_WORLD_EXTENT) {
      reader.fail(`${path}.${key}`, `${range[1]} zones make a world ${(worldExtentFor(range[1]) / 1000).toFixed(0)} km across, wider than the ${MAX_WORLD_EXTENT / 1000} km limit - more land belongs in another dimension (see DIMENSIONS.md)`);
    }
    world[key] = range;
  }
  return world;
}

/** Reads `configs/<name>.json5`. Throws a ContentError listing every problem in it. */
export function readWorldConfig(name: string, text: string): WorldConfig {
  const file = `configs/${name}.json5`;
  const issues: ContentIssue[] = [];
  let data: unknown;
  try {
    data = JSON5.parse(text);
  } catch (error) {
    throw new ContentError([{ file, path: "", message: String((error as Error).message ?? error).replace(/^JSON5: /, "") }]);
  }
  const reader = new Reader(issues, file);
  const obj = reader.object(data, "");
  reader.onlyKeys(obj, "", ["world", "content"]);

  const world = obj.world === undefined ? {} : readWorldShape(reader.object(obj.world, "world"), reader, "world");

  let packs: string[] | null = null;
  const only: Partial<Record<RootKind, string[]>> = {};
  if (obj.content !== undefined) {
    const content = reader.object(obj.content, "content");
    reader.onlyKeys(content, "content", ["packs", "only"]);
    if (content.packs !== undefined) packs = reader.stringList(content, "packs", "content");
    if (content.only !== undefined) {
      const raw = reader.object(content.only, "content.only");
      reader.onlyKeys(raw, "content.only", ROOT_KINDS);
      for (const kind of ROOT_KINDS) {
        if (raw[kind] !== undefined) only[kind] = reader.stringList(raw, kind, "content.only");
      }
    }
  }

  if (issues.length > 0) throw new ContentError(issues);
  return { name, world, packs, only };
}

/** The packs a config loads, in the order given - throwing if it names one that is not there. */
export function selectPacks<T extends { id: string }>(packs: readonly T[], config: WorldConfig): T[] {
  if (config.packs === null) return [...packs];
  const missing = config.packs.filter((id) => !packs.some((pack) => pack.id === id));
  if (missing.length > 0) {
    throw new ContentError([{ file: `configs/${config.name}.json5`, path: "content.packs", message: `no pack ${missing.map((id) => `"${id}"`).join(", ")} (known: ${packs.map((p) => p.id).join(", ")})` }]);
  }
  return packs.filter((pack) => config.packs!.includes(pack.id));
}
