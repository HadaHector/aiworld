// The NPCs test (NPCS.md): factions and standing - read from the packs, templates' factions, who is
// an ally or an enemy, generated factions, and a player's standing kept, told and saved on a real
// `tiny` server. Later steps add casts, NPCs in the world and their services.
//   npm run probe -- scripts/probe/npcs.mjs
import { ContentError } from "../../src/world/content/contentReader.ts";
import { loadContentFromDisk, loadCreatureRulesFromDisk, loadItemRulesFromDisk, loadProgressionRulesFromDisk, loadRulesFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { fillText } from "../../src/core/text.ts";
import { chooseStarts } from "../../src/world/settlements/starts.ts";
import { castForSettlement } from "../../src/sim/npcs/cast.ts";
import { resolveGameRules } from "../../src/sim/rules/gameRules.ts";
import { factionDef, standingBetween, standingWith, tierOf } from "../../src/sim/factions.ts";
import { relation } from "../../src/sim/skills/unit.ts";
import { createWorldData } from "../../src/world/worldData.ts";
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
const sources = packSourcesFromDisk(readConfigFromDisk(CONFIG)).sources;
const withProbePack = (files) => resolveGameRules([...sources, { id: "probe", files: [{ path: "pack.json5", text: "{ name: 'Probe', priority: 100 }" }, ...Object.entries(files).map(([path, text]) => ({ path, text }))] }]);
function refused(files, what, pattern) {
  try {
    withProbePack(files);
    check(`${what} refused`, false, "it loaded");
  } catch (error) {
    check(`${what} refused`, error instanceof ContentError && error.issues.some((i) => pattern.test(i.message)), error.message);
  }
}

await section("factions", () => {
  const game = loadRulesFromDisk(CONFIG);
  const creatures = loadCreatureRulesFromDisk(CONFIG, game, SEED);
  const f = game.factions;
  check("core's factions", ["players", "monsters", "wildlife", "bandits", "folk"].every((id) => f.factions.has(id)), [...f.factions.keys()].join());
  check("eight tiers, hated to exalted", f.tiers.length === 8 && f.tiers[0].id === "hated" && f.tiers[7].id === "exalted");
  check("ally from friendly, hostile below unfriendly", f.ally === 3000 && f.hostile === -3000, `${f.ally} ${f.hostile}`);
  const factionOf = (id) => (game.templates.get(id) ?? creatures.kinds.get(id)?.template)?.faction;
  check("players are players", factionOf("player") === "players");
  check("wolves are monsters, by their hostility", factionOf("wolf.timber") === "monsters");
  check("boars are wildlife", factionOf("boar.bristle") === "wildlife");
  check("bandits are bandits", factionOf("bandit.thug") === "bandits");
  check("the dummy is a monster", factionOf("trainingDummy") === "monsters");
  check("a generated faction reads its template", factionDef(f, "folk@mainland/3")?.id === "folk");
  const player = { faction: "players", standing: new Map() };
  check("the folk start friendly to a player", tierOf(f, standingWith(f, player, "folk@mainland/3")).id === "friendly");
  player.standing.set("folk@mainland/3", 9500);
  check("earned standing counts", standingBetween(f, player, { faction: "folk@mainland/3" }) === 9500 && tierOf(f, 9500).id === "honoured");
  check("...only with that zone's folk", standingWith(f, player, "folk@mainland/4") === 3000);
  check("bandits hate the folk", standingBetween(f, { faction: "bandits" }, { faction: "folk@mainland/3" }) === -42000);
  check("monsters and wildlife leave each other be", standingBetween(f, { faction: "monsters" }, { faction: "wildlife" }) === 0);

  // A faction's hostility follows when a template names a faction and no hostility.
  const probe = withProbePack({ "entities/villager.json5": "{ name: 'Villager', faction: 'folk' }", "entities/thief.json5": "{ name: 'Thief', faction: 'bandits' }" });
  check("a folk template is friendly", probe.templates.get("villager").hostility === "friendly");
  check("a bandit template is hostile", probe.templates.get("thief").hostility === "hostile");
  refused({ "entities/zz.json5": "{ faction: 'nope' }" }, "an unknown faction", /no faction "nope"/);
  refused({ "factions/zz.json5": "{ relations: { nope: 'friendly' } }" }, "a relation to an unknown faction", /no faction "nope"/);
  refused({ "factions/zz.json5": "{ relations: { players: 'chummy' } }" }, "an unknown tier", /expected a number or a tier/);
});

// --- casts: the people of a settlement, invented from relations, the same every time ---
await section("casts", () => {
  for (const [config, seeds] of [["tiny", 4], ["small", 4]]) {
    const { content } = loadContentFromDisk(config);
    const game = loadRulesFromDisk(config);
    for (let s = 0; s < seeds; s++) {
      const seed = 2000 + s * 6007;
      const progression = loadProgressionRulesFromDisk(config, game, seed);
      const classes = progression.origins.filter((o) => o.slot === "class").map((o) => ({ id: o.id, name: o.name }));
      const world = quiet(() => createWorldData(seed, content));
      const starts = new Set(chooseStarts(world, content.dimension).map((x) => x.settlement));
      const context = { seed, dimension: content.dimension.id, voices: content.voices, rules: game.npcs, classes, starts };
      const tag = `${config} seed ${seed}`;
      let people = 0;
      for (const layout of world.settlementLayouts) {
        const cast = castForSettlement(world, layout.siteId, context);
        const again = castForSettlement(world, layout.siteId, context);
        const where = `${tag} #${layout.siteId}`;
        check(`${where}: the same twice`, JSON.stringify(cast) === JSON.stringify(again));
        people += cast.npcs.length;
        const has = (b) => layout.houses.some((h) => h.building.id === b);
        const holders = (role) => cast.npcs.filter((n) => n.role === role);
        if (has("inn")) check(`${where}: an innkeeper for its inn`, holders("innkeeper").length === layout.houses.filter((h) => h.building.id === "inn").length);
        if (has("chapel")) check(`${where}: a priest for its chapel`, holders("priest").length >= 1);
        if (has("smithy")) check(`${where}: a smith for its smithy`, holders("smith").length >= 1);
        check(`${where}: one reeve`, holders("reeve").length === 1);
        if (starts.has(layout.siteId)) check(`${where}: a trainer for every class at the start`, classes.every((c) => cast.npcs.some((n) => n.role === "classTrainer" && n.class === c.id)), cast.npcs.filter((n) => n.class).map((n) => n.class).join());
        check(`${where}: every role holder is out`, cast.npcs.every((n) => !n.role || n.out));
        check(`${where}: ids by settlement and index`, cast.npcs.every((n, i) => n.id === `npc:${content.dimension.id}/${layout.siteId}/${i}` && n.index === i));
        check(`${where}: names unique`, new Set(cast.npcs.map((n) => n.name)).size === cast.npcs.length);
        check(`${where}: a household shares its family name`, cast.households.every((h) => h.members.every((m) => cast.npcs[m].family === h.family && cast.npcs[m].household === h.index)));
        const ages = ["young", "adult", "old"];
        let symmetric = true;
        let older = true;
        let alike = true;
        for (const n of cast.npcs) {
          for (const r of n.relations) {
            const back = cast.npcs[r.to].relations.find((x) => x.to === n.index && x.relation === r.relation);
            if (!back) symmetric = false;
            if (r.relation === "parentChild" && ["son", "daughter"].includes(r.call)) {
              const child = cast.npcs[r.to];
              if (ages.indexOf(n.age) <= ages.indexOf(child.age)) older = false;
              if (child.choices.skin !== n.choices.skin && cast.npcs.filter((p) => p.relations.some((x) => x.to === child.index && x.relation === "parentChild")).every((p) => p.choices.skin !== child.choices.skin)) alike = false;
            }
          }
        }
        check(`${where}: relations go both ways`, symmetric);
        check(`${where}: parents are older than their children`, older);
        check(`${where}: a child takes after a parent`, alike);
      }
      log(`${tag}: ${world.settlementLayouts.length} settlements, ${people} people`);
    }
  }
});

await section("server", async () => {
  const { content, packs } = loadContentFromDisk(CONFIG);
  const rules = loadRulesFromDisk(CONFIG);
  const creatures = loadCreatureRulesFromDisk(CONFIG, rules, SEED);
  const worldData = quiet(() => createWorldData(SEED, content));
  const store = createMemoryStore();
  const world = createWorldRecord({ id: "probe", name: "Probe", seed: SEED, config: CONFIG, packs: [], hashes: { rules: rules.hash, items: 0, creatures: 0, progression: 0 } });
  await store.writeWorld(world);
  const server = createServer({ seed: SEED, config: CONFIG, packs, dimensions: content.dimensions, rules, creatures, loadDimension: () => ({ world: worldData }), saves: { store, world, interval: 5 } });
  const clients = [];
  const connect = (hello) => {
    const channel = createLocalChannel();
    server.connect(channel.server);
    channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "", dimension: "", ...hello });
    const client = { id: 0, inbox: [], channel, send: (m) => channel.client.send(m), all: (type) => client.inbox.filter((m) => m.type === type), last: (type) => client.inbox.filter((m) => m.type === type).at(-1) };
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

  // Who is an enemy of whom, on a live server.
  const a = connect({ select: true });
  await pump(2);
  a.send({ type: "characterCreate", name: "Reeve", origins: {}, look: { seed: 3, race: "human", outfit: "", sex: "" } });
  await pump(3);
  const id = a.last("characters").list.find((c) => c.name === "Reeve").id;
  a.send({ type: "enterWorld", character: id, dimension: "" });
  await pump(15);
  const me = server.debug.entity(a.id);
  check("a player has standing", me?.standing instanceof Map);
  check("told its standing on arriving", a.last("standing")?.values.length === 0, JSON.stringify(a.last("standing")));
  const sys = server.debug.skills.sys;
  const S = server.debug.creatures.debug;
  const wolf = S.spawn("mainland", "wolf.timber", me.x + 30, me.z, 1);
  const boar = S.spawn("mainland", "boar.bristle", me.x - 30, me.z, 1);
  const thug = S.spawn("mainland", "bandit.thug", me.x, me.z + 30, 1);
  check("a wolf is an enemy", relation(sys, me, wolf) === "enemy" && relation(sys, wolf, me) === "enemy");
  check("a neutral boar can be attacked", relation(sys, me, boar) === "enemy");
  check("the wolf and the boar leave each other be", relation(sys, wolf, boar) === "none");
  check("a bandit and a wolf leave each other be", relation(sys, thug, wolf) === "none");
  for (const e of [wolf, boar, thug]) S.despawn?.(e);

  // Standing: changed, told, kept, saved.
  const folk = "folk@mainland/3";
  a.send({ type: "debugStanding", faction: folk, delta: 250 });
  await pump(2);
  check("standing moves", me.standing.get(folk) === 3250, String(me.standing.get(folk)));
  check("the change is told", a.last("standing")?.values.some(([f, v]) => f === folk && v === 3250), JSON.stringify(a.last("standing")));
  check("a faction without reputation does not move", server.debug.changeStanding(me, "monsters", 100) === null && !me.standing.has("monsters"));
  check("standing stays on the scale", server.debug.changeStanding(me, folk, 1e9) === rules.factions.max);
  server.debug.changeStanding(me, folk, -(rules.factions.max - 3250));
  a.send({ type: "logout", toMenu: false });
  await pump(10);
  check("saved with the character", (await store.readCharacter("probe", id))?.standing?.[folk] === 3250, JSON.stringify((await store.readCharacter("probe", id))?.standing));
  a.send({ type: "enterWorld", character: id, dimension: "" });
  await pump(15);
  check("back after entering again", server.debug.entity(a.id)?.standing.get(folk) === 3250);
  check("told it all again", a.last("standing")?.values.some(([f, v]) => f === folk && v === 3250));
});

