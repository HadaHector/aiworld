// The creatures test (see CREATURES.md): creature rules and kinds, zones and spawn points, the
// spawner's lifecycle and the delta, and the brain - on a real `tiny` server where it matters.
//   npm run probe -- scripts/probe/creatures.mjs
import { ContentError } from "../../src/world/content/contentReader.ts";
import { loadCreatureRulesFromDisk, loadRulesFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { levelBand, resolveCreatureRules } from "../../src/sim/rules/creatureRules.ts";
import { resolveGameRules } from "../../src/sim/rules/gameRules.ts";
import { loadContentFromDisk, loadItemRulesFromDisk } from "../diskContent.mjs";
import { createWorldData, WORLD_SEED } from "../../src/world/worldData.ts";
import { createZones } from "../../src/sim/creatures/zones.ts";
import { createSpawnPointField } from "../../src/sim/creatures/spawnPoints.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";
import { FLAG, hasFlag } from "../../src/sim/skills/flags.ts";
import { EVENT_KIND } from "../../src/sim/skills/events.ts";
import { createHuntClient } from "../server/huntBot.mjs";

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
const SEED = 1234;
const sources = packSourcesFromDisk(readConfigFromDisk(CONFIG)).sources;
const game = loadRulesFromDisk(CONFIG);
const creatures = loadCreatureRulesFromDisk(CONFIG, game, SEED);

/** Fresh game and creature rules from the packs plus one probe pack of extra files. */
function withProbePack(files, seed = SEED) {
  const probe = { id: "probe", files: [{ path: "pack.json5", text: "{ name: 'Probe', priority: 100 }" }, ...Object.entries(files).map(([path, text]) => ({ path, text }))] };
  const all = [...sources, probe];
  const rules = resolveGameRules(all);
  return { rules, creatures: resolveCreatureRules(all, rules, seed) };
}
function refused(files, what, pattern) {
  try {
    withProbePack(files);
    check(`${what} refused`, false, "it loaded");
  } catch (error) {
    check(`${what} refused`, error instanceof ContentError && error.issues.some((i) => pattern.test(i.message)), error.message);
  }
}

// --- the rules ---
await section("rules", () => {
  const ids = creatures.kindList.map((k) => k.id);
  check("core's kinds", ["wolf.timber", "wolf.frost", "boar.bristle", "spider.giant", "bandit.thug", "bandit.hexer"].every((id) => ids.includes(id)), ids.join());
  check("kinds join the templates", ids.every((id) => game.templates.get(id) === creatures.kinds.get(id).template));
  const timber = creatures.kinds.get("wolf.timber");
  check("a kind's name from its variant", /Timber Wolf$/.test(timber.template.name), timber.template.name);
  check("a kind is a threat-keeping, hostile template", timber.template.threat && timber.template.hostility === "hostile");
  check("a neutral species", creatures.kinds.get("boar.bristle").template.hostility === "neutral");
  check("the base template's spells come first", game.skills[timber.template.spells[0].skill].id === "autoAttack");
  const frost = creatures.kinds.get("wolf.frost");
  check("a variant adds its spells", frost.template.spells.some((s) => game.skills[s.skill].id === "frostBite"));
  check("a variant sets its stats over the species'", frost.template.stats.find((s) => s.stat === game.statIndex.get("armor")).value === 35);
  check("a variant's colour", frost.template.look.color[0] > 0.8);
  check("the loot table reaches the template", timber.template.items?.loot === "wolf");
  check("per level growth", timber.perLevel.some((p) => p.stat === game.statIndex.get("stamina") && p.value === 1.5));
  check("a camp-only species is not rostered", creatures.kinds.get("bandit.thug").roster === false);
  check("the hexer keeps its range", creatures.kinds.get("bandit.hexer").keepRange === 20);
  check("boars flee", creatures.kinds.get("boar.bristle").flee?.at === 0.2);
  check("the evade skill", game.skills[creatures.config.evadeSkill].id === "evade");
  const camp = creatures.camps.find((c) => c.id === "banditCamp");
  check("the bandit camp's members", camp?.members.length === 3 && camp.members[2].centre && camp.members[2].name === "Bandit Captain");
  check("level bands by ring", levelBand(creatures.config.levels, 0).join() === "1,4" && levelBand(creatures.config.levels, 2).join() === "7,10", `${levelBand(creatures.config.levels, 0)} ${levelBand(creatures.config.levels, 2)}`);
  check("level bands capped", levelBand({ start: [1, 4], step: 3, width: 3, cap: 20 }, 30).join() === "20,20");

  // Traits come from the seed: the same seed the same, other seeds differ somewhere.
  const again = withProbePack({}).creatures;
  check("the same seed, the same traits", creatures.kindList.every((k) => again.kinds.get(k.id).traits.join() === k.traits.join()));
  check("the same seed, the same hash", again.hash === creatures.hash);
  let differs = false;
  for (let seed = 1; seed < 20 && !differs; seed++) {
    const other = withProbePack({}, seed).creatures;
    differs = creatures.kindList.some((k) => other.kinds.get(k.id).traits.join() !== k.traits.join());
  }
  check("other seeds, other traits", differs);
  const traited = creatures.kindList.find((k) => k.traits.length > 0);
  check("a trait's prefix in the name", !traited || traited.template.name.split(" ").length > (traited.variant ? 2 : 1), traited?.template.name);

  refused({ "creatures/zz.json5": "{ entity: 'nope' }" }, "an unknown entity template", /no entity template "nope"/);
  refused({ "creatures/zz.json5": "{ entity: 'beast', spells: [{ skill: 'nope' }] }" }, "an unknown skill", /no skill "nope"/);
  refused({ "creatures/zz.json5": "{ entity: 'beast', habitat: { atlantis: 1 } }" }, "an unknown biome", /no biome "atlantis"/);
  refused({ "creatures/zz.json5": "{ entity: 'beast', traits: { pick: 1, pool: ['nope'] } }" }, "an unknown trait", /no trait "nope"/);
  refused({ "creatures/zz.json5": "{ entity: 'beast', tactics: [{ skill: 'fireball' }] }" }, "a tactic the kind does not know", /not one of the kind's spells/);
  refused({ "creatures/zz.json5": "{ entity: 'beast', perLevel: { grit: 1 } }" }, "an unknown stat per level", /no stat "grit"/);
  refused({ "camps/zz.json5": "{ members: [{ kind: 'dragon' }] }" }, "a camp member of no kind", /no creature kind or species "dragon"/);
  refused({ "rules/creatures.json5": "{ evadeSkill: 'nope' }" }, "an unknown evade skill", /no skill "nope"/);
  const off = withProbePack({ "rules/creatures.json5": "{ never: ['spider', 'wolf.frost'] }" }).creatures;
  check("`never` turns off species and kinds", !off.kinds.has("spider.giant") && !off.kinds.has("wolf.frost") && off.kinds.has("wolf.timber"));
});

// --- zones and spawn points, on the small config's four zones ---
await section("zones and points", () => {
  const small = loadRulesFromDisk("small");
  const rules = loadCreatureRulesFromDisk("small", small, WORLD_SEED);
  const { content } = loadContentFromDisk("small");
  const world = createWorldData(WORLD_SEED, content);
  const def = content.dimensions.find((d) => d.start);
  const zones = createZones(world, rules, def.spawn);
  const start = world.sampleTerrain(def.spawn.x, def.spawn.z).primaryAreaId;
  check("the start's zone is ring 0", zones[start].ring === 0 && zones[start].levels.join() === "1,4");
  check("every zone reached, each a ring from a neighbour", zones.every((z) => z.ring >= 0 && (z.ring === 0 || (world.areaNeighbours.get(z.id) ?? []).some((n) => zones[n].ring === z.ring - 1))));
  check("levels rise with the ring", zones.every((z) => z.levels[0] === 1 + 3 * z.ring));
  check("rosters from the zone's biome", zones.every((z) => z.roster.length > 0 && z.roster.every((r) => r.kind.habitat.has(z.biome) && r.kind.roster)));
  check("one variant per species in a roster", zones.every((z) => new Set(z.roster.map((r) => r.kind.species)).size === z.roster.length));
  const again = createZones(world, rules, def.spawn);
  check("rosters stable for a seed", JSON.stringify(again.map((z) => z.roster.map((r) => r.kind.id))) === JSON.stringify(zones.map((z) => z.roster.map((r) => r.kind.id))));
  const keepOut = [def.spawn, ...def.links.map((l) => l.at)];
  const field = createSpawnPointField(def.id, world, rules, zones, keepOut);
  const points = field.near(0, 0, 700);
  const area = Math.PI * 0.7 * 0.7;
  check("density: a point per 60-120 m square or so", points.length / area > 40 && points.length / area < 280, `${(points.length / area).toFixed(0)} per km²`);
  const other = createSpawnPointField(def.id, world, rules, zones, keepOut).near(0, 0, 700);
  const sig = (list) => JSON.stringify(list.map((p) => [p.key, p.x, p.z, p.members.map((m) => m.kind.id + m.level)]));
  check("the same points and keys again", sig(other) === sig(points));
  check("keys are the dimension's and unique", new Set(points.map((p) => p.key)).size === points.length && points.every((p) => p.key.startsWith(`${def.id}/s/`)));
  check("none near the spawn", points.every((p) => Math.hypot(p.x - def.spawn.x, p.z - def.spawn.z) >= rules.config.safeRadius));
  const ground = points.map((p) => world.sampleTerrain(p.x, p.z));
  check("none in water or on roads", ground.every((g) => g.isLand && g.height > 0.5 && g.roadGap >= 8 && g.riverGap >= 10));
  check("none in settlements", points.every((p) => world.settlementLayouts.every((l) => Math.hypot(p.x - l.x, p.z - l.z) >= l.radius + 25)));
  check("members are of the zone's roster or its camp", points.every((p) => (p.camp ? p.members.every((m) => m.kind.species === "bandit") : p.members.every((m) => zones[p.zone].roster.some((r) => r.kind === m.kind)))));
  check("levels in the zone's band (camps' captains above)", points.every((p) => p.members.every((m) => m.level >= zones[p.zone].levels[0] - 1 && m.level <= zones[p.zone].levels[1] + 3)));
  check("groups, pairs and singles all occur", [1, 2].every((n) => points.some((p) => !p.camp && p.members.length === n)) && points.some((p) => !p.camp && p.members.length > 2));
  check("a camp occurs", points.some((p) => p.camp));
  const camp = points.find((p) => p.camp);
  check("a camp's members stand within its radius", !camp || camp.members.every((m) => Math.hypot(m.homeX - camp.x, m.homeZ - camp.z) <= camp.camp.radius + 0.01));
});

// --- a real tiny server, one client ---
const { content: tinyContent, packs: tinyPacks } = loadContentFromDisk(CONFIG);
function startServer() {
  const rules = loadRulesFromDisk(CONFIG);
  const kinds = loadCreatureRulesFromDisk(CONFIG, rules, WORLD_SEED);
  const kills = [];
  const server = createServer({
    seed: WORLD_SEED,
    config: CONFIG,
    packs: tinyPacks,
    dimensions: tinyContent.dimensions,
    rules,
    creatures: kinds,
    items: loadItemRulesFromDisk(CONFIG, rules, WORLD_SEED),
    onKill: (k) => kills.push(k),
    loadDimension: () => ({ world: createWorldData(WORLD_SEED, tinyContent) }),
  });
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "probe", dimension: "" });
  const client = { id: 0, inbox: [] };
  const pump = async (steps = 1, dt = 1 / 30) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      server.step(dt);
      for (const m of channel.client.receive()) {
        if (m.type === "welcome") client.id = m.playerId;
        if (m.type === "transfer") channel.client.send({ type: "arrived" });
        client.inbox.push(m);
      }
    }
  };
  const send = (message) => channel.client.send(message);
  const dim = () => server.debug.dimensions.get("mainland");
  const creaturesNow = () => server.debug.creatures.debug.creatures("mainland");
  const me = () => server.debug.entity(client.id);
  return { server, rules, kinds, kills, client, pump, send, dim, creaturesNow, me };
}

