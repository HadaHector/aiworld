// Styles: the authored part of the music. A style is a ruleset the composer follows - modes, how
// chords move, rhythms, form, which instruments play which roles - never pre-written bars. Kept in
// code for the first pass; they move to pack json5 once the shape settles. See MUSIC.md.

import type { ModeName } from "./theory";

/** A rhythm for one bar, in rows; a negative length is a rest. */
export type Rhythm = number[];

/** A plucked pattern for one bar: [row, chord tone] with tones 0 root, 1 third, 2 fifth, 3 octave, 4 tenth. */
export type PluckPattern = [number, number][];

/** A drum pattern for one bar: [row, articulation key name]. */
export type DrumPattern = [number, string][];

export interface MeterRules {
  beats: number;
  /** Motif and free-bar rhythms. */
  rhythms: Rhythm[];
  /** Longer rhythms for the contrasting B section. */
  calmRhythms: Rhythm[];
  /** The last bar of a phrase, ending on a long note. */
  cadenceRhythms: Rhythm[];
  plucks: PluckPattern[];
  frameDrum: DrumPattern[];
  tambourine: DrumPattern[];
}

export interface Style {
  id: string;
  name: string;
  modes: [ModeName, number][];
  /** Tonic pitch classes. */
  tonics: number[];
  bpm: [number, number];
  meters: [MeterRules, number][];
  rowsPerBeat: number;
  ticksPerRow: number;
  /** How likely each degree is as a chord, before the cadence rules. */
  chordWeights: Record<number, number>;
  /** Forms, as lists of section ids (see composer). */
  forms: [string[], number][];
  percussionChance: number;
  droneChance: number;
  /** Chance the intro starts with the plucked instrument alone instead of the pad. */
  pluckFirstChance: number;
  instruments: { lead: string; pluck: string; pad: string; bass: string; frameDrum: string; tambourine: string; lowDrum: string; sparkle?: string };
  // Optional knobs; absent is off.
  /** Chance a lead phrase sits out (never the outro's), leaving the accompaniment alone. */
  leadRestChance?: number;
  /** Chance a long lead note opens with a trill to the step above. */
  trillChance?: number;
  /** Pads swell and ebb in every bar by this share of their volume. */
  padBreath?: number;
  /** Semitones the plucked accompaniment sits above its usual low-middle register. */
  pluckShift?: number;
  /** Quick high runs over the chord on their own channel: chance per bar and how many notes. */
  sparkle?: { chance: number; notes: [number, number] };
  /** Volume of each part, 1 by default. */
  mix?: Partial<Record<"lead" | "pluck" | "pad" | "bass" | "drums" | "sparkle", number>>;
}

const FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [4, 4, 8],
    [6, 2, 4, 4],
    [4, 2, 2, 8],
    [8, 4, 4],
    [-4, 4, 4, 4],
    [4, 4, 4, 4],
    [6, 2, 8],
    [2, 2, 4, 8],
  ],
  calmRhythms: [[8, 8], [12, 4], [8, 4, 4], [-4, 4, 8], [6, 2, 8]],
  cadenceRhythms: [[16], [4, 12], [2, 2, 12], [8, 8]],
  plucks: [
    [[0, 0], [4, 2], [8, 3], [12, 1]],
    [[0, 0], [2, 2], [4, 3], [6, 1], [8, 2], [10, 3], [12, 4], [14, 2]],
    [[0, 0], [3, 2], [6, 3], [8, 1], [12, 2]],
    [[0, 0], [4, 2], [6, 3], [8, 4], [12, 2]],
  ],
  frameDrum: [
    [[0, "dum"], [8, "dum"], [12, "tek"]],
    [[0, "dum"], [6, "tek"], [8, "dum"], [14, "tek"]],
    [[0, "dum"], [4, "tek"], [10, "dum"], [12, "tek"]],
  ],
  tambourine: [
    [[4, "shake"], [12, "shake"]],
    [[4, "shake"], [10, "shake"], [12, "hit"]],
  ],
};

const THREE: MeterRules = {
  beats: 3,
  rhythms: [
    [4, 4, 4],
    [6, 2, 4],
    [8, 4],
    [4, 2, 2, 4],
    [2, 2, 8],
    [-4, 4, 4],
    [4, 8],
  ],
  calmRhythms: [[12], [8, 4], [-4, 8], [6, 2, 4]],
  cadenceRhythms: [[12], [4, 8], [2, 2, 8]],
  plucks: [
    [[0, 0], [4, 2], [8, 3]],
    [[0, 0], [2, 2], [4, 3], [6, 1], [8, 2], [10, 3]],
    [[0, 0], [4, 2], [6, 3], [8, 1]],
  ],
  frameDrum: [
    [[0, "dum"], [8, "tek"]],
    [[0, "dum"], [4, "tek"], [8, "tek"]],
    [[0, "dum"], [6, "dum"], [8, "tek"]],
  ],
  tambourine: [[[4, "shake"], [8, "shake"]], [[8, "hit"]]],
};

