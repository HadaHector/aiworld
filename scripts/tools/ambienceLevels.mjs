// The ambience's loudness, rendered offline in headless Chrome (MUSIC.md, *Ambience*): each recording's
// own RMS, then each fx-page preset as the game would hear it - recorded and synthesized alone - so the
// recordings' gains in rules/ambience.json5 can be set to the synthesized mix's levels.
//   node scripts/tools/ambienceLevels.mjs ["preset|preset..."] [seconds=20]
// It serves this checkout itself (vite on a free port 5190-5197), never 5173 or 5174.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { launchChrome } from "../shot/cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const seconds = Number(args.find((a) => a.startsWith("seconds="))?.slice(8) ?? 20);
// Presets are named with commas in them ("wood, day"): several are given split by "|".
const only = args.find((a) => !a.includes("="))?.split("|");

const serving = async (port) => {
  try {
    return (await fetch(`http://localhost:${port}/fx.html`)).ok;
  } catch {
    return false;
  }
};
let port = 5190 + Math.floor(Math.random() * 8);
for (let k = 0; k < 8 && (await serving(port)); k++) port = 5190 + ((port - 5190 + 1) % 8);
const vite = resolve(dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js");
const server = spawn(process.execPath, [vite, "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
for (let i = 0; i < 150 && !(await serving(port)); i++) await new Promise((r) => setTimeout(r, 200));

const chrome = await launchChrome(800, 600);
try {
  await chrome.goto(`http://localhost:${port}/fx.html`);
  for (let i = 0; i < 300 && !(await chrome.eval("!!window.__fxAmbience?.ready?.()").catch(() => false)); i++) await new Promise((r) => setTimeout(r, 200));
  const data = readFileSync(resolve(root, "public/packs/core/rules/ambience.json5"), "utf8");
  const files = [...new Set([...data.matchAll(/"(ambience\/[^"]+)"/g)].map((m) => `core/${m[1]}`))];
  console.log("recordings (whole file):");
  for (const f of files) {
    const r = await chrome.eval(`__fxAmbience.fileRms(${JSON.stringify(f)})`);
    console.log(`  ${f.padEnd(34)} rms ${r.rms.toFixed(4)}  peak ${r.peak.toFixed(3)}  ${r.seconds.toFixed(1)} s  ${r.channels} ch`);
  }
  const presets = only ?? (await chrome.eval("Object.keys(__fxAmbience.presets)"));
  console.log(`\npresets (${seconds} s after a 6 s fade-in):            recorded           synthesized`);
  for (const p of presets) {
    const rec = await chrome.eval(`__fxAmbience.measureAmbience(${JSON.stringify(p)}, { seconds: ${seconds} })`);
    const syn = await chrome.eval(`__fxAmbience.measureAmbience(${JSON.stringify(p)}, { seconds: ${seconds}, recorded: false })`);
    console.log(`  ${p.padEnd(24)} rms ${rec.rms.toFixed(4)} peak ${rec.peak.toFixed(3)}   rms ${syn.rms.toFixed(4)} peak ${syn.peak.toFixed(3)}   ${rec.layers.split(" ").filter((l) => l.endsWith(":recorded")).map((l) => l.split(":")[0]).join(",")}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (chrome.logs.length) console.log(chrome.logs.join("\n"));
  chrome.close();
  server.kill();
}
