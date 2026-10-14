// The composer: seed + style → song. Pure and deterministic; no audio. Two seeds: the place seed
// fixes what makes the piece recognisable (key, meter, chords, motif and melodies), the visit seed
// varies how it is played (tempo, form, percussion, accompaniment, ornaments). See MUSIC.md.
//
// A song is a run of four-bar phrases, one pattern each. Intro and outro grow from and thin to a
// single layer, so the piece fades in and out by how it is written.

import { deriveSeed, mulberry32 } from "../world/rng";
import type { Cell, Channel, Effect, Pattern, Song } from "./song";
import type { MeterRules, Rhythm, Style } from "./styles";
import { chordName, degreeSemitones, degreeToMidi, mod, MODES, nearestTone, pitchClassName, triadDegrees, triadQuality, type ModeName } from "./theory";

type Rng = () => number;

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

function weighted<T>(rng: Rng, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [item, w] of items) if ((r -= w) < 0) return item;
  return items[items.length - 1][0];
}

const LEAD = 0;
const PLUCK = 1;
const PADS = [2, 3, 4];
const BASS = 5;
const FRAME = 6;
const TAMB = 7;
const LOW = 8;
const SPARKLE = 9;

const CHANNELS: Channel[] = [
  { name: "Lead", role: "lead", pan: -0.1, reverb: 0.4 },
  { name: "Pluck", role: "counter", pan: 0.3, reverb: 0.3 },
  { name: "Pad 1", role: "pad", pan: -0.4, reverb: 0.5 },
  { name: "Pad 2", role: "pad", pan: 0, reverb: 0.5 },
  { name: "Pad 3", role: "pad", pan: 0.4, reverb: 0.5 },
  { name: "Bass", role: "bass", pan: 0, reverb: 0.25 },
  { name: "Frame drum", role: "percussion", pan: -0.25, reverb: 0.25 },
  { name: "Tambourine", role: "percussion", pan: 0.45, reverb: 0.3 },
  { name: "Low drum", role: "percussion", pan: 0, reverb: 0.35 },
];

/** Only for styles with sparkles. */
const SPARKLE_CHANNEL: Channel = { name: "Sparkle", role: "counter", pan: 0.2, reverb: 0.7 };

/** Drum articulations to keys, as the drum instruments lay them out. */
const DRUM_KEYS: Record<string, number> = { dum: 60, tek: 62, shake: 60, hit: 62, boom: 60 };

const SECTION_LABELS: Record<string, string> = { I1: "Intro", I2: "Intro", A: "A", "A'": "A'", B: "B", "B'": "B'", Ar: "A", "Ar'": "A'", O1: "Outro", O2: "Outro" };

interface MelodyNote {
  /** Rows from the start of the phrase. */
  row: number;
  dur: number;
  degree: number;
  /** Semitones to slide in from. */
  slideIn?: number;
  /** How much of its volume a long note loses by its end. */
  fade?: number;
}

interface Motif {
  rhythm: Rhythm;
  steps: number[];
  start: number;
}

interface Key {
  mode: ModeName;
  tonic: number;
}

const STEP_WEIGHTS: [number, number][] = [
  [-1, 3],
  [1, 3],
  [-2, 1],
  [2, 1.2],
  [0, 0.7],
  [3, 0.4],
  [-3, 0.4],
];

