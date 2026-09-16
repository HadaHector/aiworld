import { Color3 } from "@babylonjs/core";
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
  colors: {
    color0: new Color3(0.76, 0.7, 0.5),
    height0: 3,
    color1: new Color3(0.33, 0.52, 0.25),
    height1: 5.7,
    color2: new Color3(0.45, 0.42, 0.4),
    height2: 8.5,
    color3: new Color3(0.95, 0.95, 0.97),
    height3: 11,
    slopeThreshold: 0.75,
    slopeColor: new Color3(0.45, 0.42, 0.4),
  },
  outputs: { height: detailHeightPipeline({ amplitude: 1.75, frequency: 0.018, offset: 0 }) },
  borderType: "smooth",
  spawnWeight: 3,
};

const forest: BiomeDefinition = {
  id: "forest",
  name: "Forest",
  colors: {
    color0: new Color3(0.35, 0.28, 0.18),
    height0: 3.5,
    color1: new Color3(0.14, 0.32, 0.12),
    height1: 6.5,
    color2: new Color3(0.3, 0.34, 0.24),
    height2: 9,
    color3: new Color3(0.3, 0.29, 0.28),
    height3: 12,
    slopeThreshold: 0.72,
    slopeColor: new Color3(0.3, 0.29, 0.28),
  },
  outputs: { height: detailHeightPipeline({ amplitude: 2.45, frequency: 0.0234, offset: 0.5 }) },
  borderType: "smooth",
  spawnWeight: 2,
};

const hills: BiomeDefinition = {
  id: "hills",
  name: "Hills",
  colors: {
    color0: new Color3(0.7, 0.62, 0.45),
    height0: 4,
    color1: new Color3(0.45, 0.5, 0.28),
    height1: 7,
    color2: new Color3(0.48, 0.45, 0.42),
    height2: 10,
    color3: new Color3(0.75, 0.73, 0.68),
    height3: 13,
    slopeThreshold: 0.78,
    slopeColor: new Color3(0.48, 0.45, 0.42),
  },
  outputs: { height: detailHeightPipeline({ amplitude: 3.5, frequency: 0.018, offset: 1.5 }) },
  borderType: "smooth",
  spawnWeight: 2,
};

const desert: BiomeDefinition = {
  id: "desert",
  name: "Desert",
  colors: {
    color0: new Color3(0.87, 0.78, 0.58),
    height0: 2.5,
    color1: new Color3(0.82, 0.68, 0.42),
    height1: 5,
    color2: new Color3(0.68, 0.5, 0.32),
    height2: 7.5,
    color3: new Color3(0.9, 0.75, 0.5),
    height3: 10,
    slopeThreshold: 0.7,
    slopeColor: new Color3(0.68, 0.5, 0.32),
  },
  outputs: { height: detailHeightPipeline({ amplitude: 2.1, frequency: 0.0126, offset: 0, persistence: 0.5 }) },
  borderType: "smooth",
  spawnWeight: 1.5,
};

const mountains: BiomeDefinition = {
  id: "mountains",
  name: "Mountains",
  colors: {
    color0: new Color3(0.4, 0.38, 0.36),
    height0: 6,
    color1: new Color3(0.35, 0.33, 0.32),
    height1: 10,
    color2: new Color3(0.3, 0.29, 0.28),
    height2: 14,
    color3: new Color3(0.97, 0.97, 0.99),
    height3: 17,
    slopeThreshold: 0.8,
    slopeColor: new Color3(0.3, 0.29, 0.28),
  },
  outputs: {
    height: detailHeightPipeline({ amplitude: 7, frequency: 0.0198, offset: 6, octaves: 5, persistence: 0.45 }),
  },
  borderType: "smooth",
  spawnWeight: 1,
};