// --- NPCs in the world: filled near a player, at their spots, barking, dying, dropped ---
await section("in the world", async () => {
  const { content, packs } = loadContentFromDisk(CONFIG);
  const rules = loadRulesFromDisk(CONFIG);
  const progression = loadProgressionRulesFromDisk(CONFIG, rules, SEED);
  const worldData = quiet(() => createWorldData(SEED, content));
  const server = createServer({ seed: SEED, config: CONFIG, packs, dimensions: content.dimensions, rules, progression, loadDimension: () => ({ world: worldData }) });
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "Visitor", dimension: "" });
  const inbox = [];
  let id = 0;
  const pump = async (steps = 1, dt = 1 / 30) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      server.step(dt);
      for (const m of channel.client.receive()) {
        if (m.type === "welcome") id = m.playerId;
        if (m.type === "transfer") channel.client.send({ type: "arrived" });
        inbox.push(m);
      }
    }
  };
  await pump(5);
  const npcs = server.debug.npcs;
  const [start] = server.debug.starts.get("mainland");
  const cast = npcs.debug.cast("mainland", start.settlement);
  const out = cast.npcs.filter((n) => n.out);
  let active = npcs.debug.active("mainland");
  check("the starting village is filled", active.length === out.length && out.length > 3, `${active.length} of ${out.length}`);
  const spawns = inbox.filter((m) => m.type === "entitySpawn" && m.title !== undefined);
  const innkeeper = active.find((e) => npcs.npcOf(e)?.role === "innkeeper");
  check("the innkeeper is made from the innkeeper template, and banks", innkeeper?.template.id === "innkeeper");
  check("its name and title from the cast", innkeeper?.name === npcs.npcOf(innkeeper).name && innkeeper?.title === "Innkeeper");
  check("spawns carry the title", spawns.some((m) => m.id === innkeeper?.id && m.title === "Innkeeper"));
  check("its look from the cast", innkeeper?.look.race === npcs.npcOf(innkeeper).race && innkeeper.look.choices?.skin === npcs.npcOf(innkeeper).choices.skin);
  const site = worldData.settlements.find((s) => s.id === start.settlement);
  check("its zone's folk", innkeeper?.faction === `folk@mainland/${site.areaId}`, innkeeper?.faction);
  const me = server.debug.entity(id);
  check("a player and the folk are allies", relation(server.debug.skills.sys, me, innkeeper) === "ally");
  // Indoors: inside its inn's footprint, on its floor.
  const layout = worldData.settlementLayouts.find((l) => l.siteId === start.settlement);
  const inn = layout.houses[npcs.npcOf(innkeeper).work];
  const local = { a: (innkeeper.x - inn.x) * inn.frontX + (innkeeper.z - inn.z) * inn.frontZ, b: (innkeeper.x - inn.x) * inn.frontZ - (innkeeper.z - inn.z) * inn.frontX };
  check("the innkeeper stands inside the inn", Math.abs(local.a) < inn.depth / 2 + 6 && Math.abs(local.b) < inn.width / 2 + 6, JSON.stringify(local));
  const spots = active.map((e) => [e.x, e.z]);
  check("nobody stands on anyone", spots.every(([x, z], i) => spots.every(([x2, z2], j) => i === j || Math.hypot(x - x2, z - z2) >= 1.1)));
  check("every one within the village", active.every((e) => Math.hypot(e.x - layout.x, e.z - layout.z) <= layout.radius + 15));

  // A bark for a player who comes by.
  const near = active.find((e) => npcs.npcOf(e)?.role !== "innkeeper") ?? innkeeper;
  channel.client.send({ type: "teleport", x: near.x + 2, z: near.z });
  await pump(20);
  const bark = inbox.find((m) => m.type === "bark");
  check("an NPC barks at a player who comes by", bark !== undefined && fillText(bark.text, bark.args).length > 0 && !fillText(bark.text, bark.args).includes("{"), JSON.stringify(bark));

  // Killed: lies a while, goes, comes back after its respawn.
  const victim = near;
  const victimId = npcs.npcOf(victim).id;
  server.debug.skills.kill(victim);
  await pump(25, 1);
  check("a dead NPC is taken away", !npcs.debug.active("mainland").includes(victim));
  check("...into the delta", (server.debug.delta.get(victimId) ?? 0) > server.time);
  await pump(200, 1);
  active = npcs.debug.active("mainland");
  check("...and comes back", active.some((e) => npcs.npcOf(e)?.id === victimId));

  // Away: dropped once nobody has been near for long enough.
  channel.client.send({ type: "teleport", x: layout.x + 900, z: layout.z });
  await pump(40, 1);
  check("dropped when nobody is near", npcs.debug.active("mainland").length === 0);
});

