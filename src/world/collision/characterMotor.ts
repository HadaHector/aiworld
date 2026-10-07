import type { CollisionWorld, SweepHit } from "./collisionWorld";
import type { QueryShape } from "./narrowphase";
import { Layers, type Shape } from "./shapes";
import { add, cross, dot, length, lengthSq, madd, normalize, scale, sub, vec3, type Vec3 } from "./vec";

export interface MotorSettings {
  radius: number;
  /** The capsule's whole height, round ends included. */
  height: number;
  /** The highest ledge it walks up without jumping. */
  stepHeight: number;
  /** The steepest ground it stands on, in degrees; anything steeper is a wall. */
  maxSlope: number;
  /** How far it keeps from what it touches, so the next move does not start touching. */
  skin: number;
  gravity: number;
  /** The upward speed a jump starts with. */
  jumpSpeed: number;
  /** How long after walking off an edge a jump still counts. */
  coyoteTime: number;
  /** How quickly it steers in the air, as a fraction of the way to the wanted speed per second. */
  airControl: number;
  /** What stops it. */
  mask: number;
}

export const DEFAULT_MOTOR: MotorSettings = {
  radius: 0.4,
  height: 1.8,
  // As far as a house's plinth stands - the step the old floor logic allowed, at the world's scale.
  stepHeight: 0.75,
  // Steep enough for the steepest stair (50 degrees), whose slope stands in for its steps.
  maxSlope: 52,
  skin: 0.02,
  gravity: 24,
  jumpSpeed: 7.6,
  coyoteTime: 0.12,
  airControl: 3,
  mask: Layers.solid,
};

export type ContactKind = "ground" | "wall" | "ceiling";

/** One touch during the last update - for drawing, mostly. */
export interface MotorContact {
  point: Vec3;
  normal: Vec3;
  kind: ContactKind;
  shape: Shape;
}

export interface MotorState {
  /** The bottom of the capsule. */
  feet: Vec3;
  velocity: Vec3;
  grounded: boolean;
  groundNormal: Vec3 | null;
  groundShape: Shape | null;
  /** Seconds since it last stood on ground. */
  airTime: number;
  /** Each touch of the last update. */
  contacts: MotorContact[];
  /** The paths the last update's sweeps took - for drawing. */
  path: Vec3[];
}

export interface MotorInput {
  /** The wanted velocity across the ground (y is ignored). */
  move: Vec3;
  /** Jump, if it can. */
  jump: boolean;
}

export interface CharacterMotor {
  readonly settings: MotorSettings;
  readonly state: MotorState;
  update(dt: number, input: MotorInput): void;
  /** Puts it somewhere, standing still - pushed out if that is inside something. */
  teleport(feet: Vec3): void;
  /** Changes its size or its feel; it is pushed out if it no longer fits. */
  configure(settings: Partial<MotorSettings>): void;
  /** Its capsule, with its feet at `feet`. */
  capsule(feet?: Vec3): QueryShape;
}

const MAX_SLIDES = 4;
const MAX_PUSHES = 4;
/** The ground probe's radius, as a share of the capsule's. */
const PROBE_SHARE = 0.5;

/**
 * A capsule walking and jumping through a collision world: collide and slide, steps, ground it
 * follows down slopes, ceilings that end a jump, and a push out of anything it ends up in. See
 * COLLISION.md.
 */