export function composeSong(style: Style, placeSeed: number, visitSeed: number): Song {
  const place = mulberry32(deriveSeed(placeSeed, 0x6d75));
  const visit = mulberry32(deriveSeed(visitSeed, 0x7669) ^ placeSeed);

  // --- The place: key, meter, harmony, motif, melodies.
  const key: Key = { mode: weighted(place, style.modes), tonic: pick(place, style.tonics) };
  const meter: MeterRules = weighted(place, style.meters);
  const barRows = meter.beats * style.rowsPerBeat;
  const phraseRows = barRows * 4;
  const leadTonic = 72 + key.tonic > 77 ? 60 + key.tonic : 72 + key.tonic;
  const range = { lo: -2, hi: 9 };

  const usable = (d: number): boolean => {
    const q = triadQuality(key.mode, d);
    return q === "major" || q === "minor";
  };
  const chordStep = (prev: number, avoid: number[] = []): number => {
    const options = Object.entries(style.chordWeights)
      .map(([d, w]) => [Number(d), w] as const)
      .filter(([d]) => usable(d) && !avoid.includes(d))
      .map(([d, w]) => [d, d === prev ? w * 0.15 : w] as const);
    return weighted(place, options);
  };
  const fromSet = (set: [number, number][]): number => {
    const options = set.filter(([d]) => usable(d));
    return options.length ? weighted(place, options) : 0;
  };
  const HALF: [number, number][] = style.cadences?.half ?? [[4, 1.5], [6, 2], [3, 1]];
  const LEADING: [number, number][] = style.cadences?.leading ?? [[6, 2], [4, 1.5], [3, 1.5], [5, 1]];
  const CONTRAST: [number, number][] = style.cadences?.contrast ?? [[2, 1], [5, 1.5], [3, 1.5]];
  const BACK: [number, number][] = style.cadences?.back ?? [[4, 1], [6, 2]];

  const aAnte = ((): number[] => {
    const last = fromSet(HALF);
    const c1 = chordStep(0);
    return [0, c1, chordStep(c1, [last]), last];
  })();
  const aCons = ((): number[] => {
    const c2 = fromSet(LEADING);
    return [0, chordStep(0, [c2]), c2, 0];
  })();
  const bFirst = ((): number[] => {
    const first = fromSet(CONTRAST);
    const last = fromSet(HALF);
    const c1 = chordStep(first);
    return [first, c1, chordStep(c1, [last]), last];
  })();
  const bSecond = ((): number[] => {
    const first = fromSet(CONTRAST);
    const last = fromSet(BACK);
    const c1 = chordStep(first);
    return [first, c1, chordStep(c1, [last]), last];
  })();
  const introChords = [0, 0, fromSet([[6, 2], [3, 1.5]]), 0];
  const outroChords = [0, fromSet([[6, 1], [3, 1]]), 0, 0];

  const motif: Motif = ((): Motif => {
    const candidates = meter.rhythms.filter((r) => r.filter((n) => n > 0).length >= 2);
    const rhythm = pick(place, candidates);
    const count = rhythm.filter((n) => n > 0).length;
    const steps = Array.from({ length: Math.max(1, count - 1) }, () => weighted(place, STEP_WEIGHTS));
    return { rhythm, steps, start: pick(place, [0, 2, 4]) };
  })();

  const melodyContext: MelodyContext = { rng: place, meter, barRows, range };
  const melodyA = phraseMelody(melodyContext, motif, aAnte, "half", "A");
  const melodyA2 = phraseMelody(melodyContext, motif, aCons, "full", "A");
  const melodyB = phraseMelody(melodyContext, motif, bFirst, "half", "B");
  const melodyB2 = phraseMelody(melodyContext, motif, bSecond, "half", "B");
  const melodyOutro = ((): MelodyNote[] => {
    const notes: MelodyNote[] = [];
    const tones = triadDegrees(0);
    const d = realiseBar(melodyContext, motif.rhythm, motif.steps, nearestTone(motif.start, tones), 0, 0, notes);
    notes.push({ row: barRows, dur: barRows * 2, degree: nearestTone(d, [0]), fade: 0.9 });
    return notes;
  })();

  // --- The visit: tempo, form, accompaniment, percussion, ornaments.
  const bpm = Math.round(style.bpm[0] + visit() * (style.bpm[1] - style.bpm[0]));
  const form = weighted(visit, style.forms);
  const hasPercussion = visit() < style.percussionChance;
  const drone = visit() < style.droneChance;
  const pluckFirst = visit() < style.pluckFirstChance;
  const lightConsequent = visit() < 0.6;
  const plucksA = pick(visit, meter.plucks);
  const plucksB = pick(visit, meter.plucks);
  const framePattern = pick(visit, meter.frameDrum);
  const tambPattern = pick(visit, meter.tambourine);
  const ornamentedA = ornament(visit, key.mode, melodyA);
  const ornamentedA2 = ornament(visit, key.mode, melodyA2);
  for (const notes of [melodyA, melodyA2, melodyB, melodyB2]) for (const n of notes) if (n.dur >= 4 && visit() < 0.1) n.slideIn = slideFromBelow(key.mode, n.degree);
  if (style.slideChance) {
    for (const notes of [melodyA, melodyA2, melodyB, melodyB2, ornamentedA, ornamentedA2]) {
      for (const n of notes) {
        if (n.dur < 2 || visit() >= style.slideChance) continue;
        n.slideIn = visit() < 0.5 ? slideFromBelow(key.mode, n.degree) : degreeSemitones(key.mode, n.degree + 1) - degreeSemitones(key.mode, n.degree);
      }
    }
  }

  // Optional knobs. Each draws from the visit only when the style uses it, so styles without it
  // keep their songs.
  const part = (name: keyof NonNullable<Style["mix"]>): number => style.mix?.[name] ?? 1;
  // The lead never sits out the outro, nor the first phrase that brings its theme.
  const firstTheme = form.find((id) => id !== "I1" && id !== "I2");
  const leadRests = new Set(style.leadRestChance ? form.filter((id) => !["I1", "I2", "O1", "O2"].includes(id) && id !== firstTheme && visit() < style.leadRestChance!) : []);
  const channels = style.instruments.sparkle ? [...CHANNELS, { ...SPARKLE_CHANNEL, name: style.sparkle?.name ?? SPARKLE_CHANNEL.name }] : CHANNELS;

  const totalRows = form.length * phraseRows;
  const cells: (Cell | undefined)[][] = Array.from({ length: totalRows }, () => channels.map(() => undefined));
  const put = (row: number, channel: number, cell: Cell): void => {
    if (row < 0 || row >= totalRows) return;
    const existing = cells[row][channel];
    if (!existing) {
      cells[row][channel] = cell;
      return;
    }
    const effects = [...(existing.effects ?? []), ...(cell.effects ?? [])];
    cells[row][channel] = { ...existing, ...cell, effects: effects.length ? effects : undefined };
  };
  const slideRows = (channel: number, from: number, rows: number, total: number): void => {
    const perTick = total / (rows * style.ticksPerRow);
    for (let r = from; r < from + rows; r++) put(r, channel, { effects: [{ type: "volumeSlide", perTick }] });
  };
  const jitter = (amount: number): number => (visit() - 0.5) * 2 * amount;

  let padPlaying: number[] | undefined;
  let bassPlaying: number | undefined;
  let padStarted = false;
  let plucking = false;
  const patterns: Pattern[] = [];

  form.forEach((id, index) => {
    const start = index * phraseRows;
    const isLast = index === form.length - 1;
    const chords =
      id === "I1" ? introChords
      : id === "I2" || id === "A" || id === "Ar" ? aAnte
      : id === "A'" || id === "Ar'" || id === "O1" ? aCons
      : id === "B" ? bFirst
      : id === "B'" ? bSecond
      : outroChords;
    const layers = sectionLayers(id, pluckFirst);
    if (style.instruments.sparkle && id !== "I1") layers.add("sparkle");
    if (leadRests.has(id)) layers.delete("lead");
    patterns.push({
      section: SECTION_LABELS[id] ?? id,
      rows: phraseRows,
      cells: [],
      chords: chords.map((c, b) => ({ row: b * barRows, name: chordName(key.mode, c) })),
    });

    // Lead.
    const melody =
      id === "A" ? melodyA
      : id === "A'" ? melodyA2
      : id === "B" ? melodyB
      : id === "B'" ? melodyB2
      : id === "Ar" ? ornamentedA
      : id === "Ar'" ? ornamentedA2
      : id === "O1" ? melodyOutro
      : undefined;
    if (melody && layers.has("lead")) {
      const loud = id === "B" || id === "B'" ? 0.06 : 0;
      melody.forEach((n, i) => {
        const row = start + n.row;
        const volume = (0.58 + loud + 0.08 * Math.sin((Math.PI * n.row) / phraseRows) + (n.row % barRows === 0 ? 0.04 : 0) + jitter(0.03)) * part("lead");
        const effects: Effect[] = n.slideIn ? [{ type: "slideIn", semis: n.slideIn, ticks: 3 }] : [];
        const note = degreeToMidi(key.mode, leadTonic, n.degree);
        put(row, LEAD, { note, instrument: style.instruments.lead, volume, effects: effects.length ? effects : undefined });
        // A trill: the note and the step above it, a tick apart, as birds do.
        if (style.trillChance && n.dur >= 6 && visit() < style.trillChance) {
          const x = degreeToMidi(key.mode, leadTonic, n.degree + 1) - note;
          for (let r = 1; r <= 3; r++) put(row + r, LEAD, { effects: [{ type: "arpeggio", x, y: 0 }] });
        }
        if (n.dur >= 8) slideRows(LEAD, row + 4, n.dur - 4, -volume * (n.fade ?? 0.3));
        if (style.vibratoChance && n.dur >= 8 && visit() < style.vibratoChance) {
          for (let r = 4; r < n.dur; r++) put(row + r, LEAD, { effects: [{ type: "vibrato", depth: 0.25, rate: 5.5 }] });
        }
        const next = melody[i + 1];
        if (!next || next.row > n.row + n.dur) put(row + n.dur, LEAD, { note: "off" });
      });
    }

    // Pads and bass: held chords, notes only where the chord changes.
    const fadeIn = layers.has("pad") && !padStarted;
    const fadeOut = isLast;
    if (layers.has("pad")) {
      const base = (id === "B" || id === "B'" ? 0.5 : 0.42) * part("pad");
      chords.forEach((c, b) => {
        const voicing = padVoicing(key, c, padPlaying);
        voicing.forEach((note, v) => {
          const cell: Cell = {};
          if (!padPlaying || padPlaying[v] !== note) Object.assign(cell, { note, instrument: style.instruments.pad });
          if (b === 0) cell.volume = fadeIn ? 0 : base;
          if (cell.note !== undefined || cell.volume !== undefined) put(start + b * barRows, PADS[v], cell);
        });
        padPlaying = voicing;
      });
      if (fadeIn) for (const ch of PADS) slideRows(ch, start, barRows * 2, base);
      if (fadeOut) for (const ch of PADS) slideRows(ch, start + barRows * 2, barRows * 2, -base);
      // Breathing: each bar swells and ebbs back, where no fade is running.
      const breath = (style.padBreath ?? 0) * base;
      if (breath) {
        for (let b = 0; b < 4; b++) {
          if ((fadeIn && b < 2) || (fadeOut && b >= 2)) continue;
          for (const ch of PADS) {
            slideRows(ch, start + b * barRows, barRows / 2, breath);
            slideRows(ch, start + b * barRows + barRows / 2, barRows / 2, -breath);
          }
        }
      }
      padStarted = true;
    } else {
      if (padPlaying) for (const ch of PADS) put(start, ch, { note: "off" });
      padPlaying = undefined;
    }

    if (layers.has("bass")) {
      const base = 0.5 * part("bass");
      const enterBar = fadeIn ? 2 : 0;
      chords.forEach((c, b) => {
        if (b < enterBar) return;
        const note = bassNote(key, drone ? 0 : c);
        if (bassPlaying === note && b !== enterBar) return;
        put(start + b * barRows, BASS, { note, instrument: style.instruments.bass, volume: base });
        bassPlaying = note;
      });
      if (fadeOut) slideRows(BASS, start + barRows * 2, barRows * 2, -base);
    } else {
      if (bassPlaying !== undefined) put(start, BASS, { note: "off" });
      bassPlaying = undefined;
    }

    // Plucked accompaniment.
    if (layers.has("pluck")) {
      const pattern = id === "B" || id === "B'" ? plucksB : plucksA;
      chords.forEach((c, b) => {
        if (id === "O2" && b === 2) return;
        const tones = pluckTones(key, c).map((t) => t + (style.pluckShift ?? 0));
        const steps = id === "O2" && b === 3 ? [pattern[0]] : id === "O2" && b === 1 ? pattern.slice(0, 2) : pattern;
        steps.forEach(([row, tone], i) => {
          // Tremolo picking, as on an oud: the note struck again and again until the next.
          const gap = (steps[i + 1]?.[0] ?? barRows) - row;
          if (style.pluckTremolo && gap >= 4 && visit() < style.pluckTremolo) {
            for (let r = 0; r < gap; r++) put(start + b * barRows + row + r, PLUCK, { effects: [{ type: "retrigger", every: 2, volumeFactor: 0.97 }] });
          }
          const strong = row === 0 ? 0.56 : row % style.rowsPerBeat === 0 ? 0.46 : 0.38;
          const quiet = id === "O2" ? 0.7 : 1;
          const effects: Effect[] | undefined = row > 0 && visit() < 0.2 ? [{ type: "noteDelay", ticks: 1 }] : undefined;
          put(start + b * barRows + row, PLUCK, { note: tones[tone], instrument: style.instruments.pluck, volume: (strong + jitter(0.05)) * quiet * part("pluck"), effects });
        });
      });
      plucking = true;
    } else if (plucking) {
      // Sampled plucks hold a quiet loop until let go.
      put(start, PLUCK, { note: "off" });
      plucking = false;
    }

    // Percussion.
    const level = !hasPercussion ? 0
      : style.percussion ? (style.percussion[id] ?? 0)
      : id === "B" || id === "B'" || id === "Ar'" ? 2
      : id === "Ar" ? 1
      : id === "A'" && lightConsequent ? 1
      : 0;
    if (level >= 1) {
      for (let b = 0; b < 4; b++) {
        const bar = start + b * barRows;
        if (level === 1) {
          if (b % 2 === 0) put(bar, FRAME, { note: DRUM_KEYS.dum, instrument: style.instruments.frameDrum, volume: (0.45 + jitter(0.04)) * part("drums") });
          continue;
        }
        for (const [row, name] of framePattern) {
          const volume = ((name === "dum" ? 0.55 : 0.34) + jitter(0.05)) * part("drums");
          put(bar + row, FRAME, { note: DRUM_KEYS[name], instrument: style.instruments.frameDrum, volume });
        }
        const rollBar = b === 3 && (id === "B'" || id === "Ar'");
        for (const [row, name] of tambPattern) {
          if (rollBar && row >= barRows - style.rowsPerBeat) continue;
          put(bar + row, TAMB, { note: DRUM_KEYS[name], instrument: style.instruments.tambourine, volume: ((name === "hit" ? 0.32 : 0.24) + jitter(0.04)) * part("drums") });
        }
        if (rollBar) {
          put(bar + barRows - style.rowsPerBeat, TAMB, {
            note: DRUM_KEYS.shake,
            instrument: style.instruments.tambourine,
            volume: 0.3 * part("drums"),
            effects: [{ type: "retrigger", every: 2, volumeFactor: 0.9 }],
          });
          for (let r = barRows - style.rowsPerBeat + 1; r < barRows; r++) put(bar + r, TAMB, { effects: [{ type: "retrigger", every: 2, volumeFactor: 0.92 }] });
        }
      }
      put(start, LOW, { note: DRUM_KEYS.boom, instrument: style.instruments.lowDrum, volume: (0.5 + jitter(0.04)) * part("drums") });
      if (id === "B" || id === "B'") put(start + 2 * barRows, LOW, { note: DRUM_KEYS.boom, instrument: style.instruments.lowDrum, volume: (0.36 + jitter(0.04)) * part("drums") });
    }

    // Sparkles: now and then a quick run over the chord high up, echoing away.
    const sparkle = style.sparkle;
    if (sparkle?.kind === "wail" && style.instruments.sparkle && layers.has("sparkle") && id !== "O2" && visit() < sparkle.chance) {
      // A voice rising out of nowhere into a long tonic or fifth, wavering, and fading away.
      const bar = visit() < 0.6 ? 0 : 2;
      const at = start + bar * barRows;
      const dur = barRows * 2;
      const note = pitchesOf(key, visit() < 0.6 ? 0 : 4, 60, 74)[0];
      const peak = (0.5 + jitter(0.05)) * part("sparkle");
      put(at, SPARKLE, { note, instrument: style.instruments.sparkle, volume: 0, effects: [{ type: "slideIn", semis: -pick(visit, [2, 3, 5]), ticks: style.ticksPerRow * 3 }] });
      slideRows(SPARKLE, at, barRows / 2, peak);
      slideRows(SPARKLE, at + barRows, dur - barRows, -peak);
      for (let r = barRows / 2; r < dur; r++) put(at + r, SPARKLE, { effects: [{ type: "vibrato", depth: 0.3, rate: 4.8 }] });
      put(at + dur, SPARKLE, { note: "off" });
    }
    if (sparkle && sparkle.kind !== "wail" && style.instruments.sparkle && layers.has("sparkle")) {
      chords.forEach((c, b) => {
        if (visit() >= sparkle.chance * (id === "O2" ? 0.5 : 1)) return;
        const count = sparkle.notes[0] + Math.floor(visit() * (sparkle.notes[1] - sparkle.notes[0] + 1));
        const step = pick(visit, [1, 1, 2]);
        const at = start + b * barRows + Math.floor(visit() * Math.max(1, barRows - count * step));
        const tones = [...triadDegrees(c), mod(c + 1, 7)].flatMap((d) => pitchesOf(key, d, 76, 98)).sort((x, y) => x - y);
        const up = visit() < 0.7;
        let index = up ? Math.floor(visit() * Math.max(1, tones.length - count)) : tones.length - 1 - Math.floor(visit() * Math.max(1, tones.length - count));
        let volume = (0.42 + jitter(0.06)) * part("sparkle");
        for (let k = 0; k < count && index >= 0 && index < tones.length; k++) {
          put(at + k * step, SPARKLE, { note: tones[index], instrument: style.instruments.sparkle, volume });
          volume *= 0.85;
          index += up ? 1 : -1;
        }
        const last = at + (count - 1) * step;
        for (let r = 0; r < 4; r++) put(last + r, SPARKLE, { effects: [{ type: "retrigger", every: 3, volumeFactor: 0.55 }] });
        // Let go after the echoes: a sampled bell then rings down on its own envelope.
        if (!cells[last + 4]?.[SPARKLE]?.note) put(last + 4, SPARKLE, { note: "off" });
      });
    }
  });

  patterns.forEach((p, i) => (p.cells = cells.slice(i * phraseRows, (i + 1) * phraseRows)));

  return {
    style: style.id,
    placeSeed,
    visitSeed,
    bpm,
    rowsPerBeat: style.rowsPerBeat,
    ticksPerRow: style.ticksPerRow,
    beatsPerBar: meter.beats,
    channels,
    patterns,
    summary: {
      key: `${pitchClassName(key.tonic)} ${key.mode}`,
      tempo: `${bpm} bpm`,
      meter: `${meter.beats}/4`,
      form: form.map((id) => SECTION_LABELS[id] ?? id).join(" "),
      percussion: hasPercussion ? "yes" : "no",
      bass: drone ? "drone" : "follows the chords",
      intro: pluckFirst ? "pluck alone" : "pad",
      ...(leadRests.size ? { "lead rests in": [...leadRests].map((id) => SECTION_LABELS[id] ?? id).join(", ") } : {}),
    },
  };
}

