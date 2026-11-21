// The chat test (CHAT.md): the parser and cleaning, then commands run through a real `tiny` server -
// with developer commands off (every one refused, nothing changed) and on (each does what it says),
// bad arguments, /say reaching those in range and no further, and the rate limit.
//   npm run probe -- scripts/probe/chat.mjs
import { loadContentFromDisk, loadCreatureRulesFromDisk, loadItemRulesFromDisk, loadProgressionRulesFromDisk, loadRulesFromDisk } from "../diskContent.mjs";
import { createWorldData } from "../../src/world/worldData.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";
import { cleanChat, splitWords, findNamed, createRateLimit, parseArgs, complete, CHAT_MAX_LENGTH } from "../../src/sim/chat/chat.ts";
import { fillText } from "../../src/sim/text.ts";

let failures = 0;
function check(what, ok, detail = "") {
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
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

// --- Pure parts ---
check("clean: controls and newlines", cleanChat("a\nb\u0007  c\t d ") === "a b c d");
check("clean: length", cleanChat("x".repeat(1000)).length === CHAT_MAX_LENGTH);
check("clean: not a string", cleanChat(42) === "");
check("split: plain", splitWords("give iron sword 2").join("|") === "give|iron|sword|2");
check("split: quotes", splitWords('give "iron sword" 2').join("|") === "give|iron sword|2");
const list = [{ id: "ironSword", name: "Iron Sword" }, { id: "ironShield", name: "Iron Shield" }, { id: "oakMace", name: "Oak Mace" }];
check("find: exact name", findNamed(list, "iron sword").id === "ironSword");
check("find: prefix", findNamed(list, "oak").id === "oakMace");
check("find: ambiguous", findNamed(list, "iron") === "many");
check("find: none", findNamed(list, "zzz") === "none");
const rate = createRateLimit();
check("rate: five pass", [0, 0.1, 0.2, 0.3, 0.4].every((t) => rate(t)) && !rate(0.5) && rate(4));
const giveDef = { id: "give", usage: "", summary: "", dev: true, owner: "server", args: [{ name: "item", kind: "item" }, { name: "count", kind: "int", optional: true }] };
const book = { names: () => list };
check("args: ok", JSON.stringify(parseArgs(giveDef, ["oak", "3"], book).values) === '["oakMace",3]');
check("args: optional left out", parseArgs(giveDef, ["oak"], book).values.length === 1);
check("args: missing", parseArgs(giveDef, [], book).ok === false);
check("args: bad number", parseArgs(giveDef, ["oak", "x"], book).ok === false);
check("args: fractional int", parseArgs(giveDef, ["oak", "1.5"], book).ok === false);
check("args: unknown name", parseArgs(giveDef, ["zzz"], book).ok === false);
check("complete: command", complete("/gi", [giveDef], book).join() === "give");
check("complete: argument", complete("/give oa", [giveDef], book).join() === "oakMace");

// --- The server ---
const CONFIG = "tiny";
const SEED = 1338;
const { content, packs } = loadContentFromDisk(CONFIG);
const rules = loadRulesFromDisk(CONFIG);
const creatures = loadCreatureRulesFromDisk(CONFIG, rules, SEED);
const progression = loadProgressionRulesFromDisk(CONFIG, rules, SEED);
const items = loadItemRulesFromDisk(CONFIG, rules, SEED);
const worldData = quiet(() => createWorldData(SEED, content));

async function play(devCommands) {
  const server = createServer({ seed: SEED, config: CONFIG, packs, dimensions: content.dimensions, rules, creatures, items, progression, devCommands, loadDimension: () => ({ world: worldData }) });
  const players = [];
  const join = async (name) => {
    const channel = createLocalChannel();
    server.connect(channel.server);
    channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name, dimension: "" });
    const p = { channel, inbox: [], id: 0 };
    players.push(p);
    await pump(15);
    return p;
  };
  const pump = async (steps = 1) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      server.step(1 / 30);
      for (const p of players)
        for (const m of p.channel.client.receive()) {
          if (m.type === "welcome") p.id = m.playerId;
          if (m.type === "transfer") p.channel.client.send({ type: "arrived" });
          p.inbox.push(m);
        }
    }
  };
  const run = async (p, line, channel = "command") => {
    p.inbox.length = 0;
    p.channel.client.send({ type: "chat", channel, text: line });
    await pump(2);
    return p.inbox.filter((m) => m.type === "chatEvent").map((m) => fillText(m.text, m.args));
  };
  return { server, join, run, pump, players };
}

// Off: every developer command refused, nothing changed.
{
  const w = await play(false);
  const a = await w.join("Ayla");
  check("welcome says dev commands are off", a.inbox.find((m) => m.type === "welcome")?.devCommands === false);
  const listed = a.inbox.find((m) => m.type === "commandList");
  check("the list holds only the player's commands", listed && listed.commands.every((c) => !c.dev) && listed.commands.some((c) => c.id === "say"));
  const me = w.server.debug.entity(a.id);
  const before = { x: me.x, z: me.z, bag: JSON.stringify(me.belongings?.bag) };
  for (const line of ["restore", "give oak", "level 5", "xp 100", "heal", "kill", "tp 10 10", "spawn wolf", "learn all"]) {
    const out = await run(w, a, line);
    check(`off: /${line} refused`, out.length === 1 && out[0].includes("Developer commands are off"), JSON.stringify(out));
  }
  check("off: nothing changed", me.x === before.x && me.z === before.z && JSON.stringify(me.belongings?.bag) === before.bag && !me.combat?.dead);
  const unknown = await run(w, a, "frobnicate");
  check("unknown command says so", unknown[0]?.includes("Unknown command"), JSON.stringify(unknown));
  const world = await run(w, a, "world");
  check("/world works with dev off", world.length >= 2 && world[0].includes(`Seed ${SEED}`), JSON.stringify(world));
}
async function run(w, p, line, channel) {
  return w.run(p, line, channel);
}

