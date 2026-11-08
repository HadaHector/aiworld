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
import { fillText } from "../../src/sim/text.ts";
import { composeChain, themeFits } from "../../src/sim/quests/chains.ts";
import { questOrder } from "../../src/sim/quests/generator.ts";

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

// --- segments: the pieces fit together, whatever the world ---
/** Every chain the rules could make, by walking from each opener, ignoring what a settlement has:
 *  of these themes (any free segments if none), between `min` and `max` segments. */
function chainsOf(q, { themes = null, min = 1, max = q.chain.max } = {}) {
  const segments = [...q.segments.values()];
  const allowed = (s) => s.weight > 0 && (themes ? s.theme.some((t) => themes.includes(t)) : s.free);
  const found = [];
  const walk = (chain) => {
    const last = chain[chain.length - 1];
    if (last.roles.includes("closer") && chain.length >= min) found.push(chain);
    if (chain.length >= max || (chain.length > 1 && !last.roles.includes("middle"))) return;
    const final = chain.length + 1 >= max;
    for (const s of segments) {
      if (!allowed(s) || chain.includes(s) || !(s.roles.includes("closer") || (!final && s.roles.includes("middle"))) || !themeFits(chain, s)) continue;
      if (composeChain("", [...chain, s])) walk([...chain, s]);
    }
  };
  for (const s of segments) if (allowed(s) && s.roles.includes("opener")) walk([s]);
  return found;
}
/** The objective kinds a chain asks, in order. */
const kindsOf = (q, chain) => chain.flatMap((s) => s.quest.parts.map((p) => q.parts.get(p.part).kind));

await section("segments", async () => {
  const q = loadRulesFromDisk(CONFIG).quests;
  const segments = [...q.segments.values()];
  check("there are segments of each role", ["opener", "middle", "closer"].every((r) => segments.some((s) => s.roles.includes(r))));
  // The free chains.
  const free = chainsOf(q);
  const reached = new Set(free.flat().map((s) => s.id));
  for (const s of segments) if (s.weight > 0 && s.free && s.roles.includes("opener")) check(`opener ${s.id} reaches a closer`, free.some((c) => c[0] === s));
  for (const s of segments) if (s.weight > 0 && s.free && s.theme.every((t) => !q.plots.some((p) => p.draw?.themes.includes(t)))) check(`segment ${s.id} is on some free chain`, reached.has(s.id));
  log(`${segments.length} segments, ${free.length} possible free chains of at most ${q.chain.max}`);
  check("a good number of different free chains", free.length >= 15, String(free.length));
  // The plots that draw a chain (the intro's story): every one it could be.
  for (const plot of q.plots.filter((p) => p.draw)) {
    const variants = chainsOf(q, plot.draw);
    log(`${plot.id}: ${variants.length} possible stories of ${plot.draw.min} to ${plot.draw.max}`);
    check(`${plot.id}: several stories`, variants.length >= 6, String(variants.length));
    const used = new Set(variants.flat().map((s) => s.id));
    for (const s of segments) if (s.theme.some((t) => plot.draw.themes.includes(t)) && s.weight > 0) check(`${plot.id}: ${s.id} is in some story`, used.has(s.id));
    const startsOf = new Set(variants.map((c) => c[0].id));
    check(`${plot.id}: more than one start`, startsOf.size >= 2, [...startsOf].join());
    const endsOf = new Set(variants.map((c) => c.at(-1).id));
    check(`${plot.id}: more than one ending`, endsOf.size >= 2, [...endsOf].join());
    check(`${plot.id}: a twist is possible`, variants.some((c) => c.some((s) => s.provides.some((t) => t.startsWith("twist:")))));
    // GAMEPLAY.md's test chain is one of them: talk, kill and loot, talk, gather, receive, use, talk.
    check(`${plot.id}: the test chain is one of them`, variants.some((c) => kindsOf(q, c).join() === "talk,kill,loot,talk,gather,receive,use"));
  }
  // A recipe or chain that breaks its own rules does not compose.
  const get = (id) => q.segments.get(id);
  check("a closer cannot start a chain that wants what it lacks", composeChain("x", [get("sicknessTry")]) === null);
  check("segments out of order do not fit", composeChain("x", [get("sicknessAsk"), get("sicknessHerbs")]) === null);
  check("a curse does not follow a sickness", composeChain("x", [get("sicknessAsk"), get("sicknessSample"), get("curseSigns")]) === null);
  check("the same help is not asked twice", composeChain("x", [get("sicknessAsk"), get("sicknessSample"), get("sicknessMaker"), get("makerGone")]) === null);
  check("wanting creatures nobody is does not fit", composeChain("x", [{ ...get("foldTrouble"), creatures: { hostility: ["hostile"], family: null } }, { ...get("pelts"), roles: ["middle"], creatures: { hostility: ["friendly"], family: null } }]) === null);
  // Someone who is gone can be spoken of, never met.
  const dead = { ...get("makerGone"), quest: { ...get("makerGone").quest, ender: "gone" } };
  check("a quest cannot be ended by someone who is gone", composeChain("x", [get("sicknessAsk"), get("sicknessSample"), dead]) === null);
});

