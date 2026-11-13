// npm run shot -- <asset> [view=3q,front,side,back,top,under,head] [t=0.5 | t=0:1.2:0.1 | t=0:1.2/12]
//                         [mode=...] [seed=N] [size=1600x1000] [tab=<workbench view>] [play=<clip>] [out=file.png]
//                         [any other workbench option, e.g. tint=#c08040 herd=3]
// Headless Chrome opens the workbench with `?shot`, waits for the preview, and writes one PNG: a contact
// sheet of views, or with a time range a filmstrip of the first view. See SHOTS.md.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.includes("="));
const named = Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
if (positional.length !== 1) {
  console.log("usage: npm run shot -- <asset, e.g. core/weapons/sword or weapons/sword> [view=front,side] [t=0:1:0.1] [mode=backface] ...");
  process.exit(1);
}
const asset = positional[0].split("/").length === 2 ? `core/${positional[0]}` : positional[0];

function parseTimes(text) {
  if (!text) return [0];
  const [from, rest] = text.split(/:(.*)/s);
  if (rest === undefined) return [Number(from)];
  let to, step;
  if (rest.includes("/")) {
    const [end, count] = rest.split("/");
    to = Number(end);
    step = (to - Number(from)) / Math.max(1, Number(count) - 1);
  } else [to, step] = rest.split(":").map(Number);
  const times = [];
  for (let t = Number(from); t <= to + 1e-6 && times.length < 64; t += step || 1) times.push(Math.round(t * 1000) / 1000);
  return times;
}
const times = parseTimes(named.t);
if (times.some((t) => !Number.isFinite(t))) throw new Error(`Bad t=${named.t}`);
const views = (named.view ?? "").split(",").filter(Boolean);
const [width, height] = (named.size ?? "1600x1000").split("x").map(Number);
const out = resolve(root, named.out ?? `shots/${asset.replaceAll("/", "_")}${named.mode ? `_${named.mode.replaceAll(",", "-")}` : ""}.png`);

// The workbench's own URL: its view (tab) and options.
// Grass off unless asked for: it hides where a thing meets the ground.
const page = new URLSearchParams({ asset, shot: "1", grass: "off" });
const reserved = new Set(["view", "t", "size", "out", "tab", "play", "mode"]);
const modes = (named.mode ?? "").split(",").filter(Boolean);
if (named.tab) page.set("view", named.tab);
if (named.play) {
  page.set("animation", named.play);
  page.set("beastPlay", named.play);
}
for (const [key, value] of Object.entries(named)) if (!reserved.has(key)) page.set(key, value);

async function serving(port) {
  try {
    return (await fetch(`http://localhost:${port}/workbench.html`)).ok;
  } catch {
    return false;
  }
}

const started = Date.now();
let server = null;
let port = 5173;
if (!(await serving(port))) {
  port = 5190 + Math.floor(Math.random() * 8);
  server = spawn(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
  for (let i = 0; i < 150 && !(await serving(port)); i++) await new Promise((r) => setTimeout(r, 200));
}

const chrome = await launchChrome(width, height);
let failed = false;
try {
  await chrome.goto(`http://localhost:${port}/workbench.html?${page}`);
  let readyFor = 0;
  for (let i = 0; readyFor < 2; i++) {
    if (i > 600) throw new Error("The preview did not come up in 3 minutes");
    await new Promise((r) => setTimeout(r, 300));
    const state = await chrome.eval(`JSON.stringify({ ready: !!window.__workbench?.shotReady?.(), issues: document.getElementById("issues")?.innerText ?? "" })`).catch(() => "{}");
    const { ready, issues } = JSON.parse(state);
    if (issues) throw new Error(`The workbench says:\n${issues}`);
    readyFor = ready ? readyFor + 1 : 0;
  }
  const title = `${asset}  seed ${named.seed ?? "default"}${named.mode ? `  mode ${named.mode}` : ""}${named.play ? `  play ${named.play}` : ""}`;
  const url = await chrome.eval(`__workbench.shoot(${JSON.stringify({ views, times, modes, width, height, title })})`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
  console.log(`${out}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  if (chrome.logs.length) console.log(chrome.logs.join("\n"));
  chrome.close();
  server?.kill();
}
process.exit(failed ? 1 : 0);
