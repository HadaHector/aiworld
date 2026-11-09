import type { BeastDef, ClipDef, GaitDef, GaitPattern } from "./beastDef";
import type { BeastGeometry, BeastLimb } from "./beastBuild";
import { add, cross, dot, normalize, scale, sub, type Vec } from "../skeleton";

/**
 * A beast's animation (BEASTS.md, *Animation*). Gaits are **baked**: for each gait, at a few dozen
 * points of its cycle, every walking foot's path (planted for the gait's duty, an arc between) is
 * solved once by IK into turns on the limb's bones, and the trunk's bob, pitch and wave added. At run
 * time the animator only samples those tables by phase and blends gaits by speed, so a crowd costs no
 * solving. Idle, clips (bites, swipes, the web spit), a flinch and death are laid over that.
 *
 * A pose is a rotation per bone, as a quaternion [x, y, z, w] in the body's bind-pose frame, applied
 * at the bone's head after its parent's (beastMesh.ts).
 */
export type Quat = [number, number, number, number];
const IDENTITY: Quat = [0, 0, 0, 1];

export function axisAngle(axis: Vec, angle: number): Quat {
  const a = normalize(axis);
  const s = Math.sin(angle / 2);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
}
/** `a` after `b`: rotate by `b`, then by `a`. */
export function qmul(a: Quat, b: Quat): Quat {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
function qnorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
/** Blends toward `b` by `t`, the short way round. */
export function qlerp(a: Quat, b: Quat, t: number): Quat {
  const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  return qnorm([a[0] + (b[0] * sign - a[0]) * t, a[1] + (b[1] * sign - a[1]) * t, a[2] + (b[2] * sign - a[2]) * t, a[3] + (b[3] * sign - a[3]) * t]);
}
function euler(deg: [number, number, number]): Quat {
  const k = Math.PI / 180;
  // Yaw about up, then pitch about right, then roll about forward - as a head turns.
  return qmul(axisAngle([0, 1, 0], deg[1] * k), qmul(axisAngle([1, 0, 0], deg[0] * k), axisAngle([0, 0, 1], deg[2] * k)));
}

export interface BeastPose {
  /** Per bone, its rotation: 4 numbers a bone. */
  rotations: Float32Array;
  offset: Vec;
  /** A foot came down this frame: which limb. */
  step?: number;
}

/** The gait cycles, baked: per gait, `SAMPLES` poses of every bone and the body's offset. */
export interface BakedGaits {
  gaits: GaitDef[];
  samples: number;
  poses: Float32Array[];
  offsets: Float32Array[];
  /** Per walking limb, per gait, where in the cycle its foot comes down. */
  touchdown: number[][];
}

const SAMPLES = 32;

/** Where in the cycle each walking limb's foot comes down (0-1), by the gait's pattern. */
export function patternPhases(pattern: GaitPattern, limbs: BeastLimb[]): number[] {
  const ranks = Math.max(1, ...limbs.map((l) => l.rank + 1));
  return limbs.map((l) => {
    const r = l.rank;
    const left = l.side < 0 ? 0 : 0.5;
    const frontToBack = ranks > 1 ? r / (ranks - 1) : 0;
    switch (pattern) {
      // Lateral sequence: hind left, fore left, hind right, fore right.
      case "walk":
        return ranks <= 2 ? ((r === ranks - 1 ? 0 : 0.25) + (l.side < 0 ? 0 : 0.5)) % 1 : (left + frontToBack * 0.5) % 1;
      // Diagonal pairs together.
      case "trot":
        return (left + (r % 2) * 0.5) % 1;
      // Same-side pairs together.
      case "pace":
        return left;
      // Front pair together, hind pair half a cycle later.
      case "bound":
        return (r % 2) * 0.5;
      // A rotary gallop: each pair slightly apart, the hind half a cycle after the fore.
      case "gallop":
        return ((r % 2) * 0.55 + (l.side < 0 ? 0 : 0.1)) % 1;
      // Six legs: front and back of one side with the middle of the other.
      case "tripod":
        return ((r % 2) * 0.5 + (l.side < 0 ? 0 : 0.5)) % 1;
      // Eight legs: alternating tetrapods - 1 and 3 of one side with 2 and 4 of the other.
      case "tetrapod":
        return ((r % 2) * 0.5 + (l.side < 0 ? 0 : 0.5)) % 1;
      // A wave rippling from back to front, the sides half a cycle apart.
      case "wave":
        return (left + (1 - frontToBack) * 0.5) % 1;
      // Many legs: a ripple down the body, each pair a little after the one in front.
      case "metachronal":
        return (left + r * 0.12) % 1;
    }
  });
}

/** Solves a planar chain to reach (x1, x2) - along its heading and down - from its rest angles. */
function solvePlanar(lengths: number[], rest: number[], target: [number, number], start: number[]): number[] {
  const angles = [...start];
  const n = lengths.length;
  const end = (): [number, number] => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < n; i++) {
      x += Math.sin(angles[i]) * lengths[i];
      y += Math.cos(angles[i]) * lengths[i];
    }
    return [x, y];
  };
  const reach = lengths.reduce((s, l) => s + l, 0);
  const d = Math.hypot(target[0], target[1]);
  const goal: [number, number] = d > reach * 0.999 ? [(target[0] / d) * reach * 0.999, (target[1] / d) * reach * 0.999] : target;
  if (n === 1) return [Math.atan2(goal[0], goal[1])];
  if (n === 2) {
    // Two bones: the knee bends the way it bends at rest.
    const [a, b] = lengths;
    const dist = Math.max(Math.abs(a - b) + 1e-4, Math.hypot(goal[0], goal[1]));
    const toGoal = Math.atan2(goal[0], goal[1]);
    const cosA = Math.max(-1, Math.min(1, (a * a + dist * dist - b * b) / (2 * a * dist)));
    const bend = Math.sign(rest[1] - rest[0]) || 1;
    const first = toGoal - bend * Math.acos(cosA);
    const ex = goal[0] - Math.sin(first) * a;
    const ey = goal[1] - Math.cos(first) * a;
    return [first, Math.atan2(ex, ey)];
  }
  // More: cyclic coordinate descent, pulled back toward the rest shape so the chain keeps its look.
  for (let iter = 0; iter < 30; iter++) {
    for (let i = n - 1; i >= 0; i--) {
      let bx = 0;
      let by = 0;
      for (let k = 0; k < i; k++) {
        bx += Math.sin(angles[k]) * lengths[k];
        by += Math.cos(angles[k]) * lengths[k];
      }
      const [ex, ey] = end();
      const turn = Math.atan2(goal[0] - bx, goal[1] - by) - Math.atan2(ex - bx, ey - by);
      const wrapped = Math.atan2(Math.sin(turn), Math.cos(turn)) * 0.7;
      for (let k = i; k < n; k++) angles[k] += wrapped;
    }
    // The pull toward rest fades, so the last iterations close on the goal exactly.
    if (iter < 14) for (let i = 0; i < n; i++) angles[i] += (rest[i] - angles[i]) * 0.04;
  }
  return angles;
}

