// The progression test (see PROGRESSION.md): rules, curves, sources, unlocks, talents, origins and
// saves, and a real `tiny` server where it matters.
//   npm run probe -- scripts/probe/progression.mjs
import { ContentError } from "../../src/world/content/contentReader.ts";
import { loadRulesFromDisk, loadCreatureRulesFromDisk, loadItemRulesFromDisk, loadProgressionRulesFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { resolveGameRules } from "../../src/sim/rules/gameRules.ts";
import { resolveProgressionRules, checkProgressionItems } from "../../src/sim/rules/progressionRules.ts";
import { createEntity } from "../../src/sim/entity.ts";
import { statValue } from "../../src/sim/stats.ts";
import { addXp, createProgress, learn, nextOf, pickTalent, resetTree, setLevel } from "../../src/sim/progression/progress.ts";
import { exportProgress, importProgress } from "../../src/sim/progression/save.ts";
import { loadContentFromDisk } from "../diskContent.mjs";
import { formulaText } from "../../src/sim/rules/formulaText.ts";
import { chapterText, ruleBookChapters } from "../../src/ui/ruleBook.ts";
import { createWorldData, WORLD_SEED } from "../../src/world/worldData.ts";
import { createServer } from "../../src/sim/server.ts";
import { createLocalChannel } from "../../src/sim/channel.ts";
import { PROTOCOL_VERSION } from "../../src/sim/protocol.ts";
import { EVENT_KIND } from "../../src/sim/skills/events.ts";

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

/** Fresh rules for a config's packs plus extra files, through the whole chain - or the error. */
function rulesWith(extra = {}, seed = SEED) {
  const packs = [...sources, { id: "probe", files: [{ path: "pack.json5", text: "{ name: 'Probe', priority: 100 }" }, ...Object.entries(extra).map(([path, text]) => ({ path, text }))] }];
  const game = resolveGameRules(packs);
  try {
    return { game, progression: resolveProgressionRules(packs, game, seed) };
  } catch (error) {
    if (error instanceof ContentError) return { error, issues: error.issues };
    throw error;
  }
}
const expectError = (what, extra, pattern) => {
  const result = rulesWith(extra);
  const found = result.issues?.some((i) => pattern.test(`${i.path} ${i.message}`));
  check(`refused: ${what}`, !!found, result.issues ? result.issues.map((i) => `${i.file} ${i.path}: ${i.message}`).join(" | ") : "no error");
};

await section("rules", () => {
  const game = loadRulesFromDisk(CONFIG);
  loadCreatureRulesFromDisk(CONFIG, game, SEED);
  const progression = loadProgressionRulesFromDisk(CONFIG, game, SEED);
  const items = loadItemRulesFromDisk(CONFIG, game, SEED);
  checkProgressionItems(progression, items);
  const ids = progression.disciplines.map((d) => d.id);
  for (const id of ["adventure", "class", "defence", "mining", "herbalism", "cooking"]) check(`discipline ${id}`, ids.includes(id), ids.join(","));
  check("slots", progression.config.slots.map((s) => s.id).join(",") === "people,class");
  check("level discipline", progression.disciplines[progression.config.level]?.id === "adventure");
  check("combinations", progression.combinations.size >= 9, String(progression.combinations.size));
  const dwarfMage = game.templates.get(progression.combinations.get("dwarf.mage") ?? "");
  check("dwarf mage template", !!dwarfMage);
  if (dwarfMage) {
    const stat = (id) => dwarfMage.stats.find((s) => s.stat === game.statIndex.get(id))?.value;
    check("stats add", stat("stamina") === 12 + 2 - 1 && stat("intellect") === 10 + 4, `${stat("stamina")} ${stat("intellect")}`);
    check("look race", dwarfMage.look.race === "dwarf", dwarfMage.look.race);
    check("class resource", dwarfMage.resources.includes(game.resourceIndex.get("mana")));
  }
  check("pools", progression.pools.join(",") === "choice,talent", progression.pools.join(","));
  check("trainer", progression.config.trainers.has("trainer"));
  console.log(`rules: ${progression.disciplines.length} disciplines, ${progression.origins.length} origins, ${progression.trees.length} trees, ${progression.combinations.size} combinations`);

  expectError("an unknown stat", { "disciplines/bad.json5": '{ stat: "nope", next: 10 }' }, /no stat "nope"/);
  expectError("a derived stat", { "disciplines/bad.json5": '{ stat: "maxHealth", next: 10 }' }, /derived stat/);
  expectError("no curve", { "disciplines/bad.json5": "{ }" }, /next/);
  expectError("a curve of 0", { "disciplines/bad.json5": "{ next: 0 }" }, /more than 0/);
  expectError("an unknown source", { "disciplines/bad.json5": '{ next: 10, xp: [{ on: "sneeze" }] }' }, /expected one of/);
  expectError("credit on a hit", { "disciplines/bad.json5": '{ next: 10, xp: [{ on: "hitDealt", credit: "all" }] }' }, /credit/);
  expectError("an unknown name in a source", { "disciplines/bad.json5": '{ next: 10, xp: [{ on: "kill", amount: "victim.sparkle" }] }' }, /victim.sparkle/);
  expectError("an unknown skill unlock", { "disciplines/bad.json5": '{ next: 10, unlocks: [{ at: 2, skill: "nope" }] }' }, /no skill "nope"/);
  expectError("an unlock without levels", { "disciplines/bad.json5": '{ next: 10, unlocks: [{ skill: "kick" }] }' }, /needs `at`/);
  expectError("an unknown origin slot", { "origins/bad.json5": '{ slot: "deity" }' }, /no slot "deity"/);
  expectError("an unknown tree", { "origins/bad.json5": '{ slot: "class", trees: ["nope"] }' }, /no talent tree "nope"/);
  expectError("a node in a missing tier", { "talentTrees/bad.json5": '{ tiers: [{}], nodes: { a: { tier: 1 } } }' }, /tiers/);
  expectError("nodes in a circle", { "talentTrees/bad.json5": '{ tiers: [{}], nodes: { a: { tier: 0, requires: ["b"] }, b: { tier: 0, requires: ["a"] } } }' }, /circle/);
  expectError("a tier that cannot open", { "talentTrees/bad.json5": '{ tiers: [{}, { requires: 5 }], nodes: { a: { tier: 0 }, b: { tier: 1 } } }' }, /tiers below hold only 1/);
  expectError("an xp action naming no discipline", { "skills/badXp.json5": '{ target: "self", states: { a: { enter: [{ do: "xp", discipline: "nope", amount: 1 }] } } }' }, /no discipline "nope"/);
});

await section("generation", () => {
  const one = rulesWith({}, SEED).progression;
  const again = rulesWith({}, SEED).progression;
  const sword = one.disciplines.find((d) => d.id === "weaponSkill.sword");
  check("a discipline per weapon", !!sword && one.disciplines.some((d) => d.id === "weaponSkill.unarmed"));
  check("its stat from the part", sword && sword.stat === loadRulesFromDisk(CONFIG).statIndex.get("swordSkill"));
  check("its vars rolled within range", sword && sword.varNames.join() === "base,slope" && sword.vars[0] >= 6 && sword.vars[0] <= 10 && sword.vars[1] >= 1.5 && sword.vars[1] <= 3, JSON.stringify(sword?.vars));
  check("its weapon match filled in", sword?.sources[0].weapon?.template === "sword" && one.disciplines.find((d) => d.id === "weaponSkill.unarmed").sources[0].weapon === "none");
  const hybrids = (p) => p.origins.filter((o) => o.template === "hybrid");
  check("a world keeps two hybrids", hybrids(one).length === 2, hybrids(one).map((o) => o.id).join());
  check("never: no holy warden", !one.origins.some((o) => o.id === "hybrid.warden.holy"));
  const describe = (p) => JSON.stringify([p.disciplines.map((d) => `${d.id}:${d.vars}`), hybrids(p).map((o) => [o.id, o.name, [...o.unlocks.values()].flat().map((u) => `${u.skill}@${u.at}`), o.trees.map((t) => p.trees[t].nodes.map((n) => `${n.id}/${n.tier}`))])]);
  check("the same seed, the same ruleset", describe(one) === describe(again) && one.hash === again.hash);
  let differs = false;
  for (let s = 1; s < 12 && !differs; s++) differs = describe(rulesWith({}, s).progression) !== describe(one);
  check("another seed, another ruleset", differs);
  const h = hybrids(one)[0];
  check("a hybrid's name from its parts", h && /^(Flame|Holy) (Blade|Warden)$/.test(h.name), h?.name);
  check("a hybrid's abilities by class level", h && (h.unlocks.get(one.disciplineIndex.get("class")) ?? []).length >= 2);
  const tree = h && one.trees[h.trees[0]];
  check("a hybrid's generated tree", tree && tree.nodes.length >= 5 && tree.tiers.length === 3 && tree.tiers[2].requires > 0, JSON.stringify(tree?.tiers));
  check("hybrids join the combinations", h && one.combinations.has(`human.${h.id}`));
  expectError("a template naming no pool", { "originTemplates/bad.json5": '{ slot: "class", axes: { a: [{ id: "x" }] }, tree: { nodes: { pick: 2, pool: "nope" } } }' }, /no talent pool "nope"/);
  expectError("a part with a stat that does not exist", { "disciplineTemplates/bad.json5": '{ next: 10, stat: "{w.stat}", axes: { w: [{ id: "x", stat: "nopeSkill" }] } }' }, /no stat "nopeSkill"/);
});

await section("rule book", () => {
  const cases = [
    [{ add: [45, { mul: [5, "victim.level"] }] }, "45 + 5 × victim level"],
    [{ mul: [{ add: [1, 2] }, 3] }, "(1 + 2) × 3"],
    [{ sub: [10, { sub: [4, 1] }] }, "10 − (4 − 1)"],
    [{ min: [{ div: ["amount", 4] }, 5] }, "the lower of amount / 4, 5"],
    [{ pow: ["own", 2] }, "own^2"],
    [{ floor: { mul: ["level", 0.5] } }, "(level × 0.5) rounded down"],
    [{ if: [{ ge: ["a", "b"] }, 1, 0] }, "if a ≥ b then 1, else 0"],
  ];
  for (const [tree, want] of cases) check(`formula text: ${want}`, formulaText(tree) === want, formulaText(tree));
  const game = loadRulesFromDisk(CONFIG);
  loadCreatureRulesFromDisk(CONFIG, game, SEED);
  const progression = loadProgressionRulesFromDisk(CONFIG, game, SEED);
  const items = loadItemRulesFromDisk(CONFIG, game, SEED);
  const chapters = ruleBookChapters(game, progression, items);
  const titles = chapters.map((c) => c.title);
  for (const t of ["Disciplines", "People", "Class", "Talents", "Stats", "Resources", "Combat", "Abilities"]) check(`chapter ${t}`, titles.includes(t), titles.join(","));
  const text = chapterText(chapters);
  const unreadable = /\?(?![a-z]+=)/;
  check("no formula left unreadable", !unreadable.test(text), text.split("\n").filter((l) => unreadable.test(l)).slice(0, 5).join(" / "));
  check("the kill XP reads", text.includes("Killing a creature: (45 + 5 × the victim's Level) × the victim's XP value"), text.split("\n").find((l) => l.includes("Killing")));
  check("an unlock reads", text.includes("At level 2: you learn Thunder Clap."));
  check("a generated class says so", text.includes('invented it from the template "hybrid"'));
  // What a stat does and where it comes from; what a discipline does; what an ability does.
  const section = (heading) => text.split("\n## ").find((s) => s.startsWith(`${heading}\n`)) ?? "";
  check("intellect: what reads it", section("Intellect").includes("Max mana") && section("Intellect").includes("Fireball"), section("Intellect"));
  check("intellect: where it comes from", section("Intellect").includes("Mage: +4") && section("Intellect").includes("Talent Focus"));
  check("swords: what it does", section("Swords (combat)").includes("Iron") && section("Swords (combat)").includes("How it rises"), section("Swords (combat)"));
  check("defence: what it does", section("Defence (combat)").includes("level × 4 Armor"), section("Defence (combat)"));
  check("fireball described", section("Fireball").includes("damage to the target") && section("Fireball").includes("Mage from the start"), section("Fireball"));
  check("burn is an effect", section("Burn").startsWith("Burn\nAn effect Fireball applies"), section("Burn"));
  const own = { stats: new Map([[game.statIndex.get("intellect"), 14]]), levels: new Map([[progression.disciplineIndex.get("adventure"), 3]]), origins: [progression.originIndex.get("elf"), progression.originIndex.get("mage")] };
  const mine = chapterText(ruleBookChapters(game, progression, items, own));
  check("your character chapter", mine.startsWith("# Your character") && mine.includes("Intellect: 14") && mine.includes("class: Mage"), mine.slice(0, 300));
  check("your values on their pages", mine.includes("Yours: 14.") && mine.includes("You are level 3."));
  if (process.env.BOOK) console.log(text);
});

// --- a stand-in character: the progress functions with a spell book of their own ---
const PROBE_PACK = {
  "disciplines/pA.json5": '{ next: 100, cap: 3, unlocks: [{ at: 2, resource: "rage" }, { at: 3, disciplines: { mining: 2 } }] }',
  "disciplines/pB.json5": '{ next: 100, cap: "disc.pA", overflow: "keep" }',
};
const probe = rulesWith(PROBE_PACK);
if (probe.error) console.log(probe.issues);
const { game: G, progression: P } = probe;
const ctx = {
  game: G,
  rules: P,
  grant(entity, skill, level, source) {
    if (!entity.combat.spells.some((s) => s.skill === skill)) entity.combat.spells.push({ skill, level, source, ready: 0, passive: null });
  },
  revoke(entity, source) {
    entity.combat.spells = entity.combat.spells.filter((s) => s.source !== source);
  },
};
let nextId = 1;
function character(people, klass) {
  const template = G.templates.get(P.combinations.get(`${people}.${klass}`));
  const entity = createEntity(G, template, nextId++, { dimension: "", x: 0, y: 0, z: 0, facing: 0 });
  for (const s of template.spells) entity.combat.spells.push({ skill: s.skill, level: s.level, source: "template", ready: 0, passive: null });
  createProgress(ctx, entity, new Map([["people", P.originIndex.get(people)], ["class", P.originIndex.get(klass)]]));
  return entity;
}
const D = (id) => P.disciplineIndex.get(id);
const T = (id) => P.treeIndex.get(id);
const node = (tree, id) => P.trees[T(tree)].nodes.find((n) => n.id === id).index;
const stat = (entity, id) => statValue(entity.stats, G.statIndex.get(id));
const knows = (entity, skill) => entity.combat.spells.find((s) => s.skill === G.skillIndex.get(skill));
const level = (entity, d) => entity.progress.disciplines.get(D(d))?.level ?? 0;

await section("curves", () => {
  const mage = character("human", "mage");
  check("starts", level(mage, "adventure") === 1 && level(mage, "class") === 1 && level(mage, "pA") === 1 && level(mage, "mining") === 0);
  check("level stat", stat(mage, "level") === 1 && stat(mage, "classLevel") === 1);
  check("no rage yet", !mage.resources.has.includes(G.resourceIndex.get("rage")));
  const taken = addXp(ctx, mage, D("pA"), 250, "probe");
  check("several levels at once, up to the cap", level(mage, "pA") === 3, String(level(mage, "pA")));
  check("past the cap is lost", taken === 200, String(taken));
  check("a resource unlocked", mage.resources.has.includes(G.resourceIndex.get("rage")));
  check("a discipline started", level(mage, "mining") === 2, String(level(mage, "mining")));
  const events = mage.progress.events.filter((e) => e.kind === "levelUp" && e.discipline === D("pA"));
  check("level-up events", events.length === 2, String(events.length));

  const other = character("human", "mage");
  addXp(ctx, other, D("pB"), 150, "probe");
  check("banked at the cap", level(other, "pB") === 1 && other.progress.disciplines.get(D("pB")).banked === 150);
  addXp(ctx, other, D("pA"), 100, "probe");
  const pb = other.progress.disciplines.get(D("pB"));
  check("banked flows when the cap rises, and banks again at the new one", level(other, "pB") === 2 && pb.xp === 0 && pb.banked === 50, JSON.stringify(pb));

  const human = character("human", "warrior");
  const before = human.progress.disciplines.get(D("adventure")).xp;
  addXp(ctx, human, D("adventure"), 100, "probe");
  check("a people's rate", Math.abs(human.progress.disciplines.get(D("adventure")).xp - before - 110) < 1e-9, String(human.progress.disciplines.get(D("adventure")).xp));
  check("adventure curve", nextOf(ctx, human, D("adventure")) === 250, String(nextOf(ctx, human, D("adventure"))));
});

await section("unlocks", () => {
  const warrior = character("dwarf", "warrior");
  check("a people's discipline", level(warrior, "mining") === 5);
  check("class kit", !!knows(warrior, "heroicStrike") && !!knows(warrior, "charge") && !knows(warrior, "thunderClap") && !knows(warrior, "fireball"));
  setLevel(ctx, warrior, D("class"), 2);
  check("auto at its level", knows(warrior, "thunderClap")?.source === "learn:auto", JSON.stringify(knows(warrior, "thunderClap")));
  check("not yet available", !warrior.progress.available.has(G.skillIndex.get("kick")));
  setLevel(ctx, warrior, D("class"), 3);
  check("trainer: available", warrior.progress.available.get(G.skillIndex.get("kick"))?.cost === 50);
  check("not from a book", learn(ctx, warrior, G.skillIndex.get("kick"), "item") === "notYet");
  check("from the trainer", learn(ctx, warrior, G.skillIndex.get("kick"), "trainer") === "" && knows(warrior, "kick")?.source === "learn:trainer");
  check("not twice", learn(ctx, warrior, G.skillIndex.get("heroicStrike"), "trainer") === "known");

  const armor0 = stat(warrior, "armor");
  setLevel(ctx, warrior, D("defence"), 3);
  check("modifiers grow per level", Math.abs(stat(warrior, "armor") - armor0 - 8 * 1.05) < 1e-9, `${armor0} -> ${stat(warrior, "armor")}`);
  check("defence stat", stat(warrior, "defenceSkill") === 3);

  const mage = character("elf", "mage");
  setLevel(ctx, mage, D("class"), 3);
  check("item: available", mage.progress.available.get(G.skillIndex.get("frostNova"))?.how === "item");
  check("item: not from a trainer", learn(ctx, mage, G.skillIndex.get("frostNova"), "trainer") === "notYet");
  check("item: taught by a book", learn(ctx, mage, G.skillIndex.get("frostNova"), "item") === "" && knows(mage, "frostNova")?.source === "learn:item");
});

await section("talents", () => {
  const w = character("human", "warrior");
  const arms = T("warriorArms");
  check("no points at 1", w.progress.left.get("talent") === 0);
  check("refused without points", pickTalent(ctx, w, arms, node("warriorArms", "toughness")) === "points");
  setLevel(ctx, w, D("adventure"), 4);
  check("a point a level from 2", w.progress.left.get("talent") === 3 && w.progress.left.get("choice") === 1, JSON.stringify([...w.progress.left]));
  check("tier locked", pickTalent(ctx, w, arms, node("warriorArms", "longStun")) === "tierLocked");
  const armor0 = stat(w, "armor");
  for (let i = 0; i < 3; i++) pickTalent(ctx, w, arms, node("warriorArms", "toughness"));
  check("ranks", w.progress.talents.get(arms).get(node("warriorArms", "toughness")) === 3);
  check("maxed", pickTalent(ctx, w, arms, node("warriorArms", "toughness")) === "maxed");
  check("modifier of rank", Math.abs(stat(w, "armor") - armor0 * 1.09) < 1e-6, `${armor0} -> ${stat(w, "armor")}`);
  setLevel(ctx, w, D("adventure"), 7);
  check("requires", pickTalent(ctx, w, arms, node("warriorArms", "deepWounds")) === "requires");
  pickTalent(ctx, w, arms, node("warriorArms", "might"));
  pickTalent(ctx, w, arms, node("warriorArms", "might"));
  check("a node's ability", pickTalent(ctx, w, arms, node("warriorArms", "deepWounds")) === "" && knows(w, "deepWounds")?.source === "talent:warriorArms");
  check("out of points", pickTalent(ctx, w, arms, node("warriorArms", "mortalStrike")) === "points");

  const ms = T("milestones");
  check("choice at 3 and 6", w.progress.left.get("choice") === 2);
  check("pick one", pickTalent(ctx, w, ms, node("milestones", "vigour")) === "");
  check("only one a tier", pickTalent(ctx, w, ms, node("milestones", "focus")) === "picked");
  check("the next tier", pickTalent(ctx, w, ms, node("milestones", "ironSkin")) === "");
  check("a tier's level", pickTalent(ctx, w, ms, node("milestones", "lifeblood")) === "level");
  check("not another class's tree", pickTalent(ctx, w, T("mageFire"), 0) === "noTree");

  resetTree(ctx, w, arms);
  check("reset: points back", w.progress.left.get("talent") === 6);
  check("reset: ability gone", !knows(w, "deepWounds"));
  check("reset: modifiers gone", !w.stats.modifiers.some((m) => m.source === "talent:warriorArms"));
});

await section("saves", () => {
  const w = character("dwarf", "warrior");
  setLevel(ctx, w, D("adventure"), 7);
  addXp(ctx, w, D("adventure"), 123, "probe");
  setLevel(ctx, w, D("class"), 3);
  learn(ctx, w, G.skillIndex.get("kick"), "trainer");
  for (const id of ["toughness", "toughness", "might", "might", "deepWounds"]) pickTalent(ctx, w, T("warriorArms"), node("warriorArms", id));
  pickTalent(ctx, w, T("milestones"), node("milestones", "vigour"));
  const saved = exportProgress(ctx, w);
  const json = JSON.parse(JSON.stringify(saved));
  const back = character("dwarf", "warrior");
  const skipped = importProgress(ctx, back, json);
  check("nothing skipped", skipped.length === 0, skipped.join(","));
  check("same export", JSON.stringify(exportProgress(ctx, back)) === JSON.stringify(saved), `${JSON.stringify(exportProgress(ctx, back))} vs ${JSON.stringify(saved)}`);
  const stats = (e) => G.stats.map((s) => statValue(e.stats, s.index).toFixed(6)).join(",");
  check("same stats", stats(back) === stats(w));
  const spells = (e) => e.combat.spells.map((s) => `${G.skills[s.skill].id}:${s.source}`).sort().join(",");
  check("same spells", spells(back) === spells(w), `${spells(back)} vs ${spells(w)}`);
  check("same points", JSON.stringify([...back.progress.left]) === JSON.stringify([...w.progress.left]));
  const broken = character("dwarf", "warrior");
  const skipped2 = importProgress(ctx, broken, { ...json, disciplines: { ...json.disciplines, gone: { level: 3, xp: 0 } }, learned: { nope: "auto" } });
  check("unknown ids skipped", skipped2.length === 2, skipped2.join(","));
});

// --- a real tiny server, two clients ---
const { content: tinyContent, packs: tinyPacks } = loadContentFromDisk(CONFIG);
function startServer(...who) {
  const rules = loadRulesFromDisk(CONFIG);
  const creatures = loadCreatureRulesFromDisk(CONFIG, rules, WORLD_SEED);
  const progression = loadProgressionRulesFromDisk(CONFIG, rules, WORLD_SEED);
  const items = loadItemRulesFromDisk(CONFIG, rules, WORLD_SEED);
  const server = createServer({
    seed: WORLD_SEED, config: CONFIG, packs: tinyPacks, dimensions: tinyContent.dimensions, rules, creatures, items, progression,
    loadDimension: () => ({ world: createWorldData(WORLD_SEED, tinyContent) }),
  });
  const clients = who.map((origins, i) => {
    const channel = createLocalChannel();
    server.connect(channel.server);
    channel.client.send({ type: "hello", protocol: PROTOCOL_VERSION, name: `p${i}`, dimension: "", origins });
    return { id: 0, inbox: [], channel, send: (m) => channel.client.send(m) };
  });
  const pump = async (steps = 1, dt = 1 / 30) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      server.step(dt);
      for (const c of clients) {
        for (const m of c.channel.client.receive()) {
          if (m.type === "welcome") c.id = m.playerId;
          if (m.type === "transfer") c.send({ type: "arrived" });
          c.inbox.push(m);
        }
      }
    }
  };
  return { server, rules, progression, clients, pump, entity: (c) => server.debug.entity(c.id) };
}

