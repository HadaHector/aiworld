// Logging out in a lair and in again, the way a player does it, in a real (headless) browser - the path
// lairSave.mjs (the server alone) cannot see: the menu makes a world and a character, `/dungeon cave`
// takes it into a lair, it exits to the menu and continues; then the page saves as a hidden tab does and
// is reloaded (a closed tab), and it continues again. Each time the character must be back in the lair,
// on its floor, with the lair drawn - not on the ground above (FRONTEND.md, *Saves*).
//   npm run probes -- lairLogin       (or: node scripts/probe/lairLogin.mjs [style=cave] [size=vale])
// It serves this checkout itself (vite on a free port 5190-5197), never 5173 or 5174, and needs Chrome
// or Edge and this checkout's node_modules (a worktree: a junction to the main checkout's).
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { launchChrome } from "../shot/cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (!existsSync(resolve(root, "node_modules/simplex-noise"))) {
  console.log("FAIL this checkout has no node_modules for vite to serve the game from (in a worktree: mklink /J node_modules <main checkout>\node_modules)");
  process.exit(1);
}
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")));
const style = args.style ?? "cave";
const size = args.size ?? "vale";

const serving = async (port) => {
  try {
    return (await fetch(`http://localhost:${port}/`)).ok;
  } catch {
    return false;
  }
};
let port = 5190 + Math.floor(Math.random() * 8);
for (let k = 0; k < 8 && (await serving(port)); k++) port = 5190 + ((port - 5190 + 1) % 8);
const vite = resolve(dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js");
const server = spawn(process.execPath, [vite, "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
for (let i = 0; i < 150 && !(await serving(port)); i++) await new Promise((r) => setTimeout(r, 200));

const wait = async (chrome, what, expression, seconds = 120) => {
  for (let i = 0; i < seconds * 5; i++) {
    if (await chrome.eval(expression).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const click = (text) => `(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.offsetParent !== null); if (!b) return false; b.click(); return true; })()`;
const hasButton = (text) => `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.offsetParent !== null)`;
// Where the own player stands, on the server, and the lair it is in (if any).
const where = `(() => {
  const s = window.__aiworld?.server?.debug;
  if (!s) return null;
  const [p] = [...s.players.values()];
  if (!p?.entity?.body) return null;
  const e = p.entity;
  const d = s.dimensions.get(e.dimension);
  const lair = d?.dungeons?.at(e.x, e.y, e.z) ?? d?.dungeons?.at(e.x, e.y + 1, e.z);
  const ground = d?.world?.heightAt ? d.world.heightAt(e.x, e.z) : null;
  return { x: +e.x.toFixed(2), y: +e.y.toFixed(2), z: +e.z.toFixed(2), ground: ground === null ? null : +ground.toFixed(2), lair: lair?.id ?? null, drawn: !!window.__aiworld.dungeon };
})()`;
const inGame = `(() => { const w = ${where}; return !!w; })()`;

const chrome = await launchChrome(1024, 700);
let failed = 0;
let left = null;
const report = (name, at, expectLair) => {
  // Back where it was left: in the lair, drawn, within a metre of the spot and under the ground's height.
  const back = !left || (Math.hypot(at.x - left.x, at.z - left.z) < 1 && Math.abs(at.y - left.y) < 1);
  const ok = !!at && (expectLair ? at.lair !== null && at.drawn && at.y < at.ground - 1 && back : true);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(at)}`);
  left ??= at;
};
try {
  await chrome.goto(`http://localhost:${port}/`);
  await wait(chrome, "the menu", hasButton("New character"));
  await chrome.eval(click("New character"));
  await wait(chrome, "the worlds screen", hasButton("Create a world"));
  await chrome.eval(click("Create a world"));
  await wait(chrome, "the world form", "!!document.querySelector('select')");
  await chrome.eval(`(() => { const s = document.querySelector("select"); s.value = ${JSON.stringify(size)}; s.dispatchEvent(new Event("change")); const i = [...document.querySelectorAll("input")]; i[0].value = "Lairs"; i[1].value = "6"; i[1].dispatchEvent(new Event("input")); })()`);
  await chrome.eval(click("Create"));
  await wait(chrome, "the characters screen", hasButton("Create character") + " || " + hasButton("Create and enter"));
  if (await chrome.eval(hasButton("Create character"))) await chrome.eval(click("Create character"));
  await wait(chrome, "the new character form", hasButton("Create and enter"));
  await chrome.eval(`(() => { const i = [...document.querySelectorAll("input")].find((i) => i.offsetParent !== null && i.maxLength > 0); i.value = "Delver"; i.dispatchEvent(new Event("input")); })()`);
  await chrome.eval(click("Create and enter"));
  await wait(chrome, "the game", inGame, 300);
  await new Promise((r) => setTimeout(r, 2000));
  console.log("entered:", JSON.stringify(await chrome.eval(where)));

  // Into a lair, by the chat's /dungeon.
  await chrome.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
  await wait(chrome, "the chat input", "document.activeElement instanceof HTMLInputElement", 10);
  await chrome.eval(`(() => { const i = document.activeElement; i.value = "/dungeon ${style}"; i.dispatchEvent(new Event("input")); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await wait(chrome, "the lair", `(${where})?.lair !== null && (${where})?.drawn`, 120);
  // A walk's worth of frames in it, so the page's own remembering runs as it does in play.
  await new Promise((r) => setTimeout(r, 4000));
  report("in the lair", await chrome.eval(where), true);

  // Log out from the game menu, and Continue from the main menu.
  await chrome.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }))`);
  await wait(chrome, "the game menu", hasButton("Exit to menu"), 10);
  await chrome.eval(click("Exit to menu"));
  await wait(chrome, "the main menu", hasButton("Continue"), 30);
  await chrome.eval(click("Continue"));
  await wait(chrome, "the game again", inGame, 300);
  await wait(chrome, "the lair drawn", `(${where})?.drawn`, 90).catch((e) => console.log(e.message));
  await new Promise((r) => setTimeout(r, 2000));
  report("logged out and continued", await chrome.eval(where), true);

  // As a closed tab: the page told it is hidden (it saves then), and reloaded, with no logout between.
  await chrome.eval(`(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); })()`);
  await new Promise((r) => setTimeout(r, 2500));
  await chrome.send("Page.reload", {});
  await wait(chrome, "the main menu after a reload", hasButton("Continue"), 60);
  await chrome.eval(click("Continue"));
  await wait(chrome, "the game after a reload", inGame, 300);
  await wait(chrome, "the lair drawn", `(${where})?.drawn`, 90).catch((e) => console.log(e.message));
  await new Promise((r) => setTimeout(r, 2000));
  report("reloaded and continued", await chrome.eval(where), true);
} catch (error) {
  failed++;
  console.error(error.message);
} finally {
  if (chrome.logs.length) console.log(chrome.logs.slice(-15).join("\n"));
  chrome.close();
  server.kill();
}
process.exitCode = failed ? 1 : 0;
