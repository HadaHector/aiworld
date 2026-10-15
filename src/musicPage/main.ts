// The music page (music.html): composes a song from a style and two seeds, plays it, and shows it
// as a song overview, a piano roll and a tracker grid, with a mixer and every instrument to try.
// Not tied to the game. See MUSIC.md.

import { composeSong } from "../music/composer";
import { cellText, effectsText, noteText, volumeText } from "../music/format";
import { createInstruments, zoneFor, type Instrument, type SampleZone } from "../music/instruments";
import { Player, type PlayPosition } from "../music/player";
import { parseXi } from "../music/xi";
import { songNotes, songRows, type Song } from "../music/song";
import { SHARED_SOUNDS, STYLE_SOUNDS } from "../music/sounds";
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
const inUse = element<HTMLInputElement>("inUse");

const CHANNEL_COLORS = ["#e7c26a", "#d98a5f", "#7fa7d9", "#6f97cc", "#5f87bf", "#4f6fa8", "#a8c47a", "#c9a3d9", "#8fc4b8", "#9fe0e6", "#d8c8ec", "#b0bcc8", "#e0a0a0", "#e8c9a0"];

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
  setPaused(false);
  return player;
}

/**
 * Pausing suspends the audio clock itself: everything scheduled waits, and carries on from the
 * same point when it runs again. Playing, stopping or trying an instrument resumes it.
 */
let paused = false;
const pauseButton = element<HTMLButtonElement>("pause");
function setPaused(on: boolean): void {
  paused = on;
  pauseButton.textContent = on ? "⏯ Resume" : "⏸ Pause";
  pauseButton.classList.toggle("on", on);
  if (!player) return;
  if (on) void player.ctx.suspend();
  else void player.ctx.resume();
}
pauseButton.onclick = () => {
  if (player?.playing) setPaused(!paused);
};

// Space: play when stopped, pause when playing, resume when paused - unless typing in a field.
addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat) return;
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox") return;
  if (target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
  // Also keeps a focused button from being clicked by the same key.
  e.preventDefault();
  if (player?.playing) setPaused(!paused);
  else play();
});

/** Composes the song for the style and seeds shown; if one was playing, the new one plays instead. */
function compose(): void {
  const wasPlaying = player?.playing ?? false;
  const style = STYLES.find((s) => s.id === styleSelect.value) ?? STYLES[0];
  song = composeSong(style, Number(placeInput.value) || 0, Number(visitInput.value) || 0);
  history.replaceState(null, "", `?style=${style.id}&place=${song.placeSeed}&visit=${song.visitSeed}`);
  // A new style brings its own instrument picks: play once they are in place.
  const ready = style.id !== soundsStyle ? useStyleSounds(style.id) : Promise.resolve();
  if (wasPlaying) void ready.then(() => play());
  viewPattern = 0;
  renderSummary();
  renderOverview();
  renderChannels();
  renderGrid();
  drawRoll();
  if (inUse.checked) renderInstruments();
}

function play(from?: PlayPosition): void {
  window.clearTimeout(gapTimer);
  statusLabel.textContent = "";
  follow = true;
  ensurePlayer().play(song, from);
}

/** A click jumps there while playing; a double click plays from there. Otherwise it only shows it. */
function goTo(from: PlayPosition, start: boolean): void {
  if (start || player?.playing) play(from);
  else showPattern(from.pattern, false);
}

function stop(): void {
  window.clearTimeout(gapTimer);
  statusLabel.textContent = "";
  if (player) setPaused(false);
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
    div.onclick = () => goTo({ pattern: i, row: 0 }, false);
    div.ondblclick = () => goTo({ pattern: i, row: 0 }, true);
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
  for (let i = 0; i < Math.max(song.channels.length, muted.length, soloed.length); i++) player.setChannelGain(i, (anySolo ? soloed[i] : !muted[i]) ? 1 : 0);
}

// Sounds: each instrument is its synth stand-in or a sample instrument from the local library
// (public/samples/, gitignored; index.json lists it by role). The choice is kept per browser.

