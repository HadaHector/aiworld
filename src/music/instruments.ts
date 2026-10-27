// Instruments: sample zones spread over the keyboard, an envelope and an auto-vibrato, as in XM.
// Until there are recorded samples, the zones are rendered here by small synths - a bowed string
// pad, a flute, a plucked string and three drums - so the player only ever plays samples and real
// recordings can replace these one instrument at a time.

import { mulberry32 } from "../world/rng";
import { bandpass, crossfadeLoop, mix, normalize, onePoleHighpass, onePoleLowpass, pluckString, readTable, render, SAMPLE_RATE, wavetable } from "../audio/dsp";
import { hzToMidi, midiToHz } from "./theory";

export { SAMPLE_RATE };


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
// Sample-making helpers (the shared ones are in src/audio/dsp.ts).







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

/** Bowed strings: four slightly detuned saws, softened, with a slow uneven bow. Looped. `bright` sets the tone: cellos dark, violins bright. */
function renderStrings(root: number, seed: number, bright = 5, players = [-8, -2.5, 3, 7.5]): SampleZone {
  const rng = mulberry32(seed);
  const hz = midiToHz(root);
  const length = Math.floor(3.4 * SAMPLE_RATE);
  const data = new Float32Array(length);
  const table = wavetable((h) => 1 / h, hz * 1.01);
  for (const cents of players) {
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
  const cutoff = Math.min(hz * bright, 4200);
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
/** Clarinet, low: a cylinder bore, so the odd harmonics, dark and hollow. */
const CLARINET: Blown = { harmonics: [1, 0.04, 0.5, 0.03, 0.25, 0.02, 0.12, 0.01, 0.06], breath: 0.025, chiff: 0.15 };
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
  const data = pluckString(period, Math.floor(string.seconds * SAMPLE_RATE), rng, string.pick, string.bright, string.loss);
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
/** Mandolin: paired steel strings picked hard, bright and quick to fade. */
const MANDOLIN: PluckedString = { pick: 0.12, bright: 0.85, loss: 0.993, lowpass: 7000, seconds: 1.4 };
/** Pizzicato: a bowed string plucked with the finger, dull and short. */
const PIZZ: PluckedString = { pick: 0.3, bright: 0.45, loss: 0.988, lowpass: 2800, seconds: 1.2 };
/** Oud: picked with a plectrum near the bridge, no frets, a short dark ring. */
const OUD: PluckedString = { pick: 0.08, bright: 0.7, loss: 0.9945, lowpass: 4200, seconds: 2.2 };


/**
 * A soft choir pad: detuned saws through vowel formants, between "ooh" and "aah", with a breath of
 * noise. Looped. Library choirs (aahh, oohh) can replace it.
 */
/** Where a choir's vowel sits: its first three formants, in Hz. Women sing them higher than men. */
const MIXED_VOWEL: [number, number, number] = [480, 980, 2600];
const WOMEN_VOWEL: [number, number, number] = [620, 1150, 2900];
const MEN_VOWEL: [number, number, number] = [420, 850, 2400];

function renderChoir(root: number, seed: number, vowel = MIXED_VOWEL): SampleZone {
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
  const f1 = bandpass(source, vowel[0], 4);
  const f2 = bandpass(source, vowel[1], 6);
  const f3 = bandpass(source, vowel[2], 8);
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

/**
 * A music box: a steel tine and its bright overtones, with a second tine a few cents off so the
 * two beat against each other - a little out of tune, as old ones are.
 */
function renderMusicBox(root: number): SampleZone {
  const hz = midiToHz(root);
  const off = hz * 2 ** (7 / 1200);
  const data = render(2.5, (t) => {
    const tine = Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / 1.1) + 0.5 * Math.sin(2 * Math.PI * off * t) * Math.exp(-t / 0.9);
    const over = 0.3 * Math.sin(2 * Math.PI * hz * 2 * t) * Math.exp(-t / 0.35) + 0.2 * Math.sin(2 * Math.PI * hz * 5.4 * t) * Math.exp(-t / 0.07);
    return (tine + over) * Math.min(1, t / 0.001);
  });
  normalize(data, 0.85);
  return zone(data, root, root, root);
}

/** A drop of water: a short ping whose pitch rises as the bubble closes. */
function renderDrip(root: number): SampleZone {
  const hz = midiToHz(root);
  let phase = 0;
  const data = render(0.6, (t) => {
    phase += (hz * (1 + 0.7 * (1 - Math.exp(-t / 0.025)))) / SAMPLE_RATE;
    return Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.11) * Math.min(1, t / 0.002);
  });
  normalize(data, 0.85);
  const actual = hzToMidi(hz * 1.7);
  return zone(data, actual, root, root);
}

/** A ghost of a voice, or a theremin: nearly a pure sine, wavering. Looped. */
function renderGhost(root: number): SampleZone {
  const hz = midiToHz(root);
  const data = render(2.4, (t) => {
    const p = 2 * Math.PI * hz * t;
    return (Math.sin(p) + 0.12 * Math.sin(2 * p) + 0.05 * Math.sin(3 * p)) * (1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t));
  });
  normalize(data, 0.8);
  const start = Math.floor(0.4 * SAMPLE_RATE);
  const end = Math.floor(2.3 * SAMPLE_RATE);
  crossfadeLoop(data, start, end, Math.floor(0.4 * SAMPLE_RATE));
  return zone(data, root, root, root, { start: start / SAMPLE_RATE, end: end / SAMPLE_RATE });
}

