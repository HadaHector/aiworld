// Generated sound effects (see FEEDBACK.md, *Sounds*): a sound's synth layers are recipes - a
// generator, an envelope, a filter and a few effects - rendered here to samples in plain JS, once a
// take, the first time the sound is needed. Seeded, so a take is the same on every load; the
// variation between plays comes from picking takes, pitch and volume when it is played.

import { joinPath, type RawObject, type Reader } from "../world/content/contentReader";
import { mulberry32 } from "../world/rng";
import { crossfadeLoop, pluckString, SAMPLE_RATE } from "./dsp";

export const GENERATORS = ["tone", "noise", "modal", "fm", "pluck", "crackle"] as const;
export type GeneratorKind = (typeof GENERATORS)[number];
export const WAVES = ["sine", "triangle", "square", "saw"] as const;
export const NOISES = ["white", "pink", "brown"] as const;
export const FILTERS = ["lowpass", "highpass", "bandpass"] as const;

/** A frequency: fixed, or swept from the first to the second over the layer (exponentially). */
export type Sweep = [number, number];

export interface SynthEnvelope {
  attack: number;
  hold: number;
  decay: number;
  /** The decay's shape: 1 a straight line, higher falls faster at first. */
  curve: number;
}

export interface SynthLayer {
  kind: GeneratorKind;
  /** `tone`: the wave; `noise`: its colour. */
  wave: string;
  /** `tone`, `fm`, `pluck`, `modal`: the pitch in Hz. */
  hz: Sweep;
  /** `modal`: [ratio to hz, level, decay seconds] per partial. */
  partials: [number, number, number][];
  /** `fm`: the modulator's frequency as a ratio of the carrier's, and its index over the layer. */
  ratio: number;
  index: Sweep;
  /** `pluck`: where it is plucked, how bright, how long it rings (0..1, closer to 1 longer). */
  pick: number;
  bright: number;
  loss: number;
  /** `crackle`: clicks per second, and how long each rings. */
  density: number;
  click: number;
  env: SynthEnvelope;
  gain: number;
  delay: number;
  filter: { type: (typeof FILTERS)[number]; hz: Sweep; q: number } | null;
  /** Soft clipping: 0 none. */
  drive: number;
  /** Bit depth (0 for none) and the factor the sample rate is divided by (1 for none). */
  crush: { bits: number; rate: number } | null;
  /** Pitch wobble for `tone` and `fm`: Hz and semitones. */
  vibrato: { rate: number; depth: number } | null;
  /** Level wobble: Hz and 0..1. */
  tremolo: { rate: number; depth: number } | null;
  /** Repeats: seconds apart, each this much quieter. */
  echo: { time: number; feedback: number; count: number } | null;
  /** 0..1: the share of a sound's takes this layer is in (1, all of them, by default). */
  chance: number;
}

/** A rendered take: mono samples at SAMPLE_RATE, and a loop for a looping sound. */
export interface RenderedSound {
  data: Float32Array;
  sampleRate: number;
  loop?: { start: number; end: number };
}

// --- reading recipes ---------------------------------------------------------------------------

const LAYER_KEYS = [...GENERATORS, "hz", "partials", "ratio", "index", "pick", "bright", "loss", "density", "click", "env", "gain", "delay", "filter", "drive", "crush", "vibrato", "tremolo", "echo", "chance"];

function sweep(reader: Reader, obj: RawObject, key: string, path: string, fallback: number): Sweep {
  const value = obj[key];
  if (value === undefined) return [fallback, fallback];
  if (typeof value === "number" && value > 0) return [value, value];
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && v > 0)) return [value[0], value[1]];
  reader.fail(joinPath(path, key), "expected a frequency above 0, or [from, to]");
  return [fallback, fallback];
}

/** An FM index: a number, or [from, to] over the layer - unlike a frequency, it may be 0. */
function readIndex(reader: Reader, obj: RawObject, path: string): Sweep {
  const value = obj.index;
  if (value === undefined) return [2, 2];
  if (typeof value === "number" && value >= 0) return [value, value];
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && v >= 0)) return [value[0], value[1]];
  reader.fail(joinPath(path, "index"), "expected an index of 0 or more, or [from, to]");
  return [2, 2];
}

