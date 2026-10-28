// The feedback dev page (fx.html, see FEEDBACK.md, *Dev page*): every sound, cue and particle effect
// in the packs, played on its own between a caster and a target on a small stage, to see, hear and
// tune it. The camera is the listener; the sliders move the target round the caster and slow the
// particles down. The page reloads on every pack edit, keeping what was selected.

import { ArcRotateCamera, Color3, Color4, DirectionalLight, HemisphericLight, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { whenAudio } from "../audio/context";
import { createSfx, type Sfx, type Vec3 } from "../audio/sfx";
import type { RenderedSound } from "../audio/synth";
import { createEngine } from "../core/engine";
import { createCuePlayer, type Bone, type CuePlayer, type UnitTraits } from "../feedback/cues";
import { resolveFeedback, type FeedbackRules, type ParticleEffectDef, type SoundDef } from "../feedback/rules";
import { createBodyKit, createCharacterBody, type CharacterBody } from "../game/characterBody";
import { createParticleRenderer } from "../particles/render";
import { createParticleSystem, type EffectHandle } from "../particles/system";
import { drawParticleTexture } from "../particles/textures";
import { resolveCreatureRules } from "../sim/rules/creatureRules";
import { resolveGameRules, type GameRules } from "../sim/rules/gameRules";
import { ContentError, formatIssue } from "../world/content/contentReader";
import { configNameFromUrl, fetchPackSources, fetchWorldConfig } from "../world/content/loadContent";
import type { PackSource } from "../world/content/resolveContent";
import { WORLD_SEED } from "../world/worldData";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const list = $<HTMLDivElement>("list");
const detail = $<HTMLDivElement>("detail");
const distance = $<HTMLInputElement>("distance");
const angle = $<HTMLInputElement>("angle");
const speed = $<HTMLInputElement>("speed");
const volume = $<HTMLInputElement>("volume");
const status = $<HTMLSpanElement>("status");

let packs: PackSource[];
let game: GameRules;
let rules: FeedbackRules;
try {
  const config = await fetchWorldConfig(configNameFromUrl());
  packs = await fetchPackSources(undefined, config);
  game = resolveGameRules(packs);
  resolveCreatureRules(packs, game, WORLD_SEED);
  rules = resolveFeedback(packs, game);
} catch (error) {
  detail.innerHTML = `<p class="error"></p>`;
  detail.querySelector("p")!.textContent = error instanceof ContentError ? error.issues.map(formatIssue).join("\n") : String(error);
  throw error;
}

// --- the stage ---------------------------------------------------------------------------------
// The caster stands at the origin facing its target, which stands at the distance and angle the
// sliders give. Both are bodies, as in the game.
const SOURCE = 1;
const TARGET = 2;
const canvas = $<HTMLCanvasElement>("stage");
const engine = createEngine(canvas);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.12, 0.15, 0.19, 1);
const camera = new ArcRotateCamera("camera", -Math.PI / 2 - 0.5, 1.2, 9, new Vector3(0, 1, 2), scene);
camera.attachControl(canvas, true);
camera.wheelPrecision = 30;
camera.lowerRadiusLimit = 1.5;
camera.upperRadiusLimit = 80;
camera.minZ = 0.05;
const sky = new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
sky.intensity = 0.65;
sky.groundColor = new Color3(0.25, 0.22, 0.2);
const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.5), scene);
sun.intensity = 0.8;
const ground = MeshBuilder.CreateGround("ground", { width: 140, height: 140 }, scene);
const groundMaterial = new StandardMaterial("ground", scene);
groundMaterial.diffuseColor = new Color3(0.28, 0.33, 0.24);
groundMaterial.specularColor = Color3.Black();
ground.material = groundMaterial;
// Rings at 5, 10, 20 and 40 m, to judge sizes and distances by.
for (const r of [5, 10, 20, 40]) {
  const ring = MeshBuilder.CreateTorus(`ring${r}`, { diameter: r * 2, thickness: 0.04, tessellation: 96 }, scene);
  ring.position.y = 0.01;
  const m = new StandardMaterial(`ring${r}`, scene);
  m.emissiveColor = new Color3(0.4, 0.45, 0.5);
  m.disableLighting = true;
  ring.material = m;
}

