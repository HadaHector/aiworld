// The composer: seed + style → song. Pure and deterministic; no audio. Two seeds: the place seed
// fixes what makes the piece recognisable (key, meter, chords, motif and melodies), the visit seed
// varies how it is played (tempo, form, percussion, accompaniment, ornaments). See MUSIC.md.
//
// A song is a run of four-bar phrases, one pattern each. Intro and outro grow from and thin to a
// single layer, so the piece fades in and out by how it is written.

import { deriveSeed, mulberry32 } from "../world/rng";
import type { Cell, Channel, Effect, Pattern, Song } from "./song";
import type { LeadAlternate, MeterRules, PadTexture, Rhythm, Style } from "./styles";
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
const MELODIC = (channel: number): boolean => channel !== FRAME && channel !== TAMB && channel !== LOW;

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

/** Only for styles with sparkles, then wails, in that order after the others. */
const SPARKLE_CHANNEL: Channel = { name: "Sparkle", role: "counter", pan: 0.2, reverb: 0.7 };
const WAIL_CHANNEL: Channel = { name: "Wail", role: "counter", pan: 0.2, reverb: 0.7 };
const WIND_CHANNEL: Channel = { name: "Wind", role: "pad", pan: -0.3, reverb: 0.4 };
const CLAP_CHANNEL: Channel = { name: "Claps", role: "percussion", pan: -0.35, reverb: 0.3 };

/** Drum articulations to keys, as the drum instruments lay them out. */
const DRUM_KEYS: Record<string, number> = { dum: 60, tek: 62, shake: 60, hit: 62, boom: 60 };