const synths: Record<string, Instrument> = { ...instruments };
/** Roles with no synth, only library sounds. */
const EXTRA_LOOKS: Record<string, { name: string; short: string; color: string; gain: number; range: [number, number] }> = {};
const LIBRARY = "/samples/kiarchive/";
/** Library folders an instrument may pick from besides its own. */
const LIBRARY_ALIASES: Record<string, string[]> = {
  ney: ["flute"],
  oud: ["guitar"],
  darbuka: ["frameDrum"],
  timpani: ["lowDrum"],
  stringsLow: ["bass", "strings"],
  stringsHigh: ["strings"],
  pizz: ["harp", "guitar"],
  clarinet: ["ney"],
  drip: ["nature"],
  ghost: ["atmosphere", "choir"],
  wind: ["atmosphere"],
  violin: ["stringsHigh", "strings"],
  clap: ["claps"],
  choirHigh: ["choir"],
  spiccato: ["strings", "pizz"],
  marimba: ["musicBox", "bells"],
  marimbaBass: ["marimba", "musicBox"],
  lowDrum: ["congas", "darbuka", "knock"],
  bird: ["nature"],
  shaker: ["shakers", "tambourine"],
  mandolin: ["oud", "guitar"],
  pipes: ["accordion", "clarinet"],
  castanets: ["knock", "shakers"],
  taiko: ["lowDrum", "frameDrum"],
  choirLow: ["choir"],
};
/** Where single drum strokes for a kit are picked from. */
const DRUM_FOLDERS = ["darbuka", "frameDrum", "tambourine", "lowDrum", "knock", "congas", "shakers", "claps"];
/** Picks are kept per style: { styleId: { instrument or "id:stroke": library path or "" } }. */
const SOUNDS_KEY = "aiworld.music.soundsByStyle";
/** Before that, one set of picks for every style: it becomes each style's starting point. */
const LEGACY_SOUNDS_KEY = "aiworld.music.sounds";
let library: Record<string, string[]> = {};
const soundsByStyle: Record<string, Record<string, string>> = ((): Record<string, Record<string, string>> => {
  try {
    const byStyle = JSON.parse(localStorage.getItem(SOUNDS_KEY) ?? "null");
    if (byStyle) return byStyle;
    const shared = JSON.parse(localStorage.getItem(LEGACY_SOUNDS_KEY) ?? "{}");
    return Object.fromEntries(STYLES.map((s) => [s.id, { ...shared }]));
  } catch {
    return {};
  }
})();
/** The style whose picks `sounds` holds. */
let soundsStyle = styleSelect.value || STYLES[0].id;
/** The current style's choices by instrument id; a drum's strokes by "id:stroke". "" means the synth. */
const sounds: Record<string, string> = { ...SHARED_SOUNDS, ...STYLE_SOUNDS[soundsStyle], ...soundsByStyle[soundsStyle] };

function saveSounds(): void {
  soundsByStyle[soundsStyle] = { ...sounds };
  try {
    localStorage.setItem(SOUNDS_KEY, JSON.stringify(soundsByStyle));
  } catch {
    // Private mode: the choice lasts this visit only.
  }
}

/** Another style: its own picks replace the last one's, and every instrument is put together again. */
async function useStyleSounds(styleId: string): Promise<void> {
  if (styleId === soundsStyle) return;
  soundsStyle = styleId;
  for (const key of Object.keys(sounds)) delete sounds[key];
  Object.assign(sounds, SHARED_SOUNDS, STYLE_SOUNDS[styleId], soundsByStyle[styleId]);
  for (const id of new Set([...Object.keys(synths), ...Object.keys(instruments)])) {
    try {
      await buildInstrument(id);
    } catch (e) {
      console.warn("music: could not load sounds for", id, e);
    }
  }
  renderInstruments();
}

const strokeKey = (id: string, stroke: string): string => `${id}:${stroke}`;
const choicesFor = (id: string): string[] => [id, ...(LIBRARY_ALIASES[id] ?? [])].flatMap((folder) => library[folder] ?? []);
const strokeChoices = (): string[] => DRUM_FOLDERS.flatMap((folder) => library[folder] ?? []);
const available = (path: string | undefined): path is string => !!path && Object.values(library).some((files) => files.includes(path));
const fileLabel = (path: string): string => path.replace(/\.xi$/, "");

