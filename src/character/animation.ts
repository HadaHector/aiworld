import type { Pose } from "./characterMesh";
import type { RaceSkeleton } from "./raceDef";

/**
 * What a body's animation is driven by, each frame - all of it what the client already knows of an
 * entity, or can work out from how it moved (CHARACTERS.md, *Animation*).
 */
export interface MotionInput {
  /** Speed over the ground, metres a second. */
  speed: number;
  grounded: boolean;
  /** Up the world, metres a second: rising after a jump, falling after it. */
  verticalSpeed: number;
  swimming: boolean;
  /** Set on the frame a melee swing starts. */
  swing?: boolean;
}

/** A pose to set on the body (characterMesh.ts) and how far to move the whole of it, in metres. */
export interface AnimatedPose {
  pose: Pose;
  offset: [number, number, number];
}

export interface Animator {
  update: (input: MotionInput, deltaSeconds: number) => AnimatedPose;
}

/**
 * The bones' own axes (measured, see characterMesh.ts): on a leg or an arm +x swings it forward;
 * on a shin -x bends the knee, on a forearm +x the elbow; on the spine, chest and head +x leans
 * forward, +y twists toward +x, +z leans toward -x; on a foot +x lifts the toes. For the -x side's
 * bones y and z are mirrored, as `both` does.
 */
type Turn = [number, number, number];

const SWING_TIME = 0.62;

/**
 * Procedural animation (CHARACTERS.md): each kind of motion is a function from time and the
 * inputs to a turn per bone, and they are blended by weights that ease toward what the inputs ask
 * for, so nothing snaps.
 *
 * - **Idle** breathes, shifts its weight now and then and looks round.
 * - **Walk and run** are one gait whose phase advances with the distance covered, so its strides
 *   fit its speed: stride, knee lift, bounce, lean, arm swing and elbow bend all grow with speed,
 *   walking turning into running between 4 and 9 m/s (the game walks at 6 and runs at 12). The
 *   body is lowered as far as the leg standing under it has shortened, so its foot stays down.
 * - **In the air** the legs tuck while rising and reach down while falling, the arms out for
 *   balance; landing dips the body.
 * - **Swimming** lies the body along the water and strokes: arms forward, out and back, the legs
 *   kicking together.
 * - **A melee swing** - wind-up, strike, follow-through - is laid over the upper body whatever the
 *   legs are doing.
 */