const SECTION_LABELS: Record<string, string> = { I1: "Intro", I2: "Intro", A: "A", "A'": "A'", B: "B", "B'": "B'", Ar: "A", "Ar'": "A'", C: "C", D: "Dev", Br: "Breath", O1: "Outro", O2: "Outro" };
/** A section id with "+" is that section as a climax: in a new key, the whole orchestra. */
const sectionLabel = (id: string): string => (id.endsWith("+") ? (SECTION_LABELS[id.slice(0, -1)] ?? id) + "+" : (SECTION_LABELS[id] ?? id));

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
  const leadTonic = style.leadCenter !== undefined
    ? style.leadCenter - 6 + mod(key.tonic - (style.leadCenter - 6), 12)
    : (72 + key.tonic > 77 ? 60 + key.tonic : 72 + key.tonic) + (style.leadShift ?? 0);
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

  const makeMotif = (): Motif => {
    const candidates = meter.rhythms.filter((r) => r.filter((n) => n > 0).length >= 2);
    const rhythm = pick(place, candidates);
    const count = rhythm.filter((n) => n > 0).length;
    const steps = Array.from({ length: Math.max(1, count - 1) }, () => weighted(place, STEP_WEIGHTS));
    return { rhythm, steps, start: pick(place, [0, 2, 4]) };
  };
  const motif = makeMotif();

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

  // Further sections, composed only for styles whose forms have them, so other styles keep their
  // songs. C: a third theme on a motif of its own, away from home. D: a development, the motif
  // carried down a chain of chords. Br: a breath, the harmony alone.
  const uses = (section: string): boolean => style.forms.some(([f]) => f.some((id) => id.replace("+", "") === section));
  const cChords = uses("C") ? ((): number[] => {
    const first = fromSet([[5, 2], [2, 1.5], [3, 1]]);
    const last = fromSet(HALF);
    const c1 = chordStep(first);
    return [first, c1, chordStep(c1, [last]), last];
  })() : [];
  const melodyC = uses("C") ? phraseMelody(melodyContext, makeMotif(), cChords, "half", "A") : [];
  const devChords = uses("D") ? ((): number[] => {
    const chain = [fromSet(CONTRAST)];
    for (let b = 1; b < 3; b++) {
      let d = chain[b - 1] - 1;
      while (!usable(d)) d--;
      chain.push(mod(d, 7));
    }
    return [...chain, fromSet(BACK)];
  })() : [];
  const melodyD = uses("D") ? ((): MelodyNote[] => {
    const notes: MelodyNote[] = [];
    let d = motif.start;
    for (let b = 0; b < 3; b++) d = realiseBar(melodyContext, motif.rhythm, motif.steps, nearestTone(motif.start + 1 - b, triadDegrees(devChords[b])), devChords[b], b * barRows, notes);
    notes.push({ row: barRows * 3, dur: barRows, degree: nearestTone(d, triadDegrees(devChords[3])) });
    return notes;
  })() : [];
  const breathChords = uses("Br") ? [0, fromSet([[5, 1], [3, 1]]), 0, fromSet(BACK)] : [];

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
  const leadRests = new Set(style.leadRestChance ? form.filter((id) => !["I1", "I2", "O1", "O2", "Br"].includes(id) && !id.endsWith("+") && id !== firstTheme && visit() < style.leadRestChance!) : []);
  const climaxShift = form.some((id) => id.endsWith("+")) ? pick(visit, style.climaxShift ?? [2]) : 0;
  const WAIL = style.instruments.sparkle ? SPARKLE + 1 : SPARKLE;
  const channels = [
    ...CHANNELS,
    ...(style.instruments.sparkle ? [{ ...SPARKLE_CHANNEL, name: style.sparkle?.name ?? SPARKLE_CHANNEL.name }] : []),
    ...(style.instruments.wail ? [{ ...WAIL_CHANNEL, name: style.wail?.name ?? WAIL_CHANNEL.name }] : []),
    ...(style.wind && style.instruments.wind ? [WIND_CHANNEL] : []),
    ...(style.claps && style.instruments.clap ? [CLAP_CHANNEL] : []),
  ];
  const CLAP = channels.indexOf(CLAP_CHANNEL);
  const WIND = channels.indexOf(WIND_CHANNEL);

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
  /**
   * Which instrument plays a theme's lead, chosen once per theme: A and A' and their returns (and
   * the outro, which quotes A) share one, B and B' another, so a statement and its answer match.
   */
  const alternates = new Map<string, LeadAlternate | undefined>();
  const alternateFor = (id: string): LeadAlternate | undefined => {
    const alternate = style.leadAlternate;
    if (!alternate) return undefined;
    const theme = id.startsWith("A") || id === "O1" ? "A" : id.startsWith("B") ? "B" : id;
    if (!alternates.has(theme)) {
      if (Array.isArray(alternate)) {
        // Several: one draw, each taking its share of chance in turn.
        const r = visit();
        let share = 0;
        alternates.set(theme, alternate.find((a) => r < (share += a.chance)));
      } else {
        alternates.set(theme, visit() < alternate.chance ? alternate : undefined);
      }
    }
    return alternates.get(theme);
  };
  /** A chord's three tones, sometimes coloured: an added ninth for the fifth, or a sus2 or sus4 for the third. */
  const chordColour = (c: number): number[] => {
    const colour = style.pad?.colour;
    if (!colour) return triadDegrees(c);
    const interval = (steps: number): number => mod(degreeSemitones(key.mode, c + steps) - degreeSemitones(key.mode, c), 12);
    const r = visit();
    const add9 = colour.add9 ?? 0;
    const sus2 = add9 + (colour.sus2 ?? 0);
    const sus4 = sus2 + (colour.sus4 ?? 0);
    if (r < add9 && interval(1) === 2) return [c, c + 2, c + 1];
    if (r >= add9 && r < sus2 && interval(1) === 2) return [c, c + 1, c + 4];
    if (r >= sus2 && r < sus4 && interval(3) === 5) return [c, c + 3, c + 4];
    return triadDegrees(c);
  };

  let padPlaying: number[] | undefined;
  /** The pad's voicing before a texture spreads it: what the next chord leads on from. */
  let padCore: number[] | undefined;
  let bassPlaying: number | undefined;
  let padStarted = false;
  let plucking = false;
  let keyShift = 0;
  const patterns: Pattern[] = [];
  const levelOf = (formId: string): number => {
    const id = formId.replace("+", "");
    return !hasPercussion ? 0
      : style.percussion ? (style.percussion[formId] ?? 0)
      : id === "B" || id === "B'" || id === "Ar'" ? 2
      : id === "Ar" ? 1
      : id === "A'" && lightConsequent ? 1
      : 0;
  };

  form.forEach((formId, index) => {
    const climax = formId.endsWith("+");
    const id = climax ? formId.slice(0, -1) : formId;
    const start = index * phraseRows;
    const isLast = index === form.length - 1;
    // Into or out of a new key, the held chords are struck afresh.
    const shift = climax ? climaxShift : 0;
    if (shift !== keyShift) {
      padPlaying = undefined;
      padCore = undefined;
      bassPlaying = undefined;
      keyShift = shift;
    }
    const chords =
      id === "I1" ? introChords
      : id === "I2" || id === "A" || id === "Ar" ? aAnte
      : id === "A'" || id === "Ar'" || id === "O1" ? aCons
      : id === "B" ? bFirst
      : id === "B'" ? bSecond
      : id === "C" ? cChords
      : id === "D" ? devChords
      : id === "Br" ? breathChords
      : outroChords;
    const layers = sectionLayers(id, pluckFirst);
    if ((style.instruments.sparkle || style.instruments.wail) && id !== "I1") layers.add("sparkle");
    if (leadRests.has(formId)) layers.delete("lead");
    patterns.push({
      section: sectionLabel(formId),
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
      : id === "C" ? melodyC
      : id === "D" ? melodyD
      : undefined;
    /** The lead as sung, for a chorale to harmonise: row, length, pitch, and whether a rest follows. */
    const leadLine: { row: number; dur: number; note: number; rest: boolean }[] = [];
    if (melody && layers.has("lead")) {
      const loud = (id === "B" || id === "B'" ? 0.06 : 0) + (climax ? 0.08 : 0);
      // Now and then the phrase goes to another instrument, or glides from note to note.
      const alternate = alternateFor(id);
      const glide = !!style.glideChance && visit() < style.glideChance;
      // Call and response: the second phrase of a theme is the group's answer.
      const answering = style.answer && id.endsWith("'") ? style.answer : undefined;
      const voice = answering ?? alternate;
      const leadInstrument = voice?.instrument ?? style.instruments.lead;
      const pitchOf = (degree: number): number => degreeToMidi(key.mode, leadTonic, degree) + (voice?.shift ?? 0);
      const joined = (a: MelodyNote | undefined, b: MelodyNote | undefined): boolean => !!a && !!b && a.row + a.dur === b.row;
      melody.forEach((n, i) => {
        const row = start + n.row;
        const volume = (0.58 + loud + 0.08 * Math.sin((Math.PI * n.row) / phraseRows) + (n.row % barRows === 0 ? 0.04 : 0) + jitter(0.03)) * part("lead");
        const note = pitchOf(n.degree);
        const prev = melody[i - 1];
        const glides = glide && joined(prev, n);
        if (glides) {
          // Gliding in from the note before, over two rows: XM tone portamento on both.
          const perTick = Math.max(0.05, Math.abs(note - pitchOf(prev!.degree)) / (2 * (style.ticksPerRow - 1)));
          put(row, LEAD, { note, instrument: leadInstrument, volume, effects: [{ type: "tonePortamento", perTick }] });
          put(row + 1, LEAD, { effects: [{ type: "tonePortamento", perTick }] });
        } else {
          const effects: Effect[] = n.slideIn ? [{ type: "slideIn", semis: n.slideIn, ticks: 3 }] : [];
          put(row, LEAD, { note, instrument: leadInstrument, volume, effects: effects.length ? effects : undefined });
        }
        // A trill: the note and the step above it, a tick apart, as birds do.
        if (style.trillChance && n.dur >= 6 && visit() < style.trillChance) {
          const x = pitchOf(n.degree + 1) - note;
          for (let r = 1; r <= 3; r++) put(row + r, LEAD, { effects: [{ type: "arpeggio", x, y: 0 }] });
        }
        if (n.dur >= 8) slideRows(LEAD, row + 4, n.dur - 4, -volume * (n.fade ?? 0.3));
        if (style.vibratoChance && n.dur >= 8 && visit() < style.vibratoChance) {
          for (let r = 4; r < n.dur; r++) put(row + r, LEAD, { effects: [{ type: "vibrato", depth: 0.25, rate: 5.5 }] });
        }
        const next = melody[i + 1];
        leadLine.push({ row, dur: n.dur, note, rest: !next || next.row > n.row + n.dur });
        // A long note may sag half a semitone flat over its last quarter, like a dying breath.
        if (style.sagChance && n.dur >= 8 && !(glide && joined(n, next)) && visit() < style.sagChance) {
          const rows = Math.max(2, Math.floor(n.dur / 4));
          const perTick = -0.5 / (rows * (style.ticksPerRow - 1));
          for (let r = n.dur - rows; r < n.dur; r++) put(row + r, LEAD, { effects: [{ type: "portamento", perTick }] });
        }
        if (!next || next.row > n.row + n.dur) put(row + n.dur, LEAD, { note: "off" });
        // At a climax the choir takes up the melody, an octave below unless the style says otherwise.
        if (climax && style.instruments.wail) {
          let doubled = note + (style.wail?.double ?? -12);
          while (doubled < 40) doubled += 12;
          put(row, WAIL, { note: doubled, instrument: style.instruments.wail, volume: 0.4 * part("wail") });
          if (!next || next.row > n.row + n.dur) put(row + n.dur, WAIL, { note: "off" });
        }
      });
    }

    // Pads and bass: held chords, notes only where the chord changes.
    const fadeIn = layers.has("pad") && !padStarted;
    const fadeOut = isLast;
    const pad = style.pad;
    if (pad && layers.has("pad")) {
      const base = (id === "B" || id === "B'" ? 0.5 : 0.42) * (climax ? 1.15 : 1) * part("pad");
      const choice = pad.textures?.[formId] ?? pad.textures?.[id] ?? "sustain";
      const picked: PadTexture = Array.isArray(choice) ? pick(visit, choice) : choice;
      // A chorale needs a melody to sing with; without one the chords are held.
      const texture: PadTexture = picked === "chorale" && leadLine.length === 0 ? "sustain" : picked;
      const voiceInstrument = (v: number): string => (texture === "pizzicato" ? (pad.pizzicato ?? "pizz") : (pad.voices?.[v] ?? style.instruments.pad));
      if (texture === "chorale") {
        // Voices singing with the melody, note for note: each takes a tone of the bar's chord below
        // the voice above it, as near as it can to where it was. Low voice on the root if it can.
        const ranges: [number, number][] = [[41, 60], [48, 67], [55, 72]];
        let last: (number | undefined)[] = [undefined, undefined, undefined];
        for (const sung of leadLine) {
          const chord = chords[Math.min(3, Math.floor((sung.row - start) / barRows))];
          const tones = triadDegrees(chord);
          // Voiced below the soprano's register: a low lead (a horn) then sings inside the choir.
          let above = sung.note;
          while (above < 64) above += 12;
          const voicing: number[] = [];
          for (const v of [2, 1, 0]) {
            const [lo, hi] = ranges[v];
            const wanted = v === 0 ? [tones[0]] : tones;
            let options = wanted.flatMap((d) => pitchesOf(key, d, lo, hi)).filter((m) => m <= above - 2);
            if (options.length === 0) options = tones.flatMap((d) => pitchesOf(key, d, Math.max(38, lo - 7), hi)).filter((m) => m <= above - 2);
            const from = last[v] ?? (lo + hi) / 2;
            const note = options.reduce((best, m) => (Math.abs(m - from) < Math.abs(best - from) ? m : best), options[0] ?? above - 12);
            voicing[v] = note;
            above = note;
          }
          voicing.forEach((note, v) => {
            put(sung.row, PADS[v], { note, instrument: voiceInstrument(v), volume: (0.4 + jitter(0.03)) * (climax ? 1.15 : 1) * part("pad") });
            if (sung.rest) put(sung.row + sung.dur, PADS[v], { note: "off" });
          });
          last = voicing;
        }
        // The chorale ends with the section: the next one strikes its chords afresh.
        for (const ch of PADS) put(start + phraseRows, ch, { note: "off" });
        padPlaying = undefined;
        padCore = undefined;
      } else if (texture === "pizzicato") {
        // Plucked chords: the voices take the beats in turn, low, middle, high, middle.
        chords.forEach((c, b) => {
          const voicing = padVoicing(key, triadDegrees(c), padCore);
          for (let beat = 0; beat < meter.beats; beat++) {
            const v = [0, 1, 2, 1][beat % 4];
            const volume = ((beat === 0 ? 0.6 : 0.46) + jitter(0.04)) * part("pad");
            put(start + b * barRows + beat * style.rowsPerBeat, PADS[v], { note: voicing[v], instrument: voiceInstrument(v), volume });
          }
          padCore = voicing;
        });
        // Plucks die away: the next section strikes its chords afresh.
        padPlaying = undefined;
        padCore = undefined;
      } else {
        chords.forEach((c, b) => {
          const row0 = start + b * barRows;
          const core = padVoicing(key, texture === "open" ? [c, c + 4, c] : chordColour(c), padCore);
          const voicing = texture === "wide" ? [core[0] - 12, core[1], core[2] + 12] : core;
          let suspended = false;
          voicing.forEach((note, v) => {
            if (b === 0) put(row0, PADS[v], { volume: fadeIn ? 0 : base });
            const before = padPlaying?.[v];
            if (before === note) return;
            let row = row0;
            if (before !== undefined && pad.suspensions && !suspended && before > note && before - note <= 2 && visit() < pad.suspensions) {
              // A suspension: the old note held into the new chord, stepping down a beat or two late.
              row += style.rowsPerBeat * pick(visit, [1, 2]);
              suspended = true;
            } else if (pad.stagger && before === undefined) {
              // Entering afresh, the voices come in one by one, low to high.
              row += v * style.rowsPerBeat;
            } else if (pad.stagger && visit() < pad.stagger) {
              row += 2;
            }
            // A passing note walks a third, on the last beat before the chord.
            if (before !== undefined && b > 0 && pad.passing && Math.abs(note - before) >= 3 && Math.abs(note - before) <= 4 && visit() < pad.passing) {
              const between = scaleBetween(key, before, note);
              const at = row0 - style.rowsPerBeat;
              if (between !== undefined && cells[at]?.[PADS[v]]?.note === undefined) put(at, PADS[v], { note: between, instrument: voiceInstrument(v) });
            }
            put(row, PADS[v], { note, instrument: voiceInstrument(v) });
          });
          padCore = core;
          padPlaying = voicing;
        });
        if (texture === "tremolo") for (let r = start; r < start + phraseRows; r++) for (const ch of PADS) put(r, ch, { effects: [{ type: "tremolo", depth: 0.45, rate: 9 }] });
      }
      if (fadeIn) for (const ch of PADS) slideRows(ch, start, barRows * 2, base);
      if (fadeOut) for (const ch of PADS) slideRows(ch, start + barRows * 2, barRows * 2, -base);
      // Each voice swells and ebbs on its own, over two bars, a bar and a half and a bar.
      if (pad.swell && texture !== "pizzicato" && texture !== "chorale") {
        PADS.forEach((ch, v) => {
          const length = [barRows * 2, (barRows * 3) / 2, barRows][v];
          const amount = 0.25 * base;
          for (let r = 0; r < phraseRows; r++) {
            const bar = Math.floor(r / barRows);
            if ((fadeIn && bar < 2) || (fadeOut && bar >= 2)) continue;
            const phase = (r / length + v / 3) % 1;
            put(start + r, ch, { effects: [{ type: "volumeSlide", perTick: ((phase < 0.5 ? 1 : -1) * amount) / ((length / 2) * style.ticksPerRow) }] });
          }
        });
      }
      padStarted = true;
    } else if (layers.has("pad")) {
      const base = (id === "B" || id === "B'" ? 0.5 : 0.42) * (climax ? 1.15 : 1) * part("pad");
      chords.forEach((c, b) => {
        const voicing = padVoicing(key, triadDegrees(c), padPlaying);
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
      padCore = undefined;
    }

    if (layers.has("bass")) {
      const base = 0.5 * part("bass");
      const enterBar = fadeIn ? 2 : 0;
      chords.forEach((c, b) => {
        if (b < enterBar) return;
        if (style.bassBeats) {
          // Struck on every beat, root and fifth in turn: the "oom" of a dance.
          for (let beat = 0; beat < meter.beats; beat++) {
            const note = beat % 2 === 0 || drone ? bassNote(key, drone ? 0 : c) : bassNote(key, c + 4);
            put(start + b * barRows + beat * style.rowsPerBeat, BASS, { note, instrument: style.instruments.bass, volume: base * (beat === 0 ? 1 : 0.8) });
            bassPlaying = note;
          }
          return;
        }
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
          const gap = (steps[i + 1]?.[0] ?? barRows) - row;
          const strong = row === 0 ? 0.56 : row % style.rowsPerBeat === 0 ? 0.46 : 0.38;
          const quiet = id === "O2" ? 0.7 : 1;
          let effects: Effect[] | undefined = row > 0 && visit() < 0.2 ? [{ type: "noteDelay", ticks: 1 }] : undefined;
          if (style.windDown && id === "O2" && b > 0) {
            // Running down: each note later and sinking, more with every bar.
            effects = [{ type: "noteDelay", ticks: Math.min(style.ticksPerRow - 1, b * 2) }];
            for (let r = 1; r < gap; r++) put(start + b * barRows + row + r, PLUCK, { effects: [{ type: "portamento", perTick: -0.03 * b }] });
          }
          put(start + b * barRows + row, PLUCK, { note: tones[tone], instrument: style.instruments.pluck, volume: (strong + jitter(0.05)) * quiet * part("pluck"), effects });
        });
      });
      plucking = true;
    } else if (plucking) {
      // Sampled plucks hold a quiet loop until let go.
      put(start, PLUCK, { note: "off" });
      plucking = false;
    }

    // Percussion. A style may leave out the frame drum or tambourine ("").
    const level = levelOf(formId);
    if (level >= 1) {
      for (let b = 0; b < 4; b++) {
        const bar = start + b * barRows;
        if (level === 1) {
          if (b % 2 === 0 && style.instruments.frameDrum) put(bar, FRAME, { note: DRUM_KEYS.dum, instrument: style.instruments.frameDrum, volume: (0.45 + jitter(0.04)) * part("drums") });
          continue;
        }
        for (const [row, name] of style.instruments.frameDrum ? framePattern : []) {
          const volume = ((name === "dum" ? 0.55 : 0.34) + jitter(0.05)) * part("drums");
          put(bar + row, FRAME, { note: DRUM_KEYS[name], instrument: style.instruments.frameDrum, volume });
        }
        const rollBar = b === 3 && (id === "B'" || id === "Ar'") && !!style.instruments.tambourine;
        for (const [row, name] of style.instruments.tambourine ? tambPattern : []) {
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

    // A roll on the low drum swelling into a climax or a full section, landing on its first beat.
    const next = form[index + 1];
    if (style.drumRoll && next && (next.endsWith("+") || levelOf(next) === 2) && visit() < style.drumRoll) {
      const from = start + phraseRows - barRows / 2;
      put(from, LOW, { note: DRUM_KEYS.boom, instrument: style.instruments.lowDrum, volume: 0.12 * part("drums"), effects: [{ type: "retrigger", every: 2, volumeFactor: 1.12 }] });
      for (let r = from + 1; r < start + phraseRows; r++) put(r, LOW, { effects: [{ type: "retrigger", every: 2, volumeFactor: 1.12 }] });
      put(start + phraseRows, LOW, { note: DRUM_KEYS.boom, instrument: style.instruments.lowDrum, volume: 0.65 * part("drums") });
    }

    // Sparkles: now and then a quick run over the chord high up, echoing away.
    const sparkle = style.sparkle;
    const wail = style.wail;
    if (wail && style.instruments.wail && layers.has("sparkle") && id !== "O2" && !climax && visit() < wail.chance) {
      // A voice rising out of nowhere into a long tonic or fifth, wavering, and fading away.
      const bar = visit() < 0.6 ? 0 : 2;
      const at = start + bar * barRows;
      const dur = barRows * 2;
      const note = pitchesOf(key, visit() < 0.6 ? 0 : 4, 60, 74)[0];
      const peak = (0.5 + jitter(0.05)) * part("wail");
      put(at, WAIL, { note, instrument: style.instruments.wail, volume: 0, effects: [{ type: "slideIn", semis: -pick(visit, wail.slide ?? [2, 3, 5]), ticks: style.ticksPerRow * 3 }] });
      slideRows(WAIL, at, barRows / 2, peak);
      slideRows(WAIL, at + barRows, dur - barRows, -peak);
      for (let r = barRows / 2; r < dur; r++) put(at + r, WAIL, { effects: [{ type: "vibrato", depth: 0.3, rate: 4.8 }] });
      put(at + dur, WAIL, { note: "off" });
    }
    if (sparkle && style.instruments.sparkle && layers.has("sparkle")) {
      chords.forEach((c, b) => {
        if (visit() >= sparkle.chance * (id === "O2" ? 0.5 : 1)) return;
        const count = sparkle.notes[0] + Math.floor(visit() * (sparkle.notes[1] - sparkle.notes[0] + 1));
        const step = pick(visit, sparkle.steps ?? [1, 1, 2]);
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

    // The crowd clapping along on the beats of a full section, never quite together.
    if (style.claps && style.instruments.clap && level === 2 && visit() < style.claps.chance) {
      for (let b = 0; b < 4; b++) {
        for (let beat = 0; beat < meter.beats; beat++) {
          const late: Effect[] | undefined = visit() < 0.4 ? [{ type: "noteDelay", ticks: 1 }] : undefined;
          put(start + b * barRows + beat * style.rowsPerBeat, CLAP, { note: 60, instrument: style.instruments.clap, volume: ((beat === 0 ? 0.5 : 0.42) + jitter(0.06)) * part("claps"), effects: late });
        }
      }
    }

    // The climax's key: everything but the drums, up.
    if (shift) {
      for (let r = start; r < start + phraseRows; r++) {
        cells[r].forEach((cell, channel) => {
          if (cell && typeof cell.note === "number" && MELODIC(channel) && channel !== WIND && channel !== CLAP) cell.note += shift;
        });
      }
    }
  });

  // Wind now and then: a passage of a few bars rising out of silence, the howl sliding to a new
  // pitch and gusting every bar, then dying away and let go. Quiet most of the time between.
  const wind = style.wind;
  if (wind && style.instruments.wind) {
    const level = wind.level * part("wind");
    const bars = totalRows / barRows;
    for (let b = 0; b < bars; b++) {
      if (visit() >= wind.chance) continue;
      const length = Math.min(bars - b, wind.bars[0] + Math.floor(visit() * (wind.bars[1] - wind.bars[0] + 1)));
      if (length < 2) break;
      const rise = Math.ceil(length / 3);
      const fall = Math.ceil(length / 3);
      let pitch = wind.pitch + Math.round((visit() * 2 - 1) * wind.drift);
      put(b * barRows, WIND, { note: pitch, instrument: style.instruments.wind, volume: 0 });
      slideRows(WIND, b * barRows, rise * barRows, level);
      for (let k = 0; k < length; k++) {
        const row = (b + k) * barRows;
        if (k > 0) {
          // XM tone portamento slides only on rows that carry it: every row of the bar does.
          const target = wind.pitch + Math.round((visit() * 2 - 1) * wind.drift);
          const perTick = Math.max(0.01, Math.abs(target - pitch) / (barRows * style.ticksPerRow));
          put(row, WIND, { note: target, effects: [{ type: "tonePortamento", perTick }] });
          for (let r = row + 1; r < row + barRows; r++) put(r, WIND, { effects: [{ type: "tonePortamento", perTick }] });
          pitch = target;
        }
        if (k >= rise && k < length - fall) {
          const gust = level * (0.2 + 0.5 * visit());
          const up = Math.max(1, Math.floor(barRows * (0.3 + 0.4 * visit())));
          slideRows(WIND, row, up, gust);
          slideRows(WIND, row + up, barRows - up, -gust);
        }
      }
      slideRows(WIND, (b + length - fall) * barRows, fall * barRows, -level);
      put((b + length) * barRows, WIND, { note: "off" });
      // At least a bar of quiet before the next.
      b += length;
    }
  }

  patterns.forEach((p, i) => (p.cells = cells.slice(i * phraseRows, (i + 1) * phraseRows)));

  return {
    style: style.id,
    placeSeed,
    visitSeed,
    bpm,
    rowsPerBeat: style.rowsPerBeat,
    ticksPerRow: style.ticksPerRow,
    beatsPerBar: meter.beats,
    channels: style.reverb ? channels.map((c) => ({ ...c, reverb: Math.min(1, c.reverb * style.reverb!) })) : channels,
    patterns,
    summary: {
      key: `${pitchClassName(key.tonic)} ${key.mode}`,
      tempo: `${bpm} bpm`,
      meter: meter.name ?? `${meter.beats}/4`,
      form: form.map(sectionLabel).join(" "),
      percussion: hasPercussion ? "yes" : "no",
      bass: drone ? "drone" : "follows the chords",
      intro: pluckFirst ? "pluck alone" : "pad",
      ...(leadRests.size ? { "lead rests in": [...leadRests].map(sectionLabel).join(", ") } : {}),
      ...(climaxShift ? { climax: `up ${climaxShift} semitones` } : {}),
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
    case "Br":
      return new Set(["pad", "bass"]);
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

/** Three close voices on a chord's tones (degrees), moving as little as they can from the last voicing. */
function padVoicing(key: Key, tones: number[], previous?: number[], lo = 53, hi = 70, span = 12): number[] {
  const [r, t, f] = tones.map((d) => pitchesOf(key, d, lo, hi));
  const last = previous?.length === 3 ? previous : undefined;
  let best: number[] = [];
  let bestScore = Infinity;
  for (const a of r) for (const b of t) for (const c of f) {
    const v = [a, b, c].sort((x, y) => x - y);
    if (v[2] - v[0] > span || v[0] === v[1] || v[1] === v[2]) continue;
    const score = last ? v.reduce((s, n, i) => s + Math.abs(n - last[i]), 0) : Math.abs((v[0] + v[2]) / 2 - 62);
    if (score < bestScore) {
      bestScore = score;
      best = v;
    }
  }
  // Open fifths and octaves need more room than a close triad.
  if (best.length === 0 && span === 12) return padVoicing(key, tones, previous, 48, 77, 19);
  return best;
}

/** The scale note between two pitches a third apart, if there is one. */
function scaleBetween(key: Key, a: number, b: number): number | undefined {
  for (let m = Math.min(a, b) + 1; m < Math.max(a, b); m++) if ((MODES[key.mode] as readonly number[]).includes(mod(m - key.tonic, 12))) return m;
  return undefined;
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
