// The particle system (see FEEDBACK.md, *Particles*): effects from `particles/` spawned at an
// attachment - a unit's bone, a point, something moving - and simulated on the CPU in flat typed
// arrays allocated once at the budget's size, so nothing is allocated while a fight goes on. No
// Babylon here: src/particles/render.ts draws what this holds, and the probe can run it in Node.

import type { EmitterDef, FeedbackRules, ParticleEffectDef } from "../feedback/rules";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Where an effect is: asked again every frame, so it follows what it is on. Null once that is gone. */
export type Attachment = () => Vec3 | null;

export interface SpawnOptions {
  /** Where `line` emitters reach to (a beam's target). */
  toward?: Attachment;
  /** A factor on how many particles it makes: others' fights make fewer. */
  count?: number;
  /** A factor on particle sizes (a big hit's bigger burst). */
  size?: number;
  /** The player's own fight: its particles outlast others' when the budget runs out. */
  own?: boolean;
}

export interface EffectHandle {
  readonly alive: boolean;
  /** Stops emitting; what is out lives on. A looping effect plays until this. */
  stop: () => void;
  /** Stops and takes its particles away at once. */
  kill: () => void;
}

/** What the drawers read: one pool of particles each for sprites and for meshes. */
export interface ParticlePool {
  readonly capacity: number;
  /** Particles alive: indices 0..count-1. */
  count: number;
  /** Where each is, now (local ones already moved with their attachment). */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  /** Its size (metres across) and colour now, from its emitter's curves. */
  size: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  /** Rotation in radians, and for meshes the axis it turns about. */
  rot: Float32Array;
  ax: Float32Array;
  ay: Float32Array;
  az: Float32Array;
  /** Which emitter made it (`ParticleSystem.emitters`), and which texture variant it shows. */
  emitter: Uint16Array;
  variant: Uint8Array;
}

export interface ParticleSystem {
  /** Every effect's emitters in one list: a particle's `emitter` indexes it. */
  readonly emitters: readonly EmitterDef[];
  readonly sprites: ParticlePool;
  readonly meshes: ParticlePool;
  /** Starts an effect; null when it does not exist or is past the effect distance. */
  spawn: (effect: string, at: Attachment, options?: SpawnOptions) => EffectHandle | null;
  /** Steps every effect and particle. `camera`: where it is, for the distance rule. */
  update: (dt: number, camera: Vec3 | null) => void;
  /** Effects playing now. */
  effects: () => number;
  clear: () => void;
}

/** Effects farther than this from the camera are not started. */
const EFFECT_DISTANCE = 60;

interface Instance {
  def: ParticleEffectDef;
  emitters: number[];
  at: Attachment;
  toward?: Attachment;
  count: number;
  size: number;
  own: boolean;
  time: number;
  /** Fractions of a particle owed by each emitter's rate. */
  owed: number[];
  /** How many bursts each emitter has fired. */
  fired: number[];
  stopped: boolean;
  dead: boolean;
  /** Where the attachment was last frame, for `inherit`, and where it is now. */
  last: Vec3 | null;
  now: Vec3 | null;
  vx: number;
  vy: number;
  vz: number;
}

function createPool(capacity: number): ParticlePool & { life: Float32Array; age: Float32Array; spin: Float32Array; sizeScale: Float32Array; instance: Int32Array; ox: Float32Array; oy: Float32Array; oz: Float32Array; own: Uint8Array } {
  const f = (): Float32Array => new Float32Array(capacity);
  return {
    capacity,
    count: 0,
    x: f(), y: f(), z: f(), vx: f(), vy: f(), vz: f(),
    size: f(), r: f(), g: f(), b: f(), a: f(),
    rot: f(), ax: f(), ay: f(), az: f(),
    emitter: new Uint16Array(capacity),
    variant: new Uint8Array(capacity),
    life: f(), age: f(), spin: f(), sizeScale: f(),
    // A local particle's instance (it moves with the attachment) and its place relative to it; -1 for a free one.
    instance: new Int32Array(capacity).fill(-1),
    ox: f(), oy: f(), oz: f(),
    own: new Uint8Array(capacity),
  };
}
type Pool = ReturnType<typeof createPool>;

/** A value on a curve of [life, value] points at life t, straight between them. */
export function curveAt(points: readonly [number, number][], t: number): number {
  if (points.length === 1 || t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    if (t <= t1) {
      const [t0, v0] = points[i - 1];
      return v0 + ((v1 - v0) * (t - t0)) / Math.max(1e-6, t1 - t0);
    }
  }
  return points[points.length - 1][1];
}

