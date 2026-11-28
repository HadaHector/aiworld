// The item ladder and loot test (SLICE.md I8, I1; ITEMS.md, *The ladder*): every laddered type makes its
// six rungs and its grey trash, one icon each; every generated item sits within the budget the curves
// give it; a character in a full kit of its level lands near the health curve (within 25%: the warrior, a tank, runs high mid-way, where the geometric curve dips); grey trash beats the
// starting piece it replaces; loot money and chests make the income curve's shares by level; prices,
// selling, repair and potions come from the curves. `--report` prints example items by level and
// rarity and the drop tables of a wolf, a bandit, a lair chest and a boss at levels 1, 5 and 10.
//   npm run probe -- scripts/probe/itemLadder.mjs [--report]
import { loadCreatureRulesFromDisk, loadItemRulesFromDisk, loadProgressionRulesFromDisk, loadRulesFromDisk } from "../diskContent.mjs";
import { ladderBudget } from "../../src/sim/rules/itemLadder.ts";
import { rollLoot } from "../../src/sim/rules/itemRules.ts";
import { createEntity } from "../../src/sim/entity.ts";
import { addModifier, statValue } from "../../src/sim/stats.ts";
import { createProgress, setLevel } from "../../src/sim/progression/progress.ts";
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
const report = process.argv.includes("--report");
const G = loadRulesFromDisk();
loadCreatureRulesFromDisk("default", G, 0);
const P = loadProgressionRulesFromDisk("default", G, 0);
const I = loadItemRulesFromDisk("default", G, 0);
const B = I.balance;
const L = I.layout;
check("the layout loads", !!L && !!B);
const stat = (id) => G.statIndex.get(id);
const rarity = (t) => I.rarities[t.rarity].id;

// --- every laddered type: six rungs and the trash, one icon, its levels and rarities ---
const ladders = new Map();
for (const t of I.types) if (t.parts.rung) ladders.set(t.template, [...(ladders.get(t.template) ?? []), t]);
check("36 armour, weapon and trinket types and the caster's off hand", ladders.size === 37, String(ladders.size));
const rungIds = [...L.rungs.map((r) => r.id), ...L.trash.levels.map((l) => `trash${l}`)];
for (const [template, list] of ladders) {
  const ids = list.map((t) => t.parts.rung).sort().join();
  check(`${template}: every rung and the trash`, ids === [...rungIds].sort().join(), ids);
  check(`${template}: one icon`, new Set(list.map((t) => t.icon)).size === 1 && list[0].icon !== "", [...new Set(list.map((t) => t.icon))].join());
  for (const r of L.rungs) {
    const t = list.find((x) => x.parts.rung === r.id);
    if (t) check(`${t.id}: level ${r.level}, ${r.rarity}`, t.itemLevel === r.level && rarity(t) === r.rarity);
  }
}

// --- every generated item within its budget ---
let worst = 0;
let over = [];
for (const t of I.types) {
  if (!t.parts.rung) continue;
  const line = L.lines.get(t.parts.line);
  const slots = [...t.slots, ...t.fills].map((i) => I.slots[i].id);
  const b = ladderBudget(L, line, G, B, t.itemLevel, slots, I.rarities[t.rarity].budget);
  const max = (id) => t.stats.filter((s) => s.stat === stat(id)).reduce((a, s) => a + s.max, 0);
  const points = ["strength", "agility", "stamina", "intellect", "spirit"].reduce((a, s) => a + max(s), 0);
  const fits = points <= Math.round(b.points) && max("armor") <= Math.round(b.armor) + 1 && (line.speed === 0 || max("weaponMax") <= Math.round(b.weaponMax) + 1);
  if (!fits) over.push(`${t.id} ${points}/${b.points.toFixed(1)}`);
  worst = Math.max(worst, points - b.points);
}
check("every generated item within its stat, armour and damage budget", over.length === 0, over.slice(0, 5).join("; "));

// --- grey trash beats the start piece of its type from level 4 ---
const power = (t) => t.stats.filter((s) => s.stat !== stat("weaponSpeed") && s.stat !== stat("attackRange") && s.stat !== stat("blockChance")).reduce((a, s) => a + s.max, 0);
const greys = [...ladders.keys()].filter((tmpl) => {
  const start = I.types[I.typeIndex.get(`${tmpl}.start`)];
  const grey = I.types[I.typeIndex.get(`${tmpl}.trash4`)];
  return power(grey) > power(start);
});
check("a level 4 grey beats the starting piece of its type", greys.length >= ladders.size - 3, `${greys.length} of ${ladders.size}`);

// --- a character in a full kit of its level: near the health curve ---
const ctx = { game: G, rules: P, grant() {}, revoke() {} };
const KITS = { warrior: ["sword", "roundShield", "mail"], ranger: ["bow", null, "leather"], mage: ["staff", "orb", "cloth"], priest: ["mace", "orb", "cloth"] };
const PARTS = ["Head", "Shoulders", "Chest", "Wrists", "Hands", "Waist", "Legs", "Feet"];
const kitAt = { 1: "start", 5: "shop", 10: "loot7" };
const healthLines = [];
let id = 1;
for (const [klass, [weapon, off, armour]] of Object.entries(KITS)) {
  const row = [];
  for (const [level, rung] of Object.entries(kitAt)) {
    const e = createEntity(G, G.templates.get(P.combinations.get(`human.${klass}`)), id++, { dimension: "", x: 0, y: 0, z: 0, facing: 0 });
    createProgress(ctx, e, new Map([["people", P.originIndex.get("human")], ["class", P.originIndex.get(klass)]]));
    setLevel(ctx, e, P.disciplineIndex.get("adventure"), Number(level));
    const kit = [weapon, off, ...PARTS.map((p) => armour + p), "cloak", "amulet", "ring"].filter(Boolean).map((t) => `${t}.${rung}`);
    for (const k of kit) {
      const t = I.types[I.typeIndex.get(k)];
      for (const s of t.stats) addModifier(e.stats, { stat: s.stat, kind: s.kind, value: (s.min + s.max) / 2, source: "kit" });
    }
    const health = statValue(e.stats, stat("maxHealth"));
    const want = B.curve("playerHealth", Number(level));
    row.push(`${level}: ${Math.round(health)}/${Math.round(want)}`);
    check(`${klass} at ${level} in a full ${rung} kit: health near the curve`, health >= want * 0.75 && health <= want * 1.25, `${Math.round(health)} against ${Math.round(want)}`);
  }
  healthLines.push(`  ${klass.padEnd(8)} ${row.join("   ")}`);
}

