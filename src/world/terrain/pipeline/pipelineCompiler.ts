import { deriveSeed } from "../../rng";
import { createTilingOctaveSampler, createWorldOctaveSampler, fbm, type Noise2D, type FbmParams } from "../noise";
import { ridgedNoise2D, billowNoise2D, worleyNoise2D, type OctaveNoiseParams } from "./noiseGenerators";
import type { NoiseSpec, PipelineDef, PipelineStep } from "./pipelineTypes";

/** A compiled pipeline samples world-space noise like a Noise2D, but can also pull in named
 *  external values (e.g. "height", "slope", a biome flag) via an optional context bag - used by
 *  material weight pipelines; height pipelines never pass one, so their behavior is unchanged. */
export type CompiledPipeline = (worldX: number, worldZ: number, context?: Record<string, number>) => number;

type StepFn = (worldX: number, worldZ: number, slots: Float64Array, context: Record<string, number> | undefined) => void;

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

function compileNoiseSpec(spec: NoiseSpec, rootSeed: number, namespace: string, tilePeriod: number | undefined): Noise2D {
  const seed = deriveNoiseSeed(rootSeed, namespace, spec.name);

  if (spec.type === "worley") {
    const sample = worleyNoise2D(seed, spec.frequency, tilePeriod);
    const amplitude = spec.amplitude;
    const mode = spec.mode;
    return (worldX: number, worldZ: number): number => {
      const { f1, f2 } = sample(worldX, worldZ);
      return (mode === "f1" ? f1 : f2 - f1) * amplitude;
    };
  }

  const octaveSampler = tilePeriod === undefined ? createWorldOctaveSampler(seed) : createTilingOctaveSampler(seed, tilePeriod);
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
      return ridgedNoise2D(octaveSampler, octaveParams);
    case "billow":
      return billowNoise2D(octaveSampler, octaveParams);
  }
}

/** Compiles one step into a closure writing its result into `slots[outSlot]`, with every input
 *  name pre-resolved to a slot index (or a direct noise-sampler reference) - no lookups at eval time. */
function compileStep(
  step: PipelineStep,
  slotIndex: Map<string, number>,
  noiseSamplers: Map<string, Noise2D>,
  outSlot: number,
  namespace: string,
): StepFn {
  const resolveSlot = (name: string): number => {
    const index = slotIndex.get(name);
    if (index === undefined) {
      throw new Error(`Pipeline "${namespace}" references unknown step/noise "${name}"`);
    }
    return index;
  };

  switch (step.op) {
    case "sample": {
      const noise2D = noiseSamplers.get(step.noise);
      if (!noise2D) {
        throw new Error(`Pipeline "${namespace}" references unknown step/noise "${step.noise}"`);
      }
      return (worldX, worldZ, slots): void => {
        slots[outSlot] = noise2D(worldX, worldZ);
      };
    }
    case "constant": {
      const value = step.value;
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = value;
      };
    }
    case "input": {
      const name = step.name;
      return (_worldX, _worldZ, slots, context): void => {
        slots[outSlot] = context?.[name] ?? 0;
      };
    }
    case "scale": {
      const inputSlot = resolveSlot(step.input);
      const factor = step.factor;
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = slots[inputSlot] * factor;
      };
    }
    case "offset": {
      const inputSlot = resolveSlot(step.input);
      const amount = step.amount;
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = slots[inputSlot] + amount;
      };
    }
    case "power": {
      const inputSlot = resolveSlot(step.input);
      const exponent = step.exponent;
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = Math.pow(slots[inputSlot], exponent);
      };
    }
    case "abs": {
      const inputSlot = resolveSlot(step.input);
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = Math.abs(slots[inputSlot]);
      };
    }
    case "invert": {
      const inputSlot = resolveSlot(step.input);
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = 1 - slots[inputSlot];
      };
    }
    case "clamp": {
      const inputSlot = resolveSlot(step.input);
      const { min, max } = step;
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = Math.min(max, Math.max(min, slots[inputSlot]));
      };
    }
    case "remap": {
      const inputSlot = resolveSlot(step.input);
      const { inMin, inMax, outMin, outMax } = step;
      return (_worldX, _worldZ, slots): void => {
        const t = (slots[inputSlot] - inMin) / (inMax - inMin);
        slots[outSlot] = outMin + t * (outMax - outMin);
      };
    }
    case "add": {
      const aSlot = resolveSlot(step.a);
      const bSlot = resolveSlot(step.b);
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = slots[aSlot] + slots[bSlot];
      };
    }
    case "subtract": {
      const aSlot = resolveSlot(step.a);
      const bSlot = resolveSlot(step.b);
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = slots[aSlot] - slots[bSlot];
      };
    }
    case "multiply": {
      const aSlot = resolveSlot(step.a);
      const bSlot = resolveSlot(step.b);
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = slots[aSlot] * slots[bSlot];
      };
    }
    case "max": {
      const aSlot = resolveSlot(step.a);
      const bSlot = resolveSlot(step.b);
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = Math.max(slots[aSlot], slots[bSlot]);
      };
    }
    case "min": {
      const aSlot = resolveSlot(step.a);
      const bSlot = resolveSlot(step.b);
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = Math.min(slots[aSlot], slots[bSlot]);
      };
    }
    case "lerp": {
      const aSlot = resolveSlot(step.a);
      const bSlot = resolveSlot(step.b);
      const t = step.t;
      return (_worldX, _worldZ, slots): void => {
        slots[outSlot] = slots[aSlot] + (slots[bSlot] - slots[aSlot]) * t;
      };
    }
  }
}

/**
 * Compiles a declarative PipelineDef into one closure, evaluated per-vertex. Noises are compiled
 * once via `fbm()`/ridged/billow loops; steps are compiled once into a flat array of closures
 * operating on a shared, pre-allocated scratch buffer indexed by step position - no per-sample
 * string/Map lookups on the hot path.
 *
 * `options.tilePeriod` makes every noise in the pipeline exactly periodic over that many input
 * units (see createTilingOctaveSampler in ../noise.ts). Only texture baking wants this - textures
 * are sampled over a fixed 256px tile that has to wrap without a seam - so height and
 * material-weight pipelines simply omit it and keep ordinary infinite-domain world-space noise.
 */
export function compilePipeline(def: PipelineDef, rootSeed: number, namespace: string, options?: { tilePeriod: number }): CompiledPipeline {
  const tilePeriod = options?.tilePeriod;
  const noiseSamplers = new Map<string, Noise2D>();
  for (const noiseSpec of def.noises) {
    noiseSamplers.set(noiseSpec.name, compileNoiseSpec(noiseSpec, rootSeed, namespace, tilePeriod));
  }

  if (def.steps.length === 0) {
    throw new Error(`Pipeline "${namespace}" has no steps`);
  }

  const slotIndex = new Map<string, number>();
  const stepFns: StepFn[] = def.steps.map((step, i) => {
    const fn = compileStep(step, slotIndex, noiseSamplers, i, namespace);
    slotIndex.set(step.output, i);
    return fn;
  });

  const slots = new Float64Array(stepFns.length);
  const lastSlot = stepFns.length - 1;

  return (worldX: number, worldZ: number, context?: Record<string, number>): number => {
    for (let i = 0; i < stepFns.length; i++) {
      stepFns[i](worldX, worldZ, slots, context);
    }
    return slots[lastSlot];
  };
}
