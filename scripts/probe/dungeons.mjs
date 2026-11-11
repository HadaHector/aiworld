// The dungeon layouts test (DUNGEONS.md, step 2): the packs' styles and parts load and are checked;
// a thousand layouts generated on the real terrain, at the cemeteries' crypts and at slopes all over
// the world, each checked against every rule - under its cover everywhere, no parts overlapping,
// every room reachable, boss, lock and key as they should be, the same from the same seed - and
// some walked end to end on the character motor.
//   npm run probe -- scripts/probe/dungeons.mjs [count=1000]
import { ContentError } from "../../src/world/content/contentReader.ts";
import { loadContentFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { resolveDungeons } from "../../src/world/dungeons/dungeonDefs.ts";
import { generateLayout, graphDistances, placedPaths, placedShapes, placedSockets } from "../../src/world/dungeons/layout.ts";
import { checkPaths } from "../../src/world/dungeons/clearance.ts";
import { createWorldData, WORLD_SEED } from "../../src/world/worldData.ts";
import { createCharacterMotor, createCollisionWorld, vec3 } from "../../src/world/collision/index.ts";
import { mulberry32 } from "../../src/world/rng.ts";

const COUNT = Number(process.argv[2] ?? 1000);
let failures = 0, checks = 0;
function check(what, ok, detail = "") {
  checks++;
  if (ok) return;
  failures++;
  if (failures <= 30) console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
}

// --- The packs ------------------------------------------------------------------------------
const { sources } = packSourcesFromDisk(readConfigFromDisk());
let t0 = performance.now();
const dungeons = resolveDungeons(sources);
console.log(`dungeons: ${dungeons.styles.size} styles, ${dungeons.parts.size} parts, read and their ways through measured in ${(performance.now() - t0).toFixed(0)} ms`);
for (const style of dungeons.styles.values()) {
  console.log(`  ${style.id}: ${style.parts.length} parts to grow from (${style.parts.filter((p) => p.room).length} rooms), ${style.entrances.length} entrance, ${style.bosses.length} boss, ${style.caps.length} cap`);
}

// A part too narrow is refused, saying where.
{
  const narrow = sources.map((pack) => ({
    ...pack,
    files: pack.files.map((f) => (f.path === "dungeonParts/cryptCorridor.json5" ? { ...f, text: f.text.replace("[3, -1, 0, 4, 7, 12]", "[2.5, -1, 0, 4, 7, 12]") } : f)),
  }));
  let message = "";
  try { resolveDungeons(narrow); } catch (error) { message = error instanceof ContentError ? error.message : String(error); }
  check("a corridor 5.5 m wide is refused", /cryptCorridor.*5\.50 m wide/.test(message), message.split("\n").slice(0, 3).join(" / "));
}

// --- The world ------------------------------------------------------------------------------
t0 = performance.now();
const { content } = loadContentFromDisk();
const world = createWorldData(WORLD_SEED, content);
console.log(`world: made in ${(performance.now() - t0).toFixed(0)} ms`);
const ground = {
  heightAt: (x, z) => world.heightAt(x, z),
  builtAt: (x, z) => world.buildingAt(x, world.heightAt(x, z) + 0.5, z) !== undefined,
};

// Sites: every cemetery's crypt, its door its facing; then slopes over the land, facing downhill
// (the dungeon going in uphill, under the rise).
const sites = [];
for (const layout of world.compoundLayouts) {
  for (const b of layout.buildings) {
    if (b.building.id !== "crypt") continue;
    sites.push({ kind: "crypt", x: b.x, y: world.heightAt(b.x, b.z), z: b.z, facing: (Math.atan2(b.frontX, b.frontZ) * 180) / Math.PI });
  }
}
const crypts = sites.length;
const random = mulberry32(17);
const extent = world.worldExtent;
for (let tries = 0; sites.length < crypts + 400 && tries < 20000; tries++) {
  const x = (random() * 2 - 1) * extent * 0.9, z = (random() * 2 - 1) * extent * 0.9;
  if (world.waterAt(x, z).depth > 0) continue;
  const h = world.heightAt(x, z);
  const gx = world.heightAt(x + 20, z) - world.heightAt(x - 20, z), gz = world.heightAt(x, z + 20) - world.heightAt(x, z - 20);
  const g = Math.hypot(gx, gz);
  if (g / 40 < 0.1) continue;
  // A hillside with a hill behind it: the ground still rising 20 and 40 m in (the siting a cave
  // mouth will want, DUNGEONS.md step 5) - not the last few metres below a ridge.
  const ux = gx / g, uz = gz / g;
  if (world.heightAt(x + ux * 20, z + uz * 20) < h + 5 || world.heightAt(x + ux * 40, z + uz * 40) < h + 12) continue;
  // Facing down the slope: the door looks out, the dungeon runs in under the hill.
  sites.push({ kind: "slope", x, y: h, z, facing: (Math.atan2(-gx, -gz) * 180) / Math.PI });
}
console.log(`sites: ${crypts} cemetery crypts, ${sites.length - crypts} slopes`);

// --- A thousand layouts ---------------------------------------------------------------------
const style = dungeons.styles.get("crypt");
const sizes = Object.keys(style.sizes);
const stats = { ms: 0, worst: 0, attempts: 0, minimal: 0, parts: 0, rooms: 0, locks: 0, loops: 0, divesFirst: 0, depth: 0, leastRock: Infinity };
const layouts = [];
/** The least rock over a box, sampled every metre (twice as fine as the generator looks), under buildings halved. */
function rockOver(b) {
  let least = Infinity;
  for (let x = Math.floor(b.min.x); x <= Math.ceil(b.max.x); x++) {
    for (let z = Math.floor(b.min.z); z <= Math.ceil(b.max.z); z++) {
      const rock = world.heightAt(x, z) - b.max.y;
      least = Math.min(least, ground.builtAt(x, z) ? rock / 2 : rock);
    }
  }
  return least;
}
for (let n = 0; n < COUNT; n++) {
  const site = sites[n % sites.length];
  const size = sizes[n % sizes.length];
  const seed = 1000 + n;
  const t = performance.now();
  let layout;
  try {
    layout = generateLayout(dungeons, "crypt", size, seed, site, ground);
  } catch (error) {
    check(`layout ${n} (${site.kind}) generates`, false, String(error));
    continue;
  }
  const ms = performance.now() - t;
  stats.ms += ms;
  stats.worst = Math.max(stats.worst, ms);
  stats.attempts += layout.attempt;
  if (layout.minimal) stats.minimal++;
  stats.parts += layout.parts.length;
  stats.rooms += layout.parts.filter((p) => p.role === "room" || p.role === "boss").length;
  if (layout.lock >= 0) stats.locks++;
  stats.loops += layout.joins.filter((j) => j.loop).length;
  if (n < 50) layouts.push(layout);
  const where = `layout ${n} (${site.kind}, ${size}, seed ${seed})`;

  // Under its cover everywhere, measured finer than the generator does; never showing at all.
  for (let i = 1; i < layout.parts.length; i++) {
    const p = layout.parts[i];
    if (p.role === "cap") continue;
    const rock = rockOver(p.bounds);
    stats.leastRock = Math.min(stats.leastRock, rock);
    check(`${where}: ${p.part.id} under its cover`, rock > style.cover - 0.5, `${rock.toFixed(2)} m of rock over it`);
    check(`${where}: ${p.part.id} deep enough`, p.bounds.min.y >= site.y - style.deepest - 1e-6);
  }
  // No two parts overlapping (joined ones touch at their sockets).
  for (let i = 0; i < layout.parts.length; i++) {
    for (let j = i + 1; j < layout.parts.length; j++) {
      const a = layout.parts[i].bounds, b = layout.parts[j].bounds;
      const joined = layout.joins.some((k) => (k.a === i && k.b === j) || (k.a === j && k.b === i));
      const s = 0.06;
      const overlap = a.min.x < b.max.x - s && a.max.x > b.min.x + s && a.min.y < b.max.y - s && a.max.y > b.min.y + s && a.min.z < b.max.z - s && a.max.z > b.min.z + s;
      // (A cap may sit in a neighbour's wall, where a way on ran into it: solid in solid. The
      // assembled check below shows it never reaches into anyone's way through.)
      const cap = layout.parts[i].role === "cap" || layout.parts[j].role === "cap";
      if (!joined && !cap) check(`${where}: ${layout.parts[i].part.id} and ${layout.parts[j].part.id} apart`, !overlap);
    }
  }
  // Joined sockets meet face to face.
  for (const k of layout.joins) {
    const sa = placedSockets(layout, k.a)[k.socketA], sb = placedSockets(layout, k.b)[k.socketB];
    const gap = Math.hypot(sa.at.x - sb.at.x, sa.at.y - sb.at.y, sa.at.z - sb.at.z);
    const turn = Math.abs((((sa.facing - sb.facing) % 360) + 360) % 360 - 180);
    check(`${where}: join ${k.a}-${k.b} face to face`, gap < 1e-6 && turn < 1e-6, `${gap.toFixed(4)} m apart, ${turn.toFixed(2)} deg off`);
  }
  // Every socket joined: nothing left open.
  for (let i = 0; i < layout.parts.length; i++) {
    layout.parts[i].part.sockets.forEach((s, si) => {
      if (s.type === "surface") return;
      check(`${where}: ${layout.parts[i].part.id} socket ${si} closed`, layout.joins.some((k) => (k.a === i && k.socketA === si) || (k.b === i && k.socketB === si)));
    });
  }
  // Reachable, the boss there, the lock between the entrance and the boss, the key on this side of it.
  const d = graphDistances(layout.parts.length, layout.joins, 0);
  check(`${where}: everything reachable`, d.every((x) => x < Infinity));
  if (!layout.minimal) check(`${where}: a boss`, layout.boss > 0 && layout.parts[layout.boss].role === "boss");
  if (layout.lock >= 0) {
    const without = graphDistances(layout.parts.length, layout.joins.filter((_, i) => i !== layout.lock), 0);
    check(`${where}: the boss behind the lock`, without[layout.boss] === Infinity);
    check(`${where}: the key this side of it`, without[layout.key] < Infinity && layout.parts[layout.key].role === "room");
  }
  // Diving first: the first part after the entrance goes down, or the entrance left it deep enough.
  const first = layout.parts.find((p) => p.parent === 0);
  if (first && first.part.sockets.some((s) => s.at.y < first.part.sockets[first.entry].at.y - 1)) stats.divesFirst++;
  if (!layout.minimal) stats.depth += site.y - Math.min(...layout.parts.filter((p) => p.role === "room" || p.role === "boss").map((p) => p.bounds.min.y + 1));
}
const ok = COUNT - stats.minimal;
console.log(`layouts: ${COUNT} in ${stats.ms.toFixed(0)} ms (${(stats.ms / COUNT).toFixed(2)} ms each, the slowest ${stats.worst.toFixed(1)} ms with the terrain's heights sampled), ` +
  `${stats.minimal} minimal, ${(stats.attempts / COUNT).toFixed(2)} retries each`);
console.log(`  ${(stats.parts / COUNT).toFixed(1)} parts and ${(stats.rooms / COUNT).toFixed(1)} rooms each, ${stats.locks} locked, ${stats.loops} loops; ` +
  `${stats.divesFirst} start with a way down; the deepest room ${(stats.depth / ok).toFixed(1)} m down on average; the least rock over any part ${stats.leastRock.toFixed(2)} m (cover ${style.cover})`);

// The same seed, the same layout.
{
  const site = sites[0];
  const key = (l) => JSON.stringify(l.parts.map((p) => [p.part.id, p.x.toFixed(4), p.y.toFixed(4), p.z.toFixed(4), p.yaw.toFixed(5)]));
  check("the same seed makes the same layout", key(generateLayout(dungeons, "crypt", "dungeon", 77, site, ground)) === key(generateLayout(dungeons, "crypt", "dungeon", 77, site, ground)));
}

// --- Assembled: 6 m everywhere, and walked --------------------------------------------------
t0 = performance.now();
let measured = 0;
for (const [n, layout] of layouts.entries()) {
  const shapes = layout.parts.flatMap(placedShapes);
  const cw = createCollisionWorld();
  cw.addBatch(shapes);
  const paths = layout.parts.flatMap(placedPaths);
  const sockets = layout.joins.map((k) => placedSockets(layout, k.a)[k.socketA]).filter((s, i) => layout.parts[layout.joins[i].b].role !== "cap");
  const problems = checkPaths([], paths, dungeons.rules.minClear, sockets, cw);
  measured += paths.length;
  check(`layout ${n} assembled: 6 m wide and high everywhere`, problems.length === 0, problems.slice(0, 3).join("; "));
}
console.log(`assembled: ${layouts.length} layouts, ${measured} walk lines measured in place with every part's colliders, ${(performance.now() - t0).toFixed(0)} ms`);

/** The walk lines as a graph: points joined along each line, and where lines meet (within 1.6 m, level). */
function route(layout, from, to) {
  const points = [], edges = [];
  for (const line of layout.parts.flatMap(placedPaths)) {
    line.forEach((p, i) => {
      points.push(p);
      if (i > 0) edges.push([points.length - 2, points.length - 1]);
    });
  }
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const a = points[i], b = points[j];
    if (Math.hypot(a.x - b.x, a.z - b.z) < 1.6 && Math.abs(a.y - b.y) < 0.6) edges.push([i, j]);
  }
  const near = (q) => points.reduce((best, p, i) => (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < Math.hypot(points[best].x - q.x, points[best].y - q.y, points[best].z - q.z) ? i : best), 0);
  const start = near(from), goal = near(to);
  const prev = new Map([[start, -1]]);
  const queue = [start];
  while (queue.length) {
    const i = queue.shift();
    if (i === goal) break;
    for (const [a, b] of edges) {
      const o = a === i ? b : b === i ? a : -1;
      if (o >= 0 && !prev.has(o)) { prev.set(o, i); queue.push(o); }
    }
  }
  if (!prev.has(goal)) return null;
  const out = [];
  for (let i = goal; i >= 0; i = prev.get(i)) out.unshift(points[i]);
  return out;
}