/**
 * Turns on a limb's bones that put its foot at `target` (bind-pose body coordinates): the whole limb
 * yawed about the vertical through its root for what its plane cannot reach (a spider's leg swinging
 * forward), then its chain solved in its plane - the last segment (the paw, the tarsus) keeping its
 * rest angle plus `curl`.
 */
function limbTurns(limb: BeastLimb, target: Vec, curl: number, previous: number[] | null): { turns: Quat[]; angles: number[] } {
  const rel = sub(target, limb.attach);
  const n = limb.lengths.length;
  // Out of the plane: a yaw, if the limb reaches out sideways enough to have a lever for it.
  const inPlane = dot(rel, limb.e1);
  const across = dot(rel, limb.n);
  const horizontal = Math.hypot(limb.e1[0], limb.e1[2]);
  let yaw = 0;
  // Turning e1 about up by yaw takes it to e1 cos(yaw) - n sin(yaw) (n is e2 x e1, e2 about down).
  if (inPlane > 0.12 * limb.lengths.reduce((s, l) => s + l, 0) && horizontal > 0.5) yaw = Math.atan(-across / inPlane);
  const yawQ = axisAngle([0, 1, 0], yaw);
  // The target turned back by the yaw, then in plane coordinates.
  const unyawed = rotate(qconj(yawQ), rel);
  let x1 = dot(unyawed, limb.e1);
  let x2 = dot(unyawed, limb.e2);
  const footAngle = limb.rest[n - 1] + curl;
  let angles: number[];
  if (n >= 3) {
    // The foot keeps its angle: solve the rest of the chain to its root (a two-bone leg - a
    // centipede's - has no foot to spare, and is solved whole).
    x1 -= Math.sin(footAngle) * limb.lengths[n - 1];
    x2 -= Math.cos(footAngle) * limb.lengths[n - 1];
    angles = [...solvePlanar(limb.lengths.slice(0, n - 1), limb.rest.slice(0, n - 1), [x1, x2], previous ? previous.slice(0, n - 1) : limb.rest.slice(0, n - 1)), footAngle];
  } else angles = solvePlanar(limb.lengths, limb.rest, [x1, x2], previous ?? limb.rest);
  const turns: Quat[] = [];
  let before = 0;
  for (let i = 0; i < n; i++) {
    const delta = angles[i] - limb.rest[i];
    let q = axisAngle(limb.n, delta - before);
    if (i === 0) q = qmul(yawQ, q);
    turns.push(q);
    before = delta;
  }
  return { turns, angles };
}

