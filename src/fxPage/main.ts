// The feedback dev page (fx.html, see FEEDBACK.md, *Dev page*): every sound and cue in the packs,
// played on its own, from a distance and an angle the sliders set, to hear and tune it. The page
// reloads on every pack edit, keeping what was selected.

import { whenAudio } from "../audio/context";
import { createSfx, type Sfx, type Vec3 } from "../audio/sfx";
import { createCuePlayer, type CuePlayer, type UnitTraits } from "../feedback/cues";
import { PLACEHOLDERS, resolveFeedback, type FeedbackRules, type SoundDef } from "../feedback/rules";
import { resolveCreatureRules } from "../sim/rules/creatureRules";
import { resolveGameRules, type GameRules } from "../sim/rules/gameRules";
import { ContentError, formatIssue } from "../world/content/contentReader";
import { configNameFromUrl, fetchPackSources, fetchWorldConfig } from "../world/content/loadContent";
import { WORLD_SEED } from "../world/worldData";
import type { RenderedSound } from "../audio/synth";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const list = $<HTMLDivElement>("list");
const detail = $<HTMLDivElement>("detail");
const distance = $<HTMLInputElement>("distance");
const angle = $<HTMLInputElement>("angle");
const volume = $<HTMLInputElement>("volume");
const status = $<HTMLSpanElement>("status");

let game: GameRules;
let rules: FeedbackRules;
try {
  const config = await fetchWorldConfig(configNameFromUrl());
  const packs = await fetchPackSources(undefined, config);
  game = resolveGameRules(packs);
  resolveCreatureRules(packs, game, WORLD_SEED);
  rules = resolveFeedback(packs, game);
} catch (error) {
  detail.innerHTML = `<p class="error"></p>`;
  detail.querySelector("p")!.textContent = error instanceof ContentError ? error.issues.map(formatIssue).join("\n") : String(error);
  throw error;
}

// --- where things are heard from -----------------------------------------------------------------
// The listener stands at the origin looking along +z; the sound (and a cue's target) stands at the
// distance and angle the sliders give, its source beside the listener.
const SOURCE = 1;
const TARGET = 2;
const where = (): Vec3 => {
  const d = Number(distance.value);
  const a = (Number(angle.value) * Math.PI) / 180;
  return { x: Math.sin(a) * d, y: 0, z: Math.cos(a) * d };
};
const showSliders = (): void => {
  $("distanceOut").textContent = `${distance.value} m`;
  $("angleOut").textContent = `${angle.value}°`;
};
distance.addEventListener("input", showSliders);
angle.addEventListener("input", showSliders);
showSliders();