/** Reads a layer's `synth` recipe. */
export function readSynth(reader: Reader, value: unknown, path: string): SynthLayer {
  const obj = reader.object(value, path);
  reader.onlyKeys(obj, path, LAYER_KEYS);
  const kinds = GENERATORS.filter((g) => obj[g] !== undefined);
  if (kinds.length !== 1) reader.fail(path, `needs exactly one generator (${GENERATORS.join(", ")}), got ${kinds.length}`);
  const kind = kinds[0] ?? "tone";
  let wave = "";
  if (kind === "tone") wave = reader.oneOf(obj, "tone", path, WAVES);
  if (kind === "noise") wave = reader.oneOf(obj, "noise", path, NOISES);
  if ((kind === "modal" || kind === "fm" || kind === "pluck" || kind === "crackle") && obj[kind] !== true) reader.fail(joinPath(path, kind), "expected true");

  const partials: [number, number, number][] = [];
  if (kind === "modal") {
    reader.array(obj, "partials", path).forEach((p, i) => {
      if (Array.isArray(p) && p.length === 3 && p.every((v) => typeof v === "number" && v > 0)) partials.push([p[0], p[1], p[2]]);
      else reader.fail(joinPath(joinPath(path, "partials"), i), "expected [ratio, level, decay seconds], each above 0");
    });
  }
  const envRaw = obj.env === undefined ? {} : reader.object(obj.env, joinPath(path, "env"));
  const envPath = joinPath(path, "env");
  reader.onlyKeys(envRaw, envPath, ["attack", "hold", "decay", "curve"]);
  const env: SynthEnvelope = {
    attack: reader.optionalNumber(envRaw, "attack", envPath, 0.005, { min: 0, max: 10 }),
    hold: reader.optionalNumber(envRaw, "hold", envPath, 0, { min: 0, max: 10 }),
    decay: reader.optionalNumber(envRaw, "decay", envPath, 0.3, { min: 0.001, max: 10 }),
    curve: reader.optionalNumber(envRaw, "curve", envPath, 2, { min: 0.2, max: 8 }),
  };
  let filter: SynthLayer["filter"] = null;
  if (obj.filter !== undefined) {
    const fp = joinPath(path, "filter");
    const f = reader.object(obj.filter, fp);
    reader.onlyKeys(f, fp, ["type", "hz", "q"]);
    filter = { type: reader.oneOf(f, "type", fp, FILTERS), hz: sweep(reader, f, "hz", fp, 1000), q: reader.optionalNumber(f, "q", fp, 0.7, { min: 0.1, max: 30 }) };
  }
  const pair = <K extends string>(key: string, keys: [K, K], ranges: [{ min: number; max: number }, { min: number; max: number }]): Record<K, number> | null => {
    if (obj[key] === undefined) return null;
    const p = joinPath(path, key);
    const o = reader.object(obj[key], p);
    reader.onlyKeys(o, p, keys);
    return { [keys[0]]: reader.number(o, keys[0], p, ranges[0]), [keys[1]]: reader.number(o, keys[1], p, ranges[1]) } as Record<K, number>;
  };
  let echo: SynthLayer["echo"] = null;
  if (obj.echo !== undefined) {
    const p = joinPath(path, "echo");
    const o = reader.object(obj.echo, p);
    reader.onlyKeys(o, p, ["time", "feedback", "count"]);
    echo = {
      time: reader.number(o, "time", p, { min: 0.01, max: 2 }),
      feedback: reader.number(o, "feedback", p, { min: 0, max: 0.95 }),
      count: reader.optionalNumber(o, "count", p, 4, { min: 1, max: 16, integer: true }),
    };
  }
  let crush: SynthLayer["crush"] = null;
  if (obj.crush !== undefined) {
    const p = joinPath(path, "crush");
    const o = reader.object(obj.crush, p);
    reader.onlyKeys(o, p, ["bits", "rate"]);
    crush = { bits: reader.optionalNumber(o, "bits", p, 0, { min: 0, max: 16, integer: true }), rate: reader.optionalNumber(o, "rate", p, 1, { min: 1, max: 64, integer: true }) };
  }
  return {
    kind,
    wave,
    hz: sweep(reader, obj, "hz", path, 440),
    partials,
    ratio: reader.optionalNumber(obj, "ratio", path, 2, { min: 0.01, max: 32 }),
    index: readIndex(reader, obj, path),
    pick: reader.optionalNumber(obj, "pick", path, 0.2, { min: 0.01, max: 0.5 }),
    bright: reader.optionalNumber(obj, "bright", path, 0.6, { min: 0.01, max: 1 }),
    loss: reader.optionalNumber(obj, "loss", path, 0.996, { min: 0.9, max: 0.9999 }),
    density: reader.optionalNumber(obj, "density", path, 40, { min: 1, max: 5000 }),
    click: reader.optionalNumber(obj, "click", path, 0.004, { min: 0.0005, max: 0.1 }),
    env,
    gain: reader.optionalNumber(obj, "gain", path, 1, { min: 0, max: 4 }),
    chance: reader.optionalNumber(obj, "chance", path, 1, { min: 0, max: 1 }),
    delay: reader.optionalNumber(obj, "delay", path, 0, { min: 0, max: 5 }),
    filter,
    drive: reader.optionalNumber(obj, "drive", path, 0, { min: 0, max: 20 }),
    crush,
    vibrato: pair("vibrato", ["rate", "depth"], [{ min: 0.1, max: 40 }, { min: 0, max: 24 }]),
    tremolo: pair("tremolo", ["rate", "depth"], [{ min: 0.1, max: 60 }, { min: 0, max: 1 }]),
    echo,
  };
}

