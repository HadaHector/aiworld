import { TEXTURE_RESOLUTION } from "../materials/textureGen";
import { compileOutputs } from "../terrain/pipeline/pipelineCompiler";
import type { ColorRampStop, NoiseSpec, PipelineDef, PipelineStep } from "../terrain/pipeline/pipelineTypes";
import { joinPath, type RawObject, type Reader } from "./contentReader";
import { FAILED_GENERATOR } from "./generators";

const NOISE_TYPES = ["fbm", "ridged", "billow", "worley", "wave"] as const;
const WAVE_SHAPES = ["sine", "triangle", "saw"] as const;
const WORLEY_MODES = ["f1", "edge", "cell"] as const;

/** The fields each op takes besides `output` and `op`: "ref" names an earlier step, "noise" a noise,
 *  "number"/"text"/"color" a literal. */
const OP_FIELDS: Record<string, Record<string, "ref" | "noise" | "number" | "text" | "color" | "stops">> = {
  sample: { noise: "noise" },
  constant: { value: "number" },
  input: { name: "text" },
  color: { value: "color" },
  colorRamp: { input: "ref", stops: "stops" },
  scale: { input: "ref", factor: "number" },
  offset: { input: "ref", amount: "number" },
  power: { input: "ref", exponent: "number" },
  abs: { input: "ref" },
  invert: { input: "ref" },
  sin: { input: "ref", cycles: "number" },
  clamp: { input: "ref", min: "number", max: "number" },
  terrace: { input: "ref", step: "number", riser: "number" },
  remap: { input: "ref", inMin: "number", inMax: "number", outMin: "number", outMax: "number" },
  luminance: { input: "ref" },
  add: { a: "ref", b: "ref" },
  subtract: { a: "ref", b: "ref" },
  multiply: { a: "ref", b: "ref" },
  max: { a: "ref", b: "ref" },
  min: { a: "ref", b: "ref" },
  smoothMax: { a: "ref", b: "ref", k: "number" },
  smoothMin: { a: "ref", b: "ref", k: "number" },
  lerp: { a: "ref", b: "ref", t: "number" },
  mix: { a: "ref", b: "ref", t: "ref" },
  /**
   * Not an op of the compiler's own but shorthand for two of them: turns a raw signal into a 0..1
   * mask, `at` mapping to 1 and `off` to 0, clamped outside. `at` may be either side of `off` -
   * below it inverts the sense, which is how a Worley "edge" distance (near 0 exactly on a crack)
   * becomes a mask that is 1 on the crack. Expands to a remap into `<output>Raw` and a clamp.
   */
  mask: { input: "ref", at: "number", off: "number" },
};

export interface PipelineReadOptions {
  /** Texture pipelines are sampled in pixels, so a noise there may give its scale as `tileCycles` -
   *  cycles per texture tile - instead of a raw `frequency`, which keeps a material's look fixed
   *  whatever resolution it is baked at. */
  texture?: boolean;
  /** Output names the pipeline must declare (a texture's `diffuse`, say). */
  requiredOutputs?: readonly string[];
}

