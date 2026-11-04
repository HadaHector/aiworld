// The water query (WATER.md): waterAt says the same as the ground does, deterministically, at the
// ocean, a lake or river, dry land and under a bridge, over several seeds.
//   npm run probe -- scripts/probe/water.mjs
import { loadContentFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";
import { WATER_SURFACE } from "../../src/world/water.ts";

let failures = 0, checks = 0;
const check = (what, ok, detail = "") => { checks++; if (!ok) { failures++; console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`); } };
const log = console.log;
const quiet = (run) => { console.log = (...a) => (String(a[0]).startsWith("[") ? undefined : log(...a)); try { return run(); } finally { console.log = log; } };

for (const [config, seed] of [["tiny", 1000], ["small", 475982993], ["small", 8919]]) {
  const { content } = loadContentFromDisk(config);
  const world = quiet(() => createWorldData(seed, content));
  const tag = `${config} ${seed}`;
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
  log(`${tag}: ${wet} wet and ${dry} dry samples, ${deep} deeper than 2 m`);
  // A bridge's ground is wet, its deck is not the ground.
  for (const b of world.bridges) { const m = b.points[Math.floor(b.points.length / 2)]; check(`${tag}: under a bridge is water`, world.waterAt(m.x, m.z).depth > 0, `${m.x},${m.z}`); }
}
log(`${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