const files = new Map<string, Promise<ArrayBuffer>>();
function fetchXi(path: string): Promise<ArrayBuffer> {
  let file = files.get(path);
  if (!file) {
    file = fetch(LIBRARY + path).then((r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return r.arrayBuffer();
    });
    files.set(path, file);
  }
  return file;
}

/** One drum stroke on one key: the file's sample as it sounds on C-4, never looping, faded at its end. */
function strokeZone(zone: SampleZone, note: number): SampleZone {
  let data = zone.data;
  if (zone.loop) {
    data = data.slice(0, Math.floor(zone.loop.end * zone.sampleRate));
    const fade = Math.min(data.length, Math.floor(0.02 * zone.sampleRate));
    for (let i = 0; i < fade; i++) data[data.length - fade + i] *= 1 - i / fade;
  }
  return { ...zone, data, loop: undefined, low: note, high: note, root: zone.root + note - 60 };
}

/**
 * Puts an instrument together from its choices: its sound (a library file or the synth) and, for a
 * drum, a file for any stroke picked on its own, laid over that stroke's key.
 */
async function buildInstrument(id: string): Promise<void> {
  const look = synths[id] ?? EXTRA_LOOKS[id];
  let inst: Instrument | undefined = synths[id];
  const path = sounds[id];
  if (available(path)) {
    inst = parseXi(await fetchXi(path), id, { short: look.short, color: look.color, gain: look.gain });
    inst.range = look.range;
    if (synths[id]?.keys) inst.keys = synths[id].keys;
  }
  const strokes = synths[id]?.keys;
  if (inst && strokes) {
    const zones: SampleZone[] = [];
    for (const [stroke, note] of Object.entries(strokes)) {
      const strokePath = sounds[strokeKey(id, stroke)];
      if (!available(strokePath)) continue;
      const xi = parseXi(await fetchXi(strokePath), id, { short: look.short, color: look.color, gain: 1 });
      zones.push(strokeZone(zoneFor(xi, 60), note));
    }
    if (zones.length) inst = { ...inst, zones: [...zones, ...inst.zones] };
  }
  if (inst) instruments[id] = inst;
  else delete instruments[id];
}

async function loadLibrary(): Promise<void> {
  try {
    const response = await fetch(LIBRARY + "index.json");
    if (response.ok) library = (await response.json()).roles ?? {};
  } catch {
    library = {};
  }
  // Without the library (it is not in git) every instrument stays its synth.
  const ids = new Set(Object.keys(sounds).map((key) => key.split(":")[0]));
  for (const id of ids) {
    try {
      await buildInstrument(id);
    } catch (e) {
      console.warn("music: could not load sounds for", id, e);
    }
  }
}

/** The instruments the song's cells name. */
function songInstruments(): Set<string> {
  const ids = new Set<string>();
  for (const pattern of song.patterns) for (const row of pattern.cells) for (const cell of row) if (cell?.instrument) ids.add(cell.instrument);
  return ids;
}

function renderInstruments(): void {
  const box = element("instruments");
  box.innerHTML = "";
  const used = inUse.checked ? songInstruments() : undefined;
  const ids = [...Object.keys(synths), ...Object.keys(EXTRA_LOOKS).filter((id) => library[id]?.length)].filter((id) => !used || used.has(id));
  for (const id of ids) {
    const div = document.createElement("div");
    div.className = "instrument";
    box.append(div);
    renderInstrument(div, id);
  }
}

/** A dropdown over library files that stores its pick under `key` and rebuilds the instrument. */
function soundPicker(div: HTMLElement, id: string, key: string, first: string, choices: string[], label = (path: string) => path.split("/").pop()!.replace(/\.xi$/, "")): HTMLSelectElement {
  const select = document.createElement("select");
  select.add(new Option(first, ""));
  for (const path of choices) select.add(new Option(label(path), path));
  select.value = available(sounds[key]) ? sounds[key] : "";
  select.onchange = async () => {
    select.disabled = true;
    sounds[key] = select.value;
    try {
      await buildInstrument(id);
    } catch (e) {
      console.warn("music: could not load", select.value, e);
    }
    saveSounds();
    renderInstrument(div, id);
  };
  return select;
}

