// The saves test (see FRONTEND.md, *Saves* and *Handshake*): records and names, the memory and file
// stores, and a real `tiny` server with saves - making characters, entering, logging out, and a
// restarted server finding the character, the clock and the world delta where they were left.
//   npm run probe -- scripts/probe/saves.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRulesFromDisk, loadCreatureRulesFromDisk, loadItemRulesFromDisk, loadProgressionRulesFromDisk, loadContentFromDisk } from "../diskContent.mjs";
import { createWorldData, WORLD_SEED } from "../../src/world/worldData.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION, cleanChoices } from "../../src/sim/protocol.ts";
import { createMemoryStore } from "../../src/save/memoryStore.ts";
import { migrateWorld } from "../../src/save/migrate.ts";
import { createWorldRecord, nameProblem, SAVE_VERSION } from "../../src/save/records.ts";
import { createFileStore } from "../server/fileStore.mjs";

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

const CONFIG = "tiny";

await section("records", () => {
  check("a good name", nameProblem("Aria", []) === "");
  check("apostrophes and hyphens inside", nameProblem("Ka'ra-Lin", []) === "");
  check("too short", nameProblem("A", []) !== "");
  check("too long", nameProblem("Abcdefghijklmnopq", []) !== "");
  check("letters only", nameProblem("Bob2", []) !== "" && nameProblem("-Bob", []) !== "" && nameProblem("Bo b", []) !== "");
  check("taken, without case", nameProblem("aria", ["Aria"]) !== "");
  const choices = cleanChoices({ hairStyle: 2.6, height: 3, eyeSpacing: -5, beard: 0.7, bogus: 1, skin: "red" });
  check("look choices kept to their ranges", JSON.stringify(choices) === JSON.stringify({ height: 1, hairStyle: 3, beard: 1, eyeSpacing: -1 }), JSON.stringify(choices));
  check("no choices, none kept", cleanChoices({}) === undefined && cleanChoices(null) === undefined);
  let refused = "";
  try {
    migrateWorld({ version: SAVE_VERSION + 1 });
  } catch (error) {
    refused = String(error);
  }
  check("a newer save is refused", /newer version/.test(refused), refused);
});

/** A store's whole round: write, list, read, delete. */
async function storeRound(name, store) {
  const world = createWorldRecord({ id: "w1", name: "One", seed: 5, config: CONFIG, packs: ["core"], hashes: { rules: 1, items: 2, creatures: 3, progression: 4 } }, 1000);
  const older = createWorldRecord({ id: "w0", name: "Zero", seed: 6, config: CONFIG, packs: ["core"], hashes: { rules: 1, items: 2, creatures: 3, progression: 4 } }, 500);
  await store.writeWorld(older);
  await store.writeWorld(world);
  const character = { version: SAVE_VERSION, id: "c1", name: "Aria", origins: { people: "elf" }, interface: "{}" };
  await store.writeCharacter("w1", character);
  world.name = "One, renamed";
  check(`${name}: a write is a copy`, (await store.readWorld("w1")).name === "One");
  const list = await store.listWorlds();
  check(`${name}: worlds newest played first`, list.map((w) => w.id).join() === "w1,w0", list.map((w) => w.id).join());
  check(`${name}: a character back`, (await store.readCharacter("w1", "c1"))?.name === "Aria");
  check(`${name}: a missing one is null`, (await store.readCharacter("w1", "nobody")) === null && (await store.readWorld("nowhere")) === null);
  await store.deleteWorld("w1");
  check(`${name}: deleting a world takes its characters`, (await store.readWorld("w1")) === null && (await store.readCharacter("w1", "c1")) === null);
  check(`${name}: the other world stays`, (await store.listWorlds()).length === 1);
}

await section("memory store", () => storeRound("memory", createMemoryStore()));
await section("file store", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiworld-saves-"));
  try {
    await storeRound("files", createFileStore(root));
    let refused = false;
    try {
      await createFileStore(root).readCharacter("../x", "c");
    } catch {
      refused = true;
    }
    check("files: an id cannot leave the folder", refused);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- a real tiny server with saves ---
const { content, packs } = loadContentFromDisk(CONFIG);
const rules = loadRulesFromDisk(CONFIG);
const creatures = loadCreatureRulesFromDisk(CONFIG, rules, WORLD_SEED);
const progression = loadProgressionRulesFromDisk(CONFIG, rules, WORLD_SEED);
const items = loadItemRulesFromDisk(CONFIG, rules, WORLD_SEED);
const worldData = createWorldData(WORLD_SEED, content);

function startServer(store, world) {
  const problems = [];
  const server = createServer({
    seed: WORLD_SEED, config: CONFIG, packs, dimensions: content.dimensions, rules, creatures, items, progression,
    loadDimension: () => ({ world: worldData }),
    saves: { store, world, interval: 5, onProblem: (m) => problems.push(m) },
  });
  const clients = [];
  const connect = () => {
    const channel = createLocalChannel();
    server.connect(channel.server);
    channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, select: true, name: "", dimension: "" });
    const client = { id: 0, inbox: [], channel, send: (m) => channel.client.send(m), last: (type) => client.inbox.filter((m) => m.type === type).at(-1) };
    clients.push(client);
    return client;
  };
  const pump = async (steps = 1, dt = 1 / 30) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      server.step(dt);
      for (const c of clients) {
        for (const m of c.channel.client.receive()) {
          if (m.type === "entered") c.id = m.playerId;
          if (m.type === "transfer") c.send({ type: "arrived" });
          c.inbox.push(m);
        }
      }
    }
  };
  return { server, connect, pump, problems, entity: (c) => server.debug.entity(c.id) };
}