function qconj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}
function rotate(q: Quat, v: Vec): Vec {
  const u: Vec = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}

const ease = (t: number): number => t * t * (3 - 2 * t);

/** Bakes every gait of a plan for this body (BEASTS.md: IK at build time, keyframes at run time). */
export function bakeGaits(def: BeastDef, body: BeastGeometry): BakedGaits {
  const walking = body.limbs.filter((l) => l.walks);
  const bones = body.bones.length;
  const poses: Float32Array[] = [];
  const offsets: Float32Array[] = [];
  const touchdown: number[][] = walking.map(() => []);
  const bodyBones = body.bones.map((b, i) => ({ b, i })).filter(({ b }) => b.kind !== "limb");
  for (const gait of def.gaits) {
    const phases = patternPhases(gait.pattern, walking);
    walking.forEach((_, l) => touchdown[l].push(phases[l]));
    const pose = new Float32Array(SAMPLES * bones * 4);
    const offset = new Float32Array(SAMPLES * 3);
    const previous: (number[] | null)[] = walking.map(() => null);
    // Two passes over the cycle, so the second starts from where the first ended (CCD's start).
    for (let pass = 0; pass < 2; pass++)
      for (let s = 0; s < SAMPLES; s++) {
        const phase = s / SAMPLES;
        const set = (bone: number, q: Quat): void => pose.set(q, (s * bones + bone) * 4);
        for (let b = 0; b < bones; b++) set(b, IDENTITY);
        // The body: bobbing twice a cycle, pitching and waving.
        const bob = -gait.bob * Math.cos(phase * Math.PI * 4);
        offset.set([0, bob, 0], s * 3);
        // Trunk: a lateral wave down the body, a pitch flexing it; the head steadied against both.
        let waveSum = 0;
        let pitchSum = 0;
        for (const { b, i } of bodyBones) {
          if (b.role === "head") continue;
          const k = i / Math.max(1, bones);
          const w = gait.wave * Math.sin(phase * Math.PI * 2 + k * 2.4) * (b.role === "tail" ? 2.2 : 1);
          const p = gait.pitch * Math.sin(phase * Math.PI * 4 + (b.kind === "root" ? 0 : 0.8)) * (b.kind === "root" ? 1 : 0.5);
          set(i, qmul(axisAngle([0, 1, 0], w), axisAngle([1, 0, 0], p)));
          if (b.role !== "tail") {
            waveSum += w;
            pitchSum += p;
          }
        }
        for (const { b, i } of bodyBones) if (b.role === "head") set(i, qmul(axisAngle([0, 1, 0], -waveSum * 0.6), axisAngle([1, 0, 0], -pitchSum * 0.6)));
        // Where each trunk bone now is: its turn and its head, through its parents, with the bob.
        const trunkFrame = (bone: number): { q: Quat; head: Vec } => {
          const chain: number[] = [];
          for (let b = bone; b >= 0; b = body.bones[b].parent) chain.unshift(b);
          let q: Quat = IDENTITY;
          let head: Vec = add(body.bones[chain[0]].head, [0, bob, 0]);
          for (let k = 0; k < chain.length; k++) {
            const b = chain[k];
            if (k > 0) head = add(head, rotate(q, sub(body.bones[b].head, body.bones[chain[k - 1]].head)));
            const at = (s * bones + b) * 4;
            q = qmul(q, [pose[at], pose[at + 1], pose[at + 2], pose[at + 3]]);
          }
          return { q, head };
        };
        // While down a foot travels back exactly as far as the body goes forward; `reach` lengthens
        // the swing's arc forward of the rest point (and the stance's back) without changing that.
        const reach = gait.stride * gait.duty;
        const ahead = (gait.reach - 1) * reach * 0.5;
        walking.forEach((limb, l) => {
          const local = (((phase - phases[l]) % 1) + 1) % 1;
          let dz: number;
          let dy = 0;
          let curl = 0;
          if (local < gait.duty) dz = ahead + reach * (0.5 - local / gait.duty);
          else {
            const u = (local - gait.duty) / (1 - gait.duty);
            dz = ahead + reach * (-0.5 + ease(u));
            dy = gait.lift * Math.sin(Math.PI * u);
            curl = 0.9 * Math.sin(Math.PI * Math.min(1, u * 1.3));
          }
          // The sole on the ground, whatever the rest pose gave this limb - in the frame of the trunk
          // bone it hangs off, as that bone has been moved by the bob, pitch and wave.
          const ground: Vec = [limb.tip[0], limb.sole + dy, limb.tip[2] + dz];
          const frame = trunkFrame(limb.on);
          const target = add(rotate(qconj(frame.q), sub(ground, frame.head)), body.bones[limb.on].head);
          const { turns, angles } = limbTurns(limb, target, curl, previous[l]);
          previous[l] = angles;
          limb.bones.forEach((bone, k) => set(bone, turns[k]));
        });
      }
    poses.push(pose);
    offsets.push(offset);
  }
  return { gaits: def.gaits, samples: SAMPLES, poses, offsets, touchdown };
}