const where = (): Vec3 => {
  const d = Number(distance.value);
  const a = (Number(angle.value) * Math.PI) / 180;
  return { x: Math.sin(a) * d, y: 0, z: Math.cos(a) * d };
};
const showSliders = (): void => {
  $("distanceOut").textContent = `${distance.value} m`;
  $("angleOut").textContent = `${angle.value}°`;
  $("speedOut").textContent = `×${Number(speed.value).toFixed(2)}`;
};
for (const input of [distance, angle, speed]) input.addEventListener("input", showSliders);
showSliders();

const kit = createBodyKit(packs);
const bodies = new Map<number, CharacterBody>();
void createCharacterBody(scene, "caster", kit, { race: "human", outfit: "scout", seed: 7 }, WORLD_SEED).then((b) => bodies.set(SOURCE, b));
void createCharacterBody(scene, "target", kit, { race: "human", outfit: "knight", seed: 11 }, WORLD_SEED).then((b) => bodies.set(TARGET, b));
const positionOf = (unit: number): Vec3 => (unit === SOURCE ? { x: 0, y: 0, z: 0 } : where());
const facingOf = (unit: number): number => {
  const t = where();
  return unit === SOURCE ? Math.atan2(t.x, t.z) : Math.atan2(-t.x, -t.z);
};
const scratch = new Vector3();
const HEIGHTS: Record<Bone, number> = { chest: 1.2, head: 1.7, feet: 0.03, mainHand: 1.0, offHand: 1.0, hands: 1.1, weapon: 1.1 };
const place = (unit: number, bone: Bone): Vec3 | null => {
  const body = bodies.get(unit);
  if (body) {
    body.place(bone, scratch);
    return { x: scratch.x, y: scratch.y, z: scratch.z };
  }
  const p = positionOf(unit);
  return { x: p.x, y: p.y + HEIGHTS[bone], z: p.z };
};

// --- particles ---------------------------------------------------------------------------------
const particles = createParticleSystem(rules);
const renderer = createParticleRenderer(scene, particles, rules);

// --- audio -------------------------------------------------------------------------------------
let sfx: Sfx | null = null;
whenAudio((audio) => {
  sfx = createSfx(audio.ctx, audio.effects, rules, (sound, file) => `${import.meta.env.BASE_URL}packs/${sound.file.split("/")[0]}/${file}`);
  sfx.setVolume((Number(volume.value) / 100) ** 2);
  status.textContent = "";
  // The sound's takes can show now - once the click that started the audio is over, so the button
  // it lands on is not replaced under it.
  if (state.tab === "sounds") addEventListener("pointerup", () => setTimeout(renderDetail, 0), { once: true });
});
volume.addEventListener("input", () => sfx?.setVolume((Number(volume.value) / 100) ** 2));
$("stop").addEventListener("click", () => {
  sfx?.stopAll();
  stopLooping();
  particles.clear();
});

/** Placeholders the cues panel fills: what the source hits with, what the target is made of. */
const traits: Record<"source" | "target", UnitTraits> = { source: { weapon: "blade" }, target: { armor: "metal", family: "humanoid" } };
const flags = { crit: false, periodic: false, own: true };
const cues: CuePlayer = createCuePlayer(
  rules,
  game,
  {
    player: () => (flags.own ? SOURCE : 0),
    target: () => 0,
    targetOf: () => 0,
    place,
    traits: (unit) => (unit === SOURCE ? traits.source : traits.target),
  },
  () => sfx,
  () => particles,
);

// --- every frame -------------------------------------------------------------------------------
let last = performance.now();
const forward = new Vector3();
engine.runRenderLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const [unit, body] of bodies) {
    const p = positionOf(unit);
    body.show({ ...p, facing: facingOf(unit), grounded: true });
  }
  particles.update(dt * Number(speed.value), camera.globalPosition);
  renderer.update();
  if (sfx) {
    camera.getDirectionToRef(Vector3.Forward(), forward);
    sfx.setListener(camera.globalPosition, forward, { x: 0, y: 1, z: 0 });
  }
  scene.render();
});
addEventListener("resize", () => engine.resize());
setInterval(() => {
  $("voices").textContent = String(sfx?.voices() ?? 0);
  const s = renderer.stats();
  $("particles").textContent = `${s.sprites + s.meshes} (${particles.effects()} effects)`;
}, 100);

