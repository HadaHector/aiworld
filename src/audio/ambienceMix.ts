// What the ambience should sound like where the player is (SLICE.md, P7): the pure part - a state
// of the surroundings in, the level of every layer out - so the levels can be checked by a probe
// without any audio. The sound itself is src/audio/ambience.ts.

/** The surroundings, as the game knows them each frame. */
export interface AmbienceState {
  /** The weather's wind: 1 is a plain day, 0.35 a still mist, 3.5 a blizzard. */
  wind: number;
  /** 0..1, the weather's rain (the blend where the player stands). */
  rain: number;
  /** 0..1, the weather's snow. Snow is quiet: it only hushes the rest. */
  snow: number;
  /** The hour, 0..24. */
  hour: number;
  /** 0..1: how far underground the light is - a cave or a crypt - as it fades in and out. */
  underground: number;
  /** What the underground is, for its own sound. */
  hollow: "cave" | "crypt" | null;
  /** Inside a house (outdoor sound comes through walls, dulled). */
  indoors: boolean;
  /** Metres to the nearest water that is not the sea (a river, a pond) - Infinity for none. */
  waterDistance: number;
  /** Metres to the sea's water - Infinity for none (left out: none). */
  seaDistance?: number;
  /** 0..1, how alive the place is: woods are full of birds, bare ground is not. */
  life: number;
  /** Where the river (or pond) and the sea lie, on the ground (x east, z north), and how much of it
   *  is one way: 1 all one side, 0 all round (standing in it, or on a spit). Left out: no direction. */
  waterBearing?: Bearing;
  seaBearing?: Bearing;
  /** The way the listener faces, on the ground (the camera's forward). Left out: north. */
  facing?: { x: number; z: number };
}

/** A direction on the ground and how sure it is: `focus` 0..1. */
export interface Bearing {
  x: number;
  z: number;
  focus: number;
}

/** What each layer should be: gains are 0..1 before the player's volume, rates are per second. */
export interface AmbienceMix {
  wind: number;
  /** Dry leaves moving, over the wind (autumn). */
  rustle: number;
  rain: number;
  /** The drops on leaves and ground, over the rain's hiss. */
  patter: number;
  water: number;
  /** A river's or a pond's water alone, and the sea's surf (recorded only): with a surf recording
   *  heard, the water layer plays `river`, else `water`, which is the nearer of the two. */
  river: number;
  surf: number;
  /** The wood's own bed by day and by night (recorded only: silent without a file). */
  forestDay: number;
  forestNight: number;
  /** Rain on the roof over the player, indoors (recorded only). */
  roofRain: number;
  /** A crypt's room tone and draught (a cave's and a mine's is silent: their sound is the reverb on
   *  the effects - `echo`). */
  room: number;
  /** Everything above ground, together: 0 deep underground. */
  outdoors: number;
  /** The low-pass the outdoor sound goes through: a wall's worth of it indoors. */
  outdoorCutHz: number;
  birdsPerSecond: number;
  owlsPerSecond: number;
  /** The cave's room tone, and its drips. */
  hollow: number;
  dripsPerSecond: number;
  /** A crypt's low drone, over the room tone. */
  crypt: number;
  /** 0..1, the stone reverb on the sound effects (footsteps, blows) underground. */
  echo: number;
  /** Left (-1) to right (1) for the water layer (the nearer of river and sea), the river alone and
   *  the surf; and 0..1 how far each is behind the listener (dulled a little when it is). */
  waterPan: number;
  riverPan: number;
  surfPan: number;
  waterBehind: number;
  riverBehind: number;
  surfBehind: number;
}

/** The furthest a bed is panned: never all in one ear, which on speakers sounds like a channel gone. */
export const PAN_MOST = 0.65;

/** A bearing as heard facing `facing`: pan left to right, and how far behind. */
export function heard(bearing: Bearing | undefined, facing: { x: number; z: number } | undefined, softer = 1): { pan: number; behind: number } {
  if (!bearing || !(bearing.focus > 0)) return { pan: 0, behind: 0 };
  const fl = Math.hypot(facing?.x ?? 0, facing?.z ?? 1) || 1;
  const fx = (facing?.x ?? 0) / fl;
  const fz = (facing?.z ?? 1) / fl;
  const bl = Math.hypot(bearing.x, bearing.z);
  if (bl < 1e-6) return { pan: 0, behind: 0 };
  const bx = bearing.x / bl;
  const bz = bearing.z / bl;
  // Right of the facing is (fz, -fx): facing north (+z), east (+x) is to the right.
  const right = bx * fz - bz * fx;
  const ahead = bx * fx + bz * fz;
  const focus = clamp(bearing.focus) * softer;
  return { pan: clamp(right, -1, 1) * focus * PAN_MOST, behind: clamp(-ahead) * focus };
}

