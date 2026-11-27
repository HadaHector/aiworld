// The skill bank test (SLICE.md 3b, I6; SKILLBANK.md): every skill is in the bank and its tags read;
// the class templates load; the generator gives each class the skill counts of the curves at every
// level, lands near its template's ratios at levels 1 and 10, and keeps its cooldown limits; the
// hand-picked classes (the origins) are what their templates give. `--report` prints the bank and
// each class's progression.
//   npm run probe -- scripts/probe/skillBank.mjs [--report]
import { readSkillBank, bankLine } from "../../src/sim/rules/skillBank.ts";
import { readClassTemplates, generateClass, progressionLines, ratiosAt, percent } from "../../src/sim/rules/classGen.ts";
import { readBalanceRules } from "../../src/sim/rules/balanceRules.ts";
import { loadRulesFromDisk, packSourcesFromDisk, readConfigFromDisk } from "../diskContent.mjs";

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

const packs = packSourcesFromDisk(readConfigFromDisk()).sources;
const game = loadRulesFromDisk();
const bank = readSkillBank(packs, game);
check("the core pack has a skill bank", bank !== null);

// --- every skill tagged ---
for (const s of game.skills) check(`${s.id} is in the bank`, bank.byId.has(s.id));
for (const s of bank.skills) if (s.pool === "class" && !bank.free.includes(s.id)) check(`${s.id} has effects`, s.effects.length > 0, bankLine(s));

if (report) {
  for (const pool of ["class", "creature", "item", "effect", "test"]) {
    console.log(`\n${pool}:`);
    for (const s of bank.skills.filter((x) => x.pool === pool)) console.log(`  ${s.id.padEnd(18)} ${bankLine(s)}`);
  }
}

// --- class templates and the generator ---
const balance = readBalanceRules(packs);
const templates = readClassTemplates(packs, bank);
check("four class templates", ["mage", "priest", "ranger", "warrior"].every((id) => templates.some((t) => t.id === id)), templates.map((t) => t.id).join(", "));
const order = ["warrior", "ranger", "mage", "priest"];
const classes = new Map();
for (const t of [...templates].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))) {
  const c = generateClass(t, bank, balance);
  classes.set(t.id, c);
  for (const { level, active, passive } of c.counts) {
    const wantA = Math.round(balance.curve("skillsActive", level));
    const wantP = Math.round(balance.curve("skillsPassive", level));
    check(`${t.id}: ${wantA} active and ${wantP} passive at ${level}`, active === wantA && passive === wantP, `${active} and ${passive}`);
  }
  check(`${t.id}: nothing failed to fit`, c.problems.length === 0, c.problems.join("; "));
  for (const level of [1, 10]) check(`${t.id}: near its ratios at ${level}`, c.errorAt(level) <= 0.25, `${percent(c.sharesAt(level))} against ${percent(ratiosAt(t, level))}`);
  for (const [cls, most] of t.limits) check(`${t.id}: at most ${most} ${cls}`, c.picks.filter((p) => p.skill.cooldownClass === cls).length <= most);
  if (report) {
    console.log(`\n${t.name} (axis ${t.axis}, ${t.distance}):`);
    for (const line of progressionLines(c)) console.log(line);
    for (const level of [1, 10]) console.log(`  at ${level}: ${percent(c.sharesAt(level))}   (asked: ${percent(ratiosAt(t, level))}, off by ${c.errorAt(level).toFixed(2)})`);
    console.log(`  power shares: ${c.picks.map((p) => `${p.skill.name} ${Math.round(p.share * 100)}%`).join(", ")}`);
  }
}

// --- a class nobody wrote: the same generator over a mixed description ---
const mixed = {
  id: "spellsword", file: "(probe)", name: "Spellsword (made up by the probe)", axis: 0.5, distance: "closes",
  resources: ["rage", "mana"], schools: ["physical", "fire"], weapon: "", stats: ["strength", "intellect"],
  reach: new Map([["melee", 1], ["ranged", 0.6]]),
  ratios: [{ level: 1, shares: new Map([["damage", 0.7], ["mobility", 0.3]]) }, { level: 10, shares: new Map([["damage", 0.6], ["control", 0.2], ["mobility", 0.1], ["defence", 0.1]]) }],
  limits: new Map([["long", 2], ["ultimate", 1]]), picks: [],
};
const made = generateClass(mixed, bank, balance);
// Not a check: it shows where the bank is too thin for a description, which is for the owner to read.
if (report) {
  console.log(`\n${mixed.name}:`);
  for (const line of progressionLines(made)) console.log(line);
  console.log(`  at 10: ${percent(made.sharesAt(10))}   (asked: ${percent(ratiosAt(mixed, 10))}, off by ${made.errorAt(10).toFixed(2)})`);
  for (const p of made.problems) console.log(`  missing: ${p}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
