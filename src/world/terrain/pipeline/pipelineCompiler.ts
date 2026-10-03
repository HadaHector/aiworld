import { deriveSeed } from "../../rng";
import { createTilingOctaveSampler, createWorldOctaveSampler, fbm, type Noise2D, type FbmParams } from "../noise";
import { ridgedNoise2D, billowNoise2D, worleyNoise2D, type OctaveNoiseParams } from "./noiseGenerators";
import type { BricksNoiseSpec, CellMode, NoiseSpec, PipelineDef, PipelineStep, ValueType, WaveShape } from "./pipelineTypes";

/** A compiled single-result pipeline samples world-space noise like a Noise2D, but can also pull in
 *  named external values (e.g. "height", "slope", a biome flag) via an optional context bag - used
 *  by material weight pipelines; height pipelines never pass one, so their behavior is unchanged. */
export type CompiledPipeline = (worldX: number, worldZ: number, context?: Record<string, number>) => number;

/** Where one step's value lives in the shared scratch buffer, and how wide it is. A scalar occupies
 *  one float; a color occupies three consecutive ones. */
export interface SlotRef {
  offset: number;
  type: ValueType;
}

/** A compiled multi-output pipeline. `run` evaluates every step into `slots`; callers then read
 *  whichever named outputs they want straight out of `slots` at the offsets `output` resolved at
 *  compile time - no per-sample allocation, lookup, or copying. */
export interface CompiledOutputs {
  slots: Float64Array;
  run: (x: number, y: number, context?: Record<string, number>) => void;
  output: (name: string) => SlotRef | undefined;
}

type StepFn = (x: number, y: number, slots: Float64Array, context: Record<string, number> | undefined) => void;

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function deriveNoiseSeed(rootSeed: number, namespace: string, noiseName: string): number {
  return deriveSeed(deriveSeed(rootSeed, hashString(namespace)), hashString(noiseName));
}

/** One period of each wave shape, over 0..1, returning -1..1. */
const WAVE_PROFILES: Record<Exclude<WaveShape, "triangle">, (t: number) => number> = {
  sine: (t) => Math.sin(t * 2 * Math.PI),
  saw: (t) => 2 * t - 1,
};

/**
 * One period of a triangle wave over 0..1, -1..1: climbing for the first `rise` of it to its crest,
 * falling for the rest - and with its crest and trough each rounded off over a share of the period
 * (a polynomial smooth min of the two flanks, sized so the fillet spans that share). The trough sits
 * at 0 (and 1), the crest at `rise`; at 0.5 and no rounding it is the plain symmetric triangle.
 */
function triangleProfile(rise: number, crest: number, trough: number): (t: number) => number {
  const up = 2 / rise;
  const down = 2 / (1 - rise);
  // In value units: the two flanks part by (up + down) per unit of t, so k spans `share` of a period.
  const crestK = (crest * (up + down)) / 2;
  const troughK = (trough * (up + down)) / 2;
  const smoothMin = (a: number, b: number, k: number): number => {
    if (k <= 0) return Math.min(a, b);
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - (h * h * k) / 4;
  };
  return (t) => {
    const climbing = -1 + up * t;
    const falling = 1 - down * (t - rise);
    const sharp = Math.min(climbing, falling);
    if (sharp >= 0) return smoothMin(climbing, falling, crestK);
    // About the trough: measured from it, the flank falling into it from the left, the one rising out.
    const s = t < rise ? t : t - 1;
    return -smoothMin(1 + down * s, 1 - up * s, troughK);
  };
}

/** A `bricks` noise. Over a tiling texture the courses and the cells along them wrap with it, so a
 *  brick cut by the tile's edge is the same brick, with the same random value, on the other side. */
