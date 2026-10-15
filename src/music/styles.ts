// Styles: the authored part of the music. A style is a ruleset the composer follows - modes, how
// chords move, rhythms, form, which instruments play which roles - never pre-written bars. Kept in
// code for the first pass; they move to pack json5 once the shape settles. See MUSIC.md.

import type { ModeName } from "./theory";

/**
 * How the pad plays a section: held chords ("sustain"), bare fifths and octaves ("open"), spread an
 * octave wider ("wide"), bowed tremolo ("tremolo"), plucked on the beats ("pizzicato"), or as voices
 * singing with the melody note for note, in harmony below it ("chorale"; held chords where there
 * is no melody).
 */
export type PadTexture = "sustain" | "open" | "wide" | "tremolo" | "pizzicato" | "chorale";

/** Another instrument that may take a theme's lead, `shift` semitones from the usual. */
export interface LeadAlternate {
  instrument: string;
  chance: number;
  shift?: number;
}

/** A rhythm for one bar, in rows; a negative length is a rest. */
export type Rhythm = number[];

/** A plucked pattern for one bar: [row, chord tone] with tones 0 root, 1 third, 2 fifth, 3 octave, 4 tenth. */
export type PluckPattern = [number, number][];

/** A drum pattern for one bar: [row, articulation key name]. */
export type DrumPattern = [number, string][];

export interface MeterRules {
  beats: number;
  /** For display, when beats over four is not it: "6/8" for two beats of three eighths. */
  name?: string;
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
  /**
   * Forms, as lists of section ids: I1 I2 intro, A A' the theme, B B' its contrast, Ar Ar' the theme
   * decorated, C a third theme, D a development, Br a breath, O1 O2 outro; "+" makes a section a
   * climax in a new key.
   */
  forms: [string[], number][];
  percussionChance: number;
  droneChance: number;
  /** Chance the intro starts with the plucked instrument alone instead of the pad. */
  pluckFirstChance: number;
  /** frameDrum and tambourine may be "" for none. */
  instruments: { lead: string; pluck: string; pad: string; bass: string; frameDrum: string; tambourine: string; lowDrum: string; sparkle?: string; wail?: string; wind?: string; clap?: string };
  // Optional knobs; absent is off.
  /** Chance a lead phrase sits out (never the outro's), leaving the accompaniment alone. */
  leadRestChance?: number;
  /** Chance a long lead note opens with a trill to the step above. */
  trillChance?: number;
  /** Pads swell and ebb in every bar by this share of their volume. */
  padBreath?: number;
  /** Semitones the plucked accompaniment sits above its usual low-middle register. */
  pluckShift?: number;
  /** Quick high runs over the chord on their own channel: chance per bar, notes per run, rows per note. */
  sparkle?: { name?: string; chance: number; notes: [number, number]; steps?: number[] };
  /** A long voice rising into the tonic or fifth on its own channel, chance per phrase, sliding up from `slide` semitones below. At a climax it doubles the melody instead. */
  wail?: { name?: string; chance: number; slide?: number[]; double?: number };
  /**
   * Wind on its own channel, now and then: a passage of `bars` bars may start at any quiet bar with
   * `chance`, around `pitch` (where the howl sits), at `level`, sliding to a new pitch up to
   * `drift` semitones away and gusting every bar.
   */
  wind?: { pitch: number; level: number; drift: number; chance: number; bars: [number, number] };
  /** Semitones the lead sits from its usual register. */
  leadShift?: number;
  /** Instead, the lead's tonic is the one within a tritone of this pitch. */
  leadCenter?: number;

  /** Semitones a climax section ("A+") moves the key, one picked per song. */
  climaxShift?: number[];
  /** Chance the low drum rolls into a climax or a full section. */
  drumRoll?: number;
  /** Chords that end phrases and open the B section, as [degree, weight]; defaults suit Western modes. */
  cadences?: { half?: [number, number][]; leading?: [number, number][]; contrast?: [number, number][]; back?: [number, number][] };
  /** Chance a melody note slides in from the step above or below. */
  slideChance?: number;
  /** Chance a lead phrase is played by another instrument instead, `shift` semitones from the usual. */
  leadAlternate?: LeadAlternate | LeadAlternate[];
  /** Call and response: the second phrase of every theme (A', B'...) is sung by this instead. */
  answer?: { instrument: string; shift?: number };
  /** Chance a lead phrase glides from note to note where they join, like a musical saw. */
  glideChance?: number;
  /** Chance a long lead note sags flat as it fades. */
  sagChance?: number;
  /** In the last outro the plucks slow and drop in pitch, a music box running down. */
  windDown?: boolean;
  /** Every channel's reverb send times this: a bigger, wetter space. */
  reverb?: number;
  /** The crowd claps on every beat, a little ragged, in a full section with this chance. */
  claps?: { chance: number };
  /** The bass strikes every beat, root and fifth in turn, instead of holding the chord. */
  bassBeats?: boolean;
  /** Chance a long lead note wavers with vibrato after its start. */
  vibratoChance?: number;
  /** Percussion level per section id (0 none, 1 light, 2 full) when a song has percussion. */
  percussion?: Partial<Record<string, 0 | 1 | 2>>;
  /**
   * The pad as three parts that move on their own. Chances: a voice suspending into the next chord,
   * a voice entering a little late (and fresh entries coming in one by one), a passing note across a
   * third. `swell`: each voice breathes on its own (instead of padBreath). `textures`: per section id,
   * one or a list to pick from. `colour`: chances of add9, sus2, sus4 chords. `voices`: an
   * instrument per voice, low to high; `pizzicato`: the instrument for plucked sections.
   */
  pad?: {
    suspensions?: number;
    stagger?: number;
    passing?: number;
    swell?: boolean;
    textures?: Partial<Record<string, PadTexture | PadTexture[]>>;
    colour?: { add9?: number; sus2?: number; sus4?: number };
    voices?: [string, string, string];
    pizzicato?: string;
  };
  /** Volume of each part, 1 by default. */
  mix?: Partial<Record<"lead" | "pluck" | "pad" | "bass" | "drums" | "sparkle" | "wail" | "wind" | "claps", number>>;
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
  pad: {
    suspensions: 0.35,
    stagger: 0.25,
    passing: 0.2,
    swell: true,
    textures: { I1: "open", O2: "open", B: ["sustain", "sustain", "pizzicato"] },
    colour: { sus4: 0.12, sus2: 0.08 },
    voices: ["stringsLow", "strings", "stringsHigh"],
  },
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
  pad: {
    suspensions: 0.3,
    stagger: 0.35,
    passing: 0.15,
    swell: true,
    textures: { I1: "open" },
    colour: { add9: 0.25, sus2: 0.15 },
  },
  mix: { lead: 0.85, pluck: 0.8, pad: 1.15, bass: 0.8, drums: 0.6 },
};

