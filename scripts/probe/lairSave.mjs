// Logging out in a lair (FRONTEND.md, *Saves*; the owner's bug of 2026-11-25): a saved character left deep
// in a cave, a mine and a crypt of the vale comes back, on a restarted server, in the same lair laid out the
// same, on its floor at the same spot - not on the terrain above. And a save naming a lair that is not there
// any more comes back outside its entrance, on the ground.
//   npm run probe -- scripts/probe/lairSave.mjs
import { loadContentFromDisk, loadCreatureRulesFromDisk, loadItemRulesFromDisk, loadProgressionRulesFromDisk, loadRulesFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { resolveDungeons } from "../../src/world/dungeons/dungeonDefs.ts";
import { placedSpots } from "../../src/world/dungeons/layout.ts";
import { createWorldData } from "../../src/world/worldData.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";
import { caveMouthSite, mouthSite } from "../../src/sim/dungeons.ts";
import { createMemoryStore } from "../../src/save/memoryStore.ts";
import { createWorldRecord } from "../../src/save/records.ts";

const CONFIG = "vale";
// A seed whose vale has a cave, a mine and a crypt (the default seed has no mine).
const SEED = 6;
let failures = 0, checks = 0;
const check = (what, ok, detail = "") => { checks++; if (!ok) { failures++; console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`); } };

const { content, packs } = loadContentFromDisk(CONFIG);
const rules = loadRulesFromDisk(CONFIG);
const creatures = loadCreatureRulesFromDisk(CONFIG, rules, SEED);
const items = loadItemRulesFromDisk(CONFIG, rules, SEED);
const progression = loadProgressionRulesFromDisk(CONFIG, rules, SEED);
const dungeons = resolveDungeons(packSourcesFromDisk(readConfigFromDisk(CONFIG)).sources);
const world = createWorldData(SEED, content);

const EXPECTED = [/the start ".*" dropped .* to find a settlement/, /left in a lair that is not there/];

function startServer(store, record) {
  const problems = [];
  const server = createServer({
    seed: SEED, config: CONFIG, packs, dimensions: content.dimensions, rules, creatures, items, progression, dungeons,
    loadDimension: () => ({ world }), devCommands: true,
    saves: { store, world: record, interval: 1e9, onProblem: (m) => { if (!EXPECTED.some((r) => r.test(m))) problems.push(m); } },
  });
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, select: true, name: "", dimension: "" });
  const c = { id: 0, inbox: [], send: (m) => channel.client.send(m), last: (type) => c.inbox.filter((m) => m.type === type).at(-1) };
  const pump = async (steps = 1) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      server.step(1 / 30);
      for (const m of channel.client.receive()) {
        if (m.type === "entered") c.id = m.playerId;
        if (m.type === "transfer") c.send({ type: "arrived" });
        c.inbox.push(m);
      }
    }
  };
  const me = () => server.debug.entity(c.id);
  const dim = () => [...server.debug.dimensions.values()][0];
  /** Enters a character and waits until its body is made. */
  const enter = async (character) => {
    c.send({ type: "enterWorld", character, dimension: "" });
    for (let i = 0; i < 600 && !me()?.body; i++) await pump(1);
    // (The lair's creatures would kill it while it waits: left dead, it comes back at home.)
    c.send({ type: "chat", channel: "command", text: "god" });
    await pump(45);
  };
  return { server, c, pump, me, dim, enter, problems };
}

const store = createMemoryStore();
const record = createWorldRecord({ id: "lairs", name: "Lairs", seed: SEED, config: CONFIG, packs, hashes: { rules: rules.hash, items: items.hash, creatures: creatures.hash, progression: progression.hash } });
await store.writeWorld(record);
let t = startServer(store, await store.readWorld("lairs"));
await t.pump(2);
t.c.send({ type: "characterCreate", name: "Delver", origins: {}, look: { seed: 1, race: "", outfit: "", sex: "" } });
await t.pump(2);
const characterId = t.c.last("characters")?.list[0]?.id;
check("a character made", !!characterId);

// A lair of each kind the vale has: the first cave, the first mine, the first crypt.
const caveOf = (style) => world.caveMouths.find((m) => (m.style ?? "cave") === style);
const crypt = world.compoundLayouts.flatMap((l) => l.buildings.map((b) => mouthSite(world, b)).filter(Boolean))[0];
const sites = [
  ["cave", caveOf("cave") && caveMouthSite(caveOf("cave"))],
  ["mine", caveOf("mine") && caveMouthSite(caveOf("mine"))],
  ["crypt", crypt && { ...crypt, style: "crypt" }],
].filter(([, s]) => s);
console.log(`vale: ${sites.map(([k]) => k).join(", ")} to log out in`);
check("the vale has a cave, a mine and a crypt", sites.length === 3, sites.map(([k]) => k).join());

for (const [kind, site] of sites) {
  await t.enter(characterId);
  let me = t.me(), dim = t.dim();
  // Beside its mouth: the mouth's own lair opens as it is walked up to (DUNGEONS.md, *Seamless*).
  const out = (site.facing * Math.PI) / 180;
  me.body.teleport(site.x + Math.sin(out) * 12, site.z + Math.cos(out) * 12);
  await t.pump(45);
  const dungeon = [...dim.dungeons.placed.values()].find((d) => Math.round(d.site.x) === Math.round(site.x) && Math.round(d.site.z) === Math.round(site.z));
  check(`${kind}: its lair opened by its mouth`, !!dungeon);
  if (!dungeon) continue;
  // Deep in it: a spawn spot of the room before the boss's (or the boss's own), on its floor.
  const parts = dungeon.layout.parts;
  const deep = [Math.max(1, dungeon.layout.boss - 1), dungeon.layout.boss, parts.length - 1].map((i) => parts[i] && placedSpots(parts[i], "spawns")[0]).find(Boolean) ?? dungeon.arrival;
  const floor = dungeon.floorAt ? dungeon.floorAt(deep.x, deep.y, deep.z) : deep.y;
  me.body.teleportTo({ x: deep.x, y: floor + 0.3, z: deep.z });
  await t.pump(30);
  const left = { x: me.x, y: me.y, z: me.z };
  const inside = (e) => t.dim().dungeons.at(e.x, e.y, e.z) ?? t.dim().dungeons.at(e.x, e.y + 1, e.z);
  check(`${kind}: standing in it before logging out`, inside(me) === dungeon, `${left.x.toFixed(1)}, ${left.y.toFixed(1)}, ${left.z.toFixed(1)}; terrain ${world.heightAt(left.x, left.z).toFixed(1)}`);
  t.c.send({ type: "logout" });
  await t.pump(5);
  const saved = await store.readCharacter("lairs", characterId);
  check(`${kind}: the save names the lair and the height`, !saved.dead && saved.travel.lair?.id === dungeon.id && Math.abs(saved.travel.y - left.y) < 0.01, JSON.stringify(saved.travel));
  await t.server.save();

  // A restart, and in again.
  t = startServer(store, await store.readWorld("lairs"));
  await t.pump(2);
  await t.enter(characterId);
  me = t.me();
  dim = t.dim();
  const back = dim.dungeons.placed.get(dungeon.id);
  check(`${kind}: the lair laid out again, the same`, !!back && back.seed === dungeon.seed && back.layout.parts.length === parts.length);
  check(`${kind}: back where it was left`, Math.hypot(me.x - left.x, me.z - left.z) < 1 && Math.abs(me.y - left.y) < 1.5, `${me.x.toFixed(1)}, ${me.y.toFixed(1)}, ${me.z.toFixed(1)} vs ${left.x.toFixed(1)}, ${left.y.toFixed(1)}, ${left.z.toFixed(1)}`);
  check(`${kind}: inside the lair, not on the terrain above`, !!back && inside(me) === back && me.y < world.heightAt(me.x, me.z) - 2, `y ${me.y.toFixed(1)}, terrain ${world.heightAt(me.x, me.z).toFixed(1)}`);
  check(`${kind}: its client told to draw it`, t.c.last("dungeon")?.id === dungeon.id);
  await t.pump(90);
  check(`${kind}: still on its floor a few seconds on`, inside(me) === back && Math.abs(me.y - left.y) < 1.5, `y ${me.y.toFixed(1)}`);
  t.c.send({ type: "logout" });
  await t.pump(5);
  check(`${kind}: nothing went wrong`, t.problems.length === 0, t.problems.join(" | "));
}

// A lair that is not there any more (its mouth moved away): outside where its entrance was, on the ground.
{
  const saved = await store.readCharacter("lairs", characterId);
  const lair = saved.travel.lair;
  check("the last save is in a lair", !!lair);
  if (lair) {
    lair.site.x += 0.5;
    lair.site.z += 3;
    lair.mouth = true;
    lair.style = "nowhere";
    await store.writeCharacter("lairs", saved);
    t = startServer(store, await store.readWorld("lairs"));
    await t.pump(2);
    await t.enter(characterId);
    const me = t.me();
    const out = (lair.site.facing * Math.PI) / 180;
    const door = { x: lair.site.x + Math.sin(out) * 4, z: lair.site.z + Math.cos(out) * 4 };
    check("a lair gone: outside its entrance", Math.hypot(me.x - door.x, me.z - door.z) < 3, `${me.x.toFixed(1)}, ${me.z.toFixed(1)} vs ${door.x.toFixed(1)}, ${door.z.toFixed(1)}`);
    check("a lair gone: on the ground, in no lair", Math.abs(me.y - t.dim().groundAt(me.x, me.z)) < 1.5 && !t.dim().dungeons.at(me.x, me.y + 1, me.z), `y ${me.y.toFixed(1)}, ground ${t.dim().groundAt(me.x, me.z).toFixed(1)}`);
    t.c.send({ type: "logout" });
    await t.pump(5);
    const after = await store.readCharacter("lairs", characterId);
    check("a lair gone: the save no longer names it", !after.travel.lair && after.travel.y === undefined, JSON.stringify(after.travel));
  }
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
