import type { BiomeDefinition } from "./biomeTypes";
import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";

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

const plains: BiomeDefinition = {
  id: "plains",
  name: "Plains",
  outputs: { height: detailHeightPipeline({ amplitude: 12.75, frequency: 0.002, offset: 7.5 }) },
  borderType: "mountain",
  spawnWeight: 2,
  lakeChance: 0.05,
  baseMaterialId: "grass",
};

const forest: BiomeDefinition = {
  id: "forest",
  name: "Forest",
  outputs: { height: detailHeightPipeline({ amplitude: 40.45, frequency: 0.0014, offset: 27 }) },
  borderType: "mountain",
  spawnWeight: 2,
  lakeChance: 0.04,
  baseMaterialId: "grass",
};

const hills: BiomeDefinition = {
  id: "hills",
  name: "Hills",
  // Target relief ~10m typical/high with well-separated bumps (same peak-spacing fix as mountains
  // below - wider wavelength, lower persistence so higher octaves stay texture, not competing
  // bumps), measured via FORCE_BIOME_ID (devConfig.ts).
  outputs: { height: detailHeightPipeline({ amplitude: 60, frequency: 0.0021, offset: 50, octaves: 5, persistence: 0.35 }) },
  borderType: "mountain",
  spawnWeight: 2,
  lakeChance: 0.03,
  baseMaterialId: "grass",
};

const desert: BiomeDefinition = {
  id: "desert",
  name: "Desert",
  outputs: { height: detailHeightPipeline({ amplitude: 10.1, frequency: 0.0026, offset: 4, persistence: 0.1 }) },
  borderType: "mountain",
  spawnWeight: 2,
  lakeChance: 0.03, // oases
  baseMaterialId: "sand",
};

const mountains: BiomeDefinition = {
  id: "mountains",
  name: "Mountains",
  // Target relief ~20-30m typical/high AND ~125m between major peaks (measured/eyeballed via
  // FORCE_BIOME_ID, see devConfig.ts - the first pass had the right height but peaks packed far
  // too close together against the character's scale). Base wavelength widened 61m -> 125m, and
  // persistence dropped 0.5 -> 0.42 so the higher octaves only add surface roughness instead of
  // competing peaks at their own shorter wavelength - that competing-peaks effect, not the
  // amplitude, was what made it read as crumpled rather than grand.
  outputs: {
    height: detailHeightPipeline({ amplitude: 60, frequency: 0.0015, offset: 60, octaves: 6, persistence: 0.42 }),
  },
  borderType: "mountain", // generates boundary hills along any edge shared with a differently-bordered biome
  spawnWeight: 1,
  lakeChance: 0.01, // rare tarns/crater lakes
  baseMaterialId: "rock",
};

const tundra: BiomeDefinition = {
  id: "tundra",
  name: "Tundra",
  outputs: { height: detailHeightPipeline({ amplitude: 2.1, frequency: 0.0162, offset: 1 }) },
  borderType: "mountain",
  spawnWeight: 1,
  lakeChance: 0.05,
  baseMaterialId: "tundraGround",
};

/**
 * Subtracts a sharpened ridged "carve" from a broad "plateau": most of the zone stays near
 * plateau height, but the thin ridge-crest lines (where the ridged fold peaks at every octave
 * simultaneously) get carved deep, toward and through the world's MIN_LAND_HEIGHT floor. This is
 * a genuinely different *shape* than any scalar retuning of a single fbm can produce.
 */
const canyon: BiomeDefinition = {
  id: "canyon",
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
  },
  borderType: "mountain", // generates boundary hills along any edge shared with a differently-bordered biome
  spawnWeight: 0.5,
  lakeChance: 0.02,
  baseMaterialId: "rock",
};

/**
 * Clamps the noise distribution's tails before a low offset, squashing it into a mostly-flat
 * wetland - a different shape (flattened, not just short) than plains' full-range rolling hills.
 */
const swamp: BiomeDefinition = {
  id: "swamp",
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
  },
  borderType: "mountain",
  spawnWeight: 1.5,
  lakeChance: 0.15,
  baseMaterialId: "mud",
};

export const BIOME_REGISTRY: BiomeDefinition[] = [plains, forest, hills, desert, mountains, tundra, canyon, swamp];