/** What drives a beast's animation each frame: as the humanoid's MotionInput (animation.ts). */
export interface BeastInput {
  /** Speed over the ground, metres a second, in the body's own scale (the world's over its size). */
  speed: number;
  play?: string;
  stop?: string;
  flinch?: { forward: number; side: number; strength: number };
  dead?: boolean;
  snap?: boolean;
}

export interface BeastAnimator {
  update: (input: BeastInput, dt: number) => BeastPose;
}

/** Bone indices a clip's key names: a name, or a pattern with `*` for any letters. */
function matcher(names: string[]): (key: string) => number[] {
  const cache = new Map<string, number[]>();
  return (key) => {
    let hit = cache.get(key);
    if (!hit) {
      const pattern = new RegExp(`^${key.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      hit = names.map((n, i) => (pattern.test(n) ? i : -1)).filter((i) => i >= 0);
      cache.set(key, hit);
    }
    return hit;
  };
}

const CLIP_IN = 0.1;
const CLIP_OUT = 0.2;
const FLINCH_TIME = 0.3;
const DEATH_TIME = 1.1;

export function createBeastAnimator(def: BeastDef, body: BeastGeometry, baked: BakedGaits, seed = 0): BeastAnimator {
  const bones = body.bones.length;
  const names = body.bones.map((b) => b.name);
  const match = matcher(names);
  const out = new Float32Array(bones * 4);
  const scratch = new Float32Array(bones * 4);
  const walking = body.limbs.filter((l) => l.walks);
  let phase = 0;
  let time = 0;
  let moving = 0;
  const gaitWeights = new Array(baked.gaits.length).fill(0);
  let clip: { def: ClipDef; at: number; out: number } | null = null;
  let flinch: { at: number; q: Quat } | null = null;
  let dead = 0;
  let wasDead = false;
  let look = 0;
  let lookTarget = 0;
  let nextLook = 2;
  const deathSide = seed % 2 === 0 ? 1 : -1;
  const headBones = body.bones.map((b, i) => (b.role === "head" || b.role === "neck" ? i : -1)).filter((i) => i >= 0);
  const tailBones = body.bones.map((b, i) => (b.role === "tail" ? i : -1)).filter((i) => i >= 0);
  const chest = body.places.chest ?? 0;
  const deathClip = def.actions.death ? def.clips.get(def.actions.death) : undefined;

  const get = (a: Float32Array, b: number): Quat => [a[b * 4], a[b * 4 + 1], a[b * 4 + 2], a[b * 4 + 3]];
  const put = (a: Float32Array, b: number, q: Quat): void => a.set(q, b * 4);
  const apply = (b: number, q: Quat): void => put(out, b, qmul(get(out, b), q));

  /** A clip's turns and offset at time `t` of it. */
  const sampleClip = (c: ClipDef, t: number): { turns: Map<number, Quat>; offset: Vec } => {
    const u = Math.min(1, t / c.length);
    let i = 0;
    while (i < c.keys.length - 2 && c.keys[i + 1].t < u) i++;
    const a = c.keys[i];
    const b = c.keys[Math.min(c.keys.length - 1, i + 1)];
    const f = b.t > a.t ? ease(Math.max(0, Math.min(1, (u - a.t) / (b.t - a.t)))) : 1;
    const turns = new Map<number, Quat>();
    for (const key of new Set([...Object.keys(a.turns), ...Object.keys(b.turns)])) {
      const qa = euler(a.turns[key] ?? [0, 0, 0]);
      const qb = euler(b.turns[key] ?? [0, 0, 0]);
      const q = qlerp(qa, qb, f);
      for (const bone of match(key)) turns.set(bone, turns.has(bone) ? qmul(turns.get(bone)!, q) : q);
    }
    return { turns, offset: [a.offset[0] + (b.offset[0] - a.offset[0]) * f, a.offset[1] + (b.offset[1] - a.offset[1]) * f, a.offset[2] + (b.offset[2] - a.offset[2]) * f] };
  };

  /** The default death when a plan names none: rolled onto its side, the legs folding. */
  const defaultDeath = (k: number): { turns: Map<number, Quat>; offset: Vec } => {
    const turns = new Map<number, Quat>();
    turns.set(0, axisAngle([0, 0, 1], deathSide * 1.45 * k));
    for (const limb of body.limbs)
      limb.bones.forEach((bone, i) => {
        const fold = (i === 0 ? 0.35 : i % 2 === 1 ? -0.8 : 0.6) * k;
        turns.set(bone, axisAngle(limb.n, fold));
      });
    for (const b of headBones) turns.set(b, axisAngle([1, 0, 0], 0.35 * k));
    const drop = body.bones[0].head[1] - body.width * 0.28;
    return { turns, offset: [0, -drop * k, 0] };
  };

  return {
    update(input, dt) {
      time += dt;
      let step: number | undefined;
      const offset: Vec = [0, 0, 0];
      // ---- Gaits by speed, a phase advancing with the ground covered.
      const gaits = baked.gaits;
      const speed = input.dead ? 0 : Math.max(0, input.speed);
      const targetMoving = gaits.length === 0 ? 0 : Math.min(1, speed / Math.max(0.05, gaits[0].speed * 0.4));
      moving += (targetMoving - moving) * Math.min(1, dt * 8);
      if (gaits.length > 0) {
        let g = 0;
        while (g < gaits.length - 1 && speed > gaits[g + 1].speed) g++;
        const next = Math.min(gaits.length - 1, g + 1);
        let t = 0;
        if (next !== g) t = ease(Math.max(0, Math.min(1, (speed - gaits[g].speed) / Math.max(0.01, gaits[next].speed - gaits[g].speed))));
        for (let i = 0; i < gaits.length; i++) {
          const want = i === g ? 1 - t : i === next && next !== g ? t : 0;
          gaitWeights[i] += (want - gaitWeights[i]) * Math.min(1, dt * 6);
        }
        const totalW = gaitWeights.reduce((s, w) => s + w, 0) || 1;
        // The phase advances by exactly the ground the baked stance covers, so planted feet stay put;
        // faster or slower than a gait's speed, the legs simply cycle faster or slower.
        const stride = gaitWeights.reduce((s, w, i) => s + (w / totalW) * gaits[i].stride, 0);
        const before = phase;
        phase = (phase + (speed * dt) / Math.max(0.05, stride)) % 1;
        // A foot comes down: its touch-down phase passed.
        const lead = gaitWeights.indexOf(Math.max(...gaitWeights));
        walking.forEach((_, l) => {
          const at = baked.touchdown[l][lead];
          const crossed = before <= phase ? before < at && at <= phase : before < at || at <= phase;
          if (crossed && moving > 0.5) step = l;
        });
        // Blend the baked cycles.
        const f = phase * baked.samples;
        const s0 = Math.floor(f) % baked.samples;
        const s1 = (s0 + 1) % baked.samples;
        const fs = f - Math.floor(f);
        let acc = 0;
        for (let i = 0; i < gaits.length; i++) {
          const w = gaitWeights[i] / totalW;
          if (w < 1e-3) continue;
          const pose = baked.poses[i];
          for (let b = 0; b < bones; b++) {
            const q = qlerp(get(pose, s0 * bones + b), get(pose, s1 * bones + b), fs);
            put(scratch, b, acc === 0 ? q : qlerp(get(scratch, b), q, w / (acc + w)));
          }
          offset[1] += w * (baked.offsets[i][s0 * 3 + 1] * (1 - fs) + baked.offsets[i][s1 * 3 + 1] * fs) * moving;
          acc += w;
        }
        for (let b = 0; b < bones; b++) put(out, b, acc === 0 ? IDENTITY : qlerp(IDENTITY, get(scratch, b), moving));
      } else for (let b = 0; b < bones; b++) put(out, b, IDENTITY);

      // ---- Idle: breathing in the chest, the tail swaying, the head looking round now and then.
      const still = 1 - moving;
      if (still > 0.01) {
        const breathe = Math.sin(time * 2.2) * 0.025 * def.idle.breathe * still;
        apply(chest, axisAngle([1, 0, 0], breathe));
        offset[1] += Math.sin(time * 2.2) * 0.004 * def.idle.breathe * still;
        if (time > nextLook) {
          lookTarget = (Math.sin(time * 12.9898 + seed) * 43758.5453) % 1;
          lookTarget = (lookTarget - Math.floor(lookTarget) - 0.5) * 1.1;
          nextLook = time + 2.5 + ((seed + Math.floor(time)) % 4);
        }
        look += (lookTarget - look) * Math.min(1, dt * 2.5);
        for (const b of headBones) apply(b, axisAngle([0, 1, 0], (look * 0.5 * def.idle.head * still) / headBones.length));
      }
      tailBones.forEach((b, i) => apply(b, axisAngle([0, 1, 0], Math.sin(time * 1.7 - i * 0.7) * 0.12 * def.idle.tail * (0.4 + still * 0.6))));

      // ---- Clips.
      if (input.play) {
        const c = def.clips.get(input.play) ?? (def.actions[input.play] ? def.clips.get(def.actions[input.play]) : undefined);
        if (c && !(clip && clip.def.id === c.id && c.loop)) clip = { def: c, at: 0, out: -1 };
      }
      if (input.stop && clip && (clip.def.id === input.stop || def.actions[input.stop] === clip.def.id)) clip.out = clip.out < 0 ? 0 : clip.out;
      if (clip) {
        clip.at += dt;
        const c = clip.def;
        let t = clip.at;
        if (c.loop) t = t % c.length;
        const done = !c.loop && !c.hold && clip.at >= c.length;
        if (clip.out >= 0) clip.out += dt;
        const weight = Math.min(1, clip.at / CLIP_IN) * (done ? Math.max(0, 1 - (clip.at - c.length) / CLIP_OUT) : clip.out >= 0 ? Math.max(0, 1 - clip.out / CLIP_OUT) : 1);
        if (weight <= 0 && (done || clip.out >= 0)) clip = null;
        else {
          const { turns, offset: o } = sampleClip(c, Math.min(t, c.length));
          if (c.layer === "full") for (let b = 0; b < bones; b++) if (!turns.has(b)) put(out, b, qlerp(get(out, b), IDENTITY, weight * 0.8));
          for (const [b, q] of turns) put(out, b, qmul(get(out, b), qlerp(IDENTITY, q, weight)));
          offset[0] += o[0] * weight;
          offset[1] += o[1] * weight;
          offset[2] += o[2] * weight;
        }
      }

      // ---- A flinch: the body jerked away from the blow.
      if (input.flinch) {
        const { forward, side, strength } = input.flinch;
        flinch = { at: 0, q: qmul(axisAngle([1, 0, 0], -forward * 0.18 * strength), axisAngle([0, 0, 1], side * 0.16 * strength)) };
      }
      if (flinch) {
        flinch.at += dt;
        const u = flinch.at / FLINCH_TIME;
        if (u >= 1) flinch = null;
        else {
          const k = u < 0.18 ? u / 0.18 : 1 - (u - 0.18) / 0.82;
          put(out, 0, qmul(qlerp(IDENTITY, flinch.q, k), get(out, 0)));
          for (const b of headBones) apply(b, qlerp(IDENTITY, flinch.q, k * 0.7));
        }
      }

      // ---- Death: falls over, lies; gets up again when it is no longer dead.
      const isDead = !!input.dead;
      if (input.snap) dead = isDead ? 1 : 0;
      else dead = Math.max(0, Math.min(1, dead + (isDead ? dt / DEATH_TIME : -dt / 0.35)));
      if (isDead && !wasDead && !input.snap) clip = null;
      wasDead = isDead;
      if (dead > 0) {
        // Faster as it goes over, a settle at the end.
        const k = dead < 1 ? Math.min(1, Math.pow(dead, 1.6) * 1.08) - Math.max(0, dead - 0.85) * 0.5 : 1;
        const pose = deathClip ? sampleClip(deathClip, deathClip.length * Math.min(1, dead)) : defaultDeath(1);
        const w = deathClip ? Math.min(1, dead * 3) : k;
        for (let b = 0; b < bones; b++) {
          const q = pose.turns.get(b) ?? IDENTITY;
          put(out, b, qlerp(get(out, b), q, w));
        }
        offset[0] += (pose.offset[0] - offset[0]) * w;
        offset[1] += (pose.offset[1] - offset[1]) * w;
        offset[2] += (pose.offset[2] - offset[2]) * w;
      }
      return { rotations: out, offset, step };
    },
  };
}

export const BEAST_DEATH_TIME = DEATH_TIME;