/**
 * Wind: noise through a resonant band around the note, with a fainter band above it and a low
 * rush beneath, fluttering. Sliding the note moves the howl; loud and soft is the gust. Looped.
 */
function renderWind(root: number, seed: number): SampleZone {
  const rng = mulberry32(seed);
  const hz = midiToHz(root);
  const length = Math.floor(6 * SAMPLE_RATE);
  const white = new Float32Array(length);
  for (let i = 0; i < length; i++) white[i] = rng() * 2 - 1;
  const howl = bandpass(white, hz, 7);
  const whistle = bandpass(white, hz * 2.1, 12);
  const rush = white.slice();
  onePoleLowpass(rush, Math.min(hz * 1.5, 1200));
  onePoleLowpass(rush, Math.min(hz * 1.5, 1200));
  const data = new Float32Array(length);
  const flutter = rng() * Math.PI * 2;
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    const f = 1 + 0.25 * Math.sin(2 * Math.PI * 0.31 * t + flutter) + 0.15 * Math.sin(2 * Math.PI * 0.83 * t + flutter * 2);
    data[i] = (howl[i] + 0.35 * whistle[i] + 0.5 * rush[i]) * f;
  }
  normalize(data, 0.8);
  const start = Math.floor(1 * SAMPLE_RATE);
  const end = Math.floor(5.9 * SAMPLE_RATE);
  crossfadeLoop(data, start, end, Math.floor(1 * SAMPLE_RATE));
  return zone(data, root, root, root, { start: start / SAMPLE_RATE, end: end / SAMPLE_RATE });
}

/** Accordion: three reeds a little apart (the musette), reedy and nasal, the bellows breathing. Looped. */
function renderAccordion(root: number, seed: number): SampleZone {
  const rng = mulberry32(seed);
  const hz = midiToHz(root);
  const length = Math.floor(2.6 * SAMPLE_RATE);
  const data = new Float32Array(length);
  const table = wavetable((h) => (h % 2 === 1 ? 1 / h : 0.35 / h), hz * 1.02);
  for (const cents of [-11, 0, 12]) {
    const step = (hz * 2 ** (cents / 1200)) / SAMPLE_RATE;
    let phase = rng();
    for (let i = 0; i < length; i++) {
      data[i] += readTable(table, phase);
      phase = (phase + step) % 1;
    }
  }
  for (let i = 0; i < length; i++) data[i] *= 1 + 0.06 * Math.sin((2 * Math.PI * 0.9 * i) / SAMPLE_RATE);
  const cutoff = Math.min(hz * 7, 5000);
  onePoleLowpass(data, cutoff);
  normalize(data, 0.8);
  const start = Math.floor(0.4 * SAMPLE_RATE);
  const end = Math.floor(2.5 * SAMPLE_RATE);
  crossfadeLoop(data, start, end, Math.floor(0.4 * SAMPLE_RATE));
  return zone(data, root, root, root, { start: start / SAMPLE_RATE, end: end / SAMPLE_RATE });
}