/** How long a layer sounds, from its start: delay, envelope and echoes. */
export function layerLength(layer: SynthLayer): number {
  const body = layer.env.attack + layer.env.hold + layer.env.decay;
  const ring = layer.kind === "modal" ? Math.max(0, ...layer.partials.map((p) => p[2] * 3)) : 0;
  const echoes = layer.echo ? layer.echo.time * layer.echo.count : 0;
  return layer.delay + Math.max(body, ring) + echoes;
}

// --- rendering ---------------------------------------------------------------------------------

const TWO_PI = Math.PI * 2;

function wave(kind: string, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (kind) {
    case "triangle":
      return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    case "square":
      return p < 0.5 ? 0.7 : -0.7;
    case "saw":
      return 2 * p - 1;
    default:
      return Math.sin(TWO_PI * p);
  }
}

/** Where along a sweep, exponentially (frequencies), at fraction t. */
const along = ([from, to]: Sweep, t: number): number => from * Math.pow(to / from, Math.min(1, Math.max(0, t)));

/** The envelope's level at a time: a straight attack, a hold, then a curved fall to 0. A sustained
 *  layer (a loop) holds at 1 once the attack is over. */
function envelope(env: SynthEnvelope, t: number, sustained: boolean): number {
  if (t < env.attack) return t / env.attack;
  if (sustained) return 1;
  const d = t - env.attack - env.hold;
  if (d <= 0) return 1;
  if (d >= env.decay) return 0;
  return Math.pow(1 - d / env.decay, env.curve);
}