// --- audio -------------------------------------------------------------------------------------
let sfx: Sfx | null = null;
whenAudio((audio) => {
  sfx = createSfx(audio.ctx, audio.effects, rules, (sound, file) => `${import.meta.env.BASE_URL}packs/${sound.file.split("/")[0]}/${file}`);
  sfx.setListener({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
  sfx.setVolume((Number(volume.value) / 100) ** 2);
  status.textContent = "";
  render();
});
volume.addEventListener("input", () => sfx?.setVolume((Number(volume.value) / 100) ** 2));
$("stop").addEventListener("click", () => sfx?.stopAll());
setInterval(() => ($("voices").textContent = String(sfx?.voices() ?? 0)), 100);

/** Placeholders the cues panel fills: what the source hits with, what the target is made of. */
const traits: Record<"source" | "target", UnitTraits> = { source: { weapon: "blade" }, target: { armor: "flesh", family: "humanoid" } };
const flags = { crit: false, periodic: false, own: true };
const cues: CuePlayer = createCuePlayer(
  rules,
  game,
  {
    player: () => (flags.own ? SOURCE : 0),
    target: () => 0,
    targetOf: () => 0,
    place: (unit, bone) => {
      const p = unit === SOURCE ? { x: 0.6, y: 0, z: 0.3 } : where();
      return { x: p.x, y: p.y + (bone === "head" ? 1.7 : bone === "feet" ? 0.05 : 1.2), z: p.z };
    },
    traits: (unit) => (unit === SOURCE ? traits.source : traits.target),
  },
  () => sfx,
);

// --- the list ------------------------------------------------------------------------------------
type Tab = "sounds" | "cues";
const state = { tab: (location.hash.match(/tab=(\w+)/)?.[1] as Tab) ?? "sounds", selected: decodeURIComponent(location.hash.match(/id=([^&]+)/)?.[1] ?? ""), filter: "" };
const remember = (): void => history.replaceState(null, "", `#tab=${state.tab}&id=${encodeURIComponent(state.selected)}`);

function render(): void {
  list.innerHTML = "";
  const tabs = document.createElement("div");
  tabs.className = "tabs";
  for (const tab of ["sounds", "cues"] as const) {
    const b = document.createElement("button");
    b.textContent = tab === "sounds" ? `Sounds (${rules.sounds.size})` : `Cues (${rules.cues.size})`;
    b.className = state.tab === tab ? "on" : "";
    b.onclick = () => {
      state.tab = tab;
      state.selected = "";
      remember();
      render();
    };
    tabs.append(b);
  }
  const filter = document.createElement("input");
  filter.placeholder = "Filter";
  filter.value = state.filter;
  filter.oninput = () => {
    state.filter = filter.value;
    renderItems();
  };
  const items = document.createElement("div");
  list.append(tabs, filter, items);
  const renderItems = (): void => {
    items.innerHTML = "";
    const ids = [...(state.tab === "sounds" ? rules.sounds.keys() : rules.cues.keys())].filter((id) => id.toLowerCase().includes(state.filter.toLowerCase()));
    for (const id of ids) {
      const row = document.createElement("div");
      row.className = `item${id === state.selected ? " selected" : ""}`;
      const name = document.createElement("span");
      name.textContent = id;
      const note = document.createElement("small");
      if (state.tab === "sounds") {
        const s = rules.sounds.get(id)!;
        note.textContent = `${s.bus}${s.loop ? " · loop" : ""}`;
      } else note.textContent = `${rules.cues.get(id)!.parts.length} parts`;
      row.append(name, note);
      row.onclick = () => {
        state.selected = id;
        remember();
        render();
        if (state.tab === "sounds") playSound(id);
        else playCue(id);
      };
      items.append(row);
    }
  };
  renderItems();
  renderDetail();
}

// --- playing ------------------------------------------------------------------------------------
const looping: { stop: () => void }[] = [];
function playSound(id: string, take?: number): void {
  if (!sfx) return;
  for (const l of looping.splice(0)) l.stop();
  const handle = take === undefined ? sfx.play(id, { at: where(), own: true }) : playTake(id, take);
  if (handle && rules.sounds.get(id)!.loop) looping.push(handle);
}
/** One take on its own, without the sound's variation: for comparing takes. */
function playTake(id: string, take: number): { stop: () => void } | null {
  if (!sfx) return null;
  const rendered = sfx.takes(id)[take];
  const ctx = sfx.ctx;
  const buffer = ctx.createBuffer(1, rendered.data.length, rendered.sampleRate);
  buffer.getChannelData(0).set(rendered.data);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  if (rendered.loop) {
    source.loop = true;
    source.loopStart = rendered.loop.start;
    source.loopEnd = rendered.loop.end;
  }
  const gain = ctx.createGain();
  gain.gain.value = (Number(volume.value) / 100) ** 2 * rules.config.mix.master;
  source.connect(gain).connect(ctx.destination);
  source.start();
  return { stop: () => source.stop() };
}
function playCue(id: string): void {
  cues.play(id, { source: SOURCE, target: TARGET, skill: null, crit: flags.crit, periodic: flags.periodic });
}

// --- the detail ----------------------------------------------------------------------------------
function renderDetail(): void {
  detail.innerHTML = "";
  if (!state.selected) {
    detail.innerHTML = `<p class="hint">Pick a sound or a cue on the left: a click plays it. The listener faces along +z; the sliders above move the sound (or the cue's target) round it.</p>`;
    return;
  }
  if (state.tab === "sounds") soundDetail(rules.sounds.get(state.selected));
  else cueDetail(state.selected);
}

function soundDetail(sound: SoundDef | undefined): void {
  if (!sound) return;
  const h = document.createElement("h2");
  h.textContent = sound.id;
  const facts = document.createElement("div");
  facts.className = "facts";
  const fact = (name: string, value: string): string => `<span>${name} <b>${value}</b></span>`;
  facts.innerHTML = [
    fact("bus", sound.bus),
    fact("heard", `${sound.near}-${sound.far} m`),
    fact("pitch", `${sound.pitch[0]} to ${sound.pitch[1]} st`),
    fact("volume", `${sound.volume[0]}-${sound.volume[1]}`),
    fact("voices", String(sound.maxVoices)),
    fact("takes", String(sound.takes)),
    sound.loop ? fact("loop", `${sound.loop} s`) : "",
    fact("file", sound.file),
  ].join("");
  const buttons = document.createElement("div");
  buttons.className = "row";
  const play = document.createElement("button");
  play.textContent = "▶ Play (varied)";
  play.onclick = () => playSound(sound.id);
  buttons.append(play);
  detail.append(h, facts, buttons);
  if (!sfx) {
    detail.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "Click anywhere to start the audio; the takes show once it has." }));
  } else {
    const started = performance.now();
    const takes = sfx.takes(sound.id);
    const ms = performance.now() - started;
    takes.forEach((_, i) => {
      const b = document.createElement("button");
      b.textContent = `Take ${i + 1}`;
      b.onclick = () => playSound(sound.id, i);
      buttons.append(b);
    });
    const info = document.createElement("p");
    info.className = "hint";
    info.textContent = takes.length ? `${(takes[0].data.length / takes[0].sampleRate).toFixed(2)} s a take${ms > 1 ? `, rendered in ${ms.toFixed(0)} ms` : ""}` : "No generated layers.";
    detail.append(info);
    for (const take of takes) detail.append(waveform(take));
  }
  const lh = document.createElement("h2");
  lh.textContent = "Layers";
  detail.append(lh);
  for (const layer of sound.layers) {
    const div = document.createElement("div");
    div.className = "layer";
    if (layer.synth) {
      const { kind, wave, hz, env, gain, delay, filter } = layer.synth;
      const pitched = kind !== "noise" && kind !== "crackle";
      div.textContent = `${kind}${wave ? ` ${wave}` : ""}${pitched ? ` · ${hz[0] === hz[1] ? hz[0] : `${hz[0]}→${hz[1]}`} Hz` : ""} · env ${env.attack}/${env.hold}/${env.decay} · gain ${gain}${delay ? ` · delay ${delay}` : ""}${filter ? ` · ${filter.type} ${filter.hz.join("→")} q${filter.q}` : ""}`;
    } else div.textContent = `samples: ${layer.samples!.join(", ")} · gain ${layer.gain}`;
    if (layer.standIn) div.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "stand-in" }));
    detail.append(div);
  }
}