/**
 * Marimba: a rosewood bar over its tube, the fundamental and the bar's tuned fourth partial, a
 * bright tick from the mallet; low bars ring longer.
 */
function renderMarimba(root: number, seed: number): SampleZone {
  const hz = midiToHz(root);
  const ring = 0.25 + 0.9 * Math.max(0, (84 - root) / 48);
  const bar = render(1.6, (t) => (Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / ring) + 0.3 * Math.sin(2 * Math.PI * hz * 3.93 * t) * Math.exp(-t / 0.06) + 0.08 * Math.sin(2 * Math.PI * hz * 9.2 * t) * Math.exp(-t / 0.015)) * Math.min(1, t / 0.0015));
  const data = mix([bar, 1], [noise(seed, 1.6, 0.004, 1500, 8000), 0.25]);
  return zone(data, root, root, root);
}

/** A bird: a quick whistled chirp sliding down onto its note, warbling as it goes. */
function renderBird(root: number, seed: number): SampleZone {
  const rng = mulberry32(seed);
  const hz = midiToHz(root);
  const warble = 18 + rng() * 14;
  let phase = 0;
  const data = render(0.4, (t) => {
    const pitch = hz * (1 + 0.35 * Math.exp(-t / 0.04)) * (1 + 0.04 * Math.sin(2 * Math.PI * warble * t));
    phase += pitch / SAMPLE_RATE;
    return Math.sin(2 * Math.PI * phase) * Math.min(1, t / 0.006) * Math.exp(-t / 0.09);
  });
  normalize(data, 0.85);
  return zone(data, root, root, root);
}

/**
 * Bagpipe drones and chanter: a buzzing reed, every harmonic there and the middle ones pushed up
 * (the nasal edge), steady as only bagpipes are. Looped.
 */
function renderPipes(root: number, seed: number): SampleZone {
  const rng = mulberry32(seed);
  const hz = midiToHz(root);
  const length = Math.floor(2.4 * SAMPLE_RATE);
  const data = new Float32Array(length);
  const table = wavetable((h) => (h >= 3 && h <= 9 ? 1.6 : 1) / h, hz * 1.01);
  for (const cents of [-2, 2]) {
    const step = (hz * 2 ** (cents / 1200)) / SAMPLE_RATE;
    let phase = rng();
    for (let i = 0; i < length; i++) {
      data[i] += readTable(table, phase);
      phase = (phase + step) % 1;
    }
  }
  onePoleLowpass(data, Math.min(hz * 12, 6000));
  normalize(data, 0.8);
  const start = Math.floor(0.3 * SAMPLE_RATE);
  const end = Math.floor(2.3 * SAMPLE_RATE);
  crossfadeLoop(data, start, end, Math.floor(0.25 * SAMPLE_RATE));
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

/** Knocks: a hollow log drum (dum) and a dry wood block (tek). */
function knock(seed: number): SampleZone[] {
  const partial = (hz: number, decay: number, seconds: number): Float32Array => render(seconds, (t) => Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / decay) * Math.min(1, t / 0.0008));
  const log = mix([partial(165, 0.28, 1.2), 1], [partial(165 * 2.76, 0.07, 1.2), 0.5], [noise(seed, 1.2, 0.006, 300, 4000), 0.4]);
  const block = mix([partial(940, 0.045, 0.4), 1], [partial(2550, 0.02, 0.4), 0.6], [noise(seed + 1, 0.4, 0.004, 1500, 9000), 0.5]);
  return [zone(log, 60, 60, 60), zone(block, 62, 62, 62)];
}

