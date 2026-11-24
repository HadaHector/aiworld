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
// No geometric holes: the missing shingles are the texture's, so a rotted roof is as many triangles as a sound one.
check(Math.abs(rottedTris - soundTris) < soundTris * 0.25, `rotted roofs are whole geometry (${rottedTris} triangles against ${soundTris} sound)`);
for (const id of ["bunkhouseAbandoned", "sawShedAbandoned", "toolShedAbandoned", "cookhouseAbandoned"]) check(def(id).house.parts.roof.material === "rottedShingles", `${id} roof is rottedShingles`);
check(!!content.buildingMaterials.find((m) => m.id === "rottedShingles"), "the rottedShingles material exists");
// Nothing active: no light, flame or smoke anywhere in the camp - buildings (their rooms' furniture, the
// windows' lamps, the chimneys' smoke) and the outdoor props.
const propOf = (id) => content.props.find((p) => p.id === id);
const lit = (p) => !!p && ((p.light ?? null) !== null || (p.effects?.length ?? 0) > 0);
const roomOf = (id) => content.roomTypes?.find?.((r) => r.id === id) ?? content.rooms?.find?.((r) => r.id === id);
for (const id of ["bunkhouseAbandoned", "sawShedAbandoned", "toolShedAbandoned", "cookhouseAbandoned"]) {
  const d = def(id);
  check(d.house.cold === true && d.house.litWindows === 0, `${id}: cold, no lit windows`);
  for (const r of d.house.interior?.rooms.rooms ?? []) {
    for (const entry of r.room.furnish) {
      const items = entry.group ? entry.group.members.map((m) => m.prop) : [entry.prop];
      for (const prop of items) check(!lit(prop), `${id}: room ${r.room.id} furnishes a light or flame (${prop?.id})`);
    }
  }
  for (let seed = 1; seed <= 6; seed++) {
    const m = generateBuilding(d, seed, 0);
    // (A window's daylight - `sky` - is not a source: it is gone at night.)
    const sources = (m.lights ?? []).filter((l) => !l.sky);
    check((m.effects?.length ?? 0) === 0 && sources.length === 0, `${id} seed ${seed}: no effects or lights in the model (${m.effects?.length ?? 0} effects, ${sources.length} lights)`);
  }
}
for (const e of kind.compound.props) {
  const members = e.placed.kind === "prop" ? [e.placed.prop] : e.placed.group.members.map((m) => m.prop);
  for (const prop of members) check(!lit(prop), `the camp's prop ${prop?.id} gives light or a flame`);
}

// In the world: it is placed, and the road that leads only to it is abandoned.
const { loadContentFromDisk } = await import("../diskContent.mjs");
const { createWorldData } = await import("../../src/world/worldData.ts");
const quiet = (run) => { const l = console.log; console.log = (...a) => (String(a[0]).startsWith("[") ? undefined : l(...a)); try { return run(); } finally { console.log = l; } };
const vale = loadContentFromDisk("vale").content;
let paintedAbandoned = 0, camps = 0, abandonedStretches = 0, seedsWith = 0;
const seedsN = Number(process.argv[2]) || 8;
for (let i = 0; i < seedsN; i++) {
  const w = quiet(() => createWorldData(1000 + i * 7919, vale));
  const n = (w.features ?? []).filter((f) => (f.kind?.id ?? f.kindId) === "abandonedCamp").length;
  camps += n;
  if (n > 0) seedsWith++;
  const roads = w.roads?.stretches ?? w.roadNetwork?.stretches ?? [];
  const a = roads.filter((st) => st.roadClass === "abandoned").length;
  abandonedStretches += a;
  // The ground on an abandoned stretch's line is painted as one (roadAbandoned), the sound roads' is not.
  // (Away from its ends, where the paint fades in, and off a bridge, which paints nothing: the point
  // of the stretch furthest from both that is on the ground.)
  for (const st of roads) {
    if (st.points.length < 5) continue;
    let total = 0;
    const arcs = st.points.map((p, k) => (k === 0 ? 0 : (total += Math.hypot(p.x - st.points[k - 1].x, p.z - st.points[k - 1].z))));
    const bridges = st.bridges ?? [];
    let best = null, bestFree = 0;
    st.points.forEach((p, k) => {
      const free = Math.min(arcs[k], total - arcs[k], ...bridges.map(([s0, s1]) => (arcs[k] >= s0 && arcs[k] <= s1 ? 0 : Math.min(Math.abs(arcs[k] - s0), Math.abs(arcs[k] - s1)))));
      if (free > bestFree) { bestFree = free; best = p; }
    });
    if (!best) continue;
    const sample = w.sampleTerrain(best.x, best.z);
    if (st.roadClass === "abandoned" && bestFree >= 40) { paintedAbandoned++; check(sample.roadAbandoned > 0.3, `an abandoned stretch reads roadAbandoned ${sample.roadAbandoned.toFixed(2)} ${Math.round(bestFree)} m from its ends and bridges`); }
    if (st.roadClass !== "abandoned") check(sample.roadAbandoned === 0, `a sound road reads roadAbandoned ${sample.roadAbandoned}`);
  }
  check(n <= 5, `vale seed ${i}: ${n} abandoned camps is too many`);
}
check(paintedAbandoned >= 1, `at least one long abandoned stretch checked for its paint (${paintedAbandoned})`);
check(camps >= 1, `the vale places the camp in at least one of ${seedsN} seeds (${camps} camps, ${seedsWith} seeds)`);
console.log(`vale: ${camps} camps over ${seedsN} seeds, ${seedsWith} seeds with one, ${abandonedStretches} abandoned road stretches`);
console.log(`abandonedCamp: ${checks - fails}/${checks} checks; ${placed} layouts, ${(props / Math.max(1, placed)).toFixed(1)} props each`);
process.exit(fails ? 1 : 0);
