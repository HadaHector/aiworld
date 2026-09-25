import { Color3 } from "@babylonjs/core";
import { lerp, smoothstep } from "../mathUtils";
import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";

// Both bodies rise and set at the same two clock hours - "day and night can be the same length" -
// so one pair of constants fixes both arcs' timing. Shared between sunLighting.ts (which needs the
// full elevation/azimuth arc) and skyDome.ts (which only needs dayness/twilightFactor below), so
// the two can never disagree about when dusk actually starts.
export const SUNRISE_HOUR = 6;
export const SUNSET_HOUR = 18;

// How wide, in the same 0..1 units as `elevationFactor` below, the sunrise/sunset glow band is -
// tuned by eye against the desert's own hot sunHorizonColor rather than derived from anything
// physical. Widening this stretches golden hour; narrowing it makes twilight snap on and off.
const TWILIGHT_WIDTH = 0.35;

// The night brightness/cool-tone knob for LIGHTS - ambient's own colour+intensity and the moon's.
// Deliberately separate from SKY_NIGHT_BRIGHTNESS/SKY_NIGHT_COOL_* below: a light and the sky it
// sits in read very differently even at the same physical brightness (a lit face reflects light
// straight at the camera; a night sky is mostly empty space, which reads as much darker and bluer
// than an equally "0.35-bright" lit surface for reasons no single shared knob can capture), and
// tying them together left no way to darken the sky without also dimming the ground.
export const NIGHT_BRIGHTNESS = 0.35;
// How far a day colour shifts toward NIGHT_COOL_TINT to make its night counterpart - the "mainly a
// cooler tone" half of the same request. Applied before NIGHT_BRIGHTNESS's darkening, so a strongly
// warm day colour (the desert's sand-toned ambient) still reads as cool at night rather than merely
// dim.
const NIGHT_COOL_TINT = Color3.FromInts(90, 115, 160);
const NIGHT_COOL_AMOUNT = 0.4;

// The sky/fog's own, separately-tuned night knobs - much darker and bluer than the light's, since a
// night sky reads as close to black-blue long before a moonlit face does. deriveNightSkyColor below
// is the only thing that reads these.
const SKY_NIGHT_BRIGHTNESS = 0.35;
const SKY_NIGHT_COOL_TINT = Color3.FromInts(18, 26, 58);
const SKY_NIGHT_COOL_AMOUNT = 0.8;

export interface DayNightFactors {
  /** One sine over the full 24h, zero at SUNRISE_HOUR/SUNSET_HOUR, positive by day, negative by
   *  night - the single signal every other factor here derives from, so they can never drift out
   *  of step with each other. */
  raw: number;
  isDay: boolean;
  /** 0 at either body's own rise/set, 1 at its own peak (noon or midnight). */
  elevationFactor: number;
  /** 0..1 smooth night->day crossfade, 0 at midnight, 1 at noon, 0.5 at both sunrise and sunset. */
  dayness: number;
  /** 0..1, peaks at exactly sunrise/sunset and fades to 0 well into either day or night - how much
   *  of the sunrise/sunset glow to mix in (see skyDome.ts). */
  twilightFactor: number;
}

/** The one place the day/night clock turns into every other factor this system needs - see
 *  DayNightFactors' own fields for what each one drives. */
export function computeDayNightFactors(timeHours: number): DayNightFactors {
  const raw = Math.sin((Math.PI * (timeHours - SUNRISE_HOUR)) / (SUNSET_HOUR - SUNRISE_HOUR));
  const isDay = raw >= 0;
  const elevationFactor = Math.abs(raw);
  const dayness = (raw + 1) / 2;
  const twilightFactor = 1 - smoothstep(0, TWILIGHT_WIDTH, elevationFactor);
  return { raw, isDay, elevationFactor, dayness, twilightFactor };
}

/** A day colour's hue shifted toward night's cool tint - brightness untouched, since for a
 *  Babylon light (ambient/moon) that is `intensity`'s job (see deriveNightIntensity) and for a flat
 *  sky/fog colour with no separate intensity it is deriveNightSkyColor's job below. */
export function coolNightTone(day: ColorTuple): ColorTuple {
  return [
    lerp(day[0], NIGHT_COOL_TINT.r, NIGHT_COOL_AMOUNT),
    lerp(day[1], NIGHT_COOL_TINT.g, NIGHT_COOL_AMOUNT),
    lerp(day[2], NIGHT_COOL_TINT.b, NIGHT_COOL_AMOUNT),
  ];
}

export function deriveNightIntensity(dayIntensity: number): number {
  return dayIntensity * NIGHT_BRIGHTNESS;
}

/** For a colour with no separate intensity uniform (the sky dome, whose fragment shader outputs a
 *  colour directly - see skyDome.ts) - the darkening has to be baked into the colour itself rather
 *  than left to a scalar nothing downstream multiplies by. Uses its own SKY_NIGHT_* knobs, not the
 *  light's - see their own comment for why a night sky needs to go much darker and bluer than an
 *  equally "night-brightness" lit surface does. */
export function deriveNightSkyColor(day: Color3): Color3 {
  const cooled = new Color3(
    lerp(day.r, SKY_NIGHT_COOL_TINT.r, SKY_NIGHT_COOL_AMOUNT),
    lerp(day.g, SKY_NIGHT_COOL_TINT.g, SKY_NIGHT_COOL_AMOUNT),
    lerp(day.b, SKY_NIGHT_COOL_TINT.b, SKY_NIGHT_COOL_AMOUNT),
  );
  return cooled.scale(SKY_NIGHT_BRIGHTNESS);
}
