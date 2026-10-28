// The feedback content (see FEEDBACK.md): sounds, particle effects and their textures, cues, and
// `rules/feedback.json5` - which cue each event plays. Read and checked here, with skills' `cues`
// and looks' `feedback` (which the game rules pass through unread). Pure: runs in the page and in
// Node, where the probe checks it.

import { ContentError, joinPath, Reader, type ContentIssue, type RawObject } from "../world/content/contentReader";
import { FEEDBACK_FOLDERS, orderPacks, parseFile, type PackSource } from "../world/content/resolveContent";
import type { GameRules } from "../sim/rules/gameRules";
import { COMBAT_EVENT_KINDS } from "../sim/skills/events";
import { readSynth, type SynthLayer } from "../audio/synth";
import { readParticleTexture, type ParticleTextureDef } from "../particles/textures";

// --- the definitions ---------------------------------------------------------------------------

export const BUSES = ["combat", "footsteps", "ui", "ambient"] as const;
export type Bus = (typeof BUSES)[number];

export type SoundLayer = { synth: SynthLayer; samples: null; gain: number; standIn: boolean } | { synth: null; samples: string[]; gain: number; standIn: false };

export interface SoundDef {
  id: string;
  file: string;
  bus: Bus;
  /** Full volume within `near` metres, silent beyond `far`. */
  near: number;
  far: number;
  /** Of this sound at once; the oldest stops. */
  maxVoices: number;
  /** Semitones, and a level factor, picked between per play. */
  pitch: [number, number];
  volume: [number, number];
  /** How many times the synth layers are rendered, from different seeds. */
  takes: number;
  /** Seconds a looping sound's loop lasts; 0 for a one-shot. */
  loop: number;
  /** Not placed in the world: UI sounds. */
  flat: boolean;
  layers: SoundLayer[];
}

/** A number, or one that changes over a particle's life: [life 0..1, value] points. */
export type Curve = [number, number][];
/** RGBA, 0..1, over life. */
export type ColourCurve = [number, [number, number, number, number]][];

export const EMITTER_SHAPES = ["point", "sphere", "ring", "cone", "box", "line"] as const;
export const MESH_SHAPES = ["shard", "chip", "ember", "cube", "leaf", "ring"] as const;
export const BLENDS = ["add", "alpha"] as const;

export interface EmitterDef {
  /** A texture's index for a sprite, or -1 for a mesh. */
  sprite: number;
  mesh: (typeof MESH_SHAPES)[number] | null;
  blend: (typeof BLENDS)[number];
  /** Per second while it runs. */
  rate: number;
  bursts: { at: number; count: number }[];
  delay: number;
  /** Seconds it emits for; Infinity in a looping effect, until stopped. */
  duration: number;
  life: [number, number];
  shape: { kind: (typeof EMITTER_SHAPES)[number]; size: [number, number, number]; angle: number };
  speed: [number, number];
  /** Unit vector, or null: outward from the shape (up for a point). */
  direction: [number, number, number] | null;
  /** Degrees around `direction` (or outward from the shape, or up). */
  spread: number;
  gravity: number;
  drag: number;
  size: Curve;
  colour: ColourCurve;
  spin: [number, number];
  stretch: number;
  local: boolean;
  inherit: number;
}

export interface ParticleEffectDef {
  id: string;
  file: string;
  loop: boolean;
  emitters: EmitterDef[];
}

export const CUE_PARTS = ["sound", "particles", "flash", "flinch", "shake", "pause"] as const;
export type CuePartKind = (typeof CUE_PARTS)[number];
export const PLACES = ["source", "target", "point"] as const;
export const BONES = ["chest", "head", "feet", "mainHand", "offHand", "hands", "weapon"] as const;
export const PLACEHOLDERS = ["weapon", "armor", "family", "school", "surface"] as const;

export interface CueWhen {
  crit?: boolean;
  periodic?: boolean;
  own?: boolean;
  /** `dealt`: the player is the source; `taken`: the target. */
  role?: "dealt" | "taken";
}

