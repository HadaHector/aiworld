// Hit feel (see FEEDBACK.md, *Hit feel*): a struck unit's flash and flinch, the hit pause that
// stops two bodies for an instant, and the camera's shake. The bodies and capsules that do it are
// `Feelable`s the page hands over; the shake is a trauma model - parts add trauma, it decays, and
// the camera moves by its square through smooth noise. No Babylon here.

/** What a drawn unit - a body or a capsule - can be made to do. */
export interface Feelable {
  /** Tints its meshes toward a colour and back over `seconds`. */
  flash: (colour: readonly [number, number, number], seconds: number) => void;
  /** Jerks it away from a blow coming from the world direction (x, z), strength 0-1. */
  flinch: (x: number, z: number, strength: number) => void;
  /** Stops its animation for `seconds`. */
  pause: (seconds: number) => void;
}

export interface Feel {
  /** Adds trauma (0-1, capped at 1). */
  shake: (amount: number) => void;
  /** Each frame: the camera's offset now, in screen units, from the trauma left. */
  update: (dt: number) => { x: number; y: number };
  /** The player's Screen shake setting: 0 turns it off. */
  setShake: (scale: number) => void;
  trauma: () => number;
}

/** Trauma lost a second; and the largest offset, in screen units, at full trauma. */
const DECAY = 1.8;
const REACH = 0.35;

/** Smooth 1D noise: two sines at unrelated rates, enough to look random at shake speeds. */
const wobble = (t: number, seed: number): number => (Math.sin(t * 37.1 + seed) + Math.sin(t * 61.7 + seed * 2.3) * 0.6) / 1.6;

export function createFeel(): Feel {
  let trauma = 0;
  let scale = 1;
  let time = 0;
  return {
    shake(amount) {
      trauma = Math.min(1, trauma + amount);
    },
    update(dt) {
      time += dt;
      trauma = Math.max(0, trauma - DECAY * dt);
      const k = trauma * trauma * scale * REACH;
      return { x: wobble(time, 1.3) * k, y: wobble(time, 7.9) * k };
    },
    setShake(v) {
      scale = Math.max(0, v);
    },
    trauma: () => trauma,
  };
}