/** Water is heard from this far, at most; it is at full voice within `WATER_CLOSE`. */
export const WATER_REACH = 38;
export const WATER_CLOSE = 4;
/** The sea is heard from this far, at full voice within `SEA_CLOSE`. */
export const SEA_REACH = 90;
export const SEA_CLOSE = 12;

const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));
const smooth = (x: number): number => x * x * (3 - 2 * x);

/** 0 at night, 1 by day, with dawn and dusk an hour or two long. */
export function dayness(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  return smooth(clamp((h - 5) / 2.5)) * smooth(clamp((20.5 - h) / 2.5));
}

export function ambienceMix(s: AmbienceState): AmbienceMix {
  const day = dayness(s.hour);
  const below = clamp(s.underground);
  const out = 1 - below;
  const indoors = s.indoors ? 1 : 0;
  // Behind walls the outdoors is lower and dull, but a roof under rain is its loudest.
  const wall = 1 - indoors * 0.55;
  const rain = clamp(s.rain);
  const gale = clamp((s.wind - 1) / 2.5);
  // Always a faint breath in the trees, then rising with the weather's wind.
  const wind = clamp(0.1 + 0.5 * clamp(s.wind / 3) ** 0.8 + 0.2 * gale) * (1 - 0.5 * clamp(s.snow));
  const rustle = clamp((s.wind - 0.5) / 2.2) * 0.5 * (1 - rain * 0.5);
  const near = (d: number): number => (d >= WATER_REACH ? 0 : clamp(1 - (d - WATER_CLOSE) / (WATER_REACH - WATER_CLOSE)) ** 1.6);
  const sea = s.seaDistance ?? Infinity;
  const riverNear = near(s.waterDistance);
  // (The synthesized water stands for the sea too, at a river's reach, when there is no surf to play.)
  const waterNear = Math.max(riverNear, near(sea));
  const surfNear = sea >= SEA_REACH ? 0 : clamp(1 - (sea - SEA_CLOSE) / (SEA_REACH - SEA_CLOSE)) ** 1.3;
  // Birds sing in the day, fall quiet in rain and in a gale, and not at all indoors or below.
  const singing = out * (1 - indoors) * day * clamp(1 - rain * 1.6) * clamp(1 - gale * 1.1) * clamp(1 - s.snow * 2) * clamp(s.life);
  const owls = out * (1 - indoors) * (1 - day) * clamp(1 - rain * 2) * clamp(1 - gale) * clamp(s.life);
  // The wood's bed: what birds and insects make of it, hushed by rain, a gale and snow.
  const bed = out * wall * clamp(s.life) * clamp(1 - rain * 0.9) * clamp(1 - gale * 0.7) * (1 - 0.6 * clamp(s.snow));
  const hollow = below;
  const crypt = s.hollow === "crypt" ? below : 0;
  const wet = indoors ? 0.5 : 1;
  // Through walls a sound's way is less sure.
  const softer = indoors ? 0.5 : 1;
  const river = heard(s.waterBearing, s.facing, softer);
  const seaWay = heard(s.seaBearing, s.facing, softer);
  const nearer = near(sea) > riverNear ? seaWay : river;
  return {
    wind: wind * wall * out,
    rustle: rustle * wall * out,
    rain: rain ** 0.7 * 0.55 * (indoors ? 0.7 : 1) * out,
    patter: rain * 0.5 * (indoors ? 0.5 : 1) * out,
    water: waterNear * 0.6 * wet * out,
    river: riverNear * 0.6 * wet * out,
    surf: surfNear * wall * out,
    forestDay: bed * day,
    forestNight: bed * (1 - day),
    roofRain: rain ** 0.7 * indoors * out,
    room: crypt,
    outdoors: out,
    outdoorCutHz: indoors ? 650 : 18000,
    birdsPerSecond: singing * 0.55,
    owlsPerSecond: owls * 0.05,
    hollow,
    dripsPerSecond: crypt * 0.22,
    crypt: crypt,
    echo: hollow,
    waterPan: nearer.pan,
    riverPan: river.pan,
    surfPan: seaWay.pan,
    waterBehind: nearer.behind,
    riverBehind: river.behind,
    surfBehind: seaWay.behind,
  };
}
