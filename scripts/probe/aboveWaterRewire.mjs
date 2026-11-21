// Rewires the packs' waterline rules from the input "height" to "aboveWater" (WATER.md, *Waterside
// plants*): a height input whose every reader is about the waterline (masks within 8 m of 0, or an add
// feeding such masks) is switched; one read both near the water and at altitude gets a second input for
// the near readers. Altitude rules are left on height. Edits the text, so comments stay.
//   node scripts/probe/aboveWaterRewire.mjs [--write]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import JSON5 from "json5";

const WRITE = process.argv.includes("--write");
const NEAR = 8;
// Low ground that is not about water: the ice peaks' glacier fills the valley floors.
const KEEP = [{ file: "icePeaks.json5", at: 6, off: 2 }];
const dirs = ["public/packs/core/biomes", "public/packs/core/layers"];

const graphsOf = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => graphsOf(n, out));
  else if (node && typeof node === "object") {
    if (Array.isArray(node.steps)) out.push(node.steps);
    for (const v of Object.values(node)) graphsOf(v, out);
  }
  return out;
};
const reads = (s, name) => s.input === name || s.a === name || s.b === name;
// A mask's at or off: a number, or a range rolled per area - its farthest end from 0.
const far = (v) => (typeof v === "number" ? Math.abs(v) : Array.isArray(v?.range) ? Math.max(...v.range.map(Math.abs)) : Infinity);

for (const dir of dirs) {
  for (const file of readdirSync(dir)) {
    const path = `${dir}/${file}`;
    const text = readFileSync(path, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const plans = [];
    let k = -1;
    for (const steps of graphsOf(JSON5.parse(text))) {
      for (const step of steps) {
        if (step.op !== "input" || step.name !== "height") continue;
        k++;
        const v = step.output;
        const water = [];
        let alt = 0;
        const judge = (s) => {
          if (s.op === "mask") {
            const kept = KEEP.some((k) => k.file === file && k.at === s.at && k.off === s.off);
            return !kept && Math.max(far(s.at), far(s.off)) <= NEAR;
          }
          if (s.op === "add") {
            const next = steps.filter((t) => reads(t, s.output));
            return next.length > 0 && next.every(judge);
          }
          return false;
        };
        for (const s of steps.filter((t) => reads(t, v))) {
          if (judge(s)) water.push(s);
          else alt++;
        }
        if (water.length === 0) continue;
        plans.push({ k, v, mode: alt === 0 ? "switch" : "split", water });
      }
    }
    // The input lines, in the file's order - the same order the parse walked them in.
    const inputLines = lines.map((l, i) => (/op: "input", name: "height"/.test(l) ? i : -1)).filter((i) => i >= 0);
    const allInputs = graphsOf(JSON5.parse(text)).flatMap((steps) => steps.filter((s) => s.op === "input" && s.name === "height"));
    if (inputLines.length !== allInputs.length) {
      console.log(`SKIP ${file}: ${inputLines.length} input lines, ${allInputs.length} parsed`);
      continue;
    }
    // Each plan's input is the k-th in the file, as the parse walked them.
    const inserts = [];
    for (const plan of plans) {
      const line = inputLines[plan.k];
      if (!lines[line].includes(`output: "${plan.v}"`)) { console.log(`WARN ${file}:${line + 1} is not ${plan.v}`); continue; }
      if (plan.mode === "switch") {
        lines[line] = lines[line].replace(`name: "height"`, `name: "aboveWater"`);
        console.log(`switch ${file}:${line + 1} ${plan.v}`);
      } else {
        const name = `${plan.v}AboveWater`;
        const indent = lines[line].match(/^\s*/)[0];
        inserts.push({ after: line, text: `${indent}{ output: "${name}", op: "input", name: "aboveWater" },` });
        // Redirect the near readers within this graph: the lines after the input naming them.
        for (const s of plan.water) {
          for (let j = line + 1; j < Math.min(lines.length, line + 80); j++) {
            if (lines[j].includes(`output: "${s.output}"`) && new RegExp(`(input|a|b): "${plan.v}"`).test(lines[j])) {
              lines[j] = lines[j].replace(new RegExp(`(input|a|b): "${plan.v}"`), `$1: "${name}"`);
              console.log(`split  ${file}:${j + 1} ${s.output} now reads ${name}`);
              break;
            }
          }
        }
      }
    }
    for (const ins of inserts.sort((a, b) => b.after - a.after)) lines.splice(ins.after + 1, 0, ins.text);
    if (WRITE && plans.length > 0) writeFileSync(path, lines.join(eol));
  }
}