const DESERT_FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [2, 2, 4, 8],
    [4, 2, 2, 4, 4],
    [6, 2, 2, 2, 4],
    [2, 2, 2, 2, 8],
    [8, 2, 2, 4],
    [-4, 2, 2, 8],
    [4, 4, 8],
  ],
  calmRhythms: [[12, 4], [8, 8], [16], [-4, 4, 8]],
  // Phrases end on a long note, often reached by a quick run down into it.
  cadenceRhythms: [[2, 2, 12], [4, 12], [16], [2, 2, 2, 2, 8]],
  plucks: [
    // Oud ostinatos: the root and octave driven by sixteenth pickups.
    [[0, 0], [3, 0], [4, 2], [6, 0], [8, 3], [10, 2], [12, 0], [14, 1]],
    [[0, 0], [2, 3], [4, 2], [6, 3], [8, 0], [11, 0], [12, 2], [14, 1]],
    [[0, 0], [6, 0], [8, 2], [12, 3], [14, 2]],
    [[0, 0], [4, 0], [6, 1], [8, 2], [12, 0]],
  ],
  // Darbuka rhythms in sixteenths: maqsum, baladi, saidi, and a busy maqsum.
  frameDrum: [
    [[0, "dum"], [2, "tek"], [6, "tek"], [8, "dum"], [12, "tek"]],
    [[0, "dum"], [2, "dum"], [6, "tek"], [8, "dum"], [12, "tek"]],
    [[0, "dum"], [2, "tek"], [6, "dum"], [8, "dum"], [12, "tek"]],
    [[0, "dum"], [2, "tek"], [4, "tek"], [6, "tek"], [8, "dum"], [10, "tek"], [12, "tek"], [14, "tek"]],
  ],
  // Riq: offbeat jingles, or a jingle and a slap.
  tambourine: [
    [[2, "shake"], [6, "shake"], [10, "shake"], [14, "shake"]],
    [[4, "shake"], [12, "hit"]],
  ],
};

/**
 * The desert: Arabic maqam colours, after Aladdin, Dune and Diablo II's second act. Hijaz and the
 * double harmonic over a drone, an oud ostinato, a ney that slides into its notes and
 * wavers, darbuka and riq on maqsum and baladi, deep drums, and now and then a voice wailing in
 * the distance.
 */
export const DESERT: Style = {
  id: "desert",
  name: "Desert - Arabic, maqam and drums",
  modes: [
    ["hijaz", 5],
    ["doubleHarmonic", 2],
    ["phrygian", 2],
    ["harmonicMinor", 1],
  ],
  tonics: [0, 2, 4, 5, 7, 9],
  bpm: [74, 100],
  meters: [[DESERT_FOUR, 1]],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  // Mostly the tonic; bII is the colour chord, iv and bvii the shade.
  chordWeights: { 0: 5, 1: 3, 3: 1.5, 5: 1, 6: 1.5 },
  cadences: {
    half: [[1, 3], [6, 1.5], [3, 1]],
    leading: [[1, 3], [6, 1.5], [3, 1]],
    contrast: [[3, 1.5], [5, 1.5], [6, 1]],
    back: [[1, 2], [6, 1]],
  },
  forms: [
    [["I1", "I2", "A", "A'", "B", "B'", "Ar", "Ar'", "O1", "O2"], 2],
    [["I1", "A", "A'", "B", "B'", "Ar'", "O1", "O2"], 1],
  ],
  percussionChance: 0.85,
  droneChance: 0.9,
  pluckFirstChance: 0.5,
  instruments: { lead: "ney", pluck: "oud", pad: "strings", bass: "bass", frameDrum: "darbuka", tambourine: "tambourine", lowDrum: "lowDrum", wail: "choir" },
  slideChance: 0.3,
  vibratoChance: 0.5,
  percussion: { I2: 1, A: 2, "A'": 2, B: 2, "B'": 2, Ar: 2, "Ar'": 2, O1: 1 },
  wail: { name: "Wail", chance: 0.35 },
  pad: {
    suspensions: 0.2,
    stagger: 0.2,
    swell: true,
    textures: { I1: "open", I2: "open", B: "tremolo", "B'": ["sustain", "tremolo"] },
    voices: ["stringsLow", "strings", "stringsHigh"],
  },
  mix: { lead: 0.9, pad: 0.65, bass: 0.9, drums: 1, wail: 0.8 },
};

const SNOW_FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [8, 8],
    [12, 4],
    [4, 4, 8],
    [6, 2, 8],
    [8, 4, 4],
    [-4, 4, 8],
  ],
  calmRhythms: [[16], [-8, 8], [12, 4]],
  cadenceRhythms: [[16], [8, 8], [4, 12]],
  plucks: [
    // Harp: slow broken chords, open as snowfall.
    [[0, 0], [4, 2], [8, 3], [12, 4]],
    [[0, 0], [2, 1], [4, 2], [6, 3], [8, 4]],
    [[0, 0], [8, 2]],
    [[0, 0], [6, 2], [8, 3], [14, 4]],
  ],
  frameDrum: [[]],
  tambourine: [[]],
};

const SNOW_THREE: MeterRules = {
  beats: 3,
  rhythms: [
    [12],
    [8, 4],
    [4, 8],
    [6, 2, 4],
    [-4, 8],
  ],
  calmRhythms: [[12], [-4, 8]],
  cadenceRhythms: [[12], [4, 8]],
  plucks: [
    [[0, 0], [4, 2], [8, 3]],
    [[0, 0], [2, 1], [4, 2], [6, 3]],
    [[0, 0], [6, 4]],
  ],
  frameDrum: [[]],
  tambourine: [[]],
};

/**
 * Snowfields: slow symphonic ambient. A horn sings over a wide string pad and a contrabass, harp
 * arpeggios fall like snow, a glockenspiel glints, a distant choir rises. The form travels: a third
 * theme, a development carried down a chain of chords, a breath, then the theme as a climax in a
 * new key with the choir doubling it and the timpani rolling in.
 */