// On.
{
  const w = await play(true);
  const a = await w.join("Ayla");
  const b = await w.join("Bryn");
  const far = await w.join("Cato");
  check("on: the list has developer commands", a.inbox.find((m) => m.type === "commandList")?.commands.some((c) => c.id === "give"));
  const me = w.server.debug.entity(a.id);
  const bryn = w.server.debug.entity(b.id);
  const cato = w.server.debug.entity(far.id);
  // Put Cato far from the others.
  const level = () => me.progress?.disciplines.get(progression.config.level)?.level;
  const bagCount = () => (me.belongings?.bag ?? []).filter((x) => x != null).length;

  const swordLike = items.types.find((t) => t.slots.length > 0);
  const n0 = bagCount();
  const out = await run(w, a, `give "${swordLike.name}"`);
  check("give: replies", out[0]?.startsWith("Given 1"), JSON.stringify(out));
  check("give: the bag grew", bagCount() === n0 + 1, `${n0} -> ${bagCount()}`);
  check("give: bad item", (await run(w, a, "give zzzzzz"))[0]?.includes("There is no item"));
  check("give: usage shown", (await run(w, a, "give"))[1]?.startsWith("Usage: /give"));
  check("give: bad count", (await run(w, a, "give rusty x"))[0]?.includes("whole number"));

  await run(w, a, "level 7");
  check("level: set", level() === 7, String(level()));
  const xp0 = me.progress.disciplines.get(progression.config.level).xp;
  await run(w, a, "xp 5");
  check("xp: added", me.progress.disciplines.get(progression.config.level).xp !== xp0 || level() > 7);

  w.server.debug.skills.kill(me);
  check("dead before heal", me.combat?.dead === true);
  await run(w, a, "heal");
  check("heal: revived", me.combat?.dead === false);

  const x0 = me.x;
  const reply = await run(w, a, "tp 40 -25");
  check("tp: coordinates", Math.abs(me.x - 40) < 1 && Math.abs(me.z + 25) < 1 && reply[0]?.startsWith("Taken to"), `${me.x},${me.z} ${JSON.stringify(reply)}`);
  const place = worldData.settlements[0];
  await run(w, a, `tp "${place.name}"`);
  check("tp: a place", Math.hypot(me.x - place.x, me.z - place.z) < 3, `${me.x},${me.z} vs ${place.x},${place.z}`);
  check("tp: unknown", (await run(w, a, "tp Nowhereville"))[0]?.includes("no place or zone"));
  check("tp moved", me.x !== x0);

  const kind = creatures.kinds.keys().next().value;
  const before = w.server.debug.creatures.debug.creatures("mainland").length;
  const made = await run(w, a, `spawn ${kind} 2`);
  check("spawn: made", made[0]?.startsWith("Made 2"), JSON.stringify(made));
  check("spawn: entities exist", w.server.debug.creatures.debug.creatures("mainland").length >= before + 2);

  // Commands from the packs: a macro, and an alias a pack gave /give.
  w.server.debug.skills.kill(me);
  const restored = await run(w, a, "restore");
  check("pack macro: /restore healed", me.combat?.dead === false && restored.some((r) => r.includes("restored")), JSON.stringify(restored));
  check("pack macro: and taught", restored.some((r) => r.includes("everything")), JSON.stringify(restored));
  check("pack alias: /i gives", (await run(w, a, `i "${swordLike.name}"`))[0]?.startsWith("Given"));
  const listing = a.inbox.length >= 0 && w.players[0].inbox;
  void listing;

  const learned = await run(w, a, "learn all");
  check("learn all: replies", learned[0]?.includes("everything"), JSON.stringify(learned));
  check("learn: unknown skill", (await run(w, a, "learn zzzzzz"))[0]?.includes("no skill"));

  // Say: heard by those near, not by those far.
  await run(w, b, "tp 0 0");
  await run(w, a, "tp 2 2");
  await run(w, far, "tp 900 900");
  for (const p of [a, b, far]) p.inbox.length = 0;
  const said = await run(w, a, "hello there", "say");
  check("say: the speaker hears it", said.length === 1 && said[0] === "hello there", JSON.stringify(said));
  check("say: a neighbour hears it", b.inbox.some((m) => m.type === "chatEvent" && m.channel === "say" && m.text === "hello there" && m.fromName === "Ayla" && m.typed));
  check("say: a far player does not", !far.inbox.some((m) => m.type === "chatEvent"));
  check("say: via /say", (await run(w, a, "say good day"))[0] === "good day");
  check("say: empty is dropped", (await run(w, a, "   ", "say")).length === 0);

  // Rate limit: a burst is cut off with a warning.
  w.server.step(0);
  let slow = false;
  for (let i = 0; i < 12; i++) if ((await run(w, a, `spam ${i}`, "say"))[0]?.includes("too fast")) slow = true;
  check("rate limit bites", slow);
  void cato;
  void bryn;
}

console.log(failures ? `${failures} FAILED` : "chat: all checks passed");
process.exit(failures ? 1 : 0);
