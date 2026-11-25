// Why cells are empty (FEATURES.md, *Why a cell is empty*): builds worlds for many seeds and totals, per
// kind, how often it was rolled and placed and which condition stopped its candidates.
//   npm run probe -- scripts/tools/cellwhy.mjs [config=vale|default] [seeds=20] [first=1000]
// "Stopped" counts candidates (a roadside kind: points along the road) stopped at that condition; "cells" counts
// cells whose most-stopping condition it was.
import { loadContentFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";
import { describeCheck, mainReason } from "../../src/world/features/placementWhy.ts";

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const config = arg("config", "vale");
const seeds = Number(arg("seeds", 20));
const first = Number(arg("first", 1000));
const log = console.log;
const quiet = (run) => {
  console.log = (...a) => (String(a[0]).startsWith("[") ? undefined : log(...a));
  try { return run(); } finally { console.log = log; }
};

const { content } = loadContentFromDisk(config);
const kinds = new Map();
const kind = (id) => {
  let k = kinds.get(id);
  if (!k) kinds.set(id, (k = { rolled: 0, placed: 0, seedsWith: 0, dropped: 0, noRoad: 0, cells: new Map(), stopped: new Map(), measured: new Map(), main: new Map() }));
  return k;
};
/** The median of the nearest-to-passing value of the cells whose main reason it was, and the range it needed. */
const typical = (list) => {
  if (!list?.length) return "";
  const values = list.map((c) => c.value).sort((a, b) => a - b);
  const c = list[0];
  const f = (v) => (Number.isFinite(v) ? +v.toFixed(2) : v > 0 ? "inf" : "-inf");
  return `; nearest candidate median ${f(values[values.length >> 1])} (needs ${f(c.lo)}..${f(c.hi)})`;
};
let cells = 0;
let none = 0;
let t = performance.now();
for (let s = 0; s < seeds; s++) {
  const seed = first + s * 7919;
  const world = quiet(() => createWorldData(seed, content));
  const placedHere = new Set(world.cellPlacements.filter((p) => p.placed).map((p) => p.rolled));
  for (const id of placedHere) kind(id).seedsWith++;
  for (const p of world.cellPlacements) {
    cells++;
    if (p.rolled === "none") { none++; continue; }
    const k = kind(p.rolled);
    k.rolled++;
    if (p.placed) { k.placed++; continue; }
    if (p.note.startsWith("placed, then dropped")) k.dropped++;
    if (p.note === "no road through the cell") k.noRoad++;
    const main = mainReason(p);
    const name = main ? main.name : p.note || "(nothing tried)";
    if (main) { const m = k.main.get(name) ?? []; m.push(main); k.main.set(name, m); }
    k.cells.set(name, (k.cells.get(name) ?? 0) + 1);
    for (const c of p.checks) {
      if (c.failed === 0) continue;
      k.stopped.set(c.name, (k.stopped.get(c.name) ?? 0) + c.failed);
      const m = k.measured.get(c.name) ?? [];
      m.push(describeCheck(c));
      k.measured.set(c.name, m);
    }
  }
}
log(`${config}: ${seeds} seeds, ${cells} land cells, ${none} rolled none (${((none / cells) * 100).toFixed(0)}%), ${Math.round(performance.now() - t)} ms`);
let empty = 0;
for (const [id, k] of [...kinds].sort((a, b) => b[1].rolled - a[1].rolled)) {
  empty += k.rolled - k.placed;
  log(`\n${id}: rolled ${k.rolled}, placed ${k.placed} (${((k.placed / k.rolled) * 100).toFixed(0)}%), failed ${k.rolled - k.placed}, present in ${k.seedsWith} of ${seeds} seeds${k.dropped ? ` (${k.dropped} dropped for want of a road)` : ""}${k.noRoad ? ` (${k.noRoad} with no road through the cell)` : ""}`);
  const total = [...k.stopped.values()].reduce((a, b) => a + b, 0) || 1;
  const rows = [...k.stopped].sort((a, b) => b[1] - a[1]);
  for (const [name, n] of rows) log(`    stops ${name}: ${n} candidates (${((n / total) * 100).toFixed(0)}%), main reason of ${k.cells.get(name) ?? 0} cells${typical(k.main.get(name))}`);
  for (const [name, n] of k.cells) if (!k.stopped.has(name)) log(`    main reason ${name}: ${n} cells`);
}
log(`\nempty cells: ${none} rolled none + ${empty} rolled a kind that did not place = ${none + empty} of ${cells} (${(((none + empty) / cells) * 100).toFixed(0)}%)`);