export interface CuePart {
  kind: CuePartKind;
  /** `sound` and `particles`: the id, maybe with placeholders, resolved when it plays. */
  ref: string;
  at: (typeof PLACES)[number];
  bone: (typeof BONES)[number];
  when: CueWhen;
  delay: number;
  /** A factor, or `amount`: the hit's size against the target's maximum health. */
  scale: number | "amount";
  /** `flash`: its colour and seconds. */
  colour: [number, number, number];
  time: number;
  /** `flinch`, `shake`: 0..1. `pause`: seconds. */
  strength: number;
}

export interface CueDef {
  id: string;
  file: string;
  parts: CuePart[];
  /** Play the event table's cue as well, under a skill's own. */
  table: boolean;
}

/** The phases a skill can name cues for, and the events they play on (FEEDBACK.md, *Cues in skills*). */
export const PHASES = ["cast", "channel", "release", "projectile", "impact", "tick", "applied", "aura", "faded", "swing"] as const;
export type Phase = (typeof PHASES)[number];

/** Events the client sees happen that are not combat events. */
export const CLIENT_EVENTS = ["lootable", "lootOpen", "itemTake", "moneyTake", "itemDrop", "itemPickUp", "equip", "use", "target", "footstep"] as const;
export const EVENT_NAMES: readonly string[] = [...COMBAT_EVENT_KINDS, ...CLIENT_EVENTS];

/** One line of the event table: the first whose conditions all hold picks the cue. */
export interface EventRule {
  /** Every one of these must be among the skill's tags. */
  tags: string[];
  /** The skill's engine-level type (`spell`, `physical`), or "" for any. */
  type: "" | "spell" | "physical" | "none";
  /** An animation's or an effect's name. */
  name: string;
  /** An item's rarity, one of these. */
  rarity: string[];
  role: CueWhen["role"];
  crit?: boolean;
  periodic?: boolean;
  /** "" plays nothing (and stops the search). */
  cue: string;
}

export interface FeedbackConfig {
  events: Map<string, EventRule[]>;
  /** Item template or gear piece → weapon kind. */
  weapons: Record<string, string>;
  /** Gear material → armour kind. */
  armors: Record<string, string>;
  /** Patterns on ground material ids (`*` any run of letters) → surface, first match wins. */
  surfaces: [string, string][];
  mix: Record<Bus | "master", number>;
  voices: number;
  particles: { sprites: number; meshes: number };
  others: { volume: number; particles: number };
}

export interface FeedbackRules {
  sounds: Map<string, SoundDef>;
  textures: ParticleTextureDef[];
  textureIndex: ReadonlyMap<string, number>;
  effects: Map<string, ParticleEffectDef>;
  cues: Map<string, CueDef>;
  config: FeedbackConfig;
  /** Each skill's cues by phase, by skill index (from `SkillDef.cues`, checked). */
  skillCues: Partial<Record<Phase, string>>[];
}

// --- reading -------------------------------------------------------------------------------------

/** Feedback ids may have dots: `hit.blade.metal` falls back to `hit.blade`, then `hit`. */
const ID_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const PLACEHOLDER = /\{([^}]*)\}/g;

interface Entry {
  id: string;
  file: string;
  data: unknown;
}

function feedbackEntries(packs: PackSource[], issues: ContentIssue[]): { folders: Map<string, Map<string, Entry>>; config?: Entry } {
  const folders = new Map<string, Map<string, Entry>>(FEEDBACK_FOLDERS.map((f) => [f, new Map()]));
  let config: Entry | undefined;
  for (const pack of orderPacks(packs, issues)) {
    for (const { path, text } of pack.files) {
      const parts = path.split("/");
      if (parts.length !== 2) continue;
      const file = `${pack.id}/${path}`;
      const id = parts[1].replace(/\.json5$/, "");
      if (parts[0] === "rules") {
        if (id !== "feedback") continue;
        const data = parseFile(file, text, issues);
        if (data !== undefined) config = { id, file, data };
        continue;
      }
      if (!folders.has(parts[0])) continue;
      if (!ID_PATTERN.test(id)) {
        issues.push({ file, path: "", message: "file names (which are ids) may only use letters, digits, - and _, in parts joined by dots" });
        continue;
      }
      const data = parseFile(file, text, issues);
      if (data !== undefined) folders.get(parts[0])!.set(id, { id, file, data });
    }
  }
  return { folders, config };
}

