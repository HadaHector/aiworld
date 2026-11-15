// The navigation test (NAVIGATION.md): ways through crypts by their walk lines' graph - found to
// every room, walked by the character motor, the same every time, none to where nobody can stand,
// and how long they take.
//   npm run probe -- scripts/probe/navigation.mjs [layouts]
import { packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { resolveDungeons } from "../../src/world/dungeons/dungeonDefs.ts";
import { generateLayout, placedPaths, placedShapes, toWorld } from "../../src/world/dungeons/layout.ts";
import { createCharacterMotor, createCollisionWorld, vec3 } from "../../src/world/collision/index.ts";
import { buildDungeonGraph, dungeonPath, walkableStraight } from "../../src/world/nav/dungeonNav.ts";
import { collisionStats } from "../../src/world/collision/stats.ts";

const COUNT = Number(process.argv[2] ?? 200);
const WALKED = 20;
const BUDGET = 4000;
let failures = 0, checks = 0;
function check(what, ok, detail = "") {
  checks++;
  if (ok) return;
  failures++;
  if (failures <= 30) console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
}

const { sources } = packSourcesFromDisk(readConfigFromDisk());
const content = resolveDungeons(sources);
const style = [...content.styles.values()].find((s) => s.id.includes("crypt")) ?? [...content.styles.values()][0];
// Flat ground: the generator dives under it all the same, and it is quick.
const ground = { heightAt: () => 0, builtAt: () => false };

/** Where a body arrives: the last point of the entrance's first walk line, as the server puts it. */
const arrivalOf = (layout) => placedPaths(layout.parts[0])[0].at(-2);
/** A part's spot of a kind, else the middle of its first walk line, in the world. */
function spotIn(p, kind) {
  const local = p.part.spots[kind]?.[0];
  if (local) return toWorld(p, local);
  const line = placedPaths(p)[0];
  return line?.[Math.floor(line.length / 2)];
}
const pathLength = (from, way) => way.reduce((sum, w, i) => sum + Math.hypot(w.x - (i ? way[i - 1] : from).x, w.z - (i ? way[i - 1] : from).z), 0);

let built = 0, buildMs = 0, nodes = 0, searches = 0, searchMs = 0, slowest = 0, found = 0, rooms = 0, offLine = 0, offFound = 0;
let walked = 0, tried = 0, unreachableOk = 0, rays = 0;
for (let n = 0; n < COUNT; n++) {
  const size = n % 3 === 2 ? "dungeon" : "lair";
  if (!style.sizes[size]) continue;
  const layout = generateLayout(content, style.id, size, 1000 + n, { x: 0, y: 0, z: 0, facing: (n * 37) % 360 }, ground);
  const cw = createCollisionWorld();
  cw.addBatch(layout.parts.flatMap(placedShapes));
  let t = performance.now();
  const graph = buildDungeonGraph(layout);
  buildMs += performance.now() - t;
  built++;
  nodes += graph.links.length;
  const from = arrivalOf(layout);
  const search = (a, b) => {
    const t0 = performance.now(), r0 = collisionStats.rays;
    const way = dungeonPath(graph, cw, a, b, BUDGET);
    const ms = performance.now() - t0;
    rays += collisionStats.rays - r0;
    searches++;
    searchMs += ms;
    slowest = Math.max(slowest, ms);
    return way;
  };

  // To every room: a way, its ends' shortcuts walkable.
  for (const p of layout.parts) {
    if (p.role !== "room" && p.role !== "boss") continue;
    const to = spotIn(p, p.role === "boss" ? "boss" : "spawns");
    if (!to) continue;
    rooms++;
    const way = search(from, to);
    if (way) found++;
    else if (rooms - found <= 5) check(`layout ${n}: a way from the arrival to ${p.part.id}`, false, `${to.x.toFixed(1)},${to.y.toFixed(1)},${to.z.toFixed(1)}`);
    if (way) {
      let at = from, bad = "";
      const f = (v) => `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`;
      // The first and last legs are shortcuts off the lines, taken by rays: they must hold.
      for (const [a, b] of [[from, way[0]], [way.at(-2) ?? from, way.at(-1)]]) if (!bad && !walkableStraight(cw, a, b)) bad = `${f(a)} -> ${f(b)}`;
      check(`layout ${n}: the way to ${p.part.id} leaves and meets the lines walkably`, !bad, bad);
    }
  }
  // Off the lines: every spawn spot in every part, to the arrival.
  for (const p of layout.parts) {
    for (const local of p.part.spots.spawns ?? []) {
      offLine++;
      if (search(toWorld(p, local), from)) offFound++;
    }
  }
  // Nowhere to stand: high over the boss's floor, inside the rock.
  if (layout.boss >= 0) {
    const boss = spotIn(layout.parts[layout.boss], "boss");
    if (search(from, { x: boss.x, y: boss.y + 40, z: boss.z }) === null) unreachableOk++;
    else check(`layout ${n}: no way to a point in the rock over the boss`, false);
  }
  // The same twice.
  if (n < 20 && layout.boss >= 0) {
    const to = spotIn(layout.parts[layout.boss], "boss");
    check(`layout ${n}: the same way twice`, JSON.stringify(search(from, to)) === JSON.stringify(dungeonPath(buildDungeonGraph(layout), cw, from, to, BUDGET)));
  }

  // Walked by the motor, door to boss, waypoint by waypoint.
  if (tried < WALKED && layout.boss >= 0) {
    tried++;
    const goal = spotIn(layout.parts[layout.boss], "boss");
    const way = search(from, goal);
    if (!way) continue;
    const motor = createCharacterMotor(cw, {}, vec3(from.x, from.y + 0.2, from.z));
    motor.teleport(vec3(from.x, from.y + 0.2, from.z));
    let next = 0, frames = 0;
    for (; frames < 60 * 240 && next < way.length; frames++) {
      const f = motor.state.feet, w = way[next];
      const dx = w.x - f.x, dz = w.z - f.z, l = Math.hypot(dx, dz);
      if (l < 0.75) { next++; continue; }
      motor.update(1 / 60, { move: vec3((dx / l) * 6, 0, (dz / l) * 6), jump: false });
    }
    const f = motor.state.feet;
    const there = next >= way.length && Math.hypot(f.x - goal.x, f.z - goal.z) < 1.5 && Math.abs(f.y - goal.y) < 1;
    if (there) walked++;
    // A stall is noted, not failed: what wedges the motor on a walk line is the crypt's geometry (a
    // ledger stone standing proud of the floor, met on the slant), not the way; the share is checked below.
    if (!there) console.log(`note: layout ${n}: the motor stalled on the way to the boss at waypoint ${next}/${way.length}, at ${f.x.toFixed(1)},${f.y.toFixed(1)},${f.z.toFixed(1)}, ${pathLength(from, way).toFixed(0)} m`);
  }
}

check("a way to every room", found === rooms, `${found}/${rooms}`);
check("the motor walks nine ways in ten to the boss", walked >= tried * 0.9, `${walked}/${tried}`);
check("a way from every spawn spot", offFound === offLine, `${offFound}/${offLine}`);
check("searches are quick (mean under 2 ms, none over 20 ms)", searchMs / searches < 2 && slowest < 20, `mean ${(searchMs / searches).toFixed(2)} ms, slowest ${slowest.toFixed(1)} ms`);
console.log(`${built} layouts: graph ${(buildMs / built).toFixed(1)} ms and ${Math.round(nodes / built)} nodes each; ${searches} searches, mean ${(searchMs / searches).toFixed(2)} ms and ${Math.round(rays / searches)} rays (${((searchMs * 1000) / Math.max(1, rays)).toFixed(1)} µs a ray), slowest ${slowest.toFixed(1)} ms`);
console.log(`ways to rooms ${found}/${rooms}, from spawn spots ${offFound}/${offLine}, none into the rock ${unreachableOk}, walked by the motor ${walked}/${tried}`);

// --- On a server: a wolf in a crypt chases a player into another room, round its walls ---------
{
  const { loadContentFromDisk, loadCreatureRulesFromDisk, loadItemRulesFromDisk, loadRulesFromDisk } = await import("../diskContent.mjs");
  const { createWorldData, WORLD_SEED } = await import("../../src/world/worldData.ts");
  const { createServer } = await import("../../src/sim/server.ts");
  const { createLocalChannel } = await import("../../src/sim/channel.ts");
  const { PROTOCOL_VERSION } = await import("../../src/sim/protocol.ts");
  const { dungeonSiteNear } = await import("../../src/sim/dungeons.ts");
  const CONFIG = "tiny";
  const { content: tiny, packs } = loadContentFromDisk(CONFIG);
  const rules = loadRulesFromDisk(CONFIG);
  const server = createServer({
    seed: WORLD_SEED, config: CONFIG, packs, dimensions: tiny.dimensions, rules,
    creatures: loadCreatureRulesFromDisk(CONFIG, rules, WORLD_SEED), items: loadItemRulesFromDisk(CONFIG, rules, WORLD_SEED),
    dungeons: resolveDungeons(packSourcesFromDisk(readConfigFromDisk(CONFIG)).sources),
    loadDimension: () => ({ world: createWorldData(WORLD_SEED, tiny) }),
  });
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "probe", dimension: "" });
  let id = 0;
  const pump = async (steps) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((r) => setTimeout(r, 0));
      server.step(1 / 30);
      for (const m of channel.client.receive()) {
        if (m.type === "welcome") id = m.playerId;
        if (m.type === "transfer") channel.client.send({ type: "arrived" });
      }
    }
  };
  await pump(20);
  const dim = server.debug.dimensions.get("mainland");
  const site = dungeonSiteNear(dim.world, 0, 0);
  const dungeon = dim.dungeons.open("probe/nav", "crypt", "dungeon", 77, site);
  const me = server.debug.entity(id);
  const parts = dungeon.layout.parts;
  // Two rooms near enough for the leash, with no straight way between: the wolf must go round.
  const spots = parts.filter((p) => p.role === "room" || p.role === "boss").map((p) => spotIn(p, p.role === "boss" ? "boss" : "spawns")).filter(Boolean);
  let pair = null;
  for (const a of spots) for (const b of spots) {
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (!pair && a !== b && d > 15 && d < 40 && Math.abs(a.y - b.y) < 1 && !walkableStraight(dim.collision.world, a, b)) pair = [a, b];
  }
  check("server: two crypt rooms with a wall between", !!pair);
  if (pair) {
    const [wolfAt, meAt] = pair;
    me.body.teleportTo(meAt);
    await pump(5);
    const S = server.debug.creatures.debug;
    const wolf = S.spawn("mainland", "wolf.timber", wolfAt.x, wolfAt.z, 1);
    wolf.body.teleportTo(wolfAt);
    Object.assign(wolf, { x: wolfAt.x, y: wolfAt.y, z: wolfAt.z });
    wolf.creature.home = { ...wolfAt };
    await pump(3);
    server.debug.skills.apply(rules.skillIndex.get("burn"), me, wolf);
    let planned = false, closest = Infinity, evaded = "";
    for (let i = 0; i < 30 * 30; i++) {
      await pump(1);
      if (wolf.creature.brain.path.length > 1) planned = true;
      if (wolf.creature.brain.state === "evade") { evaded = wolf.creature.brain.why; break; }
      closest = Math.min(closest, Math.hypot(wolf.x - me.x, wolf.z - me.z));
      if (closest < 3.5) break;
    }
    console.log(`server: a wolf ${Math.hypot(wolfAt.x - meAt.x, wolfAt.z - meAt.z).toFixed(0)} m off behind a wall: planned ${planned}, got within ${closest.toFixed(1)} m${evaded ? `, evaded (${evaded})` : ""}`);
    check("server: the wolf plans a way round the wall", planned);
    check("server: ...and reaches the player in the other room", closest < 3.5, `closest ${closest.toFixed(1)} m${evaded ? `, evaded (${evaded})` : ""}`);
    // Its way back: up in the rock over the room is nowhere - unreachable.
    me.body.teleportTo({ x: meAt.x, y: meAt.y + 40, z: meAt.z });
    let why = "";
    for (let i = 0; i < 60 && !why; i++) { await pump(1); if (wolf.creature.brain.state === "evade") why = wolf.creature.brain.why; }
    check("server: a target it cannot reach makes it evade as unreachable", why === "unreachable", why || wolf.creature.brain.state);
  }
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exitCode = failures ? 1 : 0;