await section("server", async () => {
  const store = createMemoryStore();
  const world = createWorldRecord({ id: "probe", name: "Probe", seed: WORLD_SEED, config: CONFIG, packs, hashes: { rules: rules.hash, items: items.hash, creatures: creatures.hash, progression: progression.hash } });
  await store.writeWorld(world);
  let t = startServer(store, await store.readWorld("probe"));
  let a = t.connect();
  await t.pump(2);
  const welcome = a.last("welcome");
  check("welcome says the world and saves", welcome?.world === "Probe" && welcome.saves === true && welcome.playerId === 0, JSON.stringify(welcome));
  check("an empty list first", a.last("characters")?.list.length === 0);

  for (const [name, why] of [["X", /at least/], ["Bad1", /letters/]]) {
    a.send({ type: "characterCreate", name, origins: {}, look: { seed: 1, race: "", outfit: "", sex: "" } });
    await t.pump(1);
    check(`a bad name is refused: ${name}`, why.test(a.last("refused")?.reason ?? ""), a.last("refused")?.reason);
  }
  a.send({ type: "characterCreate", name: "aria", origins: { people: "dwarf", class: "nobody" }, look: { seed: 3, race: "dwarf", outfit: "", sex: "female" } });
  await t.pump(1);
  check("an origin that is not there is refused", /cannot be chosen/.test(a.last("refused")?.reason ?? ""), a.last("refused")?.reason);
  a.send({ type: "characterCreate", name: "aria", origins: { people: "dwarf", class: "warrior" }, look: { seed: 3, race: "dwarf", outfit: "", sex: "female", choices: { hairStyle: 1, height: 0.2 } } });
  await t.pump(2);
  const made = a.last("characters")?.list ?? [];
  check("made, its name capitalised", made.length === 1 && made[0].name === "Aria" && made[0].origins.class === "warrior", JSON.stringify(made));
  a.send({ type: "characterCreate", name: "ARIA", origins: {}, look: { seed: 3, race: "", outfit: "", sex: "" } });
  await t.pump(1);
  check("a name taken is refused", /already/.test(a.last("refused")?.reason ?? ""));
  check("the record is written", (await store.readCharacter("probe", made[0].id))?.name === "Aria");

  a.send({ type: "enterWorld", character: made[0].id, dimension: "" });
  await t.pump(40);
  let me = t.entity(a);
  check("entered as its origins", me?.template.id === "player.dwarf.warrior", me?.template.id);
  check("with its look", me?.look.race === "dwarf" && me.look.sex === "female");
  check("and its chosen looks", me?.look.choices?.hairStyle === 1 && me.look.choices.height === 0.2 && a.last("entered")?.look.choices?.hairStyle === 1, JSON.stringify(me?.look));
  check("the list shows its look", a.last("characters")?.list[0]?.look?.race === "dwarf");
  const b = t.connect();
  await t.pump(2);
  b.send({ type: "enterWorld", character: made[0].id, dimension: "" });
  await t.pump(2);
  check("not in the world twice", /already in the world/.test(b.last("refused")?.reason ?? ""), b.last("refused")?.reason);
  b.send({ type: "characterDelete", id: made[0].id });
  await t.pump(1);
  check("not deleted while playing", /in the world/.test(b.last("refused")?.reason ?? ""));

  // Play a little: levels, an item and money, a wound, a walk, a layout.
  const adventure = progression.disciplineIndex.get("adventure");
  a.send({ type: "debugLevel", discipline: adventure, level: 4 });
  a.send({ type: "debugItem", item: "bread", count: 3 });
  const gold = items.currencies[items.main ?? 0];
  a.send({ type: "debugResource", entity: 0, resource: rules.health, delta: -40 });
  a.send({ type: "saveInterface", value: '{"bar":[1,2,3]}' });
  a.send({ type: "teleport", x: 30, z: -20 });
  await t.pump(5);
  me = t.entity(a);
  me.belongings.wallet[items.main ?? 0] = 1234;
  const health = me.resources.current[rules.health];
  const bagTypes = (e) => e.belongings.bag.map((id) => id && items.types[t.server.debug.items.store.get(id).type].id).filter(Boolean).sort().join();
  const worn = (e) => e.belongings.equipment.map((id) => id && items.types[t.server.debug.items.store.get(id).type].id).filter(Boolean).sort().join();
  const before = { bag: bagTypes(me), worn: worn(me), x: me.x, z: me.z, health };
  // A creature killed and a key that has passed, in the delta.
  t.server.debug.delta.set("probe/killed", t.server.time + 1000);
  t.server.debug.delta.set("probe/passed", t.server.time + 0.01);
  await t.pump(10);
  check("an autosave told the client", a.inbox.some((m) => m.type === "saved"));

  const atLogout = t.entity(a).resources.current[rules.health];
  a.send({ type: "logout" });
  await t.pump(5);
  const savedHealth = (await store.readCharacter("probe", made[0].id))?.resources.health;
  check("its health saved", Math.abs(savedHealth - atLogout) < 1, `${savedHealth} vs ${atLogout}`);
  check("logged out, after the save", a.inbox.some((m) => m.type === "loggedOut"));
  const listed = a.last("characters")?.list[0];
  check("the list has its level and place", listed?.level === 4 && listed.place !== "", JSON.stringify(listed));
  check("out of the world", t.server.debug.players.size === 0 && t.server.debug.dimensions.size === 0);
  // As a host does when it stops: the world written as it is now.
  await t.server.save();
  const clock = t.server.time;
  check("nothing went wrong saving", t.problems.length === 0, t.problems.join(" | "));

  // A restart: a new server from what the store has.
  t = startServer(store, await store.readWorld("probe"));
  check("the clock carries on", Math.abs(t.server.time - clock) < 1e-6, `${t.server.time} vs ${clock}`);
  check("the delta kept what has not come back", t.server.debug.delta.get("probe/killed") !== undefined && t.server.debug.delta.get("probe/passed") === undefined);
  a = t.connect();
  await t.pump(2);
  a.send({ type: "enterWorld", character: made[0].id, dimension: "" });
  await t.pump(40);
  me = t.entity(a);
  const lvl = me?.progress.disciplines.get(adventure)?.level;
  check("its level back", lvl === 4, String(lvl));
  check("its bag back", bagTypes(me) === before.bag, `${bagTypes(me)} vs ${before.bag}`);
  check("what it wore back", worn(me) === before.worn, `${worn(me)} vs ${before.worn}`);
  check("its money back", me.belongings.wallet[items.main ?? 0] === 1234, `${me.belongings.wallet} (${gold?.id})`);
  // Out of combat it has regenerated a little since.
  const now = me.resources.current[rules.health];
  check("its health back", now >= savedHealth && now <= savedHealth + 30 && now < me.resources.max[rules.health], `${now} vs ${savedHealth}`);
  check("where it was left", Math.hypot(me.x - before.x, me.z - before.z) < 1, `${me.x},${me.z} vs ${before.x},${before.z}`);
  check("its layout back", a.last("entered")?.interface === '{"bar":[1,2,3]}');
  const ids = new Set();
  for (const list of [me.belongings.bag, me.belongings.equipment]) for (const id of list) if (id != null) ids.add(id);
  check("item ids carry on past the old ones", Math.min(...ids) >= (await store.readWorld("probe")).nextItemId - 100 && [...ids].every((id) => id > 1), [...ids].join());

  // Dead at logout: back at home, alive.
  t.server.debug.skills.kill(me);
  await t.pump(2);
  a.channel.client.close();
  await t.pump(3);
  check("closing the tab saves", (await store.readCharacter("probe", made[0].id))?.dead === true);
  a = t.connect();
  await t.pump(2);
  a.send({ type: "enterWorld", character: made[0].id, dimension: "" });
  await t.pump(40);
  me = t.entity(a);
  const home = content.dimensions.find((d) => d.start).spawn;
  check("left dead, back at home alive", me && !me.combat.dead && Math.hypot(me.x - home.x, me.z - home.z) < 3, me && `${me.x},${me.z} dead ${me.combat.dead}`);
  a.send({ type: "logout" });
  await t.pump(5);
  a.send({ type: "characterDelete", id: made[0].id });
  await t.pump(5);
  check("deleted", a.last("characters")?.list.length === 0 && (await store.readCharacter("probe", made[0].id)) === null);
});

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
