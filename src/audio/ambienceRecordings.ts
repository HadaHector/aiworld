// The ambience's recordings (MUSIC.md, *Ambience*): `rules/ambience.json5` says which layer plays a
// file - a loop - instead of its synthesized voice, and which one-shots (a bird, a drip) are drawn
// from recorded takes. A layer with no file keeps its voice; adding a recording is data only. Pure:
// read here, played by ambience.ts.

import { joinPath, Reader, type ContentIssue, type RawObject } from "../world/content/contentReader";

/**
 * The looping layers, by the level `ambienceMix` gives each. Those with a synthesized voice play it
 * when they have no recording; `surf`, `forestDay`, `forestNight` and `roofRain` have none and are
 * silent without one (the sea is then the water layer's). `room` is a crypt's room tone and draught,
 * `crypt` its drone.
 */
export const AMBIENCE_LOOPS = ["wind", "rustle", "rain", "patter", "water", "surf", "forestDay", "forestNight", "roofRain", "room", "crypt"] as const;
export type AmbienceLoop = (typeof AMBIENCE_LOOPS)[number];
/** Loops with a synthesized voice to fall back to. */
export const SYNTH_LOOPS: readonly AmbienceLoop[] = ["wind", "rustle", "rain", "patter", "water", "room", "crypt"];

/** One-shots the ambience schedules itself (with synthesized voices); any other name is kept for
 *  the game to play by name (`Ambience.oneShot`), such as thunder or a mine's creak. */
export const AMBIENCE_ONE_SHOTS = ["bird", "owl", "caw", "knock", "drip"] as const;
/** The synthesized voices a recording can turn down while it plays. */
export const QUIETABLE = ["birds", "owls", "caws", "knocks"] as const;
export type Quietable = (typeof QUIETABLE)[number];

export interface LoopRecording {
  /** Pack-relative paths, the pack first ("core/ambience/wind.ogg"); one is picked per load. */
  files: string[];
  /** Its gain at the layer's full level (the mix's 1). */
  gain: number;
  /** Filters on it, Hz; 0 for none. */
  lowpass: number;
  highpass: number;
  /** Other loops whose synthesized voices it covers (rain's recording has its drops in it). */
  covers: AmbienceLoop[];
  /** Synthesized one-shots turned down (a factor on their rate) while it is heard. */
  quiets: Partial<Record<Quietable, number>>;
}

export interface OneShotRecording {
  files: string[];
  gain: number;
  /** Semitones, and a level factor, picked between per play. */
  pitch: [number, number];
  volume: [number, number];
}

export interface AmbienceRecordings {
  loops: Partial<Record<AmbienceLoop, LoopRecording>>;
  oneShots: Record<string, OneShotRecording>;
}

export const NO_RECORDINGS: AmbienceRecordings = { loops: {}, oneShots: {} };

const ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function files(reader: Reader, obj: RawObject, path: string, pack: string): string[] {
  const list = reader.stringList(obj, "files", path);
  if (list.length === 0) reader.fail(joinPath(path, "files"), "needs at least one file");
  for (const [i, f] of list.entries()) {
    if (!/\.(ogg|mp3|wav|flac|m4a|webm)$/i.test(f) || f.includes("..") || f.startsWith("/")) reader.fail(joinPath(joinPath(path, "files"), i), "expected an audio file's path inside the pack (.ogg, .mp3, .wav...)");
  }
  return list.map((f) => `${pack}/${f}`);
}

function pair(reader: Reader, obj: RawObject, key: string, path: string, fallback: [number, number]): [number, number] {
  if (obj[key] === undefined) return fallback;
  if (typeof obj[key] === "number") {
    const n = reader.number(obj, key, path);
    return [n, n];
  }
  return reader.range(obj, key, path, { allowEqual: true });
}

/** `rules/ambience.json5`, from the pack whose file won (a later pack replaces it whole). */
export function readAmbienceRecordings(data: unknown, file: string, pack: string, issues: ContentIssue[]): AmbienceRecordings {
  const reader = new Reader(issues, file);
  const obj = reader.object(data, "");
  reader.onlyKeys(obj, "", ["loops", "oneShots"]);
  const loops: AmbienceRecordings["loops"] = {};
  if (obj.loops !== undefined) {
    const raw = reader.object(obj.loops, "loops");
    for (const [id, value] of Object.entries(raw)) {
      const path = joinPath("loops", id);
      if (!(AMBIENCE_LOOPS as readonly string[]).includes(id)) {
        reader.fail(path, `unknown layer (known: ${AMBIENCE_LOOPS.join(", ")})`);
        continue;
      }
      const o = reader.object(value, path);
      reader.onlyKeys(o, path, ["files", "gain", "lowpass", "highpass", "covers", "quiets"]);
      const covers = o.covers === undefined ? [] : reader.stringList(o, "covers", path);
      for (const [i, c] of covers.entries()) if (!(AMBIENCE_LOOPS as readonly string[]).includes(c) || c === id) reader.fail(joinPath(joinPath(path, "covers"), i), `not another layer (known: ${AMBIENCE_LOOPS.join(", ")})`);
      const quiets: LoopRecording["quiets"] = {};
      if (o.quiets !== undefined) {
        const q = reader.object(o.quiets, joinPath(path, "quiets"));
        for (const key of Object.keys(q)) {
          if (!(QUIETABLE as readonly string[]).includes(key)) reader.fail(joinPath(joinPath(path, "quiets"), key), `unknown voice (known: ${QUIETABLE.join(", ")})`);
          else quiets[key as Quietable] = reader.number(q, key, joinPath(path, "quiets"), { min: 0, max: 1 });
        }
      }
      loops[id as AmbienceLoop] = {
        files: files(reader, o, path, pack),
        gain: reader.optionalNumber(o, "gain", path, 1, { min: 0, max: 8 }),
        lowpass: reader.optionalNumber(o, "lowpass", path, 0, { min: 0, max: 24000 }),
        highpass: reader.optionalNumber(o, "highpass", path, 0, { min: 0, max: 24000 }),
        covers: covers as AmbienceLoop[],
        quiets,
      };
    }
  }
  const oneShots: AmbienceRecordings["oneShots"] = {};
  if (obj.oneShots !== undefined) {
    const raw = reader.object(obj.oneShots, "oneShots");
    for (const [id, value] of Object.entries(raw)) {
      const path = joinPath("oneShots", id);
      if (!ID.test(id)) reader.fail(path, "a name is letters, digits, - and _");
      const o = reader.object(value, path);
      reader.onlyKeys(o, path, ["files", "gain", "pitch", "volume"]);
      oneShots[id] = {
        files: files(reader, o, path, pack),
        gain: reader.optionalNumber(o, "gain", path, 1, { min: 0, max: 8 }),
        pitch: pair(reader, o, "pitch", path, [-1, 1]),
        volume: pair(reader, o, "volume", path, [0.8, 1]),
      };
    }
  }
  return { loops, oneShots };
}