function renderInstrument(div: HTMLElement, id: string): void {
  const inst = instruments[id] as (Instrument & { xi?: { name: string; samples: number } }) | undefined;
  const look = synths[id] ?? EXTRA_LOOKS[id];
  div.innerHTML = `<div class="title"><b>${look.name}</b><small>${look.short} · ${id}</small></div>`;

  const choices = choicesFor(id);
  if (choices.length) {
    const select = soundPicker(div, id, id, synths[id] ? "Synth stand-in" : "None", choices, choices.some((c) => !c.startsWith(id + "/")) ? fileLabel : undefined);
    select.style.margin = "4px 0";
    div.append(select);
  }
  // A drum kit: each stroke may come from its own file.
  const strokes = synths[id]?.keys;
  if (strokes && inst && strokeChoices().length) {
    for (const stroke of Object.keys(strokes)) {
      const row = document.createElement("label");
      row.className = "stroke";
      row.textContent = stroke;
      row.append(soundPicker(div, id, strokeKey(id, stroke), "from the sound above", strokeChoices(), fileLabel));
      div.append(row);
    }
  }
  if (!inst) {
    div.insertAdjacentHTML("beforeend", `<small>Pick a sound to hear it.</small>`);
    return;
  }
  const env = inst.envelope;
  const looped = inst.zones.some((z) => z.loop);
  const shape = inst.volumeEnvelope ? `envelope ${inst.volumeEnvelope.points.length} points, release ${env.release.toFixed(2)}s` : `A ${env.attack}s D ${env.decay}s S ${env.sustain} R ${env.release}s`;
  div.insertAdjacentHTML(
    "beforeend",
    `<small>${inst.xi ? `"${inst.xi.name}" · ` : ""}${inst.zones.length} zone${inst.zones.length > 1 ? "s" : ""}${looped ? ", looped" : ", one-shot"} · ${shape}` +
      `${inst.autoVibrato ? ` · vibrato ${inst.autoVibrato.depth}¢` : ""}</small>`,
  );
  const canvas = document.createElement("canvas");
  div.append(canvas);
  const keys = document.createElement("div");
  keys.className = "keys";
  const notes = inst.keys ? Object.entries(inst.keys) : keyboardNotes(inst).map((n) => [noteName(n), n] as const);
  for (const [label, note] of notes) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      ensurePlayer().audition(id, note, inst.keys ? 0.5 : 1.2);
      drawWave(canvas, inst, note);
    };
    keys.append(b);
  }
  div.append(keys);
  requestAnimationFrame(() => drawWave(canvas, inst, notes[Math.floor(notes.length / 2)][1]));
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
    const k = zone.gain ?? 1;
    g.fillRect(x, h / 2 - (hi * k * h) / 2, 1, Math.max(1, ((hi - lo) * k * h) / 2));
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

/** The bar under a point of the piano roll. */
function rollPosition(x: number): PlayPosition {
  const row = Math.floor((x / roll.clientWidth) * songRows(song));
  const barRows = song.beatsPerBar * song.rowsPerBeat;
  let base = 0;
  for (let i = 0; i < song.patterns.length; i++) {
    if (row < base + song.patterns[i].rows) return { pattern: i, row: Math.floor((row - base) / barRows) * barRows };
    base += song.patterns[i].rows;
  }
  return { pattern: song.patterns.length - 1, row: 0 };
}
roll.onclick = (e) => {
  goTo(rollPosition(e.offsetX), false);
  drawRoll();
};
roll.ondblclick = (e) => goTo(rollPosition(e.offsetX), true);
roll.title = overview.title = "Click: show it, or jump there while playing. Double-click: play from there.";

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

element("play").onclick = () => play();
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
try {
  inUse.checked = localStorage.getItem("aiworld.music.inUse") === "1";
} catch {
  // No storage: starts unticked.
}
inUse.onchange = () => {
  try {
    localStorage.setItem("aiworld.music.inUse", inUse.checked ? "1" : "0");
  } catch {
    // No storage: the choice lasts this visit.
  }
  renderInstruments();
};
addEventListener("resize", () => drawRoll());

compose();
renderInstruments();
void loadLibrary().then(renderInstruments);
requestAnimationFrame(frame);

(window as unknown as { __music: unknown }).__music = { get song() { return song; }, get player() { return player; }, instruments, sounds };
