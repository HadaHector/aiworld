import { ContentError, type ContentIssue } from "./contentReader";
import { resolveContent, type PackSource } from "./resolveContent";
import type { WorldContent } from "./worldContent";
import { CONFIG_NAME_PATTERN, DEFAULT_CONFIG, readWorldConfig, selectPacks, type WorldConfig } from "./worldConfig";

interface PackIndex {
  packs: { id: string; files: string[] }[];
}

/**
 * Fetches every content pack in public/packs and resolves them into one WorldContent. The pack
 * list comes from /packs/index.json (see vite.config.ts), so dropping a pack folder in and
 * reloading is all it takes. Throws a ContentError listing every problem found.
 */
export async function loadContent(config?: WorldConfig, baseUrl: string = import.meta.env.BASE_URL): Promise<WorldContent> {
  config ??= await fetchWorldConfig(configNameFromUrl(), baseUrl);
  return resolveContent(await fetchPackSources(baseUrl, config), config);
}

/** The packs a page runs, under its config: fetched once, resolved per dimension as each is entered
 *  (see DIMENSIONS.md). */
export interface PackSet {
  config: WorldConfig;
  /** Which packs, by id. */
  packs: string[];
  /** One dimension's content - the start dimension's if null. Throws a ContentError. */
  resolve: (dimension: string | null) => WorldContent;
  /** The packs' files as fetched - what the game rules are resolved from (see ENTITIES.md). */
  sources: PackSource[];
}

/** Fetches the page's config (from its URL) and every pack it uses. Throws a ContentError. */
export async function loadPackSet(baseUrl: string = import.meta.env.BASE_URL): Promise<PackSet> {
  const config = await fetchWorldConfig(configNameFromUrl(), baseUrl);
  const sources = await fetchPackSources(baseUrl, config);
  return { config, packs: sources.map((pack) => pack.id), resolve: (dimension) => resolveContent(sources, config, dimension), sources };
}

/** The world config the page's URL asks for - `?config=small` - or "default". */
export function configNameFromUrl(): string {
  return new URLSearchParams(location.search).get("config") || DEFAULT_CONFIG.name;
}

/**
 * The world config by name, from public/configs (see CONFIG.md) - "default", the full game, needs
 * no file. Throws a ContentError if it cannot be loaded or has problems.
 */
export async function fetchWorldConfig(name: string, baseUrl: string = import.meta.env.BASE_URL): Promise<WorldConfig> {
  if (name === DEFAULT_CONFIG.name) return DEFAULT_CONFIG;
  const file = `configs/${name}.json5`;
  if (!CONFIG_NAME_PATTERN.test(name)) throw new ContentError([{ file, path: "", message: "a config's name may only use letters, digits, - and _" }]);
  let text: string;
  try {
    const response = await fetch(`${baseUrl}${file}`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    text = await response.text();
    // The dev server answers a missing file with the page itself.
    if (/^\s*</.test(text)) throw new Error("no such file");
  } catch (error) {
    throw new ContentError([{ file, path: "", message: `could not load the config: ${String(error)}` }]);
  }
  return readWorldConfig(name, text);
}

/**
 * Every content pack's files as text, unresolved - what loadContent resolves, and what the
 * workbench keeps so it can resolve them again with one file's text swapped for an edit. Throws a
 * ContentError if the pack list or any file cannot be fetched.
 */
export async function fetchPackSources(baseUrl: string = import.meta.env.BASE_URL, config: WorldConfig = DEFAULT_CONFIG): Promise<PackSource[]> {
  const root = `${baseUrl}packs/`;
  // no-cache: a pack edited while the page was closed must not come back stale from the cache.
  const fetchText = async (url: string): Promise<string> => {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  };

  let index: PackIndex;
  try {
    index = JSON.parse(await fetchText(`${root}index.json`)) as PackIndex;
  } catch (error) {
    throw new ContentError([{ file: "packs/index.json", path: "", message: `could not load the pack list: ${String(error)}` }]);
  }

  const issues: ContentIssue[] = [];
  const packs: PackSource[] = await Promise.all(
    selectPacks(index.packs, config).map(async (pack) => ({
      id: pack.id,
      files: (
        await Promise.all(
          pack.files.map(async (path) => {
            try {
              return { path, text: await fetchText(`${root}${pack.id}/${path}`) };
            } catch (error) {
              issues.push({ file: `${pack.id}/${path}`, path: "", message: `could not load: ${String(error)}` });
              return null;
            }
          }),
        )
      ).filter((file): file is { path: string; text: string } => file !== null),
    })),
  );
  if (issues.length > 0) throw new ContentError(issues);
  if (packs.length === 0) throw new ContentError([{ file: "public/packs", path: "", message: "no content packs found" }]);
  return packs;
}
