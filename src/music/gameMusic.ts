// Music in the game: pieces composed for wherever the player is, one at a time with silence
// between them (see MUSIC.md). The style follows the zone's biome, or the building the player is
// inside; going into or out of such a building lets the playing piece go and soon starts its own.
// Audio starts with the first click or key press, as browsers ask (src/audio/context.ts).

import { whenAudio } from "../audio/context";
import { composeSong } from "./composer";
import { createInstruments, type Instrument } from "./instruments";
import { buildInstrument, SAMPLES, stylePicks } from "./library";
import { Player } from "./player";
import type { Song } from "./song";
import { STYLES } from "./styles";

/** Where the player is, musically: a style, and a seed for the place (outdoors its theme stays its own). */
export interface MusicPlace {
  style: string;
  place: number;
  /** Inside a building with music of its own. */
  inside: boolean;
}

export interface GameMusic {
  update: (where: MusicPlace) => void;
  /** 0..1. */
  setVolume: (volume: number) => void;
  /** What is happening, for the UI: the style playing, or the silence before the next piece. */
  status: () => string;
}

/** Silence between pieces outdoors, and inside a building, in seconds. */
const GAP_OUTSIDE: [number, number] = [25, 60];
const GAP_INSIDE: [number, number] = [4, 10];
/** A new place must hold this long before the playing piece gives way to it. */
const SETTLE = 4;

export function createGameMusic(initialVolume: number): GameMusic {
  const synths = createInstruments();
  /** What the player plays from: refilled with a style's instruments before each piece. */
  const instruments: Record<string, Instrument> = { ...synths };
  const built = new Map<string, Instrument>();
  const files = new Map<string, Promise<ArrayBuffer | undefined>>();
  const load = (path: string): Promise<ArrayBuffer | undefined> => {
    let file = files.get(path);
    if (!file) {
      file = fetch(SAMPLES + path).then((r) => (r.ok ? r.arrayBuffer() : undefined)).catch(() => undefined);
      files.set(path, file);
    }
    return file;
  };

  let player: Player | undefined;
  let volume = initialVolume;
  let where: MusicPlace | undefined;
  let playing: { style: string; inside: boolean } | undefined;
  let preparing = false;
  /** When the next piece may start (performance.now() ms), once nothing plays. */
  let nextAt = performance.now() + 3000;
  let changedSince: number | undefined;
  let visit = 1;

  // The page's audio, shared with the sound effects, comes with the first click or key press.
  whenAudio((audio) => {
    player = new Player(audio.ctx, instruments, audio.music);
    player.setVolume(volume);
    player.onEnd = () => {
      const gap = playing?.inside ? GAP_INSIDE : GAP_OUTSIDE;
      playing = undefined;
      nextAt = performance.now() + (gap[0] + Math.random() * (gap[1] - gap[0])) * 1000;
    };
  });

  /** The style's instruments for the song, put together and rendered, a little at a time. */
  const prepare = async (song: Song): Promise<void> => {
    const picks = stylePicks(song.style);
    const ids = new Set(song.patterns.flatMap((p) => p.cells.flatMap((row) => row.flatMap((cell) => (cell?.instrument ? [cell.instrument] : [])))));
    for (const id of ids) {
      const synth = synths[id];
      if (!synth) continue;
      const key = `${song.style}:${id}`;
      let inst = built.get(key);
      if (!inst) {
        inst = await buildInstrument(synth, picks, load);
        built.set(key, inst);
      }
      // Rendering a synth's zones takes a moment: one instrument per task keeps the frames coming.
      void inst.zones;
      instruments[id] = inst;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const start = async (place: MusicPlace): Promise<void> => {
    const style = STYLES.find((s) => s.id === place.style) ?? STYLES[0];
    // Outdoors a zone keeps its theme, varied visit to visit. Inside, every piece is a new tune.
    const seed = place.inside ? (Math.imul(place.place + 1, 0x9e3779b1) ^ Math.imul(visit, 0x85ebca6b)) >>> 0 : place.place;
    const song = composeSong(style, seed, visit++);
    preparing = true;
    try {
      await prepare(song);
    } finally {
      preparing = false;
    }
    if (!player || !where || where.style !== place.style) {
      nextAt = performance.now() + 1000;
      return;
    }
    playing = { style: place.style, inside: place.inside };
    player.play(song);
  };

  const update = (now: MusicPlace): void => {
    where = now;
    if (!player || player.ctx.state !== "running" || preparing) return;
    const time = performance.now();
    if (playing) {
      // Somewhere with other music: once that holds, the piece gives way - quickly at a door.
      const moved = now.style !== playing.style || now.inside !== playing.inside;
      if (!moved) {
        changedSince = undefined;
        return;
      }
      changedSince ??= time;
      const door = now.inside !== playing.inside;
      if (door || time - changedSince > SETTLE * 1000) {
        player.fadeOut(door ? 1.5 : 4);
        playing = undefined;
        changedSince = undefined;
        nextAt = time + (door ? 2500 : 6000);
      }
      return;
    }
    if (time >= nextAt) void start(now);
  };

  return {
    update,
    setVolume(v) {
      volume = v;
      player?.setVolume(v);
    },
    status() {
      if (!player || player.ctx.state !== "running") return "click to start";
      if (preparing) return "tuning up";
      if (playing) return STYLES.find((s) => s.id === playing!.style)?.name.split(" - ")[0] ?? playing.style;
      return "silence";
    },
  };
}
