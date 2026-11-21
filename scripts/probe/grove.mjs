// The druid grove (SLICE.md W5): how often the vale rolls one, and that its ring of ancient oaks is
// planted through the real tree scatter (the same wrapper the chunk worker, the main thread and the
// server's collision use): a ring of 5-6, evenly round the middle, none of the scatter's own trees
// at their feet, the standing stone at the middle.
//   npm run probe -- scripts/probe/grove.mjs [seeds]
import { loadContentFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";
import { plantedTrees } from "../../src/world/foliage/featureTrees.ts";
import { createTreeScatter, samplerGround } from "../../src/world/foliage/treeScatter.ts";

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
check("the kind exists", content.featureKinds.some((k) => k.id === "druidGrove"));
check("the biome rolls it", content.biomes[0].features.some((f) => f.featureId === "druidGrove"));
check("the tree kind exists", content.treeKinds.some((k) => k.id === "ancientOak"));

const seeds = Number(process.argv[2]) || 8;
let groves = 0;
for (let s = 0; s < seeds; s++) {
  const seed = 1000 + s * 7919;
  const world = quiet(() => createWorldData(seed, content));
  const mine = world.compoundLayouts.filter((l) => l.kindId === "druidGrove");
  groves += mine.length;
  const kinds = world.compoundLayouts.map((l) => l.kindId).join(",");
  log(`seed ${seed}: ${mine.length} grove(s) of ${world.compoundLayouts.length} compounds (${kinds})`);
  for (const layout of mine) {
    const planted = plantedTrees([layout], content.treeKinds);
    check(`seed ${seed}: 5-6 oaks planted`, planted.length >= 5 && planted.length <= 6, String(planted.length));
    const radii = planted.map((t) => Math.hypot(t.x - layout.x, t.z - layout.z));
    log(`  at ${layout.x.toFixed(0)}, ${layout.z.toFixed(0)}: yard ${layout.yard.radius.toFixed(1)} m, ${planted.length} oaks at ${radii.map((r) => r.toFixed(1)).join(", ")} m; props ${layout.props.map((p) => p.prop.id).join(",")}`);
    check(`seed ${seed}: the stone stands at the middle`, layout.props.some((p) => p.prop.generator === "menhir" && Math.hypot(p.x - layout.x, p.z - layout.z) < 2));
    check(`seed ${seed}: no buildings`, layout.buildings.length === 0);
    const half = 70;
    const scatter = createTreeScatter(seed, content, plantedTrees(world.compoundLayouts, content.treeKinds));
    const got = scatter(layout.x - half, layout.z - half, layout.x + half, layout.z + half, samplerGround(world.sampleTerrain));
    const oaks = got.filter((t) => t.kind === "ancientOak");
    check(`seed ${seed}: the scatter returns the ring`, oaks.length === planted.length, `${oaks.length} of ${planted.length}`);
    const crowded = got.filter((t) => t.kind !== "ancientOak" && planted.some((p) => Math.hypot(t.x - p.x, t.z - p.z) < p.clearance));
    check(`seed ${seed}: none of the scatter's trees at the oaks' feet`, crowded.length === 0, String(crowded.length));
    const inside = got.filter((t) => t.kind !== "ancientOak" && Math.hypot(t.x - layout.x, t.z - layout.z) < layout.yard.radius - 1);
    check(`seed ${seed}: the clearing is clear`, inside.length === 0, `${inside.length} trees in it`);
    const sameAgain = scatter(layout.x - half, layout.z - half, layout.x + half, layout.z + half, samplerGround(world.sampleTerrain));
    check(`seed ${seed}: the same every time`, JSON.stringify(sameAgain) === JSON.stringify(got));
  }
}
log(`${groves} grove(s) in ${seeds} seeds`);
if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("ok");