function waveform(take: RenderedSound): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const width = 900;
  const height = 70;
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#6fa8c7";
  const per = take.data.length / width;
  for (let x = 0; x < width; x++) {
    let low = 0;
    let high = 0;
    for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) {
      low = Math.min(low, take.data[i]);
      high = Math.max(high, take.data[i]);
    }
    g.fillRect(x, height / 2 - high * (height / 2), 1, Math.max(1, (high - low) * (height / 2)));
  }
  if (take.loop) {
    g.fillStyle = "rgba(201,163,94,0.25)";
    const sr = take.sampleRate;
    g.fillRect((take.loop.start * sr) / per, 0, ((take.loop.end - take.loop.start) * sr) / per, height);
  }
  return canvas;
}

function cueDetail(id: string): void {
  const cue = rules.cues.get(id);
  if (!cue) return;
  const h = document.createElement("h2");
  h.textContent = id;
  const row = document.createElement("div");
  row.className = "row";
  const play = document.createElement("button");
  play.textContent = "▶ Play";
  play.onclick = () => playCue(id);
  row.append(play);
  for (const flag of ["crit", "periodic", "own"] as const) {
    const b = document.createElement("button");
    b.textContent = flag;
    b.className = flags[flag] ? "on" : "";
    b.onclick = () => {
      flags[flag] = !flags[flag];
      b.className = flags[flag] ? "on" : "";
    };
    row.append(b);
  }
  // Placeholder values: those that some sound or effect id in the packs uses after a dot.
  const used = (name: string): string[] => {
    const values = new Set<string>();
    for (const sid of [...rules.sounds.keys(), ...rules.effects.keys()]) for (const part of sid.split(".").slice(1)) values.add(part);
    const extra = name === "weapon" ? ["unarmed", ...Object.values(rules.config.weapons)] : name === "armor" ? ["flesh", ...Object.values(rules.config.armors)] : [];
    return [...new Set([...extra, ...values])].sort();
  };
  const pick = document.createElement("div");
  pick.className = "row";
  for (const [who, name] of [["source", "weapon"], ["target", "armor"], ["target", "family"]] as const) {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) continue;
    const label = document.createElement("label");
    label.className = "hint";
    label.textContent = `${who} ${name} `;
    const select = document.createElement("select");
    for (const value of ["", ...used(name)]) select.append(new Option(value || "(none)", value));
    select.value = traits[who][name] ?? "";
    select.onchange = () => {
      traits[who][name] = select.value || undefined;
    };
    label.append(select);
    pick.append(label);
  }
  const parts = document.createElement("div");
  for (const part of cue.parts) {
    const div = document.createElement("div");
    div.className = "layer";
    const what = part.kind === "sound" || part.kind === "particles" ? part.ref : part.kind === "flash" ? part.colour.map((c) => c.toFixed(2)).join(", ") : String(part.strength);
    const when = Object.entries(part.when).map(([k, v]) => `${k}=${v}`).join(" ");
    div.textContent = `${part.kind} ${what} · at ${part.at}${part.kind === "shake" || part.kind === "pause" ? "" : ` (${part.bone})`}${when ? ` · when ${when}` : ""}${part.delay ? ` · delay ${part.delay}` : ""}`;
    if (part.kind !== "sound") div.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "not shown yet" }));
    parts.append(div);
  }
  detail.append(h, row, pick, parts);
}

render();