function colourAt(points: EmitterDef["colour"], t: number, out: [number, number, number, number]): void {
  if (points.length === 1 || t <= points[0][0]) {
    out[0] = points[0][1][0];
    out[1] = points[0][1][1];
    out[2] = points[0][1][2];
    out[3] = points[0][1][3];
    return;
  }
  for (let i = 1; i < points.length; i++) {
    const [t1, c1] = points[i];
    if (t <= t1 || i === points.length - 1) {
      const [t0, c0] = points[i - 1];
      const k = Math.min(1, Math.max(0, (t - t0) / Math.max(1e-6, t1 - t0)));
      for (let c = 0; c < 4; c++) out[c] = c0[c] + (c1[c] - c0[c]) * k;
      return;
    }
  }
}

const range = ([a, b]: [number, number]): number => a + Math.random() * (b - a);

/** A random unit vector within `spread` degrees of (dx, dy, dz), which must be unit length. */
function inCone(dx: number, dy: number, dz: number, spread: number, out: [number, number, number]): void {
  const cosMax = Math.cos((Math.min(180, spread) * Math.PI) / 180);
  const cos = 1 - Math.random() * (1 - cosMax);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  const phi = Math.random() * Math.PI * 2;
  // A frame around the axis.
  let ux = Math.abs(dy) < 0.9 ? 0 : 1;
  let uy = Math.abs(dy) < 0.9 ? 1 : 0;
  let uz = 0;
  // u = normalize(up x d), v = d x u
  let px = uy * dz - uz * dy;
  let py = uz * dx - ux * dz;
  let pz = ux * dy - uy * dx;
  const pl = Math.hypot(px, py, pz) || 1;
  px /= pl;
  py /= pl;
  pz /= pl;
  ux = dy * pz - dz * py;
  uy = dz * px - dx * pz;
  uz = dx * py - dy * px;
  out[0] = dx * cos + (px * Math.cos(phi) + ux * Math.sin(phi)) * sin;
  out[1] = dy * cos + (py * Math.cos(phi) + uy * Math.sin(phi)) * sin;
  out[2] = dz * cos + (pz * Math.cos(phi) + uz * Math.sin(phi)) * sin;
}

