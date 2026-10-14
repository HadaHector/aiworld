// Instruments: sample zones spread over the keyboard, an envelope and an auto-vibrato, as in XM.
// Until there are recorded samples, the zones are rendered here by small synths - a bowed string
// pad, a flute, a plucked string and three drums - so the player only ever plays samples and real
// recordings can replace these one instrument at a time.

import { mulberry32 } from "../world/rng";
import { hzToMidi, midiToHz } from "./theory";

export const SAMPLE_RATE = 44100;

export interface SampleZone {
  data: Float32Array;
  sampleRate: number;
  /** The pitch the sample sounds at, as a MIDI note; may be fractional. */
  root: number;
  /** The keys it plays, inclusive. */
  low: number;
  high: number;
  /** Seconds; a looped sample sustains until released. */
  loop?: { start: number; end: number };
  /** Sample level, 1 when absent. */
  gain?: number;
}

/**
 * A volume envelope as XM has it: points of [seconds, level 0..1], ramped between. It holds at the
 * sustain point until the note is released, then plays on while the instrument's release fades
 * the note out. Without a sustain point it plays through and holds its last level.
 */
export interface VolumeEnvelope {
  points: [number, number][];
  sustain?: number;
}

/** Seconds, except sustain: the level held after the decay, 0..1. */
export interface Envelope {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

export interface Instrument {
  id: string;
  name: string;
  /** Two letters for the pattern grid. */
  short: string;
  zones: SampleZone[];
  /** Attack, decay and sustain shape the note unless there is a volumeEnvelope; release always applies. */
  envelope: Envelope;
  volumeEnvelope?: VolumeEnvelope;
  /** Depth in cents, rate in Hz, delay in seconds before it fades in over `sweep` (default 0.5). */
  autoVibrato?: { depth: number; rate: number; delay: number; sweep?: number };
  gain: number;
  /** Where it sounds natural; the composer stays inside. */
  range: [number, number];
  /** Percussion: articulation name → the key that plays it. */
  keys?: Record<string, number>;
  color: string;
}

export function zoneFor(instrument: Instrument, note: number): SampleZone {
  const inside = instrument.zones.find((z) => note >= z.low && note <= z.high);
  if (inside) return inside;
  let best = instrument.zones[0];
  for (const zone of instrument.zones) if (Math.abs(zone.root - note) < Math.abs(best.root - note)) best = zone;
  return best;
}

// ---------------------------------------------------------------------------------------------
// Sample-making helpers. All rendering is plain JS at SAMPLE_RATE and seeded, so it is the same on
// every load.

function onePoleLowpass(data: Float32Array, cutoff: number): void {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
  let y = 0;
  for (let i = 0; i < data.length; i++) data[i] = y += a * (data[i] - y);
}

function onePoleHighpass(data: Float32Array, cutoff: number): void {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
  let low = 0;
  for (let i = 0; i < data.length; i++) {
    low += a * (data[i] - low);
    data[i] -= low;
  }
}

function normalize(data: Float32Array, peak: number): void {
  let max = 0;
  for (const v of data) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < data.length; i++) data[i] *= peak / max;
}

/**
 * Blends the end of the loop into what comes before its start, so the jump back is seamless: the
 * last samples of the loop become the samples just before loopStart.
 */
function crossfadeLoop(data: Float32Array, start: number, end: number, fade: number): void {
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const a = Math.sqrt(1 - t);
    const b = Math.sqrt(t);
    data[end - fade + i] = data[end - fade + i] * a + data[start - fade + i] * b;
  }
}

/** One cycle of a waveform from harmonic amplitudes, kept under the Nyquist limit for `hz`. */
function wavetable(harmonics: (h: number) => number, hz: number, size = 2048): Float32Array {
  const table = new Float32Array(size);
  const count = Math.min(80, Math.floor((SAMPLE_RATE * 0.42) / hz));
  for (let h = 1; h <= count; h++) {
    const amp = harmonics(h);
    if (amp === 0) continue;
    for (let i = 0; i < size; i++) table[i] += amp * Math.sin((2 * Math.PI * h * i) / size);
  }
  return table;
}

