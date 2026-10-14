// Notes, modes and chords for the composer. Pitches are MIDI note numbers (C4 = 60). Melody and
// harmony are worked out in scale degrees: degree 0 is the tonic, 7 the tonic an octave up, -1 the
// step below it.

export const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
} as const;

export type ModeName = keyof typeof MODES;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** "C#4" for 61. */
export function noteName(midi: number): string {
  return NAMES[mod(midi, 12)] + (Math.floor(midi / 12) - 1);
}

export function pitchClassName(pc: number): string {
  return NAMES[mod(pc, 12)];
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** Semitones from the tonic to a degree of the mode, counting octaves. */
export function degreeSemitones(mode: ModeName, degree: number): number {
  return MODES[mode][mod(degree, 7)] + 12 * Math.floor(degree / 7);
}

/** MIDI pitch of a degree, with degree 0 at `tonicMidi`. */
export function degreeToMidi(mode: ModeName, tonicMidi: number, degree: number): number {
  return tonicMidi + degreeSemitones(mode, degree);
}

export type TriadQuality = "major" | "minor" | "diminished" | "augmented";

/** The diatonic triad built on a degree. */
export function triadQuality(mode: ModeName, root: number): TriadQuality {
  const base = degreeSemitones(mode, root);
  const third = degreeSemitones(mode, root + 2) - base;
  const fifth = degreeSemitones(mode, root + 4) - base;
  if (fifth === 6) return "diminished";
  if (fifth === 8) return "augmented";
  return third === 4 ? "major" : "minor";
}

/** Roman numeral of the triad on a degree: "IV", "vi", "vii°". */
export function chordName(mode: ModeName, root: number): string {
  const quality = triadQuality(mode, root);
  const numeral = ROMAN[mod(root, 7)];
  if (quality === "major") return numeral;
  if (quality === "augmented") return numeral + "+";
  return numeral.toLowerCase() + (quality === "diminished" ? "°" : "");
}

/** The chord's tones as pitch classes of degrees (0..6): root, third, fifth. */
export function triadDegrees(root: number): number[] {
  return [mod(root, 7), mod(root + 2, 7), mod(root + 4, 7)];
}

/** The degree nearest `degree` whose pitch class is one of `tones` (degrees 0..6); ties go down. */
export function nearestTone(degree: number, tones: readonly number[]): number {
  for (let distance = 0; distance < 7; distance++) {
    if (tones.includes(mod(degree - distance, 7))) return degree - distance;
    if (tones.includes(mod(degree + distance, 7))) return degree + distance;
  }
  return degree;
}
