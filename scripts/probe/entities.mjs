// The entities test (see ENTITIES.md): formulas, game rules, stat and resource blocks, entities on
// the server and what each client is told of them.
//   npm run probe -- scripts/probe/entities.mjs
import { Reader } from "../../src/world/content/contentReader.ts";
import { ContentError } from "../../src/world/content/contentReader.ts";
import { compileFormula } from "../../src/sim/rules/formula.ts";
import { resolveGameRules, checkPlacements } from "../../src/sim/rules/gameRules.ts";
import { loadRulesFromDisk, loadContentFromDisk } from "../diskContent.mjs";
import { addModifier, createStatBlock, explainStat, removeSource, statValue } from "../../src/sim/stats.ts";
import { createResourceBlock, restore, spend, stepResourceBlock, syncMaxima } from "../../src/sim/resources.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";
import { createWorldData, WORLD_SEED } from "../../src/world/worldData.ts";

let failures = 0;
let checks = 0;
function check(what, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
function section(name, run) {
  try {
    run();
  } catch (error) {
    failures++;
    console.log(`FAIL ${name} threw:`, error);
  }
}

// --- formulas ---
section("formulas", () => {
  const names = new Map([["a", 0], ["b", 1]]);
  const values = [3, 4];
  const run = (tree) => {
    const issues = [];
    const f = compileFormula(tree, "f", new Reader(issues, "test"), names);
    return { value: f.run(values), issues, reads: f.reads };
  };
  const cases = [
    [2.5, 2.5],
    ["a", 3],
    [{ add: ["a", "b", 1] }, 8],
    [{ mul: ["a", "b"] }, 12],
    [{ sub: ["a", "b"] }, -1],
    [{ div: ["a", "b"] }, 0.75],
    [{ div: ["a", 0] }, 0],
    [{ neg: "a" }, -3],
    [{ abs: { neg: "a" } }, 3],
    [{ sqrt: { mul: ["a", "a"] } }, 3],
    [{ sqrt: -4 }, 0],
    [{ min: ["a", "b", 7] }, 3],
    [{ max: ["a", "b", 1] }, 4],
    [{ clamp: [10, "a", "b"] }, 4],
    [{ floor: 2.7 }, 2],
    [{ ceil: 2.1 }, 3],
    [{ round: 2.5 }, 3],
    [{ pow: ["a", 3] }, 27],
    [{ pow: [2, -2] }, 0.25],
    [{ pow: [0, -1] }, 0],
    [{ gt: ["b", "a"] }, 1],
    [{ lt: ["b", "a"] }, 0],
    [{ ge: ["a", 3] }, 1],
    [{ le: ["a", 2] }, 0],
    [{ eq: ["a", 3] }, 1],
    [{ and: [1, "a"] }, 1],
    [{ and: [1, 0] }, 0],
    [{ or: [0, 0, 2] }, 1],
    [{ not: 0 }, 1],
    [{ if: [{ gt: ["a", 2] }, 10, 20] }, 10],
  ];
  for (const [tree, want] of cases) {
    const { value, issues } = run(tree);
    check(`formula ${JSON.stringify(tree)}`, issues.length === 0 && near(value, want), `got ${value}, issues ${JSON.stringify(issues)}`);
  }
  check("reads", JSON.stringify(run({ add: ["b", { mul: ["a", "b"] }] }).reads) === "[0,1]");
  const bad = [
    [{ add: [] }, "one or more"],
    [{ sub: [1] }, "expected 2"],
    [{ frob: [1] }, "unknown operation"],
    [{ add: [1], mul: [2] }, "exactly one key"],
    ["c", 'no "c"'],
    [{ pow: ["a", 1.5] }, "whole number"],
    [{ pow: ["a", "b"] }, "whole number"],
    [true, "expected a number"],
  ];
  for (const [tree, want] of bad) {
    const { issues } = run(tree);
    check(`formula error ${JSON.stringify(tree)}`, issues.some((i) => i.message.includes(want)), JSON.stringify(issues));
  }
});

// --- game rules: a tiny pack set of our own, to try the checks ---
const pack = (files, id = "test", priority = 0) => ({
  id,
  files: [{ path: "pack.json5", text: `{ priority: ${priority} }` }, ...Object.entries(files).map(([path, data]) => ({ path, text: JSON.stringify(data) }))],
});
const BASE = {
  "stats/stamina.json5": { default: 1 },
  "stats/maxHealth.json5": { formula: { mul: ["stamina", 10] } },
  "modifiers/flat.json5": { order: 100, gather: "sum", apply: { add: ["value", "total"] } },
  "resources/health.json5": { max: "maxHealth" },
  "entities/player.json5": { stats: { stamina: 5 } },
};
const issuesOf = (packs) => {
  try {
    resolveGameRules(packs);
    return [];
  } catch (error) {
    if (!(error instanceof ContentError)) throw error;
    return error.issues;
  }
};
section("game rules", () => {
  check("a minimal set resolves", issuesOf([pack(BASE)]).length === 0, JSON.stringify(issuesOf([pack(BASE)])));
  const cycle = issuesOf([pack({ ...BASE, "stats/a.json5": { formula: { add: ["b", 1] } }, "stats/b.json5": { formula: "a" } })]);
  check("a cycle between stats is reported", cycle.some((i) => i.message.includes("circle")), JSON.stringify(cycle));
  const noHealth = { ...BASE };
  delete noHealth["resources/health.json5"];
  check("no health is reported", issuesOf([pack(noHealth)]).some((i) => i.message.includes("health")));
  const derivedBase = issuesOf([pack({ ...BASE, "entities/player.json5": { stats: { maxHealth: 5 } } })]);
  check("a template may not set a derived stat", derivedBase.some((i) => i.message.includes("derived")), JSON.stringify(derivedBase));
  const templateCycle = issuesOf([pack({ ...BASE, "entities/x.json5": { extends: "y" }, "entities/y.json5": { extends: "x" } })]);
  check("a cycle between templates is reported", templateCycle.some((i) => i.message.includes("circle")), JSON.stringify(templateCycle));
  const missingParent = issuesOf([pack({ ...BASE, "entities/x.json5": { extends: "nobody" } })]);
  check("a missing parent is reported", missingParent.some((i) => i.message.includes('no template "nobody"')));
  const typo = issuesOf([pack({ ...BASE, "stats/x.json5": { defualt: 1 } })]);
  check("an unknown field is reported", typo.some((i) => i.message.includes("unknown field")));
  // A later pack replaces an earlier one's file of the same id.
  const over = resolveGameRules([pack(BASE), pack({ "stats/stamina.json5": { default: 7, name: "Grit" } }, "mod", 10)]);
  check("a later pack replaces a stat", over.stats[over.statIndex.get("stamina")].name === "Grit");
  // Inheritance: objects merge, lists are replaced, abstract is not inherited.
  const rules = resolveGameRules([
    pack({
      ...BASE,
      "stats/spirit.json5": {},
      "resources/mana.json5": { max: "stamina" },
      "entities/base.json5": { abstract: true, stats: { stamina: 2, spirit: 3 }, resources: ["mana"], look: { height: 3, color: [1, 0, 0] } },
      "entities/child.json5": { extends: "base", stats: { stamina: 9 }, resources: [], look: { radius: 1 } },
    }),
  ]);
  const child = rules.templates.get("child");
  const statOf = (t, id) => t.stats.find((s) => s.stat === rules.statIndex.get(id))?.value;
  check("abstract templates are left out", !rules.templates.has("base"));
  check("child stats merge over the parent's", statOf(child, "stamina") === 9 && statOf(child, "spirit") === 3);
  check("lists are replaced, health always there", JSON.stringify(child.resources) === JSON.stringify([rules.health]));
  check("look merges", child.look.height === 3 && child.look.radius === 1 && child.look.color[0] === 1);
  check("derived stats come after what they read", rules.statOrder.indexOf(rules.statIndex.get("maxHealth")) > rules.statOrder.indexOf(rules.statIndex.get("stamina")));
});

// --- the core pack ---
section("core pack", () => {
  const rules = loadRulesFromDisk();
  console.log(`core: ${rules.stats.length} stats, ${rules.modifierKinds.length} modifier kinds, ${rules.resources.length} resources, ${rules.templates.size} templates (hash ${rules.hash.toString(16)})`);
  check("core has a player and a dummy", rules.templates.has("player") && rules.templates.has("trainingDummy"));
  check("core's kinds apply flat, percent, multiplier", rules.applyOrder.map((k) => rules.modifierKinds[k].id).join() === "flat,percent,multiplier");
  const { content } = loadContentFromDisk();
  checkPlacements(rules, content.dimensions);
  check("mainland places a dummy", content.dimensions.find((d) => d.id === "mainland").entities.some((e) => e.template === "trainingDummy"));
});

// --- stacking and removal ---
section("stacking", () => {
  const rules = resolveGameRules([
    pack({
      ...BASE,
      "stats/spirit.json5": { default: 10 },
      "modifiers/percent.json5": { order: 200, gather: "sum", apply: { mul: ["value", { add: [1, { div: ["total", 100] }] }] } },
      "modifiers/multiplier.json5": { order: 300, gather: "product", apply: { mul: ["value", "total"] } },
      "modifiers/best.json5": { order: 250, gather: "max", apply: { add: ["value", "total"] } },
    }),
  ]);
  const player = rules.templates.get("player");
  const S = (id) => rules.statIndex.get(id);
  const K = (id) => rules.kindIndex.get(id);
  const block = createStatBlock(rules, player);
  check("base from the template", statValue(block, S("stamina")) === 5);
  check("derived from the formula", statValue(block, S("maxHealth")) === 50);
  addModifier(block, { stat: S("stamina"), kind: K("flat"), value: 10, source: "gear:chest" });
  addModifier(block, { stat: S("stamina"), kind: K("percent"), value: 20, source: "aura:1" });
  addModifier(block, { stat: S("stamina"), kind: K("multiplier"), value: 1.1, source: "aura:1" });
  check("(5 + 10) x 1.2 x 1.1", near(statValue(block, S("stamina")), 15 * 1.2 * 1.1), String(statValue(block, S("stamina"))));
  check("derived stats follow", near(statValue(block, S("maxHealth")), 15 * 1.2 * 1.1 * 10));
  addModifier(block, { stat: S("spirit"), kind: K("best"), value: 3, source: "aura:2" });
  addModifier(block, { stat: S("spirit"), kind: K("best"), value: 7, source: "aura:3" });
  check("max gathers only the strongest", statValue(block, S("spirit")) === 17);
  // best (order 250) lands between percent and multiplier.
  addModifier(block, { stat: S("spirit"), kind: K("percent"), value: 100, source: "aura:2" });
  addModifier(block, { stat: S("spirit"), kind: K("multiplier"), value: 2, source: "aura:2" });
  check("a kind's order puts it between", statValue(block, S("spirit")) === (10 * 2 + 7) * 2, String(statValue(block, S("spirit"))));
  const breakdown = explainStat(block, S("spirit"));
  check("explainStat names each kind in order", breakdown.steps.map((s) => rules.modifierKinds[s.kind].id).join() === "percent,best,multiplier");
  check("removeSource removes across stats", removeSource(block, "aura:2") === 3);
  check("spirit back", statValue(block, S("spirit")) === 17);
  removeSource(block, "aura:1");
  removeSource(block, "gear:chest");
  removeSource(block, "aura:3");
  check("all back to the template", statValue(block, S("stamina")) === 5 && statValue(block, S("spirit")) === 10 && statValue(block, S("maxHealth")) === 50);
  let threw = false;
  try {
    addModifier(block, { stat: 99, kind: 0, value: 1, source: "x" });
  } catch {
    threw = true;
  }
  check("a modifier of no stat throws", threw);
});

// --- resources ---
section("resources", () => {
  const rules = resolveGameRules([
    pack({
      ...BASE,
      "stats/maxRage.json5": { default: 100 },
      "resources/health.json5": { max: "maxHealth", regen: { outOfCombat: 5, inCombat: 0 }, interval: 2 },
      "resources/rage.json5": { max: "maxRage", start: 0, regen: { outOfCombat: -2, inCombat: 0 } },
      "resources/focus.json5": { max: "maxHealth", onMaxChange: "scale" },
      "entities/player.json5": { stats: { stamina: 5 }, resources: ["rage", "focus"] },
    }),
  ]);
  const player = rules.templates.get("player");
  const R = (id) => rules.resourceIndex.get(id);
  const stats = createStatBlock(rules, player);
  const res = createResourceBlock(rules, player, stats, 0);
  const H = R("health");
  check("health is always there, full", res.has.includes(H) && res.current[H] === 50);
  check("rage starts empty", res.current[R("rage")] === 0);
  spend(res, H, 30);
  check("spend", res.current[H] === 20);
  check("cannot spend what is not there", !spend(res, H, 100) && res.current[H] === 20);
  stepResourceBlock(res, stats, false, 1.5);
  check("no regen before the tick", res.current[H] === 20);
  stepResourceBlock(res, stats, false, 0.5);
  check("a tick is rate x interval", res.current[H] === 30, String(res.current[H]));
  stepResourceBlock(res, stats, true, 4);
  check("none in combat", res.current[H] === 30);
  stepResourceBlock(res, stats, false, 100);
  check("never above max", res.current[H] === 50);
  restore(res, R("rage"), 10);
  stepResourceBlock(res, stats, false, 3);
  check("rage decays smoothly", near(res.current[R("rage")], 4), String(res.current[R("rage")]));
  stepResourceBlock(res, stats, false, 10);
  check("and not below 0", res.current[R("rage")] === 0);
  spend(res, H, 25);
  spend(res, R("focus"), 25);
  addModifier(stats, { stat: rules.statIndex.get("stamina"), kind: rules.kindIndex.get("flat"), value: 5, source: "x" });
  syncMaxima(res, stats);
  check("keep: the value stays when the max grows", res.current[H] === 25 && res.max[H] === 100);
  check("scale: the fraction stays", res.current[R("focus")] === 50);
  removeSource(stats, "x");
  syncMaxima(res, stats);
  check("keep: clamped when the max shrinks", res.current[H] === 25 && res.max[H] === 50);
});

// --- replication: a real server, the small config's mainland, two clients over the channel ---
await (async () => {
  const configName = "small";
  const rules = loadRulesFromDisk(configName);
  const { content, packs } = loadContentFromDisk(configName);
  const server = createServer({
    seed: WORLD_SEED,
    config: configName,
    packs,
    dimensions: content.dimensions,
    rules,
    loadDimension: (definition, seed) => ({ world: createWorldData(seed, definition.start ? content : loadContentFromDisk(configName, definition.id).content) }),
  });
  const client = (name) => {
    const channel = createLocalChannel();
    server.connect(channel.server);
    channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name, dimension: "" });
    return { end: channel.client, id: 0, inbox: [] };
  };
  const a = client("a");
  const b = client("b");
  const pump = async (steps = 1) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0)); // let a dimension's load resolve
      server.step(1 / 30);
      for (const c of [a, b]) {
        for (const m of c.end.receive()) {
          if (m.type === "welcome") c.id = m.playerId;
          if (m.type === "transfer") c.end.send({ type: "arrived" });
          c.inbox.push(m);
        }
      }
    }
  };
  await pump(10);
  const take = (c) => c.inbox.splice(0);
  const S = (id) => rules.statIndex.get(id);
  const H = rules.health;
  let inA = take(a);
  let inB = take(b);
  const spawnsOf = (msgs) => msgs.filter((m) => m.type === "entitySpawn");
  const spawnOf = (msgs, id) => spawnsOf(msgs).find((m) => m.id === id);
  check("welcome carries the rules hash", inA.some((m) => m.type === "welcome" && m.rules === rules.hash));
  const dummySpawn = spawnsOf(inA).find((m) => m.template === "trainingDummy");
  check("a sees the dummy, once", dummySpawn && spawnsOf(inA).filter((m) => m.template === "trainingDummy").length === 1);
  const bInA = spawnOf(inA, b.id);
  const aInA = spawnOf(inA, a.id);
  check("a sees b's health", bInA?.resources.some((r) => r.resource === H));
  check("a does not see b's stamina", bInA && !bInA.stats.some((s) => s.stat === S("stamina")));
  check("a sees b's max health (visible: all)", bInA?.stats.some((s) => s.stat === S("maxHealth")));
  check("a sees all of its own stats", aInA?.stats.length === rules.stats.length);
  check("only its own modifiers", inA.filter((m) => m.type === "entityModifiers").every((m) => m.id === a.id));
  // A modifier on b: b is told its new stack, a only the visible value that changed.
  b.end.send({ type: "debugModifier", entity: 0, stat: S("stamina"), kind: rules.kindIndex.get("flat"), value: 10, source: "debug" });
  await pump(1);
  inA = take(a);
  inB = take(b);
  const bMods = inB.find((m) => m.type === "entityModifiers");
  check("b gets its stack", bMods?.modifiers.some((m) => m.source === "debug" && m.value === 10));
  const bValuesInA = inA.find((m) => m.type === "entityValues" && m.id === b.id);
  check("a gets b's new max health, not its stamina", bValuesInA && bValuesInA.stats.some((s) => s.stat === S("maxHealth") && s.value === 255) && !bValuesInA.stats.some((s) => s.stat === S("stamina")), JSON.stringify(bValuesInA));
  check("a is not sent b's stack", !inA.some((m) => m.type === "entityModifiers" && m.id === b.id));
  check("nothing is spawned twice", spawnsOf(inA).length === 0);
  // The dummy stands still: no motion for it in snapshots.
  const snapshot = inA.filter((m) => m.type === "snapshot").pop();
  check("a still dummy is not in snapshots", snapshot && !snapshot.entities.some((e) => e.id === dummySpawn.id) && snapshot.entities.some((e) => e.id === a.id));
  // b removes it again.
  b.end.send({ type: "debugRemoveSource", entity: 0, source: "debug" });
  await pump(1);
  check("removed: b's stamina back", server.debug.entity(b.id).stats && statValue(server.debug.entity(b.id).stats, S("stamina")) === 12);
  take(a);
  take(b);
  // a walks out of range: the dummy and b are despawned for a, and come back when it returns.
  a.end.send({ type: "teleport", x: 400, z: 0 });
  await pump(1);
  inA = take(a);
  const despawned = inA.filter((m) => m.type === "entityDespawn").map((m) => m.id);
  check("out of range: despawns", despawned.includes(dummySpawn.id) && despawned.includes(b.id), JSON.stringify(despawned));
  a.end.send({ type: "teleport", x: 0, z: 0 });
  await pump(1);
  inA = take(a);
  check("back in range: spawns again", spawnOf(inA, dummySpawn.id) && spawnOf(inA, b.id));
  // Spawning and despawning by debug command.
  a.end.send({ type: "debugSpawn", template: "trainingDummy", x: 3, z: 3 });
  await pump(1);
  inA = take(a);
  const extra = spawnsOf(inA).find((m) => m.template === "trainingDummy");
  check("debugSpawn makes one", !!extra);
  a.end.send({ type: "debugDespawn", entity: extra?.id ?? 0 });
  await pump(1);
  check("debugDespawn removes it", take(a).some((m) => m.type === "entityDespawn" && m.id === extra?.id));
  a.end.send({ type: "debugDespawn", entity: b.id });
  await pump(1);
  check("a player cannot be despawned", !!server.debug.entity(b.id) && !take(a).some((m) => m.type === "entityDespawn"));
  // Speed: +100% speed and the body goes twice as far.
  const walk = async (c) => {
    const e = server.debug.entity(c.id);
    const from = { x: e.x, z: e.z };
    c.end.send({ type: "intent", seq: 1, moveX: 1, moveZ: 0, run: false, jump: false });
    await pump(15);
    c.end.send({ type: "intent", seq: 2, moveX: 0, moveZ: 0, run: false, jump: false });
    await pump(1);
    return Math.hypot(e.x - from.x, e.z - from.z);
  };
  const normal = await walk(a);
  a.end.send({ type: "debugModifier", entity: 0, stat: S("speed"), kind: rules.kindIndex.get("percent"), value: 100, source: "debug" });
  const fast = await walk(a);
  check("speed doubles the pace", Math.abs(fast / normal - 2) < 0.2, `${normal.toFixed(2)} m, then ${fast.toFixed(2)} m`);
})().catch((error) => {
  failures++;
  console.log("FAIL replication threw:", error);
});

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
