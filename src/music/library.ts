// Library sounds: putting an instrument together from a style's picks (src/music/sounds.ts) - its
// own sound from a sample file, or the synth, and for a drum a file per stroke. Shared by the music
// page and the game. The picked files are kept in the repository under public/music/samples.

import { zoneFor, type Instrument, type SampleZone } from "./instruments";
import { SHARED_SOUNDS, STYLE_SOUNDS } from "./sounds";
import { parseXi } from "./xi";

/**
 * Where the picked sample files are served from: beside the page, so the site works under any path
 * (GitHub Pages serves it from /<repository>/). Outside Vite (a probe) there is no base: the root.
 */
export const SAMPLES = `${import.meta.env?.BASE_URL ?? "/"}music/samples/`;

/** Every file some style picks: the ones kept under SAMPLES. */
export const PICKED_FILES = new Set([...Object.values(SHARED_SOUNDS), ...Object.values(STYLE_SOUNDS).flatMap((picks) => Object.values(picks))].filter(Boolean));

/** A style's picks: the shared ones with its own on top. */
export function stylePicks(styleId: string): Record<string, string> {
  return { ...SHARED_SOUNDS, ...STYLE_SOUNDS[styleId] };
}

/** The pick for a drum's stroke is kept under "id:stroke". */
export const strokeKey = (id: string, stroke: string): string => `${id}:${stroke}`;

/** One drum stroke on one key: the file's sample as it sounds on C-4, never looping, faded at its end. */
function strokeZone(zone: SampleZone, note: number): SampleZone {
  let data = zone.data;
  if (zone.loop) {
    data = data.slice(0, Math.floor(zone.loop.end * zone.sampleRate));
    const fade = Math.min(data.length, Math.floor(0.02 * zone.sampleRate));
    for (let i = 0; i < fade; i++) data[data.length - fade + i] *= 1 - i / fade;
  }
  return { ...zone, data, loop: undefined, low: note, high: note, root: zone.root + note - 60 };
}

/**
 * Puts an instrument together from its picks: its own sound (a sample file, else the synth) and, for
 * a drum, a file for any stroke picked on its own, laid over that stroke's key. `load` gives a
 * file's bytes, or undefined where it cannot be had - that sound then stays the synth's.
 */
export async function buildInstrument(synth: Instrument, picks: Record<string, string>, load: (path: string) => Promise<ArrayBuffer | undefined>): Promise<Instrument> {
  const id = synth.id;
  let inst: Instrument = synth;
  const path = picks[id];
  const bytes = path ? await load(path) : undefined;
  if (bytes) {
    inst = parseXi(bytes, id, { short: synth.short, color: synth.color, gain: synth.gain });
    inst.range = synth.range;
    if (synth.keys) inst.keys = synth.keys;
  }
  if (synth.keys) {
    const zones: SampleZone[] = [];
    for (const [stroke, note] of Object.entries(synth.keys)) {
      const strokePath = picks[strokeKey(id, stroke)];
      const strokeBytes = strokePath ? await load(strokePath) : undefined;
      if (!strokeBytes) continue;
      const xi = parseXi(strokeBytes, id, { short: synth.short, color: synth.color, gain: 1 });
      zones.push(strokeZone(zoneFor(xi, 60), note));
    }
    if (zones.length) inst = { ...inst, zones: [...zones, ...inst.zones] };
  }
  return inst;
}
