// Runs the fast probe set one after another and prints a line for each: seconds, exit, the probe's own
// "checks" line. One probe at a time (they are CPU-bound; running them together only blurs the times).
//   npm run probe:quick               the quick set, each in its quick mode
//   npm run probe:quick -- dungeons   only the named ones
//   PROBE_FULL=1 npm run probe:quick  the same set in full mode (many minutes)
// Left out of the set: music (prints a song, checks nothing), aboveWaterRewire (a one-off rewrite of the
// packs), caves (a diagnostic of the lairs that fails until NAVIGATION.md step 6 is built), and the helpers.
import { spawnSync } from "node:child_process";
const SET = ["abandonedCamp", "ambience", "balance", "beast", "beastGaits", "body", "grove", "icons", "roadWater", "water", "yardShape", "swim", "vale", "starts",
  "riverLevels", "mapTiles", "chat", "saves", "npcs", "entities", "items", "progression", "abilities", "feedback", "collision", "navigation", "creatures", "quests", "dungeons"];
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const run = only.length ? only : SET;
const started = Date.now();
let bad = 0;
for (const name of run) {
  const t = Date.now();
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./scripts/probe/hook.mjs", `scripts/probe/${name}.mjs`], { encoding: "utf8", maxBuffer: 1 << 28, env: process.env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const lines = out.split(/\r?\n/);
  const summary = [...lines].reverse().find((l) => /\bchecks?\b|failures|^all good|^ok$|^no faults/.test(l) && !/^FAIL/.test(l)) ?? "";
  const fails = lines.filter((l) => /^\s*FAIL/.test(l)).length;
  if (r.status !== 0) bad++;
  console.log(`${r.status === 0 ? "ok  " : "FAIL"} ${name.padEnd(14)} ${((Date.now() - t) / 1000).toFixed(1).padStart(6)} s  ${summary.trim().slice(0, 90)}${r.status !== 0 && fails ? `  (${fails} FAIL lines)` : ""}`);
}
console.log(`${run.length - bad}/${run.length} probes exit clean in ${((Date.now() - started) / 1000).toFixed(0)} s`);
process.exitCode = bad ? 1 : 0;