const sorted = (m: Map<string, Entry>): Entry[] => [...m.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const known = (names: Iterable<string>): string => [...names].join(", ") || "none";

/** A [low, high] pair, or one number for both. */
function pairOf(reader: Reader, obj: RawObject, key: string, path: string, fallback: [number, number], options: { min?: number; max?: number } = {}): [number, number] {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    const n = reader.number(obj, key, path, options);
    return [n, n];
  }
  const range = reader.range(obj, key, path, { allowEqual: true });
  for (const [i, v] of range.entries()) {
    if (options.min !== undefined && v < options.min) reader.fail(joinPath(joinPath(path, key), i), `must be at least ${options.min}`);
    if (options.max !== undefined && v > options.max) reader.fail(joinPath(joinPath(path, key), i), `must be at most ${options.max}`);
  }
  return range;
}

function readSound(entry: Entry, issues: ContentIssue[]): SoundDef {
  const reader = new Reader(issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", ["bus", "near", "far", "maxVoices", "pitch", "volume", "takes", "loop", "flat", "layers"]);
  const near = reader.optionalNumber(obj, "near", "", 3, { min: 0 });
  const far = reader.optionalNumber(obj, "far", "", 40, { min: 0.1 });
  if (far <= near) reader.fail("far", `must be beyond near (${near})`);
  const layers: SoundLayer[] = reader.array(obj, "layers", "").map((value, i) => {
    const path = `layers[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["synth", "sample", "gain", "standIn"]);
    const gain = reader.optionalNumber(raw, "gain", path, 1, { min: 0, max: 4 });
    if ((raw.synth === undefined) === (raw.sample === undefined)) reader.fail(path, "needs exactly one of `synth` or `sample`");
    if (raw.sample !== undefined) {
      const samples = typeof raw.sample === "string" ? [raw.sample] : reader.stringList(raw, "sample", path);
      samples.forEach((s, k) => /\.(wav|ogg|mp3|flac)$/i.test(s) || reader.fail(joinPath(joinPath(path, "sample"), k), "expected a sound file (.wav, .ogg, .mp3 or .flac)"));
      if (raw.standIn !== undefined) reader.fail(joinPath(path, "standIn"), "only generated layers stand in for samples");
      return { synth: null, samples, gain, standIn: false };
    }
    return { synth: readSynth(reader, raw.synth ?? {}, joinPath(path, "synth")), samples: null, gain, standIn: reader.boolean(raw, "standIn", path, false) };
  });
  if (layers.length === 0) reader.fail("layers", "a sound needs at least one layer");
  return {
    id: entry.id,
    file: entry.file,
    bus: obj.bus === undefined ? "combat" : reader.oneOf(obj, "bus", "", BUSES),
    near,
    far,
    maxVoices: reader.optionalNumber(obj, "maxVoices", "", 4, { min: 1, max: 32, integer: true }),
    pitch: pairOf(reader, obj, "pitch", "", [0, 0], { min: -24, max: 24 }),
    volume: pairOf(reader, obj, "volume", "", [1, 1], { min: 0, max: 4 }),
    takes: reader.optionalNumber(obj, "takes", "", 3, { min: 1, max: 16, integer: true }),
    loop: obj.loop === undefined || obj.loop === false ? 0 : reader.number(obj, "loop", "", { min: 0.3, max: 20 }),
    flat: reader.boolean(obj, "flat", "", false),
    layers,
  };
}

/** A colour: "#rrggbb", "#rrggbbaa", [r, g, b] or [r, g, b, a] with 0-1 channels. */
function colourValue(reader: Reader, value: unknown, path: string): [number, number, number, number] {
  if (typeof value === "string") {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(value);
    if (m) return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255, m[4] === undefined ? 1 : parseInt(m[4], 16) / 255];
  } else if (Array.isArray(value) && (value.length === 3 || value.length === 4) && value.every((c) => typeof c === "number" && c >= 0 && c <= 1)) {
    return [value[0], value[1], value[2], value[3] ?? 1];
  }
  reader.fail(path, `expected a colour ("#rrggbb", "#rrggbbaa", or [r, g, b] / [r, g, b, a] with 0-1 channels)`);
  return [1, 0, 1, 1];
}

/** Points [life, value] with lives rising from 0 to 1. */
function curvePoints(reader: Reader, value: unknown[], path: string): [number, unknown][] {
  let last = -1;
  return value.map((p, i) => {
    const at = joinPath(path, i);
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "number") {
      reader.fail(at, "expected [life 0..1, value]");
      return [0, 0];
    }
    if (p[0] < 0 || p[0] > 1 || p[0] < last) reader.fail(at, "lives must rise from 0 to 1");
    last = p[0];
    return [p[0], p[1]];
  });
}

function readCurve(reader: Reader, obj: RawObject, key: string, path: string, fallback: number): Curve {
  const value = obj[key];
  const at = joinPath(path, key);
  if (value === undefined) return [[0, fallback]];
  if (typeof value === "number") return [[0, value]];
  if (Array.isArray(value)) {
    return curvePoints(reader, value, at).map(([t, v], i) => {
      if (typeof v !== "number") reader.fail(joinPath(joinPath(at, i), 1), "expected a number");
      return [t, typeof v === "number" ? v : fallback];
    });
  }
  reader.fail(at, "expected a number or [[life, value], ...]");
  return [[0, fallback]];
}

function readColourCurve(reader: Reader, obj: RawObject, key: string, path: string): ColourCurve {
  const value = obj[key];
  const at = joinPath(path, key);
  if (value === undefined) return [[0, [1, 1, 1, 1]]];
  // A curve is a list of [life, colour] pairs; anything else is one colour.
  if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0])) {
    return curvePoints(reader, value, at).map(([t, c], i) => [t, colourValue(reader, c, joinPath(joinPath(at, i), 1))]);
  }
  return [[0, colourValue(reader, value, at)]];
}

const EMITTER_KEYS = ["sprite", "mesh", "blend", "rate", "burst", "delay", "duration", "life", "shape", "speed", "direction", "spread", "gravity", "drag", "size", "colour", "spin", "stretch", "local", "inherit"];

function readEmitter(reader: Reader, value: unknown, path: string, loop: boolean, textureIndex: ReadonlyMap<string, number>): EmitterDef {
  const obj = reader.object(value, path);
  reader.onlyKeys(obj, path, EMITTER_KEYS);
  if ((obj.sprite === undefined) === (obj.mesh === undefined)) reader.fail(path, "needs exactly one of `sprite` (a texture) or `mesh` (a shape)");
  let sprite = -1;
  if (obj.sprite !== undefined) {
    const id = reader.string(obj, "sprite", path);
    sprite = textureIndex.get(id) ?? -1;
    if (id && sprite < 0) reader.fail(joinPath(path, "sprite"), `no particle texture "${id}" (known: ${known(textureIndex.keys())})`);
  }
  const bursts: EmitterDef["bursts"] = [];
  if (typeof obj.burst === "number") bursts.push({ at: 0, count: reader.number(obj, "burst", path, { min: 1, integer: true }) });
  else if (obj.burst !== undefined) {
    reader.array(obj, "burst", path).forEach((b, i) => {
      const at = joinPath(joinPath(path, "burst"), i);
      const raw = reader.object(b, at);
      reader.onlyKeys(raw, at, ["at", "count"]);
      bursts.push({ at: reader.optionalNumber(raw, "at", at, 0, { min: 0 }), count: reader.number(raw, "count", at, { min: 1, integer: true }) });
    });
  }
  const rate = reader.optionalNumber(obj, "rate", path, 0, { min: 0, max: 2000 });
  if (rate === 0 && bursts.length === 0) reader.fail(path, "emits nothing: give it a `rate` or a `burst`");

  let shape: EmitterDef["shape"] = { kind: "point", size: [0, 0, 0], angle: 0 };
  if (obj.shape !== undefined) {
    const at = joinPath(path, "shape");
    if (obj.shape === "point" || obj.shape === "line") shape = { kind: obj.shape, size: [0, 0, 0], angle: 0 };
    else {
      const raw = reader.object(obj.shape, at);
      const kinds = EMITTER_SHAPES.filter((k) => raw[k] !== undefined);
      reader.onlyKeys(raw, at, [...EMITTER_SHAPES, "angle"]);
      if (kinds.length !== 1) reader.fail(at, `needs exactly one shape (${EMITTER_SHAPES.join(", ")})`);
      const kind = kinds[0] ?? "point";
      let size: [number, number, number] = [0, 0, 0];
      if (kind === "box") {
        const v = raw.box;
        if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && n >= 0)) size = [v[0], v[1], v[2]];
        else reader.fail(joinPath(at, "box"), "expected [x, y, z] half sizes");
      } else if (kind !== "point" && kind !== "line") {
        const r = reader.number(raw, kind, at, { min: 0 });
        size = [r, r, r];
      }
      shape = { kind, size, angle: reader.optionalNumber(raw, "angle", at, 30, { min: 0, max: 180 }) };
    }
  }
  let direction: EmitterDef["direction"] = null;
  if (obj.direction !== undefined) {
    const v = obj.direction;
    if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number") && Math.hypot(v[0], v[1], v[2]) > 0) {
      const l = Math.hypot(v[0], v[1], v[2]);
      direction = [v[0] / l, v[1] / l, v[2] / l];
    } else reader.fail(joinPath(path, "direction"), "expected [x, y, z], not all 0");
  }
  const delay = reader.optionalNumber(obj, "delay", path, 0, { min: 0, max: 10 });
  const lastBurst = Math.max(0, ...bursts.map((b) => b.at));
  return {
    sprite,
    mesh: obj.mesh === undefined ? null : reader.oneOf(obj, "mesh", path, MESH_SHAPES),
    blend: obj.blend === undefined ? "alpha" : reader.oneOf(obj, "blend", path, BLENDS),
    rate,
    bursts,
    delay,
    duration: obj.duration !== undefined ? reader.number(obj, "duration", path, { min: 0 }) : loop ? Infinity : rate > 0 ? 0.5 : lastBurst,
    life: pairOf(reader, obj, "life", path, [1, 1], { min: 0.01, max: 30 }),
    shape,
    speed: pairOf(reader, obj, "speed", path, [0, 0], { min: 0, max: 200 }),
    direction,
    // Without a direction a point (or a box, a line) throws every way and a sphere or ring straight out.
    spread: reader.optionalNumber(obj, "spread", path, direction === null && (shape.kind === "point" || shape.kind === "box" || shape.kind === "line") ? 180 : 0, { min: 0, max: 180 }),
    gravity: reader.optionalNumber(obj, "gravity", path, 0, { min: -100, max: 100 }),
    drag: reader.optionalNumber(obj, "drag", path, 0, { min: 0, max: 50 }),
    size: readCurve(reader, obj, "size", path, 0.2),
    colour: readColourCurve(reader, obj, "colour", path),
    spin: pairOf(reader, obj, "spin", path, [0, 0], { min: -50, max: 50 }),
    stretch: reader.optionalNumber(obj, "stretch", path, 0, { min: 0, max: 2 }),
    local: reader.boolean(obj, "local", path, false),
    inherit: reader.optionalNumber(obj, "inherit", path, 0, { min: 0, max: 1 }),
  };
}

function readEffect(entry: Entry, issues: ContentIssue[], textureIndex: ReadonlyMap<string, number>): ParticleEffectDef {
  const reader = new Reader(issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", ["loop", "emitters"]);
  const loop = reader.boolean(obj, "loop", "", false);
  const emitters = reader.array(obj, "emitters", "").map((e, i) => readEmitter(reader, e, `emitters[${i}]`, loop, textureIndex));
  if (emitters.length === 0) reader.fail("emitters", "an effect needs at least one emitter");
  return { id: entry.id, file: entry.file, loop, emitters };
}

const PART_KEYS = [...CUE_PARTS, "at", "bone", "when", "delay", "scale", "time"];

function readWhen(reader: Reader, value: unknown, path: string): CueWhen {
  if (value === undefined) return {};
  const obj = reader.object(value, path);
  reader.onlyKeys(obj, path, ["crit", "periodic", "own", "role"]);
  const when: CueWhen = {};
  for (const key of ["crit", "periodic", "own"] as const) if (obj[key] !== undefined) when[key] = reader.boolean(obj, key, path, false);
  if (obj.role !== undefined) when.role = reader.oneOf(obj, "role", path, ["dealt", "taken"] as const);
  return when;
}

/**
 * Checks a sound's or effect's id, which may hold placeholders: every name must be known, and the
 * part before the first placeholder must exist, since that is where the fallback ends.
 */
function checkRef(reader: Reader, ref: string, path: string, exists: (id: string) => boolean, what: string): void {
  for (const [, name] of ref.matchAll(PLACEHOLDER)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) reader.fail(path, `unknown placeholder {${name}} (known: ${PLACEHOLDERS.join(", ")})`);
  }
  const parts = ref.split(".");
  const fixed = parts.findIndex((p) => p.includes("{"));
  if (fixed === 0) {
    reader.fail(path, "a placeholder may not be the first part: nothing would be left to fall back to");
    return;
  }
  const base = (fixed < 0 ? parts : parts.slice(0, fixed)).join(".");
  if (!exists(base)) reader.fail(path, `no ${what} "${base}"`);
}

function readCue(entry: Entry, issues: ContentIssue[], sounds: ReadonlyMap<string, unknown>, effects: ReadonlyMap<string, unknown>): CueDef {
  const reader = new Reader(issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", ["parts", "table"]);
  const parts = reader.array(obj, "parts", "").map((value, i): CuePart => {
    const path = `parts[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, PART_KEYS);
    const kinds = CUE_PARTS.filter((k) => raw[k] !== undefined);
    if (kinds.length !== 1) reader.fail(path, `needs exactly one of ${CUE_PARTS.join(", ")}`);
    const kind = kinds[0] ?? "sound";
    let ref = "";
    let colour: [number, number, number] = [1, 1, 1];
    let strength = 0;
    if (kind === "sound" || kind === "particles") {
      ref = reader.string(raw, kind, path);
      if (ref) checkRef(reader, ref, joinPath(path, kind), (id) => (kind === "sound" ? sounds : effects).has(id), kind === "sound" ? "sound" : "particle effect");
    } else if (kind === "flash") {
      const [r, g, b] = colourValue(reader, raw.flash, joinPath(path, "flash"));
      colour = [r, g, b];
    } else {
      strength = reader.number(raw, kind, path, kind === "pause" ? { min: 0, max: 0.08 } : { min: 0, max: 1 });
    }
    // Camera parts belong to no place; the rest default to the event's target (the source for a swing).
    const at = raw.at === undefined ? "target" : reader.oneOf(raw, "at", path, PLACES);
    if ((kind === "shake" || kind === "pause") && raw.at !== undefined) reader.fail(joinPath(path, "at"), `a ${kind} has no place`);
    if ((kind === "flash" || kind === "flinch") && at === "point") reader.fail(joinPath(path, "at"), `a ${kind} needs a unit, not a point`);
    let scale: CuePart["scale"] = 1;
    if (raw.scale === "amount") scale = "amount";
    else if (raw.scale !== undefined) scale = reader.number(raw, "scale", path, { min: 0, max: 10 });
    return {
      kind,
      ref,
      at,
      bone: raw.bone === undefined ? "chest" : reader.oneOf(raw, "bone", path, BONES),
      when: readWhen(reader, raw.when, joinPath(path, "when")),
      delay: reader.optionalNumber(raw, "delay", path, 0, { min: 0, max: 5 }),
      scale,
      colour,
      time: reader.optionalNumber(raw, "time", path, 0.12, { min: 0.01, max: 2 }),
      strength,
    };
  });
  return { id: entry.id, file: entry.file, parts, table: reader.boolean(obj, "table", "", false) };
}

const stringRecord = (reader: Reader, obj: RawObject, key: string): Record<string, string> => {
  if (obj[key] === undefined) return {};
  const raw = reader.object(obj[key], key);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
    else reader.fail(joinPath(key, k), "expected text");
  }
  return out;
};

