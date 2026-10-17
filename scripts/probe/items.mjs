// The items test (see ITEMS.md): item rules and generated types, rolls, loot tables, belongings and
// equipment on the server, and what clients are told over the boundary.
//   npm run probe -- scripts/probe/items.mjs
import { ContentError } from "../../src/world/content/contentReader.ts";
import { loadItemRulesFromDisk, loadRulesFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { formatMoney, itemStats, resolveItemRules, rollLoot, rollQuality } from "../../src/sim/rules/itemRules.ts";
import { mulberry32 } from "../../src/world/rng.ts";

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
const game = loadRulesFromDisk(CONFIG);
const items = loadItemRulesFromDisk(CONFIG, game, 1234);
const typeOf = (id) => items.types[items.typeIndex.get(id)];
const stat = (id) => game.statIndex.get(id);

/** The item rules from the packs plus one probe pack of extra files - for what must be refused. */
function withProbePack(files) {
  const sources = packSourcesFromDisk(readConfigFromDisk(CONFIG)).sources;
  const probe = { id: "probe", files: [{ path: "pack.json5", text: "{ name: 'Probe', priority: 100 }" }, ...Object.entries(files).map(([path, text]) => ({ path, text }))] };
  return resolveItemRules([...sources, probe], game, 1234);
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
  check("the core rarities in rank order", items.rarities.map((r) => r.id).join() === "poor,common,uncommon,rare,epic");
  check("13 equipment slots", items.slots.length === 13, String(items.slots.length));
  check("one main currency, with denominations", items.currencies[items.main].id === "coin" && items.currencies[items.main].denominations.length === 3);
  check("money shown in denominations", formatMoney(items.currencies[items.main], 12345) === "1g 23s 45c", formatMoney(items.currencies[items.main], 12345));
  check("a plain currency shown as a number", formatMoney(items.currencies[items.currencyIndex.get("marks")], 7) === "7");
  check("zero money shown", formatMoney(items.currencies[items.main], 0) === "0c");
  check("sword makes 18 types", items.generated.get("sword").length === 18, String(items.generated.get("sword")?.length));
  check("chestpiece makes 15 types (never: worn uncommon)", items.generated.get("chestpiece").length === 15, String(items.generated.get("chestpiece")?.length));
  const long = typeOf("sword.iron.long.common");
  check("a generated type's name from its parts", long?.name === "Iron Longsword", long?.name);
  check("a generated type's item level from its parts", long?.itemLevel === 8);
  check("a part's field overrides (the greatsword fills the off hand)", typeOf("sword.bronze.great.common").fills.join() === String(items.slotIndex.get("offHand")));
  check("the weapon speed is left unscaled", typeOf("sword.iron.great.rare").stats.find((s) => s.stat === stat("weaponSpeed"))?.min === 1.2);
  const plain = typeOf("sword.bronze.long.common").stats.find((s) => s.stat === stat("strength"));
  const iron = typeOf("sword.iron.long.common").stats.find((s) => s.stat === stat("strength"));
  check("a material's budget scales stats", plain.max < iron.max, `${plain.max} vs ${iron.max}`);
  check("a rare type has two extra stats", typeOf("sword.bronze.long.rare").stats.length === typeOf("sword.bronze.long.common").stats.length + 2);
  // The same seed, the same catalogue; another seed, other extra stats somewhere.
  const again = loadItemRulesFromDisk(CONFIG, game, 1234);
  const sig = (r) => r.types.map((t) => `${t.id}:${t.stats.map((s) => `${s.stat}/${s.min}/${s.max}`).join(",")}`).join("|");
  check("the same seed gives the same catalogue", sig(again) === sig(items) && again.hash === items.hash);
  const other = loadItemRulesFromDisk(CONFIG, game, 99);
  check("another seed gives the same ids", other.types.map((t) => t.id).join() === items.types.map((t) => t.id).join());
  check("another seed draws other extra stats", sig(other) !== sig(items));
  check("bread's skill is listed for the skill rules", items.abilityRefs.some((r) => r.id === "eatBread" && r.path === "use.skill"));
  check("the player template's belongings", items.entities.get("player")?.bag === 20 && items.entities.get("player")?.bank === 40);
  check("the dummy's loot", items.entities.get("trainingDummy")?.loot === "trainingDummy");
  check("the chest is a container", items.entities.get("chest")?.container === true);

  refused({ "items/badStack.json5": "{ name: 'X', stack: 5, stats: { stamina: [1, 2] } }" }, "a stacking type with a range", /stacking type has no stat ranges/);
  refused({ "items/badSlot.json5": "{ name: 'X', slot: 'tail' }" }, "an unknown slot", /no equipment slot "tail"/);
  refused({ "items/badGear.json5": "{ name: 'X', slot: 'head', gear: ['crown'] }" }, "an unknown gear piece", /no gear piece "crown"/);
  refused({ "lootTables/a.json5": "{ pick: [{ table: 'b' }] }", "lootTables/b.json5": "{ pick: [{ table: 'a' }] }" }, "a cycle of loot tables", /in a circle/);
  refused({ "lootTables/c.json5": "{ pick: [{ item: 'nothingLikeIt' }] }" }, "a loot entry naming no item", /no item type "nothingLikeIt"/);
  refused({ "currencies/gems.json5": "{ main: true }" }, "two main currencies", /exactly one currency/);
  refused({ "itemTemplates/huge.json5": `{ name: '{a}{b}', axes: { a: [${Array.from({ length: 50 }, (_, i) => `{ id: 'a${i}' }`).join()}], b: [${Array.from({ length: 50 }, (_, i) => `{ id: 'b${i}' }`).join()}] } }` }, "a template making too many types", /more than rules\/items.json5's maxGenerated/);
});

// --- rolls ---
await section("rolls", () => {
  const sword = typeOf("sword.iron.long.rare");
  let lowSeen = false;
  let highSeen = false;
  let inRange = true;
  for (let roll = 0; roll < 2000; roll++) {
    const values = itemStats(sword, roll * 2654435761);
    sword.stats.forEach((s, i) => {
      const v = values[i];
      if (v < s.min || v > s.max || (s.whole && !Number.isInteger(v))) inRange = false;
      if (s.min !== s.max && v === s.min) lowSeen = true;
      if (s.min !== s.max && v === s.max) highSeen = true;
    });
  }
  check("every rolled stat in its range, whole where whole", inRange);
  check("both ends of a range are reached", lowSeen && highSeen);
  check("the same roll gives the same values", itemStats(sword, 77).join() === itemStats(sword, 77).join());
  check("different rolls differ somewhere", new Set(Array.from({ length: 20 }, (_, r) => itemStats(sword, r).join())).size > 1);
  const q = rollQuality(sword, 5);
  check("quality between 0 and 1", q !== null && q >= 0 && q <= 1, String(q));
  check("nothing rolled, no quality", rollQuality(typeOf("bread"), 5) === null);
});

// --- loot ---
await section("loot", () => {
  const context = new Float64Array(game.stats.length * 2);
  const level = stat("level");
  // The chest table: the always entries every time, picks by weight.
  const random = mulberry32(42);
  const counts = new Map();
  let marks = 0;
  let money = 0;
  const N = 10000;
  for (let n = 0; n < N; n++) {
    for (const drop of rollLoot(items, "chest", context, random)) {
      if ("currency" in drop) {
        if (drop.currency === items.main) money++;
        else marks++;
      } else counts.set(items.types[drop.type].id, (counts.get(items.types[drop.type].id) ?? 0) + 1);
    }
  }
  check("money every time", money === N, String(money));
  check("marks every time", marks === N, String(marks));
  // 2-3 rolls, mean 2.5; wolf pelts weigh 20 of 103.
  const pelts = counts.get("wolfPelt") ?? 0;
  const expected = N * 2.5 * (20 / 103);
  check("weights hold over 10,000 rolls", Math.abs(pelts - expected) / expected < 0.05, `${pelts} vs ${expected.toFixed(0)}`);
  // Nesting and conditions: the dummy's table gives starter gear through a nested table, and the key
  // only to a looter under level 5.
  const dummyDrops = (looterLevel, seed) => {
    context[game.stats.length + level] = looterLevel;
    const r = mulberry32(seed);
    const all = [];
    for (let n = 0; n < 500; n++) all.push(...rollLoot(items, "trainingDummy", context, r));
    return all;
  };
  const low = dummyDrops(1, 7);
  const high = dummyDrops(10, 7);
  const isKey = (d) => "type" in d && items.types[d.type].id === "rustyKey";
  check("a condition holds for a low looter", low.filter(isKey).length === 500);
  check("a condition fails for a high one", high.filter(isKey).length === 0);
  const starter = new Set(["tunic", "leatherBoots", "leatherBelt", "leatherBracers", "copperRing", "apprenticeRobe"]);
  check("a nested table gives its items", low.some((d) => "type" in d && starter.has(items.types[d.type].id)));
  check("a template entry gives only matching types", low.filter((d) => "type" in d && items.types[d.type].template === "sword").every((d) => items.types[d.type].parts.material === "bronze" && items.types[d.type].rarity <= 2));
  check("the same seed, the same drop", JSON.stringify(dummyDrops(1, 9)) === JSON.stringify(dummyDrops(1, 9)));
});

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
