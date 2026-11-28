// The duel and fit tool (B7, DUEL.md): a class's rotation on a timeline against a dummy or a creature,
// with the game's own skills, stats, gear and defence, measured against rules/balance.json5.
//   npm run duel -- warrior 5                 the class at level 5: against the dummy and a creature of each role
//   npm run duel -- warrior 5 vs wolf         one duel, written out (a kind id or a species: wolf, wolf.frost)
//   npm run duel -- warrior 5 vs dummy        the dummy alone (60 s)
//   npm run duel -- all                       the summary table: every class at levels 1, 5 and 10
//   npm run duel -- all --scales[=file.json]  and the suggested scales per class and level band (printed,
//                                             or written to the file: a suggestion, never into the packs)
//   options: config=<name> seed=<n> foeLevel=<n> start=<metres>
import { writeFileSync } from "node:fs";
import { loadDuelRulesFromDisk } from "../diskContent.mjs";
import { runDuel } from "../../src/sim/duel/duel.ts";
import { BANDS, classReport, duelLines, suggestScales, summaryTable } from "../../src/sim/duel/report.ts";

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const words = args.filter((a) => !a.includes("=") && !a.startsWith("--"));
const quiet = (run) => {
  const log = console.log;
  console.log = (...a) => (String(a[0]).startsWith("[") ? undefined : log(...a));
  try { return run(); } finally { console.log = log; }
};
const rules = await loadDuelRulesFromDisk(option("config"));
const seed = Number(option("seed") ?? 1);
const classes = rules.classes.map((c) => c.id).sort((a, b) => order(a) - order(b));
function order(id) { return rules.progression.origins.find((o) => o.id === id)?.order ?? 99; }

const [first, second, vs, foe] = words;
if (!first) {
  console.log(`classes: ${classes.join(", ")}\nnpm run duel -- <class> <level> [vs <kind>|dummy]   or   npm run duel -- all [--scales]`);
  process.exit(0);
}

if (first === "all") {
  const reports = [];
  for (const classId of classes) for (const { at } of BANDS) reports.push(quiet(() => classReport(rules, classId, at, { seed })));
  for (const line of summaryTable(reports)) console.log(line);
  console.log("\nttk·ttd·lost: seconds to kill (fights won), seconds the foe's damage would take to kill the character, share of health a fight costs; (want) the role's curve.");
  console.log("dps, EH: the dummy dps and the effective health over the curves; power their product (1 = the budget); axis 0 tank, 1 glass cannon.");
  const scales = flag("--scales");
  if (scales !== null) {
    const suggestion = { note: "B7 suggestion: factors on damage and on health per class and level band that put each on the curves. Not applied.", scales: suggestScales(reports) };
    if (scales) {
      writeFileSync(scales, `${JSON.stringify(suggestion, null, 2)}\n`);
      console.log(`\nsuggested scales written to ${scales}`);
    } else console.log(`\n${JSON.stringify(suggestion.scales, null, 1)}`);
  }
  process.exit(0);
}

const level = Number(second ?? 1);
if (!classes.includes(first) || !Number.isFinite(level) || level < 1) {
  console.log(`no class "${first}" (classes: ${classes.join(", ")}) or bad level "${second}"`);
  process.exit(2);
}
if (vs === "vs" && foe) {
  const result = quiet(() => runDuel(rules, { classId: first, level, foe, foeLevel: option("foeLevel") ? Number(option("foeLevel")) : undefined, start: option("start") ? Number(option("start")) : undefined, seed }));
  for (const line of duelLines(result)) console.log(line);
  process.exit(0);
}
const report = quiet(() => classReport(rules, first, level, { seed }));
for (const line of summaryTable([report])) console.log(line);
const d = report.dummy;
console.log(`\ndummy: ${d.dps.toFixed(1)} dps (curve ${d.target.toFixed(1)}), spent ${Object.entries(d.spentPerSecond).map(([k, v]) => `${k} ${v.toFixed(1)}/s`).join(", ") || "nothing"}; casts ${Object.entries(d.casts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
for (const r of report.roles) console.log(`${r.role}: ${r.won}/${r.fights} won against ${r.kinds.join(", ")}; out of range ${r.outOfRange.toFixed(1)} s a fight`);

function flag(name) {
  const a = args.find((x) => x === name || x.startsWith(`${name}=`));
  if (!a) return null;
  return a.includes("=") ? a.slice(name.length + 1) : "";
}
