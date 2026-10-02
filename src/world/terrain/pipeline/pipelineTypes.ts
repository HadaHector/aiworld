interface BaseNoiseSpec {
  name: string;
  /** Noises with the same `shared` name are one noise, whichever graph samples them - so two
   *  material rules can fray along the same edge. Without it every graph's noises are its own. */
  shared?: string;
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
  /** How rounded each crest is, 0 (a knife edge, the default) and up - see ridgedNoise2D. */
  crest?: number;
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
 * "cell" is a random 0-1 value of the nearest point's own - constant across each cell. Sampled
 * from the same noise as the "f1" or "edge" it goes with (see the `sample` step's `mode`), it gives
 * every stone, plate or cobble those outline a shade or size of its own.
 */
export interface WorleyNoiseSpec {
  name: string;
  /** As BaseNoiseSpec.shared. */
  shared?: string;
  type: "worley";
  frequency: number;
  amplitude: number;
  mode: WorleyMode;
  /** As BaseNoiseSpec.stretch. */
  stretch?: [number, number];
  /** How far, in cells, a noise at the cells' own scale moves each lookup - bends every side, so the
   *  cells stop looking ruled. 0.2 is organic; much past 0.4 they fray. */
  warp?: number;
  /** 0-0.5: how much each point's distances are scaled by a weight of its own, so neighbouring
   *  cells differ in size and the borders between them curve. */
  sizeJitter?: number;
  /** In cells: the width over which "edge" blends the borders where they meet, so a stone cut from
   *  it has rounded corners rather than points. 0.12 rounds them; past 0.25 stones pinch and merge. */
  round?: number;
}

/**
 * Parallel bands: a periodic wave running along `frequency` (cycles per unit along x and along y),
 * so the crests are straight lines at right angles to it - `[0, f]` gives horizontal stripes, `[f, f]`
 * diagonal ones. -1..1 times `amplitude`, with a phase picked by the seed. On its own it is a ruler;
 * sampled with an `offset` warp it becomes wood grain, sand ripples or marble veins.
 *
 * `shape` is the profile across one band: "sine" is smooth, "triangle" has sharp crests and troughs
 * with straight flanks, "saw" climbs slowly and drops at once (a ripple's gentle windward and steep
 * lee side).
 */
export interface WaveNoiseSpec {
  name: string;
  /** As BaseNoiseSpec.shared. */
  shared?: string;
  type: "wave";
  frequency: [number, number];
  amplitude: number;
  shape: WaveShape;
}

export type WaveShape = "sine" | "triangle" | "saw";

export type WorleyMode = "f1" | "edge" | "cell";

export type NoiseSpec = FbmNoiseSpec | RidgedNoiseSpec | BillowNoiseSpec | WorleyNoiseSpec | WaveNoiseSpec;

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
   * Worley cracks become wandering fissures and round blobs become swirls. `mode` reads a worley
   * noise another way than its own - the same points - so one noise can outline stones ("f1") and
   * shade each of them ("cell").
   */
  | { output: string; op: "sample"; noise: string; offset?: [string, string]; mode?: WorleyMode }
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
  /** sin(2π · input · cycles): turns any signal into repeating bands, -1..1. On a noise, the bands
   *  follow its contours (agate, marble, strata); `cycles` is bands per unit of input. */
  | { output: string; op: "sin"; input: string; cycles: number }
  | { output: string; op: "clamp"; input: string; min: number; max: number }
  /** Steps: the input snapped to a staircase `step` apart, each step a level tread and then a rise
   *  over its last `riser` share (0-1, eased) - so a slope made of it is ledges and short drops, the
   *  smaller `riser` the sheerer the drops. On a height, rock benches and terraces. */
  | { output: string; op: "terrace"; input: string; step: number; riser: number }
  | { output: string; op: "remap"; input: string; inMin: number; inMax: number; outMin: number; outMax: number }
  /** Color -> scalar (Rec. 709 luma), so a color can drive a scalar signal such as height. */
  | { output: string; op: "luminance"; input: string }
  // --- binary, color if either operand is color ---
  | { output: string; op: "add"; a: string; b: string }
  | { output: string; op: "subtract"; a: string; b: string }
  | { output: string; op: "multiply"; a: string; b: string }
  | { output: string; op: "max"; a: string; b: string }
  | { output: string; op: "min"; a: string; b: string }
  /** `max`/`min` with the corner rounded over a width of `k`: the two meet in a smooth fillet
   *  rather than a crease. On a height, `smoothMax` with a level is a flat floor the hillsides ease
   *  down onto - a valley plain - and `smoothMin` a plateau they ease up to. */
  | { output: string; op: "smoothMax"; a: string; b: string; k: number }
  | { output: string; op: "smoothMin"; a: string; b: string; k: number }
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
