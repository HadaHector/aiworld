// The items test (see ITEMS.md): item rules and generated types, rolls, loot tables, belongings and
// equipment on the server, and what clients are told over the boundary.
//   npm run probe -- scripts/probe/items.mjs
import { ContentError } from "../../src/world/content/contentReader.ts";
import { loadItemRulesFromDisk, loadRulesFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";
import { formatMoney, itemStats, resolveItemRules, rollLoot, rollQuality } from "../../src/sim/rules/itemRules.ts";
import { mulberry32 } from "../../src/world/rng.ts";
import { createEntity } from "../../src/sim/entity.ts";
import { statValue } from "../../src/sim/stats.ts";
import { createItemSystem, GROUND_ITEM_TEMPLATE, TAKE_ALL } from "../../src/sim/items/itemSystem.ts";
import { BAG, BANK, EQUIPMENT } from "../../src/sim/items/items.ts";

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

// --- belongings and equipment, on the item system alone ---
await section("belongings", () => {
  const entities = new Map();
  let time = 0;
  let nextId = 1;
  const make = (template, x = 0, z = 0) => {
    const entity = createEntity(game, game.templates.get(template), nextId++, { dimension: "d", x, y: 0, z, facing: 0, key: `d/${nextId}` });
    entities.set(entity.id, entity);
    system.adopt(entity);
    return entity;
  };
  const hookCalls = [];
  const hooks = {
    use: (user, item, skill) => (hookCalls.push(`use ${skill}`), true),
    equip: (wearer, item, skill, source) => hookCalls.push(`equip ${skill} ${source}`),
    unequip: (wearer, source) => hookCalls.push(`unequip ${source}`),
  };
  const world = {
    seed: 1234,
    time: () => time,
    entity: (id) => entities.get(id),
    entitiesIn: () => entities.values(),
    spawn: (dimension, template, x, z) => make(template, x, z),
    despawn: (entity) => entities.delete(entity.id),
  };
  const system = createItemSystem(game, items, world, hooks);
  const dims = [{ id: "d", entities }];
  const slot = (id) => items.slotIndex.get(id);
  const bagItem = (p, i) => (p.belongings.bag[i] == null ? null : system.store.get(p.belongings.bag[i]));
  const worn = (p, s) => (p.belongings.equipment[slot(s)] == null ? null : system.store.get(p.belongings.equipment[slot(s)]));
  const typeIdOf = (item) => item && items.types[item.type].id;
  const statOf = (p, id) => statValue(p.stats, stat(id));
  const bagIndex = (p, typeId) => p.belongings.bag.findIndex((id) => id != null && items.types[system.store.get(id).type].id === typeId);
  const B = (s) => ({ container: BAG, slot: s });
  const E = (s) => ({ container: EQUIPMENT, slot: slot(s) });

  const p = make("player");
  check("a player has a bag of 20 and a bank of 40", p.belongings.bag.length === 20 && p.belongings.bank.length === 40);
  check("start clothes are worn", typeIdOf(worn(p, "chest")) === "tunic" && typeIdOf(worn(p, "legs")) === "linenTrousers" && typeIdOf(worn(p, "feet")) === "sandals");
  check("start bread is in the bag", bagIndex(p, "bread") >= 0 && bagItem(p, bagIndex(p, "bread")).count === 5);
  // Tidy the bag: the bread first.
  system.move(p, B(bagIndex(p, "bread")), B(0), 0);
  check("the body shows what is worn", p.gear.join() === "tunic,linenTrousers,sandals", p.gear.join());
  check("the dummy has loot, not belongings", !!make("trainingDummy").loot);

  // Stacks: merge, split, swap.
  system.give(p, items.typeIndex.get("bread"), 18); // 5 + 18: a full stack of 20 and one of 3
  const breads = p.belongings.bag.filter((id) => id != null && typeIdOf(system.store.get(id)) === "bread").map((id) => system.store.get(id).count).sort((a, b) => b - a);
  check("giving fills stacks first", breads.join() === "20,3", breads.join());
  check("splitting a stack", system.move(p, B(0), B(10), 4) === "" && bagItem(p, 0).count === 16 && bagItem(p, 10).count === 4);
  const small = p.belongings.bag.findIndex((id, i) => i !== 0 && i !== 10 && id != null && typeIdOf(system.store.get(id)) === "bread");
  check("merging onto a stack", system.move(p, B(10), B(small), 0) === "" && bagItem(p, small).count === 7 && bagItem(p, 10) === null);
  system.give(p, items.typeIndex.get("wolfPelt"), 1);
  const pelt = bagIndex(p, "wolfPelt");
  check("swapping two items", system.move(p, B(pelt), B(0), 0) === "" && typeIdOf(bagItem(p, 0)) === "wolfPelt" && typeIdOf(bagItem(p, pelt)) === "bread");
  check("the bank is out of reach away from a strongbox", system.move(p, B(0), { container: BANK, slot: 0 }, 0) === "bank");

  // Equipment: modifiers on, off, the look.
  const strengthBefore = statOf(p, "strength");
  const minBefore = statOf(p, "weaponMin");
  system.give(p, items.typeIndex.get("sword.bronze.long.uncommon"), 1);
  const swordAt = bagIndex(p, "sword.bronze.long.uncommon");
  const sword = bagItem(p, swordAt);
  const values = itemStats(items.types[sword.type], sword.roll);
  const swordStrength = values[items.types[sword.type].stats.findIndex((s) => s.stat === stat("strength"))] ?? 0;
  check("equipping", system.equip(p, B(swordAt)) === "" && typeIdOf(worn(p, "mainHand")) === "sword.bronze.long.uncommon");
  check("the sword's strength is on the wearer", statOf(p, "strength") === strengthBefore + swordStrength, `${statOf(p, "strength")} vs ${strengthBefore}+${swordStrength}`);
  check("its weapon damage too", statOf(p, "weaponMin") > minBefore);
  check("under the slot's source", p.stats.modifiers.some((m) => m.source === "item:mainHand" && m.stat === stat("weaponMin")));
  check("the body shows the sword", p.gear.includes("sword.bronze.long.uncommon"));
  check("unequipping", system.unequip(p, slot("mainHand")) === "" && statOf(p, "strength") === strengthBefore && statOf(p, "weaponMin") === minBefore && !p.gear.includes("sword.bronze.long.uncommon"));
  check("no item:mainHand modifiers left", !p.stats.modifiers.some((m) => m.source === "item:mainHand"));
  check("a stack cannot be worn", system.equip(p, B(bagIndex(p, "bread"))) === "slot");

  // A two-handed sword fills the off hand; something in the off hand takes it off.
  system.give(p, items.typeIndex.get("sword.bronze.great.common"), 1);
  check("a greatsword goes on", system.equip(p, B(bagIndex(p, "sword.bronze.great.common"))) === "");
  check("bread cannot go in the off hand", system.move(p, B(bagIndex(p, "bread")), E("offHand"), 0) === "slot");
  // Equip the long sword back into the main hand: the greatsword swaps into its bag slot.
  check("a one-hander swaps the two-hander out", system.equip(p, B(bagIndex(p, "sword.bronze.long.uncommon"))) === "" && typeIdOf(worn(p, "mainHand")) === "sword.bronze.long.uncommon" && bagIndex(p, "sword.bronze.great.common") >= 0);

  // Requires: an iron greatsword wants level 0 (itemLevel 8 - 8), a level-1 player passes; push it.
  system.give(p, items.typeIndex.get("plateHelm"), 1);
  check("a helm with a level requirement goes on at level 1", system.equip(p, B(bagIndex(p, "plateHelm"))) === "");
  const knight = { ...items.types[items.typeIndex.get("plateHelm")] };
  check("requires reads the wearer's level", knight.requires.run(Object.assign(new Float64Array(items.statCount + 1), { [stat("level")]: 0 })) === 0);

  // Durability: broken gives nothing, repair brings it back.
  const helm = worn(p, "head");
  const stamina = statOf(p, "stamina");
  system.wear(p, "armour");
  system.wear(p, "armour");
  system.wear(p, "armour");
  system.wear(p, "armour");
  system.wear(p, "armour");
  system.wear(p, "armour");
  check("armour wears down to 0", helm.durability === 0, String(helm.durability));
  check("a broken helm gives no stats", statOf(p, "stamina") < stamina && !p.stats.modifiers.some((m) => m.source === "item:head"));
  check("a broken helm still shows", p.gear.includes("plateHelm"));
  check("repair costs money", system.repair(p) === "money");
  p.belongings.wallet[items.main] = 100000;
  check("repairing", system.repair(p) === "" && helm.durability === items.types[helm.type].durability && statOf(p, "stamina") === stamina);
  check("repair took money", p.belongings.wallet[items.main] < 100000);
  check("nothing to repair", system.repair(p) === "nothing");
  const tunic = worn(p, "chest");
  const had = tunic.durability;
  system.wear(p, "death");
  check("death wears every worn item", tunic.durability === had - Math.ceil(items.types[tunic.type].durability * items.config.wear.onDeath));

  // Use: the hook is called, the item used up.
  hookCalls.length = 0;
  const breadAt = bagIndex(p, "bread");
  const before = bagItem(p, breadAt).count;
  check("using bread", system.use(p, B(breadAt)) === "" && hookCalls[0] === "use eatBread" && bagItem(p, breadAt).count === before - 1);
  check("a sword is not used", system.use(p, B(bagIndex(p, "sword.bronze.great.common"))) === "cannot");

  // Quest items: one only, never dropped.
  system.give(p, items.typeIndex.get("rustyKey"), 1);
  check("a second quest item is refused", system.give(p, items.typeIndex.get("rustyKey"), 1) === 1);
  check("a quest item cannot be dropped", system.drop(p, B(bagIndex(p, "rustyKey")), 0) === "quest");

  // A full bag.
  while (p.belongings.bag.includes(null)) system.give(p, items.typeIndex.get("tunic"), 1);
  check("a full bag refuses more", system.give(p, items.typeIndex.get("tunic"), 1) === 1);
  check("unequipping into a full bag is refused", system.unequip(p, slot("legs")) === "bagFull");
  check("the store has every item", system.store.size > 20);

  // Loot: the dummy at 0 health; another player takes what the first leaves; dropping and picking up.
  const q = make("player");
  q.belongings.bag.fill(null);
  const dummy = [...entities.values()].find((e) => e.template.id === "trainingDummy");
  dummy.resources.current[game.health] = 0;
  system.step(dims);
  check("the dummy at 0 health is lootable", system.lootable(dummy) && dummy.loot.money[items.main] >= 20);
  check("the second player opens it", system.openLoot(q, dummy.id) === "");
  check("loot is taken first come", system.takeLoot(q, TAKE_ALL) === "" && !system.lootable(dummy));
  check("money taken is the taker's", q.belongings.wallet[items.main] >= 20);
  system.step(dims);
  check("it is not rolled again at 0 health", !system.lootable(dummy));
  dummy.resources.current[game.health] = 10;
  system.step(dims);
  dummy.resources.current[game.health] = 0;
  system.step(dims);
  check("after coming back above 0 it is rolled again", system.lootable(dummy) && dummy.loot.rolls === 2);
  const far = make("player", 50, 0);
  check("loot out of reach is refused", system.openLoot(far, dummy.id) === "range");

  const chest = make("chest", 1, 1);
  check("a chest is lootable before it is opened", system.lootable(chest) && chest.loot.items.length === 0);
  check("opening a chest rolls it", system.openLoot(q, chest.id) === "" && chest.loot.items.length >= 2);
  system.takeLoot(q, TAKE_ALL);
  check("an emptied chest waits", !system.lootable(chest) && system.openLoot(q, chest.id) === "empty");
  check("marks from the chest", q.belongings.wallet[items.currencyIndex.get("marks")] >= 1);
  time += 601;
  check("it comes back", system.lootable(chest));

  const droppable = (id) => id != null && !items.types[system.store.get(id).type].quest;
  const pick = q.belongings.bag.findIndex(droppable);
  const dropped = system.store.get(q.belongings.bag[pick]);
  check("dropping an item", system.drop(q, B(pick), 0) === "" && q.belongings.bag[pick] === null);
  const ground = [...entities.values()].find((e) => e.template.id === GROUND_ITEM_TEMPLATE);
  check("it lies on the ground, named after it", ground && ground.loot.items[0] === dropped.id && ground.name === items.types[dropped.type].name);
  check("someone else picks it up", system.pickUp(make("player", 0.5, 0.5), ground.id) === "" && !entities.has(ground.id));
  system.drop(q, B(q.belongings.bag.findIndex(droppable)), 0);
  const second = [...entities.values()].find((e) => e.template.id === GROUND_ITEM_TEMPLATE);
  time += items.config.groundLifetime + 1;
  system.step(dims);
  check("an item left on the ground goes", !entities.has(second.id));
});

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
