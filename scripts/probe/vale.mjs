// The autumn vale (SLICE.md, W1 and W9): the `vale` config keeps one dimension, a single autumn
// wood zone of 14 cells, one landmass, with a start village chosen in it, the same every time.
// And its druid groves (SLICE.md W5), on the same worlds: a ring of 5-6 ancient oaks planted through the
// real tree scatter (the wrapper the chunk worker, the main thread and the server's collision use), evenly
// round the middle, none of the scatter's own trees at their feet, the standing stone at the middle.
//   npm run probe -- scripts/probe/vale.mjs [seeds] [map=<folder>]   (map: a relief PNG of each seed)
import { pick } from "./mode.mjs";
import { loadContentFromDisk, loadCreatureRulesFromDisk } from "../diskContent.mjs";
import { createZones } from "../../src/sim/creatures/zones.ts";
import { createWorldData } from "../../src/world/worldData.ts";
import { chooseStarts } from "../../src/world/settlements/starts.ts";
import { planWorld } from "../../src/world/cells/worldLayout.ts";
import { plantedTrees } from "../../src/world/foliage/featureTrees.ts";
import { createTreeScatter, samplerGround } from "../../src/world/foliage/treeScatter.ts";
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const mapDir = process.argv.find((a) => a.startsWith("map="))?.slice(4) ?? "";

/** A relief map: sea dark blue, water above the sea (rivers, lakes) light blue, land by height and
 *  shaded from the north-west; the start red, settlements white, other features yellow. */