function readTable(table: Float32Array, phase: number): number {
  const x = phase * table.length;
  const i = Math.floor(x);
  const f = x - i;
  return table[i % table.length] * (1 - f) + table[(i + 1) % table.length] * f;
}

function zone(data: Float32Array, root: number, low: number, high: number, loop?: { start: number; end: number }): SampleZone {
  return { data, sampleRate: SAMPLE_RATE, root, low, high, loop };
}

/** Roots every `step` semitones from `low` to `high`, each zone covering the keys around its root. */
function spread(low: number, high: number, step: number, render: (root: number) => SampleZone): SampleZone[] {
  const zones: SampleZone[] = [];
  for (let root = low + Math.floor(step / 2); root - Math.floor(step / 2) <= high; root += step) {
    const z = render(root);
    z.low = root - Math.floor(step / 2);
    z.high = root - Math.floor(step / 2) + step - 1;
    zones.push(z);
  }
  return zones;
}

// ---------------------------------------------------------------------------------------------
// The synths.

/** Bowed strings: four slightly detuned saws, softened, with a slow uneven bow. Looped. */
function renderStrings(root: number, seed: number): SampleZone {
  const rng = mulberry32(seed);
  const hz = midiToHz(root);
  const length = Math.floor(3.4 * SAMPLE_RATE);
  const data = new Float32Array(length);
  const table = wavetable((h) => 1 / h, hz * 1.01);
  for (const cents of [-8, -2.5, 3, 7.5]) {
    const step = (hz * 2 ** (cents / 1200)) / SAMPLE_RATE;
    let phase = rng();
    const bowRate = 0.25 + rng() * 0.4;
    const bowPhase = rng() * Math.PI * 2;
    for (let i = 0; i < length; i++) {
      const bow = 1 + 0.12 * Math.sin((2 * Math.PI * bowRate * i) / SAMPLE_RATE + bowPhase);
      data[i] += readTable(table, phase) * bow;
      phase = (phase + step) % 1;
    }
  }
  const cutoff = Math.min(hz * 5, 4200);
  onePoleLowpass(data, cutoff);
  onePoleLowpass(data, cutoff * 1.5);
  normalize(data, 0.8);
  const start = Math.floor(0.7 * SAMPLE_RATE);
  const end = Math.floor(3.3 * SAMPLE_RATE);
  crossfadeLoop(data, start, end, Math.floor(0.6 * SAMPLE_RATE));
  return zone(data, root, root, root, { start: start / SAMPLE_RATE, end: end / SAMPLE_RATE });
}

/** How a flute is blown: its harmonics, and how much breath goes past the edge. */
interface Blown {
  harmonics: number[];
  breath: number;
  chiff: number;
}

const FLUTE: Blown = { harmonics: [1, 0.32, 0.12, 0.06, 0.03, 0.015], breath: 0.05, chiff: 0.5 };
/** The ney: an end-blown reed flute, hollow and very breathy. */
const NEY: Blown = { harmonics: [1, 0.12, 0.22, 0.05, 0.06, 0.02], breath: 0.16, chiff: 0.8 };

/** Flute: a nearly pure tone with a little second harmonic, breath noise and a chiff. Looped. */
function renderFlute(root: number, seed: number, blown: Blown = FLUTE): SampleZone {
  const rng = mulberry32(seed);
  const hz = midiToHz(root);
  const length = Math.floor(2.6 * SAMPLE_RATE);
  const data = new Float32Array(length);
  const table = wavetable((h) => blown.harmonics[h - 1] ?? 0, hz);
  const step = hz / SAMPLE_RATE;
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const wobble = 1 + 0.03 * Math.sin((2 * Math.PI * 3.1 * i) / SAMPLE_RATE);
    data[i] = readTable(table, phase) * wobble;
    phase = (phase + step) % 1;
  }
  const breath = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const chiff = Math.exp(-i / (0.035 * SAMPLE_RATE));
    breath[i] = (rng() * 2 - 1) * (blown.breath + blown.chiff * chiff);
  }
  onePoleLowpass(breath, Math.min(hz * 3, 5000));
  onePoleHighpass(breath, hz * 0.7);
  for (let i = 0; i < length; i++) data[i] += breath[i];
  normalize(data, 0.8);
  const start = Math.floor(0.5 * SAMPLE_RATE);
  const end = Math.floor(2.5 * SAMPLE_RATE);
  crossfadeLoop(data, start, end, Math.floor(0.4 * SAMPLE_RATE));
  return zone(data, root, root, root, { start: start / SAMPLE_RATE, end: end / SAMPLE_RATE });
}