const tundra: BiomeDefinition = {
  id: "tundra",
  name: "Tundra",
  colors: {
    color0: new Color3(0.55, 0.58, 0.55),
    height0: 3.5,
    color1: new Color3(0.75, 0.78, 0.78),
    height1: 6,
    color2: new Color3(0.6, 0.6, 0.62),
    height2: 8.5,
    color3: new Color3(0.96, 0.97, 0.99),
    height3: 10.5,
    slopeThreshold: 0.73,
    slopeColor: new Color3(0.6, 0.6, 0.62),
  },
  outputs: { height: detailHeightPipeline({ amplitude: 2.1, frequency: 0.0162, offset: 1 }) },
  borderType: "smooth",
  spawnWeight: 1,
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
  // Thresholds calibrated against sampled deep-interior height distribution (composited with
  // bedrock, like every biome) rather than the pipeline's own local output range: p10=12.4,
  // p50=15.0, p90=17.2 - most land is the broad plateau, so height2/height3 dominate, with the
  // narrow ridged-carved crest lines (which can reach down to MIN_LAND_HEIGHT) picking up color0.
  colors: {
    color0: new Color3(0.35, 0.18, 0.12),
    height0: 8,
    color1: new Color3(0.55, 0.32, 0.16),
    height1: 13,
    color2: new Color3(0.72, 0.55, 0.35),
    height2: 17,
    color3: new Color3(0.85, 0.8, 0.72),
    height3: 20,
    slopeThreshold: 0.8,
    slopeColor: new Color3(0.4, 0.25, 0.15),
  },
  outputs: {
    height: {
      noises: [
        { name: "plateau", type: "fbm", octaves: 3, frequency: 0.008, amplitude: 1.5, persistence: 0.5, lacunarity: 2.0 },
        { name: "carve", type: "ridged", octaves: 5, frequency: 0.025, amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
      ],
      steps: [
        { output: "plateauRaw", op: "sample", noise: "plateau" },
        { output: "plateauLevel", op: "offset", input: "plateauRaw", amount: 10 },
        { output: "carveRaw", op: "sample", noise: "carve" },
        { output: "carveNorm", op: "remap", input: "carveRaw", inMin: 0, inMax: 1.9375, outMin: 0, outMax: 1 },
        { output: "carveSharp", op: "power", input: "carveNorm", exponent: 3 },
        { output: "carveDepth", op: "scale", input: "carveSharp", factor: 9 },
        { output: "result", op: "subtract", a: "plateauLevel", b: "carveDepth" },
      ],
    },
  },
  borderType: "smooth",
  spawnWeight: 1,
};

/**
 * Clamps the noise distribution's tails before a low offset, squashing it into a mostly-flat
 * wetland - a different shape (flattened, not just short) than plains' full-range rolling hills.
 */
const swamp: BiomeDefinition = {
  id: "swamp",
  name: "Swamp",
  // Thresholds calibrated against sampled deep-interior height distribution: the swamp's own
  // detail noise is nearly flat (clamped to a narrow band), so almost all visible height
  // variation here comes from the shared bedrock macro layer, same as every biome - p10=5.7,
  // p50=7.5, p90=9.3.
  colors: {
    color0: new Color3(0.25, 0.22, 0.15),
    height0: 5,
    color1: new Color3(0.22, 0.32, 0.18),
    height1: 7,
    color2: new Color3(0.32, 0.4, 0.22),
    height2: 9,
    color3: new Color3(0.45, 0.48, 0.3),
    height3: 11,
    slopeThreshold: 0.6,
    slopeColor: new Color3(0.3, 0.28, 0.2),
  },
  outputs: {
    height: {
      noises: [{ name: "detail", type: "fbm", octaves: 3, frequency: 0.02, amplitude: 1.2, persistence: 0.35, lacunarity: 2.0 }],
      steps: [
        { output: "raw", op: "sample", noise: "detail" },
        { output: "flattened", op: "clamp", input: "raw", min: -0.4, max: 0.4 },
        { output: "result", op: "offset", input: "flattened", amount: 1.5 },
      ],
    },
  },
  borderType: "smooth",
  spawnWeight: 1,
};

export const BIOME_REGISTRY: BiomeDefinition[] = [plains, forest, hills, desert, mountains, tundra, canyon, swamp];