await section("server", async () => {
  const t = startServer({ people: "human", class: "warrior" }, { people: "dwarf", class: "mage" });
  await t.pump(30);
  const [a, b] = t.clients.map((c) => t.entity(c));
  const R = t.progression;
  const lvl = (e, id) => e.progress.disciplines.get(R.disciplineIndex.get(id))?.level ?? 0;
  check("origins from Hello", a.template.id === "player.human.warrior" && b.template.id === "player.dwarf.mage", `${a.template.id} ${b.template.id}`);
  check("a class's resources only", a.resources.has.includes(t.rules.resourceIndex.get("rage")) && !a.resources.has.includes(t.rules.resourceIndex.get("mana")));
  check("a class's kit only", a.combat.spells.some((s) => s.skill === t.rules.skillIndex.get("charge")) && !a.combat.spells.some((s) => s.skill === t.rules.skillIndex.get("fireball")));
  check("people's starting discipline", lvl(b, "mining") === 5);

  // A wolf both fought, killed: full XP to each (credit `all`), Classic's amount for a level-1 wolf.
  const S = t.server.debug.creatures.debug;
  const wolf = S.spawn("mainland", "wolf.timber", a.x + 30, a.z, 1);
  const now = t.server.time;
  wolf.combat.threat.set(a.id, { amount: 50, last: now });
  wolf.combat.threat.set(b.id, { amount: 10, last: now });
  const xp = (e) => e.progress.disciplines.get(R.disciplineIndex.get("adventure")).xp;
  const [ax, bx] = [xp(a), xp(b)];
  t.server.debug.skills.kill(wolf);
  await t.pump(3);
  check("kill XP: the human (+10%)", Math.abs(xp(a) - ax - 55) < 1e-6, `${xp(a) - ax}`);
  check("kill XP: the dwarf", Math.abs(xp(b) - bx - 50) < 1e-6, `${xp(b) - bx}`);

  // A level-up: the owner's events, and everyone near gets a levelUp combat event.
  for (const c of t.clients) c.inbox.length = 0;
  t.server.debug.progression.debugXp(a, R.disciplineIndex.get("adventure"), 1000);
  await t.pump(2);
  const ups = (c) => c.inbox.filter((m) => m.type === "combatEvents").flatMap((m) => m.events).filter((e) => e.kind === EVENT_KIND.levelUp && e.source === a.id);
  check("a level-up seen by the other client", ups(t.clients[1]).length >= 1 && ups(t.clients[1])[0].name === "adventure", JSON.stringify(ups(t.clients[1])));
  check("level stat follows", statValue(a.stats, t.rules.statIndex.get("level")) === lvl(a, "adventure") && lvl(a, "adventure") >= 3);
  check("progress events recorded", t.server.debug.progressEvents.some((p) => p.entity === a.id && p.event.kind === "levelUp"));
  const own = (c, type) => c.inbox.filter((m) => m.type === type);
  check("the owner is told its progress", own(t.clients[0], "progress").some((m) => m.disciplines.some((d) => d.discipline === R.disciplineIndex.get("adventure") && d.level >= 3)));
  check("the owner is told its events", own(t.clients[0], "progressEvents").some((m) => m.events.some((e) => e.kind === "levelUp")));
  check("nobody else is told another's progress", !own(t.clients[1], "progress").some((m) => m.disciplines.some((d) => d.discipline === R.disciplineIndex.get("adventure") && d.level >= 3)));
  // The dummy beaten: a defeat, once until it is back above 0.
  const dummy = [...t.server.debug.dimensions.get("mainland").entities.values()].find((e) => e.template.id === "trainingDummy");
  t.clients[1].send({ type: "teleport", x: dummy.x + 1.5, z: dummy.z });
  await t.pump(5);
  dummy.resources.current[t.rules.health] = 1;
  dummy.combat.threat.set(b.id, { amount: 5, last: t.server.time });
  const before = xp(b);
  t.clients[1].send({ type: "target", id: dummy.id });
  t.clients[1].send({ type: "attack", on: true });
  await t.pump(150);
  const gained = xp(b) - before;
  check("a defeat gives XP", gained > 0, String(gained));
  await t.pump(90);
  check("only once at 0", xp(b) - before === gained, `${xp(b) - before} vs ${gained}`);

  const swordSkill = (e) => e.progress.disciplines.get(R.disciplineIndex.get("weaponSkill.sword"));
  check("sword skill from swinging a sword", swordSkill(b).xp > 0 || swordSkill(b).level > 1, JSON.stringify(swordSkill(b)));
  check("no unarmed skill with a sword in hand", b.progress.disciplines.get(R.disciplineIndex.get("weaponSkill.unarmed")).xp === 0);

  // Use-based: being hit raises defence; casting a class spell raises the class.
  const def = (e) => e.progress.disciplines.get(R.disciplineIndex.get("defence"));
  t.server.debug.skills.apply(t.rules.skillIndex.get("burn"), dummy, b);
  await t.pump(100);
  check("defence from hits taken", def(b).xp > 0 || def(b).level > 1, JSON.stringify(def(b)));
  const cls = (e) => e.progress.disciplines.get(R.disciplineIndex.get("class"));
  // Class level may not pass the character's (cap "level"): at 1 and 1, its XP is banked.
  const c0 = cls(b).xp + cls(b).banked + cls(b).level * 1000;
  b.resources.current[t.rules.resourceIndex.get("mana")] = 500;
  t.clients[1].send({ type: "cast", seq: 1, skill: t.rules.skillIndex.get("fireball"), target: dummy.id, x: NaN, z: NaN });
  await t.pump(120);
  check("class XP from a class spell, banked at the cap", cls(b).xp + cls(b).banked + cls(b).level * 1000 > c0 && cls(b).banked > 0, JSON.stringify(cls(b)));
  t.server.debug.progression.debugLevel(b, R.disciplineIndex.get("adventure"), 2);
  t.server.debug.progression.debugXp(b, R.disciplineIndex.get("adventure"), 1);
  check("banked class XP flows when the character levels", cls(b).banked === 0 && cls(b).xp > 0, JSON.stringify(cls(b)));

  // A trainer: Kick at warrior class 3, for money, in range.
  const trainer = [...t.server.debug.dimensions.get("mainland").entities.values()].find((e) => e.template.id === "trainer");
  t.server.debug.progression.debugLevel(a, R.disciplineIndex.get("class"), 3);
  const kick = t.rules.skillIndex.get("kick");
  t.clients[0].send({ type: "learn", trainer: trainer.id, skill: kick });
  await t.pump(2);
  check("trainer: out of range", !a.combat.spells.some((s) => s.skill === kick));
  t.clients[0].send({ type: "teleport", x: trainer.x + 1, z: trainer.z });
  await t.pump(3);
  t.clients[0].send({ type: "learn", trainer: trainer.id, skill: kick });
  await t.pump(2);
  check("trainer: no money", !a.combat.spells.some((s) => s.skill === kick));
  const main = t.server.debug.items.ctx.items.main;
  a.belongings.wallet[main] = 70;
  t.clients[0].send({ type: "learn", trainer: trainer.id, skill: kick });
  await t.pump(2);
  check("trainer: taught for its cost", a.combat.spells.some((s) => s.skill === kick && s.source === "learn:trainer") && a.belongings.wallet[main] === 20, String(a.belongings.wallet[main]));

  // A book: refused (and kept) before its level, taught after.
  const tome = t.server.debug.items.ctx.items.typeIndex.get("tomeOfFrostNova");
  t.server.debug.items.give(b, tome, 1);
  const bagSlot = () => b.belongings.bag.findIndex((id) => id != null && t.server.debug.items.store.get(id).type === tome);
  const frostNova = t.rules.skillIndex.get("frostNova");
  t.clients[1].send({ type: "itemUse", from: { container: 0, slot: bagSlot() } });
  await t.pump(2);
  check("book: refused before its level, kept", !b.combat.spells.some((s) => s.skill === frostNova) && bagSlot() >= 0);
  t.server.debug.progression.debugLevel(b, R.disciplineIndex.get("class"), 3);
  t.clients[1].send({ type: "itemUse", from: { container: 0, slot: bagSlot() } });
  await t.pump(3);
  check("book: teaches, and is used up", b.combat.spells.some((s) => s.skill === frostNova && s.source === "learn:item") && bagSlot() < 0);

  // An item requirement on a discipline: iron swords need sword skill 10.
  const iron = t.server.debug.items.ctx.items.typeIndex.get("sword.iron.short.common");
  t.server.debug.items.give(a, iron, 1);
  const ironSlot = () => a.belongings.bag.findIndex((id) => id != null && t.server.debug.items.store.get(id).type === iron);
  const refused = t.server.debug.items.equip(a, { container: 0, slot: ironSlot() });
  check("iron refused below sword skill 10", !!refused && ironSlot() >= 0, String(refused));
  t.server.debug.progression.debugLevel(a, R.disciplineIndex.get("weaponSkill.sword"), 10);
  const ok = t.server.debug.items.equip(a, { container: 0, slot: ironSlot() });
  check("iron worn at sword skill 10", !ok && ironSlot() < 0, String(ok));

  // Talents over the boundary.
  t.server.debug.progression.debugLevel(a, R.disciplineIndex.get("adventure"), 5);
  const arms = R.treeIndex.get("warriorArms");
  t.clients[0].send({ type: "talentPick", tree: arms, node: R.trees[arms].nodes.find((n) => n.id === "toughness").index });
  await t.pump(1);
  check("talent picked by message", a.progress.talents.get(arms)?.size === 1);
});

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
