// The music page (music.html): composes a song from a style and two seeds, plays it, and shows it
// as a song overview, a piano roll and a tracker grid, with a mixer and every instrument to try.
// Not tied to the game. See MUSIC.md.

import { composeSong } from "../music/composer";
import { cellText, effectsText, noteText, volumeText } from "../music/format";
import { createInstruments, zoneFor, type Instrument } from "../music/instruments";
import { Player } from "../music/player";
import { songNotes, songRows, type Song } from "../music/song";
import { STYLES } from "../music/styles";
import { noteName } from "../music/theory";

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const styleSelect = element<HTMLSelectElement>("style");
const placeInput = element<HTMLInputElement>("place");
const visitInput = element<HTMLInputElement>("visit");
const continuous = element<HTMLInputElement>("continuous");
const gapInput = element<HTMLInputElement>("gap");
const nextSelect = element<HTMLSelectElement>("next");
const statusLabel = element<HTMLElement>("status");
const roll = element<HTMLCanvasElement>("roll");
const grid = element<HTMLTableElement>("grid");
const gridWrap = element<HTMLElement>("gridWrap");
const overview = element<HTMLElement>("overview");

const CHANNEL_COLORS = ["#e7c26a", "#d98a5f", "#7fa7d9", "#6f97cc", "#5f87bf", "#4f6fa8", "#a8c47a", "#c9a3d9", "#8fc4b8"];

const instruments = createInstruments();
const shorts = Object.fromEntries(Object.values(instruments).map((i) => [i.id, i.short]));
let player: Player | undefined;
let song: Song;
let viewPattern = 0;
let follow = true;
let gapTimer: number | undefined;
const muted: boolean[] = [];
const soloed: boolean[] = [];

const randomSeed = (): number => Math.floor(Math.random() * 100000);

for (const style of STYLES) styleSelect.add(new Option(style.name, style.id));
const params = new URLSearchParams(location.search);
placeInput.value = params.get("place") ?? String(randomSeed());
visitInput.value = params.get("visit") ?? "1";
if (params.get("style")) styleSelect.value = params.get("style")!;

function ensurePlayer(): Player {
  if (!player) {
    player = new Player(new AudioContext(), instruments);
    player.onEnd = onSongEnd;
    applyGains();
  }
  void player.ctx.resume();
  return player;
}

function compose(): void {
  const style = STYLES.find((s) => s.id === styleSelect.value) ?? STYLES[0];
  song = composeSong(style, Number(placeInput.value) || 0, Number(visitInput.value) || 0);
  history.replaceState(null, "", `?style=${style.id}&place=${song.placeSeed}&visit=${song.visitSeed}`);
  viewPattern = 0;
  renderSummary();
  renderOverview();
  renderChannels();
  renderGrid();
  drawRoll();
}

function play(): void {
  window.clearTimeout(gapTimer);
  statusLabel.textContent = "";
  follow = true;
  ensurePlayer().play(song);
}

function stop(): void {
  window.clearTimeout(gapTimer);
  statusLabel.textContent = "";
  player?.stop();
}

function onSongEnd(): void {
  if (!continuous.checked) return;
  let left = Math.max(0, Number(gapInput.value) || 0);
  const countdown = (): void => {
    if (left <= 0) {
      if (nextSelect.value === "place") placeInput.value = String(randomSeed());
      else visitInput.value = String((Number(visitInput.value) || 0) + 1);
      compose();
      play();
      return;
    }
    statusLabel.textContent = `silence… next piece in ${left} s`;
    left--;
    gapTimer = window.setTimeout(countdown, 1000);
  };
  countdown();
}

// ---------------------------------------------------------------------------------------------

function renderSummary(): void {
  const s = song.summary;
  const seconds = Math.round((songRows(song) * 60) / (song.bpm * song.rowsPerBeat));
  element("summary").innerHTML =
    Object.entries(s)
      .map(([k, v]) => `<span>${k} <b>${v}</b></span>`)
      .join("") + `<span>length <b>${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}</b></span>`;
}

function renderOverview(): void {
  overview.innerHTML = "";
  song.patterns.forEach((p, i) => {
    const div = document.createElement("div");
    div.innerHTML = `${p.section}<small>${p.chords.map((c) => c.name).join(" ")}</small>`;
    div.onclick = () => showPattern(i, false);
    overview.append(div);
  });
  markOverview(-1);
}

function markOverview(now: number): void {
  [...overview.children].forEach((div, i) => {
    div.classList.toggle("view", i === viewPattern);
    div.classList.toggle("now", i === now);
  });
}

function showPattern(index: number, following: boolean): void {
  follow = following;
  if (index === viewPattern) return;
  viewPattern = index;
  renderGrid();
  markOverview(player?.position()?.pattern ?? -1);
}

let gridRows: HTMLTableRowElement[] = [];