export const SNOW: Style = {
  id: "snow",
  name: "Snow - slow symphonic ambient",
  modes: [
    ["aeolian", 3],
    ["dorian", 2],
    ["lydian", 1.5],
    ["ionian", 1],
  ],
  tonics: [0, 2, 4, 5, 7, 9],
  bpm: [48, 62],
  meters: [
    [SNOW_FOUR, 3],
    [SNOW_THREE, 1],
  ],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  chordWeights: { 0: 3, 2: 1.6, 3: 2, 4: 1, 5: 2.6, 6: 2 },
  forms: [
    [["I1", "I2", "A", "A'", "B", "B'", "C", "D", "Ar+", "Ar'+", "Br", "O1", "O2"], 3],
    [["I1", "I2", "A", "A'", "C", "B", "B'", "Br", "D", "Ar'+", "O1", "O2"], 2],
    [["I1", "A", "A'", "B", "B'", "D", "Ar+", "Ar'+", "O1", "O2"], 1],
  ],
  percussionChance: 0.7,
  droneChance: 0.45,
  pluckFirstChance: 0.25,
  instruments: { lead: "horn", pluck: "harp", pad: "strings", bass: "bass", frameDrum: "", tambourine: "", lowDrum: "timpani", sparkle: "bells", wail: "choir", wind: "wind" },
  wind: { pitch: 76, level: 0.3, drift: 7, chance: 0.07, bars: [3, 6] },
  leadRestChance: 0.2,
  vibratoChance: 0.25,
  padBreath: 0.15,
  pluckShift: 12,
  leadShift: -12,
  sparkle: { name: "Snowflakes", chance: 0.22, notes: [3, 5], steps: [2, 3] },
  wail: { name: "Choir", chance: 0.3, slide: [1, 2] },
  climaxShift: [2, 2, 3, 5],
  pad: {
    suspensions: 0.45,
    stagger: 0.35,
    passing: 0.25,
    swell: true,
    textures: { I1: "open", Br: "open", D: "tremolo", "Ar+": "wide", "Ar'+": "wide", B: ["sustain", "pizzicato"] },
    colour: { add9: 0.25, sus2: 0.12, sus4: 0.08 },
    voices: ["stringsLow", "strings", "stringsHigh"],
  },
  drumRoll: 0.6,
  percussion: { "B'": 2, D: 1, "Ar+": 2, "Ar'+": 2 },
  mix: { lead: 0.85, pluck: 0.6, pad: 1.2, bass: 1, drums: 0.8, sparkle: 0.55, wail: 0.7 },
};

const SWAMP_THREE: MeterRules = {
  beats: 3,
  rhythms: [
    [8, 4],
    [4, 8],
    [6, 2, 4],
    [12],
    [-4, 4, 4],
    [4, 4, 4],
  ],
  calmRhythms: [[12], [-6, 6], [-4, 8]],
  cadenceRhythms: [[12], [4, 8], [2, 2, 8]],
  plucks: [
    // Music box: a broken waltz, never quite filling the bar.
    [[0, 0], [4, 2], [8, 4]],
    [[0, 4], [2, 3], [4, 2], [6, 1]],
    [[0, 0], [6, 3]],
    [[4, 2], [8, 3]],
  ],
  // Knocks in the dark: a log, a block, somewhere off the beat.
  frameDrum: [[[0, "dum"]], [[0, "dum"], [8, "tek"]], [[4, "tek"], [6, "tek"]]],
  tambourine: [[]],
};

const SWAMP_FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [8, 8],
    [6, 2, 8],
    [4, 4, 8],
    [-4, 12],
    [12, 4],
  ],
  calmRhythms: [[16], [-8, 8]],
  cadenceRhythms: [[16], [4, 12]],
  plucks: [
    [[0, 0], [6, 2], [8, 4], [14, 3]],
    [[0, 4], [2, 3], [4, 2], [6, 1], [12, 0]],
    [[0, 0], [10, 3]],
  ],
  frameDrum: [[[0, "dum"], [10, "tek"]], [[0, "dum"], [6, "tek"], [7, "tek"]], [[12, "tek"]]],
  tambourine: [[]],
};

/**
 * The swamp: dark and spooky. A bass clarinet creeping in Phrygian and harmonic minor, a music box
 * a little out of tune playing a broken waltz, a humming choir over low strings that tremble, a
 * heartbeat drum, knocks off the beat, water dripping, and a ghost - a theremin of a voice -
 * sliding up out of the murk. Its climax only creeps a semitone higher.
 */
export const SWAMP: Style = {
  id: "swamp",
  name: "Swamp - dark and spooky",
  modes: [
    ["phrygian", 3],
    ["harmonicMinor", 3],
    ["aeolian", 2],
    ["dorian", 1],
  ],
  tonics: [0, 2, 4, 5, 7, 9],
  bpm: [52, 70],
  meters: [
    [SWAMP_THREE, 2],
    [SWAMP_FOUR, 1],
  ],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  chordWeights: { 0: 4, 1: 1.5, 3: 2, 4: 1.5, 5: 2, 6: 1 },
  cadences: {
    half: [[4, 2], [1, 1.5], [5, 1]],
    leading: [[1, 1.5], [4, 2], [5, 1]],
    contrast: [[5, 1.5], [3, 1.5], [1, 1]],
    back: [[4, 2], [1, 1]],
  },
  forms: [
    [["I1", "I2", "A", "A'", "B", "B'", "Br", "D", "Ar'+", "O1", "O2"], 2],
    [["I1", "A", "A'", "C", "B", "B'", "D", "Ar", "O1", "O2"], 1],
  ],
  percussionChance: 0.7,
  droneChance: 0.7,
  pluckFirstChance: 0.5,
  instruments: { lead: "clarinet", pluck: "musicBox", pad: "choir", bass: "bass", frameDrum: "knock", tambourine: "", lowDrum: "lowDrum", sparkle: "drip", wail: "ghost", wind: "wind" },
  wind: { pitch: 55, level: 0.28, drift: 5, chance: 0.07, bars: [2, 5] },
  leadRestChance: 0.3,
  slideChance: 0.35,
  leadAlternate: { instrument: "violin", chance: 0.35, shift: 12 },
  glideChance: 0.35,
  sagChance: 0.45,
  windDown: true,
  vibratoChance: 0.3,
  leadShift: -12,
  pluckShift: 12,
  sparkle: { name: "Drips", chance: 0.3, notes: [1, 2], steps: [3, 5] },
  wail: { name: "Ghost", chance: 0.5, slide: [3, 5, 7], double: 12 },
  climaxShift: [1],
  drumRoll: 0.3,
  percussion: { "A'": 1, Ar: 1, B: 2, "B'": 2, D: 2, "Ar'+": 2 },
  pad: {
    suspensions: 0.4,
    stagger: 0.4,
    passing: 0.15,
    swell: true,
    textures: { I1: "open", I2: "tremolo", B: "tremolo", D: "tremolo", Br: "open", "Ar'+": "wide" },
    voices: ["stringsLow", "choir", "strings"],
  },
  mix: { lead: 0.8, pluck: 0.7, pad: 1.05, bass: 1, drums: 0.9, sparkle: 0.6, wail: 0.75 },
};