function bricksNoise(spec: BricksNoiseSpec, seed: number, tilePeriod: number | undefined): Noise2D {
  const { columns, rows, stagger, amplitude, mode } = spec;
  const rowsPerTile = tilePeriod === undefined ? 0 : Math.round(rows * tilePeriod);
  const columnsPerTile = tilePeriod === undefined ? 0 : Math.round(columns * tilePeriod);
  const wrap = (value: number, count: number): number => (count > 0 ? ((value % count) + count) % count : value);
  return (x: number, y: number): number => {
    const course = y * rows;
    const row = Math.floor(course);
    const v = course - row;
    const along = x * columns + row * stagger;
    const column = Math.floor(along);
    const u = along - column;
    switch (mode) {
      case "u":
        return u * amplitude;
      case "v":
        return v * amplitude;
      case "edge": {
        // In rows: across a course its own height, along it the cell's length over the row height.
        const acrossJoint = Math.min(v, 1 - v);
        const alongJoint = (Math.min(u, 1 - u) * rows) / columns;
        return Math.min(acrossJoint, alongJoint) * amplitude;
      }
      case "cell": {
        let h = Math.imul(wrap(row, rowsPerTile) | 0, 0x27d4eb2d) ^ Math.imul(wrap(column, columnsPerTile) | 0, 0x165667b1) ^ seed;
        h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
        h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
        return (((h ^ (h >>> 15)) >>> 0) / 0x100000000) * amplitude;
      }
    }
  };
}

function compileNoiseSpec(spec: NoiseSpec, rootSeed: number, namespace: string, tilePeriod: number | undefined): Noise2D {
  const seed = spec.shared !== undefined ? deriveNoiseSeed(rootSeed, "shared", spec.shared) : deriveNoiseSeed(rootSeed, namespace, spec.name);

  if (spec.type === "bricks") return bricksNoise(spec, seed, tilePeriod);

  if (spec.type === "wave") {
    const [frequencyX, frequencyY] = spec.frequency;
    const amplitude = spec.amplitude;
    // The seed only picks where along its period the wave starts.
    const phase = (seed >>> 0) / 0x100000000;
    const profile = spec.shape === "triangle" ? triangleProfile(spec.rise, spec.crest, spec.trough) : WAVE_PROFILES[spec.shape];
    return (worldX: number, worldZ: number): number => {
      const t = worldX * frequencyX + worldZ * frequencyY + phase;
      return profile(t - Math.floor(t)) * amplitude;
    };
  }

  if (spec.type === "worley") {
    const sample = worleyNoise2D(seed, spec.frequency, tilePeriod, spec.stretch?.[0], spec.stretch?.[1], spec);
    const amplitude = spec.amplitude;
    const mode = spec.mode;
    return (worldX: number, worldZ: number): number => {
      const { f1, f2, id } = sample(worldX, worldZ);
      return (mode === "f1" ? f1 : mode === "edge" ? f2 - f1 : id) * amplitude;
    };
  }

  const [stretchX, stretchY] = spec.stretch ?? [1, 1];
  const octaveSampler =
    tilePeriod === undefined ? createWorldOctaveSampler(seed, stretchX, stretchY) : createTilingOctaveSampler(seed, tilePeriod, stretchX, stretchY);
  const octaveParams: OctaveNoiseParams = {
    octaves: spec.octaves,
    baseFrequency: spec.frequency,
    baseAmplitude: spec.amplitude,
    persistence: spec.persistence,
    lacunarity: spec.lacunarity,
  };

  switch (spec.type) {
    case "fbm": {
      const fbmParams: FbmParams = { ...octaveParams, offset: 0 };
      return (worldX: number, worldZ: number): number => fbm(octaveSampler, worldX, worldZ, fbmParams);
    }
    case "ridged":
      return ridgedNoise2D(octaveSampler, octaveParams, spec.crest ?? 0);
    case "billow":
      return billowNoise2D(octaveSampler, octaveParams);
  }
}

/** Applies `f` component-wise. A unary op always preserves its input's type, so input and output
 *  are the same width and the scalar case stays a single read/write. */