// --- the list ------------------------------------------------------------------------------------
type Tab = "sounds" | "cues" | "particles" | "atlas";
const TABS: Tab[] = ["sounds", "cues", "particles", "atlas"];
const state = { tab: (location.hash.match(/tab=(\w+)/)?.[1] as Tab) ?? "sounds", selected: decodeURIComponent(location.hash.match(/[#&]id=([^&]+)/)?.[1] ?? ""), filter: "" };
const remember = (): void => history.replaceState(null, "", `#tab=${state.tab}&id=${encodeURIComponent(state.selected)}`);
const idsOf = (tab: Tab): string[] =>
  tab === "sounds" ? [...rules.sounds.keys()] : tab === "cues" ? [...rules.cues.keys()] : tab === "particles" ? [...rules.effects.keys()] : rules.textures.map((t) => t.id);

function render(): void {
  list.innerHTML = "";
  const tabs = document.createElement("div");
  tabs.className = "tabs";
  for (const tab of TABS) {
    const b = document.createElement("button");
    b.textContent = `${tab[0].toUpperCase()}${tab.slice(1)} (${idsOf(tab).length})`;
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
    for (const id of idsOf(state.tab).filter((i) => i.toLowerCase().includes(state.filter.toLowerCase()))) {
      const row = document.createElement("div");
      row.className = `item${id === state.selected ? " selected" : ""}`;
      const name = document.createElement("span");
      name.textContent = id;
      const note = document.createElement("small");
      if (state.tab === "sounds") {
        const s = rules.sounds.get(id)!;
        note.textContent = `${s.bus}${s.loop ? " · loop" : ""}`;
      } else if (state.tab === "cues") note.textContent = `${rules.cues.get(id)!.parts.length} parts`;
      else if (state.tab === "particles") {
        const e = rules.effects.get(id)!;
        note.textContent = `${e.emitters.length} emitters${e.loop ? " · loop" : ""}`;
      } else note.textContent = rules.textures.find((t) => t.id === id)!.kind;
      row.append(name, note);
      row.onclick = () => {
        state.selected = id;
        remember();
        render();
        if (state.tab === "sounds") playSound(id);
        else if (state.tab === "cues") playCue(id);
        else if (state.tab === "particles") playEffect(id);
      };
      items.append(row);
    }
  };
  renderItems();
  renderDetail();
}

// --- playing ------------------------------------------------------------------------------------
const looping: { stop: () => void }[] = [];
function stopLooping(): void {
  for (const l of looping.splice(0)) l.stop();
}
function playSound(id: string, take?: number): void {
  if (!sfx) return;
  stopLooping();
  const handle = take === undefined ? sfx.play(id, { at: place(TARGET, "chest"), own: true }) : playTake(id, take);
  if (handle && rules.sounds.get(id)!.loop) looping.push(handle);
}
/** One take on its own, without the sound's variation or place: for comparing takes. */
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
  stopLooping();
  const handle = cues.play(id, { source: SOURCE, target: TARGET, skill: null, crit: flags.crit, periodic: flags.periodic });
  if (handle) looping.push(handle);
}
/** Where the particles tab plays an effect: on the target, or in the caster's hands. */
const effectAt = { unit: TARGET, bone: "chest" as Bone };
function playEffect(id: string): void {
  stopLooping();
  const handle: EffectHandle | null = particles.spawn(id, () => place(effectAt.unit, effectAt.bone), { own: true, toward: () => place(effectAt.unit === SOURCE ? TARGET : SOURCE, "chest") });
  if (handle) looping.push(handle);
}

// --- the detail ----------------------------------------------------------------------------------
function renderDetail(): void {
  detail.innerHTML = "";
  if (state.tab === "atlas") return atlasDetail();
  if (!state.selected) {
    detail.innerHTML = `<p class="hint">Pick something on the left: a click plays it on the stage. Drag on the stage to turn the camera, which is where sounds are heard from; the sliders move the target and slow the particles.</p>`;
    return;
  }
  if (state.tab === "sounds") soundDetail(rules.sounds.get(state.selected));
  else if (state.tab === "cues") cueDetail(state.selected);
  else effectDetail(rules.effects.get(state.selected));
}

const heading = (text: string): HTMLElement => Object.assign(document.createElement("h2"), { textContent: text });
const button = (text: string, onclick: () => void, on = false): HTMLButtonElement => Object.assign(document.createElement("button"), { textContent: text, onclick, className: on ? "on" : "" });
const row = (...children: HTMLElement[]): HTMLDivElement => {
  const div = document.createElement("div");
  div.className = "row";
  div.append(...children);
  return div;
};
const layer = (text: string, tag = ""): HTMLDivElement => {
  const div = document.createElement("div");
  div.className = "layer";
  div.textContent = text;
  if (tag) div.append(Object.assign(document.createElement("span"), { className: "tag", textContent: tag }));
  return div;
};

function soundDetail(sound: SoundDef | undefined): void {
  if (!sound) return;
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
  const buttons = row(button("▶ Play at the target", () => playSound(sound.id)));
  detail.append(heading(sound.id), facts, buttons);
  if (!sfx) {
    detail.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "Click anywhere to start the audio; the takes show once it has." }));
  } else {
    const started = performance.now();
    const takes = sfx.takes(sound.id);
    const ms = performance.now() - started;
    takes.forEach((_, i) => buttons.append(button(`Take ${i + 1}`, () => playSound(sound.id, i))));
    const info = document.createElement("p");
    info.className = "hint";
    info.textContent = takes.length ? `${(takes[0].data.length / takes[0].sampleRate).toFixed(2)} s a take${ms > 1 ? `, rendered in ${ms.toFixed(0)} ms` : ""}` : "No generated layers.";
    detail.append(info);
    for (const take of takes) detail.append(waveform(take));
  }
  detail.append(heading("Layers"));
  for (const l of sound.layers) {
    if (l.synth) {
      const { kind, wave, hz, env, gain, delay, filter } = l.synth;
      const pitched = kind !== "noise" && kind !== "crackle";
      detail.append(
        layer(
          `${kind}${wave ? ` ${wave}` : ""}${pitched ? ` · ${hz[0] === hz[1] ? hz[0] : `${hz[0]}→${hz[1]}`} Hz` : ""} · env ${env.attack}/${env.hold}/${env.decay} · gain ${gain}${delay ? ` · delay ${delay}` : ""}${filter ? ` · ${filter.type} ${filter.hz.join("→")} q${filter.q}` : ""}`,
          l.standIn ? "stand-in" : "",
        ),
      );
    } else detail.append(layer(`samples: ${l.samples!.join(", ")} · gain ${l.gain}`));
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
  const toggles = row(button("▶ Play", () => playCue(id)));
  for (const flag of ["crit", "periodic", "own"] as const) {
    const b = button(flag, () => {
      flags[flag] = !flags[flag];
      b.className = flags[flag] ? "on" : "";
    }, flags[flag]);
    toggles.append(b);
  }
  // Placeholder values: those that some sound or effect id in the packs uses after a dot.
  const used = (name: string): string[] => {
    const values = new Set<string>();
    for (const sid of [...rules.sounds.keys(), ...rules.effects.keys()]) for (const part of sid.split(".").slice(1)) values.add(part);
    const extra = name === "weapon" ? ["unarmed", ...Object.values(rules.config.weapons)] : name === "armor" ? ["flesh", ...Object.values(rules.config.armors)] : [];
    return [...new Set([...extra, ...values])].sort();
  };
  const picks = row();
  for (const [who, name] of [["source", "weapon"], ["target", "armor"], ["target", "family"]] as const) {
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
    picks.append(label);
  }
  detail.append(heading(id), toggles, picks);
  for (const part of cue.parts) {
    const what = part.kind === "sound" || part.kind === "particles" ? part.ref : part.kind === "flash" ? part.colour.map((c) => c.toFixed(2)).join(", ") : String(part.strength);
    const when = Object.entries(part.when).map(([k, v]) => `${k}=${v}`).join(" ");
    const shown = part.kind === "sound" || part.kind === "particles";
    detail.append(layer(`${part.kind} ${what} · at ${part.at}${part.kind === "shake" || part.kind === "pause" ? "" : ` (${part.bone})`}${when ? ` · when ${when}` : ""}${part.delay ? ` · delay ${part.delay}` : ""}`, shown ? "" : "not shown yet"));
  }
}

function effectDetail(effect: ParticleEffectDef | undefined): void {
  if (!effect) return;
  const places = row(button("▶ Play", () => playEffect(effect.id)));
  for (const [label, unit, bone] of [["target chest", TARGET, "chest"], ["target feet", TARGET, "feet"], ["caster hands", SOURCE, "hands"], ["caster weapon", SOURCE, "weapon"], ["caster head", SOURCE, "head"]] as const) {
    places.append(
      button(label, () => {
        effectAt.unit = unit;
        effectAt.bone = bone;
        renderDetail();
        playEffect(effect.id);
      }, effectAt.unit === unit && effectAt.bone === bone),
    );
  }
  detail.append(heading(effect.id), places, Object.assign(document.createElement("p"), { className: "hint", textContent: `${effect.loop ? "Loops until another is picked or Stop all." : "One-shot."} ${effect.file}` }));
  for (const e of effect.emitters) {
    const what = e.mesh ? `mesh ${e.mesh}` : `sprite ${rules.textures[e.sprite]?.id}`;
    const emits = [e.rate ? `${e.rate}/s` : "", ...e.bursts.map((b) => `${b.count} at ${b.at}s`)].filter(Boolean).join(", ");
    const sizes = e.size.map(([t, v]) => `${t}:${v}`).join(" ");
    detail.append(layer(`${what} · ${e.blend} · ${emits} · life ${e.life.join("-")} s · speed ${e.speed.join("-")} · ${e.shape.kind}${e.shape.size[0] ? ` ${e.shape.size[0]}` : ""} · gravity ${e.gravity} · size ${sizes}${e.local ? " · local" : ""}${e.stretch ? ` · stretch ${e.stretch}` : ""}`));
  }
}

function atlasDetail(): void {
  const { atlas } = renderer;
  detail.append(heading(`Atlas ${atlas.size}²`));
  const canvas = document.createElement("canvas");
  canvas.className = "atlas";
  canvas.width = atlas.size;
  canvas.height = atlas.size;
  const g = canvas.getContext("2d")!;
  g.putImageData(new ImageData(new Uint8ClampedArray(atlas.pixels), atlas.size, atlas.size), 0, 0);
  // The selected texture's variants outlined.
  const index = rules.textures.findIndex((t) => t.id === state.selected);
  if (index >= 0) {
    g.strokeStyle = "#c9a35e";
    g.lineWidth = 2;
    for (const r of atlas.rects[index]) g.strokeRect(r.u0 * atlas.size, r.v0 * atlas.size, (r.u1 - r.u0) * atlas.size, (r.v1 - r.v0) * atlas.size);
  }
  detail.append(canvas);
  if (index >= 0) {
    const def = rules.textures[index];
    detail.append(heading(`${def.id} · ${def.kind} · ${def.size}² · ${def.variants} variants`));
    const strip = row();
    for (let v = 0; v < def.variants; v++) {
      const pixels = drawParticleTexture(def, v);
      const c = document.createElement("canvas");
      c.className = "atlas";
      c.width = c.height = def.size;
      c.style.width = c.style.height = `${Math.max(64, def.size)}px`;
      const image = new ImageData(def.size, def.size);
      for (let i = 0; i < pixels.alpha.length; i++) {
        const l = Math.round(pixels.luminance[i] * 255);
        image.data.set([l, l, l, Math.round(pixels.alpha[i] * 255)], i * 4);
      }
      c.getContext("2d")!.putImageData(image, 0, 0);
      strip.append(c);
    }
    detail.append(strip);
  }
}

render();

// For the console: the stage's systems.
(window as unknown as { __fx: unknown }).__fx = { scene, camera, particles, renderer, cues, place, sfx: () => sfx, bodies };
