import { deriveSeed } from "../../rng";
import { createBaseNoise2D, fbm, type Noise2D, type FbmParams } from "../noise";
import { ridgedNoise2D, billowNoise2D, type OctaveNoiseParams } from "./noiseGenerators";
import type { NoiseSpec, PipelineDef, PipelineStep } from "./pipelineTypes";

/** A compiled pipeline is just a fancier Noise2D - same shape, arbitrary internal machinery. */
export type CompiledPipeline = Noise2D;

type StepFn = (worldX: number, worldZ: number, slots: Float64Array) => void;

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function deriveNoiseSeed(rootSeed: number, biomeId: string, noiseName: string): number {
  return deriveSeed(deriveSeed(rootSeed, hashString(biomeId)), hashString(noiseName));
}

function compileNoiseSpec(spec: NoiseSpec, rootSeed: number, biomeId: string): Noise2D {
  const seed = deriveNoiseSeed(rootSeed, biomeId, spec.name);
  const baseNoise2D = createBaseNoise2D(seed);
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
      return (worldX: number, worldZ: number): number => fbm(baseNoise2D, worldX, worldZ, fbmParams);
    }
    case "ridged":
      return ridgedNoise2D(baseNoise2D, octaveParams);
    case "billow":
      return billowNoise2D(baseNoise2D, octaveParams);
  }
}

/** Compiles one step into a closure writing its result into `slots[outSlot]`, with every input
 *  name pre-resolved to a slot index (or a direct noise-sampler reference) - no lookups at eval time. */
function compileStep(
  step: PipelineStep,
  slotIndex: Map<string, number>,
  noiseSamplers: Map<string, Noise2D>,
  outSlot: number,
  biomeId: string,
): StepFn {
  const resolveSlot = (name: string): number => {
    const index = slotIndex.get(name);
    if (index === undefined) {
      throw new Error(`Pipeline for biome "${biomeId}" references unknown step/noise "${name}"`);
    }
    return index;
  };

  switch (step.op) {
    case "sample": {
      const noise2D = noiseSamplers.get(step.noise);
      if (!noise2D) {
        throw new Error(`Pipeline for biome "${biomeId}" references unknown step/noise "${step.noise}"`);
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
 */
export function compilePipeline(def: PipelineDef, rootSeed: number, biomeId: string): CompiledPipeline {
  const noiseSamplers = new Map<string, Noise2D>();
  for (const noiseSpec of def.noises) {
    noiseSamplers.set(noiseSpec.name, compileNoiseSpec(noiseSpec, rootSeed, biomeId));
  }

  if (def.steps.length === 0) {
    throw new Error(`Pipeline for biome "${biomeId}" has no steps`);
  }

  const slotIndex = new Map<string, number>();
  const stepFns: StepFn[] = def.steps.map((step, i) => {
    const fn = compileStep(step, slotIndex, noiseSamplers, i, biomeId);
    slotIndex.set(step.output, i);
    return fn;
  });

  const slots = new Float64Array(stepFns.length);
  const lastSlot = stepFns.length - 1;

  return (worldX: number, worldZ: number): number => {
    for (let i = 0; i < stepFns.length; i++) {
      stepFns[i](worldX, worldZ, slots);
    }
    return slots[lastSlot];
  };
}