// Jigs count in eighths: a beat is a dotted quarter of three eighths, two rows each, so six rows.
const JIG: MeterRules = {
  beats: 2,
  name: "6/8",
  rhythms: [
    [2, 2, 2, 2, 2, 2],
    [4, 2, 4, 2],
    [2, 2, 2, 4, 2],
    [6, 2, 2, 2],
    [4, 2, 2, 2, 2],
    [2, 2, 2, 6],
    // Room to breathe inside the tune.
    [4, 2, -2, 2, 2],
    [2, 2, 2, -4, 2],
  ],
  calmRhythms: [[4, 2, 4, 2], [6, 4, 2], [6, 6], [4, -2, 6]],
  cadenceRhythms: [[2, 2, 2, 6], [4, 2, 6], [6, 6]],
  plucks: [
    // Guitar vamping: bass note, then the chord on the off-eighths.
    [[0, 0], [2, 1], [4, 2], [6, 3], [8, 2], [10, 1]],
    [[0, 0], [4, 2], [6, 3], [10, 2]],
    [[0, 0], [2, 2], [4, 3], [6, 1], [8, 2], [10, 3]],
  ],
  // Bodhrán: the down-stroke on the beat and the triplet drive between.
  frameDrum: [
    [[0, "dum"], [2, "tek"], [4, "tek"], [6, "dum"], [8, "tek"], [10, "tek"]],
    [[0, "dum"], [4, "tek"], [6, "dum"], [10, "tek"]],
    [[0, "dum"], [2, "tek"], [4, "tek"], [6, "dum"], [8, "tek"], [9, "tek"], [10, "tek"]],
  ],
  tambourine: [
    [[2, "shake"], [4, "shake"], [8, "shake"], [10, "shake"]],
    [[0, "shake"], [6, "hit"]],
  ],
};

const SLIP_JIG: MeterRules = {
  beats: 3,
  name: "9/8",
  rhythms: [
    [2, 2, 2, 2, 2, 2, 2, 2, 2],
    [4, 2, 4, 2, 4, 2],
    [6, 2, 2, 2, 4, 2],
    [4, 2, 2, 2, 2, 6],
  ],
  calmRhythms: [[6, 4, 2, 6], [4, 2, 6, 6]],
  cadenceRhythms: [[4, 2, 12], [2, 2, 2, 12], [6, 12]],
  plucks: [
    [[0, 0], [2, 1], [4, 2], [6, 3], [8, 2], [10, 1], [12, 0], [14, 2], [16, 3]],
    [[0, 0], [4, 2], [6, 3], [10, 2], [12, 1], [16, 2]],
  ],
  frameDrum: [
    [[0, "dum"], [2, "tek"], [4, "tek"], [6, "dum"], [8, "tek"], [10, "tek"], [12, "dum"], [14, "tek"], [16, "tek"]],
    [[0, "dum"], [4, "tek"], [6, "dum"], [10, "tek"], [12, "dum"], [16, "tek"]],
  ],
  tambourine: [[[2, "shake"], [4, "shake"], [8, "shake"], [10, "shake"], [14, "shake"], [16, "shake"]]],
};

/**
 * The tavern: an upbeat session. Jigs and slip jigs on a fiddle (now and then a whistle), an
 * accordion pumping the chords, a guitar vamping, the bass on every beat, bodhrán and tambourine
 * driving. Like a session set, the tune goes round - A A B B - ornamented the second time, and the
 * last time round it jumps up a key.
 */
export const TAVERN: Style = {
  id: "tavern",
  name: "Tavern - upbeat jigs",
  modes: [
    ["ionian", 3],
    ["mixolydian", 3],
    ["dorian", 2],
  ],
  tonics: [2, 7, 9, 4],
  bpm: [104, 126],
  meters: [
    [JIG, 3],
    [SLIP_JIG, 1],
  ],
  rowsPerBeat: 6,
  ticksPerRow: 4,
  chordWeights: { 0: 4, 1: 1, 3: 2.5, 4: 3, 5: 1.5, 6: 1 },
  forms: [
    [["I1", "A", "A'", "A", "A'", "B", "B'", "B", "B'", "Br", "Ar", "Ar'", "Ar", "Ar'", "B", "B'", "B", "B'", "Ar+", "Ar'+", "O1", "O2"], 2],
    [["I1", "A", "A'", "A", "A'", "B", "B'", "B", "B'", "Ar", "Ar'", "B", "B'", "Br", "Ar+", "Ar'+", "O1", "O2"], 2],
  ],
  percussionChance: 0.95,
  droneChance: 0.15,
  pluckFirstChance: 0.65,
  instruments: { lead: "violin", pluck: "guitar", pad: "accordion", bass: "bass", frameDrum: "frameDrum", tambourine: "tambourine", lowDrum: "lowDrum", clap: "clap" },
  leadAlternate: [
    { instrument: "flute", chance: 0.3 },
    { instrument: "guitar", chance: 0.25, shift: -12 },
  ],
  leadRestChance: 0.12,
  claps: { chance: 0.45 },
  trillChance: 0.25,
  bassBeats: true,
  climaxShift: [2, 5],
  percussion: { I1: 1, A: 1, "A'": 2, B: 2, "B'": 2, Br: 2, Ar: 2, "Ar'": 2, "Ar+": 2, "Ar'+": 2, O1: 1 },
  pad: { stagger: 0.1, swell: true },
  mix: { lead: 1, pluck: 0.8, pad: 0.75, bass: 0.9, drums: 0.9, claps: 0.8 },
};

const HOLY_FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [8, 8],
    [4, 4, 8],
    [12, 4],
    [4, 4, 4, 4],
    [8, 4, 4],
    [16],
  ],
  calmRhythms: [[16], [8, 8], [12, 4]],
  cadenceRhythms: [[16], [8, 8], [4, 12]],
  plucks: [
    [[0, 0], [4, 2], [8, 3], [12, 4]],
    [[0, 0], [8, 2]],
    [[0, 0], [2, 1], [4, 2], [6, 3], [8, 4]],
  ],
  frameDrum: [[]],
  tambourine: [[]],
};

const HOLY_THREE: MeterRules = {
  beats: 3,
  rhythms: [
    [8, 4],
    [4, 4, 4],
    [12],
    [4, 8],
  ],
  calmRhythms: [[12], [8, 4]],
  cadenceRhythms: [[12], [4, 8]],
  plucks: [
    [[0, 0], [4, 2], [8, 3]],
    [[0, 0], [6, 2]],
  ],
  frameDrum: [[]],
  tambourine: [[]],
};

/**
 * Holy places: churches and temples. A choir sings in parts: the women the melody (a horn for some
 * themes) and the alto, the men the tenor and the low voice, note for note, as a chorale; bare fifths of held voices open it and
 * breathe in it, as in organum. A harp now and then, another voice rising in, and the theme coming back in a new key
 * with everyone, the choir doubling it below. No drums. All of it in a big, wet space.
 */