export function createAnimator(skeleton: RaceSkeleton): Animator {
  const leg = skeleton.thigh + skeleton.shin;
  let time = 0;
  let phase = 0;
  let moving = 0;
  let air = 0;
  let swim = 0;
  let swingAt = -1;
  let wasGrounded = true;
  let airTime = 0;
  let landing = 0;
  let swimPhase = 0;

  const ease = (current: number, target: number, rate: number, dt: number): number => current + (target - current) * Math.min(1, rate * dt);

  return {
    update(input, dt) {
      time += dt;
      const speed = Math.max(0, input.speed);
      // A cycle (two steps) covers more ground the faster it goes, up to a point; past it the legs
      // only turn over faster.
      const stride = leg * Math.min(4.2, 1.4 + 0.35 * speed);
      if (input.grounded && !input.swimming) phase = (phase + (speed * dt) / stride) % 1;
      const run = smooth(4, 9, speed);
      moving = ease(moving, input.grounded && speed > 0.3 ? 1 : 0, 8, dt);
      air = ease(air, input.grounded || input.swimming ? 0 : 1, 12, dt);
      swim = ease(swim, input.swimming ? 1 : 0, 4, dt);
      if (!input.grounded) airTime += dt;
      if (input.grounded && !wasGrounded && airTime > 0.15) landing = 1;
      if (input.grounded) airTime = 0;
      wasGrounded = input.grounded;
      landing = Math.max(0, landing - dt * 4);
      if (input.swing) swingAt = time;
      swimPhase = (swimPhase + dt / 1.5) % 1;

      const idlePose = idle(time);
      const gaitPose = gait(phase, Math.min(1, speed / 3), run);
      let pose = mix(idlePose.pose, gaitPose.pose, moving);
      let offset = lerp3(idlePose.offset, gaitPose.offset, moving);
      pose = mix(pose, inAir(input.verticalSpeed), air);
      offset = lerp3(offset, [0, 0, 0], air);
      pose = mix(pose, swimming(swimPhase), swim);
      // Lying from the hips, the body is as high as they are: down to about half that, in the water.
      offset = lerp3(offset, [0, -leg * 0.5, 0], swim);
      // Landing: a dip and bent knees, gone in a quarter of a second.
      const dip = Math.sin(landing * Math.PI) * (1 - swim);
      if (dip > 0) {
        offset = [offset[0], offset[1] - 0.09 * dip, offset[2]];
        pose = add(pose, legs({ thigh: [0.35 * dip, 0, 0], shin: [-0.7 * dip, 0, 0], foot: [0.3 * dip, 0, 0] }));
      }
      const swingTime = swingAt < 0 ? -1 : time - swingAt;
      if (swingTime >= 0 && swingTime < SWING_TIME) {
        const envelope = smooth(0, 0.08, swingTime) * (1 - smooth(SWING_TIME - 0.15, SWING_TIME, swingTime));
        pose = { ...pose, ...mix(pose, { ...pose, ...swing(swingTime / SWING_TIME) }, envelope) };
      }
      return { pose, offset };
    },
  };

  /** Standing: breathing, a slow shift of weight from foot to foot, the head turning now and then. */
  function idle(t: number): AnimatedPose {
    const breath = Math.sin((t * 2 * Math.PI) / 4.2);
    const shift = Math.sin((t * 2 * Math.PI) / 9);
    const look = wander(t * 0.25) * 0.45;
    return {
      pose: {
        ...both("upperArm", [0.06 + 0.02 * breath, 0, -0.04]),
        ...both("forearm", [0.18, 0, 0]),
        ...both("thigh", [0.02, 0, 0]),
        ...both("shin", [-0.04, 0, 0]),
        pelvis: [0, 0, 0.025 * shift],
        spine: [0.02 * breath, 0, -0.02 * shift],
        chest: [-0.025 * breath, 0, -0.01 * shift],
        neck: [0, look * 0.3, 0],
        head: [0.05 + 0.03 * wander(t * 0.17 + 7), look * 0.7, 0.02 * shift],
      },
      offset: [0, -0.004 * (1 + breath), 0],
    };
  }

  /**
   * One step cycle at `p` (0-1, the +x leg's; the other half a cycle behind it). `amount` grows
   * from a shuffle to a full stride; `run` from walking to running.
   */
  function gait(p: number, amount: number, run: number): AnimatedPose {
    const thighSwing = (0.42 + 0.38 * run) * (0.4 + 0.6 * amount);
    const kneeLift = (0.75 + 0.75 * run) * (0.4 + 0.6 * amount);
    const pose: Pose = {};
    let lowest = 0;
    for (const [suffix, offset] of [["R", 0], ["L", 0.5]] as const) {
      const a = 2 * Math.PI * (p + offset);
      const thigh = thighSwing * Math.sin(a) + 0.08 * run;
      // The knee bends most while the leg swings forward (its thigh angle rising), a little as it
      // takes the weight.
      const knee = -(0.08 + 0.12 * run + kneeLift * Math.max(0, Math.cos(a - 0.5)) ** 1.6);
      // The foot held near level through the stance, toes up as the heel strikes.
      const foot = -(thigh + knee) * 0.75 + 0.2 * Math.max(0, Math.sin(a + 0.6)) - 0.15 * run * Math.max(0, -Math.sin(a));
      pose[`thigh${suffix}`] = [thigh, 0, suffix === "R" ? 0.03 : -0.03];
      pose[`shin${suffix}`] = [knee, 0, 0];
      pose[`foot${suffix}`] = [foot, 0, 0];
      // How far down this leg reaches with the hip where it is.
      const reach = skeleton.thigh * Math.cos(thigh) + skeleton.shin * Math.cos(thigh + knee);
      lowest = Math.max(lowest, reach);
      // The arm on the other side swings with this leg.
      const other = suffix === "R" ? "L" : "R";
      const arm = -(0.3 + 0.45 * run) * (0.4 + 0.6 * amount) * Math.sin(a);
      pose[`upperArm${other}`] = [arm + 0.1 * run, 0, other === "R" ? 0.06 : -0.06];
      pose[`forearm${other}`] = [0.3 + 1.1 * run + 0.25 * Math.max(0, -Math.sin(a)) * (0.4 + run), 0, 0];
    }
    const a = 2 * Math.PI * p;
    // The body lowered to stand on the longest leg; walking rises over it, running sinks into it.
    const drop = leg - lowest;
    const bob = (0.012 + 0.03 * run) * amount * Math.cos(2 * a) * (run > 0.5 ? -1 : 1);
    pose.pelvis = [0.04 * run, 0.12 * amount * Math.sin(a), 0];
    pose.spine = [0.06 + 0.16 * run, -0.08 * amount * Math.sin(a), 0];
    pose.chest = [0.02 * run, -0.1 * amount * Math.sin(a), 0];
    pose.head = [-0.05 - 0.12 * run, 0.04 * amount * Math.sin(a), 0];
    return { pose, offset: [0, -drop + bob, 0] };
  }

  /** Rising: legs tucked, one more than the other, arms up and out. Falling: legs reaching down. */
  function inAir(verticalSpeed: number): Pose {
    const rising = smooth(-2, 2, verticalSpeed);
    const tuck = (r: number, f: number): number => f + (r - f) * rising;
    return {
      thighR: [tuck(0.85, 0.3), 0, 0.05],
      shinR: [tuck(-1.5, -0.45), 0, 0],
      footR: [tuck(0.5, 0.1), 0, 0],
      thighL: [tuck(0.25, -0.05), 0, -0.05],
      shinL: [tuck(-0.7, -0.25), 0, 0],
      footL: [tuck(0.3, 0.15), 0, 0],
      ...both("upperArm", [tuck(0.6, 0.25), 0, tuck(0.35, 0.65)]),
      ...both("forearm", [tuck(0.9, 0.4), 0, 0]),
      spine: [tuck(0.15, 0.05), 0, 0],
      head: [tuck(-0.1, 0.15), 0, 0],
    };
  }

  /** A breaststroke at `p`: glide with the arms ahead, sweep out and back, draw them in and reach
   *  again; the legs draw up and kick out together. The body lies forward from the hips. */
  function swimming(p: number): Pose {
    const sweep = smooth(0.15, 0.45, p) * (1 - smooth(0.55, 0.8, p));
    const draw = smooth(0.45, 0.65, p) * (1 - smooth(0.8, 0.98, p));
    const kick = smooth(0.5, 0.7, p) * (1 - smooth(0.75, 0.9, p));
    return {
      pelvis: [1.35, 0, 0],
      spine: [-0.08, 0, 0],
      chest: [-0.1, 0, 0],
      neck: [-0.35, 0, 0],
      head: [-0.55, 0, 0],
      ...both("upperArm", [2.7 - 1.1 * sweep - 0.6 * draw, 0, 0.15 + 1.0 * sweep - 0.5 * draw]),
      ...both("forearm", [0.15 + 1.5 * draw, 0, 0]),
      ...both("thigh", [-0.25 + 0.95 * kick, 0, 0.1 + 0.35 * kick]),
      ...both("shin", [-0.1 - 1.7 * kick, 0, 0]),
      ...both("foot", [-0.6 + 0.4 * kick, 0, 0]),
    };
  }

  /** A one-handed slash with the +x arm at `p` (0-1): drawn back and up, cut across, carried
   *  through, the chest turning into it. */
  function swing(p: number): Pose {
    const keys: [number, Turn, Turn, Turn, Turn][] = [
      // at, upper arm, forearm, chest, spine
      [0, [0.1, 0, 0.05], [0.3, 0, 0], [0, 0, 0], [0.05, 0, 0]],
      [0.35, [1.9, 0.4, 0.9], [1.4, 0, 0], [0, -0.45, -0.05], [0.0, -0.2, 0]],
      [0.55, [1.2, -0.3, -0.35], [0.25, 0, 0], [0.12, 0.55, 0.05], [0.15, 0.25, 0]],
      [0.75, [0.7, -0.4, -0.25], [0.5, 0, 0], [0.1, 0.4, 0], [0.12, 0.2, 0]],
      [1, [0.1, 0, 0.05], [0.3, 0, 0], [0, 0, 0], [0.05, 0, 0]],
    ];
    let i = 0;
    while (i < keys.length - 2 && p > keys[i + 1][0]) i++;
    const [t0, ua0, fa0, ch0, sp0] = keys[i];
    const [t1, ua1, fa1, ch1, sp1] = keys[i + 1];
    const k = smooth(0, 1, (p - t0) / (t1 - t0));
    const at = (a: Turn, b: Turn): Turn => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    return { upperArmR: at(ua0, ua1), forearmR: at(fa0, fa1), handR: [0, 0, 0], chest: at(ch0, ch1), spine: at(sp0, sp1) };
  }
}

