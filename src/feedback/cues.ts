// Events to cues (see FEEDBACK.md, *Cues in skills* and *The event table*): a combat event plays
// its skill's cue for the phase it belongs to, or else the first matching line of the event table;
// a cue plays its parts at the event's source or target. The page that uses it (the game, the dev
// page) says where units and their bones are, and what they hit with and are made of.

import { COMBAT_EVENT_KINDS, EVENT_FLAG, type CombatEvent } from "../sim/skills/events";
import type { GameRules } from "../sim/rules/gameRules";
import type { SkillDef } from "../sim/rules/skillRules";
import type { SoundHandle, Sfx, Vec3 } from "../audio/sfx";
import type { EffectHandle, ParticleSystem } from "../particles/system";
import { resolveRef, type CueDef, type CuePart, type EventRule, type FeedbackRules, type Phase } from "./rules";

export type Bone = CuePart["bone"];

/** What a unit's hits and deaths are made of: filled into `{weapon}`, `{armor}`, `{family}`. */
export interface UnitTraits {
  weapon?: string;
  armor?: string;
  family?: string;
}

/** What the cue player needs from the page it plays in. */
export interface CueStage {
  /** The player's own unit, and its target: whose fights are "own". 0 for none. */
  player: () => number;
  target: () => number;
  /** Whom a unit has selected, 0 for nobody or not known: a swing's event names no target. */
  targetOf: (unit: number) => number;
  /** Where a unit's bone is in the world now, or null for a unit not known. */
  place: (unit: number, bone: Bone) => Vec3 | null;
  traits: (unit: number) => UnitTraits;
}

/** One play of a cue: who and what it is about. */
export interface CueContext {
  source: number;
  target: number;
  skill: SkillDef | null;
  crit: boolean;
  periodic: boolean;
  /** A point, for `at: "point"` and for a cue with no units. */
  point?: Vec3;
  /** Placeholders the event fills beyond the units' traits: `surface`, a rarity. */
  values?: Record<string, string>;
}

/** A cue playing: its looping sounds and effects go on until it is stopped. */
export interface CueHandle {
  /** Stops it: looping sounds fade, effects stop emitting and let what is out live on. */
  stop: (fade?: number) => void;
}

export interface CuePlayer {
  /** A step's combat events. */
  events: (events: readonly CombatEvent[]) => void;
  /** A client event (FEEDBACK.md's `lootOpen`, `itemTake`...): the event table's cue for it. */
  client: (name: string, context: CueContext, match?: { rarity?: string }) => void;
  /** Plays a cue by id. */
  play: (cue: string, context: CueContext) => CueHandle | null;
}

/** Seconds within which one source's same cue plays its sound only once (a hit on five targets). */
const COALESCE = 0.05;