function readNoise(raw: unknown, reader: Reader, path: string, options: PipelineReadOptions): NoiseSpec {
  const obj = reader.object(raw, path);
  const type = reader.oneOf(obj, "type", path, NOISE_TYPES);
  const name = reader.string(obj, "name", path);
  const shared = reader.has(obj, "shared") ? { shared: reader.string(obj, "shared", path) } : {};
  if (type === "wave") return { ...readWave(obj, name, reader, path, options), ...shared };
  const scaleKeys = options.texture ? ["frequency", "tileCycles"] : ["frequency"];
  let frequency = 0;
  if (options.texture && reader.has(obj, "tileCycles")) {
    if (reader.has(obj, "frequency")) reader.fail(path, "give either frequency or tileCycles, not both");
    frequency = reader.number(obj, "tileCycles", path, { min: 0 }) / TEXTURE_RESOLUTION;
  } else {
    frequency = reader.number(obj, "frequency", path, { min: 0 });
  }
  const amplitude = reader.number(obj, "amplitude", path);
  let stretch: [number, number] | undefined;
  if (obj.stretch !== undefined) {
    const value = obj.stretch;
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && v > 0)) stretch = [value[0], value[1]];
    else reader.fail(joinPath(path, "stretch"), "expected [x, y], both above 0");
  }

  if (type === "worley") {
    reader.onlyKeys(obj, path, ["name", "shared", "type", "amplitude", "mode", "stretch", "warp", "sizeJitter", "round", ...scaleKeys]);
    const shaping = (key: "warp" | "sizeJitter" | "round", max: number) =>
      reader.has(obj, key) ? { [key]: reader.number(obj, key, path, { min: 0, max }) } : {};
    return {
      name,
      ...shared,
      type,
      frequency,
      amplitude,
      mode: reader.oneOf(obj, "mode", path, WORLEY_MODES),
      ...(stretch ? { stretch } : {}),
      ...shaping("warp", 1),
      ...shaping("sizeJitter", 0.5),
      ...shaping("round", 1),
    };
  }
  reader.onlyKeys(obj, path, ["name", "shared", "type", "amplitude", "octaves", "persistence", "lacunarity", "stretch", ...(type === "ridged" ? ["crest"] : []), ...scaleKeys]);
  return {
    ...(stretch ? { stretch } : {}),
    ...(type === "ridged" && obj.crest !== undefined ? { crest: reader.number(obj, "crest", path, { min: 0, max: 1 }) } : {}),
    name,
    ...shared,
    type,
    frequency,
    amplitude,
    octaves: reader.number(obj, "octaves", path, { min: 1, max: 12, integer: true }),
    persistence: reader.number(obj, "persistence", path),
    lacunarity: reader.number(obj, "lacunarity", path),
  };
}

/** A wave's scale is a pair - cycles along x and along y - and in a texture those cycles must be
 *  whole, or the bands would not meet themselves at the tile's edge. */
function readWave(obj: RawObject, name: string, reader: Reader, path: string, options: PipelineReadOptions): NoiseSpec {
  const scaleKey = options.texture ? "tileCycles" : "frequency";
  reader.onlyKeys(obj, path, ["name", "shared", "type", "amplitude", "shape", scaleKey]);
  const value = obj[scaleKey];
  let frequency: [number, number] = [0, 0];
  if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === "number" && Number.isFinite(v))) {
    reader.fail(joinPath(path, scaleKey), options.texture ? "expected [x, y], whole cycles per tile along each axis" : "expected [x, y], cycles per unit along each axis");
  } else if (options.texture && !value.every((v) => Number.isInteger(v))) {
    reader.fail(joinPath(path, scaleKey), "a texture's wave needs whole cycles per tile, or it will not tile");
  } else if (value[0] === 0 && value[1] === 0) {
    reader.fail(joinPath(path, scaleKey), "at least one of the two must be non-zero");
  } else {
    frequency = options.texture ? [value[0] / TEXTURE_RESOLUTION, value[1] / TEXTURE_RESOLUTION] : [value[0], value[1]];
  }
  const shape = reader.has(obj, "shape") ? reader.oneOf(obj, "shape", path, WAVE_SHAPES) : "sine";
  return { name, type: "wave", frequency, amplitude: reader.number(obj, "amplitude", path), shape };
}

function readStops(raw: RawObject, reader: Reader, path: string): ColorRampStop[] {
  const stops = reader.array(raw, "stops", path).map((item, i) => {
    const at = joinPath(joinPath(path, "stops"), i);
    const stop = reader.object(item, at);
    reader.onlyKeys(stop, at, ["at", "color"]);
    return { at: reader.number(stop, "at", at), color: reader.color(stop, "color", at) };
  });
  if (stops.length === 0) reader.fail(joinPath(path, "stops"), "a colour ramp needs at least one stop");
  return stops;
}

/**
 * Reads a pipeline graph (see terrain/pipeline/pipelineTypes.ts), expanding `mask` steps and
 * `tileCycles`, checking every field and every name a step refers to, and finally compiling it once
 * so anything the compiler itself objects to (a colour where a number has to be) is reported
 * against the pack file rather than surfacing mid-generation.
 */