function renderGrid(): void {
  const pattern = song.patterns[viewPattern];
  const head = `<tr><th></th>${song.channels.map((c) => `<th style="color:${CHANNEL_COLORS[song.channels.indexOf(c)]}">${c.name}</th>`).join("")}</tr>`;
  const rows: string[] = [];
  const barRows = song.beatsPerBar * song.rowsPerBeat;
  for (let r = 0; r < pattern.rows; r++) {
    const cls = r % barRows === 0 && r > 0 ? "bar beat" : r % song.rowsPerBeat === 0 ? "beat" : "";
    const tds = pattern.cells[r].map((cell) => {
      if (!cell) return `<td class="e">... .. .. </td>`;
      const inst = cell.instrument ? shorts[cell.instrument] : "..";
      return `<td title="${cellText(cell, shorts)}"><span class="${cell.note !== undefined ? "n" : "e"}">${noteText(cell)}</span> ${inst} ${volumeText(cell)} <span class="x">${effectsText(cell)}</span></td>`;
    });
    rows.push(`<tr class="${cls}"><td class="row">${String(r).padStart(2, "0")}</td>${tds.join("")}</tr>`);
  }
  grid.innerHTML = head + rows.join("");
  gridRows = [...grid.querySelectorAll<HTMLTableRowElement>("tr")].slice(1);
}

function renderChannels(): void {
  const box = element("channels");
  box.innerHTML = "";
  song.channels.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "channel";
    row.innerHTML = `<span class="swatch" style="background:${CHANNEL_COLORS[i]}"></span><span>${c.name} <small>${c.role}</small></span>`;
    const mute = document.createElement("button");
    mute.textContent = "M";
    mute.title = "Mute";
    mute.classList.toggle("on", !!muted[i]);
    mute.onclick = () => {
      muted[i] = !muted[i];
      mute.classList.toggle("on", muted[i]);
      applyGains();
    };
    const solo = document.createElement("button");
    solo.textContent = "S";
    solo.title = "Solo";
    solo.classList.toggle("on", !!soloed[i]);
    solo.onclick = () => {
      soloed[i] = !soloed[i];
      solo.classList.toggle("on", soloed[i]);
      applyGains();
    };
    row.append(mute, solo);
    box.append(row);
  });
}

function applyGains(): void {
  if (!player) return;
  const anySolo = soloed.some(Boolean);
  for (let i = 0; i < CHANNEL_COLORS.length; i++) player.setChannelGain(i, (anySolo ? soloed[i] : !muted[i]) ? 1 : 0);
}

function renderInstruments(): void {
  const box = element("instruments");
  for (const inst of Object.values(instruments)) {
    const div = document.createElement("div");
    div.className = "instrument";
    const env = inst.envelope;
    const looped = inst.zones.some((z) => z.loop);
    div.innerHTML =
      `<div class="title"><b>${inst.name}</b><small>${inst.short} · ${inst.id}</small></div>` +
      `<small>${inst.zones.length} zone${inst.zones.length > 1 ? "s" : ""}${looped ? ", looped" : ", one-shot"} · A ${env.attack}s D ${env.decay}s S ${env.sustain} R ${env.release}s` +
      `${inst.autoVibrato ? ` · vibrato ${inst.autoVibrato.depth}¢` : ""}</small>`;
    const canvas = document.createElement("canvas");
    div.append(canvas);
    const keys = document.createElement("div");
    keys.className = "keys";
    const notes = inst.keys ? Object.entries(inst.keys) : keyboardNotes(inst).map((n) => [noteName(n), n] as const);
    for (const [label, note] of notes) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => {
        ensurePlayer().audition(inst.id, note, inst.keys ? 0.5 : 1.2);
        drawWave(canvas, inst, note);
      };
      keys.append(b);
    }
    div.append(keys);
    box.append(div);
    requestAnimationFrame(() => drawWave(canvas, inst, notes[Math.floor(notes.length / 2)][1]));
  }
}

/** The natural notes over about two octaves in the middle of an instrument's range. */
function keyboardNotes(inst: Instrument): number[] {
  const middle = Math.round((inst.range[0] + inst.range[1]) / 2);
  const out: number[] = [];
  for (let n = Math.max(inst.range[0], middle - 12); n <= Math.min(inst.range[1], middle + 12); n++) if (![1, 3, 6, 8, 10].includes(n % 12)) out.push(n);
  return out;
}

function drawWave(canvas: HTMLCanvasElement, inst: Instrument, note: number): void {
  const zone = zoneFor(inst, note);
  const dpr = devicePixelRatio;
  const w = (canvas.width = canvas.clientWidth * dpr);
  const h = (canvas.height = canvas.clientHeight * dpr);
  const g = canvas.getContext("2d")!;
  const data = zone.data;
  if (zone.loop) {
    g.fillStyle = "rgba(111,168,199,0.15)";
    const x0 = (zone.loop.start * zone.sampleRate * w) / data.length;
    const x1 = (zone.loop.end * zone.sampleRate * w) / data.length;
    g.fillRect(x0, 0, x1 - x0, h);
  }
  g.fillStyle = inst.color;
  const per = data.length / w;
  for (let x = 0; x < w; x++) {
    let lo = 0;
    let hi = 0;
    for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) {
      lo = Math.min(lo, data[i]);
      hi = Math.max(hi, data[i]);
    }
    g.fillRect(x, h / 2 - (hi * h) / 2, 1, Math.max(1, ((hi - lo) * h) / 2));
  }
  g.fillStyle = "#8d9aa8";
  g.font = `${10 * dpr}px system-ui`;
  g.fillText(`zone ${noteName(Math.round(zone.root))} (${noteName(zone.low)}–${noteName(zone.high)})${zone.loop ? " · loop shaded" : ""}`, 4 * dpr, 12 * dpr);
}