const DEFAULT_CONFIG: Omit<FeedbackConfig, "events"> = {
  weapons: {},
  armors: {},
  surfaces: [],
  mix: { master: 0.8, combat: 1, footsteps: 0.45, ui: 0.6, ambient: 0.6 },
  voices: 28,
  particles: { sprites: 3000, meshes: 600 },
  others: { volume: 0.5, particles: 0.5 },
};

function readConfig(entry: Entry | undefined, issues: ContentIssue[], cues: ReadonlyMap<string, unknown>): FeedbackConfig {
  const reader = new Reader(issues, entry?.file ?? "rules/feedback.json5");
  const obj = entry ? reader.object(entry.data, "") : {};
  reader.onlyKeys(obj, "", ["events", "weapons", "armors", "surfaces", "mix", "voices", "particles", "others"]);
  const events = new Map<string, EventRule[]>();
  if (obj.events !== undefined) {
    const raw = reader.object(obj.events, "events");
    for (const [name, list] of Object.entries(raw)) {
      const path = joinPath("events", name);
      if (!EVENT_NAMES.includes(name)) reader.fail(path, `unknown event (known: ${EVENT_NAMES.join(", ")})`);
      if (!Array.isArray(list)) {
        reader.fail(path, "expected a list of rules");
        continue;
      }
      events.set(name, list.map((r, i) => {
        const at = joinPath(path, i);
        const rule = reader.object(r, at);
        reader.onlyKeys(rule, at, ["tags", "type", "name", "rarity", "role", "crit", "periodic", "cue"]);
        const cue = typeof rule.cue === "string" ? rule.cue : reader.string(rule, "cue", at);
        if (cue && !cues.has(cue)) reader.fail(joinPath(at, "cue"), `no cue "${cue}"`);
        return {
          tags: rule.tags === undefined ? [] : reader.stringList(rule, "tags", at),
          type: rule.type === undefined ? "" : reader.oneOf(rule, "type", at, ["spell", "physical", "none"] as const),
          name: reader.optionalString(rule, "name", at) ?? "",
          rarity: rule.rarity === undefined ? [] : typeof rule.rarity === "string" ? [rule.rarity] : reader.stringList(rule, "rarity", at),
          role: rule.role === undefined ? undefined : reader.oneOf(rule, "role", at, ["dealt", "taken"] as const),
          crit: rule.crit === undefined ? undefined : reader.boolean(rule, "crit", at, false),
          periodic: rule.periodic === undefined ? undefined : reader.boolean(rule, "periodic", at, false),
          cue,
        };
      }));
    }
  }
  const surfaces = Object.entries(stringRecord(reader, obj, "surfaces"));
  const mixRaw = obj.mix === undefined ? {} : reader.object(obj.mix, "mix");
  reader.onlyKeys(mixRaw, "mix", ["master", ...BUSES]);
  const mix = { ...DEFAULT_CONFIG.mix };
  for (const key of Object.keys(mixRaw)) if (key in mix) mix[key as keyof typeof mix] = reader.number(mixRaw, key, "mix", { min: 0, max: 2 });
  const sub = (key: "particles" | "others", names: readonly string[], range: { min: number; max: number }): Record<string, number> => {
    const raw = obj[key] === undefined ? {} : reader.object(obj[key], key);
    reader.onlyKeys(raw, key, names);
    const out: Record<string, number> = { ...DEFAULT_CONFIG[key] };
    for (const name of names) out[name] = reader.optionalNumber(raw, name, key, out[name], range);
    return out;
  };
  return {
    events,
    weapons: stringRecord(reader, obj, "weapons"),
    armors: stringRecord(reader, obj, "armors"),
    surfaces,
    mix,
    voices: reader.optionalNumber(obj, "voices", "", DEFAULT_CONFIG.voices, { min: 1, max: 128, integer: true }),
    particles: sub("particles", ["sprites", "meshes"], { min: 0, max: 100000 }) as FeedbackConfig["particles"],
    others: sub("others", ["volume", "particles"], { min: 0, max: 1 }) as FeedbackConfig["others"],
  };
}