/**
 * A plucked gut string (lute or guitar), Karplus-Strong: a burst of noise circulating in a delay
 * line one period long, averaged a little on every pass so the high partials die first. The delay is
 * a whole number of samples, so the zone's root is the pitch that actually comes out.
 */
function renderPluck(root: number, seed: number, string: PluckedString = GUT): SampleZone {
  const rng = mulberry32(seed);
  const period = Math.max(2, Math.round(SAMPLE_RATE / midiToHz(root) - 0.5));
  const length = Math.floor(string.seconds * SAMPLE_RATE);
  const data = new Float32Array(length);
  const burst = new Float32Array(period);
  for (let i = 0; i < period; i++) burst[i] = rng() * 2 - 1;
  // Where along the string it is plucked: that comb takes out some partials; the lowpass makes it
  // a finger rather than a pick.
  const pick = Math.max(1, Math.floor(period * string.pick));
  for (let i = period - 1; i >= pick; i--) burst[i] -= burst[i - pick];
  let y = 0;
  for (let i = 0; i < period; i++) burst[i] = y += string.bright * (burst[i] - y);
  const loss = string.loss;
  for (let i = 0; i < length; i++) {
    if (i < period) data[i] = burst[i];
    else data[i] = loss * 0.5 * (data[i - period] + data[i - period - 1 >= 0 ? i - period - 1 : 0]);
  }
  onePoleHighpass(data, 60);
  onePoleLowpass(data, string.lowpass);
  normalize(data, 0.9);
  const actual = hzToMidi(SAMPLE_RATE / (period + 0.5));
  return zone(data, actual, root, root);
}

interface PluckedString {
  /** Fraction of the string from the end where it is plucked. */
  pick: number;
  /** 0..1: how much of the burst's top end survives the finger. */
  bright: number;
  /** Per-pass loss: closer to 1 rings longer. */
  loss: number;
  lowpass: number;
  seconds: number;
}

const GUT: PluckedString = { pick: 0.2, bright: 0.5, loss: 0.9965, lowpass: 5000, seconds: 3 };
const HARP: PluckedString = { pick: 0.12, bright: 0.8, loss: 0.9982, lowpass: 7500, seconds: 4.5 };
/** Oud: picked with a plectrum near the bridge, no frets, a short dark ring. */
const OUD: PluckedString = { pick: 0.08, bright: 0.7, loss: 0.9945, lowpass: 4200, seconds: 2.2 };

/** RBJ band-pass, constant peak gain, run in place. */
function bandpass(data: Float32Array, hz: number, q: number): Float32Array {
  const w = (2 * Math.PI * hz) / SAMPLE_RATE;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const [b0, b2, a1, a2] = [alpha / a0, -alpha / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0];
  const out = new Float32Array(data.length);
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const yv = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = yv;
    [x2, x1, y2, y1] = [x1, x, y1, yv];
  }
  return out;
}

/**
 * A soft choir pad: detuned saws through vowel formants, between "ooh" and "aah", with a breath of
 * noise. Looped. Library choirs (aahh, oohh) can replace it.
 */
function renderChoir(root: number, seed: number): SampleZone {
  const rng = mulberry32(seed);
  const hz = midiToHz(root);
  const length = Math.floor(3.6 * SAMPLE_RATE);
  const source = new Float32Array(length);
  const table = wavetable((h) => 1 / h, hz * 1.01);
  for (const cents of [-11, -4, 3, 9, 14]) {
    const step = (hz * 2 ** (cents / 1200)) / SAMPLE_RATE;
    let phase = rng();
    const swell = 0.2 + rng() * 0.3;
    const offset = rng() * Math.PI * 2;
    for (let i = 0; i < length; i++) {
      source[i] += readTable(table, phase) * (1 + 0.15 * Math.sin((2 * Math.PI * swell * i) / SAMPLE_RATE + offset));
      phase = (phase + step) % 1;
    }
  }
  for (let i = 0; i < length; i++) source[i] += (rng() * 2 - 1) * 0.15;
  // Formants of a vowel between "oo" (300, 870 Hz) and "ah" (700, 1100 Hz), plus a little air.
  const f1 = bandpass(source, 480, 4);
  const f2 = bandpass(source, 980, 6);
  const f3 = bandpass(source, 2600, 8);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = f1[i] + 0.5 * f2[i] + 0.12 * f3[i];
  onePoleLowpass(data, 3500);
  normalize(data, 0.8);
  const start = Math.floor(0.8 * SAMPLE_RATE);
  const end = Math.floor(3.5 * SAMPLE_RATE);
  crossfadeLoop(data, start, end, Math.floor(0.7 * SAMPLE_RATE));
  return zone(data, root, root, root, { start: start / SAMPLE_RATE, end: end / SAMPLE_RATE });
}