function sectionLayers(id: string, pluckFirst: boolean): Set<string> {
  switch (id) {
    case "I1":
      return new Set(pluckFirst ? ["pluck"] : ["pad", "bass"]);
    case "I2":
    case "O2":
      return new Set(["pad", "bass", "pluck"]);
    default:
      return new Set(["pad", "bass", "pluck", "lead"]);
  }
}

// ---------------------------------------------------------------------------------------------
// Melody.

interface MelodyContext {
  rng: Rng;
  meter: MeterRules;
  barRows: number;
  range: { lo: number; hi: number };
}

/**
 * One bar of melody: the rhythm's notes walk by `steps` from `anchor`; notes on the bar's strong
 * rows land on the chord. Returns the last degree.
 */
function realiseBar(ctx: MelodyContext, rhythm: Rhythm, steps: number[], anchor: number, chord: number, barStart: number, out: MelodyNote[]): number {
  const strong = ctx.meter.beats === 4 ? [0, ctx.barRows / 2] : [0];
  const tones = triadDegrees(chord);
  let d = anchor;
  let pos = 0;
  let i = 0;
  for (const len of rhythm) {
    if (len < 0) {
      pos -= len;
      continue;
    }
    if (i > 0) d += steps[(i - 1) % steps.length];
    if (strong.includes(pos)) d = nearestTone(d, tones);
    while (d > ctx.range.hi) d -= 2;
    while (d < ctx.range.lo) d += 2;
    out.push({ row: barStart + pos, dur: len, degree: d });
    pos += len;
    i++;
  }
  return d;
}

