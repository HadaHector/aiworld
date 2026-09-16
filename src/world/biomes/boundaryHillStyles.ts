import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";

export interface BoundaryHillStyle {
  id: string;
  name: string;
  heightPipeline: PipelineDef;
}

// Sharp crest lines - the same ridged primitive canyon's carve uses, reused additively instead of
// subtractively. Wavelength widened well past BOUNDARY_HILL_WIDTH (20m -> 167m) and persistence
// dropped (0.5 -> 0.4) so this reads as one flowing ridge crest, not a field of competing spikes -
// the exact same peak-spacing lesson learned tuning the mountains/hills/canyon biomes earlier.
const jaggedRidge: BoundaryHillStyle = {
  id: "jagged-ridge",
  name: "Jagged Ridge",
  heightPipeline: {
    noises: [{ name: "ridge", type: "ridged", octaves: 4, frequency: 0.003, amplitude: 1, persistence: 0.15, lacunarity: 2.0 }],
    steps: [
      { output: "raw", op: "sample", noise: "ridge" },
      { output: "result", op: "scale", input: "raw", factor: 17 },
    ],
  },
};

// Soft rolling bumps, wider wavelength than the ridged style.
const rollingFbm: BoundaryHillStyle = {
  id: "rolling-fbm",
  name: "Rolling Fbm",
  heightPipeline: {
    noises: [{ name: "roll", type: "fbm", octaves: 3, frequency: 0.008, amplitude: 7, persistence: 0.4, lacunarity: 2.0 }],
    steps: [
      { output: "raw", op: "sample", noise: "roll" },
      { output: "result", op: "offset", input: "raw", amount: 6 },
    ],
  },
};

// Puffy rounded bumps.
const roundedBillow: BoundaryHillStyle = {
  id: "rounded-billow",
  name: "Rounded Billow",
  heightPipeline: {
    noises: [{ name: "puff", type: "billow", octaves: 3, frequency: 0.007, amplitude: 6, persistence: 0.4, lacunarity: 2.0 }],
    steps: [
      { output: "raw", op: "sample", noise: "puff" },
      { output: "result", op: "offset", input: "raw", amount: 8 },
    ],
  },
};

// Broad rolling base with gentler, wider spikes added on top - canyon's multi-noise technique,
// additive instead of subtractive.
const jaggedCrumple: BoundaryHillStyle = {
  id: "jagged-crumple",
  name: "Jagged Crumple",
  heightPipeline: {
    noises: [
      { name: "base", type: "fbm", octaves: 3, frequency: 0.006, amplitude: 7, persistence: 0.35, lacunarity: 2.0 },
      { name: "spike", type: "ridged", octaves: 3, frequency: 0.015, amplitude: 1, persistence: 0.4, lacunarity: 2.0 },
    ],
    steps: [
      { output: "baseRaw", op: "sample", noise: "base" },
      { output: "baseLevel", op: "offset", input: "baseRaw", amount: 8 },
      { output: "spikeRaw", op: "sample", noise: "spike" },
      { output: "spikeScaled", op: "scale", input: "spikeRaw", factor: 7 },
      { output: "result", op: "add", a: "baseLevel", b: "spikeScaled" },
    ],
  },
};

export const BOUNDARY_HILL_STYLES: BoundaryHillStyle[] = [jaggedRidge, rollingFbm, roundedBillow, jaggedCrumple];