/** A biquad (RBJ) whose frequency can move: coefficients are worked out again every 16 samples. */
function runFilter(data: Float32Array, filter: NonNullable<SynthLayer["filter"]>, span: number): void {
  let [b0, b1, b2, a1, a2] = [0, 0, 0, 0, 0];
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i++) {
    if ((i & 15) === 0) {
      const hz = Math.min(along(filter.hz, i / span), SAMPLE_RATE * 0.45);
      const w = (TWO_PI * hz) / SAMPLE_RATE;
      const cos = Math.cos(w);
      const alpha = Math.sin(w) / (2 * filter.q);
      const a0 = 1 + alpha;
      if (filter.type === "lowpass") [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
      else if (filter.type === "highpass") [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
      else [b0, b1, b2] = [alpha, 0, -alpha];
      [b0, b1, b2, a1, a2] = [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
    }
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    data[i] = y;
  }
}

/** One layer's raw signal, `length` samples, before its envelope. */
function generate(layer: SynthLayer, length: number, rng: () => number): Float32Array {
  const out = new Float32Array(length);
  const span = Math.max(1, length);
  const vibrato = (i: number): number => (layer.vibrato ? Math.pow(2, (Math.sin((TWO_PI * layer.vibrato.rate * i) / SAMPLE_RATE) * layer.vibrato.depth) / 12) : 1);
  switch (layer.kind) {
    case "tone": {
      let phase = rng();
      for (let i = 0; i < length; i++) {
        phase += (along(layer.hz, i / span) * vibrato(i)) / SAMPLE_RATE;
        out[i] = wave(layer.wave, phase);
      }
      break;
    }
    case "noise": {
      // Pink after Paul Kellet's economy filter; brown as leaky integrated white.
      let [p0, p1, p2, brown] = [0, 0, 0, 0];
      for (let i = 0; i < length; i++) {
        const white = rng() * 2 - 1;
        if (layer.wave === "pink") {
          p0 = 0.99765 * p0 + white * 0.099046;
          p1 = 0.963 * p1 + white * 0.2965164;
          p2 = 0.57 * p2 + white * 1.0526913;
          out[i] = (p0 + p1 + p2 + white * 0.1848) * 0.25;
        } else if (layer.wave === "brown") {
          brown = (brown + white * 0.02) * 0.998;
          out[i] = brown * 3.5;
        } else out[i] = white * 0.6;
      }
      break;
    }
    case "modal": {
      // Struck partials, each ringing down on its own: bells, clangs, knocks. Slightly detuned per take.
      for (const [ratio, level, decay] of layer.partials) {
        const detune = 1 + (rng() - 0.5) * 0.01;
        let phase = rng();
        for (let i = 0; i < length; i++) {
          phase += (along(layer.hz, i / span) * ratio * detune) / SAMPLE_RATE;
          out[i] += Math.sin(TWO_PI * phase) * level * Math.exp(-i / SAMPLE_RATE / decay);
        }
      }
      break;
    }
    case "fm": {
      let carrier = 0;
      let modulator = 0;
      for (let i = 0; i < length; i++) {
        const hz = along(layer.hz, i / span) * vibrato(i);
        modulator += (hz * layer.ratio) / SAMPLE_RATE;
        const index = layer.index[0] + (layer.index[1] - layer.index[0]) * (i / span);
        carrier += hz / SAMPLE_RATE;
        out[i] = Math.sin(TWO_PI * carrier + index * Math.sin(TWO_PI * modulator));
      }
      break;
    }
    case "pluck": {
      const period = Math.max(2, Math.round(SAMPLE_RATE / layer.hz[0] - 0.5));
      out.set(pluckString(period, length, rng, layer.pick, layer.bright, layer.loss));
      break;
    }
    case "crackle": {
      // Clicks at random times, each a decaying burst: fire, embers, gravel underfoot.
      const ring = Math.max(1, Math.floor(layer.click * SAMPLE_RATE));
      const p = layer.density / SAMPLE_RATE;
      for (let i = 0; i < length; i++) {
        if (rng() >= p) continue;
        const level = 0.3 + rng() * 0.7;
        const sign = rng() < 0.5 ? -1 : 1;
        for (let k = 0; k < ring && i + k < length; k++) out[i + k] += sign * level * (rng() * 2 - 1) * Math.exp((-4 * k) / ring);
      }
      break;
    }
  }
  return out;
}

/** Renders one layer into `into`, from its delay on. `sustain`: seconds a looping sound holds. */
function renderLayer(layer: SynthLayer, into: Float32Array, rng: () => number, sustain: number): void {
  const start = Math.floor(layer.delay * SAMPLE_RATE);
  const body = sustain > 0 ? sustain : layer.env.attack + layer.env.hold + layer.env.decay;
  const ring = sustain > 0 ? 0 : layer.kind === "modal" ? Math.max(0, ...layer.partials.map((p) => p[2] * 3)) : 0;
  const length = Math.min(into.length - start, Math.floor(Math.max(body, ring) * SAMPLE_RATE));
  if (length <= 0) return;
  const data = generate(layer, length, rng);
  if (layer.filter) runFilter(data, layer.filter, length);
  // A modal layer's partials ring by their own decays; its envelope only shapes the strike.
  const sustained = sustain > 0;
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    let level = layer.kind === "modal" ? (t < layer.env.attack ? t / layer.env.attack : 1) : envelope(layer.env, t, sustained);
    if (layer.tremolo) level *= 1 - layer.tremolo.depth * (0.5 + 0.5 * Math.sin(TWO_PI * layer.tremolo.rate * t));
    data[i] *= level * layer.gain;
  }
  if (layer.drive > 0) {
    const norm = Math.tanh(layer.drive);
    for (let i = 0; i < length; i++) data[i] = Math.tanh(data[i] * layer.drive) / norm;
  }
  if (layer.crush) {
    const steps = layer.crush.bits > 0 ? Math.pow(2, layer.crush.bits - 1) : 0;
    let held = 0;
    for (let i = 0; i < length; i++) {
      if (i % layer.crush.rate === 0) held = steps > 0 ? Math.round(data[i] * steps) / steps : data[i];
      data[i] = held;
    }
  }
  for (let i = 0; i < length; i++) into[start + i] += data[i];
  if (layer.echo) {
    let level = 1;
    for (let n = 1; n <= layer.echo.count; n++) {
      level *= layer.echo.feedback;
      const offset = start + Math.floor(n * layer.echo.time * SAMPLE_RATE);
      for (let i = 0; i < length && offset + i < into.length; i++) into[offset + i] += data[i] * level;
    }
  }
}

/** Seconds of crossfade a looping sound's end gets into its start. */
const LOOP_FADE = 0.25;

/**
 * Renders a take of a sound's synth layers. A one-shot runs as long as its longest layer; a looping
 * sound (`loop` seconds) holds every layer at its sustain for that long, with its end crossfaded
 * into its start so it repeats without a click. Clipping is avoided by scaling the take down if its
 * peak passes `ceiling`, never by scaling up: layers' gains are what make sounds louder or softer.
 */
export function renderSynth(all: readonly SynthLayer[], seed: number, loop = 0, ceiling = 0.98, take?: { index: number; count: number }): RenderedSound {
  // A layer with a `chance` is in only that share of a sound's takes - at least one - so a rare ring
  // on a hit is heard now and then, never always and never not at all. Without the take's place
  // among the others, a draw decides, from a stream of its own so the other layers sound the same.
  const draw = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  const layers = all.filter((l, i) => {
    if (l.chance >= 1) return true;
    if (!take) return draw() < l.chance;
    const share = Math.max(1, Math.round(l.chance * take.count));
    // Each layer starts on a different take, so two rare layers do not always meet.
    return (take.index + i) % take.count < share;
  });
  const rng = mulberry32(seed);
  if (loop > 0) {
    const fade = Math.floor(LOOP_FADE * SAMPLE_RATE);
    const start = Math.floor(Math.max(0, ...layers.map((l) => l.delay + l.env.attack)) * SAMPLE_RATE) + fade;
    const end = start + Math.floor(loop * SAMPLE_RATE);
    const data = new Float32Array(end);
    for (const layer of layers) renderLayer(layer, data, rng, end / SAMPLE_RATE);
    crossfadeLoop(data, start, end, fade);
    limit(data, ceiling);
    return { data, sampleRate: SAMPLE_RATE, loop: { start: start / SAMPLE_RATE, end: end / SAMPLE_RATE } };
  }
  // As long as all its layers, whichever this take has, so every take of a sound is one length.
  const seconds = Math.max(0.01, ...all.map(layerLength));
  const data = new Float32Array(Math.ceil(seconds * SAMPLE_RATE));
  for (const layer of layers) renderLayer(layer, data, rng, 0);
  limit(data, ceiling);
  return { data, sampleRate: SAMPLE_RATE };
}

function limit(data: Float32Array, ceiling: number): void {
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak > ceiling) for (let i = 0; i < data.length; i++) data[i] *= ceiling / peak;
}