function stepsToward(rng: Rng, count: number, from: number, to: number): number[] {
  const steps: number[] = [];
  let d = from;
  for (let i = 0; i < count; i++) {
    const dir = Math.sign(to - d);
    const step = dir === 0 ? weighted(rng, [[1, 1], [-1, 1], [0, 0.6]]) : weighted(rng, [[dir, 3], [2 * dir, 1], [-dir, 1], [0, 0.5]]);
    steps.push(step);
    d += step;
  }
  return steps;
}

/** The same bar length, one long note split in two or two notes merged. */
function varyRhythm(rng: Rng, rhythm: Rhythm): Rhythm {
  const out = [...rhythm];
  const splittable = out.map((n, i) => (n >= 4 && n % 2 === 0 ? i : -1)).filter((i) => i >= 0);
  if (splittable.length && rng() < 0.6) {
    const i = pick(rng, splittable);
    out.splice(i, 1, out[i] / 2, out[i] / 2);
    return out;
  }
  for (let i = 0; i + 1 < out.length; i++) {
    if (out[i] > 0 && out[i + 1] > 0) {
      out.splice(i, 2, out[i] + out[i + 1]);
      return out;
    }
  }
  return out;
}

/**
 * A four-bar phrase: the motif, a variation of it, a freer bar heading for the cadence, and the
 * cadence itself - a long note on the tonic ("full") or on another tone of the last chord ("half").
 * B phrases turn the motif upside down, a little higher and in longer notes.
 */
