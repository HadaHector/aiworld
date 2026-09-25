import { mulberry32, deriveSeed } from "../rng";

/**
 * A phonetic palette, one per file in a pack's voices/ folder. Names are built from these rather than drawn from a word list, so the
 * generator can produce an unbounded number of names that still sound like they belong together -
 * and so that a new voice is a handful of sounds rather than a few hundred hand-written words.
 *
 * `codas` may be empty, and often is: an onset-nucleus-only syllable is what makes a voice sound
 * open and flowing, and a heavy coda is what makes it sound blunt.
 */
export interface Voice {
  onsets: string[];
  nuclei: string[];
  codas: string[];
  /** Endings applied to the last syllable, which is what a name is mostly recognised by. */
  finals: string[];
  /** Nouns this voice's places are called - "the X Waste", "the X Fells". */
  features: string[];
  /** Adjectives, used by the templates that take one. */
  qualities: string[];
  /** Chance a syllable takes a coda at all, 0..1. Low is open and vowel-heavy, high is clipped. */
  codaChance: number;
  /** Chance of a third syllable. Two syllables read as a name, three as a place. */
  thirdSyllableChance: number;
}

/** Name shapes, chosen per name. A world of nothing but bare words reads as a word list; a world
 *  of nothing but "the Adjective Noun" reads as a parody. Mixing them is what makes a map of 66
 *  zones look like it was named rather than generated. */
type Template = "bare" | "bareFeature" | "qualityFeature" | "featureOf" | "possessive";

const TEMPLATE_WEIGHTS: [Template, number][] = [
  ["bare", 0.34],
  ["bareFeature", 0.22],
  ["qualityFeature", 0.16],
  ["featureOf", 0.16],
  ["possessive", 0.12],
];

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

function pickTemplate(rng: () => number): Template {
  let roll = rng();
  for (const [template, weight] of TEMPLATE_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return template;
  }
  return "bare";
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

const VOWELS = "aeiouy";
/** Names much past this stop reading as names and start reading as keyboard mashing. */
const MAX_WORD_LENGTH = 12;

function isVowel(character: string): boolean {
  return VOWELS.includes(character);
}

function runLength(text: string, fromEnd: boolean): number {
  const match = fromEnd ? /[^aeiouy]+$/.exec(text) : /^[^aeiouy]+/.exec(text);
  return match ? match[0].length : 0;
}

/**
 * Whether a piece can follow what has been built so far.
 *
 * Two rules, both of which showed up as actual output before they existed: a vowel meeting a vowel
 * across the seam gives runs like "Faeeliel", and a cluster coda meeting a cluster onset gives
 * "Svysknand" and "Gluglven". Capping the consonant run at the seam rather than forbidding clusters
 * outright keeps the harder voices sounding hard.
 */
function fits(word: string, piece: string): boolean {
  if (word.length === 0 || piece.length === 0) return true;
  const last = word[word.length - 1];
  const first = piece[0];
  if (isVowel(last) && isVowel(first)) return false;
  if (!isVowel(last) && !isVowel(first) && runLength(word, true) + runLength(piece, false) > 2) return false;
  return true;
}

/** First of a few random draws that fits, else any draw - a voice with few sounds must still be
 *  able to produce a word rather than loop forever. */
function pickFitting(rng: () => number, items: readonly string[], word: string, avoid?: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = pick(rng, items);
    if (candidate !== avoid && fits(word, candidate)) return candidate;
  }
  return pick(rng, items);
}

/**
 * Builds one word from a voice's sounds.
 *
 * Beyond the seam rules in `fits`, the one thing that most gave the generator away was repeating an
 * onset - "Bribreabras" is three draws of the same sound - so a syllable never reuses the previous
 * syllable's onset.
 */
function buildWord(rng: () => number, voice: Voice, syllables: number): string {
  let word = "";
  let previousOnset: string | undefined;

  for (let i = 0; i < syllables; i++) {
    const onset = pickFitting(rng, voice.onsets, word, previousOnset);
    previousOnset = onset;
    word += onset;

    if (i === syllables - 1) {
      word += pickFitting(rng, voice.finals, word);
    } else {
      word += pickFitting(rng, voice.nuclei, word);
      if (voice.codas.length > 0 && rng() < voice.codaChance) {
        const coda = pickFitting(rng, voice.codas, word);
        if (fits(word, coda)) word += coda;
      }
    }
  }

  return word;
}

