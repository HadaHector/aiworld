// The autumn vale (SLICE.md, W1 and W9): the `vale` config keeps one dimension, a single autumn
// wood zone of 14 cells, one landmass, with a start village chosen in it, the same every time.
//   npm run probe -- scripts/probe/vale.mjs [seeds]
import { loadContentFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";
import { chooseStarts } from "../../src/world/settlements/starts.ts";
import { planWorld } from "../../src/world/cells/worldLayout.ts";

let failures = 0;
function check(what, ok, detail = "") {
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
}
const log = console.log;
const quiet = (run) => {
  console.log = (...a) => (String(a[0]).startsWith("[") ? undefined : log(...a));
  try { return run(); } finally { console.log = log; }
};

const { content } = loadContentFromDisk("vale");
check("the vale is the start dimension", content.dimension.id === "autumnVale", content.dimension.id);
check("only autumnWood", content.biomes.length === 1 && content.biomes[0].id === "autumnWood", content.biomes.map((b) => b.id).join());
check("14 cells a zone", content.world.cellsPerArea === 14 && content.world.areas[1] === 1);
const full = loadContentFromDisk("default").content;
check("the full world keeps 10 cells a zone", full.world.cellsPerArea === 10);

const seeds = Number(process.argv[2]) || 6;
for (let s = 0; s < seeds; s++) {
  const seed = 1000 + s * 7919;
  const layout = planWorld(seed, content.world);
  check(`seed ${seed}: one zone, 14 cells`, layout.areaCount === 1 && layout.cellCount === 14, JSON.stringify(layout));
  const t = performance.now();
  const world = quiet(() => createWorldData(seed, content));
  const warnings = [];
  const starts = chooseStarts(world, content.dimension, (m) => warnings.push(m));
  const again = chooseStarts(world, content.dimension);
  check(`seed ${seed}: one start, stable`, starts.length === 1 && JSON.stringify(starts) === JSON.stringify(again));
  // One walkable piece of land: from the start, over ground above the water and not steeper than
  // a climbable slope, 10 m steps, reaching every settlement (BACKLOG: cells cut off by cliffs).
  const STEP = 10;
  const R = 1800;
  const n = (2 * R) / STEP + 1;
  const dry = new Uint8Array(n * n);
  const h = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) h[i * n + j] = world.heightAt(-R + i * STEP, -R + j * STEP);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) dry[i * n + j] = h[i * n + j] > 0.5 && world.waterAt(-R + i * STEP, -R + j * STEP).depth <= 0.3 ? 1 : 0;
  const seen = new Uint8Array(n * n);
  const from = starts[0];
  const si = Math.round((from.x + R) / STEP), sj = Math.round((from.z + R) / STEP);
  const stack = [si * n + sj];
  seen[si * n + sj] = 1;
  let reached = 0;
  while (stack.length) {
    const c = stack.pop();
    reached++;
    const i = (c / n) | 0, j = c % n;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      const k = a * n + b;
      if (seen[k] || !dry[k] || Math.abs(h[k] - h[c]) > STEP * 1.4) continue;
      seen[k] = 1;
      stack.push(k);
    }
  }
  const dryTotal = dry.reduce((x, y) => x + y, 0);
  const lost = world.settlements.filter((st) => !seen[Math.round((st.x + R) / STEP) * n + Math.round((st.z + R) / STEP)]);
  // Informational: the fill ignores bridges, so a river (W11) cuts the land in two here and the
  // roads' bridges join it again. A start on a small piece is what to look for.
  if (lost.length > 0) log(`  note: not walkable from the start without a bridge: ${lost.map((l) => l.name).join(", ")}`);
  check(`seed ${seed}: the start is on a piece of land of at least 0.2 km2`, reached * STEP * STEP >= 0.2e6, `${(reached * STEP * STEP / 1e6).toFixed(2)} km2`);
  log(`  walkable ${(reached * STEP * STEP / 1e6).toFixed(2)} of ${(dryTotal * STEP * STEP / 1e6).toFixed(2)} km2 dry`);
  const sites = world.settlements.length;
  const features = {};
  for (const f of world.features ?? []) features[f.kind ?? f.type ?? "?"] = (features[f.kind ?? f.type ?? "?"] ?? 0) + 1;
  log(`seed ${seed}: land cells ${world.areas?.landCellSites?.length ?? "?"}, settlements ${sites}, start ${starts[0] ? `(${Math.round(starts[0].x ?? starts[0].at?.x)}, ${Math.round(starts[0].z ?? starts[0].at?.z)})` : "none"}, extent ${Math.round(layout.worldExtent)} m, ${Math.round(performance.now() - t)} ms${warnings.length ? `, warnings: ${warnings.join("; ")}` : ""}`);
}
log(failures ? `${failures} failure(s)` : "ok");
process.exit(failures ? 1 : 0);