function writeMap(path, n, R, STEP, h, water, world, start) {
  const rgba = new Uint8Array(n * n * 4);
  const put = (i, j, [r, g, b]) => {
    if (i < 0 || j < 0 || i >= n || j >= n) return;
    const k = ((n - 1 - j) * n + i) * 4; // +z is north: up
    rgba[k] = r; rgba[k + 1] = g; rgba[k + 2] = b; rgba[k + 3] = 255;
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const c = i * n + j;
    const w = water[c];
    if (w > 0) { put(i, j, w === 2 ? [80, 150, 210] : [25, 55, 105]); continue; }
    const e = h[c];
    const dx = (h[Math.min(n - 1, i + 1) * n + j] - h[Math.max(0, i - 1) * n + j]);
    const dz = (h[i * n + Math.min(n - 1, j + 1)] - h[i * n + Math.max(0, j - 1)]);
    const shade = Math.max(0.35, Math.min(1.3, 1 + (-dx + dz) * 0.04));
    const t = Math.min(1, e / 120);
    const base = [120 + 90 * t, 110 + 50 * t, 60 + 90 * t];
    put(i, j, base.map((v) => Math.min(255, v * shade)));
  }
  const dot = (x, z, colour, r = 3) => {
    const ci = Math.round((x + R) / STEP), cj = Math.round((z + R) / STEP);
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) if (a * a + b * b <= r * r) put(ci + a, cj + b, colour);
  };
  for (const f of world.features ?? []) dot(f.x, f.z, [240, 210, 40], 2);
  for (const s of world.settlements) dot(s.x, s.z, [255, 255, 255], 4);
  dot(start.x, start.z, [230, 30, 30], 4);
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) Buffer.from(rgba.buffer, y * n * 4, n * 4).copy(raw, y * (n * 4 + 1) + 1);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    let crc = ~0;
    for (const b of td) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const c = Buffer.alloc(4);
    c.writeUInt32BE(~crc >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

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

const creatures = loadCreatureRulesFromDisk("vale");
check("levels by cell", content.dimension.creatureLevels === "cells");
check("the grove kind exists", content.featureKinds.some((k) => k.id === "druidGrove"));
check("the biome rolls the grove", content.biomes[0].features.some((f) => f.featureId === "druidGrove"));
check("the ancient oak exists", content.treeKinds.some((k) => k.id === "ancientOak"));
let groves = 0;

/** The druid groves of one world (moved here from grove.mjs). */
function checkGroves(seed, world) {
  const mine = world.compoundLayouts.filter((l) => l.kindId === "druidGrove");
  groves += mine.length;
  for (const layout of mine) {
    const planted = plantedTrees([layout], content.treeKinds);
    check(`seed ${seed}: 5-6 oaks planted`, planted.length >= 5 && planted.length <= 6, String(planted.length));
    check(`seed ${seed}: the stone stands at the middle`, layout.props.some((p) => p.prop.generator === "menhir" && Math.hypot(p.x - layout.x, p.z - layout.z) < 2));
    check(`seed ${seed}: no buildings in the grove`, layout.buildings.length === 0);
    const half = 70;
    const scatter = createTreeScatter(seed, content, plantedTrees(world.compoundLayouts, content.treeKinds));
    const got = scatter(layout.x - half, layout.z - half, layout.x + half, layout.z + half, samplerGround(world.sampleTerrain));
    const oaks = got.filter((t) => t.kind === "ancientOak");
    check(`seed ${seed}: the scatter returns the ring`, oaks.length === planted.length, `${oaks.length} of ${planted.length}`);
    const crowded = got.filter((t) => t.kind !== "ancientOak" && planted.some((p) => Math.hypot(t.x - p.x, t.z - p.z) < p.clearance));
    check(`seed ${seed}: none of the scatter's trees at the oaks' feet`, crowded.length === 0, String(crowded.length));
    const inside = got.filter((t) => t.kind !== "ancientOak" && Math.hypot(t.x - layout.x, t.z - layout.z) < layout.yard.radius - 1);
    check(`seed ${seed}: the grove's clearing is clear`, inside.length === 0, `${inside.length} trees in it`);
    const sameAgain = scatter(layout.x - half, layout.z - half, layout.x + half, layout.z + half, samplerGround(world.sampleTerrain));
    check(`seed ${seed}: the grove's trees the same every time`, JSON.stringify(sameAgain) === JSON.stringify(got));
  }
  return mine.length;
}

// 3 seeds give 5 groves (1000, 8919, 16838); the full 8 give 11.
const seeds = Number(process.argv[2]) || pick(3, 8);
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
  const R = 2200;
  const n = (2 * R) / STEP + 1;
  const dry = new Uint8Array(n * n);
  const h = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) h[i * n + j] = world.heightAt(-R + i * STEP, -R + j * STEP);
  const water = new Uint8Array(n * n); // 0 none, 1 the sea, 2 water above it
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const w = world.waterAt(-R + i * STEP, -R + j * STEP);
    const k = i * n + j;
    water[k] = w.depth > 0.3 ? (w.surface > 0.5 ? 2 : 1) : 0;
    dry[k] = h[k] > 0.5 && water[k] === 0 ? 1 : 0;
  }
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
  if (mapDir) writeMap(`${mapDir}/vale-${seed}.png`, n, R, STEP, h, water, world, from);
  const dryTotal = dry.reduce((x, y) => x + y, 0);
  const lost = world.settlements.filter((st) => !seen[Math.round((st.x + R) / STEP) * n + Math.round((st.z + R) / STEP)]);
  // Informational: the fill ignores bridges, so a river (W11) cuts the land in two here and the
  // roads' bridges join it again. A start on a small piece is what to look for.
  if (lost.length > 0) log(`  note: not walkable from the start without a bridge: ${lost.map((l) => l.name).join(", ")}`);
  check(`seed ${seed}: the start is on a piece of land of at least 0.2 km2`, reached * STEP * STEP >= 0.2e6, `${(reached * STEP * STEP / 1e6).toFixed(2)} km2`);
  log(`  walkable ${(reached * STEP * STEP / 1e6).toFixed(2)} of ${(dryTotal * STEP * STEP / 1e6).toFixed(2)} km2 dry`);
  // Levels by cell (B2): level 1 by the start, rising with distance, 9-10 at the far side.
  const zones = createZones(world, creatures, starts[0], "cells");
  const bands = [...world.landCellSites].sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z)).map((c) => zones[0].levelsAt(c.x, c.z));
  check(`seed ${seed}: level 1 at the start`, zones[0].levelsAt(from.x, from.z)[0] === 1, JSON.stringify(zones[0].levelsAt(from.x, from.z)));
  check(`seed ${seed}: levels rise with distance`, bands.every((b, i) => i === 0 || b[0] >= bands[i - 1][0]));
  check(`seed ${seed}: the far side reaches level 9`, bands[bands.length - 1][1] >= 9, JSON.stringify(bands.at(-1)));
  log(`  cell levels by distance: ${bands.map((b) => b.join("-")).join(" ")}; zone ${zones[0].levels.join("-")}`);
  const groveCount = checkGroves(seed, world);
  const sites = world.settlements.length;
  const features = {};
  for (const f of world.features ?? []) features[f.kind ?? f.type ?? "?"] = (features[f.kind ?? f.type ?? "?"] ?? 0) + 1;
  log(`seed ${seed}: land cells ${world.landCellSites.length}, settlements ${sites}, ${groveCount} grove(s), start ${starts[0] ? `(${Math.round(starts[0].x ?? starts[0].at?.x)}, ${Math.round(starts[0].z ?? starts[0].at?.z)})` : "none"}, extent ${Math.round(layout.worldExtent)} m, ${Math.round(performance.now() - t)} ms${warnings.length ? `, warnings: ${warnings.join("; ")}` : ""}`);
}
check("the seeds have a druid grove", groves > 0, `${groves} in ${seeds} seeds`);
log(`${groves} grove(s) in ${seeds} seeds`);
log(failures ? `${failures} failure(s)` : "ok");
process.exit(failures ? 1 : 0);