/** Hand claps from a few people in a crowd, each a little early or late, each clap a quick flutter. */
function claps(seed: number): SampleZone[] {
  const rng = mulberry32(seed);
  const out = new Float32Array(Math.floor(0.4 * SAMPLE_RATE));
  for (let person = 0; person < 5; person++) {
    const at = rng() * 0.025;
    const hand = noise(seed + person, 0.35, 0.045, 700 + rng() * 500, 2500 + rng() * 1500);
    const offset = Math.floor(at * SAMPLE_RATE);
    for (let i = 0; i < hand.length && offset + i < out.length; i++) {
      // Palms meeting: three quick bursts before the ring.
      const t = i / SAMPLE_RATE;
      const flutter = t < 0.02 ? 0.5 + 0.5 * Math.cos(2 * Math.PI * t * 150) : 1;
      out[offset + i] += hand[i] * flutter * (0.7 + 0.3 * rng());
    }
  }
  normalize(out, 0.9);
  return [zone(out, 60, 60, 60)];
}

/** Taiko: the big drum struck in the middle (dum), deep and long, and a smaller drum (tek). */
function taiko(seed: number): SampleZone[] {
  const big = mix([thump(96, 50, 0.05, 0.8, 2.6), 1], [noise(seed, 2.6, 0.025, 40, 700), 0.5]);
  const small = mix([thump(210, 150, 0.02, 0.2, 0.9), 1], [noise(seed + 1, 0.9, 0.012, 300, 3500), 0.6]);
  return [zone(big, 60, 60, 60), zone(small, 62, 62, 62)];
}

/** Shaker: seeds in a gourd - a soft shake, and a harder accented one. */
function shaker(seed: number): SampleZone[] {
  const grains = (s: number, attack: number, decay: number): Float32Array => {
    const data = noise(s, 0.3, decay, 3500, 12000);
    for (let i = 0; i < data.length; i++) data[i] *= Math.min(1, i / (attack * SAMPLE_RATE));
    return data;
  };
  const shake = mix([grains(seed, 0.012, 0.05), 1]);
  const hit = mix([grains(seed + 1, 0.003, 0.035), 1], [noise(seed + 2, 0.3, 0.01, 1500, 6000), 0.4]);
  return [zone(shake, 60, 60, 60), zone(hit, 62, 62, 62)];
}

/** Castanets: two shells of hard wood clapping - a single click, and a quick roll of them. */
function castanets(seed: number): SampleZone[] {
  const click = (s: number, at: number, level: number, length: number): Float32Array => {
    const out = new Float32Array(Math.floor(length * SAMPLE_RATE));
    const body = mix([render(0.08, (t) => Math.sin(2 * Math.PI * 2300 * t) * Math.exp(-t / 0.012)), 1], [noise(s, 0.08, 0.006, 1500, 9000), 0.8]);
    const offset = Math.floor(at * SAMPLE_RATE);
    for (let i = 0; i < body.length && offset + i < out.length; i++) out[offset + i] += body[i] * level;
    return out;
  };
  const one = click(seed, 0, 1, 0.12);
  const roll = mix(...[0, 0.035, 0.07, 0.1].map((at, i): [Float32Array, number] => [click(seed + i, at, 0.6 + 0.15 * i, 0.25), 1]));
  return [zone(mix([one, 1]), 60, 60, 60), zone(roll, 62, 62, 62)];
}

function lowDrum(seed: number): SampleZone[] {
  const boom = mix([thump(78, 46, 0.09, 0.5, 2), 1], [noise(seed, 2, 0.02, 40, 400), 0.4]);
  return [zone(boom, 60, 60, 60)];
}