export function createCharacterMotor(world: CollisionWorld, initial: Partial<MotorSettings> = {}, feet: Vec3 = vec3()): CharacterMotor {
  const settings: MotorSettings = { ...DEFAULT_MOTOR, ...initial };
  const state: MotorState = { feet: { ...feet }, velocity: vec3(), grounded: false, groundNormal: null, groundShape: null, airTime: 0, contacts: [], path: [] };
  let minGroundY = Math.cos((settings.maxSlope * Math.PI) / 180);
  let jumped = false;

  function capsule(at: Vec3 = state.feet): QueryShape {
    const r = settings.radius;
    const top = Math.max(settings.height - r, r);
    return { kind: "capsule", a: vec3(at.x, at.y + r, at.z), b: vec3(at.x, at.y + top, at.z), radius: r };
  }

  const kindOf = (normal: Vec3): ContactKind => (normal.y >= minGroundY ? "ground" : normal.y < -0.05 ? "ceiling" : "wall");

  function note(hit: SweepHit): void {
    state.contacts.push({ point: hit.point, normal: hit.normal, kind: kindOf(hit.normal), shape: hit.shape });
  }

  function sweep(from: Vec3, delta: Vec3): SweepHit | null {
    return world.sweep(capsule(from), delta, settings.mask);
  }

  /**
   * Takes away the velocity going into a surface - a ceiling ends a jump, a floor a fall - but never
   * turns it upward: running into a slope or a step's edge does not launch it.
   */
  function stopInto(normal: Vec3): void {
    const into = dot(state.velocity, normal);
    if (into >= 0) return;
    const before = state.velocity.y;
    state.velocity = madd(state.velocity, normal, -into);
    state.velocity.y = Math.min(state.velocity.y, Math.max(before, 0));
  }

  /** Pushes the feet out of whatever the capsule is in, deepest first; true if it ends clear. */
  function pushOut(): boolean {
    for (let i = 0; i < MAX_PUSHES; i++) {
      const contacts = world.overlap(capsule(), settings.mask);
      if (contacts.length === 0) return true;
      const deepest = contacts.reduce((a, b) => (b.depth > a.depth ? b : a));
      state.feet = madd(state.feet, deepest.normal, deepest.depth + settings.skin / 2);
      state.contacts.push({ point: deepest.point, normal: deepest.normal, kind: kindOf(deepest.normal), shape: deepest.shape });
      stopInto(deepest.normal);
    }
    return world.overlap(capsule(), settings.mask).length === 0;
  }

  /**
   * Moves the feet along `delta`, sliding along what it meets. Walls met while on the ground are
   * taken as upright, so a steep slope is not climbed by sliding up it. Returns whether a wall
   * stopped it.
   */
  function slide(delta: Vec3, onGround: boolean): boolean {
    let remaining = delta;
    const planes: Vec3[] = [];
    let blocked = false;
    for (let i = 0; i < MAX_SLIDES && lengthSq(remaining) > 1e-12; i++) {
      const hit = sweep(state.feet, remaining);
      if (!hit) {
        state.feet = add(state.feet, remaining);
        state.path.push({ ...state.feet });
        break;
      }
      note(hit);
      if (hit.startedInside) {
        pushOut();
        continue;
      }
      const total = length(remaining);
      const dir = scale(remaining, 1 / total);
      // Stop the skin short of it - along the normal, so a glancing touch keeps its gap too.
      const travel = Math.max(0, hit.distance - settings.skin / Math.max(-dot(dir, hit.normal), 0.1));
      state.feet = madd(state.feet, dir, travel);
      state.path.push({ ...state.feet });
      remaining = scale(dir, total - travel);

      let normal = hit.normal;
      const kind = kindOf(normal);
      if (kind !== "ground") blocked = true;
      if (kind === "wall" && onGround) {
        const flat = vec3(normal.x, 0, normal.z);
        if (lengthSq(flat) > 1e-12) normal = normalize(flat);
      }
      stopInto(normal);

      planes.push(normal);
      remaining = clipToPlanes(remaining, planes);
    }
    return blocked;
  }

  /** The move less what goes into any of the planes; along the crease when two of them pinch it. */
  function clipToPlanes(move: Vec3, planes: Vec3[]): Vec3 {
    const last = planes[planes.length - 1];
    let out = madd(move, last, -Math.min(0, dot(move, last)));
    for (let i = 0; i < planes.length - 1; i++) {
      if (dot(out, planes[i]) >= -1e-9) continue;
      const crease = cross(planes[i], last);
      if (lengthSq(crease) < 1e-12) return vec3();
      const along = normalize(crease);
      out = scale(along, dot(move, along));
      // Into a third plane as well: stuck in a corner.
      for (let j = 0; j < planes.length - 1; j++) if (j !== i && dot(out, planes[j]) < -1e-9) return vec3();
      break;
    }
    return out;
  }

  /**
   * Whether a touch from above is something to stand on: walkable ground - or the edge of some, met
   * by the capsule's round bottom at a slant, with walkable ground just past the edge.
   */
  function standsOn(hit: SweepHit): boolean {
    if (kindOf(hit.normal) === "ground") return true;
    if (hit.normal.y <= 0) return false;
    const inward = normalize(vec3(-hit.normal.x, 0, -hit.normal.z));
    const look = settings.skin * 2;
    const over = add(madd(hit.point, inward, look), vec3(0, look, 0));
    const surface = world.raycast(over, vec3(0, -1, 0), look * 2, settings.mask);
    return surface !== null && kindOf(surface.normal) === "ground";
  }

  /** Up a step, across, and down onto it: true (and moved) if it lands on ground further on. */
  function tryStep(from: Vec3, across: Vec3): boolean {
    const start = { ...state.feet };
    const startVelocity = { ...state.velocity };
    const contacts = state.contacts.length;
    const plainGain = horizontalDistance(from, state.feet);
    state.feet = { ...from };
    const up = sweep(state.feet, vec3(0, settings.stepHeight, 0));
    const rise = up ? Math.max(0, up.distance - settings.skin) : settings.stepHeight;
    state.feet = madd(state.feet, vec3(0, 1, 0), rise);
    slide(across, true);
    const down = sweep(state.feet, vec3(0, -(rise + settings.skin * 2), 0));
    if (
      down && !down.startedInside && standsOn(down) &&
      down.point.y - from.y <= settings.stepHeight + settings.skin && horizontalDistance(from, state.feet) > plainGain + 1e-4
    ) {
      state.feet = madd(state.feet, vec3(0, -1, 0), down.distance - settings.skin);
      note(down);
      return true;
    }
    state.feet = start;
    state.velocity = startVelocity;
    state.contacts.length = contacts;
    return false;
  }

  /**
   * Looks for ground under the feet - further while walking, so it follows slopes and stairs down.
   * Probed with a sphere narrower than the capsule, so the edge of a step or a wall's foot brushed
   * by the capsule's round bottom is not taken for the ground it stands on.
   */
  function findGround(reach: number): void {
    const r = settings.radius;
    const probe = r * PROBE_SHARE;
    const centre = vec3(state.feet.x, state.feet.y + r, state.feet.z);
    // A slope lowers where a round bottom rests; allow for the steepest ground there is.
    const slack = r / minGroundY - r;
    const hit = world.sweep({ kind: "sphere", center: centre, radius: probe }, vec3(0, -(reach + r - probe + slack), 0), settings.mask);
    if (hit && !hit.startedInside && kindOf(hit.normal) === "ground") {
      // Where the capsule's round bottom rests on the plane the probe found.
      const n = hit.normal;
      const restY = hit.point.y + (r - n.x * (centre.x - hit.point.x) - n.z * (centre.z - hit.point.z)) / n.y + settings.skin;
      const drop = centre.y - restY;
      if (drop <= reach) {
        if (drop > 0) {
          // Down only as far as nothing else stops it.
          const block = sweep(state.feet, vec3(0, -drop, 0));
          state.feet = madd(state.feet, vec3(0, -1, 0), block && !block.startedInside ? Math.max(0, block.distance - settings.skin) : drop);
        } else {
          state.feet = madd(state.feet, vec3(0, 1, 0), -drop);
        }
        state.grounded = true;
        state.groundNormal = n;
        state.groundShape = hit.shape;
        if (state.velocity.y < 0) state.velocity.y = 0;
        return;
      }
    }
    state.grounded = false;
    state.groundNormal = null;
    state.groundShape = null;
  }

  function step(dt: number, input: MotorInput): void {
    const wanted = vec3(input.move.x, 0, input.move.z);
    if (state.grounded) {
      state.velocity = vec3(wanted.x, Math.min(state.velocity.y, 0), wanted.z);
      jumped = false;
    } else {
      const k = Math.min(1, settings.airControl * dt);
      state.velocity.x += (wanted.x - state.velocity.x) * k;
      state.velocity.z += (wanted.z - state.velocity.z) * k;
      state.velocity.y -= settings.gravity * dt;
    }
    let jumping = false;
    if (input.jump && !jumped && (state.grounded || state.airTime <= settings.coyoteTime)) {
      state.velocity.y = settings.jumpSpeed;
      state.grounded = false;
      jumped = true;
      jumping = true;
    }

    const wasGrounded = state.grounded;
    let across = vec3(state.velocity.x * dt, 0, state.velocity.z * dt);
    // Walking: along the ground's slope, not into it or off it.
    if (wasGrounded && state.groundNormal) {
      const n = state.groundNormal;
      across = vec3(across.x, -(n.x * across.x + n.z * across.z) / n.y, across.z);
    }
    const from = { ...state.feet };
    if (wasGrounded) {
      const blocked = slide(across, true);
      if (blocked && lengthSq(across) > 0) tryStep(from, vec3(across.x, 0, across.z));
    } else {
      slide(scale(state.velocity, dt), false);
    }
    pushOut();

    const rising = state.velocity.y > 0 || jumping;
    findGround(wasGrounded && !rising ? settings.stepHeight + settings.skin * 2 : settings.skin * 2);
    if (rising && state.velocity.y > 0) state.grounded = false;
    state.airTime = state.grounded ? 0 : state.airTime + dt;
  }

  function update(dt: number, input: MotorInput): void {
    state.contacts = [];
    state.path = [{ ...state.feet }];
    // Never more than half its radius a step, so a fast fall or a long frame stays smooth.
    const speed = Math.max(length(state.velocity), length(input.move), settings.jumpSpeed);
    const steps = Math.min(16, Math.max(1, Math.ceil((speed * dt) / (settings.radius / 2))));
    for (let i = 0; i < steps; i++) step(dt / steps, i === 0 ? input : { move: input.move, jump: false });
  }

  function teleport(feet: Vec3): void {
    state.feet = { ...feet };
    state.velocity = vec3();
    state.contacts = [];
    state.path = [{ ...feet }];
    pushOut();
    findGround(settings.stepHeight);
  }

  function configure(next: Partial<MotorSettings>): void {
    Object.assign(settings, next);
    minGroundY = Math.cos((settings.maxSlope * Math.PI) / 180);
    pushOut();
  }

  return { settings, state, update, teleport, configure, capsule };
}

function horizontalDistance(a: Vec3, b: Vec3): number {
  const d = sub(b, a);
  return Math.hypot(d.x, d.z);
}