export const HOLY: Style = {
  id: "holy",
  name: "Holy - choirs and strings",
  modes: [
    ["ionian", 3],
    ["mixolydian", 2],
    ["dorian", 2],
    ["lydian", 1],
  ],
  tonics: [0, 2, 5, 7, 9, 10],
  bpm: [44, 58],
  meters: [
    [HOLY_FOUR, 3],
    [HOLY_THREE, 1],
  ],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  chordWeights: { 0: 3, 1: 1.2, 3: 2.5, 4: 2.5, 5: 2, 6: 0.8 },
  forms: [
    [["I1", "I2", "A", "A'", "B", "B'", "Br", "C", "Ar+", "Ar'+", "O1", "O2"], 2],
    [["I1", "A", "A'", "B", "B'", "D", "Ar'+", "Br", "O1", "O2"], 1],
  ],
  percussionChance: 0,
  droneChance: 0.5,
  pluckFirstChance: 0.1,
  instruments: { lead: "choirHigh", pluck: "harp", pad: "choirLow", bass: "stringsLow", frameDrum: "", tambourine: "", lowDrum: "timpani", wail: "choirLow" },
  leadCenter: 64,
  leadAlternate: { instrument: "horn", chance: 0.25, shift: -12 },
  leadRestChance: 0.15,
  vibratoChance: 0.2,
  pluckShift: 12,
  wail: { name: "Voice", chance: 0.3, slide: [1, 2] },
  climaxShift: [2, 5],
  reverb: 1.6,
  pad: {
    suspensions: 0.6,
    stagger: 0.4,
    passing: 0.3,
    swell: true,
    textures: { I1: "open", I2: "open", Br: "open", A: "chorale", "A'": "chorale", B: ["chorale", "sustain"], "B'": "chorale", C: "chorale", D: "sustain", "Ar+": "chorale", "Ar'+": "chorale", O1: "chorale" },
    colour: { sus4: 0.2, add9: 0.15, sus2: 0.1 },
    // Men below, women on top: the low voice and tenor, then the alto under the women's melody.
    voices: ["choirLow", "choirLow", "choirHigh"],
  },
  mix: { lead: 0.8, pluck: 0.45, pad: 1.2, bass: 0.75, wail: 0.65 },
};

const EPIC_FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [8, 8],
    [6, 2, 8],
    [4, 4, 8],
    [12, 4],
    [8, 4, 4],
    [-4, 4, 8],
  ],
  calmRhythms: [[16], [8, 8], [12, 4]],
  cadenceRhythms: [[16], [4, 12], [8, 8]],
  plucks: [
    // Low-string ostinatos: driving eighths on a pedal, and a gallop.
    [[0, 0], [2, 0], [4, 2], [6, 0], [8, 3], [10, 0], [12, 2], [14, 0]],
    [[0, 0], [2, 2], [4, 3], [6, 2], [8, 0], [10, 2], [12, 3], [14, 2]],
    [[0, 0], [1, 0], [2, 2], [4, 0], [5, 0], [6, 3], [8, 0], [9, 0], [10, 2], [12, 0], [13, 0], [14, 3]],
    [[0, 0], [3, 0], [6, 2], [8, 0], [11, 0], [14, 3]],
  ],
  // Taiko: the big drum on the strong beats, the small one pushing toward them.
  frameDrum: [
    [[0, "dum"], [6, "tek"], [8, "dum"], [11, "tek"], [12, "tek"]],
    [[0, "dum"], [8, "dum"], [12, "tek"], [14, "tek"]],
    [[0, "dum"], [3, "tek"], [6, "dum"], [8, "dum"], [12, "tek"], [13, "tek"], [14, "tek"]],
  ],
  tambourine: [[]],
};

/**
 * The open world, as a film score would have it: low strings driving an ostinato under a wide,
 * swelling string pad, a heroic horn (the violins for some themes), big drums and timpani rolling
 * into the climaxes, a choir rising and then carrying the theme home in a new key, a glint of
 * glockenspiel, and some wind. Cinematic harmony: i VI III VII and its kin.
 */
export const EPIC: Style = {
  id: "epic",
  name: "Epic - cinematic outdoors",
  modes: [
    ["aeolian", 3],
    ["dorian", 2],
    ["ionian", 2],
    ["lydian", 1],
  ],
  tonics: [0, 2, 4, 5, 7, 9],
  bpm: [72, 92],
  meters: [[EPIC_FOUR, 1]],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  chordWeights: { 0: 3, 2: 2.2, 3: 1.6, 4: 1.2, 5: 3, 6: 2.6 },
  forms: [
    [["I1", "I2", "A", "A'", "B", "B'", "D", "Ar+", "Ar'+", "Br", "O1", "O2"], 2],
    [["I1", "A", "A'", "C", "B", "B'", "D", "Ar'+", "O1", "O2"], 1],
    [["I1", "I2", "A", "A'", "B", "B'", "Ar", "Ar'", "D", "Ar+", "Ar'+", "O1", "O2"], 1],
  ],
  percussionChance: 0.9,
  droneChance: 0.3,
  pluckFirstChance: 0.45,
  instruments: { lead: "horn", pluck: "spiccato", pad: "strings", bass: "bass", frameDrum: "taiko", tambourine: "", lowDrum: "timpani", sparkle: "bells", wail: "choir", wind: "wind" },
  leadShift: -12,
  leadAlternate: { instrument: "violin", chance: 0.3, shift: 12 },
  vibratoChance: 0.3,
  sparkle: { name: "Glints", chance: 0.12, notes: [3, 5], steps: [1, 2] },
  wail: { name: "Choir", chance: 0.3, slide: [1, 2] },
  wind: { pitch: 72, level: 0.18, drift: 6, chance: 0.05, bars: [3, 5] },
  climaxShift: [2, 3],
  drumRoll: 0.7,
  percussion: { A: 1, "A'": 1, C: 1, B: 2, "B'": 2, Ar: 1, "Ar'": 2, D: 2, "Ar+": 2, "Ar'+": 2 },
  pad: {
    suspensions: 0.4,
    stagger: 0.3,
    passing: 0.2,
    swell: true,
    textures: { I1: "open", Br: "open", D: "tremolo", "Ar+": "wide", "Ar'+": "wide" },
    colour: { add9: 0.15, sus2: 0.1, sus4: 0.1 },
    voices: ["stringsLow", "strings", "stringsHigh"],
  },
  mix: { lead: 0.95, pluck: 0.55, pad: 1.1, bass: 1, drums: 0.9, sparkle: 0.45, wail: 0.7, wind: 0.8 },
};