// --- loot money by level: the income curve's shares ---
const context = (level) => {
  const c = new Float64Array(2 * G.stats.length);
  c[I.levelStat] = level;
  c[G.stats.length + I.levelStat] = level;
  return c;
};
const sample = (table, level, n = 3000) => {
  const random = mulberry32(1234 + level);
  const out = { money: 0, items: new Map() };
  for (let k = 0; k < n; k++) {
    for (const d of rollLoot(I, table, context(level), random)) {
      if ("currency" in d) {
        if (d.currency === I.main) out.money += d.amount;
      } else out.items.set(d.type, (out.items.get(d.type) ?? 0) + d.count);
    }
  }
  out.money /= n;
  return out;
};
const goldLines = [];
for (const level of [1, 3, 5, 7, 10]) {
  const income = B.income(level);
  const kill = sample("wolf", level).money;
  const chest = sample("dungeonChest", level).money;
  const kills = kill * B.killsPerHour;
  const chests = chest * B.chestsPerHour;
  goldLines.push(`  ${String(level).padStart(2)}: income ${Math.round(income)}c an hour; kills ${Math.round(kills)}c (${Math.round((100 * kills) / income)}%, curve 40%), chests ${Math.round(chests)}c (${Math.round((100 * chests) / income)}%, curve 25%)`);
  check(`level ${level}: kill money an hour is the kills' share of income`, Math.abs(kills / (income * B.incomeSplit.kills) - 1) < 0.1, `${Math.round(kills)} against ${Math.round(income * B.incomeSplit.kills)}`);
  check(`level ${level}: chest money an hour is the chests' share`, Math.abs(chests / (income * B.incomeSplit.chests) - 1) < 0.15, `${Math.round(chests)} against ${Math.round(income * B.incomeSplit.chests)}`);
}

// --- gear drops are near the source's level ---
for (const level of [1, 5, 10]) {
  const s = sample("gear", level, 4000);
  const levels = [...s.items.keys()].map((t) => I.types[t].itemLevel);
  check(`gear at level ${level} within three levels of it (a level 10 drop may be the level 7 green: the only level 9 loot is rare)`, levels.length > 0 && levels.every((l) => Math.abs(l - level) <= 3), [...new Set(levels)].join());
}

// --- prices: from the curves ---
const price = (id) => I.types[I.typeIndex.get(id)].value;
check("potions cost 3 minutes of income", price("healthPotion") === B.potionPrice(1) && price("manaPotion") === B.potionPrice(1), `${price("healthPotion")} vs ${B.potionPrice(1)}`);
check("a shop weapon of the band costs about 25 minutes of income", Math.abs(price("sword.shop") / ((B.income(4) / 60) * 25) - 1) < 0.05, `${price("sword.shop")}`);
check("vendors pay 25%", I.config.sellRate === B.sellRate && B.sellRate === 0.25, String(I.config.sellRate));
const repair = I.config.repairCost.run([10, 10, 1000, 5]);
check("a full repair costs the balance's repair share of the value", Math.abs(repair - Math.ceil(1000 * B.repairShare)) <= 1, `${repair} vs ${1000 * B.repairShare}`);
check("grey trash sells for little", price("sword.trash4") < price("sword.start") / 2, `${price("sword.trash4")} vs ${price("sword.start")}`);

if (report) {
  const name = (t) => `${t.name} (${rarity(t)}, L${t.itemLevel})`;
  const statLine = (t) => t.stats.filter((s) => s.max > 0 && s.stat !== stat("weaponSpeed")).map((s) => `${G.stats[s.stat].name} ${s.min === s.max ? s.max : `${s.min}-${s.max}`}`).join(", ");
  console.log("\nExample items:");
  for (const tid of ["sword.start", "sword.shop", "sword.quest", "sword.loot9", "sword.trash4", "leatherChest.start", "leatherChest.loot7", "leatherChest.loot9", "mailChest.loot9", "clothHead.quest", "bow.loot9", "ring.loot9"]) {
    const t = I.types[I.typeIndex.get(tid)];
    console.log(`  ${name(t).padEnd(36)} ${statLine(t)}; ${t.value}c`);
  }
  console.log("\nHealth in a full kit (start at 1, shop at 5, the level 7 greens at 10), against the curve:");
  for (const l of healthLines) console.log(l);
  console.log("\nMoney an hour:");
  for (const l of goldLines) console.log(l);
  for (const table of ["wolf", "bandit", "dungeonChest", "cryptBoss"]) {
    console.log(`\n${table}:`);
    for (const level of [1, 5, 10]) {
      const s = sample(table, level, 2000);
      const top = [...s.items].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([t, n]) => `${I.types[t].name}${I.types[t].template ? ` (${rarity(I.types[t])} L${I.types[t].itemLevel})` : ""} ${Math.round((100 * n) / 2000)}%`);
      console.log(`  level ${level}: ${s.money.toFixed(1)}c; ${top.join(", ")}`);
    }
  }
}
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