// --- the order the world's quests are made in ---
await section("quest order", () => {
  const ids = Array.from({ length: 40 }, (_, i) => i);
  const a = questOrder(1, "mainland", ids);
  check("a permutation of the settlements", [...a].sort((x, y) => x - y).join() === ids.join());
  check("the same however they are listed", questOrder(1, "mainland", [...ids].reverse()).join() === a.join());
  check("shuffled, not in id order", a.join() !== ids.join());
  check("different for another seed", questOrder(2, "mainland", ids).join() !== a.join());
});

// --- the generator: every settlement's quests, well formed, the same for the same seed ---
/** A server on a config and seed, with one quick player at the start; its casts made on asking. */
async function generatedWorld(config, seed) {
  const { content, packs } = loadContentFromDisk(config);
  const rules = loadRulesFromDisk(config);
  const creatures = loadCreatureRulesFromDisk(config, rules, seed);
  const progression = loadProgressionRulesFromDisk(config, rules, seed);
  const items = loadItemRulesFromDisk(config, rules, seed);
  const worldData = quiet(() => createWorldData(seed, content));
  const server = createServer({ seed, config, packs, dimensions: content.dimensions, rules, creatures, items, progression, loadDimension: () => ({ world: worldData }) });
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "Scout", dimension: "" });
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    server.step(1 / 30);
    for (const m of channel.client.receive()) if (m.type === "transfer") channel.client.send({ type: "arrived" });
  }
  // Every settlement's quests exist as soon as the dimension has loaded, with no one near them.
  const quests = [];
  for (const l of worldData.settlementLayouts) for (let n = 0; ; n++) {
    const def = server.debug.quests.def(`q:mainland/${l.siteId}/${n}`);
    if (!def) break;
    quests.push(def);
  }
  const casts = new Map(worldData.settlementLayouts.map((l) => [l.siteId, server.debug.npcs.debug.cast("mainland", l.siteId)]));
  return { server, rules, items, worldData, casts, quests, channel };
}

