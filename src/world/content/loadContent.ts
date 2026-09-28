import { ContentError, type ContentIssue } from "./contentReader";
import { resolveContent, type PackSource } from "./resolveContent";
import type { WorldContent } from "./worldContent";

interface PackIndex {
  packs: { id: string; files: string[] }[];
}

/**
 * Fetches every content pack in public/packs and resolves them into one WorldContent. The pack
 * list comes from /packs/index.json (see vite.config.ts), so dropping a pack folder in and
 * reloading is all it takes. Throws a ContentError listing every problem found.
 */
export async function loadContent(baseUrl: string = import.meta.env.BASE_URL): Promise<WorldContent> {
  return resolveContent(await fetchPackSources(baseUrl));
}

/**
 * Every content pack's files as text, unresolved - what loadContent resolves, and what the
 * workbench keeps so it can resolve them again with one file's text swapped for an edit. Throws a
 * ContentError if the pack list or any file cannot be fetched.
 */
export async function fetchPackSources(baseUrl: string = import.meta.env.BASE_URL): Promise<PackSource[]> {
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
    index.packs.map(async (pack) => ({
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