function buildName(rng: () => number, voice: Voice): string {
  const syllables = 2 + (rng() < voice.thirdSyllableChance ? 1 : 0);
  let word = buildWord(rng, voice, syllables);
  // Three syllables of a long-vowel voice can run well past readable; fall back rather than clip,
  // since a truncated word tends to lose the ending the name is recognised by.
  if (word.length > MAX_WORD_LENGTH && syllables > 2) word = buildWord(rng, voice, 2);
  return capitalise(word);
}

function assemble(rng: () => number, voice: Voice): string {
  const word = buildName(rng, voice);
  switch (pickTemplate(rng)) {
    case "bareFeature":
      return `${word} ${pick(rng, voice.features)}`;
    case "qualityFeature":
      return `The ${pick(rng, voice.qualities)} ${pick(rng, voice.features)}`;
    case "featureOf":
      return `The ${pick(rng, voice.features)} of ${word}`;
    case "possessive":
      return `${word}'s ${pick(rng, voice.features)}`;
    case "bare":
    default:
      return word;
  }
}

/**
 * Words a settlement is called after, shared by every voice rather than declared per voice.
 *
 * The zones' `features` are landscape words and belong to the voice that named the land; a
 * settlement is named by the people living in it, who all speak the same common tongue - so
 * "Sonriel Crossing" and "Kharun Crossing" sitting on the same map is the point, not a collision.
 */
const SETTLEMENT_FEATURES = [
  "Crossing", "Ford", "Hold", "Watch", "Rest", "Gate", "Market", "Landing", "Bridge", "Steps",
];

/** Bare word or word plus feature. Weighted towards bare, so the map does not read as a list of
 *  compass points; the feature-bearing ones are what make the bare ones look deliberate. */
const SETTLEMENT_FEATURE_CHANCE = 0.45;

export interface NameGenerator {
  /**
   * A name for one thing, stable for a given (voice, id) pair and unique within this generator.
   *
   * Uniqueness is enforced by re-rolling with a bumped salt rather than by appending a numeral,
   * because "Kharun Waste 2" gives the generation away immediately. With 66 zones over six voices
   * collisions are rare, so the retry almost never runs.
   */
  nameFor(voiceId: string, id: number): string;
  /**
   * A name for a settlement, drawn from the same pool of taken names as everything else - a town
   * and the zone it stands in must not share a name.
   *
   * Separate from `nameFor` because the zone templates are wrong for a place people live in: "The
   * Drowned Marsh" is a region, not a village, and "Zaazmun's Sands" names a landscape after
   * someone rather than naming a settlement at all.
   */
  settlementNameFor(voiceId: string, id: number): string;
}

const NAME_SALT = 701;

export function createNameGenerator(seed: number, voices: Record<string, Voice>): NameGenerator {
  const fallbackVoice = Object.values(voices)[0];
  const root = deriveSeed(seed, NAME_SALT);
  const cache = new Map<string, string>();
  const taken = new Set<string>();

  function generate(kind: string, voiceId: string, id: number, build: (rng: () => number, voice: Voice) => string): string {
    const key = `${kind}:${voiceId}:${id}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const voice = voices[voiceId] ?? fallbackVoice;
    let name = "";
    for (let attempt = 0; attempt < 32; attempt++) {
      const rng = mulberry32(deriveSeed(root, id * 8191 + attempt * 131 + voiceId.length + kind.length));
      name = build(rng, voice);
      if (!taken.has(name)) break;
    }

    taken.add(name);
    cache.set(key, name);
    return name;
  }

  function nameFor(voiceId: string, id: number): string {
    return generate("zone", voiceId, id, assemble);
  }

  function settlementNameFor(voiceId: string, id: number): string {
    return generate("settlement", voiceId, id, (rng, voice) => {
      const word = buildName(rng, voice);
      return rng() < SETTLEMENT_FEATURE_CHANCE ? `${word} ${pick(rng, SETTLEMENT_FEATURES)}` : word;
    });
  }

  return { nameFor, settlementNameFor };
}