// ---------------------------------------------------------------------------------------------
// Piano roll: the whole song, pitched channels above, drum lanes below.

const LANE = 9;
let rollNotes: ReturnType<typeof songNotes> = [];

function drawRoll(playRow = -1): void {
  const dpr = devicePixelRatio;
  const w = (roll.width = roll.clientWidth * dpr);
  const h = (roll.height = roll.clientHeight * dpr);
  const g = roll.getContext("2d")!;
  if (playRow < 0) rollNotes = songNotes(song);
  const total = songRows(song);
  const xOf = (row: number): number => (row / total) * w;
  const drums = song.channels.map((c, i) => (c.role === "percussion" ? i : -1)).filter((i) => i >= 0);
  const drumTop = h - drums.length * LANE * dpr - 4 * dpr;
  const pitched = rollNotes.filter((n) => !drums.includes(n.channel));
  const lo = Math.min(...pitched.map((n) => n.note)) - 2;
  const hi = Math.max(...pitched.map((n) => n.note)) + 2;
  const yOf = (note: number): number => 16 * dpr + ((hi - note) / (hi - lo)) * (drumTop - 22 * dpr);
  const step = (drumTop - 22 * dpr) / (hi - lo);

  g.fillStyle = "#13171c";
  g.fillRect(0, 0, w, h);
  for (let n = lo; n <= hi; n++) if (n % 12 === 0) {
    g.fillStyle = "#1f262e";
    g.fillRect(0, yOf(n), w, 1);
  }
  let base = 0;
  g.font = `${10 * dpr}px system-ui`;
  song.patterns.forEach((p, i) => {
    g.fillStyle = i === viewPattern ? "rgba(111,168,199,0.07)" : "transparent";
    g.fillRect(xOf(base), 0, xOf(p.rows), h);
    g.fillStyle = "#333e4b";
    g.fillRect(xOf(base), 0, 1, h);
    g.fillStyle = "#8d9aa8";
    g.fillText(p.section, xOf(base) + 4 * dpr, 11 * dpr);
    base += p.rows;
  });
  for (const n of rollNotes) {
    g.globalAlpha = 0.35 + 0.65 * Math.min(1, n.volume / 0.6);
    g.fillStyle = CHANNEL_COLORS[n.channel];
    const lane = drums.indexOf(n.channel);
    if (lane >= 0) g.fillRect(xOf(n.start), drumTop + lane * LANE * dpr + 1, Math.max(2 * dpr, xOf(1)), (LANE - 2) * dpr);
    else g.fillRect(xOf(n.start), yOf(n.note) - step / 2, Math.max(1, xOf(n.end - n.start) - 1), Math.max(2 * dpr, step - 1));
  }
  g.globalAlpha = 1;
  if (playRow >= 0) {
    g.fillStyle = "#ffffff";
    g.fillRect(xOf(playRow), 0, Math.max(1, dpr), h);
  }
}

roll.onclick = (e) => {
  const row = (e.offsetX / roll.clientWidth) * songRows(song);
  let base = 0;
  for (let i = 0; i < song.patterns.length; i++) {
    if (row < base + song.patterns[i].rows) return showPattern(i, false), drawRoll();
    base += song.patterns[i].rows;
  }
};

// ---------------------------------------------------------------------------------------------

let lastKey = "";
function frame(): void {
  const position = player?.playing ? player.position() : undefined;
  const key = position ? `${position.pattern}:${position.row}` : "";
  if (key !== lastKey) {
    lastKey = key;
    if (position && follow && position.pattern !== viewPattern) showPattern(position.pattern, true);
    gridRows.forEach((tr, r) => tr.classList.toggle("now", !!position && position.pattern === viewPattern && r === position.row));
    if (position && position.pattern === viewPattern && follow) {
      const tr = gridRows[position.row];
      gridWrap.scrollTop = tr.offsetTop - gridWrap.clientHeight / 2;
    }
    markOverview(position?.pattern ?? -1);
    let playRow = -1;
    if (position) playRow = song.patterns.slice(0, position.pattern).reduce((s, p) => s + p.rows, 0) + position.row;
    drawRoll(playRow);
  }
  requestAnimationFrame(frame);
}

element("play").onclick = play;
element("stop").onclick = stop;
element("newPlace").onclick = () => {
  placeInput.value = String(randomSeed());
  compose();
};
element("newVisit").onclick = () => {
  visitInput.value = String((Number(visitInput.value) || 0) + 1);
  compose();
};
placeInput.onchange = visitInput.onchange = styleSelect.onchange = compose;
addEventListener("resize", () => drawRoll());

compose();
renderInstruments();
requestAnimationFrame(frame);

(window as unknown as { __music: unknown }).__music = { get song() { return song; }, get player() { return player; }, instruments };