// Twelve eighths in four dotted beats, six rows a beat: two rows an eighth.
const JUNGLE_TWELVE: MeterRules = {
  beats: 4,
  name: "12/8",
  rhythms: [
    [4, 2, 4, 2, 4, 2, 4, 2],
    [6, 6, 6, 6],
    [4, 2, 6, 4, 2, 6],
    [2, 2, 2, 6, 4, 2, 6],
    [12, 4, 2, 6],
    [-6, 4, 2, 6, 6],
  ],
  calmRhythms: [[12, 12], [18, 6], [-12, 12]],
  cadenceRhythms: [[4, 2, 18], [6, 18], [24]],
  plucks: [
    // Marimba: interlocking figures, two against three.
    [[0, 0], [4, 2], [6, 3], [10, 2], [12, 0], [16, 2], [18, 3], [22, 1]],
    [[0, 0], [2, 2], [4, 3], [8, 2], [12, 0], [14, 2], [16, 3], [20, 4]],
    [[0, 3], [4, 2], [8, 0], [12, 3], [16, 2], [20, 0]],
  ],
  // Log drum (dum) under the twelve-eight bell on the wood block (tek), or a looser groove.
  frameDrum: [
    [[0, "dum"], [4, "tek"], [8, "tek"], [10, "tek"], [12, "dum"], [14, "tek"], [18, "tek"], [22, "tek"]],
    [[0, "dum"], [6, "tek"], [12, "dum"], [16, "dum"], [18, "tek"]],
    [[0, "dum"], [8, "dum"], [12, "tek"], [14, "dum"], [20, "tek"]],
  ],
  // Shakers on the eighths, the beat accented.
  tambourine: [
    [[0, "hit"], [2, "shake"], [4, "shake"], [6, "hit"], [8, "shake"], [10, "shake"], [12, "hit"], [14, "shake"], [16, "shake"], [18, "hit"], [20, "shake"], [22, "shake"]],
    [[2, "shake"], [4, "shake"], [8, "shake"], [10, "shake"], [14, "shake"], [16, "shake"], [20, "shake"], [22, "shake"]],
  ],
};

/**
 * The jungle: humid and teeming. Twelve-eight time, a marimba's interlocking figures and a low
 * marimba on the beat, log drum and wood block on the twelve-eight bell, shakers, a breathy bamboo
 * flute (the marimba takes some themes) and far-off flute calls, birds chirping high up, and a
 * soft choir hanging in the air like mist.
 */
export const JUNGLE: Style = {
  id: "jungle",
  name: "Jungle - marimba and drums in 12/8",
  modes: [
    ["dorian", 3],
    ["mixolydian", 2],
    ["aeolian", 2],
    ["lydian", 1],
  ],
  tonics: [0, 2, 4, 5, 7, 9],
  bpm: [84, 104],
  meters: [[JUNGLE_TWELVE, 1]],
  rowsPerBeat: 6,
  ticksPerRow: 4,
  chordWeights: { 0: 4, 2: 1.5, 3: 2.2, 4: 1.6, 5: 1.6, 6: 2 },
  forms: [
    [["I1", "I2", "A", "A'", "B", "B'", "Br", "Ar", "Ar'", "O1", "O2"], 2],
    [["I1", "A", "A'", "B", "B'", "D", "Ar'", "O1", "O2"], 1],
  ],
  percussionChance: 0.95,
  droneChance: 0.4,
  pluckFirstChance: 0.5,
  instruments: { lead: "ney", pluck: "marimba", pad: "choir", bass: "marimbaBass", frameDrum: "knock", tambourine: "shaker", lowDrum: "lowDrum", sparkle: "bird", wail: "ney" },
  leadAlternate: { instrument: "marimba", chance: 0.3 },
  slideChance: 0.2,
  trillChance: 0.15,
  bassBeats: true,
  sparkle: { name: "Birds", chance: 0.45, notes: [2, 4], steps: [1, 1, 2] },
  wail: { name: "Calls", chance: 0.3, slide: [2, 3] },
  drumRoll: 0.3,
  percussion: { I2: 1, A: 2, "A'": 2, B: 2, "B'": 2, D: 2, Ar: 2, "Ar'": 2, O1: 1 },
  pad: {
    stagger: 0.3,
    swell: true,
    textures: { I1: "open", Br: "open" },
    colour: { add9: 0.2, sus2: 0.1 },
  },
  mix: { lead: 0.9, pluck: 0.75, pad: 0.6, bass: 0.9, drums: 0.85, sparkle: 0.6, wail: 0.6 },
};

const NORDIC_FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [8, 8],
    [6, 2, 8],
    [4, 4, 8],
    [12, 4],
    [4, 4, 4, 4],
    [-4, 4, 8],
  ],
  calmRhythms: [[16], [8, 8], [12, 4]],
  cadenceRhythms: [[16], [4, 12], [8, 8]],
  plucks: [
    // Kantele: open strings ringing in slow broken chords.
    [[0, 0], [4, 2], [8, 3], [12, 2]],
    [[0, 0], [2, 2], [4, 3], [6, 4], [8, 3], [12, 2]],
    [[0, 0], [8, 3]],
  ],
  // The big frame drum: a ritual beat, a heartbeat, a march.
  frameDrum: [
    [[0, "dum"], [8, "dum"]],
    [[0, "dum"], [6, "tek"], [8, "dum"]],
    [[0, "dum"], [4, "dum"], [8, "dum"], [12, "dum"]],
  ],
  tambourine: [[]],
};

const POLSKA: MeterRules = {
  beats: 3,
  name: "3/4 polska",
  rhythms: [
    [6, 2, 4],
    [4, 4, 4],
    [2, 2, 4, 4],
    [6, 6],
    [8, 4],
  ],
  calmRhythms: [[12], [8, 4]],
  cadenceRhythms: [[12], [4, 8]],
  plucks: [
    [[0, 0], [4, 2], [8, 3]],
    [[0, 0], [2, 2], [4, 3], [8, 2]],
  ],
  // The polska leans on the first and the third beat.
  frameDrum: [[[0, "dum"], [8, "dum"]], [[0, "dum"], [6, "tek"], [8, "dum"]]],
  tambourine: [[]],
};

/**
 * The north: mountains and cold heights, a darker, older cousin of the epic. A fiddle (now and then
 * a lur-like horn) over a deep men's choir chanting on drones of bare fifths, a big frame drum
 * beating out a ritual, a kantele ringing, high kulning calls sliding down the valley, wind, and
 * now and then a polska in three.
 */
export const NORDIC: Style = {
  id: "nordic",
  name: "Nordic - fiddle, chant and drum",
  modes: [
    ["aeolian", 3],
    ["dorian", 3],
    ["mixolydian", 1],
  ],
  tonics: [0, 2, 4, 5, 7, 9],
  bpm: [60, 80],
  meters: [
    [NORDIC_FOUR, 3],
    [POLSKA, 1],
  ],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  chordWeights: { 0: 4, 2: 1.8, 3: 2, 4: 1, 5: 2.4, 6: 2.6 },
  forms: [
    [["I1", "I2", "A", "A'", "B", "B'", "Br", "D", "Ar+", "Ar'+", "O1", "O2"], 2],
    [["I1", "A", "A'", "B", "B'", "Ar", "Ar'", "Br", "O1", "O2"], 1],
  ],
  percussionChance: 0.85,
  droneChance: 0.85,
  pluckFirstChance: 0.35,
  instruments: { lead: "violin", pluck: "harp", pad: "choirLow", bass: "stringsLow", frameDrum: "taiko", tambourine: "", lowDrum: "timpani", wail: "choir", wind: "wind" },
  leadAlternate: { instrument: "horn", chance: 0.25, shift: -12 },
  slideChance: 0.15,
  trillChance: 0.15,
  wail: { name: "Kulning", chance: 0.35, slide: [5, 7] },
  wind: { pitch: 70, level: 0.24, drift: 7, chance: 0.08, bars: [3, 6] },
  climaxShift: [2],
  drumRoll: 0.5,
  percussion: { I2: 1, A: 1, "A'": 2, B: 2, "B'": 2, D: 2, Ar: 2, "Ar'": 2, "Ar+": 2, "Ar'+": 2 },
  pad: {
    suspensions: 0.3,
    stagger: 0.4,
    swell: true,
    textures: { I1: "open", I2: "open", A: ["open", "sustain"], Br: "open", D: "tremolo", "Ar+": "wide", "Ar'+": "wide" },
    voices: ["stringsLow", "choirLow", "choirLow"],
  },
  mix: { lead: 0.9, pluck: 0.55, pad: 1.1, bass: 1, drums: 0.9, wail: 0.6, wind: 0.85 },
};

