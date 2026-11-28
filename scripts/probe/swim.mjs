// Swimming and drowning (WATER.md), on a real server: a body put in deep water floats at the
// surface, swims slower than it walks, dives and rises, climbs out onto the bank; its breath drains
// under water and hurts at zero, and refills in air.
//   npm run probe -- scripts/probe/swim.mjs
import { loadContentFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";
import { chooseStarts } from "../../src/world/settlements/starts.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";

let failures = 0, checks = 0;
const check = (what, ok, detail = "") => { checks++; if (!ok) { failures++; console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`); } };
const log = console.log;
const quiet = (run) => { console.log = (...a) => (String(a[0]).startsWith("[") ? undefined : log(...a)); try { return run(); } finally { console.log = log; } };

const config = "small", seed = 475982993;
const { content, packs } = loadContentFromDisk(config);
const { loadRulesFromDisk } = await import("../diskContent.mjs");
const rules = loadRulesFromDisk(config);
const worldData = quiet(() => createWorldData(seed, content));
const [start] = chooseStarts(worldData, content.dimension);

// A spot in deep water with dry land a short way east.
let spot = null;
for (let r = 30; r < 1500 && !spot; r += 15) for (let a = 0; a < 360 && !spot; a += 10) {
  const x = start.x + Math.cos(a * Math.PI / 180) * r, z = start.z + Math.sin(a * Math.PI / 180) * r;
  if (worldData.waterAt(x, z).depth < 4) continue;
  for (let d = 5; d <= 60; d += 5) if (worldData.waterAt(x + d, z).depth === 0 && worldData.waterAt(x + d + 6, z).depth === 0) { spot = { x, z, shore: x + d }; break; }
}
check("found deep water with a bank", spot !== null);
if (!spot) process.exit(1);

const server = createServer({ seed, config, packs, dimensions: content.dimensions, rules, loadDimension: () => ({ world: worldData }), saves: undefined });
const channel = createLocalChannel();
server.connect(channel.server);
channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "Swimmer", dimension: "" });
let id = 0, seq = 0;
const pump = async (steps, intent = {}) => {
  for (let i = 0; i < steps; i++) {
    await new Promise((r) => setImmediate(r));
    channel.client.send({ type: "intent", seq: ++seq, moveX: 0, moveZ: 0, jump: false, ...intent });
    server.step(1 / 30);
    for (const m of channel.client.receive()) {
      if (m.type === "welcome" && m.playerId) id = m.playerId;
      if (m.type === "entered") id = m.playerId;
      if (m.type === "transfer") channel.client.send({ type: "arrived" });
    }
  }
};
await pump(20);
const e = () => server.debug.entity(id);
check("the player is in", e() !== undefined);
const hp = () => e().resources.current[rules.health];
const breathIndex = rules.resourceIndex.get("breath");

channel.client.send({ type: "teleport", x: spot.x, z: spot.z });
await pump(90);
const surface = worldData.waterAt(spot.x, spot.z).surface;
check("floats, swimming", e().water === 2, `water ${e().water} y ${e().y.toFixed(2)}`);
check("floats at the surface", Math.abs(e().y - (surface - rules.water.floatDepth)) < 0.3, `y ${e().y.toFixed(2)} surface ${surface}`);

// Swims east slower than it walks.
const x0 = e().x;
await pump(60, { moveX: 1 });
const speed = (e().x - x0) / 2;
check("swims slower than it walks", speed > 1 && speed < 6 * rules.water.swimSpeed * 1.05, `${speed.toFixed(2)} m/s`);

// Dives, then rises.
const y0 = e().y;
await pump(30, { dive: true });
check("dives", e().y < y0 - 1.5, `${y0.toFixed(2)} -> ${e().y.toFixed(2)}`);
check("under: head under water", e().water === 3, `water ${e().water}`);
const breathAfterDive = breathIndex === undefined ? null : e().resources.current[breathIndex];
await pump(60, { rise: true });
check("rises to the surface", e().water === 2, `water ${e().water} y ${e().y.toFixed(2)}`);

// Swims to the bank and stands.
let guard = 0;
while (worldData.waterAt(e().x, e().z).depth > 0 && guard++ < 150) { await pump(30, { moveX: 1 }); if (process.env.SWIMDBG) log(e().x.toFixed(1), e().y.toFixed(2), worldData.heightAt(e().x, e().z).toFixed(2), e().water, `shore ${spot.shore.toFixed(1)}`); }
await pump(60, { moveX: 1 });
check("climbs out", e().water <= 1, `water ${e().water} at ${e().x.toFixed(1)}`);

if (breathIndex !== undefined) {
  check("has breath", e().resources.has.includes(breathIndex));
  const full = e().resources.max[breathIndex];
  channel.client.send({ type: "teleport", x: spot.x, z: spot.z });
  await pump(60);
  await pump(45, { dive: true });
  const before = e().resources.current[breathIndex];
  await pump(60, { dive: true });
  check("breath drains under water", e().resources.current[breathIndex] < before - 0.5, `${before.toFixed(1)} -> ${e().resources.current[breathIndex].toFixed(1)} of ${full}`);
  const health = hp();
  let t = 0;
  while (e().resources.current[breathIndex] > 0 && t++ < 60) await pump(30, { dive: true });
  await pump(90, { dive: true });
  check("drowning hurts", hp() < health, `${health} -> ${hp()}`);
  await pump(240, { rise: true });
  check("breath comes back in air", e().resources.current[breathIndex] > 1, `${e().resources.current[breathIndex]}`);
}
log(`${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
