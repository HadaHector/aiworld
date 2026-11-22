// The navigation test (NAVIGATION.md): ways through crypts by their walk lines' graph - found to
// every room, walked by the character motor, the same every time, none to where nobody can stand,
// and how long they take.
//   npm run probe -- scripts/probe/navigation.mjs [layouts]
import { pick } from "./mode.mjs";
import { packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { resolveDungeons } from "../../src/world/dungeons/dungeonDefs.ts";
import { generateLayout, placedPaths, placedShapes, toWorld } from "../../src/world/dungeons/layout.ts";
import { createCharacterMotor, createCollisionWorld, vec3 } from "../../src/world/collision/index.ts";
import { buildDungeonGraph, dungeonPath, walkableStraight } from "../../src/world/nav/dungeonNav.ts";
import { collisionStats } from "../../src/world/collision/stats.ts";

const COUNT = Number(process.argv[2] ?? pick(60, 200));
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

// --- The surface's cells on made-up ground: a fence is a wall, a kerb under the step height is not
{
  const { createSurfaceNav } = await import("../../src/world/nav/surfaceNav.ts");
  const { boxShape } = await import("../../src/world/dungeons/kitShapes.ts");
  const world = createCollisionWorld();
  // A fence 40 m long, 0.2 m thick, 1.2 m high, along z = 16 from x = 4 to 44; a kerb 0.5 m high across x = 60.
  world.addBatch([boxShape(4, 0, 15.9, 44, 1.2, 16.1), boxShape(59.9, 0, 0, 60.1, 0.5, 32)]);
  const surface = createSurfaceNav({ world, groundAt: () => 0, waterAt: () => ({ surface: -10, depth: 0 }), deep: 1.2, loaded: () => true });
  check("made-up: cells on a fence are shut", surface.cell(20.5, 16.5).shut || surface.cell(20.5, 15.5).shut);
  check("made-up: cells off a fence are open", !surface.cell(20.5, 18.5).shut && !surface.cell(20.5, 13.5).shut);
  check("made-up: cells on a kerb under the step height are open", !surface.cell(60.5, 10.5).shut);
  const a = { x: 20, y: 0, z: 10 }, b = { x: 20, y: 0, z: 22 };
  check("made-up: not straight through a fence", !surface.straight(a, b));
  const way = surface.path(a, b, BUDGET);
  const round = way && way.some((w) => w.x < 4 || w.x > 44);
  let ok = !!way, at = a;
  for (const w of way ?? []) { if (!surface.straight(at, w)) ok = false; at = w; }
  check("made-up: the way goes round the fence's end, every leg straight", ok && round, way ? way.map((w) => `${w.x.toFixed(1)},${w.z.toFixed(1)}`).join(" ") : "none");
  check("made-up: straight over the kerb", surface.straight({ x: 55, y: 0, z: 10 }, { x: 65, y: 0, z: 10 }));
}

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
    creatures: (() => {
      const kinds = loadCreatureRulesFromDisk(CONFIG, rules, WORLD_SEED);
      // The core pack puts creatures down alone for now: groups on, to test a pack (as creatures.mjs).
      kinds.config.groups = { single: 0.6, pair: 0.28, group: 0.12 };
      return kinds;
    })(),
    items: loadItemRulesFromDisk(CONFIG, rules, WORLD_SEED),
    dungeons: resolveDungeons(packSourcesFromDisk(readConfigFromDisk(CONFIG)).sources),
    loadDimension: () => ({ world: createWorldData(WORLD_SEED, tiny) }),
  });
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "probe", dimension: "" });
  let id = 0;
  const pump = async (steps) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((r) => setImmediate(r));
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

  // --- The surface: round a house, round a river (and across it for a swimmer) ----------------
  const { createServerNav } = await import("../../src/sim/nav.ts");
  const nav = createServerNav((d) => server.debug.dimensions.get(d));
  const walker = { swims: false }, swimmer = { swims: true };
  const legsOk = (from, way, agent) => {
    let at = from;
    for (const w of way) {
      if (!nav.straight("mainland", at, w, agent)) return false;
      at = w;
    }
    return true;
  };
  let surfaceMs = 0, surfaceSearches = 0, surfaceSlowest = 0;
  const timed = (from, to, agent) => {
    const t0 = performance.now();
    const way = nav.path("mainland", from, to, BUDGET, agent);
    const ms = performance.now() - t0;
    surfaceMs += ms;
    surfaceSearches++;
    surfaceSlowest = Math.max(surfaceSlowest, ms);
    return way;
  };
  const onGround = (x, z) => ({ x, y: dim.groundAt(x, z), z });

  // A house with open ground before and behind it: the player before it, a wolf behind.
  const houses = dim.world.settlementLayouts.flatMap((l) => l.houses);
  let house = null, front = null, back = null;
  for (const h of houses) {
    const reach = h.depth / 2 + 7;
    const f = { x: h.x + h.frontX * reach, z: h.z + h.frontZ * reach }, b = { x: h.x - h.frontX * reach, z: h.z - h.frontZ * reach };
    me.body.teleportTo(onGround(f.x, f.z));
    server.debug.dimensions.get("mainland").streamer.loadAround(f.x, f.z, [f]);
    const F = onGround(f.x, f.z), B = onGround(b.x, b.z);
    if (nav.straight("mainland", F, B, walker)) continue;
    const s = nav.surface("mainland");
    if (s.cell(F.x, F.z).shut || s.cell(B.x, B.z).shut || s.cell(F.x, F.z).deep || s.cell(B.x, B.z).deep) continue;
    const way = timed(B, F, walker);
    if (!way) continue;
    [house, front, back] = [h, F, B];
    break;
  }
  check("surface: a house with a way round it", !!house);
  if (house) {
    const s = nav.surface("mainland");
    check("surface: the cells under the house's middle are shut", s.cell(house.x, house.z).shut);
    const way = timed(back, front, walker);
    check("surface: every leg of the way round the house walkable", legsOk(back, way, walker));
    check("surface: the same way twice", JSON.stringify(way) === JSON.stringify(nav.path("mainland", back, front, BUDGET, walker)));
    // On the server: a wolf behind the house chases the player before it.
    me.body.teleportTo(front);
    await pump(10);
    const S = server.debug.creatures.debug;
    const wolf = S.spawn("mainland", "wolf.timber", back.x, back.z, 1);
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
    console.log(`surface: a wolf ${Math.hypot(back.x - front.x, back.z - front.z).toFixed(0)} m off behind a house: planned ${planned}, got within ${closest.toFixed(1)} m${evaded ? `, evaded (${evaded})` : ""}`);
    check("surface: the wolf goes round the house to the player", planned && closest < 3.5, `closest ${closest.toFixed(1)} m${evaded ? `, evaded (${evaded})` : ""}`);
    server.debug.skills.kill(wolf);
    // A ranged creature behind the house, in range but out of sight: it comes round till it sees the player.
    const hexer = S.spawn("mainland", "bandit.hexer", back.x, back.z, 1);
    await pump(3);
    const sight = (a) => server.debug.skills.sys.world.lineOfSight("mainland", a, me);
    check("ranged: the hexer starts out of sight", !sight(hexer));
    server.debug.skills.apply(rules.skillIndex.get("burn"), me, hexer);
    let saw = -1, still = 0, why = "", px = hexer.x, pz = hexer.z;
    for (let i = 0; i < 30 * 20; i++) {
      await pump(1);
      server.debug.skills.revive(me);
      if (hexer.creature.brain.state === "evade") { why = hexer.creature.brain.why; break; }
      if (saw < 0 && sight(hexer)) saw = i;
      if (saw >= 0 && Math.hypot(hexer.x - px, hexer.z - pz) < 0.01) still++;
      [px, pz] = [hexer.x, hexer.z];
      if (saw >= 0 && i - saw > 60) break;
    }
    const left = Math.hypot(hexer.x - me.x, hexer.z - me.z);
    console.log(`ranged: a hexer behind the house: saw the player after ${(saw / 30).toFixed(1)} s, ${left.toFixed(1)} m off, standing ${still} of the next ticks${why ? `, evaded (${why})` : ""}`);
    check("ranged: the hexer comes round till it sees the player", saw >= 0 && !why, why);
    check("ranged: and stops at range, not at the player", left > 4, `${left.toFixed(1)} m`);
    server.debug.skills.kill(hexer);
  }

  // A pack pulled together does not merge into one body (NAVIGATION.md, *Local steering*): how near
  // two of its members come while both are running, and once they stand round the player.
  {
    const S = server.debug.creatures.debug;
    const point = S.points("mainland", 0, 0, 1500).find((p) => !p.camp && p.members.length >= 2);
    check("steering: a pack to pull", !!point);
    if (point) {
      const stand = onGround(point.x + 35, point.z);
      me.body.teleportTo(stand);
      server.debug.dimensions.get("mainland").streamer.loadAround(stand.x, stand.z, [stand]);
      server.debug.skills.revive(me);
      await pump(30);
      const pack = server.debug.creatures.debug.creatures("mainland").filter((e) => e.creature.point?.key === point.key && !e.combat.dead);
      server.debug.skills.apply(rules.skillIndex.get("burn"), me, pack[0]);
      // The player is topped up as well as revived: three wolves hit at the balance curves (rules/balance.json5), and a dead player ends the chase.
      const hi = rules.resourceIndex.get("health");
      const keepAlive = () => { server.debug.skills.revive(me); me.resources.current[hi] = me.resources.max[hi]; };
      let nearest = Infinity, running = 0;
      for (let i = 0; i < 30 * 12; i++) {
        await pump(1);
        const moving = pack.filter((e) => !e.combat.dead && (e.creature.input.moveX !== 0 || e.creature.input.moveZ !== 0) && Math.hypot(e.x - me.x, e.z - me.z) > 4);
        for (let a = 0; a < moving.length; a++) for (let b = a + 1; b < moving.length; b++) {
          running++;
          nearest = Math.min(nearest, Math.hypot(moving[a].x - moving[b].x, moving[a].z - moving[b].z));
        }
        keepAlive();
      }
      console.log(`steering: a pack of ${pack.length} running at the player: its members came within ${nearest.toFixed(2)} m of each other (${running} pairs looked at)`);
      // ...and once at the player, standing round it.
      let standing = Infinity;
      for (let i = 0; i < 30 * 4; i++) {
        await pump(1);
        keepAlive();
      }
      const alive = pack.filter((e) => !e.combat.dead);
      for (let a = 0; a < alive.length; a++) for (let b = a + 1; b < alive.length; b++) standing = Math.min(standing, Math.hypot(alive[a].x - alive[b].x, alive[a].z - alive[b].z));
      console.log(`steering: ...standing round the player, the nearest two ${standing.toFixed(2)} m apart; ${alive.map((e) => Math.hypot(e.x - me.x, e.z - me.z).toFixed(1)).join(", ")} m from it`);
      check("steering: a pack stands round the player a body apart, all in reach", alive.length >= 2 && standing > 0.8 && alive.every((e) => Math.hypot(e.x - me.x, e.z - me.z) < 3.5), `${standing.toFixed(2)} m`);
      check("steering: a pack's members keep a body apart while running", running > 0 && nearest > 0.8, `${nearest.toFixed(2)} m, ${running} pairs`);
    }
  }

  // Houses (NAVIGATION.md step 7): a wolf in the street chases the player up to a room upstairs.
  {
    const { buildHouseGraph, houseNodeAt } = await import("../../src/world/nav/houseNav.ts");
    const upstairs = dim.buildings.enterable.find((e) => e.interior.layout.stairs.some((s) => s.level === 0) && e.interior.exits.length > 0 && e.interior.layout.rooms.some((r) => r.base >= 1));
    check("houses: a house with rooms upstairs", !!upstairs);
    if (upstairs) {
      const { house } = upstairs;
      me.body.teleportTo(onGround(house.x + house.frontX * 14, house.z + house.frontZ * 14));
      server.debug.dimensions.get("mainland").streamer.loadAround(house.x, house.z, [house]);
      await pump(3);
      const g = buildHouseGraph(upstairs, dim.collision.world, dim.world.heightAt, true);
      const floor1 = upstairs.interior.levels.find((l) => l.index === 1).floor;
      // A standable tile upstairs, and the street before the door.
      const room = [...g.nodeOf.entries()].find(([key]) => /^-?\d+,-?\d+,1$/.test(key));
      check("houses: a standable tile upstairs", !!room);
      const street = g.points[g.exits[0]];
      const front = { x: street.x + (street.x - house.x) * 0.6, y: 0, z: street.z + (street.z - house.z) * 0.6 };
      front.y = dim.world.heightAt(front.x, front.z);
      if (room) {
        const up = g.points[room[1]];
        check("houses: the tile upstairs is found from its point", houseNodeAt(g, up) === room[1]);
        check("houses: a way from the street to the room upstairs", !!nav.path("mainland", front, up, BUDGET, walker));
        check("houses: not straight from the street to upstairs", !nav.straight("mainland", front, up, walker));
        me.body.teleportTo(up);
        await pump(5);
        check("houses: the player stands upstairs", Math.abs(me.y - (house.y + floor1)) < 0.6, `${me.y.toFixed(2)} against ${(house.y + floor1).toFixed(2)}`);
        const S = server.debug.creatures.debug;
        const wolf = S.spawn("mainland", "wolf.timber", front.x, front.z, 1);
        await pump(3);
        server.debug.skills.apply(rules.skillIndex.get("burn"), me, wolf);
        let planned = false, closest = Infinity, evaded = "", up1 = false;
        for (let i = 0; i < 30 * 40; i++) {
          await pump(1);
          server.debug.skills.revive(me);
          if (wolf.creature.brain.path.length > 1) planned = true;
          if (wolf.y > house.y + floor1 - 0.5) up1 = true;
          if (wolf.creature.brain.state === "evade") { evaded = wolf.creature.brain.why; break; }
          closest = Math.min(closest, Math.hypot(wolf.x - me.x, wolf.z - me.z) + Math.abs(wolf.y - me.y));
          if (closest < 3.5) break;
        }
        console.log(`houses: a wolf in the street, the player upstairs: planned ${planned}, went upstairs ${up1}, got within ${closest.toFixed(1)} m${evaded ? `, evaded (${evaded})` : ""}; the house's graph ${g.points.length} nodes, ${g.exits.length} doors out`);
        check("houses: the wolf goes in and up the stairs to the player", planned && up1 && closest < 3.5, `closest ${closest.toFixed(1)} m${evaded ? `, evaded (${evaded})` : ""}`);
        server.debug.skills.kill(wolf);
      }
    }
  }

  // Deep water near the start: dry ground either side of it, a walker's way never through it, a
  // swimmer's straight across.
  let river = null;
  for (let r = 40; r < 1200 && !river; r += 23) {
    for (let k = 0; k < 16 && !river; k++) {
      const x = Math.sin(k) * r, z = Math.cos(k) * r;
      const w = dim.world.waterAt(x, z);
      if (w.depth < 2.5) continue;
      for (const [ux, uz] of [[1, 0], [0, 1]]) {
        const side = (sign) => {
          for (let d = 1; d < 30; d++) {
            const px = x + ux * d * sign, pz = z + uz * d * sign;
            if (dim.world.waterAt(px, pz).depth <= 0) return { x: px + ux * 2 * sign, z: pz + uz * 2 * sign };
          }
          return null;
        };
        const a = side(-1), b = side(1);
        if (a && b && !river) river = { a, b };
      }
    }
  }
  check("surface: deep water with dry ground either side", !!river);
  if (river) {
    me.body.teleportTo(onGround(river.a.x, river.a.z));
    server.debug.dimensions.get("mainland").streamer.loadAround(river.a.x, river.a.z, [river.a]);
    const A = onGround(river.a.x, river.a.z), B = onGround(river.b.x, river.b.z);
    const swim = timed(A, B, swimmer);
    check("surface: a swimmer's way across the water", !!swim && legsOk(A, swim, swimmer));
    const walk = timed(A, B, walker);
    check("surface: a walker's way round (or over a bridge), never through deep water", walk === null || legsOk(A, walk, walker), walk ? `${walk.length} waypoints` : "");
    console.log(`surface: water ${Math.hypot(A.x - B.x, A.z - B.z).toFixed(0)} m across: a swimmer's way ${swim?.length ?? "none"} legs, a walker's ${walk ? `${walk.length} legs` : "none within the window"}`);
  }
  console.log(`surface: ${surfaceSearches} searches, mean ${(surfaceMs / Math.max(1, surfaceSearches)).toFixed(2)} ms, slowest ${surfaceSlowest.toFixed(1)} ms; ${nav.surface("mainland").tileCount} tiles kept, ${nav.surface("mainland").made.tiles} made in ${nav.surface("mainland").made.ms.toFixed(0)} ms`);
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exitCode = failures ? 1 : 0;
