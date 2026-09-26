import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";
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
 * The tree (or bush) density map of a zone that grows a single species: one slow noise turned into
 * a 0-1 share of the scatter lattice.
 *
 * `openAt` is the noise value below which there are no trees at all and `fullAt` the value where a
 * stand reaches `peak`, so the pair decides both how much of the zone is wooded and how abruptly a
 * wood gives way to open ground. `frequency` is the size of a stand; 0.003 is a grove a few hundred
 * units across.
 *
 * `{ generator: "standDensity", kind, frequency, openAt, fullAt, peak }` - `tree` is accepted in
 * place of `kind`.
 */
const standDensity: Generator = (params, reader, path) => {
  reader.onlyKeys(params, path, ["generator", "kind", "tree", "frequency", "openAt", "fullAt", "peak"]);
  const kind = reader.string(params, params.kind !== undefined ? "kind" : "tree", path);
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
    outputs: { [kind]: "density" },
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

/**
 * How much taller than it was first authored the grassland's relief is: about 0.1 from soil to clump
 * top, which the bump never minded (it reads the slope, not the height) but which left the height
 * blend almost nothing to go on. Scaled up to span most of 0-1 - soil the cracks, clumps and leaves
 * the bumps - with the bump strength scaled down to match, so the bump is exactly as it was.
 */
const GRASSLAND_RELIEF = 4;

/**
 * A grassy ground texture - what shows between the grass tufts, so it carries the same structure
 * they do rather than a flat green: a mottle between `dark` and `light`, clumps with shadowed
 * rims, fine curling blade strokes, and bare `soil` showing through in ragged patches, more and
 * larger the higher `soilAmount` (0-1).
 *
 * With `leaves` (0-1) fallen leaves lie over it, in the shades between `leafColors`' two - the
 * ground at the edge of a wood, halfway to its floor.
 *
 * `{ generator: "grassland", dark, light, soil, soilAmount, roughness, bumpStrength, leaves?, leafColors? }`
 */
const grassland: Generator = (params, reader, path) => {
  reader.onlyKeys(params, path, ["generator", "dark", "light", "soil", "soilAmount", "roughness", "bumpStrength", "leaves", "leafColors"]);
  const soilAmount = reader.number(params, "soilAmount", path, { min: 0, max: 1 });
  const leaves = reader.optionalNumber(params, "leaves", path, 0, { min: 0, max: 1 });
  let leafColors: [ColorTuple, ColorTuple] = [
    [0.24, 0.16, 0.1],
    [0.36, 0.3, 0.18],
  ];
  if (leaves > 0) {
    const pair = reader.array(params, "leafColors", path).map((c, i) => reader.colorValue(c, joinPath(joinPath(path, "leafColors"), i)));
    if (pair.length !== 2) reader.fail(joinPath(path, "leafColors"), "expected two colours: [darkest, lightest]");
    else leafColors = [pair[0], pair[1]];
  }
  const noise = (name: string, type: string, octaves: number, tileCycles: number): RawObject => ({
    name,
    type,
    octaves,
    tileCycles,
    amplitude: 1,
    persistence: 0.5,
    lacunarity: 2.0,
  });
  return {
    bumpStrength: reader.number(params, "bumpStrength", path) / GRASSLAND_RELIEF,
    pipeline: {
      noises: [
        noise("mottle", "fbm", 3, 13),
        noise("broad", "fbm", 2, 3),
        noise("clumps", "billow", 2, 34),
        // Blade strokes: the crest lines of a fine ridged noise, bent by a warp so they curl every
        // which way rather than lining up with the texture's axes.
        noise("strokes", "ridged", 1, 70),
        noise("curlX", "fbm", 2, 40),
        noise("curlY", "fbm", 2, 40),
        noise("soil", "fbm", 4, 11),
        ...(leaves > 0
          ? [{ name: "leaves", type: "worley", tileCycles: 75, stretch: [1, 1.5], amplitude: 1, mode: "f1" }, noise("leafDrift", "fbm", 2, 6)]
          : []),
      ],
      steps: [
        { output: "mottle", op: "sample", noise: "mottle" },
        { output: "mottleMask", op: "mask", input: "mottle", at: 1.75, off: -1.75 },
        { output: "broad", op: "sample", noise: "broad" },
        { output: "broadMask", op: "mask", input: "broad", at: 1.3, off: -1.3 },
        { output: "clumpRaw", op: "sample", noise: "clumps" },
        { output: "clump", op: "mask", input: "clumpRaw", at: 1.3, off: 0.1 },
        { output: "curlXRaw", op: "sample", noise: "curlX" },
        { output: "curlYRaw", op: "sample", noise: "curlY" },
        { output: "curlXPx", op: "scale", input: "curlXRaw", factor: 9 },
        { output: "curlYPx", op: "scale", input: "curlYRaw", factor: 9 },
        { output: "strokeCrest", op: "sample", noise: "strokes", offset: ["curlXPx", "curlYPx"] },
        { output: "strokes", op: "mask", input: "strokeCrest", at: 0.97, off: 0.8 },

        // Bare soil in ragged patches - more of them, and larger, with soilAmount.
        { output: "soilRaw", op: "sample", noise: "soil" },
        { output: "soilMask", op: "mask", input: "soilRaw", at: 1.05 - soilAmount * 0.9, off: 0.8 - soilAmount * 0.9 },

        { output: "tone", op: "add", a: "mottleMask", b: "broadMask" },
        { output: "toneHalf", op: "scale", input: "tone", factor: 0.5 },
        { output: "darkColor", op: "color", value: reader.color(params, "dark", path) },
        { output: "lightColor", op: "color", value: reader.color(params, "light", path) },
        { output: "green", op: "mix", a: "darkColor", b: "lightColor", t: "toneHalf" },
        // Clumps stand up and catch the light; the ground between them is in their shade.
        { output: "clumpShade", op: "remap", input: "clump", inMin: 0, inMax: 1, outMin: 0.8, outMax: 1.08 },
        { output: "strokeShade", op: "remap", input: "strokes", inMin: 0, inMax: 1, outMin: 0.95, outMax: 1.16 },
        { output: "shade", op: "multiply", a: "clumpShade", b: "strokeShade" },
        { output: "litGreen", op: "multiply", a: "green", b: "shade" },
        { output: "soilColor", op: "color", value: reader.color(params, "soil", path) },
        { output: "soilShade", op: "remap", input: "mottleMask", inMin: 0, inMax: 1, outMin: 0.8, outMax: 1.1 },
        { output: "soil", op: "multiply", a: "soilColor", b: "soilShade" },
        // Blades still cross the bare patches, so the soil shows between strokes.
        { output: "soilVisible", op: "invert", input: "strokes" },
        { output: "soilShown", op: "multiply", a: "soilMask", b: "soilVisible" },
        { output: "ground", op: "mix", a: "litGreen", b: "soil", t: "soilShown" },

        // Fallen leaves, if any: domes around worley points, as many of the points as `leaves` asks
        // for (each point's own value picks it), thicker where a slow drift gathers them.
        ...(leaves > 0
          ? [
              { output: "leafDist", op: "sample", noise: "leaves" },
              { output: "leafId", op: "sample", noise: "leaves", mode: "cell" },
              { output: "leafDriftRaw", op: "sample", noise: "leafDrift" },
              { output: "leafDriftShift", op: "scale", input: "leafDriftRaw", factor: 0.25 },
              { output: "leafPickValue", op: "add", a: "leafId", b: "leafDriftShift" },
              { output: "leafPick", op: "mask", input: "leafPickValue", at: 1.02 - leaves, off: 0.98 - leaves },
              { output: "leafShrink", op: "scale", input: "leafId", factor: 0.2 },
              { output: "leafReach", op: "add", a: "leafDist", b: "leafShrink" },
              { output: "leafEdge", op: "mask", input: "leafReach", at: 0.1, off: 0.5 },
              { output: "leafDome", op: "power", input: "leafEdge", exponent: 0.6 },
              { output: "leaf", op: "multiply", a: "leafDome", b: "leafPick" },
              { output: "leafShown", op: "mask", input: "leaf", at: 0.18, off: 0.04 },
              { output: "leafDark", op: "color", value: leafColors[0] },
              { output: "leafLight", op: "color", value: leafColors[1] },
              { output: "leafTone", op: "mix", a: "leafDark", b: "leafLight", t: "leafId" },
              { output: "leafShade", op: "remap", input: "leafDome", inMin: 0, inMax: 1, outMin: 0.72, outMax: 1.05 },
              { output: "leafLit", op: "multiply", a: "leafTone", b: "leafShade" },
              { output: "diffuse", op: "mix", a: "ground", b: "leafLit", t: "leafShown" },
            ]
          : [{ output: "diffuse", op: "scale", input: "ground", factor: 1 }]),

        // Blades are waxy and catch the light, bare soil is matte: `roughness` is the grass's own,
        // the strokes a little glossier and the soil a good deal duller.
        { output: "grassRough", op: "constant", value: reader.number(params, "roughness", path) },
        { output: "bladeGloss", op: "scale", input: "strokes", factor: -0.2 },
        { output: "bladeRough", op: "add", a: "grassRough", b: "bladeGloss" },
        { output: "soilRough", op: "constant", value: 0.92 },
        { output: "roughness", op: "mix", a: "bladeRough", b: "soilRough", t: "soilShown" },

        { output: "clumpRelief", op: "scale", input: "clump", factor: 0.4 },
        { output: "strokeRelief", op: "scale", input: "strokes", factor: 0.08 },
        { output: "grassRelief", op: "add", a: "clumpRelief", b: "strokeRelief" },
        { output: "mottleRelief", op: "scale", input: "mottleMask", factor: 0.2 },
        { output: "grassHeight", op: "add", a: "grassRelief", b: "mottleRelief" },
        { output: "soilHeight", op: "constant", value: 0.05 },
        { output: "groundHeight", op: "mix", a: "grassHeight", b: "soilHeight", t: "soilShown" },
        ...(leaves > 0
          ? [
              { output: "leafRelief", op: "scale", input: "leaf", factor: 0.5 },
              { output: "relief", op: "max", a: "groundHeight", b: "leafRelief" },
            ]
          : [{ output: "relief", op: "scale", input: "groundHeight", factor: 1 }]),
        { output: "height", op: "scale", input: "relief", factor: GRASSLAND_RELIEF },
      ],
      outputs: { diffuse: "diffuse", roughness: "roughness", height: "height" },
    },
  };
};

export const GENERATORS: Record<string, Generator> = { detailHeight, standDensity, twoSpecies, twoTone, grassland };

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
