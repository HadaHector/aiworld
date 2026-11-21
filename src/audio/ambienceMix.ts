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
  /** Metres to the nearest water (a river, a pond) - Infinity for none. */
  waterDistance: number;
  /** 0..1, how alive the place is: woods are full of birds, bare ground is not. */
  life: number;
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
}

/** Water is heard from this far, at most; it is at full voice within `WATER_CLOSE`. */
export const WATER_REACH = 38;
export const WATER_CLOSE = 4;

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
  const waterNear = s.waterDistance >= WATER_REACH ? 0 : clamp(1 - (s.waterDistance - WATER_CLOSE) / (WATER_REACH - WATER_CLOSE)) ** 1.6;
  // Birds sing in the day, fall quiet in rain and in a gale, and not at all indoors or below.
  const singing = out * (1 - indoors) * day * clamp(1 - rain * 1.6) * clamp(1 - gale * 1.1) * clamp(1 - s.snow * 2) * clamp(s.life);
  const owls = out * (1 - indoors) * (1 - day) * clamp(1 - rain * 2) * clamp(1 - gale) * clamp(s.life);
  const hollow = below;
  const crypt = s.hollow === "crypt" ? below : 0;
  return {
    wind: wind * wall * out,
    rustle: rustle * wall * out,
    rain: rain ** 0.7 * 0.55 * (indoors ? 0.7 : 1) * out,
    patter: rain * 0.5 * (indoors ? 0.5 : 1) * out,
    water: waterNear * 0.6 * (indoors ? 0.5 : 1) * out,
    outdoors: out,
    outdoorCutHz: indoors ? 650 : 18000,
    birdsPerSecond: singing * 0.55,
    owlsPerSecond: owls * 0.05,
    hollow,
    dripsPerSecond: hollow * (s.hollow === "crypt" ? 0.22 : 0.45),
    crypt: crypt,
  };
}
