// Runs probes by category and prints a line for each as it ends: seconds, exit, the probe's own "checks" line.
// The categories are the team's fields (WORKFLOW.md): a session runs its own field's, the main session the
// fields of what it merged, or all.
//   npm run probes -- dungeons rules     the probes of those categories (a probe in both runs once)
//   npm run probes -- all                every probe
//   npm run probes -- water quests       probes can be named too, beside categories
//   npm run probes -- --list             the categories and their probes
//   npm run probes -- all --full         each probe in its full mode (many minutes); PROBE_FULL=1 too
//   npm run probes -- dungeons --worklists   also the worklists: probes that fail until their work is built
//   npm run probes -- all --jobs=1       one probe at a time (default 3 at once; times are then each alone)
// Every probe in scripts/probe must be in a category (or a helper or worklist below), so a new one gets one.
import { spawn } from "node:child_process";
import { openSync, closeSync, unlinkSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CATEGORIES = {
  features: ["abandonedCamp", "yardShape", "featureReach", "vale"],
  placement: ["vale", "starts", "abandonedCamp"],
  dungeons: ["dungeons", "navigation"],
  "terrain-water": ["water", "riverLevels", "mapTiles", "swim", "vale"],
  gameplay: ["lairSave", "abilities", "entities", "collision", "creatures", "beast", "chat", "feedback", "ambience"],
  rules: ["balance", "items", "progression", "quests", "npcs", "saves", "starts"],
  art: ["body", "beast", "icons", "feedback"],
};
/** Checks that fail today because the work they check is not built: run only with --worklists. */
const WORKLISTS = { dungeons: ["caves", "caveMouths"] };
const HELPERS = ["hook", "tsResolve", "loadContent", "mode", "run"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const jobs = Math.max(1, Number(args.find((a) => a.startsWith("--jobs="))?.slice(7)) || 3);
// PROBE_JOBS tells a probe it shares the CPU (navigation lets a wall-clock limit go then).
const env = { ...process.env, PROBE_JOBS: String(jobs), ...(flag("--full") ? { PROBE_FULL: "1" } : {}) };
const names = args.filter((a) => !a.startsWith("--"));

const all = [...new Set(Object.values(CATEGORIES).flat())];
const worklists = [...new Set(Object.values(WORKLISTS).flat())];
const onDisk = readdirSync("scripts/probe").filter((f) => f.endsWith(".mjs") && !f.endsWith(".local.mjs") && f !== "scratch.mjs").map((f) => f.slice(0, -4));
const orphans = onDisk.filter((p) => !all.includes(p) && !worklists.includes(p) && !HELPERS.includes(p));
const missing = [...all, ...worklists].filter((p) => !onDisk.includes(p));
if (orphans.length || missing.length) {
  if (orphans.length) console.log(`probes in no category (add them to CATEGORIES in scripts/probe/run.mjs): ${orphans.join(", ")}`);
  if (missing.length) console.log(`listed but not in scripts/probe: ${missing.join(", ")}`);
  process.exit(2);
}

if (flag("--list") || names.length === 0) {
  for (const [c, ps] of Object.entries(CATEGORIES)) console.log(`${c.padEnd(14)} ${ps.join(", ")}${WORKLISTS[c] ? `  (worklists: ${WORKLISTS[c].join(", ")})` : ""}`);
  if (names.length === 0 && !flag("--list")) console.log("\nname categories (or all, or probes) to run: npm run probes -- dungeons rules");
  process.exit(0);
}

const run = [];
for (const n of names) {
  const ps = n === "all" ? all : CATEGORIES[n] ?? (all.includes(n) || worklists.includes(n) ? [n] : null);
  if (!ps) { console.log(`no category or probe "${n}"; categories: ${Object.keys(CATEGORIES).join(", ")}, all`); process.exit(2); }
  run.push(...ps);
  if (flag("--worklists")) run.push(...(n === "all" ? worklists : WORKLISTS[n] ?? []));
}
// Slowest first, so the long ones do not end the run alone.
const SLOW = ["quests", "dungeons", "caves", "npcs", "creatures", "navigation", "caveMouths", "starts"];
const queue = [...new Set(run)];
queue.sort((a, b) => { const ia = SLOW.indexOf(a), ib = SLOW.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });

// One heavy probe run at a time on this machine (WORKFLOW.md): a lock file in the system temp folder, so
// every worktree's copy of this script shares it. A second run waits for the first; a lock left by a dead
// process (older than an hour) is taken over.
const LOCK = join(tmpdir(), "aiworld-probe-quick.lock");
const LOCK_STALE_MS = 60 * 60 * 1000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let announced = false;
for (;;) {
  try {
    closeSync(openSync(LOCK, "wx"));
    writeFileSync(LOCK, `${process.pid} ${Date.now()}`);
    break;
  } catch {
    let since = 0;
    try { since = Number(readFileSync(LOCK, "utf8").split(" ")[1]) || 0; } catch {}
    if (since && Date.now() - since > LOCK_STALE_MS) { try { unlinkSync(LOCK); } catch {} continue; }
    if (!announced) console.log("another probe run is going; waiting for it to finish...");
    announced = true;
    sleep(5000);
  }
}
const release = () => { try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch {} };
process.on("exit", release);
process.on("SIGINT", () => { release(); process.exit(130); });

const started = Date.now();
let bad = 0, done = 0;
function runOne(name) {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import", "./scripts/probe/hook.mjs", `scripts/probe/${name}.mjs`], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (status) => {
      const lines = out.split(/\r?\n/);
      const summary = [...lines].reverse().find((l) => /\bchecks?\b|failures|^all good|^ok$|^no faults/.test(l) && !/^\s*FAIL/.test(l)) ?? "";
      const fails = lines.filter((l) => /^\s*FAIL/.test(l)).length;
      if (status !== 0) bad++;
      done++;
      console.log(`${status === 0 ? "ok  " : "FAIL"} ${name.padEnd(14)} ${((Date.now() - t) / 1000).toFixed(1).padStart(6)} s  ${summary.trim().slice(0, 90)}${status !== 0 && fails ? `  (${fails} FAIL lines)` : ""}`);
      if (status !== 0 && flag("--verbose")) console.log(lines.filter((l) => /^\s*FAIL/.test(l)).slice(0, 20).join("\n"));
      resolve();
    });
  });
}
const pending = [...queue];
await Promise.all(Array.from({ length: Math.min(jobs, pending.length) }, async () => { while (pending.length) await runOne(pending.shift()); }));
console.log(`${done - bad}/${done} probes exit clean in ${((Date.now() - started) / 1000).toFixed(0)} s (${jobs} at a time${env.PROBE_FULL === "1" ? ", full mode" : ""})`);
process.exitCode = bad ? 1 : 0;