const SAVANNA_FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [4, 4, 8],
    [2, 2, 4, 8],
    [6, 2, 4, 4],
    [4, 2, 2, 4, 4],
    [8, 4, 4],
    [-4, 4, 4, 4],
  ],
  calmRhythms: [[8, 8], [12, 4], [-4, 12]],
  cadenceRhythms: [[4, 12], [16], [2, 2, 12]],
  plucks: [
    // Balafon: the tresillo, three and three and two, and a busier weave.
    [[0, 0], [3, 2], [6, 3], [8, 0], [11, 2], [14, 4]],
    [[0, 0], [2, 2], [4, 0], [6, 3], [8, 0], [10, 2], [12, 4], [14, 3]],
    [[0, 3], [3, 2], [6, 0], [10, 2], [12, 3]],
  ],
  // Djembe: the bass in the middle of the skin, tones and slaps at the rim.
  frameDrum: [
    [[0, "dum"], [3, "tek"], [6, "tek"], [8, "dum"], [10, "tek"], [12, "tek"], [14, "tek"]],
    [[0, "dum"], [4, "tek"], [6, "dum"], [8, "dum"], [12, "tek"], [14, "tek"]],
    [[0, "dum"], [2, "tek"], [3, "tek"], [8, "dum"], [11, "tek"], [12, "tek"]],
  ],
  // Shekere: the gourd and its net of beads on the off-beats.
  tambourine: [
    [[2, "shake"], [4, "hit"], [6, "shake"], [10, "shake"], [12, "hit"], [14, "shake"]],
    [[0, "hit"], [2, "shake"], [4, "shake"], [6, "shake"], [8, "hit"], [10, "shake"], [12, "shake"], [14, "shake"]],
  ],
};

/**
 * The savanna: call and response under a wide sky. A lead voice sings each theme and the group
 * answers it; a balafon on the tresillo, a bass marimba on every beat, djembe and shekere, a
 * kalimba taking some themes, birds, and a warm wind.
 */
export const SAVANNA: Style = {
  id: "savanna",
  name: "Savanna - call and response",
  modes: [
    ["mixolydian", 3],
    ["dorian", 2],
    ["ionian", 2],
  ],
  tonics: [0, 2, 4, 5, 7, 9],
  bpm: [96, 116],
  meters: [[SAVANNA_FOUR, 1]],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  chordWeights: { 0: 5, 3: 3, 4: 2.5, 6: 1.5, 1: 1 },
  forms: [
    [["I1", "I2", "A", "A'", "A", "A'", "B", "B'", "B", "B'", "Br", "Ar", "Ar'", "O1", "O2"], 2],
    [["I1", "A", "A'", "B", "B'", "A", "A'", "Br", "Ar+", "Ar'+", "O1", "O2"], 1],
  ],
  percussionChance: 0.95,
  droneChance: 0.3,
  pluckFirstChance: 0.4,
  instruments: { lead: "choirLow", pluck: "marimba", pad: "choir", bass: "marimbaBass", frameDrum: "darbuka", tambourine: "shaker", lowDrum: "lowDrum", sparkle: "bird", wind: "wind" },
  leadCenter: 57,
  answer: { instrument: "choir" },
  leadAlternate: { instrument: "musicBox", chance: 0.3, shift: 12 },
  slideChance: 0.15,
  bassBeats: true,
  sparkle: { name: "Birds", chance: 0.2, notes: [2, 3], steps: [1, 2] },
  wind: { pitch: 62, level: 0.2, drift: 5, chance: 0.05, bars: [3, 5] },
  climaxShift: [2],
  drumRoll: 0.3,
  percussion: { I2: 1, A: 2, "A'": 2, B: 2, "B'": 2, Br: 2, Ar: 2, "Ar'": 2, "Ar+": 2, "Ar'+": 2, O1: 1 },
  pad: {
    stagger: 0.3,
    swell: true,
    textures: { I1: "open", Br: "open" },
  },
  mix: { lead: 0.95, pluck: 0.75, pad: 0.55, bass: 0.9, drums: 0.9, sparkle: 0.5, wind: 0.7 },
};

const MED_WALTZ: MeterRules = {
  beats: 3,
  rhythms: [
    [4, 2, 2, 4],
    [6, 2, 4],
    [4, 4, 4],
    [2, 2, 2, 2, 4],
    [8, 4],
    [-4, 4, 4],
  ],
  calmRhythms: [[12], [8, 4], [6, 6]],
  cadenceRhythms: [[12], [4, 8], [2, 2, 8]],
  plucks: [
    // Nylon guitar: the bass, then the chord on two and three.
    [[0, 0], [4, 2], [6, 3], [8, 2], [10, 3]],
    [[0, 0], [2, 2], [4, 3], [6, 1], [8, 2], [10, 3]],
    [[0, 0], [4, 1], [8, 2]],
  ],
  // Castanets: clicks on the beats, a roll (tek) into the next bar.
  frameDrum: [
    [[0, "dum"], [4, "dum"], [8, "dum"]],
    [[0, "dum"], [4, "dum"], [6, "dum"], [8, "tek"]],
    [[0, "dum"], [8, "tek"]],
  ],
  tambourine: [[[4, "shake"], [8, "shake"]], [[0, "hit"], [6, "shake"]]],
};

const MED_FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [4, 2, 2, 8],
    [6, 2, 4, 4],
    [4, 4, 4, 4],
    [3, 3, 2, 8],
    [8, 4, 4],
    [-4, 4, 4, 4],
  ],
  calmRhythms: [[16], [8, 8], [12, 4]],
  cadenceRhythms: [[16], [4, 12], [2, 2, 12]],
  plucks: [
    // A light rumba strum: three and three and two.
    [[0, 0], [3, 2], [6, 3], [8, 0], [11, 2], [14, 3]],
    [[0, 0], [2, 2], [4, 3], [6, 2], [8, 1], [10, 2], [12, 3], [14, 2]],
  ],
  frameDrum: [
    [[0, "dum"], [3, "dum"], [6, "dum"], [8, "dum"], [12, "tek"]],
    [[0, "dum"], [4, "dum"], [8, "dum"], [12, "dum"], [14, "tek"]],
  ],
  tambourine: [[[4, "shake"], [12, "shake"]], [[2, "shake"], [6, "shake"], [10, "shake"], [14, "shake"]]],
};

