// Particle effects on props (see PROP_EFFECTS.md): the flames a prop's generator laid as mount points
// (`BuildingModel.effects`) get the looping effects its pack file names - but only the nearest few,
// only while their house is shown. Everything else keeps the geometry flame it already has.
//
// Pure of Babylon: it drives the particle system, so a probe can run it in Node.

import type { ModelEffect } from "../buildings/buildingTypes";
import type { ParticleSystem, EffectHandle, Vec3 } from "../../particles/system";

export type FlameQuality = "low" | "medium" | "high";
export const FLAME_QUALITIES: readonly FlameQuality[] = ["low", "medium", "high"];

/** What a quality means: how far from the camera a flame runs, how many run at once, and whether the
 *  `extra` effects (smoke, embers) run. There is no off - the geometry flame is always there. */
export interface FlameQualitySpec {
  distance: number;
  cap: number;
  extras: boolean;
}
export const FLAME_QUALITY: Record<FlameQuality, FlameQualitySpec> = {
  low: { distance: 20, cap: 16, extras: false },
  medium: { distance: 30, cap: 32, extras: true },
  high: { distance: 45, cap: 48, extras: true },
};

/** One flame in the world: where it is, and the handles of the effects running on it now. */
interface Flame {
  at: Vec3;
  effect: string;
  extra: string[];
  size: number;
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
  setQuality: (quality: FlameQuality) => void;
  /** Starts the nearest flames and stops the rest: call every frame, before the particles' update. */
  update: (camera: Vec3, dt: number) => void;
  /** Flames running now, and how many exist. */
  stats: () => { running: number; total: number };
  clear: () => void;
}

/** How often the nearest flames are chosen again, in seconds. */
const CHOOSE_EVERY = 0.25;

export function createPropEffects(particles: ParticleSystem, known?: (effect: string) => boolean): PropEffects {
  const groups = new Set<Group>();
  let spec = FLAME_QUALITY.high;
  let sinceChosen = Infinity;
  let running = 0;
  let total = 0;
  const unknown = new Set<string>();

  const start = (flame: Flame): void => {
    const handles: EffectHandle[] = [];
    const ids = spec.extras ? [flame.effect, ...flame.extra] : [flame.effect];
    for (const id of ids) {
      if (known && !known(id)) {
        if (!unknown.has(id)) {
          unknown.add(id);
          console.warn(`A prop's flame names the particle effect "${id}", which no pack has.`);
        }
        continue;
      }
      const handle = particles.spawn(id, () => flame.at, { size: flame.size, still: true });
      if (handle) handles.push(handle);
    }
    flame.handles = handles;
  };
  const stop = (flame: Flame): void => {
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
        flames.push({ at, effect: e.effect, extra: e.extra, size: e.size, handles: null, group });
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
    setQuality(q) {
      spec = FLAME_QUALITY[q];
      // Running ones start again with what the new quality has.
      for (const group of groups) stopGroup(group);
      sinceChosen = Infinity;
    },
    update(camera, dt) {
      sinceChosen += dt;
      if (sinceChosen < CHOOSE_EVERY) return;
      sinceChosen = 0;
      const candidates: { flame: Flame; d: number }[] = [];
      for (const group of groups) {
        const near = (!group.shown || group.shown()) && Math.hypot(group.x - camera.x, group.z - camera.z) - group.reach <= spec.distance + 2;
        if (!near) {
          stopGroup(group);
          continue;
        }
        for (const flame of group.flames) {
          const d = Math.hypot(flame.at.x - camera.x, flame.at.y - camera.y, flame.at.z - camera.z);
          // A little past the distance a running one stays, so it does not flicker on and off at the edge.
          if (d <= spec.distance + (flame.handles ? 3 : 0)) candidates.push({ flame, d });
          else stop(flame);
        }
      }
      candidates.sort((a, b) => a.d - b.d);
      running = 0;
      candidates.forEach(({ flame }, i) => {
        if (i < spec.cap) {
          if (!flame.handles) start(flame);
          running++;
        } else stop(flame);
      });
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
