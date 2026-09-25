import { isObject, joinPath, type RawObject, type Reader } from "./contentReader";

/**
 * Named generators a pack can call instead of writing a value out in full: anywhere in a pack file,
 * an object with a `generator` field is replaced by what that generator returns for the object's
 * other fields. The result is then read exactly as if it had been written by hand, so it is checked
 * the same way and a generator can only ever produce something a pack could have written itself.
 *
 * These are code on purpose - adding one is a code change - so each stays a short, well-understood
 * shorthand for a shape of graph the content keeps asking for.
 */
type Generator = (params: RawObject, reader: Reader, path: string) => unknown;

/**
 * A single shared-shape height: one fbm noise, offset by the biome's base elevation.
 *
 * `{ generator: "detailHeight", amplitude, frequency, offset, octaves?: 4, persistence?: 0.4 }`
 */
const detailHeight: Generator = (params, reader, path) => {
  reader.onlyKeys(params, path, ["generator", "amplitude", "frequency", "offset", "octaves", "persistence"]);
  return {
    noises: [
      {
        name: "detail",
        type: "fbm",
        octaves: reader.optionalNumber(params, "octaves", path, 4, { min: 1, integer: true }),
        frequency: reader.number(params, "frequency", path),
        amplitude: reader.number(params, "amplitude", path),
        persistence: reader.optionalNumber(params, "persistence", path, 0.4),
        lacunarity: 2.0,
      },
    ],
    steps: [
      { output: "raw", op: "sample", noise: "detail" },
      { output: "result", op: "offset", input: "raw", amount: reader.number(params, "offset", path) },
    ],
  };
};

/**
 * The tree density map of a zone that grows a single species: one slow noise turned into a 0-1
 * share of the scatter lattice.
 *
 * `openAt` is the noise value below which there are no trees at all and `fullAt` the value where a
 * stand reaches `peak`, so the pair decides both how much of the zone is wooded and how abruptly a
 * wood gives way to open ground. `frequency` is the size of a stand; 0.003 is a grove a few hundred
 * units across.
 *
 * `{ generator: "standDensity", tree, frequency, openAt, fullAt, peak }`
 */
const standDensity: Generator = (params, reader, path) => {
  reader.onlyKeys(params, path, ["generator", "tree", "frequency", "openAt", "fullAt", "peak"]);
  const peak = reader.number(params, "peak", path);
  return {
    noises: [
      { name: "stand", type: "fbm", octaves: 3, frequency: reader.number(params, "frequency", path), amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
    ],
    steps: [
      { output: "raw", op: "sample", noise: "stand" },
      {
        output: "ramp",
        op: "remap",
        input: "raw",
        inMin: reader.number(params, "openAt", path),
        inMax: reader.number(params, "fullAt", path),
        outMin: 0,
        outMax: peak,
      },
      { output: "density", op: "clamp", input: "ramp", min: 0, max: peak },
    ],
    outputs: { [reader.string(params, "tree", path)]: "density" },
  };
};

/**
 * Splits one "how wooded is it here" cover signal between two species by a 0-1 share, so the two
 * always partition the same ground rather than stacking two independent densities on it. What
 * drives the share is up to the pack: a slow noise gives interleaved stands, the `height` input a
 * belt up a hillside.
 *
 * `cover` must end in a step named "cover" and `share` in one named "share".
 *
 * `{ generator: "twoSpecies", lower, upper, noises: [...], cover: [steps], share: [steps] }`
 */
const twoSpecies: Generator = (params, reader, path) => {
  reader.onlyKeys(params, path, ["generator", "lower", "upper", "noises", "cover", "share"]);
  return {
    noises: reader.array(params, "noises", path),
    steps: [
      ...reader.array(params, "cover", path),
      ...reader.array(params, "share", path),
      { output: "lowerShare", op: "invert", input: "share" },
      { output: "lowerDensity", op: "multiply", a: "cover", b: "lowerShare" },
      { output: "upperDensity", op: "multiply", a: "cover", b: "share" },
    ],
    outputs: { [reader.string(params, "lower", path)]: "lowerDensity", [reader.string(params, "upper", path)]: "upperDensity" },
  };
};

/**
 * A plain two-colour mottled material texture: one noise fades between two colours, drives a flat
 * roughness, and doubles as the surface relief.
 *
 * `{ generator: "twoTone", base: colour, variation: colour, roughness, bumpStrength }`
 */
const twoTone: Generator = (params, reader, path) => {
  reader.onlyKeys(params, path, ["generator", "base", "variation", "roughness", "bumpStrength"]);
  return {
    bumpStrength: reader.number(params, "bumpStrength", path),
    pipeline: {
      // The shared "mottle": 3 octaves at amplitude 1 and persistence 0.5 span about +/-1.75.
      noises: [{ name: "mottle", type: "fbm", octaves: 3, tileCycles: 13, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
      steps: [
        { output: "mottle", op: "sample", noise: "mottle" },
        { output: "mottleMask", op: "mask", input: "mottle", at: 1.75, off: -1.75 },
        { output: "baseColor", op: "color", value: reader.color(params, "base", path) },
        { output: "variationColor", op: "color", value: reader.color(params, "variation", path) },
        { output: "diffuse", op: "mix", a: "baseColor", b: "variationColor", t: "mottleMask" },
        { output: "roughness", op: "constant", value: reader.number(params, "roughness", path) },
      ],
      // Height reuses the 0..1 mask - an output can name any step.
      outputs: { diffuse: "diffuse", roughness: "roughness", height: "mottleMask" },
    },
  };
};

export const GENERATORS: Record<string, Generator> = { detailHeight, standDensity, twoSpecies, twoTone };

/** Stands in for a generator call that could not be made. Its problem is already reported, so
 *  whatever reads this value skips it quietly rather than piling "missing field" errors on top. */
export const FAILED_GENERATOR: RawObject = Object.freeze({});

/**
 * Replaces every `{ generator: ... }` object in a parsed file with its generator's result,
 * depth-first, so a generator's parameters may themselves use generators.
 */
export function expandGenerators(value: unknown, reader: Reader, path = ""): unknown {
  if (Array.isArray(value)) return value.map((item, i) => expandGenerators(item, reader, joinPath(path, i)));
  if (!isObject(value)) return value;

  const expanded: RawObject = {};
  for (const [key, child] of Object.entries(value)) expanded[key] = expandGenerators(child, reader, joinPath(path, key));
  if (expanded.generator === undefined) return expanded;

  const name = expanded.generator;
  const generator = typeof name === "string" ? GENERATORS[name] : undefined;
  if (!generator) {
    reader.fail(joinPath(path, "generator"), `unknown generator ${JSON.stringify(name)} (known: ${Object.keys(GENERATORS).join(", ")})`);
    return FAILED_GENERATOR;
  }
  return generator(expanded, reader, path);
}
