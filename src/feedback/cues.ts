// Events to cues (see FEEDBACK.md, *Cues in skills* and *The event table*): a combat event plays
// its skill's cue for the phase it belongs to, or else the first matching line of the event table;
// a cue plays its parts at the event's source or target. Some phases last: a cast loops at the
// caster's hands until the cast ends, a projectile flies to its target until its hit lands, an aura
// loops on its host until it goes. The page that uses it (the game, the dev page) says where units
// and their bones are, and what they hit with and are made of.

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
  /** A moving place every part plays at instead of its own: a projectile in flight. */
  travel?: () => Vec3 | null;
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
  /** Each frame: moves lasting cues' sounds with what they are on, and ends projectiles that are due. */
  update: () => void;
  /** A unit gone from view: whatever lasts on it stops. */
  forget: (unit: number) => void;
  /** Lasting cues playing now - casts, projectiles, auras - for the meters and the probe. */
  lasting: () => { casts: number; projectiles: number; auras: number };
  /** Stops every lasting cue. */
  stopAll: () => void;
}

/** Seconds within which one source's same cue plays its sound only once (a hit on five targets). */
const COALESCE = 0.05;

/** What a playing cue has started, to stop it, and to move its sounds with what they are on. */
interface Playing {
  sounds: { handle: SoundHandle; part: CuePart }[];
  effects: EffectHandle[];
  context: CueContext;
  stopped: boolean;
}
type Lasting = CueHandle & { playing: Playing };

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
    if (c.travel) return c.travel();
    if (part.at === "point") return c.point ?? null;
    const unit = part.at === "source" ? c.source : c.target;
    return (unit ? stage.place(unit, part.bone) : null) ?? c.point ?? null;
  };

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
      if (handle) playing.sounds.push({ handle, part });
    } else if (part.kind === "particles") {
      const system = particles();
      if (!system) return;
      const id = resolveRef(part.ref, valuesOf(c), (e) => rules.effects.has(e));
      if (!id) return;
      // It follows the unit (or bone, or projectile) it is on, every frame, for as long as it plays.
      const at = (): Vec3 | null => placeOf(part, c);
      const other = part.at === "source" ? c.target : c.source;
      const handle = system.spawn(id, at, {
        own,
        count: own ? 1 : rules.config.others.particles,
        size: scale,
        toward: other ? () => stage.place(other, "chest") : undefined,
      });
      if (handle) playing.effects.push(handle);
    }
    // flash, flinch, shake and pause come with step 5.
  };

  const play = (cueId: string, c: CueContext): Lasting | null => {
    const cue = rules.cues.get(cueId);
    if (!cue) return null;
    const own = isOwn(c);
    const playing: Playing = { sounds: [], effects: [], context: c, stopped: false };
    for (const part of cue.parts) {
      if (!whenHolds(part, c, own)) continue;
      if (part.delay > 0) setTimeout(() => playPart(cue, part, c, own, playing), part.delay * 1000);
      else playPart(cue, part, c, own, playing);
    }
    return {
      playing,
      stop(fade = 0.25) {
        if (playing.stopped) return;
        playing.stopped = true;
        for (const { handle } of playing.sounds) if (rules.sounds.get(handle.sound)?.loop) handle.stop(fade);
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
      if (rule.type && rule.type !== c.skill?.type) continue;
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

  /** A skill's cue for a phase - `tick` falling back to `impact` - or undefined when it names none. */
  const skillCue = (skill: SkillDef | null, phase: Phase): string | undefined => {
    const cues = skill ? rules.skillCues[skill.index] : undefined;
    if (!cues) return undefined;
    return cues[phase] ?? (phase === "tick" ? cues.impact : undefined);
  };
  /** Plays a skill's cue for a phase, then the table's for the event unless the skill's says not to. */
  const playPhase = (phase: Phase | null, kind: string, c: CueContext, name = ""): void => {
    const own = phase ? skillCue(c.skill, phase) : undefined;
    if (own !== undefined) {
      if (own) play(own, c);
      if (!own || !rules.cues.get(own)?.table) return;
    }
    const table = fromTable(kind, c, { name });
    if (table) play(table, c);
  };

  // --- lasting phases ---
  /** A cast or channel playing, by its caster. */
  const casts = new Map<number, Lasting>();
  /** Auras playing, by host, skill and caster. */
  const auras = new Map<string, Lasting>();
  /** Projectiles in flight. */
  const projectiles: { source: number; target: number; skill: number; until: number; cue: Lasting }[] = [];
  const auraKey = (host: number, skill: number, caster: number): string => `${host}:${skill}:${caster}`;
  const endCast = (caster: number): void => {
    casts.get(caster)?.stop();
    casts.delete(caster);
  };

  /** The speed a skill's projectile flies at: its committing state's travel, when that is a number. */
  const travelSpeed = (skill: SkillDef): number | null => {
    const committing = skill.states.find((s) => s.commit) ?? skill.states[skill.start];
    if (committing?.length.kind !== "travel") return null;
    return committing.length.speed.constant ?? 20;
  };
  /** A point that leaves the caster's hands and flies at `speed` to wherever its target now is. */
  const flight = (source: number, target: number, speed: number): { travel: () => Vec3 | null; seconds: number } => {
    const from = stage.place(source, "hands") ?? stage.place(source, "chest");
    const to = stage.place(target, "chest");
    const started = now();
    const seconds = from && to ? Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / speed : 0;
    let last: Vec3 | null = from;
    return {
      seconds,
      travel() {
        const goal = stage.place(target, "chest");
        if (!from || !goal) return last;
        const t = seconds > 0 ? Math.min(1, (now() - started) / seconds) : 1;
        last = { x: from.x + (goal.x - from.x) * t, y: from.y + (goal.y - from.y) * t, z: from.z + (goal.z - from.z) * t };
        return last;
      },
    };
  };
  const everyLasting = (): Lasting[] => [...casts.values(), ...auras.values(), ...projectiles.map((p) => p.cue)];

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
        switch (kind) {
          case "effect":
            // An `effect` action names its cue.
            play(event.name, c);
            break;
          case "castStart": {
            // A cast bar: its cue loops at the caster until the cast ends. Its flags say a channel.
            endCast(c.source);
            const channel = (event.flags & 1) !== 0;
            const cue = skillCue(skill, channel ? "channel" : "cast") ?? fromTable(kind, { ...c, periodic: false }, {});
            const lasting = cue ? play(cue, { ...c, periodic: false }) : null;
            if (lasting) casts.set(c.source, lasting);
            break;
          }
          case "castStopped":
            endCast(c.source);
            break;
          case "castFailed":
            endCast(c.source);
            playPhase(null, kind, c);
            break;
          case "interrupted":
            // The interrupted unit is the target.
            endCast(c.target);
            playPhase(null, kind, c);
            break;
          case "castDone": {
            endCast(c.source);
            playPhase("release", kind, c);
            // A skill that travels sends its projectile on its way.
            const cue = skillCue(skill, "projectile");
            const speed = skill ? travelSpeed(skill) : null;
            if (cue && speed && c.target) {
              const path = flight(c.source, c.target, speed);
              const lasting = play(cue, { ...c, travel: path.travel });
              if (lasting) projectiles.push({ source: c.source, target: c.target, skill: event.skill, until: now() + path.seconds + 0.3, cue: lasting });
            }
            break;
          }
          case "hit":
          case "miss":
          case "heal": {
            // A projectile's hit ends its flight.
            const i = projectiles.findIndex((p) => p.source === c.source && p.skill === event.skill && p.target === c.target);
            if (i >= 0) {
              projectiles[i].cue.stop(0.08);
              projectiles.splice(i, 1);
            }
            playPhase(c.periodic ? "tick" : "impact", kind, c);
            break;
          }
          case "auraOn": {
            // On its host (the event's target), looping until it goes; applied again, it goes on.
            const key = auraKey(c.target, event.skill, c.source);
            if (auras.has(key)) break;
            playPhase("applied", kind, c);
            const cue = skillCue(skill, "aura");
            const lasting = cue ? play(cue, c) : null;
            if (lasting) auras.set(key, lasting);
            break;
          }
          case "auraOff": {
            const key = auraKey(c.target, event.skill, c.source);
            auras.get(key)?.stop();
            auras.delete(key);
            playPhase("faded", kind, c);
            break;
          }
          case "animation":
            playPhase("swing", kind, c, event.name);
            break;
          case "death":
            endCast(c.target);
            playPhase(null, kind, c);
            break;
          default:
            playPhase(null, kind, c, event.name);
        }
      }
    },
    client(name, context, match = {}) {
      const cue = fromTable(name, context, match);
      if (cue) play(cue, context);
    },
    play,
    update() {
      const t = now();
      for (let i = projectiles.length - 1; i >= 0; i--) {
        if (projectiles[i].until > t) continue;
        projectiles[i].cue.stop(0.08);
        projectiles.splice(i, 1);
      }
      // Lasting sounds go where their parts are now.
      for (const { playing } of everyLasting()) {
        for (const { handle, part } of playing.sounds) {
          if (!handle.playing) continue;
          const at = placeOf(part, playing.context);
          if (at) handle.move(at);
        }
      }
    },
    forget(unit) {
      endCast(unit);
      for (const [key, lasting] of auras) {
        if (lasting.playing.context.target !== unit) continue;
        lasting.stop();
        auras.delete(key);
      }
      for (let i = projectiles.length - 1; i >= 0; i--) {
        if (projectiles[i].source !== unit && projectiles[i].target !== unit) continue;
        projectiles[i].cue.stop(0.08);
        projectiles.splice(i, 1);
      }
    },
    lasting: () => ({ casts: casts.size, projectiles: projectiles.length, auras: auras.size }),
    stopAll() {
      for (const lasting of everyLasting()) lasting.stop(0.05);
      casts.clear();
      auras.clear();
      projectiles.length = 0;
    },
  };
}