/** French horn: a round brass tone, its upper partials kept low, two players a little apart. Looped. */
function renderHorn(root: number, seed: number): SampleZone {
  const rng = mulberry32(seed);
  const hz = midiToHz(root);
  const length = Math.floor(3 * SAMPLE_RATE);
  const data = new Float32Array(length);
  const table = wavetable((h) => 1 / h ** 1.25, hz * 1.005);
  for (const cents of [-3, 4]) {
    const step = (hz * 2 ** (cents / 1200)) / SAMPLE_RATE;
    let phase = rng();
    for (let i = 0; i < length; i++) {
      data[i] += readTable(table, phase) * (1 + 0.05 * Math.sin((2 * Math.PI * 0.6 * i) / SAMPLE_RATE + cents));
      phase = (phase + step) % 1;
    }
  }
  const cutoff = Math.min(hz * 3.5, 2400);
  onePoleLowpass(data, cutoff);
  onePoleLowpass(data, cutoff);
  normalize(data, 0.8);
  const start = Math.floor(0.5 * SAMPLE_RATE);
  const end = Math.floor(2.9 * SAMPLE_RATE);
  crossfadeLoop(data, start, end, Math.floor(0.5 * SAMPLE_RATE));
  return zone(data, root, root, root, { start: start / SAMPLE_RATE, end: end / SAMPLE_RATE });
}

/** A bell or celesta: two-operator FM at an inharmonic ratio, bright at the strike, ringing long. */
function renderBell(root: number): SampleZone {
  const hz = midiToHz(root);
  const data = render(4, (t) => {
    const index = 2.2 * Math.exp(-t / 0.25) + 0.4 * Math.exp(-t / 1.5);
    const body = Math.sin(2 * Math.PI * hz * t + index * Math.sin(2 * Math.PI * hz * 3.5 * t));
    const shimmer = 0.25 * Math.sin(2 * Math.PI * hz * 2.76 * t) * Math.exp(-t / 0.6);
    return (body * Math.exp(-t / 1.6) + shimmer) * Math.min(1, t / 0.002);
  });
  normalize(data, 0.85);
  return zone(data, root, root, root);
}

function render(seconds: number, sample: (t: number, i: number) => number): Float32Array {
  const data = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  for (let i = 0; i < data.length; i++) data[i] = sample(i / SAMPLE_RATE, i);
  return data;
}

/** A sine whose pitch falls from `from` to `to` Hz with time constant `drop`, decaying with `decay`. */
function thump(from: number, to: number, drop: number, decay: number, seconds: number): Float32Array {
  let phase = 0;
  return render(seconds, (t) => {
    const hz = to + (from - to) * Math.exp(-t / drop);
    phase += hz / SAMPLE_RATE;
    return Math.sin(2 * Math.PI * phase) * Math.exp(-t / decay);
  });
}

function noise(seed: number, seconds: number, decay: number, low: number, high: number): Float32Array {
  const rng = mulberry32(seed);
  const data = render(seconds, (t) => (rng() * 2 - 1) * Math.exp(-t / decay));
  onePoleHighpass(data, low);
  onePoleLowpass(data, high);
  return data;
}

function mix(...parts: [Float32Array, number][]): Float32Array {
  const length = Math.max(...parts.map(([d]) => d.length));
  const out = new Float32Array(length);
  for (const [data, gain] of parts) for (let i = 0; i < data.length; i++) out[i] += data[i] * gain;
  normalize(out, 0.9);
  return out;
}

