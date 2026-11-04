// Roads and water (WATER.md, *Roads*): no road runs under the water. Samples every stretch's points
// against the ground height; a point below the waterline must be on a bridge's deck.
//   npm run probe -- scripts/probe/roadWater.mjs            (tiny and small over 6 seeds each, plus 475982993 small)
//   npm run probe -- scripts/probe/roadWater.mjs full       (and the full world over 2 seeds)
import { loadContentFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";

const log = console.log;
const quiet = (run) => {
  console.log = (...args) => (String(args[0]).startsWith("[") ? undefined : log(...args));
  try { return run(); } finally { console.log = log; }
};
const cases = [];
for (const config of ["tiny", "small"]) for (let s = 0; s < 6; s++) cases.push([config, 1000 + s * 7919]);
cases.push(["small", 475982993], ["tiny", 475982993]);
if (process.argv.includes("full")) cases.push(["default", 475982993], ["default", 1338]);

let failures = 0, points = 0;
for (const [config, seed] of cases) {
  const { content } = loadContentFromDisk(config);
  const world = quiet(() => createWorldData(seed, content));
  const bad = [];
  for (const stretch of world.roads.stretches) {
    for (let i = 0; i < stretch.points.length; i++) {
      const p = stretch.points[i];
      points++;
      const t = world.sampleTerrain(p.x, p.z);
      if (t.height >= 0.1) continue;
      if (world.bridges.some((b) => b.points.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 6))) continue;
      bad.push(`(${p.x.toFixed(0)}, ${p.z.toFixed(0)}) ${t.height.toFixed(2)}`);
    }
  }
  if (bad.length > 0) failures++;
  log(`${bad.length ? "FAIL" : "ok  "} ${config} seed ${seed}: ${world.roads.stretches.length} stretches, ${world.bridges.length} bridges, ${bad.length} points under water ${bad.slice(0, 4).join(" ")}`);
}
log(`${points} road points checked; ${failures} worlds with a road under water`);
process.exit(failures > 0 ? 1 : 0);
