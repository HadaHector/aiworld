// The duel tool's probe (B7, DUEL.md): every class at levels 1, 5 and 10 against the dummy and one
// creature of each role runs without error, and what it reports is sane - the class has its skills at
// the level, it deals damage, casts more than its auto-attack, the numbers are finite, a dummy fight
// lasts its time, the same seed gives the same duel. It checks the tool, not the balance: where a class
// sits against the curves is the report's (`npm run duel -- all`), not a failure here.
//   npm run probe -- scripts/probe/duel.mjs
import { loadDuelRulesFromDisk } from "../diskContent.mjs";
import { runDuel } from "../../src/sim/duel/duel.ts";
import { classReport, representatives, summaryTable, suggestScales, BANDS } from "../../src/sim/duel/report.ts";
import { createArena } from "../../src/sim/duel/arena.ts";

let checks = 0, failures = 0;
const check = (what, ok, detail = "") => { checks++; if (!ok) { failures++; console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`); } };
const log = console.log;
const quiet = (run) => { console.log = (...a) => (String(a[0]).startsWith("[") ? undefined : log(...a)); try { return run(); } finally { console.log = log; } };
const finite = (x) => typeof x === "number" && Number.isFinite(x);

const rules = await loadDuelRulesFromDisk();
const classes = rules.classes.map((c) => c.id);
check("the four classes have templates", ["warrior", "ranger", "mage", "priest"].every((c) => classes.includes(c)), classes.join(","));
const byRole = representatives(rules);
const kinds = [...byRole.values()].map((ks) => ks[0]);
check("a creature of each role to fight", kinds.length >= 3, [...byRole.keys()].join(","));

// The character the arena makes: its skills and ranks at the level, as the skill bank says.
for (const classId of classes) for (const { at: level } of BANDS) {
  const arena = quiet(() => createArena(rules));
  const me = quiet(() => arena.character(classId, level, 0));
  const active = me.combat.spells.filter((s) => !rules.game.skills[s.skill].passive && rules.game.skills[s.skill].id !== "autoAttack").length;
  const want = rules.creatures.balance.curve("skillsActive", level);
  // Kick is a trainer's, Frost Nova a book's: an active skill or so short of the curve is what a character starts with.
  check(`${classId} ${level}: knows its skills`, active >= want - 1 && active <= want, `${active} active, the curve says ${want}`);
  check(`${classId} ${level}: wears its start kit`, (me.gear ?? []).length > 0);
  if (level === 10) check(`${classId} 10: ranks have come`, me.combat.spells.some((s) => s.level === 3), me.combat.spells.map((s) => `${rules.game.skills[s.skill].id}${s.level}`).join(" "));
}

// Every class and level against the dummy and a creature of each role.
const reports = [];
for (const classId of classes) for (const { at: level } of BANDS) {
  let report;
  try {
    report = quiet(() => classReport(rules, classId, level, { kinds }));
  } catch (error) {
    check(`${classId} ${level}: the duels run`, false, String(error?.stack ?? error));
    continue;
  }
  reports.push(report);
  const tag = `${classId} ${level}`;
  check(`${tag}: deals damage to the dummy`, report.dummy.dps > 0, String(report.dummy.dps));
  check(`${tag}: casts more than its auto-attack`, Object.keys(report.dummy.casts).length > 0, JSON.stringify(report.dummy.casts));
  check(`${tag}: the numbers are finite`, [report.dummy.dps, report.dummy.target, report.ehRatio, report.dpsRatio, report.power, report.axis].every(finite));
  check(`${tag}: spends a resource`, Object.values(report.dummy.spentPerSecond).some((v) => v > 0), JSON.stringify(report.dummy.spentPerSecond));
  for (const r of report.roles) {
    check(`${tag} vs ${r.role}: fought`, r.fights > 0);
    check(`${tag} vs ${r.role}: lost a sane share of health`, r.lost >= 0 && r.lost <= 1, String(r.lost));
  }
}
check("a report for every class and level", reports.length === classes.length * BANDS.length, `${reports.length}`);

// The same seed, the same duel; a dummy fight lasts its time; a creature fight ends.
const a = quiet(() => runDuel(rules, { classId: "warrior", level: 5, foe: kinds[0], seed: 3 }));
const b = quiet(() => runDuel(rules, { classId: "warrior", level: 5, foe: kinds[0], seed: 3 }));
check("the same seed gives the same duel", JSON.stringify(a) === JSON.stringify(b));
const d = quiet(() => runDuel(rules, { classId: "mage", level: 1, foe: "dummy", limit: 20 }));
check("a dummy fight runs its time", d.winner === "time" && Math.abs(d.seconds - 20) < 0.1, `${d.winner} ${d.seconds}`);
const w = quiet(() => runDuel(rules, { classId: "warrior", level: 1, foe: "wolf" }));
check("a warrior kills a level 1 wolf", w.winner === "player", `${w.winner} after ${w.seconds.toFixed(1)} s`);
check("the wolf fights back", w.enemy.dealt > 0);
check("a melee class spends little time out of reach", w.outOfRange < 3, w.outOfRange.toFixed(1));

// The suggestion has a damage and a health factor for every class and band.
const scales = suggestScales(reports);
check("a suggested scale per class and band", classes.every((c) => scales[c]?.length === BANDS.length && scales[c].every((s) => finite(s.damage) && finite(s.health))));

for (const line of summaryTable(reports)) log(line);
log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