/** A turn for a +x bone and its -x twin, mirrored. */
function both(name: string, turn: Turn): Pose {
  return { [`${name}R`]: turn, [`${name}L`]: [turn[0], -turn[1], -turn[2]] };
}

function legs(parts: { thigh: Turn; shin: Turn; foot: Turn }): Pose {
  return { ...both("thigh", parts.thigh), ...both("shin", parts.shin), ...both("foot", parts.foot) };
}

/** `a` blended toward `b` by `w`, bone by bone - a bone one of them leaves out is at rest there. */
function mix(a: Pose, b: Pose, w: number): Pose {
  if (w <= 0) return a;
  if (w >= 1) return b;
  const out: Pose = {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[name] ?? [0, 0, 0];
    const y = b[name] ?? [0, 0, 0];
    out[name] = [x[0] + (y[0] - x[0]) * w, x[1] + (y[1] - x[1]) * w, x[2] + (y[2] - x[2]) * w];
  }
  return out;
}

function add(a: Pose, b: Pose): Pose {
  const out: Pose = { ...a };
  for (const [name, t] of Object.entries(b)) {
    const x = out[name] ?? [0, 0, 0];
    out[name] = [x[0] + t[0], x[1] + t[1], x[2] + t[2]];
  }
  return out;
}

function lerp3(a: [number, number, number], b: [number, number, number], w: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
}

function smooth(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** A slow wander between -1 and 1: a few sines that never line up. */
function wander(t: number): number {
  return (Math.sin(t * 1.3) + Math.sin(t * 2.9 + 1.7) * 0.6 + Math.sin(t * 0.7 + 4.1) * 0.8) / 2.4;
}