export function createParticleSystem(rules: FeedbackRules): ParticleSystem {
  const emitters: EmitterDef[] = [];
  const effectEmitters = new Map<string, number[]>();
  for (const [id, effect] of rules.effects) {
    effectEmitters.set(id, effect.emitters.map((e) => emitters.push(e) - 1));
  }
  const sprites = createPool(rules.config.particles.sprites);
  const meshes = createPool(rules.config.particles.meshes);
  const instances: Instance[] = [];
  let nextInstance = 0;
  const instanceIds = new Map<Instance, number>();
  const byId = new Map<number, Instance>();
  const colour: [number, number, number, number] = [0, 0, 0, 0];
  const dir: [number, number, number] = [0, 0, 0];
  let camera: Vec3 | null = null;

  const removeAt = (pool: Pool, i: number): void => {
    const last = --pool.count;
    if (i === last) return;
    // The last particle takes its place.
    for (const key of ["x", "y", "z", "vx", "vy", "vz", "size", "r", "g", "b", "a", "rot", "ax", "ay", "az", "life", "age", "spin", "sizeScale", "ox", "oy", "oz"] as const) pool[key][i] = pool[key][last];
    pool.emitter[i] = pool.emitter[last];
    pool.variant[i] = pool.variant[last];
    pool.instance[i] = pool.instance[last];
    pool.own[i] = pool.own[last];
  };

  /** A free slot, or - for the player's own fight, when the pool is full - the oldest of others' particles. */
  const slot = (pool: Pool, own: boolean): number => {
    if (pool.count < pool.capacity) return pool.count++;
    if (!own) return -1;
    let best = -1;
    let oldest = -1;
    for (let i = 0; i < pool.count; i++) {
      if (pool.own[i]) continue;
      const age = pool.age[i] / pool.life[i];
      if (age > oldest) {
        oldest = age;
        best = i;
      }
    }
    return best;
  };

  const emit = (inst: Instance, index: number, origin: Vec3): void => {
    const e = emitters[index];
    const pool = e.mesh ? meshes : sprites;
    const i = slot(pool, inst.own);
    if (i < 0) return;
    // Where it starts, around the origin, and which way it goes: within `spread` of its direction,
    // which is outward from a sphere or a ring and up otherwise unless the emitter gives one.
    let ox = 0;
    let oy = 0;
    let oz = 0;
    let bx = 0;
    let by = 1;
    let bz = 0;
    const s = e.shape;
    switch (s.kind) {
      case "sphere": {
        inCone(0, 1, 0, 180, dir);
        const r = s.size[0] * Math.cbrt(Math.random());
        [ox, oy, oz] = [dir[0] * r, dir[1] * r, dir[2] * r];
        [bx, by, bz] = dir;
        break;
      }
      case "ring": {
        const angle = Math.random() * Math.PI * 2;
        [bx, by, bz] = [Math.cos(angle), 0, Math.sin(angle)];
        [ox, oy, oz] = [bx * s.size[0], 0, bz * s.size[0]];
        break;
      }
      case "box":
        [ox, oy, oz] = [(Math.random() * 2 - 1) * s.size[0], (Math.random() * 2 - 1) * s.size[1], (Math.random() * 2 - 1) * s.size[2]];
        break;
      case "line": {
        const to = inst.toward?.();
        if (to) {
          const t = Math.random();
          [ox, oy, oz] = [(to.x - origin.x) * t, (to.y - origin.y) * t, (to.z - origin.z) * t];
        }
        break;
      }
    }
    if (e.direction) [bx, by, bz] = e.direction;
    inCone(bx, by, bz, s.kind === "cone" ? s.angle : e.spread, dir);
    const speed = range(e.speed);
    const vx = dir[0] * speed + inst.vx * e.inherit;
    const vy = dir[1] * speed + inst.vy * e.inherit;
    const vz = dir[2] * speed + inst.vz * e.inherit;

    pool.vx[i] = vx;
    pool.vy[i] = vy;
    pool.vz[i] = vz;
    pool.life[i] = range(e.life);
    pool.age[i] = 0;
    pool.spin[i] = range(e.spin);
    // A mesh that does not spin keeps the shape's own orientation (a ring lies flat); anything else
    // starts turned at random.
    pool.rot[i] = e.mesh && e.spin[0] === 0 && e.spin[1] === 0 ? 0 : Math.random() * Math.PI * 2;
    pool.sizeScale[i] = inst.size;
    pool.emitter[i] = index;
    pool.own[i] = inst.own ? 1 : 0;
    const texture = e.sprite >= 0 ? rules.textures[e.sprite] : null;
    pool.variant[i] = texture ? Math.floor(Math.random() * texture.variants) : 0;
    if (e.mesh) {
      inCone(0, 1, 0, 180, dir);
      pool.ax[i] = dir[0];
      pool.ay[i] = dir[1];
      pool.az[i] = dir[2];
    }
    if (e.local) {
      pool.instance[i] = instanceIds.get(inst)!;
      pool.ox[i] = ox;
      pool.oy[i] = oy;
      pool.oz[i] = oz;
    } else pool.instance[i] = -1;
    pool.x[i] = origin.x + ox;
    pool.y[i] = origin.y + oy;
    pool.z[i] = origin.z + oz;
    shade(pool, i, 0);
  };

  /** Its size and colour at the share of its life it has lived. */
  const shade = (pool: Pool, i: number, t: number): void => {
    const e = emitters[pool.emitter[i]];
    pool.size[i] = curveAt(e.size, t) * pool.sizeScale[i];
    colourAt(e.colour, t, colour);
    pool.r[i] = colour[0];
    pool.g[i] = colour[1];
    pool.b[i] = colour[2];
    pool.a[i] = colour[3];
  };

  const stepPool = (pool: Pool, dt: number): void => {
    for (let i = 0; i < pool.count; ) {
      pool.age[i] += dt;
      if (pool.age[i] >= pool.life[i]) {
        removeAt(pool, i);
        continue;
      }
      const e = emitters[pool.emitter[i]];
      if (e.drag > 0) {
        const k = Math.exp(-e.drag * dt);
        pool.vx[i] *= k;
        pool.vy[i] *= k;
        pool.vz[i] *= k;
      }
      pool.vy[i] -= e.gravity * dt;
      pool.rot[i] += pool.spin[i] * dt;
      const owner = pool.instance[i] >= 0 ? byId.get(pool.instance[i]) : undefined;
      if (owner?.now) {
        pool.ox[i] += pool.vx[i] * dt;
        pool.oy[i] += pool.vy[i] * dt;
        pool.oz[i] += pool.vz[i] * dt;
        pool.x[i] = owner.now.x + pool.ox[i];
        pool.y[i] = owner.now.y + pool.oy[i];
        pool.z[i] = owner.now.z + pool.oz[i];
      } else {
        // A local particle whose effect has gone carries on where it was.
        pool.instance[i] = -1;
        pool.x[i] += pool.vx[i] * dt;
        pool.y[i] += pool.vy[i] * dt;
        pool.z[i] += pool.vz[i] * dt;
      }
      shade(pool, i, pool.age[i] / pool.life[i]);
      i++;
    }
  };

  const system: ParticleSystem = {
    emitters,
    sprites,
    meshes,
    spawn(effect, at, options = {}) {
      const def = rules.effects.get(effect);
      const indices = effectEmitters.get(effect);
      if (!def || !indices) return null;
      const where = at();
      if (!where) return null;
      if (camera && Math.hypot(where.x - camera.x, where.y - camera.y, where.z - camera.z) > EFFECT_DISTANCE) return null;
      const inst: Instance = {
        def,
        emitters: indices,
        at,
        toward: options.toward,
        count: options.count ?? 1,
        size: options.size ?? 1,
        own: options.own ?? false,
        time: 0,
        owed: indices.map(() => 0),
        fired: indices.map(() => 0),
        stopped: false,
        dead: false,
        last: { ...where },
        now: { ...where },
        vx: 0,
        vy: 0,
        vz: 0,
      };
      const id = nextInstance++;
      instanceIds.set(inst, id);
      byId.set(id, inst);
      instances.push(inst);
      // Bursts at 0 go out at once, so a hit's sparks are there this frame.
      advance(inst, 0);
      return {
        get alive() {
          return !inst.dead;
        },
        stop() {
          inst.stopped = true;
        },
        kill() {
          inst.stopped = true;
          inst.dead = true;
          for (const pool of [sprites, meshes]) {
            for (let i = 0; i < pool.count; ) {
              if (pool.instance[i] === id) removeAt(pool, i);
              else i++;
            }
          }
        },
      };
    },
    update(dt, cam) {
      camera = cam;
      for (const inst of instances) advance(inst, dt);
      for (let i = instances.length - 1; i >= 0; i--) {
        if (!instances[i].dead) continue;
        const id = instanceIds.get(instances[i])!;
        instanceIds.delete(instances[i]);
        byId.delete(id);
        instances.splice(i, 1);
      }
      stepPool(sprites, dt);
      stepPool(meshes, dt);
    },
    effects: () => instances.length,
    clear() {
      for (const inst of instances) inst.dead = true;
      instances.length = 0;
      instanceIds.clear();
      byId.clear();
      sprites.count = 0;
      meshes.count = 0;
    },
  };

  /** Moves an effect on by dt: follows its attachment and emits what is due. */
  function advance(inst: Instance, dt: number): void {
    if (inst.dead) return;
    const where = inst.at();
    if (!where) {
      // What it was on has gone: it stops where it was.
      inst.stopped = true;
    } else {
      if (dt > 0 && inst.now) {
        inst.vx = (where.x - inst.now.x) / dt;
        inst.vy = (where.y - inst.now.y) / dt;
        inst.vz = (where.z - inst.now.z) / dt;
      }
      inst.last = inst.now;
      inst.now = { ...where };
    }
    const origin = inst.now;
    const from = inst.time;
    inst.time += dt;
    let busy = false;
    inst.emitters.forEach((index, k) => {
      const e = emitters[index];
      const start = e.delay;
      const end = e.delay + e.duration;
      if (!inst.stopped && origin) {
        // Bursts whose time has come.
        while (inst.fired[k] < e.bursts.length && inst.time >= start + e.bursts[inst.fired[k]].at) {
          const n = Math.round(e.bursts[inst.fired[k]].count * inst.count);
          for (let p = 0; p < n; p++) emit(inst, index, origin);
          inst.fired[k]++;
        }
        // The rate, over the part of this step the emitter runs in.
        if (e.rate > 0) {
          const span = Math.max(0, Math.min(inst.time, end) - Math.max(from, start));
          inst.owed[k] += span * e.rate * inst.count;
          while (inst.owed[k] >= 1) {
            emit(inst, index, origin);
            inst.owed[k] -= 1;
          }
        }
      }
      if (!inst.stopped && (inst.time < end || inst.fired[k] < e.bursts.length)) busy = true;
    });
    // An effect is over once its emitters are done and its particles gone.
    if (!busy) {
      inst.stopped = true;
      const id = instanceIds.get(inst);
      let left = false;
      for (const pool of [sprites, meshes]) {
        for (let i = 0; i < pool.count && !left; i++) if (pool.instance[i] === id) left = true;
      }
      // Free particles do not hold it: only local ones need its attachment.
      if (!left) inst.dead = true;
    }
  }

  return system;
}