/**
 * Reads the packs' feedback, later packs replacing earlier ones' definitions by id, and checks it
 * against the game rules' skills and templates (after the creature rules have added their kinds).
 * Throws a ContentError listing every problem found.
 */
export function resolveFeedback(packs: PackSource[], game: GameRules): FeedbackRules {
  const issues: ContentIssue[] = [];
  const { folders, config: configEntry } = feedbackEntries(packs, issues);

  const textureEntries = sorted(folders.get("particleTextures")!);
  const textures = textureEntries.map((e) => readParticleTexture(e.id, new Reader(issues, e.file), e.data));
  const textureIndex = new Map(textures.map((t, i) => [t.id, i]));

  const sounds = new Map(sorted(folders.get("sounds")!).map((e) => [e.id, readSound(e, issues)]));
  const effects = new Map(sorted(folders.get("particles")!).map((e) => [e.id, readEffect(e, issues, textureIndex)]));
  const cues = new Map(sorted(folders.get("cues")!).map((e) => [e.id, readCue(e, issues, sounds, effects)]));
  const config = readConfig(configEntry, issues, cues);

  // Skills name cues by phase; the game rules let the field through unread.
  const skillCues = game.skills.map((skill) => {
    const reader = new Reader(issues, `skills/${skill.id}.json5`);
    const out: Partial<Record<Phase, string>> = {};
    for (const [phase, cue] of Object.entries(skill.cues)) {
      const path = joinPath("cues", phase);
      if (!(PHASES as readonly string[]).includes(phase)) reader.fail(path, `unknown phase (known: ${PHASES.join(", ")})`);
      else if (cue && !cues.has(cue)) reader.fail(path, `no cue "${cue}"`);
      else out[phase as Phase] = cue;
    }
    return out;
  });
  // Looks say what their units' hits sound like.
  for (const [id, template] of game.templates) {
    const reader = new Reader(issues, game.rawTemplates.get(id)?.file ?? `entities/${id}.json5`);
    for (const key of Object.keys(template.look.feedback)) {
      if (key !== "weapon" && key !== "armor" && key !== "family") reader.fail(joinPath(joinPath("look", "feedback"), key), "unknown field (expected one of: weapon, armor, family)");
    }
  }
  if (issues.length > 0) throw new ContentError(issues);
  return { sounds, textures, textureIndex, effects, cues, config, skillCues };
}

/**
 * Fills a sound's or effect's placeholders and finds the most specific one that exists:
 * `hit.{weapon}.{armor}` with a blade on mail tries `hit.blade.metal`, `hit.blade`, then `hit`.
 * A placeholder with no value stops the id there.
 */
export function resolveRef(ref: string, values: Readonly<Record<string, string | undefined>>, exists: (id: string) => boolean): string | null {
  if (!ref.includes("{")) return exists(ref) ? ref : null;
  const parts: string[] = [];
  for (const part of ref.split(".")) {
    let missing = false;
    const filled = part.replace(PLACEHOLDER, (_, name: string) => {
      const value = values[name];
      if (!value) missing = true;
      return value ?? "";
    });
    if (missing) break;
    parts.push(filled);
  }
  for (let n = parts.length; n > 0; n--) {
    const id = parts.slice(0, n).join(".");
    if (exists(id)) return id;
  }
  return null;
}

/** Whether a ground material's id matches a `surfaces` pattern: `*` stands for any run of characters. */
export function matchesPattern(pattern: string, id: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(id);
}

