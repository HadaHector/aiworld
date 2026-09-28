import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { buildPackIndex } from "./scripts/packIndex.mjs";

const PACKS_DIR = fileURLToPath(new URL("./public/packs", import.meta.url));

/**
 * Serves /packs/index.json - the list of content packs and their files - fresh on every request
 * in dev, and writes it into the build. Editing, adding or removing a pack file reloads the page,
 * since the game only reads the packs once, at start.
 */
function packIndex(): Plugin {
  return {
    name: "aiworld-pack-index",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/packs/index.json") return next();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(buildPackIndex(PACKS_DIR)));
      });
      server.watcher.add(PACKS_DIR);
      const reload = (file: string): void => {
        if (resolve(file).startsWith(PACKS_DIR)) server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("change", reload);
      server.watcher.on("add", reload);
      server.watcher.on("unlink", reload);
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "packs/index.json", source: JSON.stringify(buildPackIndex(PACKS_DIR)) });
    },
  };
}

/** Everything a baked texture's pixels depend on besides its definition and seed. */
function textureCodeFiles(): string[] {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const pipelineDir = resolve(root, "src/world/terrain/pipeline");
  return [
    "src/world/materials/textureGen.ts",
    "src/world/materials/textureBake.worker.ts",
    "src/world/terrain/noise.ts",
    "src/world/rng.ts",
    ...readdirSync(pipelineDir).filter((name) => name.endsWith(".ts")).map((name) => `src/world/terrain/pipeline/${name}`),
    // The simplex noise itself; its version is what matters.
    "node_modules/simplex-noise/package.json",
  ].map((file) => resolve(root, file));
}

/**
 * `virtual:texture-code-hash` - a hash of the code that bakes textures, so the texture cache
 * (src/world/materials/textureCache.ts) bakes again after that code changes. Worked out here rather
 * than in the page so the bundle carries a hash, not the sources; in dev every file is watched,
 * so an edit to one reloads the page with the new hash.
 */
function textureCodeHash(): Plugin {
  const id = "virtual:texture-code-hash";
  const resolvedId = `\0${id}`;
  const root = fileURLToPath(new URL(".", import.meta.url));
  return {
    name: "aiworld-texture-code-hash",
    resolveId(source) {
      return source === id ? resolvedId : undefined;
    },
    load(loadId) {
      if (loadId !== resolvedId) return undefined;
      const hash = createHash("sha256");
      for (const file of textureCodeFiles()) {
        this.addWatchFile(file);
        hash.update(relative(root, file).replaceAll("\\", "/"));
        // Line endings normalised, so a checkout's autocrlf does not count as a change.
        hash.update(readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
      }
      return `export default ${JSON.stringify(hash.digest("hex").slice(0, 16))};`;
    },
  };
}

export default defineConfig({
  plugins: [packIndex(), textureCodeHash()],
  // Two pages: the game, and the workbench (workbench.html) for looking at one pack asset at a time.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        workbench: fileURLToPath(new URL("./workbench.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
