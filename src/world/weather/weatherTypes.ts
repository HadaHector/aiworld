/**
 * A kind of weather (a pack's weathers/ folder): what it does to a zone's sky, fog, light and wind.
 * Every number is relative to the zone's own look - a zone's sky colours, fog distances and light
 * are its fair-weather self, and a weather moves them from there - so one "overcast" greys a desert's
 * pale sky and a moor's blue one alike, each in its own way. All 1s (and a cover of FAIR_CLOUD_COVER,
 * no darkening, no grey) is the zone exactly as it is written.
 */
export interface WeatherDef {
  id: string;
  name: string;
  /** How much of the sky the cloud layer covers, 0 (clear) to 1 (one unbroken deck). */
  cloudCover: number;
  /** How far the clouds darken to rain-cloud grey, 0-1. */
  cloudDarkness: number;
  /** How far the sky's own colours wash out to grey, 0-1 - an overcast sky has no blue in it. */
  skyGrey: number;
  /** Multiplies the zone's fog distances: below 1 the fog closes in. */
  fog: number;
  /** Multiplies the direct sunlight (and moonlight): below 1 the shadows fade with it. */
  sun: number;
  /** Multiplies the ambient sky-fill: an overcast day is lit evenly from the whole sky. */
  ambient: number;
  /** Multiplies how hard the wind blows the grass, the leaves and the clouds. */
  wind: number;
  /** How hard it rains and how thickly it snows, 0 (not at all) to 1 (a downpour, a blizzard). */
  rain: number;
  snow: number;
  /** How long a spell of it lasts, in seconds, before the zone's weather turns again. */
  lasts: [number, number];
}

/** One weather a zone can have, and how likely it is to be drawn next: its odds over the sum of
 *  all the zone's odds. */
export interface WeatherChance {
  weatherId: string;
  odds: number;
}

/** The cloud cover a zone's sky had before there was weather - what "fair" means. */
export const FAIR_CLOUD_COVER = 0.58;

/** The weather where a point is right now: every in-range zone's own weather, each part way from one
 *  spell to the next, blended by the zones' weights. The same fields as a WeatherDef. */
export interface WeatherBlend {
  cloudCover: number;
  cloudDarkness: number;
  skyGrey: number;
  fog: number;
  sun: number;
  ambient: number;
  wind: number;
  rain: number;
  snow: number;
}

/** No weather at all: the zone exactly as written. */
export const NO_WEATHER: WeatherBlend = { cloudCover: FAIR_CLOUD_COVER, cloudDarkness: 0, skyGrey: 0, fog: 1, sun: 1, ambient: 1, wind: 1, rain: 0, snow: 0 };
