// Particle effects on props (see PROP_EFFECTS.md): the flames a prop's generator laid as mount points
// (`BuildingModel.effects`) get the looping effects its pack file names - but only the nearest few,
// only while their house is shown. Everything else keeps the geometry flame it already has.
//
// Pure of Babylon: it drives the particle system, so a probe can run it in Node.

import type { ModelEffect } from "../buildings/buildingTypes";
import type { ParticleSystem, EffectHandle, Vec3 } from "../../particles/system";

/** How far from the camera flames run (metres): the player's setting, and the most that run at once. */
export const FLAME_DISTANCE = { min: 10, max: 80, default: 45 };
const FLAME_CAP = 64;
/** A large fire is heard from this far, from at most this many places, each at least this far from the next. */
const SOUND_DISTANCE = 14;
const SOUND_VOICES = 3;
const SOUND_SPACING = 4;

/** What plays a flame's sound: `play` places a looping sound; null if it cannot (audio not started). */
export interface FlameSounds {
  play: (sound: string, at: Vec3) => { stop: (fade?: number) => void } | null;
}

/** One flame in the world: where it is, and the handles of the effects running on it now. */
interface Flame {
  at: Vec3;
  effect: string;
  extra: string[];
  size: number;
  sound: string | null;
  voice: { stop: (fade?: number) => void } | null;
  handles: EffectHandle[] | null;
  group: Group;
}

interface Group {
  /** Where its flames are gathered: the middle and how far they reach, for skipping it whole. */
  x: number;
  z: number;
  reach: number;
  flames: Flame[];
  /** Whether it is drawn near now (a house's near mesh shown); a group with no test is always on. */
  shown: (() => boolean) | null;
}

/** A model's flames in the world's space, and whether it is drawn near (all of them stand still). */
export interface EffectGroup {
  effects: ModelEffect[];
  shown: () => boolean;
}

export interface PropEffects {
  /** Sets down a model's effects, each placed by `place` (model space to the world's); `shown`
   *  tells whether the model is drawn near. Returns a function that takes them away again. */
  add: (effects: readonly ModelEffect[], place: (x: number, y: number, z: number) => Vec3, shown?: () => boolean) => () => void;
  /** How far from the camera flames run, metres. */
  setDistance: (metres: number) => void;
  /** Starts the nearest flames and stops the rest: call every frame, before the particles' update. */
  update: (camera: Vec3, dt: number) => void;
  /** Flames running now, and how many exist. */
  stats: () => { running: number; total: number };
  clear: () => void;
}

/** How often the nearest flames are chosen again, in seconds. */
const CHOOSE_EVERY = 0.25;

export function createPropEffects(particles: ParticleSystem, known?: (effect: string) => boolean, sounds?: FlameSounds): PropEffects {
  const groups = new Set<Group>();
  let distance = FLAME_DISTANCE.default;
  let sinceChosen = Infinity;
  let running = 0;
  let total = 0;
  const unknown = new Set<string>();

  const start = (flame: Flame): void => {
    const handles: EffectHandle[] = [];
    const ids = [flame.effect, ...flame.extra];
    for (const id of ids) {
      if (known && !known(id)) {
        if (!unknown.has(id)) {
          unknown.add(id);
          console.warn(`A prop's flame names the particle effect "${id}", which no pack has.`);
        }
        continue;
      }
      const handle = particles.spawn(id, () => flame.at, { size: flame.size, still: true, warm: 2.5 });
      if (handle) handles.push(handle);
    }
    flame.handles = handles;
  };
  const stop = (flame: Flame): void => {
    flame.voice?.stop(0.5);
    flame.voice = null;
    if (!flame.handles) return;
    for (const handle of flame.handles) handle.stop();
    flame.handles = null;
  };
  const stopGroup = (group: Group): void => {
    for (const flame of group.flames) stop(flame);
  };

  return {
    add(effects, place, shown) {
      const flames: Flame[] = [];
      const group: Group = { x: 0, z: 0, reach: 0, flames, shown: shown ?? null };
      for (const e of effects) {
        const at = place(...e.position);
        flames.push({ at, effect: e.effect, extra: e.extra, size: e.size, sound: e.sound ?? null, voice: null, handles: null, group });
      }
      if (flames.length === 0) return () => undefined;
      group.x = flames.reduce((s, f) => s + f.at.x, 0) / flames.length;
      group.z = flames.reduce((s, f) => s + f.at.z, 0) / flames.length;
      group.reach = Math.max(...flames.map((f) => Math.hypot(f.at.x - group.x, f.at.z - group.z)));
      groups.add(group);
      total += flames.length;
      sinceChosen = Infinity;
      return () => {
        stopGroup(group);
        if (groups.delete(group)) total -= flames.length;
      };
    },
    setDistance(metres) {
      const next = Math.min(FLAME_DISTANCE.max, Math.max(FLAME_DISTANCE.min, metres));
      if (next === distance) return;
      distance = next;
      sinceChosen = Infinity;
    },
    update(camera, dt) {
      sinceChosen += dt;
      if (sinceChosen < CHOOSE_EVERY) return;
      sinceChosen = 0;
      const candidates: { flame: Flame; d: number }[] = [];
      for (const group of groups) {
        const near = (!group.shown || group.shown()) && Math.hypot(group.x - camera.x, group.z - camera.z) - group.reach <= distance + 2;
        if (!near) {
          stopGroup(group);
          continue;
        }
        for (const flame of group.flames) {
          const d = Math.hypot(flame.at.x - camera.x, flame.at.y - camera.y, flame.at.z - camera.z);
          // A little past the distance a running one stays, so it does not flicker on and off at the edge.
          if (d <= distance + (flame.handles ? 3 : 0)) candidates.push({ flame, d });
          else stop(flame);
        }
      }
      candidates.sort((a, b) => a.d - b.d);
      running = 0;
      const heard: Flame[] = [];
      candidates.forEach(({ flame, d }, i) => {
        if (i < FLAME_CAP) {
          if (!flame.handles) start(flame);
          running++;
          // The nearest large fires, one voice to a hearth however many tongues it has.
          if (sounds && flame.sound && d <= SOUND_DISTANCE && heard.length < SOUND_VOICES && heard.every((h) => Math.hypot(h.at.x - flame.at.x, h.at.z - flame.at.z) > SOUND_SPACING)) heard.push(flame);
        } else stop(flame);
      });
      if (sounds) {
        for (const { flame } of candidates) {
          if (flame.voice && !heard.includes(flame)) {
            flame.voice.stop(0.8);
            flame.voice = null;
          }
        }
        for (const flame of heard) if (!flame.voice) flame.voice = sounds.play(flame.sound!, flame.at);
      }
    },
    stats: () => ({ running, total }),
    clear() {
      for (const group of groups) stopGroup(group);
      groups.clear();
      total = 0;
      running = 0;
    },
  };
}