await section("lifecycle", async () => {
  const t = startServer();
  await t.pump(20);
  const points = t.server.debug.creatures.debug.points("mainland", 0, 0, 400).filter((p) => !p.camp).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  const point = points[0];
  // Stand 100 m off it: in range to fill it, out of the creatures' aggro.
  const away = { x: point.x + 100, z: point.z };
  t.send({ type: "teleport", ...away });
  await t.pump(30);
  const mine = () => t.creaturesNow().filter((e) => e.creature.point?.key === point.key);
  check("a point near the player fills", mine().length === point.members.length, `${mine().length} of ${point.members.length}`);
  const first = mine()[0];
  check("a creature has its kind's template, level and a body", first && first.template.id === point.members[0].kind.id && first.creature.level === point.members[0].level && !!first.body);
  const hp = first.resources.max[t.rules.health];
  check("its health grows with level (full at spawn)", first.resources.current[t.rules.health] === hp && hp > 20, String(hp));
  check("its key is its member's", first.key === point.members[0].key);

  // A kill: a corpse with loot, the delta's entry, a kill record.
  t.server.debug.skills.kill(first);
  await t.pump(5);
  const until = t.server.debug.delta.get(first.key);
  const now = t.server.time;
  check("the dead member is in the delta for its respawn time", until !== undefined && until - now >= point.members[0].respawn[0] - 1 && until - now <= point.members[0].respawn[1], String(until - now));
  check("a kill record", t.kills.some((k) => k.creature === first.id && k.kind === first.template.id && k.level === first.creature.level));
  check("the corpse lies, lootable", t.dim().entities.has(first.id) && first.combat.dead && t.server.debug.items.lootable(first));
  await t.pump(Math.ceil(t.kinds.config.corpse.time) + 2, 1);
  check("the corpse goes after its time", !t.dim().entities.has(first.id));
  check("not made again before its time", !mine().some((e) => e.key === first.key));
  await t.pump(Math.ceil(until - t.server.time) + 2, 1);
  const back = mine().find((e) => e.key === first.key);
  check("made again once its time passes", !!back && back.id !== first.id);
  check("...somewhere within its spread", back && Math.hypot(back.creature.home.x - point.x, back.creature.home.z - point.z) <= point.members[0].spread + 0.01);
  check("...and the delta entry dropped", t.server.debug.delta.get(first.key) === undefined);

  // Away: released after a while, and nothing about the living kept.
  const ids = mine().map((e) => e.id);
  t.send({ type: "teleport", x: point.x + 1500, z: point.z });
  await t.pump(Math.ceil(t.kinds.config.releaseAfter) + 4, 1);
  check("released when nobody is near", ids.every((id) => !t.dim().entities.has(id)));
  t.send({ type: "teleport", ...away });
  await t.pump(10, 0.5);
  check("made fresh on coming back", mine().length === point.members.length && mine().every((e) => !ids.includes(e.id)));
});