// --- services: talking, the shop, mending, the inn ---
await section("services", async () => {
  const { content, packs } = loadContentFromDisk(CONFIG);
  const rules = loadRulesFromDisk(CONFIG);
  const progression = loadProgressionRulesFromDisk(CONFIG, rules, SEED);
  const items = loadItemRulesFromDisk(CONFIG, rules, SEED);
  const worldData = quiet(() => createWorldData(SEED, content));
  const server = createServer({ seed: SEED, config: CONFIG, packs, dimensions: content.dimensions, rules, progression, items, loadDimension: () => ({ world: worldData }) });
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "Customer", dimension: "" });
  const inbox = [];
  let id = 0;
  const pump = async (steps = 1) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      server.step(1 / 30);
      for (const m of channel.client.receive()) {
        if (m.type === "welcome") id = m.playerId;
        if (m.type === "transfer") channel.client.send({ type: "arrived" });
        inbox.push(m);
      }
    }
  };
  const last = (type) => inbox.filter((m) => m.type === type).at(-1);
  const send = async (m, steps = 2) => {
    channel.client.send(m);
    await pump(steps);
  };
  await pump(5);
  const npcs = server.debug.npcs;
  const me = server.debug.entity(id);
  const by = (role) => npcs.debug.active("mainland").find((e) => npcs.npcOf(e)?.role === role);
  const goTo = async (npc) => send({ type: "teleport", x: npc.x + Math.sin(npc.facing) * 1.6, z: npc.z + Math.cos(npc.facing) * 1.6 }, 3);
  const main = items.main;

  const smith = by("smith");
  check("the start has a smith", smith !== undefined);
  await send({ type: "teleport", x: smith.x + 30, z: smith.z });
  await send({ type: "talk", npc: smith.id });
  check("too far to talk", last("npcRefused")?.reason === "range");
  await goTo(smith);
  await send({ type: "talk", npc: smith.id });
  const window = last("npcWindow");
  check("talking opens its window", window?.npc === smith.id && window.repair && window.stock.length > 0 && window.sellRate > 0, JSON.stringify(window)?.slice(0, 200));
  check("...with a greeting", typeof window?.greeting === "string" && window.greeting.length > 0 && !fillText(window.greeting, window.greetingArgs).includes("{"));
  check("it turns to the player", Math.abs(Math.atan2(me.x - smith.x, me.z - smith.z) - smith.facing) < 1e-6);
  me.belongings.wallet[main] = 0;
  await send({ type: "shopBuy", npc: smith.id, index: 0 });
  check("no money, no sale", last("npcRefused")?.reason === "money");
  const price = window.stock[0].price;
  me.belongings.wallet[main] = price + 10;
  const bagBefore = me.belongings.bag.filter((x) => x != null).length;
  await send({ type: "shopBuy", npc: smith.id, index: 0 });
  check("bought: in the bag, paid for", me.belongings.bag.filter((x) => x != null).length === bagBefore + 1 && me.belongings.wallet[main] === 10, String(me.belongings.wallet[main]));
  check("...and told", last("npcDone")?.what === "buy");
  const slot = me.belongings.bag.findIndex((x, i) => x != null && server.debug.items.ctx.store.get(x).type === items.typeIndex.get(window.stock[0].type));
  await send({ type: "shopSell", npc: smith.id, from: { container: 0, slot } });
  check("sold back for a share of its value", me.belongings.bag[slot] == null && me.belongings.wallet[main] === 10 + Math.floor(items.types[items.typeIndex.get(window.stock[0].type)].value * items.config.sellRate), String(me.belongings.wallet[main]));
  server.debug.items.wear(me, "armour");
  me.belongings.wallet[main] = 1000;
  await send({ type: "npcRepair", npc: smith.id });
  check("mended for money", last("npcDone")?.what === "repair" && me.belongings.wallet[main] < 1000, String(me.belongings.wallet[main]));

  // The inn: the bank, and home.
  const innkeeper = by("innkeeper");
  await goTo(innkeeper);
  await send({ type: "talk", npc: innkeeper.id });
  const inn = last("npcWindow");
  check("the innkeeper keeps the bank and the inn", inn?.npc === innkeeper.id && inn.banker && inn.innkeeper && !inn.home);
  await send({ type: "setHome", npc: innkeeper.id });
  check("its inn made home", last("npcDone")?.what === "home" && Math.hypot(server.debug.players.get(id).quickHome.x - innkeeper.x, server.debug.players.get(id).quickHome.z - innkeeper.z) < 3);
  await send({ type: "talk", npc: innkeeper.id });
  check("...and it says so", last("npcWindow")?.home === true);
  await send({ type: "teleport", x: innkeeper.x + 60, z: innkeeper.z }, 3);
  server.debug.skills.kill(me);
  await pump(2);
  await send({ type: "respawn" }, 3);
  check("dead, back at home", Math.hypot(me.x - innkeeper.x, me.z - innkeeper.z) < 4, `${me.x - innkeeper.x}, ${me.z - innkeeper.z}`);
});

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