function phraseMelody(ctx: MelodyContext, motif: Motif, chords: number[], ending: "half" | "full", kind: "A" | "B"): MelodyNote[] {
  const { rng, meter, barRows } = ctx;
  const notes: MelodyNote[] = [];
  const isB = kind === "B";
  const steps0 = isB ? motif.steps.map((s) => -s) : motif.steps;
  const rhythm0 = isB ? pick(rng, meter.calmRhythms) : motif.rhythm;
  const anchor0 = nearestTone(motif.start + (isB ? 2 : 0), triadDegrees(chords[0]));
  let d = realiseBar(ctx, rhythm0, steps0, anchor0, chords[0], 0, notes);

  const variation = weighted(rng, [["repeat", 1], ["sequence", 2], ["invert", 1]] as const);
  let shift = mod(chords[1] - chords[0], 7);
  if (shift > 3) shift -= 7;
  const anchor1 = variation === "sequence" ? anchor0 + shift : anchor0;
  const steps1 = variation === "invert" ? steps0.map((s) => -s) : steps0;
  const rhythm1 = rng() < 0.6 ? rhythm0 : varyRhythm(rng, rhythm0);
  d = realiseBar(ctx, rhythm1, steps1, nearestTone(anchor1, triadDegrees(chords[1])), chords[1], barRows, notes);

  const lastTones = triadDegrees(chords[3]);
  const goal = ending === "full" ? nearestTone(d, [0]) : nearestTone(d, lastTones.filter((t) => t !== 0).length ? lastTones.filter((t) => t !== 0) : lastTones);
  const rhythm2 = pick(rng, isB ? meter.calmRhythms : meter.rhythms);
  const count2 = rhythm2.filter((n) => n > 0).length;
  const start2 = nearestTone(d + (rng() < 0.5 ? 1 : -1), triadDegrees(chords[2]));
  d = realiseBar(ctx, rhythm2, stepsToward(rng, count2, start2, goal), start2, chords[2], barRows * 2, notes);

  const rhythm3 = pick(rng, meter.cadenceRhythms);
  const sounding = rhythm3.filter((n) => n > 0);
  const final = ending === "full" ? nearestTone(d, [0]) : nearestTone(d, lastTones.filter((t) => t !== 0));
  const dir = d >= final ? 1 : -1;
  let pos = 0;
  let k = 0;
  for (const len of rhythm3) {
    if (len < 0) {
      pos -= len;
      continue;
    }
    const degree = final + dir * (sounding.length - 1 - k);
    notes.push({ row: barRows * 3 + pos, dur: len, degree: Math.max(ctx.range.lo, Math.min(ctx.range.hi, degree)) });
    pos += len;
    k++;
  }
  return notes;
}

