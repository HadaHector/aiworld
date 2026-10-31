// The starting site test (NPCS.md, *The starting site*): starts read from dimension definitions,
// chosen from the generated settlements by their rule (relaxed where nothing matches), the same
// every time; ring 0 of the zone levels at the start; and on a real `tiny` server, quick and saved
// characters appearing there, with a new character's first home written when it first enters.
//   npm run probe -- scripts/probe/starts.mjs            (tiny and small over 8 seeds each)
//   npm run probe -- scripts/probe/starts.mjs full       (and the full world over 3 seeds)
import { loadContentFromDisk, loadRulesFromDisk, loadCreatureRulesFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";
import { chooseStarts, startAllows } from "../../src/world/settlements/starts.ts";
import { startingPlace } from "../../src/sim/spawn.ts";
import { createZones } from "../../src/sim/creatures/zones.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";
import { createMemoryStore } from "../../src/save/memoryStore.ts";
import { createWorldRecord } from "../../src/save/records.ts";

let failures = 0;
let checks = 0;
function check(what, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
}
async function section(name, run) {
  try {
    await run();
  } catch (error) {
    failures++;
    console.log(`FAIL ${name} threw:`, error);
  }
}

// Generation logs a line per phase; keep the output to the checks.
const log = console.log;
const quiet = (run) => {
  console.log = (...args) => (String(args[0]).startsWith("[") ? undefined : log(...args));
  try {
    return run();
  } finally {
    console.log = log;
  }
};

const configs = [["tiny", 8], ["small", 8], ...(process.argv.includes("full") ? [["default", 3]] : [])];

for (const [config, seeds] of configs) {
  await section(`${config} starts`, () => {
    const { content } = loadContentFromDisk(config);
    const mainland = content.dimension;
    const game = loadRulesFromDisk(config);
    for (let s = 0; s < seeds; s++) {
      const seed = 1000 + s * 7919;
      const warnings = [];
      const world = quiet(() => createWorldData(seed, content));
      const starts = chooseStarts(world, mainland, (m) => warnings.push(m));
      const again = chooseStarts(world, mainland);
      const tag = `${config} seed ${seed}`;
      check(`${tag}: one start per definition`, starts.length === Math.max(1, mainland.starts.length));
      check(`${tag}: the same twice`, JSON.stringify(starts) === JSON.stringify(again));
      const start = starts[0];
      const layout = world.settlementLayouts.find((l) => l.siteId === start.settlement);
      const site = world.settlements.find((x) => x.id === start.settlement);
      if (world.settlementLayouts.length > 0) check(`${tag}: a settlement chosen`, layout !== undefined, JSON.stringify(start));
      if (!layout) continue;
      check(`${tag}: arrives inside it`, Math.hypot(start.x - layout.x, start.z - layout.z) <= layout.radius, `${start.x},${start.z}`);
      check(`${tag}: home inside it`, Math.hypot(start.home.x - layout.x, start.home.z - layout.z) <= layout.radius);
      check(`${tag}: what stands there is near`, start.entities.every((e) => Math.hypot(e.x - layout.x, e.z - layout.z) <= layout.radius + 10), JSON.stringify(start.entities));
      // What the rule asked, unless it said it dropped it.
      const rule = mainland.starts[0].rule;
      const dropped = new Set(start.relaxed);
      check(`${tag}: relaxing is warned`, dropped.size === 0 || warnings.length > 0);
      if (!dropped.has("tiers")) check(`${tag}: a village`, rule.tiers.includes(site.tier), site.tier);
      if (!dropped.has("buildings")) for (const b of rule.buildings) check(`${tag}: has a ${b}`, layout.houses.some((h) => h.building.id === b));
      if (!dropped.has("biomes")) check(`${tag}: a mild biome`, rule.biomes.only.includes(site.biome.id), site.biome.id);
      // Ring 0 is the start's zone.
      const creatures = loadCreatureRulesFromDisk(config, game, seed);
      const zones = createZones(world, creatures, start);
      const area = world.sampleTerrain(start.x, start.z).primaryAreaId;
      check(`${tag}: ring 0 at the start`, zones.find((z) => z.id === area)?.ring === 0, JSON.stringify(zones.map((z) => [z.id, z.ring])));
      log(`${tag}: ${start.name} (${site.tier}, ${site.biome.id}) at ${start.x.toFixed(0)}, ${start.z.toFixed(0)}${start.relaxed.length ? `, dropped ${start.relaxed.join(", ")}` : ""}`);
    }
  });
}

// Starts with a filter: who starts where, without a world.
await section("filters", () => {
  const def = {
    id: "test", spawn: { x: 0, z: 0 },
    starts: [
      { id: "dwarves", for: { people: ["dwarf"] }, rule: null, entities: [] },
      { id: "common", for: null, rule: null, entities: [] },
    ],
  };
  check("a dwarf starts with the dwarves", startingPlace(def, { people: "dwarf" }).start === "dwarves");
  check("a human starts at the common start", startingPlace(def, { people: "human" }).start === "common");
  check("for allows", startAllows({ for: { people: ["elf"] } }, { people: "elf" }) && !startAllows({ for: { people: ["elf"] } }, {}));
  check("no starts: the default", startingPlace({ id: "x", starts: [] }, {}).start === "default");
});

// A real server: quick and saved characters at the start.
await section("server", async () => {
  const config = "tiny";
  const { content, packs } = loadContentFromDisk(config);
  const rules = loadRulesFromDisk(config);
  const seed = 1338;
  const worldData = quiet(() => createWorldData(seed, content));
  const [start] = chooseStarts(worldData, content.dimension);
  const store = createMemoryStore();
  const world = createWorldRecord({ id: "probe", name: "Probe", seed, config, packs: [], hashes: { rules: rules.hash, items: 0, creatures: 0, progression: 0 } });
  await store.writeWorld(world);
  const server = createServer({ seed, config, packs, dimensions: content.dimensions, rules, loadDimension: () => ({ world: worldData }), saves: { store, world, interval: 5 } });
  const clients = [];
  const connect = (hello) => {
    const channel = createLocalChannel();
    server.connect(channel.server);
    channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "", dimension: "", ...hello });
    const client = { id: 0, inbox: [], channel, send: (m) => channel.client.send(m), last: (type) => client.inbox.filter((m) => m.type === type).at(-1) };
    clients.push(client);
    return client;
  };
  const pump = async (steps = 1) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      server.step(1 / 30);
      for (const c of clients) {
        for (const m of c.channel.client.receive()) {
          if (m.type === "welcome" && m.playerId) c.id = m.playerId;
          if (m.type === "entered") c.id = m.playerId;
          if (m.type === "transfer") c.send({ type: "arrived" });
          c.inbox.push(m);
        }
      }
    }
  };
  const entity = (c) => server.debug.entity(c.id);
  const near = (e, p, d = 2) => e && Math.hypot(e.x - p.x, e.z - p.z) < d;

  // A quick character (the `?play` path).
  const quick = connect({ name: "Quick" });
  await pump(10);
  check("a quick transfer names the start", quick.last("transfer")?.start === start.id, JSON.stringify(quick.last("transfer")));
  check("a quick character appears at the start", near(entity(quick), start), entity(quick) && `${entity(quick).x},${entity(quick).z} vs ${start.x},${start.z}`);
  quick.channel.client.close();
  await pump(2);

  // A saved character: made, entered, placed, its home written.
  const a = connect({ select: true });
  await pump(2);
  a.send({ type: "characterCreate", name: "Starter", origins: {}, look: { seed: 3, race: "human", outfit: "", sex: "" } });
  await pump(3);
  const id = a.last("characters")?.list.find((c) => c.name === "Starter")?.id;
  check("made", id !== undefined, JSON.stringify(a.last("refused")));
  check("made, not yet placed", (await store.readCharacter("probe", id))?.travel.start === start.id);
  a.send({ type: "enterWorld", character: id, dimension: "" });
  await pump(15);
  check("a new character appears at the start", near(entity(a), start), entity(a) && `${entity(a).x},${entity(a).z} vs ${start.x},${start.z}`);
  a.send({ type: "logout", toMenu: false });
  await pump(10);
  const record = await store.readCharacter("probe", id);
  check("placed: the start is gone from its record", record.travel.start === undefined, JSON.stringify(record.travel));
  check("its home is the start's", near(record.travel.home, start.home, 0.01), JSON.stringify(record.travel.home));
  a.send({ type: "enterWorld", character: id, dimension: "" });
  await pump(15);
  check("entering again: where it was left", near(entity(a), record.travel), entity(a) && `${entity(a).x},${entity(a).z}`);
});

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