export const FOREST: Style = {
  id: "forest",
  name: "Forest - medieval ambient",
  modes: [
    ["dorian", 3],
    ["aeolian", 3],
    ["mixolydian", 2],
  ],
  tonics: [2, 4, 7, 9],
  bpm: [64, 84],
  meters: [
    [FOUR, 3],
    [THREE, 2],
  ],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  chordWeights: { 0: 3, 1: 0.4, 2: 1.4, 3: 2, 4: 1.4, 5: 1.6, 6: 2.4 },
  forms: [
    [["I1", "I2", "A", "A'", "B", "B'", "Ar", "Ar'", "O1", "O2"], 3],
    [["I1", "A", "A'", "B", "B'", "Ar'", "O1", "O2"], 2],
    [["I1", "I2", "A", "A'", "Ar", "Ar'", "O1", "O2"], 1],
  ],
  percussionChance: 0.65,
  droneChance: 0.35,
  pluckFirstChance: 0.3,
  instruments: { lead: "flute", pluck: "guitar", pad: "strings", bass: "bass", frameDrum: "frameDrum", tambourine: "tambourine", lowDrum: "lowDrum" },
};

const GLADE_FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [8, 8],
    [12, 4],
    [4, 12],
    [-4, 12],
    [6, 2, 8],
    [-8, 4, 4],
  ],
  calmRhythms: [[16], [-8, 8], [12, 4], [-4, 12]],
  cadenceRhythms: [[16], [4, 12]],
  plucks: [
    // Harp: rising sweeps that leave space, and slow broken chords.
    [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [10, 3], [12, 2]],
    [[0, 0], [2, 2], [4, 3], [6, 4], [8, 3], [10, 2], [12, 1], [14, 2]],
    [[0, 0], [6, 2], [8, 3], [14, 4]],
    [[0, 0], [4, 1], [8, 2], [12, 4]],
  ],
  frameDrum: [[[0, "dum"]], [[0, "dum"], [10, "tek"]]],
  tambourine: [[[8, "shake"]], [[12, "shake"]]],
};

const GLADE_THREE: MeterRules = {
  beats: 3,
  rhythms: [
    [12],
    [8, 4],
    [4, 8],
    [-4, 8],
    [6, 6],
  ],
  calmRhythms: [[12], [-4, 8], [-6, 6]],
  cadenceRhythms: [[12], [4, 8]],
  plucks: [
    [[0, 0], [2, 1], [4, 2], [6, 3], [8, 4], [10, 2]],
    [[0, 0], [4, 2], [8, 4]],
    [[0, 0], [1, 1], [2, 2], [3, 3], [8, 4]],
  ],
  frameDrum: [[[0, "dum"]]],
  tambourine: [[[6, "shake"]]],
};

/**
 * Ambient and a little mysterious, but alive: a breathing choir over a drone, harp sweeps, a flute
 * that comes and goes with bird-like trills, and bells sparkling high up. Lydian for the magic,
 * Dorian and Aeolian for the shade. Hardly any percussion.
 */
export const GLADE: Style = {
  id: "glade",
  name: "Glade - mysterious, magical nature",
  modes: [
    ["lydian", 4],
    ["dorian", 2],
    ["aeolian", 1],
    ["mixolydian", 1],
  ],
  tonics: [0, 2, 4, 5, 7, 9],
  bpm: [54, 68],
  meters: [
    [GLADE_FOUR, 3],
    [GLADE_THREE, 2],
  ],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  chordWeights: { 0: 3, 1: 2.2, 2: 1.2, 3: 1, 4: 1.2, 5: 1.8, 6: 1.4 },
  forms: [
    [["I1", "I2", "A", "A'", "B", "B'", "Ar'", "O1", "O2"], 2],
    [["I1", "I2", "B", "A", "A'", "B'", "O1", "O2"], 1],
    [["I1", "I2", "A", "A'", "B", "B'", "Ar", "Ar'", "O1", "O2"], 1],
  ],
  percussionChance: 0.25,
  droneChance: 0.8,
  pluckFirstChance: 0.4,
  instruments: { lead: "flute", pluck: "harp", pad: "choir", bass: "bass", frameDrum: "frameDrum", tambourine: "tambourine", lowDrum: "lowDrum", sparkle: "bells" },
  leadRestChance: 0.3,
  trillChance: 0.35,
  padBreath: 0.3,
  pluckShift: 12,
  sparkle: { chance: 0.4, notes: [3, 6] },
  mix: { lead: 0.85, pluck: 0.8, pad: 1.15, bass: 0.8, drums: 0.6 },
};

export const STYLES: Style[] = [FOREST, GLADE];