function unaryFn(input: SlotRef, out: SlotRef, f: (value: number) => number): StepFn {
  const i = input.offset;
  const o = out.offset;
  if (out.type === "scalar") {
    return (_x, _y, slots): void => {
      slots[o] = f(slots[i]);
    };
  }
  return (_x, _y, slots): void => {
    slots[o] = f(slots[i]);
    slots[o + 1] = f(slots[i + 1]);
    slots[o + 2] = f(slots[i + 2]);
  };
}

/** Applies `f` component-wise across two operands. A scalar operand gets stride 0, so every channel
 *  re-reads its single float - which is exactly the broadcast rule (`color * scalar`) with no
 *  branching left on the hot path. */
function binaryFn(a: SlotRef, b: SlotRef, out: SlotRef, f: (a: number, b: number) => number): StepFn {
  const ao = a.offset;
  const bo = b.offset;
  const o = out.offset;
  if (out.type === "scalar") {
    return (_x, _y, slots): void => {
      slots[o] = f(slots[ao], slots[bo]);
    };
  }
  const aStride = a.type === "color" ? 1 : 0;
  const bStride = b.type === "color" ? 1 : 0;
  return (_x, _y, slots): void => {
    slots[o] = f(slots[ao], slots[bo]);
    slots[o + 1] = f(slots[ao + aStride], slots[bo + bStride]);
    slots[o + 2] = f(slots[ao + aStride * 2], slots[bo + bStride * 2]);
  };
}

/** Result type of a binary op: color as soon as either side is, matching GLSL/Blender. */
function combineType(a: SlotRef, b: SlotRef): ValueType {
  return a.type === "color" || b.type === "color" ? "color" : "scalar";
}

function resultTypeOf(step: PipelineStep, resolve: (name: string) => SlotRef): ValueType {
  switch (step.op) {
    case "sample":
    case "constant":
    case "input":
    case "luminance":
      return "scalar";
    case "color":
    case "colorRamp":
      return "color";
    case "scale":
    case "offset":
    case "power":
    case "abs":
    case "invert":
    case "sin":
    case "clamp":
    case "remap":
    case "terrace":
      return resolve(step.input).type;
    case "add":
    case "subtract":
    case "multiply":
    case "max":
    case "min":
    case "smoothMax":
    case "smoothMin":
    case "lerp":
    case "mix":
      return combineType(resolve(step.a), resolve(step.b));
  }
}

/** Compiles one step into a closure writing its result into the slot range at `out`, with every
 *  input name pre-resolved to a slot offset (or a direct noise-sampler reference) - no lookups at
 *  eval time. */
