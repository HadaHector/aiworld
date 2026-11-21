// The abandoned camp (SLICE.md W3): the content is there and wired (the feature, its biome odds, its
// quest tags, its buildings and props), it lays out over many seeds with its two required buildings,
// and its roofs are really rotted - holes, a deeper sag, a fallen-in place - while a sound roof is not.
// npm run probe -- scripts/probe/abandonedCamp.mjs
const { loadContent } = await import("./loadContent.mjs");
const { buildFeaturePreview } = await import("../../src/workbench/featurePreview.ts");
const { generateBuilding } = await import("../../src/world/buildings/buildingGenerator.ts");
const content = loadContent();
let checks = 0, fails = 0;
const check = (ok, msg) => { checks++; if (!ok) { fails++; console.log("  FAIL", msg); } };

// Content and wiring.
const kind = content.featureKinds.find((k) => k.id === "abandonedCamp");
check(!!kind?.compound, "abandonedCamp is a compound feature kind");
const wood = content.biomes.find((b) => b.id === "autumnWood");
check(!!wood?.features.some((f) => f.featureId === "abandonedCamp" && f.odds > 0), "the autumn wood rolls it");
for (const tag of ["abandoned", "ruin", "mystery", "remote", "wood"]) check(!!kind?.quest?.tags.includes(tag), `quest tag ${tag}`);
check((kind?.quest?.objects.length ?? 0) >= 3, "quest objects to find");
const ids = (kind?.compound?.buildings ?? []).map((b) => b.building.id);
for (const id of ["bunkhouseAbandoned", "sawShedAbandoned"]) check(ids.includes(id), `it builds a ${id}`);
check((kind?.compound?.buildings ?? []).filter((b) => b.required).length === 2, "the bunkhouse and the saw shed are required");

// Layouts over seeds and variants.
let placed = 0, bunk = 0, shed = 0, props = 0, droppedRequired = 0;
for (const seed of [1338, 77, 4242, 9001, 31337]) {
  for (let variant = 0; variant < 6; variant++) {
    const f = buildFeaturePreview(kind, content, seed, variant, false, () => 30);
    check(!!f, `seed ${seed} variant ${variant} laid out`);
    if (!f) continue;
    placed++;
    const have = f.layout.buildings.map((b) => b.building.id);
    if (have.includes("bunkhouseAbandoned")) bunk++;
    if (have.includes("sawShedAbandoned")) shed++;
    droppedRequired += f.layout.droppedRequired;
    props += f.layout.props.length;
  }
}
check(bunk === placed && shed === placed, `every layout has its bunkhouse and saw shed (${bunk}/${shed} of ${placed})`);
check(droppedRequired === 0, "no required building dropped");
check(props / placed >= 8, `about ${(props / placed).toFixed(1)} props a camp`);

// The roofs: rotted ones are open and sunk, sound ones are not, and the same building is the same.
const def = (id) => content.buildings.find((b) => b.id === id);
const tris = (m) => m.indices.length / 3;
let soundTris = 0, rottedTris = 0;
for (let seed = 1; seed <= 12; seed++) {
  const sound = generateBuilding(def("bunkhouse"), seed, 0);
  const rotted = generateBuilding(def("bunkhouseAbandoned"), seed, 0);
  const again = generateBuilding(def("bunkhouseAbandoned"), seed, 0);
  check(tris(rotted) === tris(again) && rotted.height === again.height, `seed ${seed}: rotted bunkhouse is repeatable`);
  soundTris += tris(sound);
  rottedTris += tris(rotted);
}
// Holes take cells of covering and boards out: fewer triangles than a sound roof's.
check(rottedTris < soundTris && rottedTris > soundTris * 0.5, `rotted roofs are open (${rottedTris} triangles against ${soundTris} sound)`);
console.log(`abandonedCamp: ${checks - fails}/${checks} checks; ${placed} layouts, ${(props / Math.max(1, placed)).toFixed(1)} props each`);
process.exit(fails ? 1 : 0);