t0 = performance.now();
let walked = 0, steps = 0;
for (const [n, layout] of layouts.slice(0, 12).entries()) {
  if (layout.boss < 0) continue;
  const cw = createCollisionWorld();
  cw.addBatch(layout.parts.flatMap(placedShapes));
  const door = placedSockets(layout, 0).find((s) => s.def.type === "surface");
  const boss = layout.parts[layout.boss];
  const spot = boss.part.spots.boss?.[0] ?? boss.part.paths[0].at(-1);
  const goal = vec3(boss.x + spot.x * Math.cos(boss.yaw) + spot.z * Math.sin(boss.yaw), boss.y + spot.y, boss.z - spot.x * Math.sin(boss.yaw) + spot.z * Math.cos(boss.yaw));
  const way = route(layout, door.at, goal);
  check(`layout ${n}: a way along the walk lines from the door to the boss`, way !== null);
  if (!way) continue;
  const start = way[0];
  const motor = createCharacterMotor(cw, {}, vec3(start.x, start.y + 0.2, start.z));
  motor.teleport(vec3(start.x, start.y + 0.2, start.z));
  let next = 1, deepest = 0, frames = 0;
  for (; frames < 60 * 240 && next < way.length; frames++) {
    const f = motor.state.feet, w = way[next];
    const dx = w.x - f.x, dz = w.z - f.z, l = Math.hypot(dx, dz);
    if (l < 0.8) { next++; continue; }
    motor.update(1 / 60, { move: vec3((dx / l) * 6, 0, (dz / l) * 6), jump: false });
    for (const c of cw.overlap(motor.capsule())) deepest = Math.max(deepest, c.depth);
  }
  steps += frames;
  const f = motor.state.feet;
  // At the end of the walk lines in the boss hall, and that a few steps from the boss's own spot.
  const end = way.at(-1);
  const there = next >= way.length && Math.hypot(f.x - end.x, f.z - end.z) < 1.5 && Math.abs(f.y - end.y) < 0.5 && Math.hypot(end.x - goal.x, end.z - goal.z) < 4;
  if (there) walked++;
  check(`layout ${n}: walked from the door to the boss`, there && deepest < 1e-3,
    `got to waypoint ${next} of ${way.length} at (${f.x.toFixed(1)}, ${f.y.toFixed(1)}, ${f.z.toFixed(1)}), goal y ${goal.y.toFixed(1)}, deepest ${deepest.toExponential(1)}`);
}
console.log(`walked: ${walked} layouts from the door to the boss on the character motor, ${(steps / 60).toFixed(0)} s of walking in ${(performance.now() - t0).toFixed(0)} ms`);

console.log(failures === 0 ? `all good (${checks} checks)` : `${failures} failures of ${checks} checks`);
process.exitCode = failures === 0 ? 0 : 1;