function compileStep(
  step: PipelineStep,
  resolve: (name: string) => SlotRef,
  noiseFor: (name: string, mode?: CellMode) => Noise2D | undefined,
  out: SlotRef,
  namespace: string,
): StepFn {
  const o = out.offset;

  switch (step.op) {
    case "sample": {
      const noise2D = noiseFor(step.noise, step.mode);
      if (!noise2D) {
        throw new Error(
          step.mode
            ? `Pipeline "${namespace}" reads "${step.noise}" as ${step.mode}, which it cannot be read as`
            : `Pipeline "${namespace}" references unknown step/noise "${step.noise}"`,
        );
      }
      if (!step.offset) {
        return (x, y, slots): void => {
          slots[o] = noise2D(x, y);
        };
      }
      const offsetX = resolve(step.offset[0]);
      const offsetY = resolve(step.offset[1]);
      if (offsetX.type !== "scalar" || offsetY.type !== "scalar") {
        throw new Error(`Pipeline "${namespace}" warps "${step.noise}" by a colour; an offset has to be a number`);
      }
      const ox = offsetX.offset;
      const oy = offsetY.offset;
      return (x, y, slots): void => {
        slots[o] = noise2D(x + slots[ox], y + slots[oy]);
      };
    }
    case "constant": {
      const value = step.value;
      return (_x, _y, slots): void => {
        slots[o] = value;
      };
    }
    case "input": {
      const name = step.name;
      return (_x, _y, slots, context): void => {
        slots[o] = context?.[name] ?? 0;
      };
    }
    case "color": {
      const [r, g, b] = step.value;
      return (_x, _y, slots): void => {
        slots[o] = r;
        slots[o + 1] = g;
        slots[o + 2] = b;
      };
    }
    case "colorRamp": {
      const input = resolve(step.input);
      if (input.type !== "scalar") {
        throw new Error(`Pipeline "${namespace}" step "${step.output}": colorRamp needs a scalar input, got a color`);
      }
      const stops = step.stops;
      if (stops.length === 0) {
        throw new Error(`Pipeline "${namespace}" step "${step.output}": colorRamp needs at least one stop`);
      }
      for (let i = 1; i < stops.length; i++) {
        if (stops[i].at < stops[i - 1].at) {
          throw new Error(`Pipeline "${namespace}" step "${step.output}": colorRamp stops must be sorted by "at" ascending`);
        }
      }
      const positions = Float64Array.from(stops.map((stop) => stop.at));
      const colors = Float64Array.from(stops.flatMap((stop) => stop.color));
      const last = stops.length - 1;
      const i = input.offset;
      return (_x, _y, slots): void => {
        const value = slots[i];
        // Held constant outside the ends, linearly interpolated between neighbouring stops.
        if (value <= positions[0]) {
          slots[o] = colors[0];
          slots[o + 1] = colors[1];
          slots[o + 2] = colors[2];
          return;
        }
        if (value >= positions[last]) {
          slots[o] = colors[last * 3];
          slots[o + 1] = colors[last * 3 + 1];
          slots[o + 2] = colors[last * 3 + 2];
          return;
        }
        let hi = 1;
        while (hi < last && positions[hi] < value) hi++;
        const lo = hi - 1;
        const span = positions[hi] - positions[lo];
        const t = span === 0 ? 0 : (value - positions[lo]) / span;
        slots[o] = colors[lo * 3] + (colors[hi * 3] - colors[lo * 3]) * t;
        slots[o + 1] = colors[lo * 3 + 1] + (colors[hi * 3 + 1] - colors[lo * 3 + 1]) * t;
        slots[o + 2] = colors[lo * 3 + 2] + (colors[hi * 3 + 2] - colors[lo * 3 + 2]) * t;
      };
    }
    case "luminance": {
      const input = resolve(step.input);
      if (input.type !== "color") {
        throw new Error(`Pipeline "${namespace}" step "${step.output}": luminance needs a color input, got a scalar`);
      }
      const i = input.offset;
      return (_x, _y, slots): void => {
        slots[o] = 0.2126 * slots[i] + 0.7152 * slots[i + 1] + 0.0722 * slots[i + 2];
      };
    }
    case "scale": {
      const factor = step.factor;
      return unaryFn(resolve(step.input), out, (value) => value * factor);
    }
    case "offset": {
      const amount = step.amount;
      return unaryFn(resolve(step.input), out, (value) => value + amount);
    }
    case "power": {
      const exponent = step.exponent;
      return unaryFn(resolve(step.input), out, (value) => Math.pow(value, exponent));
    }
    case "abs":
      return unaryFn(resolve(step.input), out, Math.abs);
    case "invert":
      return unaryFn(resolve(step.input), out, (value) => 1 - value);
    case "sin": {
      const angular = step.cycles * 2 * Math.PI;
      return unaryFn(resolve(step.input), out, (value) => Math.sin(value * angular));
    }
    case "clamp": {
      const { min, max } = step;
      return unaryFn(resolve(step.input), out, (value) => Math.min(max, Math.max(min, value)));
    }
    case "terrace": {
      const size = step.step;
      const riser = Math.min(1, Math.max(1e-3, step.riser));
      return unaryFn(resolve(step.input), out, (value) => {
        const u = value / size;
        const level = Math.floor(u);
        const t = Math.min(1, Math.max(0, (u - level - (1 - riser)) / riser));
        return (level + t * t * (3 - 2 * t)) * size;
      });
    }
    case "remap": {
      const { inMin, inMax, outMin, outMax } = step;
      return unaryFn(resolve(step.input), out, (value) => {
        const t = (value - inMin) / (inMax - inMin);
        return outMin + t * (outMax - outMin);
      });
    }
    case "add":
      return binaryFn(resolve(step.a), resolve(step.b), out, (a, b) => a + b);
    case "subtract":
      return binaryFn(resolve(step.a), resolve(step.b), out, (a, b) => a - b);
    case "multiply":
      return binaryFn(resolve(step.a), resolve(step.b), out, (a, b) => a * b);
    case "max":
      return binaryFn(resolve(step.a), resolve(step.b), out, Math.max);
    case "min":
      return binaryFn(resolve(step.a), resolve(step.b), out, Math.min);
    case "smoothMax":
    case "smoothMin": {
      // The polynomial smooth minimum; the maximum is its mirror.
      const k = Math.max(1e-6, step.k);
      const sign = step.op === "smoothMax" ? -1 : 1;
      return binaryFn(resolve(step.a), resolve(step.b), out, (a, b) => {
        const x = a * sign;
        const y = b * sign;
        const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (y - x)) / k));
        return (y + (x - y) * h - k * h * (1 - h)) * sign;
      });
    }
    case "lerp": {
      const t = step.t;
      return binaryFn(resolve(step.a), resolve(step.b), out, (a, b) => a + (b - a) * t);
    }
    case "mix": {
      const a = resolve(step.a);
      const b = resolve(step.b);
      const tSlot = resolve(step.t);
      if (tSlot.type !== "scalar") {
        throw new Error(`Pipeline "${namespace}" step "${step.output}": mix needs a scalar blend factor, got a color`);
      }
      const ao = a.offset;
      const bo = b.offset;
      const ti = tSlot.offset;
      if (out.type === "scalar") {
        return (_x, _y, slots): void => {
          const t = Math.min(1, Math.max(0, slots[ti]));
          slots[o] = slots[ao] + (slots[bo] - slots[ao]) * t;
        };
      }
      const aStride = a.type === "color" ? 1 : 0;
      const bStride = b.type === "color" ? 1 : 0;
      return (_x, _y, slots): void => {
        const t = Math.min(1, Math.max(0, slots[ti]));
        for (let c = 0; c < 3; c++) {
          const av = slots[ao + aStride * c];
          const bv = slots[bo + bStride * c];
          slots[o + c] = av + (bv - av) * t;
        }
      };
    }
  }
}

