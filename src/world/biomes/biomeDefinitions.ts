import { Color3 } from "@babylonjs/core";
import type { BiomeAtmosphere, BiomeDayNight, BiomeDefinition } from "./biomeTypes";
import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { TreeKind } from "../foliage/foliageConfig";
import { coolNightTone, deriveNightIntensity } from "../lighting/dayNightMath";

// Every other biome's fog starts at the same fraction of the draw distance the un-zoned default
// used before biomes had a say in it - only a biome with something to say (the swamp) overrides it.
const DEFAULT_FOG_START_FRACTION = 0.3;

/** Shorthand for an atmosphere literal - every biome states its three colours plus how close its
 *  fog sits in, so this is just Color3-from-tuple three times and a default rather than a helper
 *  worth naming beyond that. */
function atmosphere(
  horizon: [number, number, number],
  zenith: [number, number, number],
  cloud: [number, number, number],
  fogStartFraction = DEFAULT_FOG_START_FRACTION,
): BiomeAtmosphere {
  return { horizon: Color3.FromInts(...horizon), zenith: Color3.FromInts(...zenith), cloud: Color3.FromInts(...cloud), fogStartFraction };
}

// Shared by every biome that doesn't say otherwise - a plain, unsaturated day palette so a biome
// only has to state colour where it actually wants to diverge from it (see e.g. forest/desert
// below), the same pattern atmosphere()'s fogStartFraction default already uses. There is no
// DEFAULT_*_NIGHT pair any more: night is derived from whatever the day colour/intensity turns out
// to be (see dayNight() below and lighting/dayNightMath.ts), so a biome that tints its own day
// colours gets an automatically-matching, consistently-cooler-and-dimmer night for free.
const DEFAULT_AMBIENT_DAY: [number, number, number] = [176, 196, 214];
const DEFAULT_AMBIENT_DAY_INTENSITY = 0.55;
const DEFAULT_SUN_HORIZON: [number, number, number] = [255, 150, 90];
const DEFAULT_SUN_ZENITH: [number, number, number] = [255, 248, 224];
const DEFAULT_SUN_INTENSITY = 1.0;

interface DayNightOverrides {
  ambientDay?: [number, number, number];
  ambientDayIntensity?: number;
  sunHorizon?: [number, number, number];
  sunZenith?: [number, number, number];
  sunIntensity?: number;
  /** Escape hatches for a biome that wants its night to diverge from the derived one outright,
   *  rather than just inheriting a cooler/dimmer version of its day colours - unused today (every
   *  biome's derived night already reads distinctly enough), kept because "derive it" should never
   *  be a dead end if a future zone genuinely needs its own night. */
  ambientNight?: [number, number, number];
  ambientNightIntensity?: number;
  moonColor?: [number, number, number];
  moonIntensity?: number;
}

/** Shorthand for a day-night literal. Every biome states its own peak elevations - the one setting
 *  the user asked for explicitly, since it is what makes a zone's sky read as equatorial (high,
 *  harsh noon) or polar (low, grazing) - and its day colours; night is always the SAME rule applied
 *  to those (see dayNightMath.ts's NIGHT_BRIGHTNESS/coolNightTone) unless explicitly overridden. */
function dayNight(sunPeakElevation: number, moonPeakElevation: number, overrides: DayNightOverrides = {}): BiomeDayNight {
  const ambientDay = Color3.FromInts(...(overrides.ambientDay ?? DEFAULT_AMBIENT_DAY));
  const ambientDayIntensity = overrides.ambientDayIntensity ?? DEFAULT_AMBIENT_DAY_INTENSITY;
  const sunZenithColor = Color3.FromInts(...(overrides.sunZenith ?? DEFAULT_SUN_ZENITH));
  const sunIntensity = overrides.sunIntensity ?? DEFAULT_SUN_INTENSITY;
  return {
    sunPeakElevation,
    moonPeakElevation,
    ambientDay,
    ambientDayIntensity,
    sunHorizonColor: Color3.FromInts(...(overrides.sunHorizon ?? DEFAULT_SUN_HORIZON)),
    sunZenithColor,
    sunIntensity,
    ambientNight: overrides.ambientNight ? Color3.FromInts(...overrides.ambientNight) : coolNightTone(ambientDay),
    ambientNightIntensity: overrides.ambientNightIntensity ?? deriveNightIntensity(ambientDayIntensity),
    // The moon's colour derives from the sun's ZENITH colour (its full-strength daylight hue), not
    // its horizon one - moonlight doesn't have its own "moonrise/moonset" colour shift in this
    // model, so there is only the one sun colour worth cooling into it.
    moonColor: overrides.moonColor ? Color3.FromInts(...overrides.moonColor) : coolNightTone(sunZenithColor),
    moonIntensity: overrides.moonIntensity ?? deriveNightIntensity(sunIntensity),
  };
}