function frameDrum(seed: number): SampleZone[] {
  const dum = mix([thump(125, 82, 0.05, 0.22, 1), 1], [noise(seed, 1, 0.03, 80, 900), 0.5]);
  const tek = mix([thump(380, 330, 0.02, 0.05, 0.35), 0.6], [noise(seed + 1, 0.35, 0.02, 900, 4000), 1]);
  return [zone(dum, 60, 60, 60), zone(tek, 62, 62, 62)];
}

function tambourine(seed: number): SampleZone[] {
  const jingles = (s: number, decay: number): Float32Array => {
    const rng = mulberry32(s);
    const partials = Array.from({ length: 7 }, () => ({ hz: 5500 + rng() * 5000, phase: rng() }));
    return render(0.6, (t) => {
      let sum = 0;
      for (const p of partials) sum += Math.sin(2 * Math.PI * (p.hz * t + p.phase));
      return (sum / partials.length) * Math.exp(-t / decay) * Math.min(1, t / 0.004);
    });
  };
  const shake = mix([jingles(seed, 0.07), 0.8], [noise(seed + 2, 0.6, 0.05, 5000, 12000), 1]);
  const hit = mix([jingles(seed + 3, 0.16), 1], [noise(seed + 4, 0.6, 0.08, 4000, 12000), 0.8], [thump(220, 180, 0.01, 0.03, 0.6), 0.6]);
  return [zone(shake, 60, 60, 60), zone(hit, 62, 62, 62)];
}

/** Darbuka: the doum, deep from the middle of the head, and the tek, a sharp crack at its rim. */
function darbuka(seed: number): SampleZone[] {
  const doum = mix([thump(140, 88, 0.025, 0.32, 1.2), 1], [noise(seed, 1.2, 0.012, 200, 2500), 0.35]);
  const tek = mix([noise(seed + 1, 0.3, 0.018, 2200, 9000), 1], [thump(720, 640, 0.01, 0.04, 0.3), 0.5]);
  return [zone(doum, 60, 60, 60), zone(tek, 62, 62, 62)];
}

/** Timpani: a tuned kettle, a clear low pitch with its inharmonic partials, struck soft. */
function timpani(seed: number): SampleZone[] {
  const f = 73;
  const partials: [number, number, number][] = [[1, 1, 2.2], [1.5, 0.5, 1.2], [1.98, 0.3, 0.9], [2.44, 0.15, 0.6]];
  const body = render(3, (t) => partials.reduce((sum, [ratio, amp, decay]) => sum + amp * Math.sin(2 * Math.PI * f * ratio * t) * Math.exp(-t / decay), 0) * Math.min(1, t / 0.004));
  return [zone(mix([body, 1], [noise(seed, 3, 0.03, 60, 700), 0.35]), 60, 60, 60)];
}

function lowDrum(seed: number): SampleZone[] {
  const boom = mix([thump(78, 46, 0.09, 0.5, 2), 1], [noise(seed, 2, 0.02, 40, 400), 0.4]);
  return [zone(boom, 60, 60, 60)];
}