interface CompiledGraph {
  stepFns: StepFn[];
  slots: Float64Array;
  slotOf: Map<string, SlotRef>;
  lastSlot: SlotRef;
}

function compileGraph(def: PipelineDef, rootSeed: number, namespace: string, tilePeriod: number | undefined): CompiledGraph {
  const noiseSamplers = new Map<string, Noise2D>();
  for (const noiseSpec of def.noises) {
    noiseSamplers.set(noiseSpec.name, compileNoiseSpec(noiseSpec, rootSeed, namespace, tilePeriod));
  }
  const noiseSpecs = new Map(def.noises.map((spec) => [spec.name, spec]));
  const noiseFor = (name: string, mode?: CellMode): Noise2D | undefined => {
    const spec = noiseSpecs.get(name);
    if (!spec || !mode) return noiseSamplers.get(name);
    if ((spec.type === "worley" || spec.type === "bricks") && mode === spec.mode) return noiseSamplers.get(name);
    if (spec.type === "worley" && (mode === "f1" || mode === "edge" || mode === "cell")) return compileNoiseSpec({ ...spec, mode }, rootSeed, namespace, tilePeriod);
    if (spec.type === "bricks" && mode !== "f1") return compileNoiseSpec({ ...spec, mode }, rootSeed, namespace, tilePeriod);
    return undefined;
  };

  if (def.steps.length === 0) {
    throw new Error(`Pipeline "${namespace}" has no steps`);
  }

  const slotOf = new Map<string, SlotRef>();
  // Only steps compiled so far are registered, so a forward or misspelled reference fails here at
  // compile time rather than silently reading an unrelated slot.
  const resolve = (name: string): SlotRef => {
    const ref = slotOf.get(name);
    if (ref === undefined) {
      throw new Error(`Pipeline "${namespace}" references unknown step/noise "${name}"`);
    }
    return ref;
  };

  const stepFns: StepFn[] = [];
  let width = 0;
  let lastSlot: SlotRef = { offset: 0, type: "scalar" };
  for (const step of def.steps) {
    const out: SlotRef = { offset: width, type: resultTypeOf(step, resolve) };
    width += out.type === "color" ? 3 : 1;
    stepFns.push(compileStep(step, resolve, noiseFor, out, namespace));
    slotOf.set(step.output, out);
    lastSlot = out;
  }

  return { stepFns, slots: new Float64Array(width), slotOf, lastSlot };
}

