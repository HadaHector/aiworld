// The main theme: a composed piece, not a generated one. Every note of its melodies is written out
// below; the accompaniment (harp, string chords, bass, drums, choir) follows the chords by the
// rules each section asks for. It plays through the same tracker player as everything else.
// See MUSIC.md.

import type { Cell, Channel, Effect, Pattern, Song } from "../song";

const ROWS_PER_BEAT = 4;
const BAR = 16;

const CHANNELS: Channel[] = [
  { name: "Melody", role: "lead", pan: -0.05, reverb: 0.45 },
  { name: "Harp", role: "counter", pan: 0.35, reverb: 0.4 },
  { name: "Strings 1", role: "pad", pan: -0.4, reverb: 0.55 },
  { name: "Strings 2", role: "pad", pan: 0, reverb: 0.55 },
  { name: "Strings 3", role: "pad", pan: 0.4, reverb: 0.55 },
  { name: "Bass", role: "bass", pan: 0, reverb: 0.3 },
  { name: "Taiko", role: "percussion", pan: -0.15, reverb: 0.35 },
  { name: "Timpani", role: "percussion", pan: 0.1, reverb: 0.45 },
  { name: "Counter", role: "lead", pan: 0.25, reverb: 0.5 },
  { name: "Choir", role: "pad", pan: -0.2, reverb: 0.7 },
];
const [MELODY, HARP, S1, S2, S3, BASS, TAIKO, TIMPANI, COUNTER, CHOIR] = CHANNELS.map((_, i) => i);
const STRINGS = [S1, S2, S3];

// ---------------------------------------------------------------------------------------------
// Notation. A part is bars split by "|", each bar a run of NOTE:LENGTH in sixteenths ("F#5:4",
// "Bb3:8"), "r" for a rest. A bar's lengths must fill it. Chords are one or two per bar ("G A"
// splits the bar), major or minor ("Bm").

