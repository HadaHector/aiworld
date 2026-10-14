// The song model: what the composer writes and the player plays, close to a tracker module.
// Patterns are rows × channels of cells; a cell may start a note, set the channel's volume and carry
// effects that work tick by tick within its row. See MUSIC.md.

export type Role = "lead" | "counter" | "pad" | "bass" | "percussion";

/**
 * Effects follow the XM set by meaning, not by byte format, and take real numbers: volumes are
 * 0..1, pitches semitones. Slides run on every tick of their row but the first, as in XM.
 */
export type Effect =
  /** XM 0xy: the note, +x, +y semitones, one per tick. */
  | { type: "arpeggio"; x: number; y: number }
  /** XM 1xx / 2xx: pitch slide, semitones per tick (negative is down). */
  | { type: "portamento"; perTick: number }
  /** XM 3xx: slide from the playing pitch to the cell's note instead of starting a new one. */
  | { type: "tonePortamento"; perTick: number }
  /** XM 4xy: depth in semitones, rate in cycles per second. */
  | { type: "vibrato"; depth: number; rate: number }
  /** XM Axy: volume per tick. */
  | { type: "volumeSlide"; perTick: number }
  /** XM EDx: the note starts this many ticks into the row. */
  | { type: "noteDelay"; ticks: number }
  /** XM ECx: silence the note at this tick. */
  | { type: "noteCut"; ticks: number }
  /** XM E9x: strike the note again every `every` ticks, its volume times `volumeFactor` each time. */
  | { type: "retrigger"; every: number; volumeFactor: number }
  /** Ours: the note starts `semis` away and reaches its pitch in `ticks` - a slide into the note. */
  | { type: "slideIn"; semis: number; ticks: number };

export type EffectType = Effect["type"];

export interface Cell {
  /** A MIDI note to start, or "off" to release the playing one. */
  note?: number | "off";
  /** Instrument id; the channel keeps the last one. */
  instrument?: string;
  /** Channel volume 0..1, from this row on. */
  volume?: number;
  effects?: Effect[];
}

export interface Channel {
  name: string;
  role: Role;
  /** -1 left .. 1 right. */
  pan: number;
  /** Reverb send 0..1. */
  reverb: number;
}

export interface Pattern {
  /** The section this pattern plays, e.g. "A" or "Intro". */
  section: string;
  rows: number;
  /** cells[row][channel]; undefined is an empty cell. */
  cells: (Cell | undefined)[][];
  /** Chord names and where they start, for display. */
  chords: { row: number; name: string }[];
}

export interface Song {
  style: string;
  placeSeed: number;
  visitSeed: number;
  bpm: number;
  rowsPerBeat: number;
  ticksPerRow: number;
  beatsPerBar: number;
  channels: Channel[];
  /** In play order. */
  patterns: Pattern[];
  /** What the composer chose, for display. */
  summary: Record<string, string>;
}

export function tickSeconds(song: Song): number {
  return 60 / (song.bpm * song.rowsPerBeat * song.ticksPerRow);
}

export function rowSeconds(song: Song): number {
  return tickSeconds(song) * song.ticksPerRow;
}

export function songRows(song: Song): number {
  return song.patterns.reduce((sum, p) => sum + p.rows, 0);
}

/** A note as heard: from its row until the channel's next note or note-off. */
export interface SongNote {
  channel: number;
  note: number;
  instrument: string;
  /** Rows from the start of the song. */
  start: number;
  end: number;
  volume: number;
}

export function songNotes(song: Song): SongNote[] {
  const notes: SongNote[] = [];
  const open: (SongNote | undefined)[] = song.channels.map(() => undefined);
  const instruments: string[] = song.channels.map(() => "");
  const volumes: number[] = song.channels.map(() => 1);
  let base = 0;
  for (const pattern of song.patterns) {
    for (let row = 0; row < pattern.rows; row++) {
      pattern.cells[row].forEach((cell, channel) => {
        if (!cell) return;
        if (cell.instrument) instruments[channel] = cell.instrument;
        if (cell.volume !== undefined) volumes[channel] = cell.volume;
        if (cell.note === undefined) return;
        const isPorta = cell.effects?.some((e) => e.type === "tonePortamento") && open[channel];
        if (isPorta) return;
        const current = open[channel];
        if (current) current.end = base + row;
        open[channel] = undefined;
        if (cell.note === "off") return;
        const note: SongNote = { channel, note: cell.note, instrument: instruments[channel], start: base + row, end: base + row + 1, volume: volumes[channel] };
        notes.push(note);
        open[channel] = note;
      });
    }
    base += pattern.rows;
  }
  for (const note of open) if (note) note.end = base;
  return notes;
}