/** A single shared-shape "detail" pipeline: one fbm noise, offset by the biome's base elevation.
 *  Reproduces the pre-pipeline fbm arithmetic exactly (amplitude/frequency scaled off the old
 *  DEFAULT_FBM_PARAMS, offset = baseElevation) so the six original biomes carry over unchanged. */
function detailHeightPipeline(params: {
  amplitude: number;
  frequency: number;
  offset: number;
  persistence?: number;
  octaves?: number;
}): PipelineDef {
  return {
    noises: [
      {
        name: "detail",
        type: "fbm",
        octaves: params.octaves ?? 4,
        frequency: params.frequency,
        amplitude: params.amplitude,
        persistence: params.persistence ?? 0.4,
        lacunarity: 2.0,
      },
    ],
    steps: [
      { output: "raw", op: "sample", noise: "detail" },
      { output: "result", op: "offset", input: "raw", amount: params.offset },
    ],
  };
}

/**
 * The density map for a zone that grows a single species: one slow noise turned into a 0-1 share
 * of the scatter lattice.
 *
 * `openAt` is the noise value below which there are no trees at all and `fullAt` the value where a
 * stand reaches `peak`, so the pair decides both how much of the zone is wooded and how abruptly a
 * wood gives way to open ground - which is why there is no separate "patchiness" knob. `frequency`
 * is the size of a stand; 0.003 is a grove a few hundred units across.
 *
 * Zones that grow more than one species write their graph out in full, because the interesting
 * part is how they divide the ground between them.
 */