await section("the generator", async () => {
  /** The stories the intro drew across these worlds. */
  const seen = new Set();
  for (const [config, seeds] of [["tiny", 3], ["small", 3]]) {
    for (let s = 0; s < seeds; s++) {
      const seed = 4000 + s * 911;
      const tag = `${config} seed ${seed}`;
      const w = await generatedWorld(config, seed);
      const again = await generatedWorld(config, seed);
      check(`${tag}: every settlement has quests before anyone is near`, w.worldData.settlementLayouts.every((l) => w.quests.some((q) => q.id.startsWith(`q:mainland/${l.siteId}/`))), `${w.quests.length} quests`);
      check(`${tag}: the same quests twice`, JSON.stringify(w.quests) === JSON.stringify(again.quests));
      const npcIds = new Map();
      for (const cast of w.casts.values()) for (const n of cast?.npcs ?? []) npcIds.set(n.id, n);
      const [start] = w.server.debug.starts.get("mainland");
      const startQuests = w.quests.filter((q) => q.id.startsWith(`q:mainland/${start.settlement}/`));
      // The intro is one chain: the welcome, a story drawn for this world, and the letter on.
      let length = 1;
      while (length < startQuests.length && startQuests[length].requires.quests[0] === startQuests[length - 1].id) length++;
      const intro = startQuests.slice(0, length);
      const story = intro.filter((q) => q.chain);
      const plot = w.rules.quests.plots.find((p) => p.draw);
      check(`${tag}: the start has an intro of ${length}, its story ${story.length}`, story.length >= plot.draw.min && story.length <= plot.draw.max, String(story.length));
      const first = npcIds.get(intro[0]?.giver);
      check(`${tag}: the intro begins with the reeve`, first?.role === "reeve", first?.role);
      const kinds = story.flatMap((q) => q.objectives.map((o) => o.kind)).join();
      const stories = chainsOf(w.rules.quests, plot.draw).map((c) => kindsOf(w.rules.quests, c).join());
      check(`${tag}: its story is one the rules can make`, stories.includes(kinds), kinds);
      seen.add(story[0]?.chain?.id.split("#").slice(1).join("#"));
      const letter = intro.at(-1);
      const to = npcIds.get(letter?.ender);
      check(`${tag}: the road on to another settlement`, letter?.objectives.at(-1)?.kind === "deliver" && to && !to.id.startsWith(`npc:mainland/${start.settlement}/`), letter?.ender);
      check(`${tag}: an item to choose at the story's end`, story.at(-1)?.rewards.choice.length >= 2, JSON.stringify(story.at(-1)?.rewards.choice));
      let bad = 0;
      for (const q of w.quests) {
        const site = Number(q.id.split("/")[1]);
        const layout = w.worldData.settlementLayouts.find((l) => l.siteId === site);
        const problems = [];
        if (!npcIds.has(q.giver)) problems.push("giver");
        if (!npcIds.has(q.ender)) problems.push("ender");
        for (const o of q.objectives) {
          if ((o.kind === "talk" && !npcIds.has(o.npc)) || (o.kind === "receive" && !npcIds.has(o.from)) || (o.kind === "deliver" && !npcIds.has(o.to))) problems.push(`${o.kind} npc`);
          if ((o.kind === "receive" || o.kind === "use" || o.kind === "deliver") && !w.items.typeIndex.has(o.item)) problems.push(`item ${o.item}`);
          if ((o.kind === "kill" || o.kind === "loot" || o.kind === "use") && (o.kind === "loot" ? o.from : o.kind === "use" ? o.on : o.creatures).kinds.length === 0) problems.push(`${o.kind} creatures`);
          if ((o.kind === "gather" || o.kind === "reach") && Math.hypot(o.area.x - layout.x, o.area.z - layout.z) > w.rules.quests.reach + 200) problems.push(`${o.kind} too far`);
          if (fillText(o.line.text, o.line.args).includes("{")) problems.push(`line "${o.line.text}"`);
        }
        for (const text of Object.values(q.text)) {
          if (fillText(text.text, text.args).includes("{")) problems.push(`text "${text.text.slice(0, 40)}"`);
          // An argument that is there but empty makes a hole in a sentence.
          for (const [, name] of text.text.matchAll(/\{(\w+)[,}]/g)) if (text.args[name] === "") problems.push(`empty {${name}} in "${text.text.slice(0, 40)}"`);
          if (/ {2}|\[|\]|\|/.test(text.text)) problems.push(`stray markup in "${text.text.slice(0, 40)}"`);
        }
        if (problems.length > 0) {
          bad++;
          if (bad <= 3) log(`  ${q.id}: ${problems.join(", ")}`);
        }
      }
      check(`${tag}: every quest well formed (${w.quests.length})`, bad === 0, `${bad} not`);
      const offers = w.quests.map((x) => fillText(x.text.offer.text, x.text.offer.args));
      check(`${tag}: no two offers the same`, new Set(offers).size === offers.length, `${offers.length - new Set(offers).size} repeated`);
      const free = w.quests.filter((x) => x.chain && !x.id.startsWith(`q:mainland/${start.settlement}/`) && x.chain.index > 1);
      log(`${tag}: ${free.length} later quests in chains drawn from segments, ${new Set(w.quests.map((x) => x.text.title.text)).size} different titles`);
      const people = [...w.casts.values()].flatMap((c) => c?.npcs ?? []).filter((n) => n.spot);
      log(`${tag}: ${w.quests.length} quests in ${w.casts.size} settlements, ${people.length} quest people (${[...new Set(people.map((p) => p.role))].join(", ")})`);
    }
  }
  log(`the intro drew ${seen.size} different stories in these worlds: ${[...seen].map((x) => x?.replace(/^affliction#/, "")).join("; ")}`);
  check("the worlds drew more than one story", seen.size >= 3, String(seen.size));
  // One offer as a reader sees it.
  const w = await generatedWorld("small", 1338);
  const [start] = w.server.debug.starts.get("mainland");
  const sick = w.quests.find((q) => q.id === `q:mainland/${start.settlement}/1`);
  if (sick) log(`\n${fillText(sick.text.title.text, sick.text.title.args)}\n${fillText(sick.text.offer.text, sick.text.offer.args)}\n`);
});

