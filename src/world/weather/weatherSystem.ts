import type { AreaWeight } from "../cells/areaField";
import { mulberry32, deriveSeed } from "../rng";
import { lerp, smoothstep } from "../mathUtils";
import { NO_WEATHER, type WeatherBlend, type WeatherDef } from "./weatherTypes";

/** How long one weather takes to turn into the next, in seconds. */
const TRANSITION_SECONDS = 90;
/** A weather is this much less likely to be drawn again straight after itself - so a zone's weather
 *  does turn, without ever being forbidden to hold. */
const REPEAT_WEIGHT = 0.35;
const WEATHER_SALT = 0x5ea7;
/** How quickly a weather picked by hand (force) comes in, or the natural weather comes back. */
const FORCE_SECONDS = 4;

/** One area's weather: the spell it is turning from, the one it is turning into, and when. */
interface AreaWeather {
  from: WeatherDef;
  to: WeatherDef;
  startedAt: number;
  endsAt: number;
  random: () => number;
}

export interface WeatherSystem {
  /** Advances the weather clock and blends the weather of every zone in range of the player, by the
   *  same weights the sky and the light blend by. Every frame. */
  update: (deltaSeconds: number, areaWeights: AreaWeight[]) => WeatherBlend;
  /** The weather of one area right now, for the HUD: the spell it is in, and the one it is turning
   *  into with how far along it is - or null for an area with no weather of its own. */
  describe: (areaId: number) => string | null;
  /** Holds every zone at one weather (by id), or lets them go their own way again (null) - for
   *  looking at a weather without waiting for it. Either way it blends over FORCE_SECONDS. */
  force: (weatherId: string | null) => void;
  /** Every weather there is, in order - what a forcing control offers. */
  weathers: readonly WeatherDef[];
}

/**
 * Weather, zone by zone: each area has its own, drawn at random from what its biome can have (a
 * weighted list - see BiomeDefinition.weather), holding for a while and then turning into the next
 * draw over TRANSITION_SECONDS. No two areas are in step and none follows a fixed order. The weather
 * where the player stands is every in-range area's own, blended by the same weights the sky blends
 * by, so walking over a border from rain into sun is a fade, not a switch.
 *
 * Each area's state is made when it is first seen and is caught up whenever it is seen again, so
 * nothing is computed for the areas nobody is near.
 */
export function createWeatherSystem(seed: number, weathers: readonly WeatherDef[]): WeatherSystem {
  const byId = new Map(weathers.map((w) => [w.id, w]));
  const areas = new Map<number, AreaWeather>();
  let now = 0;
  let forced: WeatherDef | null = null;
  // A hand-picked weather (or the release of one) blends from wherever the weather was at the moment
  // of picking: `from` is that moment's blend, `forceStartedAt` when it was.
  let forceFrom: WeatherBlend | null = null;
  let forceStartedAt = -Infinity;
  const natural: WeatherBlend = { ...NO_WEATHER };
  const blend: WeatherBlend = { ...NO_WEATHER };

  const choicesOf = (weight: AreaWeight): { def: WeatherDef; weight: number }[] =>
    weight.biome.weather.flatMap((chance) => {
      const def = byId.get(chance.weatherId);
      return def && chance.odds > 0 ? [{ def, weight: chance.odds }] : [];
    });

  const draw = (choices: { def: WeatherDef; weight: number }[], random: () => number, after: WeatherDef | null): WeatherDef => {
    const weightOf = (c: { def: WeatherDef; weight: number }): number => (c.def === after && choices.length > 1 ? c.weight * REPEAT_WEIGHT : c.weight);
    const total = choices.reduce((sum, c) => sum + weightOf(c), 0);
    let pick = random() * total;
    for (const c of choices) {
      pick -= weightOf(c);
      if (pick <= 0) return c.def;
    }
    return choices[choices.length - 1].def;
  };

  const spell = (def: WeatherDef, random: () => number): number => lerp(def.lasts[0], def.lasts[1], random());

  /** The area's weather, made on first sight and caught up to now. */
  function weatherOf(weight: AreaWeight): AreaWeather | null {
    const choices = choicesOf(weight);
    if (choices.length === 0) return null;
    let state = areas.get(weight.areaId);
    if (!state) {
      const random = mulberry32(deriveSeed(deriveSeed(seed, WEATHER_SALT), weight.areaId));
      const first = draw(choices, random, null);
      // Part way through its first spell, so the areas the player meets don't all turn together.
      state = { from: first, to: first, startedAt: now - TRANSITION_SECONDS, endsAt: now + spell(first, random) * random(), random };
      areas.set(weight.areaId, state);
    }
    // Caught up over however many spells passed while nobody was near (a few at most).
    for (let guard = 0; now >= state.endsAt && guard < 64; guard++) {
      const next = draw(choices, state.random, state.to);
      state.from = state.to;
      state.to = next;
      state.startedAt = state.endsAt;
      state.endsAt = state.startedAt + TRANSITION_SECONDS + spell(next, state.random);
    }
    return state;
  }

  const progressOf = (state: AreaWeather): number => smoothstep(0, 1, Math.min(1, (now - state.startedAt) / TRANSITION_SECONDS));

  function update(deltaSeconds: number, areaWeights: AreaWeight[]): WeatherBlend {
    now += deltaSeconds;
    blendNatural(areaWeights);
    const target = forced ? fieldsOf(forced) : natural;
    const t = forceFrom ? smoothstep(0, 1, Math.min(1, (now - forceStartedAt) / FORCE_SECONDS)) : 1;
    if (t >= 1 && !forced) forceFrom = null;
    for (const key of WEATHER_KEYS) blend[key] = forceFrom ? lerp(forceFrom[key], target[key], t) : target[key];
    return blend;
  }

  /** Every in-range area's own weather, blended by the areas' weights, into `natural`. */
  function blendNatural(areaWeights: AreaWeight[]): void {
    const blend = natural;
    let total = 0;
    for (const key of WEATHER_KEYS) blend[key] = 0;
    for (const weight of areaWeights) {
      const state = weatherOf(weight);
      const t = state ? progressOf(state) : 0;
      const from = state ? state.from : NO_WEATHER;
      const to = state ? state.to : NO_WEATHER;
      const w = weight.weight;
      total += w;
      for (const key of WEATHER_KEYS) blend[key] += lerp(from[key], to[key], t) * w;
    }
    if (total <= 0) {
      Object.assign(blend, NO_WEATHER);
      return;
    }
    for (const key of WEATHER_KEYS) blend[key] /= total;
  }

  function describe(areaId: number): string | null {
    if (forced) return `${forced.name} (picked)`;
    const state = areas.get(areaId);
    if (!state) return null;
    const t = progressOf(state);
    if (t >= 1 || state.from === state.to) return state.to.name;
    return `${state.from.name} → ${state.to.name} ${Math.round(t * 100)}%`;
  }

  function force(weatherId: string | null): void {
    forceFrom = { ...blend };
    forceStartedAt = now;
    forced = weatherId === null ? null : (byId.get(weatherId) ?? null);
  }

  return { update, describe, force, weathers };
}

const WEATHER_KEYS = ["cloudCover", "cloudDarkness", "skyGrey", "fog", "sun", "ambient", "wind", "rain", "snow"] as const;

function fieldsOf(def: WeatherDef): WeatherBlend {
  const fields = { ...NO_WEATHER };
  for (const key of WEATHER_KEYS) fields[key] = def[key];
  return fields;
}
