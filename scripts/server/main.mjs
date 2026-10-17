// The headless server: the simulation on its own in Node, with no client and no Babylon (see
// SIMULATION.md and DIMENSIONS.md).
//   npm run server                       run until stopped, a line a second
//   npm run server -- --bot              with a player that walks in a circle
//   npm run server -- --bot --ticks 300  stop after 300 steps (for scripted checks)
//   npm run server -- --seed 1337        another world
//   npm run server -- --config small     a world config from public/configs (see CONFIG.md)
//   npm run server -- --bot --dimension isles   the bot starts in another dimension
//   npm run server -- --bot --travel 300        the bot travels to the next dimension every 300 ticks
//   npm run server -- --bot --inspect           every second, the bot's entity and those near it: stats,
//                                               modifiers, resources (see ENTITIES.md)
//   npm run server -- --bot --fight             the bot walks to the training dummy and fights it with
//                                               its spells, printing the combat log (see ABILITIES.md)
//   npm run server -- --bot --loot              the bot loots the training dummy, puts on what it can and
//                                               prints its stats and belongings before and after (ITEMS.md)
// A dimension is generated when the first player heads for it and dropped when the last one leaves,
// so with no bot the server holds no world at all.
import { loadContentFromDisk, loadItemRulesFromDisk, loadRulesFromDisk } from "../diskContent.mjs";
import { checkSkillRefs } from "../../src/sim/rules/skillRules.ts";
import { formatMoney } from "../../src/sim/rules/itemRules.ts";
import { statValue } from "../../src/sim/stats.ts";
import { checkPlacements } from "../../src/sim/rules/gameRules.ts";
import { describeEntity } from "../../src/sim/entityText.ts";
import { createWorldData, WORLD_SEED } from "../../src/world/worldData.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";
import { describeEvent } from "../../src/sim/skills/combatLog.ts";
import { createFightClient } from "./fightBot.mjs";

const TICK_HZ = 30;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const text = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
const option = (name, fallback) => Number(text(name, fallback));
const seed = option("seed", WORLD_SEED);
const maxTicks = option("ticks", Infinity);
const configName = text("config", "default");
const travelEvery = option("travel", 0);

const ms = (since) => `${(performance.now() - since).toFixed(0)} ms`;

// The packs from disk, under the config, resolved exactly as the game resolves the ones it fetches -
// once here for the list of dimensions, then per dimension as each is loaded.
let started = performance.now();
const { content: startContent, packs } = loadContentFromDisk(configName);
const dimensions = startContent.dimensions;
console.log(`config ${configName}: packs ${packs.join(", ")}; dimensions ${dimensions.map((d) => `${d.id}${d.start ? " (start)" : ""}`).join(", ")} (${ms(started)})`);
// Stats, resources and entity templates (see ENTITIES.md): once for the server, not per dimension.
started = performance.now();
const rules = loadRulesFromDisk(configName);
checkPlacements(rules, dimensions);
console.log(`game rules: ${rules.stats.length} stats, ${rules.modifierKinds.length} modifier kinds, ${rules.resources.length} resources, ${rules.templates.size} templates, ${rules.skills.length} skills (${ms(started)})`);
// Items (see ITEMS.md): generated types depend on the world seed.
started = performance.now();
const items = loadItemRulesFromDisk(configName, rules, seed);
checkSkillRefs(rules, items.abilityRefs);
console.log(`item rules: ${items.types.length} item types (${[...items.generated.values()].reduce((n, t) => n + t.length, 0)} generated), ${items.slots.length} equipment slots, ${items.lootTables.size} loot tables (${ms(started)})`);

const server = createServer({
  seed,
  config: configName,
  packs,
  dimensions,
  rules,
  items,
  loadDimension(definition, dimensionSeed) {
    let at = performance.now();
    const content = definition.start ? startContent : loadContentFromDisk(configName, definition.id).content;
    const resolved = ms(at);
    at = performance.now();
    const world = createWorldData(dimensionSeed, content);
    console.log(`dimension ${definition.id} (seed ${dimensionSeed}): ${content.biomes.length} biomes, ${world.settlements.length} settlements, ${world.buildingGroups.length} building groups (content ${resolved}, world ${ms(at)})`);
    return { world };
  },
  onLoadError: (definition, error) => console.error(`dimension ${definition.id} failed to load:`, error),
});

// A player that walks a slow circle, jumping now and then - so a headless run exercises the body
// and the collision streaming the way a real client would, over the same channel. It answers every
// Transfer with Arrived at once, having no world of its own to build.
let bot = null;
if (flag("bot")) {
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "bot", dimension: text("dimension", "") });
  bot = { end: channel.client, id: 0, seq: 0, last: null, dimension: "", entityMessages: 0, fighter: flag("fight") ? createFightClient(rules, channel.client) : null };
}

