// The headless server: the simulation on its own in Node, with no client and no Babylon (see
// SIMULATION.md).
//   npm run server                      run until stopped, a line a second
//   npm run server -- --bot             with a player that walks in a circle
//   npm run server -- --bot --ticks 300 stop after 300 steps (for scripted checks)
//   npm run server -- --seed 1337       another world
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPackIndex } from "../packIndex.mjs";
import { resolveContent } from "../../src/world/content/resolveContent.ts";
import { createWorldData, WORLD_SEED } from "../../src/world/worldData.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";

const TICK_HZ = 30;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && at + 1 < args.length ? Number(args[at + 1]) : fallback;
};
const seed = option("seed", WORLD_SEED);
const maxTicks = option("ticks", Infinity);

const ms = (since) => `${(performance.now() - since).toFixed(0)} ms`;

// The packs from disk, resolved exactly as the game resolves the ones it fetches.
let started = performance.now();
const root = fileURLToPath(new URL("../../public/packs/", import.meta.url));
const { packs } = buildPackIndex(root);
const content = resolveContent(packs.map((pack) => ({ id: pack.id, files: pack.files.map((path) => ({ path, text: readFileSync(`${root}/${pack.id}/${path}`, "utf8") })) })));
console.log(`packs: ${packs.map((p) => p.id).join(", ")} (${ms(started)})`);

started = performance.now();
const world = createWorldData(seed, content);
console.log(`world ${seed}: ${world.settlements.length} settlements, ${world.buildingGroups.length} building groups (${ms(started)})`);

started = performance.now();
const server = createServer(world, { packs: packs.map((p) => p.id) });
console.log(`server ready (${ms(started)})`);

// A player that walks a slow circle, jumping now and then - so a headless run exercises the body
// and the collision streaming the way a real client would, over the same channel.
let bot = null;
if (flag("bot")) {
  const channel = createLocalChannel();
  server.connect(channel.server);
  channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "bot" });
  bot = { end: channel.client, id: 0, seq: 0, last: null };
}

function driveBot() {
  for (const message of bot.end.receive()) {
    if (message.type === "welcome") bot.id = message.playerId;
    if (message.type === "snapshot") bot.last = message.players.find((p) => p.id === bot.id) ?? null;
  }
  const t = server.tick / TICK_HZ;
  bot.seq = (bot.seq + 1) & 0xffff;
  bot.end.send({ type: "intent", seq: bot.seq, moveX: Math.cos(t / 20), moveZ: Math.sin(t / 20), run: true, jump: server.tick % 90 === 0 });
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
    const { collision, streamer, players } = server.debug;
    const at = bot?.last ? ` · bot at ${bot.last.x.toFixed(1)}, ${bot.last.y.toFixed(1)}, ${bot.last.z.toFixed(1)}${bot.last.grounded ? "" : " (in the air)"}` : "";
    console.log(`tick ${server.tick} · ${players.size} players · step ${(stepMs / steps).toFixed(2)} ms · ${streamer.chunkCount} chunks, ${collision.shapeCount} shapes${at}`);
    stepMs = 0;
    steps = 0;
    lastReport = now;
  }
  if (server.tick >= maxTicks) clearInterval(timer);
}, 1000 / TICK_HZ);