await section("brain", async () => {
  const t = startServer();
  await t.pump(20);
  // Somewhere open and empty, away from points, to put creatures down by hand.
  const S = t.server.debug.creatures.debug;
  const pts = S.points("mainland", 0, 0, 1500);
  let spot = null;
  for (let r = 300; r < 1400 && !spot; r += 37) {
    for (let a = 0; a < 12 && !spot; a++) {
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      const g = t.dim().world.sampleTerrain(x, z);
      if (g.isLand && g.height > 1 && g.roadGap > 20 && pts.every((p) => Math.hypot(p.x - x, p.z - z) > 70)) spot = { x, z };
    }
  }
  check("an empty spot for the brain's tests", !!spot);
  if (!spot) return;
  t.send({ type: "teleport", x: spot.x, z: spot.z });
  await t.pump(30);
  const me = t.me();
  const state = (e) => e.creature.brain.state;
  const fireball = t.rules.skillIndex.get("burn"); // a damage over time from the player: threat on its first tick

  // A hostile wolf 10 m off, level 1: about 20 m of aggro, so it comes.
  const wolf = S.spawn("mainland", "wolf.timber", spot.x + 10, spot.z, 1);
  await t.pump(15);
  check("a hostile creature aggroes a player in range", state(wolf) === "combat" && wolf.combat.threat.has(me.id), state(wolf));
  await t.pump(60);
  check("it chases to melee", Math.hypot(wolf.x - me.x, wolf.z - me.z) < 3.5, Math.hypot(wolf.x - me.x, wolf.z - me.z).toFixed(1));
  check("it targets and attacks the top of its table", wolf.combat.target === me.id && wolf.combat.attacking);
  const health = me.resources.current[t.rules.health];
  t.client.inbox.length = 0;
  await t.pump(420);
  const events = t.client.inbox.filter((m) => m.type === "combatEvents").flatMap((m) => m.events);
  check("it hurts the player", me.resources.current[t.rules.health] < health || me.combat.dead);
  const bite = t.rules.skillIndex.get("bite");
  check("it uses its tactics (bite)", events.some((e) => e.skill === bite && (e.kind === EVENT_KIND.hit || e.kind === EVENT_KIND.miss)));
  t.server.debug.skills.revive(me);

  // Leash: the player goes far off; the wolf gives up, immune on the way, home at full health.
  t.server.debug.skills.apply(fireball, me, wolf);
  await t.pump(70);
  t.send({ type: "teleport", x: spot.x + 90, z: spot.z + 40 });
  for (let i = 0; i < 400 && state(wolf) !== "evade"; i++) await t.pump(1);
  check("it evaded for its leash", wolf.creature.brain.why === "leash", wolf.creature.brain.why);
  check("it chased past its leash", Math.hypot(wolf.x - wolf.creature.brain.pulledAt.x, wolf.z - wolf.creature.brain.pulledAt.z) > t.kinds.config.leash);
  check("past its leash it evades", state(wolf) === "evade", state(wolf));
  check("...immune while evading", hasFlag(wolf.combat.flags, FLAG.immune));
  check("...its table cleared", wolf.combat.threat.size === 0);
  await t.pump(240);
  check("home again, idle, full health, not immune", state(wolf) !== "evade" && !hasFlag(wolf.combat.flags, FLAG.immune) && wolf.resources.current[t.rules.health] === wolf.resources.max[t.rules.health], `${state(wolf)} ${wolf.resources.current[t.rules.health]}/${wolf.resources.max[t.rules.health]}`);
  check("...near its home", Math.hypot(wolf.x - wolf.creature.home.x, wolf.z - wolf.creature.home.z) < 3);
  t.server.debug.skills.kill(wolf);

  // A neutral boar stands by a player until hit; then it fights, and runs at low health.
  t.send({ type: "teleport", x: spot.x, z: spot.z });
  await t.pump(10);
  const boar = S.spawn("mainland", "boar.bristle", spot.x + 6, spot.z + 3, 1);
  await t.pump(60);
  check("a neutral creature does not aggro", state(boar) !== "combat" && boar.combat.threat.size === 0, state(boar));
  t.server.debug.skills.apply(fireball, me, boar);
  await t.pump(75);
  check("hit, it fights back", state(boar) === "combat" || state(boar) === "flee", state(boar));
  const max = boar.resources.max[t.rules.health];
  boar.resources.current[t.rules.health] = max * 0.1;
  await t.pump(3);
  check("at low health it flees", state(boar) === "flee", state(boar));
  const fleeFrom = Math.hypot(boar.x - me.x, boar.z - me.z);
  await t.pump(75);
  check("...away from its foe", Math.hypot(boar.x - me.x, boar.z - me.z) > fleeFrom + 3, `${fleeFrom.toFixed(1)} → ${Math.hypot(boar.x - me.x, boar.z - me.z).toFixed(1)}`);
  await t.pump(200);
  check("...and comes back to fight once", (state(boar) === "combat" || boar.combat.dead) && boar.creature.brain.fled, state(boar));
  t.server.debug.skills.apply(fireball, me, boar);
  t.server.debug.skills.kill(boar);
  await t.pump(5);
  check("a dead creature remembers who killed it", boar.combat.killers.includes(me.id), boar.combat.killers.join());
  t.server.debug.skills.revive(me);

  // Group aggro: hit one of a pack, the pack comes.
  const near = S.points("mainland", 0, 0, 1500).find((p) => !p.camp && p.members.length >= 2);
  check("a group to pull", !!near);
  t.send({ type: "teleport", x: near.x + 60, z: near.z });
  await t.pump(30);
  const pack = t.creaturesNow().filter((e) => e.creature.point?.key === near.key && !e.combat.dead);
  t.server.debug.skills.apply(fireball, me, pack[0]);
  await t.pump(70);
  check("pulling one pulls its group", pack.length >= 2 && pack.every((e) => state(e) === "combat"), pack.map(state).join());
});