/** One entity message, short, with stats and resources by name. */
function describeMessage(message) {
  const stats = (list) => list.map((s) => `${rules.stats[s.stat].id} ${+s.value.toFixed(2)}`).join(", ");
  const resources = (list) => list.map((r) => `${rules.resources[r.resource].id} ${+r.current.toFixed(2)}/${+r.max.toFixed(2)}`).join(", ");
  switch (message.type) {
    case "entitySpawn":
      return `spawn #${message.id} ${message.name} (${message.template}, look ${message.look.seed}${message.look.race ? ` ${message.look.race} ${message.look.outfit}` : ""}) · ${resources(message.resources)} · ${stats(message.stats)}`;
    case "entityValues":
      return `values #${message.id} · ${[resources(message.resources), stats(message.stats)].filter(Boolean).join(" · ")}`;
    case "entityModifiers":
      return `modifiers #${message.id} · ${message.modifiers.map((m) => `${rules.stats[m.stat].id} ${rules.modifierKinds[m.kind].id} ${m.value} (${m.source})`).join(", ") || "none"}`;
    case "entityDespawn":
      return `despawn #${message.id}`;
    default:
      return null;
  }
}

function driveBot() {
  if (bot.fighter) {
    driveFighter();
    return;
  }
  for (const message of bot.end.receive()) {
    if (message.type === "welcome") bot.id = message.playerId;
    if (message.type === "transfer") {
      console.log(`bot: to ${message.dimension} at ${message.x}, ${message.z}`);
      bot.dimension = message.dimension;
      bot.last = null;
      bot.end.send({ type: "arrived" });
    }
    if (message.type === "snapshot") bot.last = message.entities.find((p) => p.id === bot.id) ?? bot.last;
    if (lootRun) lootRun.receive(message);
    // What the bot is told of entities (see ENTITIES.md): the first few in full, then a count a second.
    if (message.type.startsWith("entity")) {
      bot.entityMessages++;
      const line = describeMessage(message);
      if (line && bot.entityMessages <= 20) console.log(`bot: ${line}`);
    }
  }
  if (lootRun) {
    lootRun.drive(server.tick);
    return;
  }
  // A scripted test of resources: some health spent, then a while in combat - regen stops while in
  // it and comes back after.
  if (server.tick === 60) bot.end.send({ type: "debugResource", entity: 0, resource: rules.health, delta: -100 });
  if (server.tick === 150) bot.end.send({ type: "debugCombat", entity: 0, inCombat: true });
  if (server.tick === 300) bot.end.send({ type: "debugCombat", entity: 0, inCombat: false });
  if (travelEvery > 0 && server.tick > 0 && server.tick % travelEvery === 0) {
    const next = dimensions[(dimensions.findIndex((d) => d.id === bot.dimension) + 1) % dimensions.length];
    bot.end.send({ type: "travel", dimension: next.id });
  }
  const t = server.tick / TICK_HZ;
  bot.seq = (bot.seq + 1) & 0xffff;
  bot.end.send({ type: "intent", seq: bot.seq, moveX: Math.cos(t / 20), moveZ: Math.sin(t / 20), run: true, jump: server.tick % 90 === 0 });
}

/** The --fight bot: the fight client plays, and the combat log is printed as it comes. */
function driveFighter() {
  const fighter = bot.fighter;
  fighter.receive();
  bot.id = fighter.state.id;
  bot.dimension = fighter.state.dimension;
  bot.last = fighter.state.me;
  for (const event of fighter.state.events.splice(0)) {
    if (fighter.loggable(event)) console.log(`  [${event.time.toFixed(1)}] ${describeEvent(rules, event, fighter.nameOf)}`);
  }
  fighter.drive(server.tick);
}

/**
 * The --loot bot (see ITEMS.md, *Debug, the server and the test*): it walks to the dummy, spends all
 * its health, loots it, puts on whatever it can and prints its stats and belongings before and after.
 */