/**
 * Scrubland by the sea: warm and sunny, with a Spanish or Greek turn now and then. A mandolin sings
 * (an accordion or a clarinet takes some themes), a nylon guitar strums a waltz
 * or a light rumba, the accordion holds the chords softly, castanets and a tambourine click along,
 * and the minor keys walk the Andalusian way down, i VII VI V.
 */
export const MEDITERRANEAN: Style = {
  id: "mediterranean",
  name: "Mediterranean - mandolin and guitar in the sun",
  modes: [
    ["ionian", 2],
    ["mixolydian", 2],
    ["harmonicMinor", 2],
    ["aeolian", 1],
    ["hijaz", 1],
  ],
  tonics: [0, 2, 4, 5, 7, 9],
  bpm: [92, 120],
  meters: [
    [MED_WALTZ, 2],
    [MED_FOUR, 1],
  ],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  chordWeights: { 0: 4, 1: 1, 3: 2, 4: 2.5, 5: 2, 6: 2.2 },
  cadences: {
    half: [[4, 3], [6, 1], [3, 1]],
    leading: [[4, 3], [6, 1.5], [3, 1]],
    contrast: [[5, 1.5], [3, 1.5], [6, 1]],
    back: [[4, 2], [6, 1]],
  },
  forms: [
    [["I1", "A", "A'", "B", "B'", "A", "A'", "B", "B'", "Ar", "Ar'", "O1", "O2"], 2],
    [["I1", "I2", "A", "A'", "B", "B'", "Br", "A", "A'", "B", "B'", "Ar", "Ar'+", "O1", "O2"], 1],
  ],
  percussionChance: 0.8,
  droneChance: 0.1,
  pluckFirstChance: 0.7,
  instruments: { lead: "mandolin", pluck: "guitar", pad: "accordion", bass: "bass", frameDrum: "castanets", tambourine: "tambourine", lowDrum: "lowDrum" },
  leadAlternate: [
    { instrument: "accordion", chance: 0.2 },
    { instrument: "clarinet", chance: 0.15, shift: -12 },
  ],
  slideChance: 0.1,
  bassBeats: true,
  climaxShift: [2],
  percussion: { A: 1, "A'": 2, B: 2, "B'": 2, Br: 2, Ar: 2, "Ar'": 2, "Ar'+": 2, O1: 1 },
  pad: { stagger: 0.2, swell: true, textures: { I1: "open", Br: "open" }, colour: { sus4: 0.1 } },
  mix: { lead: 0.9, pluck: 0.9, pad: 0.5, bass: 0.85, drums: 0.8 },
};

const AIR_THREE: MeterRules = {
  beats: 3,
  rhythms: [
    [6, 2, 4],
    [8, 4],
    [4, 4, 4],
    [12],
    [4, 2, 2, 4],
    [-4, 8],
  ],
  calmRhythms: [[12], [8, 4], [-4, 8]],
  cadenceRhythms: [[12], [4, 8], [2, 2, 8]],
  plucks: [
    // Celtic harp: slow broken chords, rising.
    [[0, 0], [4, 2], [8, 3]],
    [[0, 0], [2, 1], [4, 2], [6, 3], [8, 4]],
    [[0, 0], [8, 2]],
  ],
  frameDrum: [[[0, "dum"], [8, "tek"]], [[0, "dum"], [4, "tek"], [8, "tek"]]],
  tambourine: [[]],
};

const AIR_FOUR: MeterRules = {
  beats: 4,
  rhythms: [
    [8, 8],
    [6, 2, 8],
    [4, 4, 8],
    [12, 4],
    [-4, 4, 8],
  ],
  calmRhythms: [[16], [8, 8], [-8, 8]],
  cadenceRhythms: [[16], [4, 12], [8, 8]],
  plucks: [
    [[0, 0], [4, 2], [8, 3], [12, 2]],
    [[0, 0], [8, 3]],
  ],
  frameDrum: [[[0, "dum"], [8, "dum"], [12, "tek"]], [[0, "dum"], [6, "tek"], [8, "dum"]]],
  tambourine: [[]],
};

/**
 * The highlands: a lonely air on an open moor. A whistle (a fiddle for some themes) with cuts,
 * slides and the odd trill, over bagpipe drones on bare fifths and a drone bass, a Celtic harp,
 * a bodhran only when it fills out, long silences in the tune, and the wind across the heather.
 */
export const HIGHLANDS: Style = {
  id: "highlands",
  name: "Highlands - a lonely air over drones",
  modes: [
    ["mixolydian", 3],
    ["dorian", 2],
    ["ionian", 1],
    ["aeolian", 1],
  ],
  tonics: [0, 2, 7, 9],
  bpm: [54, 70],
  meters: [
    [AIR_THREE, 2],
    [AIR_FOUR, 1],
  ],
  rowsPerBeat: 4,
  ticksPerRow: 6,
  chordWeights: { 0: 4, 3: 2, 4: 1.5, 5: 1.5, 6: 2.2 },
  forms: [
    [["I1", "I2", "A", "A'", "B", "B'", "Br", "Ar", "Ar'", "O1", "O2"], 2],
    [["I1", "A", "A'", "B", "B'", "Ar'", "O1", "O2"], 1],
  ],
  percussionChance: 0.4,
  droneChance: 1,
  pluckFirstChance: 0.3,
  instruments: { lead: "flute", pluck: "harp", pad: "pipes", bass: "pipes", frameDrum: "frameDrum", tambourine: "", lowDrum: "lowDrum", wind: "wind" },
  leadAlternate: { instrument: "violin", chance: 0.35 },
  leadRestChance: 0.2,
  slideChance: 0.25,
  trillChance: 0.2,
  vibratoChance: 0.15,
  wind: { pitch: 64, level: 0.25, drift: 6, chance: 0.07, bars: [3, 6] },
  percussion: { B: 1, "B'": 2, "Ar'": 1 },
  pad: {
    stagger: 0.3,
    swell: true,
    textures: { I1: "open", I2: "open", A: "open", "A'": "open", B: "sustain", "B'": "sustain", Br: "open", Ar: "open", "Ar'": "open", O1: "open", O2: "open" },
    voices: ["stringsLow", "pipes", "pipes"],
  },
  mix: { lead: 0.9, pluck: 0.6, pad: 0.75, bass: 0.6, drums: 0.7, wind: 0.85 },
};

export const STYLES: Style[] = [FOREST, GLADE, DESERT, SNOW, SWAMP, TAVERN, HOLY, EPIC, JUNGLE, NORDIC, SAVANNA, MEDITERRANEAN, HIGHLANDS];
