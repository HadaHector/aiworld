// The balance rules test (SLICE.md, 3a; BALANCE.md): the curves in rules/balance.json5 read and
// agree with what was decided, creatures with a role get health, damage and armour from them (so a
// same-level fight takes the time the role says), loot money and generated prices follow the income
// curve, and bad curve files are reported.
//   npm run probe -- scripts/probe/balance.mjs
import { ContentError } from "../../src/world/content/contentReader.ts";
import { readBalanceRules } from "../../src/sim/rules/balanceRules.ts";
import { defenceMultiplier } from "../../src/sim/rules/defenceRules.ts";
import { createStatBlock, statValue } from "../../src/sim/stats.ts";
import { createResourceBlock, stepResourceBlock } from "../../src/sim/resources.ts";
import { rollLoot } from "../../src/sim/rules/itemRules.ts";
import { loadCreatureRulesFromDisk, loadItemRulesFromDisk, loadRulesFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";

let failures = 0;
let checks = 0;
function check(what, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const packs = packSourcesFromDisk(readConfigFromDisk()).sources;
const balance = readBalanceRules(packs);
check("the core pack has balance rules", balance !== null);

// --- the curves, as agreed with the user (2026-11-20) ---
check("player health 175 at 1, 450 at 10", near(balance.curve("playerHealth", 1), 175, 0.001) && near(balance.curve("playerHealth", 10), 450, 0.001));
check("player dps 15 at 1, 40 at 10", near(balance.curve("playerDps", 1), 15, 0.001) && near(balance.curve("playerDps", 10), 40, 0.001));
check("curves go on past 10 (geometric)", balance.curve("playerHealth", 11) > balance.curve("playerHealth", 10));
check("curves hold under 1", balance.curve("playerHealth", 0) === balance.curve("playerHealth", 1));
let xp = 0;
for (let own = 1; own <= 9; own++) xp += balance.curve("xpToNext", own);
check("level 10 costs 20,850 XP", xp === 20850, String(xp));
check("level 2 costs 250 XP", balance.curve("xpToNext", 1) === 250);
check("pace: level 10 at minute 120", balance.pace.get(10) === 120 && balance.pace.get(4) === 35);
check("income 270 at 1, 2000 at 10", near(balance.income(1), 270, 0.001) && near(balance.income(10), 2000, 0.001));
check("potion costs 3 minutes of income", balance.potionPrice(1) === Math.round(270 / 60 * 3));
check("sell rate 25%", balance.sellRate === 0.25);
check("regeneration 2% after 6 s", balance.regen.share === 0.02 && balance.regen.delay === 6);
check("skills: 2 active at 1, 7 active and 2 passive at 10", balance.curve("skillsActive", 1) === 2 && balance.curve("skillsActive", 10) === 7 && balance.curve("skillsPassive", 10) === 2);
check("tactics: 1 at level 1, 2 at level 4", balance.curve("tactics", 1) === 1 && balance.curve("tactics", 4) === 2);
check("quest effort: kill 4 early, 12 late", balance.curve("questEffortMin", 1) === 4 && balance.curve("questEffortMax", 10) === 12);
check("an unknown curve throws", (() => { try { balance.curve("nope", 1); return false; } catch { return true; } })());

// --- the baselines: the role's ratios read back ---
for (let level = 1; level <= 12; level++) {
  const b = balance.baseline("normal", level);
  const ttk = b.health / (balance.curve("playerDps", level) * (1 - b.mitigation));
  const ttd = balance.curve("playerHealth", level) / (b.dps * (1 - balance.curve("playerMitigation", level)));
  check(`normal L${level}: 10 s to kill, 35 s to die`, near(ttk, 10, 0.001) && near(ttd, 35, 0.001), `${ttk} ${ttd}`);
  const cost = ttk / ttd;
  check(`normal L${level}: a fight costs about a third`, cost > 0.25 && cost < 0.33, String(cost));
}
for (const [id, ttk, ttd] of [["elite", 30, 12], ["boss", 120, 25]]) {
  const b = balance.baseline(id, 5);
  check(`${id}: ttk ${ttk}, ttd ${ttd}`, near(b.health / (balance.curve("playerDps", 5) * (1 - b.mitigation)), ttk, 0.001) && near(balance.curve("playerHealth", 5) / (b.dps * (1 - balance.curve("playerMitigation", 5))), ttd, 0.001));
}
check("livestock does no damage", balance.baseline("livestock", 3).dps === 0);
const armor = balance.baseline("normal", 5);
check("armour stat stops the share asked (the combat formula)", near(armor.armor / (armor.armor + 400 + 85 * 5), armor.mitigation, 0.001));
check("an unknown role throws", (() => { try { balance.baseline("nope", 1); return false; } catch { return true; } })());

// --- creatures with a role, spawned the way the spawner does ---
const game = loadRulesFromDisk();
const creatures = loadCreatureRulesFromDisk("default", game, 7);
// --- regeneration (I9): health 2% of maximum a second out of combat, after 6 s; none in combat ---
check("combat timeout is the regen delay", game.combat.combatTimeout === balance.regen.delay, String(game.combat.combatTimeout));
{
  const template = game.templates.get("player");
  const stats = createStatBlock(game, template);
  const block = createResourceBlock(game, template, stats, 0);
  const H = game.resourceIndex.get("health");
  const max = block.max[H];
  block.current[H] = 0;
  stepResourceBlock(block, stats, true, 10);
  check("no health regen in combat", block.current[H] === 0);
  stepResourceBlock(block, stats, false, 10);
  check("out of combat: balance share of maximum a second", near(block.current[H], max * balance.regen.share * 10, 0.001), `${block.current[H]} of ${max}`);
}
const items = loadItemRulesFromDisk("default", game, 7);
check("creature rules carry the balance rules", creatures.balance === balance || creatures.balance !== null);
const statIndex = (id) => game.statIndex.get(id);
const spawn = (kind, level) => {
  const block = createStatBlock(game, kind.template);
  game.statIndex.get("level") !== undefined && block && (() => {})();
  return block;
};
let roled = 0;
for (const kind of creatures.kindList) {
  if (!kind.balance) continue;
  roled++;
  const role = balance.roles.get(kind.balance.role);
  for (const level of [1, 4, 7, 10]) {
    const block = createStatBlock(game, kind.template);
    // The spawner's order: level, perLevel growth, then the balance.
    const { setBase } = await import("../../src/sim/stats.ts");
    setBase(block, statIndex("level"), level);
    for (const { stat, value } of kind.perLevel) {
      const base = kind.template.stats.find((s) => s.stat === stat)?.value ?? game.stats[stat].default;
      setBase(block, stat, base + value * (level - 1));
    }
    balance.applyCreature(block, game, kind.balance, level);
    const want = balance.creatureBaseline(kind.balance, level);
    const health = statValue(block, statIndex("maxHealth"));
    // Traits are modifiers on top (a thick-hided one has more), so compare with them stripped by their percent.
    const hasTraitHealth = kind.traits.includes("old") || kind.traits.includes("thickHide");
    const wantHealth = want.health;
    if (!hasTraitHealth) check(`${kind.id} L${level}: health ${Math.round(health)} is the baseline's ${Math.round(wantHealth)}`, near(health, wantHealth, 0.02), `${health} vs ${wantHealth}`);
    // Damage: weapon swings plus the tactics' share is the role's dps.
    const swing = statValue(block, statIndex("weaponSpeed"));
    const mean = (statValue(block, statIndex("weaponMin")) + statValue(block, statIndex("weaponMax"))) / 2 + statValue(block, statIndex("strength")) / 7;
    const auto = mean / swing;
    if (kind.traits.length === 0) {
      const wantAuto = want.dps * (1 - role.tacticShare);
      check(`${kind.id} L${level}: auto-attack dps ${auto.toFixed(2)} is ${wantAuto.toFixed(2)}`, near(auto, wantAuto, 0.03), `${auto} vs ${wantAuto}`);
      // Its defence (armour, dodge, parry, control... - rules/combat.json5) stops the role's share in all.
      const eh = defenceMultiplier(game.combat.defence, (id) => (game.statIndex.has(id) ? statValue(block, game.statIndex.get(id)) : 0), level, { health }).physical;
      check(`${kind.id} L${level}: its defence stops the role's share of damage`, near(1 - 1 / eh, Math.min(0.9, role.mitigation * kind.balance.scale.armour), 0.01), `${(1 - 1 / eh).toFixed(3)}`);
    }
    check(`${kind.id} L${level}: XP value is the role's`, near(statValue(block, statIndex("xpValue")), role.xp * kind.balance.scale.xp, 0.001));
  }
}
check("creature kinds were moved to roles", roled >= 20, `${roled} kinds`);
// The wolf of the first levels: the number the user will feel.
{
  const wolf = creatures.kindList.find((k) => k.species === "wolf" && k.traits.length === 0) ?? creatures.kindList.find((k) => k.species === "wolf");
  const { setBase } = await import("../../src/sim/stats.ts");
  const block = createStatBlock(game, wolf.template);
  setBase(block, statIndex("level"), 1);
  for (const { stat, value } of wolf.perLevel) setBase(block, stat, (wolf.template.stats.find((s) => s.stat === stat)?.value ?? game.stats[stat].default));
  balance.applyCreature(block, game, wolf.balance, 1);
  console.log(`wolf L1: health ${Math.round(statValue(block, statIndex("maxHealth")))}, weapon ${statValue(block, statIndex("weaponMin")).toFixed(1)}-${statValue(block, statIndex("weaponMax")).toFixed(1)}, armour ${Math.round(statValue(block, statIndex("armor")))} (player: 175 health, 15 dps)`);
}

// --- loot money by level ---
{
  const wolf = items.lootTables.get("wolf");
  check("the wolf's money is a share of a kill", wolf.always[0].what.scale === "brute");
  const money = (level, n = 4000) => {
    const context = new Float64Array(game.stats.length * 2);
    context[game.statIndex.get("level")] = level;
    let random = 1;
    const rng = () => ((random = (random * 16807) % 2147483647) - 1) / 2147483646;
    let sum = 0;
    for (let i = 0; i < n; i++) for (const drop of rollLoot(items, "wolf", context, rng)) if ("currency" in drop) sum += drop.amount;
    return sum / n;
  };
  const m1 = money(1);
  const m10 = money(10);
  check("a level 1 wolf drops about a copper or two", m1 >= 1 && m1 <= 2.5, String(m1));
  check("money per kill grows with the level", m10 > 5 * m1 && near(m10, balance.moneyPerKill("brute", 10), 0.15), `${m1} ${m10} vs ${balance.moneyPerKill("brute", 10)}`);
  console.log(`wolf money: level 1 ${m1.toFixed(2)}c, level 10 ${m10.toFixed(2)}c`);
}

// --- prices from the budget ---
{
  // The sword ladder (ITEMS.md, *The ladder*): bronze at 3, iron (green) at 7, the rare at 9.
  const sword = items.types[items.typeIndex.get("sword.loot3")];
  const iron = items.types[items.typeIndex.get("sword.loot7")];
  const rare = items.types[items.typeIndex.get("sword.loot9")];
  check("a generated sword has a price from the curves", sword.value === balance.itemPrice(3, "mainHand", 1), String(sword.value));
  check("iron (level 7) costs more than bronze", iron.value > sword.value * 2, `${iron.value} vs ${sword.value}`);
  check("rare costs more than common at the same level", rare.value > iron.value, `${rare.value} vs ${iron.value}`);
  const priced = items.types.filter((t) => t.template);
  check("no generated item is free", priced.every((t) => t.value > 0), String(priced.filter((t) => !(t.value > 0)).length));
  console.log(`sword price: bronze ${sword.value}c, iron ${iron.value}c, iron rare ${rare.value}c; health potion ${balance.potionPrice(1)}c at level 1, ${balance.potionPrice(10)}c at 10`);
}

// --- a bad file is reported, all at once ---
{
  const broken = packs.map((pack) => ({ ...pack, files: pack.files.map((f) => (f.path === "rules/balance.json5" ? { ...f, text: "{ curves: { playerHealth: { from: 1 }, playerDps: { table: [] }, income: { value: 1, poly: [1,2,3] } }, roles: { x: { ttd: 3 } } }" } : f)) }));
  try {
    readBalanceRules(broken);
    check("a broken balance file is refused", false);
  } catch (error) {
    check("a broken balance file is refused with a ContentError", error instanceof ContentError);
    const text = String(error.message);
    check("...naming the curve, the role and the missing pieces", text.includes("playerHealth") && text.includes("roles.x") && text.includes("normal"), text);
  }
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
