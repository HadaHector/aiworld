import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The headless server's module resolver (see SIMULATION.md). Like the probe's (scripts/probe/
 * tsResolve.mjs) it resolves the source's extensionless imports to their `.ts` files - and it
 * refuses anything the simulation must not reach: Babylon, and the modules that only work in a
 * browser. A stray import of one breaks `npm run server` at once, with the chain that led to it,
 * rather than the split quietly eroding.
 */
const FORBIDDEN_PACKAGES = [/^@babylonjs\//];
const FORBIDDEN_FILES = [
  "src/world/content/loadContent.ts",
  "src/world/terrain/chunkBuildPool.ts",
  "src/world/lighting/lightBakePool.ts",
  "src/world/lighting/lightCache.ts",
  "src/world/materials/textureBakePool.ts",
  "src/world/materials/textureCache.ts",
  "src/world/world.ts",
  "src/main.ts",
];
const FORBIDDEN_DIRS = ["src/player/", "src/core/", "src/ui/", "src/debug/", "src/music/", "src/workbench/"];

function project(url) {
  return fileURLToPath(url).replace(/\\/g, "/").replace(/^.*?\/src\//, "src/");
}

function refuse(what, parentURL) {
  const from = parentURL ? project(parentURL) : "the entry point";
  throw new Error(`The simulation must not import ${what} (imported from ${from}) - see SIMULATION.md`);
}

export async function resolve(specifier, context, next) {
  if (FORBIDDEN_PACKAGES.some((pattern) => pattern.test(specifier))) refuse(specifier, context.parentURL);
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    const url = new URL(specifier + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(url))) specifier = url.href;
  }
  const resolved = await next(specifier, context);
  if (resolved.url.startsWith("file:")) {
    const file = project(resolved.url);
    if (FORBIDDEN_FILES.includes(file) || FORBIDDEN_DIRS.some((dir) => file.startsWith(dir))) refuse(file, context.parentURL);
  }
  return resolved;
}
