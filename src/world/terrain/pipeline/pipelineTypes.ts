interface BaseNoiseSpec {
  name: string;
  frequency: number;
  amplitude: number;
  octaves: number;
  persistence: number;
  lacunarity: number;
  /** Stretches the noise's features by these factors along x and y - [1, 4] makes them four times
   *  taller than wide (bark fissures, wood grain, streaks). A tiling texture still tiles. */
  stretch?: [number, number];
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
  /** As BaseNoiseSpec.stretch. */
  stretch?: [number, number];
}

export type NoiseSpec = FbmNoiseSpec | RidgedNoiseSpec | BillowNoiseSpec | WorleyNoiseSpec;

/**
 * What a step carries. Inferred per step when the pipeline compiles (never declared by hand), so a
 * scalar-only pipeline - every world-space height and material-weight pipeline - still occupies one
 * float per step exactly as before colors existed, and only genuinely-color steps pay for three.
 */
export type ValueType = "scalar" | "color";

/** Linear RGB, 0..1 per channel. A plain tuple rather than Babylon's Color3 so this module stays
 *  free of engine imports; material definitions keep authoring in Color3 and spread into these. */
export type ColorTuple = [number, number, number];

/** One stop of a `colorRamp`. `at` positions it along the ramp's input range. */
export interface ColorRampStop {
  at: number;
  color: ColorTuple;
}

/**
 * Steps are the pipeline's operations. Most are type-polymorphic: a color input is processed
 * component-wise and a binary op mixing a color with a scalar broadcasts the scalar across all
 * three channels (the same rule GLSL and Blender use), so `multiply(someColor, someNoise)` needs no
 * special case. `sample`/`constant`/`input` are inherently scalar - `colorRamp` and `mix` are how a
 * scalar signal becomes color, and `luminance` is how a color becomes a scalar again.
 */
export type PipelineStep =
  // --- scalar sources ---
  /**
   * Samples a noise at this point - or, with `offset`, at this point moved by the values of two
   * earlier scalar steps (in the pipeline's own input units: world units, or texture pixels). That
   * is domain warping: offsetting by another noise bends the first one's features, so straight
   * Worley cracks become wandering fissures and round blobs become swirls.
   */
  | { output: string; op: "sample"; noise: string; offset?: [string, string] }
  | { output: string; op: "constant"; value: number }
  | { output: string; op: "input"; name: string } // reads a named value from an external context bag, 0 if absent
  // --- color sources ---
  | { output: string; op: "color"; value: ColorTuple }
  /**
   * Maps a scalar through sorted color stops, linearly interpolated between them and held constant
   * outside the first/last - Blender's ColorRamp, Substance Designer's gradient map. This is the
   * op that lets one noise drive a whole palette instead of a single flat tint.
   */
  | { output: string; op: "colorRamp"; input: string; stops: ColorRampStop[] }
  // --- unary, preserves the input's type ---
  | { output: string; op: "scale"; input: string; factor: number }
  | { output: string; op: "offset"; input: string; amount: number }
  | { output: string; op: "power"; input: string; exponent: number }
  | { output: string; op: "abs"; input: string }
  | { output: string; op: "invert"; input: string }
  | { output: string; op: "clamp"; input: string; min: number; max: number }
  | { output: string; op: "remap"; input: string; inMin: number; inMax: number; outMin: number; outMax: number }
  /** Color -> scalar (Rec. 709 luma), so a color can drive a scalar signal such as height. */
  | { output: string; op: "luminance"; input: string }
  // --- binary, color if either operand is color ---
  | { output: string; op: "add"; a: string; b: string }
  | { output: string; op: "subtract"; a: string; b: string }
  | { output: string; op: "multiply"; a: string; b: string }
  | { output: string; op: "max"; a: string; b: string }
  | { output: string; op: "min"; a: string; b: string }
  | { output: string; op: "lerp"; a: string; b: string; t: number }
  /** Like `lerp`, but blends by a *computed* factor (another step, clamped 0..1) instead of a fixed
   *  number - the everyday way one noise decides how much of two signals to show. */
  | { output: string; op: "mix"; a: string; b: string; t: string };

/**
 * A named output recipe: sample one or more noises, then transform/combine them into a result.
 * Steps execute in array order; each may reference any earlier step's `output` name.
 *
 * With `outputs` omitted the pipeline has a single result: the last step's value. That is what
 * every world-space pipeline (biome height, material weight, boundary hill style) uses, and its
 * behaviour is unchanged by the existence of named outputs.
 *
 * With `outputs` set, each keyword maps to the name of the step producing it - how a material's
 * texture declares its `diffuse`, `roughness` and `height` from one shared graph (see TextureDef).
 */
export interface PipelineDef {
  noises: NoiseSpec[];
  steps: PipelineStep[];
  outputs?: Record<string, string>;
}
