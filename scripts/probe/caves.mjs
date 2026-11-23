// The lairs check (SLICE.md E6, DUNGEONS.md): on a real headless server (the default world, with its cave
// mouths and churchyards), a player opens a lair with `/dungeon` at a cave mouth (or a crypt), is walked to
// every spot something stands at - the boss, the chests, the spawn points - along the dungeon graph, and the
// run says what drops through a floor, what is stuck, and what the lair holds (creatures, boss, chests).
//   npm run probe -- scripts/probe/caves.mjs [count=6] [style=cave] [size=lair]
import { loadContentFromDisk, loadCreatureRulesFromDisk, loadItemRulesFromDisk, loadProgressionRulesFromDisk, loadRulesFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { resolveDungeons } from "../../src/world/dungeons/dungeonDefs.ts";
import { placedSpots, worldToFrame } from "../../src/world/dungeons/layout.ts";
import { buildDungeonGraph, dungeonPath, walkableStraight } from "../../src/world/nav/dungeonNav.ts";
import { createWorldData, WORLD_SEED } from "../../src/world/worldData.ts";
import { dungeonSpawnPoints } from "../../src/sim/creatures/dungeonSpawns.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";
import { caveMouthSite, mouthSite } from "../../src/sim/dungeons.ts";

const COUNT = Number(process.argv[2] ?? 6);
const STYLE = process.argv[3] ?? "cave";
const SIZE = process.argv[4] ?? "lair";
let failures = 0, checks = 0;
const check = (what, ok, detail = "") => { checks++; if (!ok) { failures++; console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`); } };

const CONFIG = process.env.CONFIG || undefined;
const { content, packs } = loadContentFromDisk(CONFIG);
const rules = loadRulesFromDisk(CONFIG);
const world = createWorldData(WORLD_SEED, content);
const creatureRules = loadCreatureRulesFromDisk(CONFIG, rules, WORLD_SEED);
const dungeons = resolveDungeons(packSourcesFromDisk(readConfigFromDisk(CONFIG)).sources);
const server = createServer({
  seed: WORLD_SEED, config: CONFIG ?? "default", packs, dimensions: content.dimensions, rules,
  creatures: loadCreatureRulesFromDisk(CONFIG, rules, WORLD_SEED),
  items: loadItemRulesFromDisk(CONFIG, rules, WORLD_SEED),
  progression: loadProgressionRulesFromDisk(CONFIG, rules, WORLD_SEED),
  dungeons: resolveDungeons(packSourcesFromDisk(readConfigFromDisk(CONFIG)).sources),
  devCommands: true,
  loadDimension: () => ({ world }),
});
const channel = createLocalChannel();
server.connect(channel.server);
channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "probe", dimension: "" });
let id = 0, seq = 0;
const told = [];
const pump = (steps = 1, intent) => {
  for (let i = 0; i < steps; i++) {
    if (intent) channel.client.send({ type: "intent", seq: (seq = (seq + 1) & 0xffff), moveX: intent.x, moveZ: intent.z, run: true, jump: false });
    server.step(1 / 30);
    for (const m of channel.client.receive()) {
      if (m.type === "welcome") id = m.playerId;
      if (m.type === "transfer") channel.client.send({ type: "arrived" });
      if (m.type === "chatEvent") told.push(m.text);
    }
  }
};
for (let i = 0; i < 400 && !(id && server.debug.dimensions.size > 0 && server.debug.entity(id)?.body); i++) { await new Promise((r) => setTimeout(r, 5)); pump(1); }
pump(30);
channel.client.send({ type: "chat", channel: "command", text: "god" });
pump(3);
const dim = server.debug.dimensions.get("mainland") ?? [...server.debug.dimensions.values()][0];
const me = server.debug.entity(id);
console.log(`server up; ${world.caveMouths.length} cave mouths, dimension ${dim.id}`);


/** A cave has no walk-line graph that reaches its floors' swells (NAVIGATION.md step 6): a way is found over a
 *  grid of the floor itself - cells every STEP metres where `floorAt` finds a floor a body could walk
 *  straight onto from the last - A* from `from` to the cell nearest `to`; waypoints every cell. */
function gridWay(world, floorAt, from, to, limit = 60000) {
  const STEP = 1.5;
  const key = (ix, iz, y) => `${ix},${iz},${Math.round(y / 2.5)}`;
  const open = [{ x: from.x, y: from.y, z: from.z, g: 0, f: 0, prev: null }];
  const seen = new Map([[key(Math.round(from.x / STEP), Math.round(from.z / STEP), from.y), 0]]);
  let best = open[0], bestD = Infinity, expanded = 0;
  const h = (n) => Math.hypot(n.x - to.x, n.z - to.z) + Math.abs(n.y - to.y);
  while (open.length && expanded++ < limit) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const n = open.splice(bi, 1)[0];
    const d = h(n);
    if (d < bestD) [best, bestD] = [n, d];
    if (Math.hypot(n.x - to.x, n.z - to.z) < STEP * 1.2 && Math.abs(n.y - to.y) < 2.5) { best = n; break; }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = n.x + dx * STEP, z = n.z + dz * STEP;
      const y = floorAt(x, n.y, z);
      if (Math.abs(y - n.y) > 1.6 * Math.hypot(dx, dz)) continue;
      const k = key(Math.round(x / STEP), Math.round(z / STEP), y);
      const g = n.g + STEP * Math.hypot(dx, dz);
      if (seen.has(k) && seen.get(k) <= g) continue;
      const p = { x, y, z };
      if (!walkableStraight(world, n, p)) continue;
      seen.set(k, g);
      open.push({ x, y, z, g, f: g + h(p), prev: n });
    }
  }
  const out = [];
  for (let n = best; n; n = n.prev) out.unshift({ x: n.x, y: n.y, z: n.z });
  return { way: out, reached: bestD < STEP * 2 + 2.5, nearest: bestD, expanded };
}

const sites = dungeons.styles.get(STYLE).builder === "field"
  ? world.caveMouths.filter((_, i) => i % Math.max(1, Math.floor(world.caveMouths.length / COUNT)) === 0).slice(0, COUNT).map(caveMouthSite)
  : world.compoundLayouts.flatMap((l) => l.buildings.map((b) => mouthSite(world, b)).filter(Boolean)).slice(0, COUNT);
const total = { spots: 0, walked: 0, creatures: 0, chests: 0, bosses: 0, parts: 0 };
for (const [n, site] of sites.entries()) {
  // Beside the mouth, then `/dungeon`.
  me.body.teleport(site.x + Math.sin((site.facing * Math.PI) / 180) * 12, site.z + Math.cos((site.facing * Math.PI) / 180) * 12);
  pump(20);
  told.length = 0;
  channel.client.send({ type: "chat", channel: "command", text: `dungeon ${STYLE} ${SIZE}` });
  pump(40);
  const dungeon = [...dim.dungeons.placed.values()].find((d) => d.style === STYLE && Math.hypot(d.site.x - site.x, d.site.z - site.z) < 5 && d.size === SIZE);
  const where = `${STYLE}/${SIZE} #${n} at ${site.x.toFixed(0)}, ${site.z.toFixed(0)}`;
  check(`${where}: opened by /dungeon`, !!dungeon, told.join(" / "));
  if (!dungeon) continue;
  // Alone at its site: the mouth's own cave, opened as the player came near, closed for it - else both
  // rocks would collide in the same space and the walks below measure the two together.
  const others = [...dim.dungeons.placed.values()].filter((d) => d !== dungeon && Math.hypot(d.site.x - site.x, d.site.z - site.z) < 5);
  check(`${where}: the only dungeon at its site`, others.length === 0, others.map((d) => d.id).join(", "));
  const layout = dungeon.layout;
  total.parts += layout.parts.length;
  check(`${where}: a boss part, not minimal`, layout.boss > 0 && !layout.minimal, `boss ${layout.boss}, minimal ${layout.minimal}`);
  const inside = (e) => dim.dungeons.at(e.x, e.y + 1, e.z) === dungeon;
  const creatures = [...dim.entities.values()].filter((e) => e !== me && e.creature && inside(e));
  const named = creatures.filter((e) => e.name && e.name !== e.template.name);
  const chests = [...dim.entities.values()].filter((e) => e.template.id.endsWith("hest") && inside(e));
  total.creatures += creatures.length;
  total.chests += chests.length;
  console.log(`${where}: ${layout.parts.length} parts, ${creatures.length} creatures (${named.length} named), ${chests.length} chests; arrival ${dungeon.arrival.x.toFixed(0)}, ${dungeon.arrival.y.toFixed(1)}, ${dungeon.arrival.z.toFixed(0)}; player at ${me.x.toFixed(0)}, ${me.y.toFixed(1)}, ${me.z.toFixed(0)}`);
  check(`${where}: creatures spawn`, creatures.length > 0);
  if (layout.boss < 0) { console.log(`  minimal layout (${layout.failures.slice(0, 3).join(" | ")})`); continue; }
  {
    const bp = placedSpots(layout.parts[layout.boss], "boss")[0];
    const style = dungeons.styles.get(STYLE);
    const pts = dungeonSpawnPoints(dungeon.id, layout, style.creatures, creatureRules, undefined);
    const bossPoint = pts.find((q) => Math.hypot(q.x - bp.x, q.z - bp.z) < 1);
    check(`${where}: a boss spawn point with a named member at the boss spot`, !!bossPoint && bossPoint.members.length === 1 && !!bossPoint.members[0].name, `${pts.length} points`);
  }
  check(`${where}: chests stand`, chests.length > 0);
  if (process.env.DEBUG) { console.log(creatures.map((e) => `${e.template.id}:${e.name}:L${e.stats ? "" : ""}`).slice(0, 12).join(" ")); console.log(layout.parts.map((p, i) => `${i}:${p.part.id}`).join(" ")); }
  const graph = buildDungeonGraph(layout);
  // The spots: the boss, then each chest, then a spawn point in every other room.
  const spots = [];
  layout.parts.forEach((p, i) => {
    if (i === layout.boss) for (const at of placedSpots(p, "boss")) spots.push({ kind: "boss", at, part: i });
    for (const at of placedSpots(p, "chest")) spots.push({ kind: "chest", at, part: i });
    for (const at of placedSpots(p, "spawns").slice(0, 1)) spots.push({ kind: "spawn", at, part: i });
  });
  total.bosses += spots.filter((s) => s.kind === "boss").length;
  for (const s of spots) {
    total.spots++;
    // Back at the door, then walked along the graph to the spot's floor, the player's own feet the guide.
    me.body.teleportTo(dungeon.arrival);
    pump(6);
    let goal = { x: s.at.x, y: dungeon.floorAt ? dungeon.floorAt(s.at.x, s.at.y, s.at.z) : s.at.y, z: s.at.z };
    let way;
    if (dungeon.floorAt) {
      const g = gridWay(dim.collision.world, dungeon.floorAt, { x: me.x, y: me.y, z: me.z }, goal);
      way = g.reached ? g.way : null;
      if (!way) { check(`${where}: a way to the ${s.kind} spot`, false, `grid got within ${g.nearest.toFixed(1)} m (${g.expanded} cells) of part ${s.part} ${layout.parts[s.part].part.id}, goal ${goal.x.toFixed(0)}, ${goal.y.toFixed(1)}, ${goal.z.toFixed(0)} (authored y ${s.at.y.toFixed(1)})`); continue; }
    } else way = dungeonPath(graph, dim.collision.world, { x: me.x, y: me.y, z: me.z }, goal, 6000);
    if (!way) { check(`${where}: a way to the ${s.kind} spot`, false, `part ${s.part} ${layout.parts[s.part].part.id}, goal ${goal.x.toFixed(0)}, ${goal.y.toFixed(1)}, ${goal.z.toFixed(0)} (authored y ${s.at.y.toFixed(1)})`); continue; }
    let lowest = me.y, next = 0, frames = 0;
    for (; frames < 30 * 400 && next < way.length; frames++) {
      const w = way[next], dx = w.x - me.x, dz = w.z - me.z, l = Math.hypot(dx, dz);
      if (l < 1 && Math.abs(w.y - me.y) < 2.5) { next++; continue; }
      const before = { x: me.x, y: me.y, z: me.z };
      pump(1, { x: dx / l, z: dz / l });
      lowest = Math.min(lowest, me.y);
      if (Math.abs(me.y - before.y) > 3) {
        const fr = worldToFrame(layout.frame, before.x, before.z);
        const out = layout.parts.map((p, i) => ({ i, id: p.part.id, d: Math.max(p.box.min.x - fr.fx, fr.fx - p.box.max.x, p.box.min.z - fr.fz, fr.fz - p.box.max.z, p.box.min.y - before.y, before.y - p.box.max.y) })).sort((a, b) => a.d - b.d).slice(0, 3).map((o) => `${o.i}:${o.id} ${o.d.toFixed(2)} outside`).join("; ");
        console.log("  nearest boxes:", out);
        const near = layout.parts.map((p, i) => ({ p, i })).filter(({ p }) => Math.hypot(p.x - before.x, p.z - before.z) < 60).map(({ p, i }) => `${i}:${p.part.id} y ${p.box.min.y.toFixed(1)}..${p.box.max.y.toFixed(1)}`).join("; ");
        check(`${where}: no jump in height on the way to the ${s.kind} spot`, false, `from ${before.x.toFixed(1)}, ${before.y.toFixed(1)}, ${before.z.toFixed(1)} to y ${me.y.toFixed(1)}; inside before: ${dim.dungeons.at(before.x, before.y, before.z) ? "yes" : "NO"}; parts near: ${near}`);
        break;
      }
    }
    const arrived = next >= way.length && Math.hypot(me.x - goal.x, me.z - goal.z) < 3.5;
    if (arrived) total.walked++;
    check(`${where}: walked to the ${s.kind} spot`, arrived, `stopped ${Math.hypot(me.x - goal.x, me.z - goal.z).toFixed(1)} m off at waypoint ${next}/${way.length}, at ${me.x.toFixed(1)}, ${me.y.toFixed(1)}, ${me.z.toFixed(1)}; goal y ${goal.y.toFixed(1)}`);
    check(`${where}: on the ${s.kind} spot's floor, not dropped through`, Math.abs(me.y - goal.y) < 2.5 || !arrived, `y ${me.y.toFixed(1)} vs ${goal.y.toFixed(1)}`);
  }
  // Leave: out again.
  channel.client.send({ type: "chat", channel: "command", text: "dungeon leave" });
  pump(40);
  // Out again, the lair gone and the mouth's own back (the seamless entry), once the mouths are looked over.
  const after = [...dim.dungeons.placed.values()].filter((d) => Math.hypot(d.site.x - site.x, d.site.z - site.z) < 5);
  const own = STYLE === "cave" && SIZE === "dungeon"; // (the mouth's own itself: it stays)
  if (!own) check(`${where}: on leaving, the lair closed`, !after.includes(dungeon), after.map((d) => d.id).join(", "));
  if (dungeons.styles.get(STYLE).builder === "field") check(`${where}: on leaving, the mouth's own cave open again`, after.length === 1 && after[0].size === "dungeon", after.map((d) => d.id).join(", "));
}
console.log(`${STYLE}: ${sites.length} ${SIZE}s, ${total.parts} parts, ${total.creatures} creatures, ${total.chests} chests, ${total.bosses} boss spots; ${total.walked}/${total.spots} spots walked to`);
console.log(failures === 0 ? `all good (${checks} checks)` : `${failures} failures of ${checks} checks`);
process.exitCode = failures === 0 ? 0 : 1;
