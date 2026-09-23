import type { BiomeDefinition } from "./biomeTypes";
import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { TreeKind } from "../foliage/foliageConfig";

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
};

export const BIOME_REGISTRY: BiomeDefinition[] = [plains, forest, hills, desert, mountains, tundra, canyon, swamp];