/** Every instrument there is, by id. */
export function createInstruments(): Record<string, Instrument> {
  const strings = spread(33, 84, 6, (r) => renderStrings(r, 1000 + r));
  const list: Instrument[] = [
    {
      id: "strings",
      name: "Strings",
      short: "st",
      zones: strings,
      envelope: { attack: 0.5, decay: 0.6, sustain: 0.85, release: 1.4 },
      autoVibrato: { depth: 6, rate: 4.6, delay: 0.6 },
      gain: 0.32,
      range: [36, 81],
      color: "#7fa7d9",
    },
    {
      id: "bass",
      name: "Bass",
      short: "bs",
      zones: strings,
      envelope: { attack: 0.5, decay: 0.6, sustain: 0.85, release: 1.4 },
      autoVibrato: { depth: 6, rate: 4.6, delay: 0.6 },
      gain: 0.32,
      range: [33, 60],
      color: "#4f6fa8",
    },
    {
      id: "flute",
      name: "Flute",
      short: "fl",
      zones: spread(59, 98, 6, (r) => renderFlute(r, 2000 + r)),
      envelope: { attack: 0.07, decay: 0.25, sustain: 0.85, release: 0.25 },
      autoVibrato: { depth: 14, rate: 5.2, delay: 0.35 },
      gain: 0.42,
      range: [62, 93],
      color: "#e7c26a",
    },
    {
      id: "guitar",
      name: "Guitar",
      short: "gt",
      zones: spread(38, 79, 5, (r) => renderPluck(r, 3000 + r)),
      envelope: { attack: 0.002, decay: 0, sustain: 1, release: 0.5 },
      gain: 0.5,
      range: [40, 76],
      color: "#d98a5f",
    },
    {
      id: "choir",
      name: "Choir",
      short: "ch",
      zones: spread(45, 84, 6, (r) => renderChoir(r, 7000 + r)),
      envelope: { attack: 0.9, decay: 0.8, sustain: 0.85, release: 2 },
      autoVibrato: { depth: 8, rate: 4.2, delay: 0.8, sweep: 1.5 },
      gain: 0.3,
      range: [48, 79],
      color: "#d8c8ec",
    },
    {
      id: "harp",
      name: "Harp",
      short: "hp",
      zones: spread(36, 96, 5, (r) => renderPluck(r, 8000 + r, HARP)),
      envelope: { attack: 0.002, decay: 0, sustain: 1, release: 1.2 },
      gain: 0.42,
      range: [40, 91],
      color: "#e8a6b8",
    },
    {
      id: "bells",
      name: "Bells",
      short: "bl",
      zones: spread(60, 102, 6, (r) => renderBell(r)),
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 1.5 },
      gain: 0.22,
      range: [72, 98],
      color: "#9fe0e6",
    },
    {
      id: "ney",
      name: "Ney",
      short: "ny",
      zones: spread(55, 96, 6, (r) => renderFlute(r, 9000 + r, NEY)),
      envelope: { attack: 0.12, decay: 0.3, sustain: 0.85, release: 0.35 },
      autoVibrato: { depth: 10, rate: 5, delay: 0.5 },
      gain: 0.42,
      range: [60, 89],
      color: "#e0b36a",
    },
    {
      id: "oud",
      name: "Oud",
      short: "od",
      zones: spread(36, 79, 5, (r) => renderPluck(r, 10000 + r, OUD)),
      envelope: { attack: 0.002, decay: 0, sustain: 1, release: 0.4 },
      gain: 0.5,
      range: [40, 76],
      color: "#c8794a",
    },
    {
      id: "darbuka",
      name: "Darbuka",
      short: "db",
      zones: darbuka(11000),
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.25 },
      gain: 0.55,
      range: [60, 62],
      keys: { dum: 60, tek: 62 },
      color: "#b9a66f",
    },
    {
      id: "horn",
      name: "Horn",
      short: "hn",
      zones: spread(36, 84, 6, (r) => renderHorn(r, 12000 + r)),
      envelope: { attack: 0.2, decay: 0.4, sustain: 0.85, release: 0.7 },
      autoVibrato: { depth: 5, rate: 4.8, delay: 0.7 },
      gain: 0.4,
      range: [45, 77],
      color: "#d9b26a",
    },
    {
      id: "timpani",
      name: "Timpani",
      short: "tp",
      zones: timpani(13000),
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 1 },
      gain: 0.6,
      range: [60, 60],
      keys: { boom: 60 },
      color: "#9fb3c8",
    },
    {
      id: "frameDrum",
      name: "Frame drum",
      short: "fd",
      zones: frameDrum(4000),
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.3 },
      gain: 0.55,
      range: [60, 62],
      keys: { dum: 60, tek: 62 },
      color: "#a8c47a",
    },
    {
      id: "tambourine",
      name: "Tambourine",
      short: "tb",
      zones: tambourine(5000),
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.2 },
      gain: 0.3,
      range: [60, 62],
      keys: { shake: 60, hit: 62 },
      color: "#c9a3d9",
    },
    {
      id: "lowDrum",
      name: "Low drum",
      short: "ld",
      zones: lowDrum(6000),
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.6 },
      gain: 0.6,
      range: [60, 60],
      keys: { boom: 60 },
      color: "#8fc4b8",
    },
  ];
  return Object.fromEntries(list.map((i) => [i.id, i]));
}