export function createCuePlayer(rules: FeedbackRules, game: GameRules, stage: CueStage, sfx: () => Sfx | null, particles: () => ParticleSystem | null = () => null): CuePlayer {
  const recent = new Map<string, number>();
  const now = (): number => performance.now() / 1000;

  const isOwn = (c: CueContext): boolean => {
    const me = stage.player();
    if (!me) return false;
    if (c.source === me || c.target === me) return true;
    if (c.target !== 0) return c.target === stage.target();
    // An event with no target (a swing): whoever the source is going for.
    return c.source !== 0 && (c.source === stage.target() || stage.targetOf(c.source) === me);
  };
  const whenHolds = (part: CuePart, c: CueContext, own: boolean): boolean => {
    const w = part.when;
    if (w.crit !== undefined && w.crit !== c.crit) return false;
    if (w.periodic !== undefined && w.periodic !== c.periodic) return false;
    if (w.own !== undefined && w.own !== own) return false;
    if (w.role === "dealt" && c.source !== stage.player()) return false;
    if (w.role === "taken" && c.target !== stage.player()) return false;
    return true;
  };
  const valuesOf = (c: CueContext): Record<string, string | undefined> => {
    const source = c.source ? stage.traits(c.source) : {};
    const target = c.target ? stage.traits(c.target) : {};
    const school = c.skill?.tags.find((t) => t.startsWith("school."))?.slice(7);
    return { weapon: source.weapon, armor: target.armor, family: target.family ?? source.family, school: school ?? "physical", ...c.values };
  };
  const placeOf = (part: CuePart, c: CueContext): Vec3 | null => {
    if (part.at === "point") return c.point ?? null;
    const unit = part.at === "source" ? c.source : c.target;
    return (unit ? stage.place(unit, part.bone) : null) ?? c.point ?? null;
  };

  /** What a playing cue has started, to stop it. */
  interface Playing {
    sounds: SoundHandle[];
    effects: EffectHandle[];
    stopped: boolean;
  }

  const playPart = (cue: CueDef, part: CuePart, c: CueContext, own: boolean, playing: Playing): void => {
    if (playing.stopped) return;
    const scale = typeof part.scale === "number" ? part.scale : 1;
    if (part.kind === "sound") {
      const player = sfx();
      if (!player) return;
      const id = resolveRef(part.ref, valuesOf(c), (s) => rules.sounds.has(s));
      if (!id) return;
      const key = `${cue.id}:${c.source}:${id}`;
      const t = now();
      if ((recent.get(key) ?? -1) > t - COALESCE) return;
      recent.set(key, t);
      if (recent.size > 512) for (const [k, v] of recent) if (v < t - 1) recent.delete(k);
      const handle = player.play(id, { at: placeOf(part, c), gain: scale * (own ? 1 : rules.config.others.volume), own });
      if (handle) playing.sounds.push(handle);
    } else if (part.kind === "particles") {
      const system = particles();
      if (!system) return;
      const id = resolveRef(part.ref, valuesOf(c), (e) => rules.effects.has(e));
      if (!id) return;
      // It follows the unit (or bone) it is on, every frame, for as long as it plays.
      const at = (): Vec3 | null => placeOf(part, c);
      const target = part.at === "source" ? c.target : c.source;
      const handle = system.spawn(id, at, {
        own,
        count: own ? 1 : rules.config.others.particles,
        size: scale,
        toward: target ? () => stage.place(target, "chest") : undefined,
      });
      if (handle) playing.effects.push(handle);
    }
    // flash, flinch, shake and pause come with step 5.
  };

  const play = (cueId: string, c: CueContext): CueHandle | null => {
    const cue = rules.cues.get(cueId);
    if (!cue) return null;
    const own = isOwn(c);
    const playing: Playing = { sounds: [], effects: [], stopped: false };
    for (const part of cue.parts) {
      if (!whenHolds(part, c, own)) continue;
      if (part.delay > 0) setTimeout(() => playPart(cue, part, c, own, playing), part.delay * 1000);
      else playPart(cue, part, c, own, playing);
    }
    return {
      stop(fade = 0.25) {
        playing.stopped = true;
        for (const sound of playing.sounds) if (rules.sounds.get(sound.sound)?.loop) sound.stop(fade);
        for (const effect of playing.effects) effect.stop();
      },
    };
  };

  /** The first line of the event table that matches, or undefined. "" means: play nothing. */
  const fromTable = (name: string, c: CueContext, extra: { name?: string; rarity?: string }): string | undefined => {
    const list: EventRule[] | undefined = rules.config.events.get(name);
    if (!list) return undefined;
    const me = stage.player();
    for (const rule of list) {
      if (rule.tags.length > 0 && !rule.tags.every((t) => c.skill?.tags.includes(t))) continue;
      if (rule.name && rule.name !== extra.name) continue;
      if (rule.rarity.length > 0 && !rule.rarity.includes(extra.rarity ?? "")) continue;
      if (rule.role === "dealt" && c.source !== me) continue;
      if (rule.role === "taken" && c.target !== me) continue;
      if (rule.crit !== undefined && rule.crit !== c.crit) continue;
      if (rule.periodic !== undefined && rule.periodic !== c.periodic) continue;
      return rule.cue;
    }
    return undefined;
  };

  /** The phase a combat event plays for its skill, if it has one. */
  const phaseOf = (kind: string, periodic: boolean): Phase | null => {
    switch (kind) {
      case "hit":
      case "miss":
      case "heal":
        return periodic ? "tick" : "impact";
      case "castDone":
        return "release";
      case "animation":
        return "swing";
      default:
        return null;
    }
  };

  return {
    events(events) {
      for (const event of events) {
        const kind = COMBAT_EVENT_KINDS[event.kind];
        const skill = event.skill >= 0 ? (game.skills[event.skill] ?? null) : null;
        const c: CueContext = {
          source: event.source,
          target: event.target,
          skill,
          crit: (event.flags & EVENT_FLAG.crit) !== 0,
          periodic: (event.flags & EVENT_FLAG.periodic) !== 0,
        };
        // An `effect` action names its cue.
        if (kind === "effect") {
          play(event.name, c);
          continue;
        }
        const phase = phaseOf(kind, c.periodic);
        const cues = skill ? rules.skillCues[skill.index] : undefined;
        let own: string | undefined = phase && cues ? (cues[phase] ?? (phase === "tick" ? cues.impact : undefined)) : undefined;
        if (own !== undefined) {
          if (own) play(own, c);
          if (!own || !rules.cues.get(own)?.table) continue;
        }
        own = fromTable(kind, c, { name: event.name });
        if (own) play(own, c);
      }
    },
    client(name, context, match = {}) {
      const cue = fromTable(name, context, match);
      if (cue) play(cue, context);
    },
    play,
  };
}
