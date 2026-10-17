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
  /** Dead: the body falls and lies still until this is false again. */
  dead?: boolean;
  /** Be as `dead` says at once, with no fall or getting up: a unit first seen already dead lies
   *  there, and one that comes back somewhere else (a respawn) stands there (ABILITIES.md). */
  snap?: boolean;
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
 * - **Walk and run** are two cycles on one phase, which advances with the distance covered so the
 *   strides fit the speed; walking (about 1.2-1.5 m/s) turns into running - a jog, about 3 m/s -
 *   between 1.8 and 2.6. Walking lowers the body as far as the leg standing under it has
 *   shortened, so that foot stays down; running flies between its steps.
 * - **In the air** the legs tuck while rising and reach down while falling, the arms out for
 *   balance; landing dips the body.
 * - **Swimming** lies the body along the water and strokes: arms forward, out and back, the legs
 *   kicking together.
 * - **A melee swing** - wind-up, strike, follow-through - is laid over the upper body whatever the
 *   legs are doing.
 * - **Death**: the knees give, the body tips back and falls, bounces once and lies still - over
 *   whatever else it was doing, until it is alive again.
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
  /** Seconds since death, or -1 while alive; and how far the body is given over to it. */
  let deadFor = -1;
  let death = 0;

  const ease = (current: number, target: number, rate: number, dt: number): number => current + (target - current) * Math.min(1, rate * dt);

  return {
    update(input, dt) {
      time += dt;
      const speed = Math.max(0, input.speed);
      // Walking turns into running between 1.8 and 2.6 m/s. A cycle (two steps) covers more ground
      // the faster it goes, a running one more than a walking one, up to a point; past it the legs
      // only turn over faster.
      const run = smooth(1.8, 2.6, speed);
      const walkStride = leg * Math.min(2.6, 1.2 + 0.4 * speed);
      const runStride = leg * Math.min(4.2, 1.6 + 0.35 * speed);
      const stride = walkStride + (runStride - walkStride) * run;
      if (input.grounded && !input.swimming) phase = (phase + (speed * dt) / stride) % 1;
      moving = ease(moving, input.grounded && speed > 0.3 ? 1 : 0, 8, dt);
      air = ease(air, input.grounded || input.swimming ? 0 : 1, 12, dt);
      swim = ease(swim, input.swimming ? 1 : 0, 4, dt);
      if (!input.grounded) airTime += dt;
      if (input.grounded && !wasGrounded && airTime > 0.15) landing = 1;
      if (input.grounded) airTime = 0;
      wasGrounded = input.grounded;
      landing = Math.max(0, landing - dt * 4);
      if (input.swing) swingAt = time;
      deadFor = input.dead ? (deadFor < 0 ? 0 : deadFor + dt) : -1;
      // Into death at once (what the body was doing gives way within a few frames); out of it
      // gently, when it comes back.
      death = input.dead ? Math.min(1, death + dt * 10) : Math.max(0, death - dt * 3);
      if (input.snap) {
        death = input.dead ? 1 : 0;
        if (input.dead) deadFor = Math.max(deadFor, 2);
      }
      swimPhase = (swimPhase + dt / 1.5) % 1;

      const idlePose = idle(time);
      const walkPose = walking(phase, Math.min(1, speed / 1.3));
      const runPose = running(phase, Math.min(1, speed / 3));
      const gaitPose = { pose: mix(walkPose.pose, runPose.pose, run), offset: lerp3(walkPose.offset, runPose.offset, run) };
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
      if (death > 0) {
        const dying = dyingPose(Math.max(0, deadFor));
        pose = mix(pose, dying.pose, death);
        offset = lerp3(offset, dying.offset, death);
      }
      return { pose, offset };
    },
  };

  /**
   * Death, `t` seconds in: the knees give and the body sags forward; then it tips back from the
   * hips, slowly at first and faster as it goes, as a falling thing does; it lands on its back with
   * a small bounce, and lies there - arms flung out, one knee raised a little, head rolled aside.
   */
  function dyingPose(t: number): AnimatedPose {
    const hips = skeleton.ankle + leg;
    // The knees giving, in the first quarter of a second.
    const sag = smooth(0, 0.25, t);
    // The fall: eased in like a drop, landing at 0.8 s.
    const f = Math.min(1, Math.max(0, (t - 0.15) / 0.65));
    const fall = f * f;
    // A bounce on landing, gone by 1.1 s.
    const bounce = t > 0.8 ? Math.sin(Math.min(1, (t - 0.8) / 0.3) * Math.PI) * 0.06 * (1 - smooth(0.8, 1.1, t)) : 0;
    const lying = smooth(0.6, 1.0, t);
    const pose: Pose = {
      // Tipping back from the hips, the whole body with it.
      pelvis: [-1.5 * fall + bounce * 0.5, 0, 0.08 * fall],
      spine: [0.3 * sag * (1 - fall) - 0.05 * lying, 0.1 * lying, 0],
      chest: [0.15 * sag * (1 - fall), 0.08 * lying, 0],
      neck: [0.2 * sag * (1 - fall), 0.3 * lying, 0],
      head: [0.25 * sag * (1 - fall) - 0.15 * lying, 0.55 * lying, 0.1 * lying],
      // The knees bent as they give, straightening as the body lands - the +x one staying up a little.
      thighR: [0.55 * sag * (1 - fall) + 0.35 * lying, 0, 0.1 * lying],
      shinR: [-1.1 * sag * (1 - fall) - 0.7 * lying, 0, 0],
      footR: [0.4 * sag * (1 - fall) + 0.2 * lying, 0, 0],
      thighL: [0.45 * sag * (1 - fall) + 0.05 * lying, 0, -0.15 * lying],
      shinL: [-0.9 * sag * (1 - fall) - 0.12 * lying, 0, 0],
      footL: [0.35 * sag * (1 - fall) - 0.3 * lying, 0, 0],
      // Arms hanging limp as it sags, thrown up and out as it falls, then lying spread on the ground:
      // on its back, the body's forward is up, so a lying arm swings only out to the side (along
      // the ground), a little back, its elbow near straight.
      ...both("upperArm", [0.25 * sag * (1 - fall) + 0.5 * fall * (1 - lying) - 0.12 * lying, 0, 0.15 + 0.9 * fall]),
      ...both("forearm", [0.3 * (1 - lying) + 0.4 * fall * (1 - lying) + 0.05 * lying, 0, 0]),
      ...both("hand", [-0.1 * lying, 0, 0]),
    };
    // Down as the knees give, then all the way down as it tips over - the hips coming to rest at
    // the body's own thickness off the ground.
    const down = 0.15 * sag * (1 - fall) + (hips - 0.14) * fall;
    return { pose, offset: [0, -down + bounce, 0] };
  }

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
   * A walking cycle at `p` (0-1, the +x leg's; the other half a cycle behind it), `amount` growing
   * from a shuffle to a full stride: one foot always down, the knee bending as the leg swings
   * through, the body rising over the standing leg, the arms swinging loosely against the legs.
   */
  function walking(p: number, amount: number): AnimatedPose {
    const reach = 0.4 + 0.6 * amount;
    const pose: Pose = {};
    let lowest = 0;
    for (const [suffix, offset] of [["R", 0], ["L", 0.5]] as const) {
      const a = 2 * Math.PI * (p + offset);
      const thigh = 0.42 * reach * Math.sin(a);
      // The knee bends most while the leg swings forward (its thigh angle rising), a little as it
      // takes the weight.
      const knee = -(0.08 + 0.75 * reach * Math.max(0, Math.cos(a - 0.5)) ** 1.6);
      // The foot held near level through the stance, toes up as the heel strikes.
      const foot = -(thigh + knee) * 0.75 + 0.2 * Math.max(0, Math.sin(a + 0.6));
      pose[`thigh${suffix}`] = [thigh, 0, suffix === "R" ? 0.03 : -0.03];
      pose[`shin${suffix}`] = [knee, 0, 0];
      pose[`foot${suffix}`] = [foot, 0, 0];
      lowest = Math.max(lowest, skeleton.thigh * Math.cos(thigh) + skeleton.shin * Math.cos(thigh + knee));
      // The arm on the other side swings with this leg.
      const other = suffix === "R" ? "L" : "R";
      pose[`upperArm${other}`] = [-0.3 * reach * Math.sin(a), 0, other === "R" ? 0.06 : -0.06];
      pose[`forearm${other}`] = [0.3 + 0.25 * Math.max(0, -Math.sin(a)) * reach, 0, 0];
    }
    const a = 2 * Math.PI * p;
    // Lowered onto the longer leg, and rising over it at mid-stance.
    const bob = 0.012 * amount * Math.cos(2 * a);
    pose.pelvis = [0, 0.12 * amount * Math.sin(a), 0];
    pose.spine = [0.06, -0.08 * amount * Math.sin(a), 0];
    pose.chest = [0, -0.1 * amount * Math.sin(a), 0];
    pose.head = [-0.05, 0.04 * amount * Math.sin(a), 0];
    return { pose, offset: [0, -(leg - lowest) + bob, 0] };
  }

  /**
   * A running cycle - a jog - at `p`: each foot pushes off behind and the body flies between
   * steps, lowest as it lands on the next; the swinging leg's heel kicks up behind and its knee
   * drives high in front; the body leans into it, the elbows held bent and pumping.
   */
  function running(p: number, amount: number): AnimatedPose {
    const reach = 0.5 + 0.5 * amount;
    const pose: Pose = {};
    let lowest = 0;
    for (const [suffix, offset] of [["R", 0], ["L", 0.5]] as const) {
      const a = 2 * Math.PI * (p + offset);
      // Further forward than back: the knee drives up in front.
      const thigh = 0.2 + 0.6 * reach * Math.sin(a);
      // Folded tight through the swing - the heel up behind as the thigh comes through - and a
      // little through the stance, taking the landing.
      const swingFold = Math.max(0, Math.cos(a + 0.3)) ** 1.2;
      const knee = -(0.3 + 1.55 * reach * swingFold + 0.25 * Math.max(0, -Math.cos(a)));
      // Toes pointed after the push-off, the foot flat again to land.
      const foot = -(thigh + knee) * 0.55 - 0.35 * Math.max(0, -Math.sin(a + 0.4)) * reach;
      pose[`thigh${suffix}`] = [thigh, 0, suffix === "R" ? 0.02 : -0.02];
      pose[`shin${suffix}`] = [knee, 0, 0];
      pose[`foot${suffix}`] = [foot, 0, 0];
      lowest = Math.max(lowest, skeleton.thigh * Math.cos(thigh) + skeleton.shin * Math.cos(thigh + knee));
      // The arm on the other side pumps with this leg, elbow bent near square, crossing a little.
      const other = suffix === "R" ? "L" : "R";
      pose[`upperArm${other}`] = [0.15 - 0.55 * reach * Math.sin(a), 0, other === "R" ? -0.08 : 0.08];
      pose[`forearm${other}`] = [1.45 + 0.2 * Math.sin(a), 0, 0];
    }
    const a = 2 * Math.PI * p;
    // Down onto the leg under it at each mid-stance, so that foot is on the ground; up in the
    // flight between steps.
    const flight = 0.05 * reach * Math.max(0, -Math.cos(2 * a));
    const bob = -(leg - lowest) + flight;
    pose.pelvis = [0.08, 0.08 * reach * Math.sin(a), 0];
    pose.spine = [0.16, -0.06 * reach * Math.sin(a), 0];
    pose.chest = [0.04, -0.12 * reach * Math.sin(a), 0];
    pose.head = [-0.2, 0.04 * reach * Math.sin(a), 0];
    return { pose, offset: [0, bob, 0] };
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
