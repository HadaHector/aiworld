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

/**
 * Cellular/Worley noise: scatters one jittered point per grid cell (cell size = 1/frequency) and,
 * for a query position, finds the distance to the nearest ("f1") and second-nearest ("f2") point.
 * "f1" is near 0 at each point and grows outward - reads as rounded, grain/pebble/cell-like blobs,
 * a genuinely different shape than fbm's soft all-over mottle or ridged/billow's folded-sum crests.
 * "edge" (f2-f1) is near 0 exactly along the boundary between two cells and grows away from it -
 * a natural, irregular crack/fracture network with no directional bias, unlike ridged noise's
 * creases (which follow the underlying gradient field and end up looking like directional waves,
 * not the polygonal fracture patterns real cracked ground/rock actually shows).
 */
export interface WorleyNoiseSpec {
  name: string;
  type: "worley";
  frequency: number;
  amplitude: number;
  mode: "f1" | "edge";
}

export type NoiseSpec = FbmNoiseSpec | RidgedNoiseSpec | BillowNoiseSpec | WorleyNoiseSpec;

export type PipelineStep =
  | { output: string; op: "sample"; noise: string }
  | { output: string; op: "constant"; value: number }
  | { output: string; op: "input"; name: string } // reads a named value from an external context bag, 0 if absent
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
  | { output: string; op: "max"; a: string; b: string }
  | { output: string; op: "min"; a: string; b: string }
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
