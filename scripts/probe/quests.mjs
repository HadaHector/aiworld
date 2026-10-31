// The quests test (QUESTS.md): the quest runtime on a real `tiny` server, with GAMEPLAY.md's test
// chain made by hand from the starting village's own people and its zone's creatures - talk, kill
// and loot, talk, gather from the ground, receive a quest item, use it on an enemy, talk to finish -
// a saved character logging out half way, and the rewards: XP, money, standing and an item chosen.
// Then the text: templates filled. Later steps add the generator.
//   npm run probe -- scripts/probe/quests.mjs
import { loadContentFromDisk, loadCreatureRulesFromDisk, loadItemRulesFromDisk, loadProgressionRulesFromDisk, loadRulesFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";
import { createMemoryStore } from "../../src/save/memoryStore.ts";
import { createWorldRecord } from "../../src/save/records.ts";
import { addThreat } from "../../src/sim/skills/combat.ts";
import { fillText } from "../../src/core/text.ts";

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
const log = console.log;
const quiet = (run) => {
  console.log = (...args) => (String(args[0]).startsWith("[") ? undefined : log(...args));
  try {
    return run();
  } finally {
    console.log = log;
  }
};

const CONFIG = "tiny";
const SEED = 1338;

await section("text", () => {
  check("an argument", fillText("Hello {name}.", { name: "Tam" }) === "Hello Tam.");
  check("plural one", fillText("{count, plural, one {# wolf} other {# wolves}}", { count: 1 }) === "1 wolf");
  check("plural other", fillText("{count, plural, one {# wolf} other {# wolves}}", { count: 4 }) === "4 wolves");
  check("select", fillText("{sex, select, male {he} female {she} other {they}}", { sex: "female" }) === "she");
  check("nested", fillText("{count, plural, one {a {thing}} other {# {thing}s}}", { count: 3, thing: "fang" }) === "3 fangs");
  check("a missing argument stays", fillText("{nope}", {}) === "{nope}");
});

await section("the test chain", async () => {
  const { content, packs } = loadContentFromDisk(CONFIG);
  const rules = loadRulesFromDisk(CONFIG);
  const creatures = loadCreatureRulesFromDisk(CONFIG, rules, SEED);
  // Progression first: it adds the origins' templates, which the item rules give belongings to.
  const progression = loadProgressionRulesFromDisk(CONFIG, rules, SEED);
  const items = loadItemRulesFromDisk(CONFIG, rules, SEED);
  const worldData = quiet(() => createWorldData(SEED, content));
  const store = createMemoryStore();
  const world = createWorldRecord({ id: "probe", name: "Probe", seed: SEED, config: CONFIG, packs: [], hashes: { rules: rules.hash, items: items.hash, creatures: creatures.hash, progression: progression.hash } });
  await store.writeWorld(world);
  const server = createServer({ seed: SEED, config: CONFIG, packs, dimensions: content.dimensions, rules, creatures, items, progression, loadDimension: () => ({ world: worldData }), saves: { store, world, interval: 1000 } });
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, select: true, name: "", dimension: "" });
  const inbox = [];
  let id = 0;
  const pump = async (steps = 1, dt = 1 / 30) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      server.step(dt);
      for (const m of channel.client.receive()) {
        if (m.type === "entered") id = m.playerId;
        if (m.type === "transfer") channel.client.send({ type: "arrived" });
        inbox.push(m);
      }
    }
  };
  const send = async (m, steps = 2) => {
    channel.client.send(m);
    await pump(steps);
  };
  const last = (type) => inbox.filter((m) => m.type === type).at(-1);
  await pump(2);
  await send({ type: "characterCreate", name: "Questa", origins: {}, look: { seed: 9, race: "human", outfit: "", sex: "" } });
  const character = last("characters").list.find((c) => c.name === "Questa").id;
  await send({ type: "enterWorld", character, dimension: "" }, 15);
  let me = server.debug.entity(id);
  check("a fresh character is told an empty quest log", last("questLog")?.active.length === 0);

  // The cast: a giver, a healer, a maker - the reeve, the priest (else the innkeeper), the smith.
  const npcs = server.debug.npcs;
  const at = (role) => npcs.debug.active("mainland").find((e) => npcs.npcOf(e)?.role === role);
  let giverE = at("reeve");
  let healerE = at("priest") ?? at("innkeeper");
  let makerE = at("smith") ?? at("shopkeeper");
  const giver = npcs.npcOf(giverE).id;
  const healer = npcs.npcOf(healerE).id;
  const maker = npcs.npcOf(makerE).id;
  // A beast of the zone, and a place to gather in at the edge of the village.
  const zone = server.debug.creatures.debug.zoneAt("mainland", me.x, me.z);
  const kind = zone.roster.find((r) => r.kind.template.hostility !== "friendly")?.kind.id ?? zone.roster[0].kind.id;
  const species = kind.split(".")[0];
  const [start] = server.debug.starts.get("mainland");
  const layout = worldData.settlementLayouts.find((l) => l.siteId === start.settlement);
  const field = { dimension: "mainland", x: layout.x + layout.radius + 40, z: layout.z, radius: 15 };
  const t = (text, args = {}) => ({ text, args });
  const beasts = { kinds: [species], name: t("{species}", { species }) };
  const choice = items.generated.get("sword").slice(0, 3).map((i) => items.types[i].id);
  const quest = (n, fields) => ({
    id: `q:probe/${n}`, level: 1, chain: { id: "q:probe", index: n, of: 6 }, requires: { quests: n > 1 ? [`q:probe/${n - 1}`] : [], level: 1 }, ordered: true, within: 0, where: [],
    text: { title: t(`Part ${n}`), offer: t("Go on, {player}."), progress: t("Well?"), done: t("Good.") },
    rewards: { xp: 100, money: 20, choice: [], items: [], standing: [] },
    ...fields,
  });
  const folk = giverE.faction;
  const chain = [
    quest(1, { giver, ender: healer, objectives: [{ kind: "talk", npc: healer, line: t("Talk to the healer") }] }),
    quest(2, { giver: healer, ender: healer, objectives: [{ kind: "kill", creatures: beasts, count: 2, line: t("Beasts slain") }, { kind: "loot", from: beasts, count: 1, chance: 1, line: t("A sample") }] }),
    quest(3, { giver: healer, ender: maker, objectives: [{ kind: "talk", npc: maker, line: t("Talk to the maker") }] }),
    quest(4, { giver: maker, ender: maker, objectives: [{ kind: "gather", object: "Gravebloom", count: 3, area: field, line: t("Gravebloom picked") }] }),
    quest(5, { giver: maker, ender: maker, objectives: [{ kind: "receive", item: "herbalSalve", from: maker, line: t("Take the salve") }] }),
    quest(6, {
      giver: maker, ender: giver,
      objectives: [{ kind: "use", item: "herbalSalve", on: beasts, below: 1, count: 1, line: t("Salve a beast") }],
      rewards: { xp: 300, money: 75, choice, items: [], standing: [{ faction: folk, amount: 250 }] },
    }),
  ];
  server.debug.quests.define(chain);

  const goTo = async (npc) => send({ type: "teleport", x: npc.x + Math.sin(npc.facing) * 1.6, z: npc.z + Math.cos(npc.facing) * 1.6 }, 3);
  const talk = async (npc) => {
    await goTo(npc);
    await send({ type: "talk", npc: npc.id });
    return last("npcWindow");
  };
  const state = (n) => server.debug.quests.export(me).active.find((a) => a.id === `q:probe/${n}`);
  const done = (n) => server.debug.quests.export(me).done.includes(`q:probe/${n}`);
  const xp = () => me.progress.disciplines.get(progression.disciplineIndex.get("adventure"));
  const xpTotal = () => xp().level * 1e6 + xp().xp;
  const killBeast = async () => {
    const beast = server.debug.creatures.debug.spawn("mainland", kind, me.x + 4, me.z, 1);
    addThreat(server.debug.skills.sys, beast, me, 10);
    server.debug.skills.kill(beast);
    await pump(2);
  };

  // 1. Talk to an NPC.
  let window = await talk(giverE);
  check("the giver offers the first", window?.quests.some((q) => q.id === "q:probe/1" && q.state === "offer"), JSON.stringify(window?.quests));
  check("...and the client is told it whole", inbox.some((m) => m.type === "questDefs" && m.defs.some((d) => d.id === "q:probe/1")));
  check("...but not the second yet", !window.quests.some((q) => q.id === "q:probe/2"));
  await send({ type: "questAccept", npc: giverE.id, quest: "q:probe/1" });
  check("taken", state(1)?.state === "active" && last("questUpdate")?.quest === "q:probe/1");
  await send({ type: "questComplete", npc: giverE.id, quest: "q:probe/1", choice: 0 });
  check("not handed in at the wrong NPC", last("questRefused")?.reason === "notEnder");
  window = await talk(healerE);
  check("talking to the healer is the objective", window?.quests.some((q) => q.id === "q:probe/1" && q.state === "ready"), JSON.stringify(window?.quests));
  let before = xpTotal();
  await send({ type: "questComplete", npc: healerE.id, quest: "q:probe/1", choice: 0 });
  check("handed in: done, and XP", done(1) && xpTotal() > before, `${JSON.stringify(xp())}`);

  // 2. Kill creatures and loot something from them.
  await send({ type: "questAccept", npc: healerE.id, quest: "q:probe/2" });
  await killBeast();
  check("a kill counts", state(2)?.counts[0] === 1, JSON.stringify(state(2)));
  check("...but the loot waits its turn (ordered)", state(2)?.counts[1] === 0);
  await killBeast();
  await killBeast();
  check("two kills, and then the sample", state(2)?.counts.join() === "2,1" && state(2)?.state === "ready", JSON.stringify(state(2)));
  window = await talk(healerE);
  await send({ type: "questComplete", npc: healerE.id, quest: "q:probe/2", choice: 0 });
  check("the second done", done(2));

  // 3. Talk to another NPC - and a log out and in half way.
  await send({ type: "questAccept", npc: healerE.id, quest: "q:probe/3" });
  await send({ type: "logout", toMenu: false }, 10);
  const record = await store.readCharacter("probe", character);
  check("saved: active and done", record.quests?.active.some((a) => a.id === "q:probe/3") && record.quests.done.includes("q:probe/2"), JSON.stringify(record.quests));
  await send({ type: "enterWorld", character, dimension: "" }, 15);
  me = server.debug.entity(id);
  // The dimension went with the last player out, and its people were made anew.
  giverE = npcs.entityOf(giver);
  healerE = npcs.entityOf(healer);
  makerE = npcs.entityOf(maker);
  check("the same people back, by their ids", giverE && healerE && makerE);
  check("back: the log as it was", last("questLog")?.active.some((a) => a.id === "q:probe/3") && last("questLog").done.includes("q:probe/1"));
  window = await talk(makerE);
  check("the maker's talk done on talking", state(3)?.state === "ready");
  await send({ type: "questComplete", npc: makerE.id, quest: "q:probe/3", choice: 0 });

  // 4. Pick up items lying on the ground.
  await send({ type: "questAccept", npc: makerE.id, quest: "q:probe/4" });
  await send({ type: "teleport", x: field.x, z: field.z }, 10);
  const objects = [...server.debug.dimensions.get("mainland").entities.values()].filter((e) => e.key.startsWith("qo:q:probe/4"));
  check("ground objects stand in the field", objects.length === rules.quests.objects.count, String(objects.length));
  for (const object of objects.slice(0, 3)) {
    await send({ type: "teleport", x: object.x + 1, z: object.z }, 2);
    await send({ type: "questObjectTake", entity: object.id });
  }
  check("three picked", state(4)?.counts[0] === 3 && state(4)?.state === "ready", JSON.stringify(state(4)));
  check("a taken one is gone", !server.debug.dimensions.get("mainland").entities.has(objects[0].id));
  await send({ type: "questObjectTake", entity: objects[3].id });
  check("one more is not needed", last("questRefused")?.reason === "notNeeded" || last("questRefused")?.reason === "range");
  window = await talk(makerE);
  await send({ type: "questComplete", npc: makerE.id, quest: "q:probe/4", choice: 0 });

  // 5. Talk to an NPC and get a quest item.
  await send({ type: "questAccept", npc: makerE.id, quest: "q:probe/5" });
  const salve = items.typeIndex.get("herbalSalve");
  const salveSlot = () => me.belongings.bag.findIndex((x) => x != null && server.debug.items.ctx.store.get(x).type === salve);
  check("the salve received on taking it", salveSlot() >= 0 && state(5)?.state === "ready");
  await send({ type: "questComplete", npc: makerE.id, quest: "q:probe/5", choice: 0 });
  check("...and kept for the next part", done(5) && salveSlot() >= 0);
  await send({ type: "itemDrop", from: { container: 0, slot: salveSlot() }, count: 0 });
  check("a quest item cannot be dropped", salveSlot() >= 0);

  // 6. Use the quest item on an enemy.
  await send({ type: "questAccept", npc: makerE.id, quest: "q:probe/6" });
  const beast = server.debug.creatures.debug.spawn("mainland", kind, me.x + 3, me.z, 1);
  await send({ type: "target", id: beast.id });
  await send({ type: "itemUse", from: { container: 0, slot: salveSlot() } }, 70);
  check("the salve used on a beast counts", state(6)?.state === "ready", JSON.stringify(state(6)));

  // 7. Talk to an NPC to finish - with the rewards.
  window = await talk(giverE);
  check("ready at the first giver", window?.quests.some((q) => q.id === "q:probe/6" && q.state === "ready"));
  await send({ type: "questComplete", npc: giverE.id, quest: "q:probe/6", choice: 9 });
  check("an item must be chosen", last("questRefused")?.reason === "choose");
  before = xpTotal();
  const money = me.belongings.wallet[items.main];
  const standing = me.standing.get(folk) ?? 3000;
  await send({ type: "questComplete", npc: giverE.id, quest: "q:probe/6", choice: 1 });
  check("the chain done", done(6));
  check("XP", xpTotal() > before);
  check("money", me.belongings.wallet[items.main] === money + 75, String(me.belongings.wallet[items.main] - money));
  check("standing with the folk", me.standing.get(folk) === standing + 250, String(me.standing.get(folk)));
  const chosen = items.typeIndex.get(choice[1]);
  check("the item chosen", me.belongings.bag.some((x) => x != null && server.debug.items.ctx.store.get(x).type === chosen));
  check("the salve taken back", salveSlot() < 0);
  check("done once: not offered again", !(await talk(giverE)).quests.some((q) => q.id === "q:probe/1"));

  // Abandoning and failing leave nothing behind.
  const timed = quest(7, { giver, ender: giver, requires: { quests: [], level: 1 }, within: 2, objectives: [{ kind: "receive", item: "sealedLetter", from: maker, line: t("Fetch the letter") }] });
  server.debug.quests.define([timed]);
  await talk(giverE);
  await send({ type: "questAccept", npc: giverE.id, quest: "q:probe/7" });
  await pump(5, 1);
  check("out of time: failed", state(7)?.state === "failed");
  await send({ type: "questAbandon", quest: "q:probe/7" });
  check("abandoned: gone, and can be taken again", !state(7) && (await talk(giverE)).quests.some((q) => q.id === "q:probe/7" && q.state === "offer"));
});

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
