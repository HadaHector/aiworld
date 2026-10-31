import { whenAudio } from "../audio/context";
import { createSfx, type Sfx } from "../audio/sfx";
import { createCuePlayer, type CueContext } from "../feedback/cues";
import { resolveFeedback } from "../feedback/rules";
import { resolveGameRules } from "../sim/rules/gameRules";
import type { PackSource } from "../world/content/resolveContent";

/** The front end's events in the feedback event table (FRONTEND.md, *Sounds and cues*). */
export type MenuSound = "uiHover" | "uiClick" | "uiBack" | "uiError" | "uiSwatch" | "characterCreated" | "enterWorld" | "logout";

export interface MenuSounds {
  play: (event: MenuSound) => void;
  /** The Effects volume, 0..1. */
  setVolume: (volume: number) => void;
  /** Sounds playing now - for the console. */
  voices: () => number;
}

/** The menus are the player's own doing: their sounds play as the player's, never as someone else's. */
const ME = 1;
const OWN: CueContext = { source: ME, target: ME, skill: null, crit: false, periodic: false };

/**
 * The front end's sounds, through the same event table, cues and sounds as the game's feedback
 * (FEEDBACK.md) - but with no world and no scene, so sound only. The packs' rules are resolved once
 * from every pack, as the menus are the same for every world.
 */
export function createMenuSounds(sources: readonly PackSource[], volume: number, baseUrl: string = import.meta.env.BASE_URL): MenuSounds {
  const packs = [...sources];
  let sfx: Sfx | null = null;
  let level = volume;
  let rules: ReturnType<typeof resolveFeedback> | null = null;
  let game: ReturnType<typeof resolveGameRules> | null = null;
  try {
    game = resolveGameRules(packs);
    rules = resolveFeedback(packs, game);
  } catch (error) {
    console.warn("The menus' sounds could not be read:", error);
  }
  const cues = rules && game ? createCuePlayer(rules, game, { player: () => ME, target: () => 0, targetOf: () => 0, place: () => null, traits: () => ({}) }, () => sfx) : null;
  if (rules) {
    const feedback = rules;
    whenAudio((audio) => {
      sfx = createSfx(audio.ctx, audio.effects, feedback, (sound, file) => `${baseUrl}packs/${sound.file.split("/")[0]}/${file}`);
      sfx.setVolume(level);
      sfx.prewarm();
    });
  }
  return {
    play: (event) => void cues?.client(event, OWN),
    setVolume(v) {
      level = v;
      sfx?.setVolume(v);
    },
    voices: () => sfx?.voices() ?? 0,
  };
}