// --- the intro chain, played: a new character from the start to its gear, with a log out half way ---
// One seed for each kind of story: the curse lifted, the culprit asked, a death on the way, the plain sickness.
for (const introSeed of [2, 7, 8, 15]) await section(`the intro chain (seed ${introSeed})`, async () => {
  const config = "tiny";
  const seed = introSeed;
  const { content, packs } = loadContentFromDisk(config);
  const rules = loadRulesFromDisk(config);
  const creatures = loadCreatureRulesFromDisk(config, rules, seed);
  const progression = loadProgressionRulesFromDisk(config, rules, seed);
  const items = loadItemRulesFromDisk(config, rules, seed);
  const worldData = quiet(() => createWorldData(seed, content));
  const store = createMemoryStore();
  const world = createWorldRecord({ id: "intro", name: "Intro", seed, config, packs: [], hashes: { rules: rules.hash, items: items.hash, creatures: creatures.hash, progression: progression.hash } });
  await store.writeWorld(world);
  const server = createServer({ seed, config, packs, dimensions: content.dimensions, rules, creatures, items, progression, loadDimension: () => ({ world: worldData }), saves: { store, world, interval: 1000 } });
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
  await send({ type: "characterCreate", name: "Novice", origins: {}, look: { seed: 21, race: "human", outfit: "", sex: "" } });
  const character = last("characters").list.find((c) => c.name === "Novice").id;
  await send({ type: "enterWorld", character, dimension: "" }, 15);
  let me = server.debug.entity(id);
  const npcs = server.debug.npcs;
  const [start] = server.debug.starts.get("mainland");
  check("the new character stands in the starting village", Math.hypot(me.x - start.x, me.z - start.z) < 3);
  const intro = [];
  for (let n = 0; ; n++) {
    const def = server.debug.quests.def(`q:mainland/${start.settlement}/${n}`);
    if (!def || (n > 0 && def.requires.quests[0] !== intro[n - 1].id)) break;
    intro.push(def);
  }
  check("the intro is there", intro.length >= 6, String(intro.length));
  const half = Math.floor(intro.length / 2);
  const rewarding = intro.find((q) => q.rewards.choice.length > 0);
  const marks = () => inbox.filter((m) => m.type === "markers").at(-1)?.list ?? [];

  /** The entity of an NPC id, its settlement filled first if it is not (the letter's end is elsewhere). */
  const npcEntity = async (npcId) => {
    let e = npcs.entityOf(npcId);
    if (!e) {
      const site = Number(npcId.split("/")[1]);
      const layout = worldData.settlementLayouts.find((l) => l.siteId === site);
      await send({ type: "teleport", x: layout.square.x, z: layout.square.z }, 5);
      e = npcs.entityOf(npcId);
    }
    return e;
  };
  const goTo = async (npcId) => {
    const npc = await npcEntity(npcId);
    await send({ type: "teleport", x: npc.x + Math.sin(npc.facing) * 1.6, z: npc.z + Math.cos(npc.facing) * 1.6 }, 3);
    return npc;
  };
  const talkTo = async (npcId) => {
    const npc = await goTo(npcId);
    await send({ type: "talk", npc: npc.id });
    return npc;
  };
  const state = (q) => server.debug.quests.export(me).active.find((a) => a.id === q.id);
  const done = (q) => server.debug.quests.export(me).done.includes(q.id);
  const fight = async (kind, health = 0) => {
    const beast = server.debug.creatures.debug.spawn("mainland", kind, me.x + 3, me.z, 1);
    if (health === 0) {
      addThreat(server.debug.skills.sys, beast, me, 10);
      server.debug.skills.kill(beast);
    } else beast.resources.current[rules.health] = beast.resources.max[rules.health] * health;
    await pump(2);
    return beast;
  };
  const adventure = progression.disciplineIndex.get("adventure");
  const startLevel = me.progress.disciplines.get(adventure).level;

  for (const [n, q] of intro.entries()) {
    const giver = await npcEntity(q.giver);
    // The giver's mark, before taking it.
    await goTo(q.giver);
    await pump(16);
    check(`${n + 1}: "!" over its giver`, marks().some(([e, m]) => e === giver.id && m === "!"), JSON.stringify(marks()));
    await talkTo(q.giver);
    check(`${n + 1}: offered`, last("npcWindow")?.quests.some((x) => x.id === q.id && x.state === "offer"), JSON.stringify(last("npcWindow")?.quests));
    await send({ type: "questAccept", npc: giver.id, quest: q.id });
    for (const [i, o] of q.objectives.entries()) {
      const at = () => state(q)?.counts[i] ?? (done(q) ? Infinity : 0);
      if (o.kind === "talk") await talkTo(o.npc);
      else if (o.kind === "receive") await talkTo(o.from);
      else if (o.kind === "deliver") await talkTo(o.to);
      else if (o.kind === "kill") for (let k = 0; k < o.count; k++) await fight(o.creatures.kinds[0]);
      else if (o.kind === "loot") for (let k = 0; k < 30 && at() < o.count; k++) await fight(o.from.kinds[0]);
      else if (o.kind === "gather") {
        await send({ type: "teleport", x: o.area.x, z: o.area.z }, 10);
        const objects = [...server.debug.dimensions.get("mainland").entities.values()].filter((e) => e.key.startsWith(`qo:${q.id}/${i}/`));
        for (const object of objects.slice(0, o.count)) {
          await send({ type: "teleport", x: object.x + 1, z: object.z }, 2);
          await send({ type: "questObjectTake", entity: object.id });
        }
      } else if (o.kind === "use") {
        const beast = await fight(o.on.kinds[0], Math.min(o.below, 0.5));
        await send({ type: "target", id: beast.id });
        const slot = me.belongings.bag.findIndex((x) => x != null && server.debug.items.ctx.store.get(x).type === items.typeIndex.get(o.item));
        await send({ type: "itemUse", from: { container: 0, slot } }, 80);
      } else if (o.kind === "reach") await send({ type: "teleport", x: o.area.x, z: o.area.z }, 20);
      check(`${n + 1}: ${o.kind} done`, at() >= ("count" in o ? o.count : 1), JSON.stringify(state(q)));
    }
    check(`${n + 1}: ready`, state(q)?.state === "ready", JSON.stringify(state(q)));
    const ender = await talkTo(q.ender);
    await send({ type: "questComplete", npc: ender.id, quest: q.id, choice: 0 });
    check(`${n + 1}: "${fillText(q.text.title.text, q.text.title.args)}" handed in`, done(q), JSON.stringify(last("questRefused")));
    if (n === half - 1) {
      // Half way: log out and back in.
      await send({ type: "logout", toMenu: false }, 10);
      await send({ type: "enterWorld", character, dimension: "" }, 15);
      me = server.debug.entity(id);
      check(`back half way: the ${half} done, kept`, intro.slice(0, half).every(done));
    }
  }
  const level = me.progress.disciplines.get(adventure).level;
  check("a level or more gained", level > startLevel, `${startLevel} -> ${level}`);
  check("money earned", me.belongings.wallet[items.main] > 0, String(me.belongings.wallet[items.main]));
  const reward = items.typeIndex.get(rewarding.rewards.choice[0]);
  const slot = me.belongings.bag.findIndex((x) => x != null && server.debug.items.ctx.store.get(x).type === reward);
  check("the chosen reward in the bag", slot >= 0, rewarding.rewards.choice.join());
  await send({ type: "itemEquip", from: { container: 0, slot } });
  check("...and worn", me.belongings.equipment.some((x) => x != null && server.debug.items.ctx.store.get(x).type === reward), JSON.stringify(last("itemRefused")));
  check("standing with the village's folk", [...me.standing.values()].some((v) => v > 3000), JSON.stringify([...me.standing]));
  log(`the intro (seed ${seed}, ${intro.filter((q) => q.chain).map((q) => q.objectives.map((o) => o.kind).join("+")).join(" / ")}): level ${startLevel} -> ${level}, ${me.belongings.wallet[items.main]} copper, wearing ${items.types[reward].name}`);
});

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