/** Every instrument there is, by id. */
export function createInstruments(): Record<string, Instrument> {
  // Rendering every synth takes seconds: each instrument's zones are rendered the first time they
  // are asked for, and kept.
  const rendered = new Map<string, SampleZone[]>();
  const once = (key: string, make: () => SampleZone[]): SampleZone[] => {
    let zones = rendered.get(key);
    if (!zones) rendered.set(key, (zones = make()));
    return zones;
  };
  const strings = (): SampleZone[] => once("strings", () => spread(33, 84, 6, (r) => renderStrings(r, 1000 + r)));
  const marimba = (): SampleZone[] => once("marimba", () => spread(33, 96, 6, (r) => renderMarimba(r, 23000 + r)));
  const list: Instrument[] = [
    {
      id: "strings",
      name: "Strings",
      short: "st",
      get zones() {
        return strings();
      },
      envelope: { attack: 0.5, decay: 0.6, sustain: 0.85, release: 1.4 },
      autoVibrato: { depth: 6, rate: 4.6, delay: 0.6 },
      gain: 0.32,
      range: [36, 81],
      color: "#7fa7d9",
    },
    {
      id: "spiccato",
      name: "Spiccato strings",
      short: "sp",
      get zones() {
        return strings();
      },
      envelope: { attack: 0.012, decay: 0.12, sustain: 0.35, release: 0.12 },
      gain: 0.4,
      range: [36, 76],
      color: "#8fb3e0",
    },
    {
      id: "stringsLow",
      name: "Low strings",
      short: "sl",
      get zones() {
        return once("stringsLow", () => spread(28, 72, 6, (r) => renderStrings(r, 1500 + r, 3.5)));
      },
      envelope: { attack: 0.6, decay: 0.6, sustain: 0.85, release: 1.5 },
      autoVibrato: { depth: 5, rate: 4.3, delay: 0.7 },
      gain: 0.32,
      range: [36, 67],
      color: "#6f97cc",
    },
    {
      id: "stringsHigh",
      name: "High strings",
      short: "sh",
      get zones() {
        return once("stringsHigh", () => spread(48, 96, 6, (r) => renderStrings(r, 1700 + r, 7)));
      },
      envelope: { attack: 0.45, decay: 0.6, sustain: 0.85, release: 1.3 },
      autoVibrato: { depth: 8, rate: 5.2, delay: 0.5 },
      gain: 0.3,
      range: [55, 91],
      color: "#9cc0e8",
    },
    {
      id: "violin",
      name: "Violin",
      short: "vn",
      get zones() {
        return once("violin", () => spread(52, 100, 6, (r) => renderStrings(r, 1800 + r, 8, [-2, 2])));
      },
      envelope: { attack: 0.12, decay: 0.4, sustain: 0.85, release: 0.6 },
      autoVibrato: { depth: 18, rate: 5.6, delay: 0.3, sweep: 0.6 },
      gain: 0.36,
      range: [55, 96],
      color: "#cfa0a0",
    },
    {
      id: "mandolin",
      name: "Mandolin",
      short: "md",
      get zones() {
        return once("mandolin", () => spread(48, 96, 5, (r) => renderPluck(r, 26000 + r, MANDOLIN)));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.25 },
      gain: 0.42,
      range: [55, 91],
      color: "#e0b070",
    },
    {
      id: "pipes",
      name: "Pipes",
      short: "pp",
      get zones() {
        return once("pipes", () => spread(33, 84, 6, (r) => renderPipes(r, 27000 + r)));
      },
      envelope: { attack: 0.15, decay: 0.2, sustain: 0.95, release: 0.6 },
      gain: 0.22,
      range: [36, 79],
      color: "#b0a070",
    },
    {
      id: "pizz",
      name: "Pizzicato",
      short: "pz",
      get zones() {
        return once("pizz", () => spread(36, 91, 5, (r) => renderPluck(r, 1900 + r, PIZZ)));
      },
      envelope: { attack: 0.002, decay: 0, sustain: 1, release: 0.25 },
      gain: 0.45,
      range: [36, 84],
      color: "#a7b8d6",
    },
    {
      id: "bass",
      name: "Bass",
      short: "bs",
      get zones() {
        return strings();
      },
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
      get zones() {
        return once("flute", () => spread(59, 98, 6, (r) => renderFlute(r, 2000 + r)));
      },
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
      get zones() {
        return once("guitar", () => spread(38, 79, 5, (r) => renderPluck(r, 3000 + r)));
      },
      envelope: { attack: 0.002, decay: 0, sustain: 1, release: 0.5 },
      gain: 0.5,
      range: [40, 76],
      color: "#d98a5f",
    },
    {
      id: "choir",
      name: "Choir",
      short: "ch",
      get zones() {
        return once("choir", () => spread(45, 84, 6, (r) => renderChoir(r, 7000 + r)));
      },
      envelope: { attack: 0.9, decay: 0.8, sustain: 0.85, release: 2 },
      autoVibrato: { depth: 8, rate: 4.2, delay: 0.8, sweep: 1.5 },
      gain: 0.3,
      range: [48, 79],
      color: "#d8c8ec",
    },
    {
      id: "choirHigh",
      name: "Women's choir",
      short: "cw",
      get zones() {
        return once("choirHigh", () => spread(52, 90, 6, (r) => renderChoir(r, 7400 + r, WOMEN_VOWEL)));
      },
      envelope: { attack: 0.8, decay: 0.8, sustain: 0.85, release: 2 },
      autoVibrato: { depth: 9, rate: 4.6, delay: 0.7, sweep: 1.5 },
      gain: 0.3,
      range: [55, 86],
      color: "#e8d0f0",
    },
    {
      id: "choirLow",
      name: "Men's choir",
      short: "cm",
      get zones() {
        return once("choirLow", () => spread(36, 72, 6, (r) => renderChoir(r, 7700 + r, MEN_VOWEL)));
      },
      envelope: { attack: 0.9, decay: 0.8, sustain: 0.85, release: 2 },
      autoVibrato: { depth: 7, rate: 4, delay: 0.9, sweep: 1.5 },
      gain: 0.32,
      range: [38, 69],
      color: "#b8a8d8",
    },
    {
      id: "harp",
      name: "Harp",
      short: "hp",
      get zones() {
        return once("harp", () => spread(36, 96, 5, (r) => renderPluck(r, 8000 + r, HARP)));
      },
      envelope: { attack: 0.002, decay: 0, sustain: 1, release: 1.2 },
      gain: 0.42,
      range: [40, 91],
      color: "#e8a6b8",
    },
    {
      id: "bells",
      name: "Bells",
      short: "bl",
      get zones() {
        return once("bells", () => spread(60, 102, 6, (r) => renderBell(r)));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 1.5 },
      gain: 0.22,
      range: [72, 98],
      color: "#9fe0e6",
    },
    {
      id: "ney",
      name: "Ney",
      short: "ny",
      get zones() {
        return once("ney", () => spread(55, 96, 6, (r) => renderFlute(r, 9000 + r, NEY)));
      },
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
      get zones() {
        return once("oud", () => spread(36, 79, 5, (r) => renderPluck(r, 10000 + r, OUD)));
      },
      envelope: { attack: 0.002, decay: 0, sustain: 1, release: 0.4 },
      gain: 0.5,
      range: [40, 76],
      color: "#c8794a",
    },
    {
      id: "darbuka",
      name: "Darbuka",
      short: "db",
      get zones() {
        return once("darbuka", () => darbuka(11000));
      },
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
      get zones() {
        return once("horn", () => spread(36, 84, 6, (r) => renderHorn(r, 12000 + r)));
      },
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
      get zones() {
        return once("timpani", () => timpani(13000));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 1 },
      gain: 0.6,
      range: [60, 60],
      keys: { boom: 60 },
      color: "#9fb3c8",
    },
    {
      id: "clarinet",
      name: "Bass clarinet",
      short: "cl",
      get zones() {
        return once("clarinet", () => spread(34, 84, 6, (r) => renderFlute(r, 14000 + r, CLARINET)));
      },
      envelope: { attack: 0.09, decay: 0.3, sustain: 0.85, release: 0.3 },
      autoVibrato: { depth: 4, rate: 4.5, delay: 0.8 },
      gain: 0.42,
      range: [38, 82],
      color: "#8a9a6a",
    },
    {
      id: "musicBox",
      name: "Music box",
      short: "mb",
      get zones() {
        return once("musicBox", () => spread(55, 102, 6, (r) => renderMusicBox(r)));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.8 },
      gain: 0.32,
      range: [60, 98],
      color: "#c7b3d9",
    },
    {
      id: "drip",
      name: "Drips",
      short: "dr",
      get zones() {
        return once("drip", () => spread(55, 103, 12, (r) => renderDrip(r)));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.2 },
      gain: 0.3,
      range: [60, 98],
      color: "#7fc8c0",
    },
    {
      id: "ghost",
      name: "Ghost",
      short: "gh",
      get zones() {
        return once("ghost", () => spread(48, 96, 6, (r) => renderGhost(r)));
      },
      envelope: { attack: 0.5, decay: 0.5, sustain: 0.85, release: 1.4 },
      autoVibrato: { depth: 32, rate: 5.6, delay: 0.25, sweep: 1 },
      gain: 0.3,
      range: [52, 86],
      color: "#b8d0c8",
    },
    {
      id: "knock",
      name: "Knocks",
      short: "kn",
      get zones() {
        return once("knock", () => knock(15000));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.3 },
      gain: 0.5,
      range: [60, 62],
      keys: { dum: 60, tek: 62 },
      color: "#a89070",
    },
    {
      id: "wind",
      name: "Wind",
      short: "wd",
      get zones() {
        return once("wind", () => spread(36, 96, 12, (r) => renderWind(r, 16000 + r)));
      },
      envelope: { attack: 1.5, decay: 0, sustain: 1, release: 2.5 },
      gain: 0.35,
      range: [43, 91],
      color: "#b0bcc8",
    },
    {
      id: "accordion",
      name: "Accordion",
      short: "ac",
      get zones() {
        return once("accordion", () => spread(36, 90, 6, (r) => renderAccordion(r, 17000 + r)));
      },
      envelope: { attack: 0.06, decay: 0.2, sustain: 0.9, release: 0.25 },
      gain: 0.26,
      range: [41, 84],
      color: "#d9a66f",
    },
    {
      id: "clap",
      name: "Claps",
      short: "cp",
      get zones() {
        return once("clap", () => claps(19000));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.15 },
      gain: 0.4,
      range: [60, 60],
      keys: { clap: 60 },
      color: "#e8c9a0",
    },
    {
      id: "taiko",
      name: "Taiko",
      short: "tk",
      get zones() {
        return once("taiko", () => taiko(22000));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.6 },
      gain: 0.6,
      range: [60, 62],
      keys: { dum: 60, tek: 62 },
      color: "#c89070",
    },
    {
      id: "marimba",
      name: "Marimba",
      short: "mr",
      get zones() {
        return marimba();
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.4 },
      gain: 0.42,
      range: [36, 91],
      color: "#c89a68",
    },
    {
      id: "marimbaBass",
      name: "Bass marimba",
      short: "bm",
      get zones() {
        return marimba();
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.5 },
      gain: 0.46,
      range: [33, 60],
      color: "#a87a50",
    },
    {
      id: "bird",
      name: "Birds",
      short: "bd",
      get zones() {
        return once("bird", () => spread(72, 108, 8, (r) => renderBird(r, 24000 + r)));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.1 },
      gain: 0.22,
      range: [76, 104],
      color: "#a8d878",
    },
    {
      id: "shaker",
      name: "Shaker",
      short: "sk",
      get zones() {
        return once("shaker", () => shaker(25000));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.08 },
      gain: 0.32,
      range: [60, 62],
      keys: { shake: 60, hit: 62 },
      color: "#d8c888",
    },
    {
      id: "castanets",
      name: "Castanets",
      short: "cn",
      get zones() {
        return once("castanets", () => castanets(28000));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.1 },
      gain: 0.35,
      range: [60, 62],
      keys: { dum: 60, tek: 62 },
      color: "#c87850",
    },
    {
      id: "frameDrum",
      name: "Frame drum",
      short: "fd",
      get zones() {
        return once("frameDrum", () => frameDrum(4000));
      },
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
      get zones() {
        return once("tambourine", () => tambourine(5000));
      },
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
      get zones() {
        return once("lowDrum", () => lowDrum(6000));
      },
      envelope: { attack: 0.001, decay: 0, sustain: 1, release: 0.6 },
      gain: 0.6,
      range: [60, 60],
      keys: { boom: 60 },
      color: "#8fc4b8",
    },
  ];
  return Object.fromEntries(list.map((i) => [i.id, i]));
}