export function readPipeline(raw: unknown, reader: Reader, path: string, options: PipelineReadOptions = {}): PipelineDef {
  if (raw === FAILED_GENERATOR) return { noises: [], steps: [] };
  const obj = reader.object(raw, path);
  reader.onlyKeys(obj, path, ["noises", "steps", "outputs"]);
  const issuesBefore = reader.issues.length;

  const noises = reader.optionalArray(obj, "noises", path).map((n, i) => readNoise(n, reader, joinPath(joinPath(path, "noises"), i), options));
  const noiseNames = new Set<string>();
  noises.forEach((noise, i) => {
    if (noiseNames.has(noise.name)) reader.fail(joinPath(joinPath(path, "noises"), i), `a noise named "${noise.name}" already exists`);
    noiseNames.add(noise.name);
  });

  const outputs = new Set<string>();
  const steps: PipelineStep[] = [];
  const rawSteps = reader.array(obj, "steps", path);
  if (rawSteps.length === 0) reader.fail(joinPath(path, "steps"), "a pipeline needs at least one step");
  rawSteps.forEach((rawStep, i) => {
    const at = joinPath(joinPath(path, "steps"), i);
    const step = reader.object(rawStep, at);
    const output = reader.string(step, "output", at);
    const op = reader.oneOf(step, "op", at, Object.keys(OP_FIELDS));
    const fields = OP_FIELDS[op];
    reader.onlyKeys(step, at, ["output", "op", ...Object.keys(fields), ...(op === "sample" ? ["offset", "mode"] : [])]);

    const read: RawObject = { output, op };
    if (op === "sample" && step.mode !== undefined) read.mode = reader.oneOf(step, "mode", at, WORLEY_MODES);
    if (op === "sample" && step.offset !== undefined) {
      const offset = step.offset;
      if (!Array.isArray(offset) || offset.length !== 2 || !offset.every((name) => typeof name === "string")) {
        reader.fail(joinPath(at, "offset"), "expected [stepX, stepY], the names of two earlier steps");
      } else {
        for (const name of offset as string[]) {
          if (!outputs.has(name)) reader.fail(joinPath(at, "offset"), `no earlier step named "${name}"`);
        }
        read.offset = offset;
      }
    }
    for (const [key, kind] of Object.entries(fields)) {
      if (kind === "number") read[key] = reader.number(step, key, at);
      else if (kind === "text") read[key] = reader.string(step, key, at);
      else if (kind === "color") read[key] = reader.color(step, key, at);
      else if (kind === "stops") read[key] = readStops(step, reader, at);
      else {
        const name = reader.string(step, key, at);
        read[key] = name;
        if (kind === "noise" && name && !noiseNames.has(name)) reader.fail(joinPath(at, key), `no noise named "${name}" in this pipeline`);
        if (kind === "ref" && name && !outputs.has(name)) reader.fail(joinPath(at, key), `no earlier step named "${name}"`);
      }
    }

    if (op === "mask") {
      steps.push({ output: `${output}Raw`, op: "remap", input: read.input as string, inMin: read.off as number, inMax: read.at as number, outMin: 0, outMax: 1 });
      steps.push({ output, op: "clamp", input: `${output}Raw`, min: 0, max: 1 });
      outputs.add(`${output}Raw`);
    } else {
      steps.push(read as unknown as PipelineStep);
    }
    outputs.add(output);
  });

  let namedOutputs: Record<string, string> | undefined;
  if (obj.outputs !== undefined) {
    const map = reader.object(obj.outputs, joinPath(path, "outputs"));
    namedOutputs = {};
    for (const [key, value] of Object.entries(map)) {
      if (typeof value !== "string" || !outputs.has(value)) {
        reader.fail(joinPath(joinPath(path, "outputs"), key), `must name a step of this pipeline, got ${JSON.stringify(value)}`);
        continue;
      }
      namedOutputs[key] = value;
    }
  }
  for (const required of options.requiredOutputs ?? []) {
    if (!namedOutputs?.[required]) reader.fail(joinPath(path, "outputs"), `must declare a "${required}" output`);
  }

  const pipeline: PipelineDef = namedOutputs ? { noises, steps, outputs: namedOutputs } : { noises, steps };
  if (reader.issues.length === issuesBefore) {
    try {
      compileOutputs(pipeline, 0, "check", options.texture ? { tilePeriod: TEXTURE_RESOLUTION } : undefined);
    } catch (error) {
      reader.fail(path, error instanceof Error ? error.message : String(error));
    }
  }
  return pipeline;
}