const lootRun = bot && flag("loot") ? createLootRun() : null;
function createLootRun() {
  const containers = [[], [], []];
  let dummy = 0;
  let wallet = [];
  const nameOf = (state) => (state ? `${items.types[items.typeIndex.get(state.type)]?.name ?? state.type}${state.count > 1 ? ` x${state.count}` : ""}` : null);
  const stat = (id) => {
    const me = server.debug.entity(bot.id);
    return me?.stats ? +statValue(me.stats, rules.statIndex.get(id)).toFixed(2) : 0;
  };
  const report = (when) => {
    console.log(`bot (${when}): strength ${stat("strength")}, stamina ${stat("stamina")}, armor ${stat("armor")}, weapon ${stat("weaponMin")}-${stat("weaponMax")} every ${stat("weaponSpeed")} s`);
    console.log(`  worn: ${containers[2].map((s, i) => (s ? `${items.slots[i].id} ${nameOf(s)}` : null)).filter(Boolean).join(", ")}`);
    console.log(`  bag: ${containers[0].map(nameOf).filter(Boolean).join(", ")}`);
    console.log(`  money: ${wallet.map((n, c) => formatMoney(items.currencies[c], n)).join(", ")} · gear on the body: ${server.debug.entity(bot.id)?.gear?.join(", ")}`);
  };
  const send = (message) => bot.end.send(message);
  return {
    receive(message) {
      if (message.type === "entitySpawn" && message.template === "trainingDummy") dummy = message.id;
      if (message.type === "container") containers[message.container] = [...message.items];
      if (message.type === "itemSlot") containers[message.container][message.slot] = message.item;
      if (message.type === "wallet") wallet = message.amounts;
      if (message.type === "itemRefused") console.log(`bot: refused - ${message.reason}`);
      if (message.type === "loot" && message.entity) console.log(`bot: loot of #${message.entity}: ${message.items.map(nameOf).filter(Boolean).join(", ")}; ${message.money.map((n, c) => (n ? formatMoney(items.currencies[c], n) : "")).filter(Boolean).join(", ")}`);
      if (message.type === "entityLootable" && message.id === dummy) console.log(`bot: the dummy is ${message.lootable ? "" : "no longer "}lootable`);
    },
    drive(tick) {
      bot.seq = (bot.seq + 1) & 0xffff;
      send({ type: "intent", seq: bot.seq, moveX: 0, moveZ: 0, run: false, jump: false });
      if (tick === 30) send({ type: "teleport", x: 5, z: 3 });
      if (tick === 40) report("before");
      if (tick === 45) send({ type: "debugResource", entity: dummy, resource: rules.health, delta: -1e9 });
      if (tick === 50) send({ type: "lootOpen", entity: dummy });
      if (tick === 55) send({ type: "lootTake", slot: 0xffff });
      if (tick === 60) {
        containers[0].forEach((state, slot) => {
          if (state && items.types[items.typeIndex.get(state.type)].slots.length > 0) send({ type: "itemEquip", from: { container: 0, slot } });
        });
      }
      if (tick === 70) report("after");
    },
  };
}

console.log(`startup ${ms(0)}`);

/** How far around the bot `--inspect` looks. */
const INSPECT_RADIUS = 150;
const inspect = flag("inspect");

/** Prints the bot's entity and every entity near it, as the server has them. */
function inspectBot() {
  const me = server.debug.entity(bot.id);
  const dimension = me && server.debug.dimensions.get(me.dimension);
  if (!me || !dimension) return;
  const near = [...dimension.entities.values()].filter((e) => e !== me && Math.hypot(e.x - me.x, e.z - me.z) <= INSPECT_RADIUS);
  for (const entity of [me, ...near]) for (const line of describeEntity(rules, entity)) console.log(`  ${line}`);
}

let stepMs = 0;
let steps = 0;
let lastReport = performance.now();
let lastStep = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  const delta = (now - lastStep) / 1000;
  lastStep = now;
  if (bot) driveBot();
  const before = performance.now();
  server.step(delta);
  stepMs += performance.now() - before;
  steps++;
  if (now - lastReport >= 1000 || server.tick >= maxTicks) {
    const { dimensions: loaded, players } = server.debug;
    const worlds = [...loaded.values()].map((d) => {
      const inIt = [...players.values()].filter((p) => p.entity.dimension === d.id && p.entity.body).length;
      return `${d.id}: ${inIt} players, ${d.entities.size} entities, ${d.streamer.chunkCount} chunks, ${d.collision.shapeCount} shapes`;
    });
    const at = bot?.last ? ` · bot in ${bot.dimension} at ${bot.last.x.toFixed(1)}, ${bot.last.y.toFixed(1)}, ${bot.last.z.toFixed(1)}${bot.last.grounded ? "" : " (in the air)"}` : "";
    const told = bot ? ` · ${bot.entityMessages} entity messages` : "";
    const me = bot && server.debug.entity(bot.id);
    const health = me?.resources ? ` · bot health ${me.resources.current[rules.health].toFixed(0)}/${me.resources.max[rules.health]}${me.inCombat ? " (in combat)" : ""}` : "";
    console.log(`tick ${server.tick} · ${players.size} players · step ${(stepMs / steps).toFixed(2)} ms · ${worlds.join(" · ") || "no dimension loaded"}${at}${health}${told}`);
    if (inspect && bot) inspectBot();
    stepMs = 0;
    steps = 0;
    lastReport = now;
  }
  if (server.tick >= maxTicks) clearInterval(timer);
}, 1000 / TICK_HZ);