/**
 * Compiles a declarative PipelineDef into one closure, evaluated per-vertex. Noises are compiled
 * once via `fbm()`/ridged/billow loops; steps are compiled once into a flat array of closures
 * operating on a shared, pre-allocated scratch buffer indexed by slot offset - no per-sample
 * string/Map lookups on the hot path.
 *
 * This is the single-result form: the last step's value is the result. Every world-space pipeline
 * (biome height, material weight, boundary hill style) uses it. See compileOutputs for the
 * multi-output form material textures use.
 *
 * `options.tilePeriod` makes every noise in the pipeline exactly periodic over that many input
 * units (see createTilingOctaveSampler in ../noise.ts) - only texture baking wants this.
 */
export function compilePipeline(def: PipelineDef, rootSeed: number, namespace: string, options?: { tilePeriod: number }): CompiledPipeline {
  const { stepFns, slots, lastSlot } = compileGraph(def, rootSeed, namespace, options?.tilePeriod);
  if (lastSlot.type !== "scalar") {
    throw new Error(`Pipeline "${namespace}" is a single-result pipeline, so its last step must be a scalar, not a color`);
  }
  const resultOffset = lastSlot.offset;

  return (worldX: number, worldZ: number, context?: Record<string, number>): number => {
    for (let i = 0; i < stepFns.length; i++) {
      stepFns[i](worldX, worldZ, slots, context);
    }
    return slots[resultOffset];
  };
}

/**
 * Compiles a PipelineDef that declares named `outputs` - one graph producing several keyed results
 * (a material texture's `diffuse`/`roughness`/`height`) rather than a single value. An intermediate
 * step feeding two outputs is therefore evaluated once per sample, not once per output.
 */
export function compileOutputs(def: PipelineDef, rootSeed: number, namespace: string, options?: { tilePeriod: number }): CompiledOutputs {
  const { stepFns, slots, slotOf } = compileGraph(def, rootSeed, namespace, options?.tilePeriod);

  const outputs = new Map<string, SlotRef>();
  for (const [name, stepName] of Object.entries(def.outputs ?? {})) {
    const ref = slotOf.get(stepName);
    if (ref === undefined) {
      throw new Error(`Pipeline "${namespace}" output "${name}" names unknown step "${stepName}"`);
    }
    outputs.set(name, ref);
  }

  const run = (x: number, y: number, context?: Record<string, number>): void => {
    for (let i = 0; i < stepFns.length; i++) {
      stepFns[i](x, y, slots, context);
    }
  };

  return { slots, run, output: (name: string) => outputs.get(name) };
}