function standDensity(
  kind: TreeKind,
  params: { frequency: number; openAt: number; fullAt: number; peak: number },
): PipelineDef {
  return {
    noises: [
      { name: "stand", type: "fbm", octaves: 3, frequency: params.frequency, amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
    ],
    steps: [
      { output: "raw", op: "sample", noise: "stand" },
      { output: "ramp", op: "remap", input: "raw", inMin: params.openAt, inMax: params.fullAt, outMin: 0, outMax: params.peak },
      { output: "density", op: "clamp", input: "ramp", min: 0, max: params.peak },
    ],
    outputs: { [kind]: "density" },
  };
}

/**
 * Splits a single "how wooded is it here" cover signal between two species by a 0-1 share, so the
 * two always partition the same ground rather than stacking two independent densities on it. What
 * drives the share is the caller's business: a slow noise gives interleaved stands, the `height`
 * input gives a belt up a hillside.
 */
function twoSpecies(params: {
  lower: TreeKind;
  upper: TreeKind;
  cover: PipelineDef["steps"];
  share: PipelineDef["steps"];
  noises: PipelineDef["noises"];
}): PipelineDef {
  return {
    noises: params.noises,
    steps: [
      ...params.cover,
      ...params.share,
      { output: "lowerShare", op: "invert", input: "share" },
      { output: "lowerDensity", op: "multiply", a: "cover", b: "lowerShare" },
      { output: "upperDensity", op: "multiply", a: "cover", b: "share" },
    ],
    outputs: { [params.lower]: "lowerDensity", [params.upper]: "upperDensity" },
  };
}

const plains: BiomeDefinition = {
  id: "plains",
  voiceId: "verdant",
  name: "Plains",
  outputs: {
    height: detailHeightPipeline({ amplitude: 12.75, frequency: 0.002, offset: 7.5 }),
    foliage: standDensity("broadleaf", { frequency: 0.0012, openAt: 0.12, fullAt: 0.62, peak: 0.55 }),
  },
  borderType: "mountain",
  spawnWeight: 2,
  lakeChance: 0.05,
  baseMaterialId: "grass",
  roadMaterialId: "track",
  atmosphere: atmosphere([196, 214, 210], [88, 140, 202], [246, 248, 244]),
  dayNight: dayNight(65, 45),
};

const forest: BiomeDefinition = {
  id: "forest",
  voiceId: "shaded",
  name: "Forest",
  outputs: {
    height: detailHeightPipeline({ amplitude: 40.45, frequency: 0.0014, offset: 27 }),
    foliage: twoSpecies({
      lower: "broadleaf",
      upper: "pine",
      noises: [
        { name: "stand", type: "fbm", octaves: 3, frequency: 0.0035, amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
        { name: "species", type: "fbm", octaves: 2, frequency: 0.0012, amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
      ],
      // Nearly closed, with the odd clearing rather than the odd stand - this is the one zone
      // where the default is wood and the exception is open ground.
      cover: [
        { output: "standRaw", op: "sample", noise: "stand" },
        { output: "coverRamp", op: "remap", input: "standRaw", inMin: -0.9, inMax: -0.35, outMin: 0, outMax: 1 },
        { output: "cover", op: "clamp", input: "coverRamp", min: 0, max: 1 },
      ],
      // A slower noise than the cover one, so a conifer stand spans several clearings instead of
      // changing species every time the wood thins.
      share: [
        { output: "speciesRaw", op: "sample", noise: "species" },
        { output: "shareRamp", op: "remap", input: "speciesRaw", inMin: 0.12, inMax: 0.5, outMin: 0, outMax: 1 },
        { output: "share", op: "clamp", input: "shareRamp", min: 0, max: 1 },
      ],
      }),
  },
  borderType: "mountain",
  spawnWeight: 2,
  // Closed wood. The hard core still leaves a full TREE_SPACING between trunks, so this is dense
  lakeChance: 0.04,
  baseMaterialId: "grass",
  roadMaterialId: "track",
  atmosphere: atmosphere([164, 186, 172], [70, 112, 132], [214, 222, 208]),
  dayNight: dayNight(58, 38, { ambientDay: [168, 194, 176] }),
};

const hills: BiomeDefinition = {
  id: "hills",
  voiceId: "verdant",
  name: "Hills",
  // Target relief ~10m typical/high with well-separated bumps (same peak-spacing fix as mountains
  // below - wider wavelength, lower persistence so higher octaves stay texture, not competing
  // bumps), measured via FORCE_BIOME_ID (devConfig.ts).
  outputs: {
    height: detailHeightPipeline({ amplitude: 60, frequency: 0.0021, offset: 50, octaves: 5, persistence: 0.35 }),
    foliage: twoSpecies({
      lower: "broadleaf",
      upper: "pine",
      noises: [
        { name: "stand", type: "fbm", octaves: 3, frequency: 0.0034, amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
      ],
      cover: [
        { output: "standRaw", op: "sample", noise: "stand" },
        { output: "coverRamp", op: "remap", input: "standRaw", inMin: -0.45, inMax: 0.2, outMin: 0, outMax: 0.7 },
        { output: "cover", op: "clamp", input: "coverRamp", min: 0, max: 0.7 },
      ],
      // Split by altitude rather than by noise: measured across hills zones the ground runs p25
      // 33, p50 58, p75 82, so this leaves the valley floors broadleaf, the tops coniferous, and
      // a genuinely mixed belt through the middle where most of the zone is.
      share: [
        { output: "ground", op: "input", name: "height" },
        { output: "shareRamp", op: "remap", input: "ground", inMin: 36, inMax: 74, outMin: 0, outMax: 1 },
        { output: "share", op: "clamp", input: "shareRamp", min: 0, max: 1 },
      ],
      }),
  },
  borderType: "mountain",
  spawnWeight: 2,
  lakeChance: 0.03,
  baseMaterialId: "grass",
  roadMaterialId: "track",
  atmosphere: atmosphere([186, 206, 202], [72, 124, 186], [242, 244, 240]),
  dayNight: dayNight(68, 46),
};

const desert: BiomeDefinition = {
  id: "desert",
  voiceId: "arid",
  name: "Desert",
  outputs: {
    height: detailHeightPipeline({ amplitude: 10.1, frequency: 0.0026, offset: 4, persistence: 0.1 }),
    // Barren, except along the water. There is no stray term and no baseline: away from a river
    // this evaluates to zero and the zone grows nothing at all, which is the point of a desert.
    foliage: {
      noises: [{ name: "grove", type: "fbm", octaves: 2, frequency: 0.006, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
      steps: [
        { output: "water", op: "input", name: "riverGap" },
        // The same band the riverside grass uses (see desertRiverGrassLayer): full on the bank,
        // gone about forty units back from it. Descending, so the ramp is full at the water and
        // nothing beyond its reach - and riverGap is Infinity where there is no river at all,
        // which runs off the bottom of this and clamps to zero with no branch needed.
        { output: "bankRamp", op: "remap", input: "water", inMin: 90, inMax: 45, outMin: 0, outMax: 1 },
        { output: "bank", op: "clamp", input: "bankRamp", min: 0, max: 1 },
        // Gathers the palms into clumps along the bank instead of spacing them evenly down it.
        { output: "groveRaw", op: "sample", noise: "grove" },
        { output: "groveRamp", op: "remap", input: "groveRaw", inMin: -0.5, inMax: 0.15, outMin: 0.15, outMax: 0.8 },
        { output: "grove", op: "clamp", input: "groveRamp", min: 0.15, max: 0.8 },
        { output: "palm", op: "multiply", a: "bank", b: "grove" },
      ],
      outputs: { palm: "palm" },
    },
  },
  borderType: "mountain",
  spawnWeight: 2,
  lakeChance: 0.03, // oases
  baseMaterialId: "sand",
  roadMaterialId: "trackSand",
  atmosphere: atmosphere([236, 202, 154], [138, 168, 208], [255, 250, 236]),
  // A harsh, near-overhead noon and a moon that barely clears the dunes - the two extremes of the
  // per-biome elevation range - plus a hotter horizon sun and a dim, sharp-cool night to match.
  dayNight: dayNight(82, 30, { sunHorizon: [255, 120, 55], ambientDay: [214, 198, 164] }),
};

const mountains: BiomeDefinition = {
  id: "mountains",
  voiceId: "stony",
  name: "Mountains",
  // Target relief ~20-30m typical/high AND ~125m between major peaks (measured/eyeballed via
  // FORCE_BIOME_ID, see devConfig.ts - the first pass had the right height but peaks packed far
  // too close together against the character's scale). Base wavelength widened 61m -> 125m, and
  // persistence dropped 0.5 -> 0.42 so the higher octaves only add surface roughness instead of
  // competing peaks at their own shorter wavelength - that competing-peaks effect, not the
  // amplitude, was what made it read as crumpled rather than grand.
  outputs: {
    height: detailHeightPipeline({ amplitude: 60, frequency: 0.0015, offset: 60, octaves: 6, persistence: 0.42 }),
    foliage: standDensity("pine", { frequency: 0.0035, openAt: -0.5, fullAt: 0.1, peak: 0.5 }),
  },
  borderType: "mountain", // generates boundary hills along any edge shared with a differently-bordered biome
  spawnWeight: 1,
  lakeChance: 0.01, // rare tarns/crater lakes
  baseMaterialId: "rock",
  roadMaterialId: "trackStone",
  atmosphere: atmosphere([202, 216, 226], [46, 92, 158], [252, 253, 255]),
  // Thin, crisp air: sun and moon reach nearly the same height, and both read bright and clean.
  dayNight: dayNight(55, 55, { sunZenith: [255, 255, 250] }),
};

const tundra: BiomeDefinition = {
  id: "tundra",
  voiceId: "frozen",
  name: "Tundra",
  outputs: {
    height: detailHeightPipeline({ amplitude: 2.1, frequency: 0.0162, offset: 1 }),
    foliage: standDensity("pine", { frequency: 0.0028, openAt: 0.2, fullAt: 0.65, peak: 0.35 }),
  },
  borderType: "mountain",
  spawnWeight: 1,
  lakeChance: 0.05,
  baseMaterialId: "tundraGround",
  roadMaterialId: "trackStone",
  atmosphere: atmosphere([222, 228, 232], [150, 178, 210], [255, 255, 255]),
  // Polar reversal of the desert: a low, grazing noon sun and a big, bright midnight moon.
  dayNight: dayNight(32, 62, { ambientDay: [210, 220, 230], sunZenith: [235, 240, 245] }),
};

/**
 * Subtracts a sharpened ridged "carve" from a broad "plateau": most of the zone stays near
 * plateau height, but the thin ridge-crest lines (where the ridged fold peaks at every octave
 * simultaneously) get carved deep, toward and through the world's MIN_LAND_HEIGHT floor. This is
 * a genuinely different *shape* than any scalar retuning of a single fbm can produce.
 */
const canyon: BiomeDefinition = {
  id: "canyon",
  voiceId: "stony",
  name: "Canyon",
  // Plateau raised (bigger offset/amplitude) and the carve cut deeper (scale factor 9 -> 24) for
  // real 20-30m drama, measured via FORCE_BIOME_ID (devConfig.ts) same as mountains. Plateau
  // wavelength widened further (167m -> 200m) and persistence dropped (0.5 -> 0.4), same fix as
  // mountains/hills, so the mesa top reads as broad and grand rather than crumpled.
  // The carve needed a second pass: 6 octaves of ridged noise stacks 6 overlapping ridge networks
  // (ridged noise puts a crest at every zero-crossing of the underlying noise, at every octave),
  // which reads as a dense crumpled/veiny texture no matter how narrow each individual crest is -
  // dropping to 3 octaves (and widening wavelength 40m -> 83m) leaves a few distinct, legible
  // channels instead of many competing ones, verified by re-checking the actual screenshots this
  // time rather than only the height distribution.
  outputs: {
    height: {
      noises: [
        { name: "plateau", type: "fbm", octaves: 4, frequency: 0.005, amplitude: 3, persistence: 0.4, lacunarity: 2.0 },
        { name: "carve", type: "ridged", octaves: 1, frequency: 0.002, amplitude: 6, persistence: 0.45, lacunarity: 2.0 },
      ],
      steps: [
        { output: "plateauRaw", op: "sample", noise: "plateau" },
        { output: "plateauLevel", op: "offset", input: "plateauRaw", amount: 100 },
        { output: "carveRaw", op: "sample", noise: "carve" },
        { output: "carveNorm", op: "remap", input: "carveRaw", inMin: 0, inMax: 2, outMin: 0, outMax: 1 },
        { output: "carveSharp", op: "power", input: "carveNorm", exponent: 4 },
        { output: "carveDepth", op: "scale", input: "carveSharp", factor: 4 },
        { output: "carved", op: "subtract", a: "plateauLevel", b: "carveDepth" },
        { output: "carvedClamped", op: "clamp", input: "carved", min: 3, max: 60 },
        { output: "result", op: "add", a: "carvedClamped", "b": "plateauRaw" },
      ],
    },
    foliage: standDensity("palm", { frequency: 0.004, openAt: 0.25, fullAt: 0.7, peak: 0.3 }),
  },
  borderType: "mountain", // generates boundary hills along any edge shared with a differently-bordered biome
  spawnWeight: 0.5,
  lakeChance: 0.02,
  baseMaterialId: "rock",
  roadMaterialId: "trackSand",
  atmosphere: atmosphere([224, 176, 140], [104, 132, 186], [250, 236, 222]),
  dayNight: dayNight(78, 36, { sunHorizon: [255, 128, 68] }),
};

/**
 * Clamps the noise distribution's tails before a low offset, squashing it into a mostly-flat
 * wetland - a different shape (flattened, not just short) than plains' full-range rolling hills.
 */
const swamp: BiomeDefinition = {
  id: "swamp",
  voiceId: "murky",
  name: "Swamp",
  outputs: {
    height: {
      noises: [{ name: "detail", type: "fbm", octaves: 3, frequency: 0.01, amplitude: 5.2, persistence: 0.35, lacunarity: 2.0 }],
      steps: [
        { output: "raw", op: "sample", noise: "detail" },
        //{ output: "flattened", op: "clamp", input: "raw", min: -0.4, max: 0.4 },
        { output: "result", op: "offset", input: "raw", amount: -3.5 },
      ],
    },
    foliage: standDensity("broadleaf", { frequency: 0.005, openAt: -0.3, fullAt: 0.25, peak: 0.6 }),
  },
  borderType: "mountain",
  spawnWeight: 1.5,
  lakeChance: 0.15,
  baseMaterialId: "mud",
  roadMaterialId: "track",
  // A close, low haze instead of the usual 30% - a swamp is the one zone that should never read as
  // open country, whatever the draw-distance slider is set to.
  atmosphere: atmosphere([176, 180, 152], [98, 114, 100], [200, 204, 180], 0.08),
  // Canopy-filtered even at noon (a dimmer sunIntensity than anywhere else) and a murky,
  // low-strength ambient that never gets properly bright even at midday - night then falls out of
  // the ordinary derived rule already dimmer and murkier than anywhere else, rather than needing
  // its own separate night numbers to say so twice.
  dayNight: dayNight(45, 24, {
    ambientDay: [150, 160, 140],
    ambientDayIntensity: 0.42,
    sunHorizon: [200, 150, 110],
    sunIntensity: 0.7,
  }),
};

export const BIOME_REGISTRY: BiomeDefinition[] = [plains, forest, hills, desert, mountains, tundra, canyon, swamp];