/** Semitones down to the scale step below, as a slide-in amount (negative). */
function slideFromBelow(mode: ModeName, degree: number): number {
  return degreeSemitones(mode, degree - 1) - degreeSemitones(mode, degree);
}

/** A repeat of a melody, decorated: passing notes across thirds, some notes slid into. */
function ornament(rng: Rng, mode: ModeName, notes: MelodyNote[]): MelodyNote[] {
  const out: MelodyNote[] = [];
  notes.forEach((a, i) => {
    const b = notes[i + 1];
    if (b && b.row === a.row + a.dur && Math.abs(b.degree - a.degree) === 2 && a.dur >= 4 && rng() < 0.5) {
      out.push({ ...a, dur: a.dur - 2 });
      out.push({ row: a.row + a.dur - 2, dur: 2, degree: (a.degree + b.degree) / 2 });
    } else {
      out.push({ ...a });
    }
  });
  for (const n of out) if (n.dur >= 4 && rng() < 0.3) n.slideIn = slideFromBelow(mode, n.degree);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Accompaniment.

/** All pitches of a degree's pitch class between lo and hi. */
function pitchesOf(key: Key, degree: number, lo: number, hi: number): number[] {
  const pc = mod(key.tonic + MODES[key.mode][mod(degree, 7)], 12);
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (mod(m, 12) === pc) out.push(m);
  return out;
}

/** Three close voices of the chord, moving as little as they can from the last voicing. */
function padVoicing(key: Key, chord: number, previous?: number[]): number[] {
  const [r, t, f] = triadDegrees(chord).map((d) => pitchesOf(key, d, 53, 70));
  let best: number[] = [];
  let bestScore = Infinity;
  for (const a of r) for (const b of t) for (const c of f) {
    const v = [a, b, c].sort((x, y) => x - y);
    if (v[2] - v[0] > 12 || v[0] === v[1] || v[1] === v[2]) continue;
    const score = previous ? v.reduce((s, n, i) => s + Math.abs(n - previous[i]), 0) : Math.abs((v[0] + v[2]) / 2 - 62);
    if (score < bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

function bassNote(key: Key, chord: number): number {
  return pitchesOf(key, chord, 38, 49)[0];
}

/** The plucked chord tones: root, third, fifth, octave, tenth, from a root in the low-middle range. */
function pluckTones(key: Key, chord: number): number[] {
  const root = pitchesOf(key, chord, 45, 56)[0];
  const base = degreeSemitones(key.mode, chord);
  return [0, 2, 4, 7, 9].map((off) => root + degreeSemitones(key.mode, chord + off) - base);
}
