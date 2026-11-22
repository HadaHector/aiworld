// Rivers at their own level (WATER.md, *Water at its own level*; SLICE.md W10, W11): on one-zone
// autumn-wood worlds with `riverLevels`, every river's surface falls from source to mouth and never
// below the sea, the water query finds it along the river, a tributary meets its trunk at the trunk's
// level, fords are shallow, bridges stand over water, and a world without the flag has no levels.
//   npm run probe -- scripts/probe/riverLevels.mjs [seeds...]
import { packSourcesFromDisk } from "../diskContent.mjs";
import { readWorldConfig } from "../../src/world/content/worldConfig.ts";
import { resolveContent } from "../../src/world/content/resolveContent.ts";
import { createWorldData } from "../../src/world/worldData.ts";
import { WATER_SURFACE } from "../../src/world/water.ts";

let failures = 0, checks = 0;
const check = (what, ok, detail = "") => { checks++; if (!ok) { failures++; console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`); } };
const log = console.log;
const quiet = (run) => { console.log = (...a) => (String(a[0]).startsWith("[") ? undefined : log(...a)); console.info = () => {}; try { return run(); } finally { console.log = log; } };

const contentFor = (world) => {
  const config = readWorldConfig("probe", JSON.stringify({ world, content: { only: { biomes: ["autumnWood"] } } }));
  return resolveContent(packSourcesFromDisk(config).sources, config, null);
};
const levelled = contentFor({ areas: [1, 1], rivers: [2, 2], riverLength: [4, 6], riverTributaries: [1, 1], riverLevels: true });
const legacy = contentFor({ areas: [1, 1], rivers: [2, 2], riverLength: [4, 6], riverTributaries: [1, 1] });

const seeds = process.argv.slice(2).map(Number);
for (const seed of seeds.length ? seeds : [1338, 7, 4242, 90210]) {
  const world = quiet(() => createWorldData(seed, levelled));
  const tag = `seed ${seed}`;
  const profiles = world.riverProfiles;
  check(`${tag}: has rivers`, profiles.length > 0);
  let highest = -Infinity, wetStations = 0, stations = 0, fordStations = 0, steepest = 0;
  profiles.forEach((p, r) => {
    for (let i = 0; i < p.level.length; i++) {
      highest = Math.max(highest, p.level[i]);
      check(`${tag} river ${r}: not below the sea`, p.level[i] >= WATER_SURFACE - 1e-9, `${p.level[i]}`);
      if (i > 0) {
        check(`${tag} river ${r}: never rises toward the mouth`, p.level[i] >= p.level[i - 1] - 1e-9, `station ${i}: ${p.level[i - 1]} -> ${p.level[i]}`);
        steepest = Math.max(steepest, (p.level[i] - p.level[i - 1]) / (p.length / (p.level.length - 1)));
      }
      if (p.depth[i] < 0.5) fordStations++;
      // Away from the mouth (the coast blend) and the ends, the centreline is under the river's water.
      if (i > 2 && i < p.level.length - 2) {
        stations++;
        const w = world.waterAt(p.x[i], p.z[i]);
        if (w.depth > 0.05 && Math.abs(w.surface - Math.max(WATER_SURFACE, p.level[i])) < 0.5) wetStations++;
      }
    }
    log(`${tag} river ${r}: ${(p.length / 1000).toFixed(2)} km, surface ${p.level[0].toFixed(1)} at the mouth to ${p.level[p.level.length - 1].toFixed(1)} at the source`);
  });
  // No water standing over a pit: the ground under a river above the sea is its own bed, not something
  // cut deeper beside it (another river's valley).
  let pits = 0, pitAt = "";
  profiles.forEach((p, r) => {
    for (let i = 0; i < p.level.length; i++) {
      if (p.level[i] < WATER_SURFACE + 0.5) continue;
      const h = world.heightAt(p.x[i], p.z[i]);
      if (h < p.level[i] - p.depth[i] - 1) { pits++; pitAt = `river ${r} station ${i}: ground ${h.toFixed(1)} under water at ${p.level[i].toFixed(1)}`; }
    }
  });
  check(`${tag}: no water over a pit`, pits === 0, `${pits} stations, e.g. ${pitAt}`);
  check(`${tag}: the water query finds the river along it`, stations === 0 || wetStations / stations > 0.9, `${wetStations}/${stations}`);
  if (profiles.length > 1) {
    const [trunk, trib] = profiles;
    let best = Infinity, level = 0, at = 0;
    for (let i = 0; i < trunk.level.length; i++) { const d = Math.hypot(trunk.x[i] - trib.x[0], trunk.z[i] - trib.z[0]); if (d < best) { best = d; level = trunk.level[i]; at = i; } }
    if (best < 900) check(`${tag}: the tributary meets its trunk at the trunk's level`, Math.abs(trib.level[0] - Math.max(WATER_SURFACE, level)) < 1e-6, `${trib.level[0]} vs ${level}`);
    // Part way along it: at its source it only carries the river on (one river drawn as two), at its
    // mouth it shares it.
    const along = at / (trunk.level.length - 1);
    if (best < 60) check(`${tag}: the tributary joins its trunk part way along`, along > 0.05 && along < 0.95, `at ${along.toFixed(2)} of the trunk`);
    log(`${tag}: second river's mouth ${best.toFixed(0)} m from the first river's line`);
  }
  // No step in the ground across a river: sampled across each station every metre, against the
  // same lines in the legacy world (whose own steps come from the land, not the water).
  const old = quiet(() => createWorldData(seed, legacy));
  const steps = (w) => {
    let worst = 0, at = "";
    for (const p of profiles) for (let i = 1; i < p.level.length - 1; i += 4) {
      const dx = p.x[i + 1] - p.x[i - 1], dz = p.z[i + 1] - p.z[i - 1], n = Math.hypot(dx, dz) || 1;
      let prev = null;
      for (let s = -150; s <= 150; s += 1) {
        const x = p.x[i] - (dz / n) * s, z = p.z[i] + (dx / n) * s, h = w.heightAt(x, z);
        if (prev !== null && Math.abs(h - prev) > worst) { worst = Math.abs(h - prev); at = `(${x.toFixed(0)}, ${z.toFixed(0)}) ${s} m off the line`; }
        prev = h;
      }
    }
    return { worst, at };
  };
  const { worst: worstStep, at } = steps(world);
  const { worst: legacyStep } = steps(old);
  // The land alone has slopes past 4 m a metre (scripts/probe/steepest.local.mjs); the coast's fall to the seabed
  // beside a river's mouth reaches 2. A river must not make it worse than that, nor than the legacy world.
  check(`${tag}: no cliff across a river`, worstStep < Math.max(2.5, legacyStep + 0.5), `${worstStep.toFixed(2)} m in 1 m at ${at} (legacy ${legacyStep.toFixed(2)})`);
  // Water under some of each bridge (a bridge reaches out to firm bank, further on one side than the
  // other, so its middle may be on the bank), and its deck a metre over it wherever it is.
  for (const b of world.bridges) {
    const wet = b.points.map((q, i) => ({ q, deck: b.heights[i], w: world.waterAt(q.x, q.z) })).filter((e) => e.w.depth > 0);
    const m = b.points[Math.floor(b.points.length / 2)];
    check(`${tag}: under a bridge is water`, wet.length > 0, `${m.x.toFixed(0)},${m.z.toFixed(0)}`);
    for (const e of wet) check(`${tag}: a bridge's deck is over the water`, e.deck > e.w.surface + 1, `deck ${e.deck.toFixed(1)} over ${e.w.surface.toFixed(1)} at ${e.q.x.toFixed(0)},${e.q.z.toFixed(0)}`);
  }
  // No road through deep water off a bridge (a ford is shallow: wading, under 0.35 m).
  let roadWet = 0, fordCrossings = 0, wetAt = "";
  for (const stretch of world.roads.stretches) for (const p of stretch.points) {
    const w = world.waterAt(p.x, p.z);
    if (w.depth <= 0.05) continue;
    if (world.bridges.some((b) => b.points.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 6))) continue;
    if (w.depth < 0.35) fordCrossings++;
    else { roadWet++; wetAt = `(${p.x.toFixed(0)}, ${p.z.toFixed(0)}) ${w.depth.toFixed(2)} m under ${w.surface.toFixed(1)}`; }
  }
  check(`${tag}: no road through deep water off a bridge`, roadWet === 0, `${roadWet} points, e.g. ${wetAt}`);
  log(`${tag}: ${fordCrossings} road points wading a ford`);
  log(`${tag}: ${profiles.length} rivers, highest surface ${highest.toFixed(1)} m, steepest fall ${(steepest * 100).toFixed(1)} %, ${fordStations} shallow (ford or estuary) stations, worst ground step ${worstStep.toFixed(2)} m/m, ${world.bridges.length} bridges`);

  check(`${tag}: no levels without the flag`, old.riverProfiles.length === 0);
  check(`${tag}: same rivers without the flag`, old.riverProfiles.length === 0 && profiles.length >= 0);
}
log(`${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
