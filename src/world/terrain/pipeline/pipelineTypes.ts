interface BaseNoiseSpec {
  name: string;
  frequency: number;
  amplitude: number;
  octaves: number;
  persistence: number;
  lacunarity: number;
}

export interface FbmNoiseSpec extends BaseNoiseSpec {
  type: "fbm";
}

export interface RidgedNoiseSpec extends BaseNoiseSpec {
  type: "ridged";
}

export interface BillowNoiseSpec extends BaseNoiseSpec {
  type: "billow";
}

export type NoiseSpec = FbmNoiseSpec | RidgedNoiseSpec | BillowNoiseSpec;

export type PipelineStep =
  | { output: string; op: "sample"; noise: string }
  | { output: string; op: "constant"; value: number }
  | { output: string; op: "scale"; input: string; factor: number }
  | { output: string; op: "offset"; input: string; amount: number }
  | { output: string; op: "power"; input: string; exponent: number }
  | { output: string; op: "abs"; input: string }
  | { output: string; op: "invert"; input: string }
  | { output: string; op: "clamp"; input: string; min: number; max: number }
  | { output: string; op: "remap"; input: string; inMin: number; inMax: number; outMin: number; outMax: number }
  | { output: string; op: "add"; a: string; b: string }
  | { output: string; op: "subtract"; a: string; b: string }
  | { output: string; op: "multiply"; a: string; b: string }
  | { output: string; op: "lerp"; a: string; b: string; t: number };

/**
 * A named output recipe: sample one or more noises, then transform/combine them into a result.
 * Steps execute in array order; each may reference any earlier step's `output` name. The last
 * step's value is the pipeline's result - there is no separate "result" field.
 */
export interface PipelineDef {
  noises: NoiseSpec[];
  steps: PipelineStep[];
}
