import { resolve } from "node:path";
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

export default defineConfig({
  plugins: [packIndex()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