// --- the hunting bot: a client that finds, fights and loots creatures from messages alone ---
await section("hunt", async () => {
  const rules = loadRulesFromDisk(CONFIG);
  const kinds = loadCreatureRulesFromDisk(CONFIG, rules, WORLD_SEED);
  const server = createServer({
    seed: WORLD_SEED,
    config: CONFIG,
    packs: tinyPacks,
    dimensions: tinyContent.dimensions,
    rules,
    creatures: kinds,
    items: loadItemRulesFromDisk(CONFIG, rules, WORLD_SEED),
    loadDimension: () => ({ world: createWorldData(WORLD_SEED, tinyContent) }),
  });
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "hunter", dimension: "" });
  const hunter = createHuntClient(rules, kinds, channel.client);
  for (let tick = 0; tick < 30 * 90 && hunter.state.loots.length === 0; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    server.step(1 / 30);
    hunter.receive();
    hunter.drive(tick);
  }
  check("the bot kills a creature within 90 s", hunter.state.kills >= 1, `${hunter.state.kills} kills, ${hunter.state.deaths} deaths`);
  check("...and loots its corpse", hunter.state.loots.length >= 1 && hunter.state.loots[0].items.length + hunter.state.loots[0].money > 0, JSON.stringify(hunter.state.loots));
});

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