const NOTE_NAMES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitch(name: string): number {
  const m = name.match(/^([A-G])([#b]?)(-?\d)$/);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE_NAMES[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

interface Written {
  row: number;
  length: number;
  /** Undefined for a rest. */
  note?: number;
}

function part(text: string, bars: number): Written[] {
  const out: Written[] = [];
  const measures = text.split("|").map((m) => m.trim());
  if (measures.length !== bars) throw new Error(`part has ${measures.length} bars, wants ${bars}: ${text}`);
  measures.forEach((measure, b) => {
    let row = b * BAR;
    for (const token of measure.split(/\s+/)) {
      const [name, len] = token.split(":");
      const length = Number(len);
      out.push({ row, length, note: name === "r" ? undefined : pitch(name) });
      row += length;
    }
    if (row !== (b + 1) * BAR) throw new Error(`bar ${b + 1} lasts ${row - b * BAR} sixteenths: ${measure}`);
  });
  return out;
}

interface Chord {
  root: number;
  minor: boolean;
  name: string;
}

/** The chords of each bar: one or two (a half bar each). */
function chords(text: string, bars: number): Chord[][] {
  const out = text.split("|").map((bar) =>
    bar.trim().split(/\s+/).map((name) => {
      const m = name.match(/^([A-G])([#b]?)(m?)$/);
      if (!m) throw new Error(`bad chord ${name}`);
      return { root: NOTE_NAMES[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0), minor: m[3] === "m", name };
    }),
  );
  if (out.length !== bars) throw new Error(`chords for ${out.length} bars, want ${bars}`);
  return out;
}

const tones = (c: Chord): number[] => [c.root, c.root + (c.minor ? 3 : 4), c.root + 7].map((t) => ((t % 12) + 12) % 12);
/** The lowest pitch of a pitch class at or above `low`. */
const above = (pc: number, low: number): number => low + ((((pc - low) % 12) + 12) % 12);

// ---------------------------------------------------------------------------------------------
// The score.

interface Section {
  label: string;
  bars: number;
  chords: string;
  /** Semitones the whole section is moved: the climax goes up a whole step. */
  transpose?: number;
  melody?: { part: string; instrument: string; volume: number; octave?: number };
  counter?: { part: string; instrument: string; volume: number; octave?: number };
  /** The strings' level, and whether they spread wide or swell in from nothing. */
  strings: { volume: number; wide?: boolean; swell?: boolean; open?: boolean };
  harp?: "flowing" | "rising" | "sparse";
  bass?: "halves" | "beats" | "late";
  taiko?: "soft" | "build" | "full" | "fanfare";
  /** Timpani: a stroke on the downbeat, a roll into the next section, or both. */
  timpani?: { hit?: boolean; roll?: boolean; final?: boolean };
  choir?: boolean;
}

const THEME = "D5:6 A4:2 D5:4 E5:4 | F#5:8 E5:4 D5:4 | B4:6 D5:2 G5:4 F#5:4 | E5:8 A4:4 C#5:4 | D5:6 A4:2 D5:4 E5:4 | F#5:6 G5:2 A5:4 F#5:4 | G5:4 F#5:4 E5:4 C#5:4 | D5:12 r:4";
const THEME_CHORDS = "D | Bm | G | A | D | Bm | G A | D";

const SCORE: Section[] = [
  {
    label: "Intro",
    bars: 4,
    chords: "D | D | C | A",
    counter: { part: "r:16 | D4:6 A3:2 D4:8 | E4:6 C4:2 G4:8 | A3:4 C#4:4 E4:4 A4:4", instrument: "horn", volume: 0.62 },
    strings: { volume: 0.42, swell: true, open: true },
    harp: "rising",
    bass: "late",
    timpani: { roll: true },
  },
  {
    label: "A",
    bars: 8,
    chords: THEME_CHORDS,
    melody: { part: THEME, instrument: "flute", volume: 0.62 },
    strings: { volume: 0.34 },
    harp: "flowing",
    bass: "halves",
    timpani: { hit: true },
  },
  {
    label: "A2",
    bars: 8,
    chords: THEME_CHORDS,
    melody: { part: THEME, instrument: "horn", volume: 0.66, octave: -1 },
    counter: { part: "F#5:8 A5:8 | B5:12 A5:4 | G5:8 B5:8 | C#6:8 A5:8 | D6:12 C#6:4 | B5:8 D6:8 | B5:8 C#6:8 | D6:16", instrument: "violin", volume: 0.42 },
    strings: { volume: 0.42 },
    harp: "flowing",
    bass: "halves",
    taiko: "soft",
    timpani: { hit: true },
  },
  {
    label: "B",
    bars: 8,
    chords: "Bm | Em | D | F#m | Bm | G | Em | B",
    melody: { part: "F#5:4 B5:8 A5:4 | G5:6 F#5:2 E5:8 | F#5:4 A5:8 G5:4 | F#5:12 E5:4 | D5:4 F#5:4 B5:4 C#6:4 | D6:8 B5:8 | G5:4 F#5:4 E5:4 G5:4 | B5:8 A5:4 F#5:4", instrument: "violin", volume: 0.64 },
    strings: { volume: 0.5 },
    harp: "sparse",
    bass: "halves",
    taiko: "build",
    timpani: { hit: true, roll: true },
    choir: true,
  },
  {
    label: "A3+",
    bars: 8,
    chords: THEME_CHORDS,
    transpose: 2,
    melody: { part: THEME, instrument: "violin", volume: 0.7 },
    counter: { part: THEME, instrument: "horn", volume: 0.55, octave: -1 },
    strings: { volume: 0.55, wide: true },
    harp: "flowing",
    bass: "beats",
    taiko: "full",
    timpani: { hit: true },
    choir: true,
  },
  {
    label: "Outro",
    bars: 4,
    chords: "E | A | B | E",
    melody: { part: "E5:6 B4:2 E5:4 G#5:4 | A5:8 G#5:4 F#5:4 | F#5:4 G#5:4 A5:4 B5:4 | E6:16", instrument: "violin", volume: 0.72 },
    counter: { part: "E5:6 B4:2 E5:4 G#5:4 | A5:8 G#5:4 F#5:4 | F#5:4 G#5:4 A5:4 B5:4 | E6:16", instrument: "horn", volume: 0.58, octave: -1 },
    strings: { volume: 0.55, wide: true },
    harp: "rising",
    bass: "beats",
    taiko: "fanfare",
    timpani: { hit: true, roll: true, final: true },
    choir: true,
  },
];

// ---------------------------------------------------------------------------------------------
// The arrangement.

/** The theme as a song, every note fixed: the same each time it plays. */
export function mainThemeSong(): Song {
  const total = SCORE.reduce((sum, s) => sum + s.bars * BAR, 0);
  const cells: (Cell | undefined)[][] = Array.from({ length: total + BAR }, () => CHANNELS.map(() => undefined));
  const put = (row: number, channel: number, cell: Cell): void => {
    const existing = cells[row]?.[channel];
    if (!cells[row]) return;
    if (!existing) {
      cells[row][channel] = cell;
      return;
    }
    const effects = [...(existing.effects ?? []), ...(cell.effects ?? [])];
    cells[row][channel] = { ...existing, ...cell, effects: effects.length ? effects : undefined };
  };
  const slide = (channel: number, from: number, rows: number, total: number): void => {
    const perTick = total / (rows * 6);
    for (let r = from; r < from + rows; r++) put(r, channel, { effects: [{ type: "volumeSlide", perTick }] });
  };

  let start = 0;
  let voicing: number[] | undefined;
  const patterns: Pattern[] = [];
  for (const section of SCORE) {
    const shift = section.transpose ?? 0;
    const bars = chords(section.chords, section.bars).map((bar) => bar.map((c) => ({ ...c, root: c.root + shift })));
    const chordAt = (row: number): Chord => {
      const bar = bars[Math.floor(row / BAR)];
      return bar[bar.length > 1 && row % BAR >= BAR / 2 ? 1 : 0];
    };
    const name = (c: Chord): string => ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"][((c.root % 12) + 12) % 12] + (c.minor ? "m" : "");

    // Melody and counter-melody: written out, legato within a phrase, let go at rests.
    const line = (spec: NonNullable<Section["melody"]>, channel: number): void => {
      const notes = part(spec.part, section.bars);
      notes.forEach((n, i) => {
        const row = start + n.row;
        if (n.note === undefined) {
          put(row, channel, { note: "off" });
          return;
        }
        const strong = n.row % (BAR / 2) === 0 ? 0.05 : 0;
        const long = n.length >= 8;
        const effects: Effect[] = [];
        // Long notes swell a little, then fall away, as a player leans into them.
        put(row, channel, { note: n.note + shift + 12 * (spec.octave ?? 0), instrument: spec.instrument, volume: Math.min(1, spec.volume + strong), effects: effects.length ? effects : undefined });
        if (long) {
          slide(channel, row + 1, Math.floor(n.length / 3), 0.06);
          slide(channel, row + n.length - Math.floor(n.length / 2), Math.floor(n.length / 2), -0.12);
        }
        const next = notes[i + 1];
        if (!next && channel === MELODY) put(row + n.length, channel, { note: "off" });
      });
    };
    if (section.melody) line(section.melody, MELODY);
    else put(start, MELODY, { note: "off" });
    if (section.counter) line(section.counter, COUNTER);
    else put(start, COUNTER, { note: "off" });

    // Strings: three voices on the chord, moving as little as they can; bare fifths when open,
    // spread an octave either way when wide, swelling in from nothing when asked.
    for (let b = 0; b < section.bars; b++) {
      for (const half of bars[b].length > 1 ? [0, 1] : [0]) {
        const chord = bars[b][half];
        const pcs = section.strings.open ? [chord.root, chord.root + 7, chord.root].map((t) => ((t % 12) + 12) % 12) : tones(chord);
        let best: number[] = [];
        let score = Infinity;
        for (const a of [0, 1, 2]) for (const lowStart of [52, 55, 58]) {
          const v = [above(pcs[a], lowStart), above(pcs[(a + 1) % 3], lowStart + 3), above(pcs[(a + 2) % 3], lowStart + 6)].sort((x, y) => x - y);
          if (v[2] - v[0] > 14 || v[0] === v[1] || v[1] === v[2]) continue;
          const s = voicing ? v.reduce((sum, n, i) => sum + Math.abs(n - voicing![i]), 0) : Math.abs(v[1] - 62);
          if (s < score) (score = s), (best = v);
        }
        if (!best.length) best = [above(pcs[0], 48), above(pcs[1], 55), above(pcs[2], 60)];
        const sounding = section.strings.wide ? [best[0] - 12, best[1], best[2] + 12] : best;
        const row = start + b * BAR + half * (BAR / 2);
        sounding.forEach((note, v) => {
          const fresh = !voicing || voicing[v] !== best[v] || row === start;
          const cell: Cell = fresh ? { note, instrument: ["stringsLow", "strings", "stringsHigh"][v] } : {};
          if (row === start) cell.volume = section.strings.swell ? 0 : section.strings.volume;
          if (cell.note !== undefined || cell.volume !== undefined) put(row, STRINGS[v], cell);
        });
        voicing = best;
      }
    }
    if (section.strings.swell) for (const ch of STRINGS) slide(ch, start, BAR * 2, section.strings.volume);

    // Harp: eighth-note arpeggios on each chord, rising and falling; sparse ones on the beats.
    if (section.harp) {
      for (let row = 0; row < section.bars * BAR; row += 2) {
        const chord = chordAt(row);
        const root = above(chord.root, 50);
        const ladder = [root, root + 7, root + 12, root + 12 + (chord.minor ? 3 : 4), root + 19, root + 24];
        const step = (row % BAR) / 2;
        const shapes = { flowing: [0, 1, 2, 3, 4, 3, 2, 1], rising: [0, 1, 2, 3, 4, 5, 4, 3], sparse: [0, -1, 2, -1, 3, -1, 4, -1] };
        const index = shapes[section.harp][step];
        if (index < 0) continue;
        put(start + row, HARP, { note: ladder[index], instrument: "harp", volume: (step === 0 ? 0.5 : 0.38) + (section.harp === "rising" ? 0.04 * step / 7 : 0) });
      }
    }

    // Bass: the root on the half bars; on every beat (root and fifth) when the music drives.
    if (section.bass) {
      for (let row = section.bass === "late" ? 2 * BAR : 0; row < section.bars * BAR; row += section.bass === "beats" ? ROWS_PER_BEAT : BAR / 2) {
        const chord = chordAt(row);
        const fifth = section.bass === "beats" && (row / ROWS_PER_BEAT) % 2 === 1;
        put(start + row, BASS, { note: above(fifth ? chord.root + 7 : chord.root, 38), instrument: "bass", volume: 0.55 });
      }
    }

    // Taiko: soft on one and three; a build, adding strokes bar by bar; the full drive; a fanfare.
    if (section.taiko) {
      for (let b = 0; b < section.bars; b++) {
        const bar = start + b * BAR;
        const hits: [number, "dum" | "tek", number][] =
          section.taiko === "soft" ? [[0, "dum", 0.32], [8, "dum", 0.26]]
          : section.taiko === "build" ? (b < 4 ? [[0, "dum", 0.32], [8, "dum", 0.28]] : [[0, "dum", 0.4], [6, "tek", 0.25], [8, "dum", 0.4], [12, "tek", 0.28], [14, "tek", 0.3 + 0.03 * b]])
          : section.taiko === "full" ? [[0, "dum", 0.5], [6, "tek", 0.3], [8, "dum", 0.45], [11, "tek", 0.3], [12, "tek", 0.34], [14, "dum", 0.38]]
          : b < 3 ? [[0, "dum", 0.5], [4, "tek", 0.32], [8, "dum", 0.45], [12, "tek", 0.36]] : [[0, "dum", 0.6]];
        for (const [row, stroke, volume] of hits) put(bar + row, TAIKO, { note: stroke === "dum" ? 60 : 62, instrument: "taiko", volume });
      }
    }

    // Timpani: a stroke to open the section, a roll swelling into the next, a last stroke to end.
    if (section.timpani?.hit) put(start, TIMPANI, { note: 60, instrument: "timpani", volume: 0.55 });
    if (section.timpani?.roll) {
      const from = start + section.bars * BAR - (section.timpani.final ? BAR : BAR / 2);
      put(from, TIMPANI, { note: 60, instrument: "timpani", volume: 0.14, effects: [{ type: "retrigger", every: 2, volumeFactor: 1.08 }] });
      for (let r = from + 1; r < start + section.bars * BAR; r++) put(r, TIMPANI, { effects: [{ type: "retrigger", every: 2, volumeFactor: 1.08 }] });
      put(start + section.bars * BAR, TIMPANI, { note: 60, instrument: "timpani", volume: section.timpani.final ? 0.7 : 0.6 });
    }

    // Choir: an "aah" holding the chord's third (or root), above the strings, a bar at a time.
    if (section.choir) {
      for (let b = 0; b < section.bars; b++) {
        const chord = bars[b][0];
        const note = above(chord.root + (chord.minor ? 3 : 4), 64);
        put(start + b * BAR, CHOIR, { note, instrument: "choir", volume: b === 0 ? 0.42 : undefined });
      }
    } else {
      put(start, CHOIR, { note: "off" });
    }

    patterns.push({ section: section.label, rows: section.bars * BAR, cells: [], chords: bars.map((bar, b) => ({ row: b * BAR, name: bar.map(name).join(" ") })) });
    start += section.bars * BAR;
  }

  // The last chord rings on a bar: strings, choir and counter hold, then everything is let go.
  patterns.push({ section: "End", rows: BAR, cells: [], chords: [{ row: 0, name: "E" }] });
  for (const ch of [...STRINGS, CHOIR]) slide(ch, start, BAR, -0.5);
  for (const ch of CHANNELS.map((_, i) => i)) put(start + BAR - 1, ch, { note: "off" });

  let row = 0;
  for (const p of patterns) {
    p.cells = cells.slice(row, row + p.rows);
    row += p.rows;
  }
  return {
    style: "mainTheme",
    placeSeed: 0,
    visitSeed: 0,
    bpm: 96,
    rowsPerBeat: ROWS_PER_BEAT,
    ticksPerRow: 6,
    beatsPerBar: 4,
    channels: CHANNELS,
    patterns,
    rubato: 0.6,
    room: { seconds: 3.8, damping: 0.35 },
    echo: 0.3,
    summary: { piece: "Main theme (composed)", key: "D major, the climax in E", tempo: "96 bpm", form: SCORE.map((s) => s.label).join(" ") },
  };
}
