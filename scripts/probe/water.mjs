// The water query and roads (WATER.md): waterAt says the same as the ground does, deterministically, at the
// ocean, a lake or river, dry land and under a bridge; and no road runs under the water (*Roads*): every
// stretch's points sampled against the ground height, a point below the waterline must be on a bridge's deck.
// Over the tiny and small configs at several seeds (2 each quick, 6 full), plus seed 475982993.
//   npm run probe -- scripts/probe/water.mjs            (quick)
//   npm run probe -- scripts/probe/water.mjs --full     (6 seeds each, and the default world over 2 seeds)
import { pick } from "./mode.mjs";
import { loadContentFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";
import { WATER_SURFACE } from "../../src/world/water.ts";

let failures = 0, checks = 0;
const check = (what, ok, detail = "") => { checks++; if (!ok) { failures++; console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`); } };
const log = console.log;
const quiet = (run) => { console.log = (...a) => (String(a[0]).startsWith("[") ? undefined : log(...a)); try { return run(); } finally { console.log = log; } };

const full = pick(false, true) || process.argv.includes("full");
const cases = [];
for (const config of ["tiny", "small"]) for (let s = 0; s < pick(2, 6); s++) cases.push([config, 1000 + s * 7919]);
cases.push(["small", 475982993], ["tiny", 475982993]);
if (full) cases.push(["default", 475982993], ["default", 1338]);

let roadPoints = 0, roadWorlds = 0;
for (const [config, seed] of cases) {
  const { content } = loadContentFromDisk(config);
  const world = quiet(() => createWorldData(seed, content));
  const tag = `${config} ${seed}`;
  // The water query.
  let wet = 0, dry = 0, deep = 0;
  for (let x = -3000; x <= 3000; x += 97) for (let z = -3000; z <= 3000; z += 89) {
    const h = world.heightAt(x, z), w = world.waterAt(x, z);
    check(`${tag} (${x}, ${z}): surface`, w.surface === WATER_SURFACE);
    check(`${tag} (${x}, ${z}): depth is surface over ground`, Math.abs(w.depth - Math.max(0, WATER_SURFACE - h)) < 1e-9);
    check(`${tag}: same twice`, world.waterAt(x, z).depth === w.depth);
    if (w.depth > 0) wet++; else dry++;
    if (w.depth > 2) deep++;
  }
  check(`${tag}: has dry land`, dry > 0);
  // A bridge's ground is wet, its deck is not the ground.
  for (const b of world.bridges) { const m = b.points[Math.floor(b.points.length / 2)]; check(`${tag}: under a bridge is water`, world.waterAt(m.x, m.z).depth > 0, `${m.x},${m.z}`); }
  // No road under the water (moved here from roadWater.mjs).
  const bad = [];
  for (const stretch of world.roads.stretches) for (const p of stretch.points) {
    roadPoints++;
    if (world.sampleTerrain(p.x, p.z).height >= 0.1) continue;
    if (world.bridges.some((b) => b.points.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 6))) continue;
    bad.push(`(${p.x.toFixed(0)}, ${p.z.toFixed(0)}) ${world.sampleTerrain(p.x, p.z).height.toFixed(2)}`);
  }
  checks++;
  if (bad.length) { failures++; roadWorlds++; log(`FAIL ${tag}: ${bad.length} road points under water ${bad.slice(0, 4).join(" ")}`); }
  log(`${tag}: ${wet} wet and ${dry} dry samples, ${deep} deeper than 2 m; ${world.roads.stretches.length} road stretches, ${world.bridges.length} bridges, ${bad.length} road points under water`);
}
log(`${roadPoints} road points checked; ${roadWorlds} worlds with a road under water`);
log(`${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
