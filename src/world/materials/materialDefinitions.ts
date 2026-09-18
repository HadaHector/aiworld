import { Color3 } from "@babylonjs/core";
import type { ColorTuple, NoiseSpec, PipelineDef, PipelineStep } from "../terrain/pipeline/pipelineTypes";
import type { TextureDef } from "./textureGen";

export interface MaterialDef {
  id: string;
  name: string;
  texture: TextureDef;
}

/** Color3 is convenient to author in; the pipeline deliberately knows nothing about Babylon. */
function rgb(color: Color3): ColorTuple {
  return [color.r, color.g, color.b];
}

/**
 * Steps turning a raw signal into a 0..1 mask: the value `at` maps to 1, the value `off` maps to 0,
 * clamped outside that span. `at` may be either side of `off` - passing `at` below `off` inverts
 * the sense, which is how a Worley "edge" distance (near 0 exactly on a crack) becomes a mask that
 * is 1 on the crack and 0 away from it.
 *
 * Masks are the backbone of authoring here: each one is computed once and then reused to drive
 * diffuse, roughness and height independently - which is the whole point of this design. A crack
 * mask can darken the color, roughen the surface AND cut the height down, all from one signal.
 */
function maskSteps(input: string, at: number, off: number, output: string): PipelineStep[] {
  return [
    { output: `${output}Raw`, op: "remap", input, inMin: off, inMax: at, outMin: 0, outMax: 1 },
    { output, op: "clamp", input: `${output}Raw`, min: 0, max: 1 },
  ];
}

// The shared noises every material draws on. Amplitude is 1 with persistence 0.5, so an N-octave
// fbm spans roughly +/-(2 - 0.5^(N-1)): +/-1.75 for 3 octaves, +/-1.5 for 2. Those are the numbers
// the maskSteps calls below use as their `at`/`off` ends.
const MOTTLE_NOISE: NoiseSpec = { name: "mottle", type: "fbm", octaves: 3, frequency: 0.05, amplitude: 1, persistence: 0.5, lacunarity: 2.0 };
const MOTTLE_SPAN = 1.75;

/** A tighter grain than MOTTLE_NOISE, for materials that read as too soft/blurry with only one
 *  (broad) noise scale in play. */
const FINE_GRAIN_NOISE: NoiseSpec = { name: "grain", type: "fbm", octaves: 2, frequency: 0.18, amplitude: 1, persistence: 0.5, lacunarity: 2.0 };

/** Gentle, large-area tonal shifts (sun-bleached patches, soft shadowing) - meant to read as a big
 *  soft area of slightly different tone, not a repeating close-up pattern. */
const BROAD_TONE_NOISE: NoiseSpec = { name: "broad", type: "fbm", octaves: 2, frequency: 0.012, amplitude: 1, persistence: 0.5, lacunarity: 2.0 };
const TWO_OCTAVE_SPAN = 1.5;

/** A plain two-color mottled material: one noise fades between two colors, drives a flat roughness,
 *  and doubles as the surface relief. See rockMaterial and leafLitterMaterial for textures that
 *  actually exploit independent diffuse/roughness/height instead of the simple two-tone case. */
function twoToneTexture(baseColor: Color3, variationColor: Color3, roughness: number, bumpStrength: number): TextureDef {
  return {
    bumpStrength,
    pipeline: {
      noises: [MOTTLE_NOISE],
      steps: [
        { output: "mottle", op: "sample", noise: "mottle" },
        ...maskSteps("mottle", MOTTLE_SPAN, -MOTTLE_SPAN, "mottleMask"),
        { output: "baseColor", op: "color", value: rgb(baseColor) },
        { output: "variationColor", op: "color", value: rgb(variationColor) },
        { output: "diffuse", op: "mix", a: "baseColor", b: "variationColor", t: "mottleMask" },
        { output: "roughness", op: "constant", value: roughness },
      ],
      // height reuses the already-computed 0..1 mask - no extra step needed, an output can name any
      // step. (bumpStrength at the call sites is ~3.5x what it was when height was the raw +/-1.75
      // noise, since the mask compresses the same relief into a 1.0 span.)
      outputs: { diffuse: "diffuse", roughness: "roughness", height: "mottleMask" },
    },
  };
}

/** A rule tying one MaterialDef to a weight pipeline. Several layers may point at the same
 *  MaterialDef (see the two snow layers below) - the material and the rule that selects it are
 *  deliberately separate. */
export interface MaterialLayer {
  id: string;
  material: MaterialDef;
  weight: PipelineDef;
}

// roughness/bumpStrength are chosen by material character (rock-like = rough + strong bump,
// foliage/ground = medium-high roughness + gentle bump, sand = medium roughness + medium ripple,
// snow/ice = lowest roughness + gentlest bump), not individually tuned - first-pass numbers like
// every other constant in this project, meant to be eyeballed and adjusted.
const grassMaterial: MaterialDef = {
  id: "grass",
  name: "Grass",
  texture: twoToneTexture(new Color3(0.28, 0.42, 0.2), new Color3(0.38, 0.55, 0.28), 0.75, 1.4),
};

// Rock: broad mottle, a FINER grain on top (the mottle alone read as too soft/uniform), natural
// crack lines (Worley "edge" - an irregular fracture network, not ridged noise's directional
// creases), and sparse lichen patches (billow, an organic growth shape rather than a geometric one).
//
// This is the clearest demonstration of why diffuse/roughness/height are separate outputs: the
// crack mask darkens the color, roughens the surface, AND is *subtracted* from the height, so
// cracks are grooves. Under the old paint-layer design a feature could only show where it was the
// tallest layer, which meant every crack in this project was silently baked as a raised ridge and
// lit as one - measurably so (its darkest pixels sat at height 254.6/255, the maximum).
const rockMaterial: MaterialDef = {
  id: "rock",
  name: "Rock",
  texture: {
    bumpStrength: 1.65,
    pipeline: {
      noises: [
        MOTTLE_NOISE,
        FINE_GRAIN_NOISE,
        { name: "cracks", type: "worley", frequency: 0.02, amplitude: 1, mode: "edge" },
        { name: "lichen", type: "billow", octaves: 2, frequency: 0.025, amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
      ],
      steps: [
        { output: "mottle", op: "sample", noise: "mottle" },
        ...maskSteps("mottle", MOTTLE_SPAN, -MOTTLE_SPAN, "mottleMask"),
        { output: "grain", op: "sample", noise: "grain" },
        ...maskSteps("grain", TWO_OCTAVE_SPAN, -TWO_OCTAVE_SPAN, "grainMask"),
        // `at` below `off` inverts: the Worley edge distance is ~0 exactly on a crack, so this is 1
        // on the crack line and falls to 0 by 0.13 away from it.
        { output: "crackEdge", op: "sample", noise: "cracks" },
        ...maskSteps("crackEdge", 0, 0.13, "crackMask"),
        { output: "lichenRaw", op: "sample", noise: "lichen" },
        ...maskSteps("lichenRaw", 1.3, 0.3, "lichenMask"),

        // --- diffuse: stone tone, grain detail, then cracks and lichen painted over it ---
        { output: "stoneDark", op: "color", value: [0.35, 0.33, 0.32] },
        { output: "stoneLight", op: "color", value: [0.48, 0.46, 0.44] },
        { output: "stone", op: "mix", a: "stoneDark", b: "stoneLight", t: "mottleMask" },
        { output: "grainColor", op: "color", value: [0.4, 0.38, 0.37] },
        { output: "grainBlend", op: "scale", input: "grainMask", factor: 0.45 },
        { output: "stoneGrained", op: "mix", a: "stone", b: "grainColor", t: "grainBlend" },
        { output: "crackColor", op: "color", value: [0.13, 0.12, 0.11] },
        { output: "cracked", op: "mix", a: "stoneGrained", b: "crackColor", t: "crackMask" },
        { output: "lichenColor", op: "color", value: [0.43, 0.47, 0.32] },
        { output: "diffuse", op: "mix", a: "cracked", b: "lichenColor", t: "lichenMask" },

        // --- roughness: lichen is a touch softer than bare stone ---
        { output: "roughStone", op: "constant", value: 0.9 },
        { output: "roughLichen", op: "constant", value: 0.82 },
        { output: "roughness", op: "mix", a: "roughStone", b: "roughLichen", t: "lichenMask" },

        // --- height: mottle + grain relief on a raised bed, with the cracks cut down into it ---
        // The bed offset is what keeps the result inside the 0..1 convention once cracks subtract.
        { output: "bed", op: "constant", value: 0.55 },
        { output: "mottleRelief", op: "scale", input: "mottleMask", factor: 0.3 },
        { output: "bedded", op: "add", a: "bed", b: "mottleRelief" },
        { output: "grainRelief", op: "scale", input: "grainMask", factor: 0.15 },
        { output: "surface", op: "add", a: "bedded", b: "grainRelief" },
        { output: "crackDepth", op: "scale", input: "crackMask", factor: 0.65 },
        { output: "height", op: "subtract", a: "surface", b: "crackDepth" },
      ],
      outputs: { diffuse: "diffuse", roughness: "roughness", height: "height" },
    },
  },
};

// Sand: the usual mottle, a gentle broad tonal shift (fbm, very low frequency - large, soft
// sun-bleached patches instead of a repeating ripple pattern), and small rounded grains (Worley
// "f1" - a naturally grain-shaped blob, not the soft billow blobs used elsewhere for organic
// growth). No ridged dune-ripple layer any more - it read as an artificial, overly-regular wave
// pattern rather than sand.
const sandMaterial: MaterialDef = {
  id: "sand",
  name: "Sand",
  texture: {
    bumpStrength: 0.5,
    pipeline: {
      noises: [
        MOTTLE_NOISE,
        BROAD_TONE_NOISE,
        { name: "grains", type: "worley", frequency: 0.12, amplitude: 1, mode: "f1" },
      ],
      steps: [
        { output: "mottle", op: "sample", noise: "mottle" },
        ...maskSteps("mottle", MOTTLE_SPAN, -MOTTLE_SPAN, "mottleMask"),
        { output: "broad", op: "sample", noise: "broad" },
        ...maskSteps("broad", TWO_OCTAVE_SPAN, -TWO_OCTAVE_SPAN, "broadMask"),
        // Worley f1 is ~0 at each scattered point, so this is 1 at a grain and 0 by 0.4 away.
        { output: "grainDist", op: "sample", noise: "grains" },
        ...maskSteps("grainDist", 0, 0.4, "grainMask"),

        { output: "sandDark", op: "color", value: [0.76, 0.68, 0.48] },
        { output: "sandLight", op: "color", value: [0.86, 0.78, 0.58] },
        { output: "sand", op: "mix", a: "sandDark", b: "sandLight", t: "mottleMask" },
        { output: "shadeColor", op: "color", value: [0.7, 0.61, 0.42] },
        { output: "shadeBlend", op: "scale", input: "broadMask", factor: 0.6 },
        { output: "sandShaded", op: "mix", a: "sand", b: "shadeColor", t: "shadeBlend" },
        { output: "grainColor", op: "color", value: [0.44, 0.37, 0.26] },
        { output: "diffuse", op: "mix", a: "sandShaded", b: "grainColor", t: "grainMask" },

        { output: "roughSand", op: "constant", value: 0.6 },
        { output: "roughGrain", op: "constant", value: 0.82 },
        { output: "roughness", op: "mix", a: "roughSand", b: "roughGrain", t: "grainMask" },

        // Grains are little stones sitting proud of the sand, so they add height rather than cut it.
        { output: "drift", op: "scale", input: "mottleMask", factor: 0.45 },
        { output: "grainRelief", op: "scale", input: "grainMask", factor: 0.5 },
        { output: "height", op: "add", a: "drift", b: "grainRelief" },
      ],
      outputs: { diffuse: "diffuse", roughness: "roughness", height: "height" },
    },
  },
};

// Snow: the usual mottle, a gentle broad tonal shift (fbm, very low frequency, a cool blue-white
// shadow color - soft, large drifts of shading rather than a repeating pattern), and rare bright
// sparkle glints (billow, only the extreme upper tail so glints stay tiny and sparse). No ridged
// wind-ridge layer any more - it read as patchy and artificial rather than smooth, windswept snow.
const snowMaterial: MaterialDef = {
  id: "snow",
  name: "Snow",
  texture: {
    bumpStrength: 1.0,
    pipeline: {
      noises: [
        MOTTLE_NOISE,
        BROAD_TONE_NOISE,
        { name: "sparkle", type: "billow", octaves: 2, frequency: 0.22, amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
      ],
      steps: [
        { output: "mottle", op: "sample", noise: "mottle" },
        ...maskSteps("mottle", MOTTLE_SPAN, -MOTTLE_SPAN, "mottleMask"),
        { output: "broad", op: "sample", noise: "broad" },
        ...maskSteps("broad", TWO_OCTAVE_SPAN, -TWO_OCTAVE_SPAN, "broadMask"),
        // Only the extreme upper tail, so glints stay tiny and sparse rather than a bright haze.
        { output: "sparkleRaw", op: "sample", noise: "sparkle" },
        ...maskSteps("sparkleRaw", 1.5, 1.1, "glintMask"),

        // A colorRamp instead of a two-color mix: snow reads better as a short cool-to-warm-white
        // gradient than as a straight blend between two endpoints.
        {
          output: "snowTone",
          op: "colorRamp",
          input: "mottleMask",
          stops: [
            { at: 0.0, color: [0.88, 0.9, 0.95] },
            { at: 0.55, color: [0.94, 0.95, 0.97] },
            { at: 1.0, color: [0.99, 0.99, 1.0] },
          ],
        },
        { output: "shadowColor", op: "color", value: [0.83, 0.87, 0.94] },
        { output: "shadowBlend", op: "scale", input: "broadMask", factor: 0.75 },
        { output: "drifted", op: "mix", a: "snowTone", b: "shadowColor", t: "shadowBlend" },
        { output: "glintColor", op: "color", value: [1.0, 1.0, 1.0] },
        { output: "diffuse", op: "mix", a: "drifted", b: "glintColor", t: "glintMask" },

        { output: "roughSnow", op: "constant", value: 0.35 },
        { output: "roughGlint", op: "constant", value: 0.12 },
        { output: "roughness", op: "mix", a: "roughSnow", b: "roughGlint", t: "glintMask" },

        // Broad drifts set the large-scale relief, but at frequency 0.012 they barely change from
        // pixel to pixel, so on their own they bake a completely flat normal map - the fine mottle
        // is what actually gives snow any surface at all. Glints are optical, not geometric, so
        // they contribute no height.
        { output: "drifts", op: "scale", input: "broadMask", factor: 0.65 },
        { output: "fineSnow", op: "scale", input: "mottleMask", factor: 0.35 },
        { output: "height", op: "add", a: "drifts", b: "fineSnow" },
      ],
      outputs: { diffuse: "diffuse", roughness: "roughness", height: "height" },
    },
  },
};

const tundraGroundMaterial: MaterialDef = {
  id: "tundraGround",
  name: "Tundra Ground",
  texture: twoToneTexture(new Color3(0.52, 0.56, 0.52), new Color3(0.68, 0.71, 0.68), 0.8, 1.75),
};

// Mud: the usual mottle, a web of dry-cracked-mud fractures (Worley "edge" - the textbook natural
// use for cellular noise, an irregular polygonal crack network, not ridged noise's directional
// creases), and darker, notably glossier wet patches (billow, broad, with a much lower roughness
// than the surrounding dry mud).
const mudMaterial: MaterialDef = {
  id: "mud",
  name: "Mud",
  texture: {
    bumpStrength: 0.7,
    pipeline: {
      noises: [
        MOTTLE_NOISE,
        { name: "cracks", type: "worley", frequency: 0.015, amplitude: 1, mode: "edge" },
        { name: "damp", type: "billow", octaves: 2, frequency: 0.03, amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
      ],
      steps: [
        { output: "mottle", op: "sample", noise: "mottle" },
        ...maskSteps("mottle", MOTTLE_SPAN, -MOTTLE_SPAN, "mottleMask"),
        { output: "crackEdge", op: "sample", noise: "cracks" },
        ...maskSteps("crackEdge", 0, 0.16, "crackMask"),
        { output: "dampRaw", op: "sample", noise: "damp" },
        ...maskSteps("dampRaw", 1.3, 0.2, "wetMask"),

        { output: "mudDark", op: "color", value: [0.22, 0.19, 0.13] },
        { output: "mudLight", op: "color", value: [0.33, 0.34, 0.2] },
        { output: "mud", op: "mix", a: "mudDark", b: "mudLight", t: "mottleMask" },
        { output: "crackColor", op: "color", value: [0.14, 0.11, 0.07] },
        { output: "cracked", op: "mix", a: "mud", b: "crackColor", t: "crackMask" },
        { output: "wetColor", op: "color", value: [0.15, 0.13, 0.09] },
        { output: "diffuse", op: "mix", a: "cracked", b: "wetColor", t: "wetMask" },

        // Wet patches are notably glossier than the dry mud around them.
        { output: "roughDry", op: "constant", value: 0.55 },
        { output: "roughWet", op: "constant", value: 0.22 },
        { output: "roughness", op: "mix", a: "roughDry", b: "roughWet", t: "wetMask" },

        // Dried mud curls up into plates with the cracks as grooves between them - so the crack
        // mask is subtracted here, the same correctness fix described on rockMaterial. The bed
        // offset keeps the result inside the 0..1 height convention once the cracks cut into it.
        { output: "bed", op: "constant", value: 0.6 },
        { output: "plateRelief", op: "scale", input: "mottleMask", factor: 0.4 },
        { output: "plates", op: "add", a: "bed", b: "plateRelief" },
        { output: "crackDepth", op: "scale", input: "crackMask", factor: 0.6 },
        { output: "height", op: "subtract", a: "plates", b: "crackDepth" },
      ],
      outputs: { diffuse: "diffuse", roughness: "roughness", height: "height" },
    },
  },
};

// Plains-only variety layers (see the north/south/valley layers below) - never a biome's base, so
// not registered in MATERIAL_REGISTRY, only referenced directly by their MaterialLayer.
const grassPaleMaterial: MaterialDef = {
  id: "grassPale",
  name: "Faded Grass",
  texture: twoToneTexture(new Color3(0.48, 0.54, 0.4), new Color3(0.58, 0.63, 0.48), 0.75, 1.4),
};

const grassDryMaterial: MaterialDef = {
  id: "grassDry",
  name: "Dry Grass",
  texture: twoToneTexture(new Color3(0.56, 0.5, 0.26), new Color3(0.66, 0.58, 0.34), 0.75, 1.4),
};

const weedsMaterial: MaterialDef = {
  id: "weeds",
  name: "Weeds",
  texture: twoToneTexture(new Color3(0.13, 0.2, 0.09), new Color3(0.2, 0.3, 0.15), 0.78, 1.575),
};

// Moss: the usual mottle, a second finer grain layer (fbm at a higher frequency, the same "add a
// close-up scale" fix as rock's - a fuzzy, textured surface instead of one soft blur), and
// brighter clumpy tufts (billow, mid-frequency for small rounded clumps). No crack/crevice layer -
// moss doesn't show sharp fractures the way bare rock or dry mud does, and a ridged crease pattern
// here just read as an unrelated, out-of-place texture rather than anything moss-like.
const mossMaterial: MaterialDef = {
  id: "moss",
  name: "Moss",
  texture: {
    bumpStrength: 0.75,
    pipeline: {
      noises: [
        MOTTLE_NOISE,
        FINE_GRAIN_NOISE,
        { name: "clumps", type: "billow", octaves: 2, frequency: 0.1, amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
      ],
      steps: [
        { output: "mottle", op: "sample", noise: "mottle" },
        ...maskSteps("mottle", MOTTLE_SPAN, -MOTTLE_SPAN, "mottleMask"),
        { output: "grain", op: "sample", noise: "grain" },
        ...maskSteps("grain", TWO_OCTAVE_SPAN, -TWO_OCTAVE_SPAN, "grainMask"),
        { output: "clumpRaw", op: "sample", noise: "clumps" },
        ...maskSteps("clumpRaw", 1.4, 0.5, "tuftMask"),

        // Moss varies over a range of greens rather than between two, so a ramp fits it better.
        {
          output: "mossTone",
          op: "colorRamp",
          input: "mottleMask",
          stops: [
            { at: 0.0, color: [0.14, 0.23, 0.18] },
            { at: 0.45, color: [0.19, 0.31, 0.24] },
            { at: 1.0, color: [0.24, 0.39, 0.29] },
          ],
        },
        { output: "grainShade", op: "color", value: [0.17, 0.28, 0.21] },
        { output: "grainBlend", op: "scale", input: "grainMask", factor: 0.35 },
        { output: "mossGrained", op: "mix", a: "mossTone", b: "grainShade", t: "grainBlend" },
        { output: "tuftColor", op: "color", value: [0.3, 0.44, 0.3] },
        { output: "diffuse", op: "mix", a: "mossGrained", b: "tuftColor", t: "tuftMask" },

        { output: "roughMoss", op: "constant", value: 0.8 },
        { output: "roughTuft", op: "constant", value: 0.75 },
        { output: "roughness", op: "mix", a: "roughMoss", b: "roughTuft", t: "tuftMask" },

        // Tufts genuinely stand proud of the mat, and the fine grain gives it a fuzzy micro-relief.
        { output: "mat", op: "scale", input: "mottleMask", factor: 0.25 },
        { output: "fuzz", op: "scale", input: "grainMask", factor: 0.2 },
        { output: "bed", op: "add", a: "mat", b: "fuzz" },
        { output: "tuftRelief", op: "scale", input: "tuftMask", factor: 0.55 },
        { output: "height", op: "add", a: "bed", b: "tuftRelief" },
      ],
      outputs: { diffuse: "diffuse", roughness: "roughness", height: "height" },
    },
  },
};

// A real physical composition rather than a two-tone tint: grass at ground level, with brown leaf
// clusters lying on top of it wherever a low-frequency blobby noise clears a threshold. The narrow
// mask span (0.15..0.45 of the blob noise) is what gives the clusters a defined, blob-like edge
// instead of a soft gradient, and they genuinely sit above the grass in the height output, so the
// bump reads them as raised litter.
const leafLitterMaterial: MaterialDef = {
  id: "leafLitter",
  name: "Leaf Litter",
  texture: {
    bumpStrength: 0.5,
    pipeline: {
      noises: [
        { name: "blobs", type: "fbm", octaves: 2, frequency: 0.02, amplitude: 1, persistence: 0.5, lacunarity: 2.0 },
        MOTTLE_NOISE,
      ],
      steps: [
        { output: "blobRaw", op: "sample", noise: "blobs" },
        ...maskSteps("blobRaw", 0.45, 0.15, "leafMask"),
        { output: "mottle", op: "sample", noise: "mottle" },
        ...maskSteps("mottle", MOTTLE_SPAN, -MOTTLE_SPAN, "mottleMask"),

        // Both the grass and the leaves get their own tonal variation from the shared mottle, so
        // neither reads as a flat sheet of color.
        { output: "grassDark", op: "color", value: [0.22, 0.33, 0.16] },
        { output: "grassLight", op: "color", value: [0.29, 0.42, 0.22] },
        { output: "grass", op: "mix", a: "grassDark", b: "grassLight", t: "mottleMask" },
        { output: "leafDark", op: "color", value: [0.28, 0.19, 0.09] },
        { output: "leafLight", op: "color", value: [0.42, 0.29, 0.14] },
        { output: "leaves", op: "mix", a: "leafDark", b: "leafLight", t: "mottleMask" },
        { output: "diffuse", op: "mix", a: "grass", b: "leaves", t: "leafMask" },

        { output: "roughGrass", op: "constant", value: 0.75 },
        { output: "roughLeaf", op: "constant", value: 0.8 },
        { output: "roughness", op: "mix", a: "roughGrass", b: "roughLeaf", t: "leafMask" },

        { output: "groundLevel", op: "scale", input: "mottleMask", factor: 0.15 },
        { output: "litter", op: "scale", input: "leafMask", factor: 0.85 },
        { output: "height", op: "add", a: "groundLevel", b: "litter" },
      ],
      outputs: { diffuse: "diffuse", roughness: "roughness", height: "height" },
    },
  },
};

const duneShadowMaterial: MaterialDef = {
  id: "duneShadow",
  name: "Dune Shadow",
  texture: twoToneTexture(new Color3(0.62, 0.52, 0.34), new Color3(0.72, 0.6, 0.4), 0.62, 1.75),
};

const screeMaterial: MaterialDef = {
  id: "scree",
  name: "Scree",
  texture: twoToneTexture(new Color3(0.42, 0.38, 0.32), new Color3(0.52, 0.47, 0.4), 0.88, 3.5),
};

const frostPatchMaterial: MaterialDef = {
  id: "frostPatch",
  name: "Frost Patch",
  texture: twoToneTexture(new Color3(0.72, 0.8, 0.84), new Color3(0.84, 0.9, 0.93), 0.4, 1.05),
};

// A second, warmer-toned rock so any steep slope in any biome shows two-rock variety instead of
// one flat texture - see rockAltLayer below.
const rockAltMaterial: MaterialDef = {
  id: "rockAlt",
  name: "Weathered Rock",
  texture: twoToneTexture(new Color3(0.4, 0.31, 0.26), new Color3(0.52, 0.42, 0.34), 0.9, 4.2),
};

// Lake-bed gravel for hills - see hillsLakeGravelLayer below. Cooler and smaller-grained-reading
// than rock/scree, since it's meant as a rounded lakebed material, not a boulder/rubble one.
const gravelMaterial: MaterialDef = {
  id: "gravel",
  name: "Gravel",
  texture: twoToneTexture(new Color3(0.5, 0.5, 0.47), new Color3(0.6, 0.6, 0.56), 0.85, 2.45),
};

/** Every material a biome can name as its `baseMaterialId` (biomeTypes.ts), keyed by MaterialDef
 *  id. Overlay-only materials (snow) live here too since materialLibrary.ts dedupes by id either way. */
export const MATERIAL_REGISTRY: Record<string, MaterialDef> = {
  grass: grassMaterial,
  rock: rockMaterial,
  sand: sandMaterial,
  snow: snowMaterial,
  tundraGround: tundraGroundMaterial,
  mud: mudMaterial,
};

export const DEFAULT_MATERIAL: MaterialDef = grassMaterial;

const rockLayer: MaterialLayer = {
  id: "rock",
  material: rockMaterial,
  weight: {
    noises: [],
    steps: [
      // Steeper than this (lower normalY) reads as bare rock, regardless of biome.
      { output: "slope", op: "input", name: "slope" },
      { output: "raw", op: "remap", input: "slope", inMin: 0.85, inMax: 0.55, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

// A second rock type in noise-selected patches, layered on top of rockLayer rather than
// partitioning it: this pipeline recomputes the exact same slope weight independently (no shared
// seed/complementary-mask trickery needed), then only inside patches picked by its own noise does
// it nudge that weight a hair above what rockLayer computes for the same point, winning there;
// everywhere else it's multiplied down to 0 and rockLayer wins as before.
const rockAltLayer: MaterialLayer = {
  id: "rock-alt",
  material: rockAltMaterial,
  weight: {
    noises: [{ name: "patch", type: "fbm", octaves: 2, frequency: 0.05, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
    steps: [
      { output: "slope", op: "input", name: "slope" },
      { output: "slopeRaw", op: "remap", input: "slope", inMin: 0.85, inMax: 0.55, outMin: 0, outMax: 1 },
      { output: "slopeW", op: "clamp", input: "slopeRaw", min: 0, max: 1 },
      { output: "patchNoise", op: "sample", noise: "patch" },
      { output: "maskRaw", op: "remap", input: "patchNoise", inMin: 0.15, inMax: 0.5, outMin: 0, outMax: 1 },
      { output: "mask", op: "clamp", input: "maskRaw", min: 0, max: 1 },
      { output: "boosted", op: "offset", input: "slopeW", amount: 0.01 },
      { output: "result", op: "multiply", a: "boosted", b: "mask" },
    ],
  },
};

const shoreLayer: MaterialLayer = {
  id: "shore",
  material: sandMaterial,
  weight: {
    noises: [],
    steps: [
      // Coastline/lake/river proximity - universal, not biome-gated.
      { output: "landmass", op: "input", name: "landmass" },
      { output: "coastRaw", op: "remap", input: "landmass", inMin: 0.2, inMax: -0.05, outMin: 0, outMax: 1 },
      { output: "coast", op: "clamp", input: "coastRaw", min: 0, max: 1 },
      { output: "lakeFactor", op: "input", name: "lakeFactor" },
      { output: "lakeRaw", op: "remap", input: "lakeFactor", inMin: 0, inMax: 0.5, outMin: 0, outMax: 1 },
      { output: "lake", op: "clamp", input: "lakeRaw", min: 0, max: 1 },
      // riverGap, not the flat isRiverEdge boolean - a river's carve can be up to
      // RIVER_WIDTH_MOUTH=100 world units wide (riverConfig.ts), but the sandy bank should only
      // hug the actual waterline, not the whole channel, so this needs its own much narrower fall-
      // off distance rather than treating "is this a river edge at all" as a flat yes/no.
      { output: "riverGap", op: "input", name: "riverGap" },
      { output: "riverRaw", op: "remap", input: "riverGap", inMin: 12, inMax: 0, outMin: 0, outMax: 1 },
      { output: "river", op: "clamp", input: "riverRaw", min: 0, max: 1 },
      { output: "coastOrLake", op: "max", a: "coast", b: "lake" },
      { output: "result", op: "max", a: "coastOrLake", b: "river" },
    ],
  },
};

// Snow only makes sense on specific biomes, and each biome's own height range is wildly different
// (tundra ~3.5-10.5, mountains ~20-100 - see biomeDefinitions.ts) so one global height threshold
// can't work for both; each biome below gets its own layer sharing the one `snowMaterial`, tuned
// to that biome's own height range. No biome-flag gate needed - PER_BIOME_MATERIAL_LAYERS below is
// itself the gate, so a mountains face never even evaluates tundra's layer or vice versa.
//
// Both layers do the same two things before their height remap: (1) sample a dedicated jitter
// noise and add it to height, so the snowline reads as an organically wavy band rather than a
// flat contour; (2) fold in reliefCurvature as a "valley" bias - a valley/basin (positive
// curvature) has its effective height nudged up, so snow clings to a real elevation lower than an
// open slope's there, while a ridge (negative curvature) gets nudged the other way and needs to
// climb higher to hold snow - snow drifts into and lingers in valleys, ridges wind-scour bare.
const snowTundraLayer: MaterialLayer = {
  id: "snow-tundra",
  material: snowMaterial,
  weight: {
    noises: [{ name: "snowline", type: "fbm", octaves: 2, frequency: 0.03, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
    steps: [
      { output: "height", op: "input", name: "height" },
      { output: "curvature", op: "input", name: "reliefCurvature" },
      { output: "valleyBias", op: "scale", input: "curvature", factor: 4 },
      { output: "biasedHeight", op: "add", a: "height", b: "valleyBias" },
      { output: "jitterRaw", op: "sample", noise: "snowline" },
      { output: "jitter", op: "scale", input: "jitterRaw", factor: 0.6 },
      { output: "effectiveHeight", op: "add", a: "biasedHeight", b: "jitter" },
      { output: "raw", op: "remap", input: "effectiveHeight", inMin: 7, inMax: 9.5, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

const snowMountainsLayer: MaterialLayer = {
  id: "snow-mountains",
  material: snowMaterial,
  weight: {
    noises: [{ name: "snowline", type: "fbm", octaves: 2, frequency: 0.03, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
    steps: [
      { output: "height", op: "input", name: "height" },
      { output: "curvature", op: "input", name: "reliefCurvature" },
      { output: "valleyBias", op: "scale", input: "curvature", factor: 2 },
      { output: "biasedHeight", op: "add", a: "height", b: "valleyBias" },
      { output: "jitterRaw", op: "sample", noise: "snowline" },
      { output: "jitter", op: "scale", input: "jitterRaw", factor: 4 },
      { output: "effectiveHeight", op: "add", a: "biasedHeight", b: "jitter" },
      { output: "raw", op: "remap", input: "effectiveHeight", inMin: 75, inMax: 95, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

// Plains-only ground variety. slopeFacing and reliefCurvature are both small, gentle signals on
// plains' own rolling hills (amplitude ~12.75), so these thresholds sit close to 0 rather than
// mirroring rock/snow's much steeper ones.
const plainsNorthFadeLayer: MaterialLayer = {
  id: "plains-north-fade",
  material: grassPaleMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "facing", op: "input", name: "slopeFacing" },
      { output: "raw", op: "remap", input: "facing", inMin: 0.08, inMax: 0.35, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

const plainsSouthDryLayer: MaterialLayer = {
  id: "plains-south-dry",
  material: grassDryMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "facing", op: "input", name: "slopeFacing" },
      { output: "facingSouth", op: "scale", input: "facing", factor: -1 },
      { output: "raw", op: "remap", input: "facingSouth", inMin: 0.08, inMax: 0.35, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

const plainsValleyWeedsLayer: MaterialLayer = {
  id: "plains-valley-weeds",
  material: weedsMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "curvature", op: "input", name: "reliefCurvature" },
      { output: "raw", op: "remap", input: "curvature", inMin: 0.3, inMax: 1.5, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

// Forest's detail amplitude (~40.45) is bigger than plains' (~12.75), so its slope/curvature
// thresholds are widened roughly proportionally - first-pass numbers like every other biome
// constant in this project, meant to be eyeballed and adjusted via FORCE_BIOME_ID.
const forestMossNorthLayer: MaterialLayer = {
  id: "forest-moss-north",
  material: mossMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "facing", op: "input", name: "slopeFacing" },
      { output: "raw", op: "remap", input: "facing", inMin: 0.08, inMax: 0.4, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

const forestLeafLitterValleyLayer: MaterialLayer = {
  id: "forest-leaf-litter-valley",
  material: leafLitterMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "curvature", op: "input", name: "reliefCurvature" },
      { output: "raw", op: "remap", input: "curvature", inMin: 0.05, inMax: 1.5, outMin: 0, outMax: 1.5 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

// Hills reuses plains' own faded/dry/weeds materials - same idea, just rethresholded for hills'
// much bigger detail amplitude (~60 vs plains' ~12.75).
const hillsNorthFadeLayer: MaterialLayer = {
  id: "hills-north-fade",
  material: grassPaleMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "facing", op: "input", name: "slopeFacing" },
      { output: "raw", op: "remap", input: "facing", inMin: 0.08, inMax: 0.4, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

const hillsSouthDryLayer: MaterialLayer = {
  id: "hills-south-dry",
  material: grassDryMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "facing", op: "input", name: "slopeFacing" },
      { output: "facingSouth", op: "scale", input: "facing", factor: -1 },
      { output: "raw", op: "remap", input: "facingSouth", inMin: 0.08, inMax: 0.4, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

const hillsValleyWeedsLayer: MaterialLayer = {
  id: "hills-valley-weeds",
  material: weedsMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "curvature", op: "input", name: "reliefCurvature" },
      { output: "raw", op: "remap", input: "curvature", inMin: 1.5, inMax: 6, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

// Hills dip low enough in places to drop below sea level, forming small lakes (see
// terrainSampler.ts's lakeFactor lerp toward LAKE_TARGET_HEIGHT) - the universal shoreLayer would
// otherwise ring every one of those in the same sand it uses for ocean coastlines, which reads
// wrong for a hillside pond. Both layers below deliberately out-weigh shoreLayer's own lake
// component (whose max is 1.0) at every point it's active, one on each side of the waterline:
// grassAtWaterline mirrors shoreLayer's exact lakeFactor ramp scaled up 1.5x (so it wins by a
// growing margin, never a flat epsilon that could lose ground on a steep part of the ramp), then
// fades out once truly underwater; gravelUnderwater ramps up over the same (complementary) handoff
// band as height drops below sea level. Both ceilings are 2.2, not just "> 1.0": since the two
// fade gates are complementary (sum to 1), the worst case is exactly at their midpoint where each
// only gets half its own ceiling - 2.2*0.5=1.1 still clears shoreLayer's max of 1.0 there, so
// there's no dead zone in the middle of the handoff where sand could still sneak through.
const hillsLakeShoreGrassLayer: MaterialLayer = {
  id: "hills-lake-shore-grass",
  material: grassMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "lakeFactor", op: "input", name: "lakeFactor" },
      { output: "lakeRaw", op: "remap", input: "lakeFactor", inMin: 0, inMax: 0.5, outMin: 0, outMax: 1 },
      { output: "lakeW", op: "clamp", input: "lakeRaw", min: 0, max: 1 },
      { output: "boosted", op: "scale", input: "lakeW", factor: 2.2 },
      { output: "height", op: "input", name: "height" },
      // SEA_LEVEL is 0 (areaField.ts) - fades this layer out over the last couple of units above
      // the waterline so it hands off to gravel cleanly instead of persisting underwater.
      { output: "aboveWaterRaw", op: "remap", input: "height", inMin: -2, inMax: 0.5, outMin: 0, outMax: 1 },
      { output: "aboveWater", op: "clamp", input: "aboveWaterRaw", min: 0, max: 1 },
      { output: "result", op: "multiply", a: "boosted", b: "aboveWater" },
    ],
  },
};

const hillsLakeGravelLayer: MaterialLayer = {
  id: "hills-lake-gravel",
  material: gravelMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "height", op: "input", name: "height" },
      { output: "underwaterRaw", op: "remap", input: "height", inMin: 0.5, inMax: -2, outMin: 0, outMax: 1 },
      { output: "underwater", op: "clamp", input: "underwaterRaw", min: 0, max: 1 },
      { output: "result", op: "scale", input: "underwater", factor: 2.2 },
    ],
  },
};

// Desert dunes: a shaded leeward face (reusing the same slopeFacing signal, just relabeled) and
// damp, darker sand pooling in the troughs between dunes - the latter reuses swamp's own mud
// material rather than a new texture, the same "share a MaterialDef across layers" trick as snow.
const desertDuneShadowLayer: MaterialLayer = {
  id: "desert-dune-shadow",
  material: duneShadowMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "facing", op: "input", name: "slopeFacing" },
      { output: "raw", op: "remap", input: "facing", inMin: 0.05, inMax: 0.3, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

const desertDampSandValleyLayer: MaterialLayer = {
  id: "desert-damp-sand-valley",
  material: mudMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "curvature", op: "input", name: "reliefCurvature" },
      { output: "raw", op: "remap", input: "curvature", inMin: 0.2, inMax: 1.0, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

// Ravines/gullies cutting into a mountainside collect loose rubble - distinct from the sheer-face
// rock the universal rockLayer already paints on any steep slope in any biome.
const mountainsScreeValleyLayer: MaterialLayer = {
  id: "mountains-scree-valley",
  material: screeMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "curvature", op: "input", name: "reliefCurvature" },
      { output: "raw", op: "remap", input: "curvature", inMin: 2, inMax: 8, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

// Tundra's detail amplitude (~2.1) is far gentler than plains' (~12.75), so its valley threshold
// is scaled down proportionally rather than reused as-is - a basin this shallow would never clear
// plains' own thresholds.
const tundraFrostValleyLayer: MaterialLayer = {
  id: "tundra-frost-valley",
  material: frostPatchMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "curvature", op: "input", name: "reliefCurvature" },
      { output: "raw", op: "remap", input: "curvature", inMin: 0.05, inMax: 0.25, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

// Canyon floors accumulate wind/water-blown silt - reuses the sand material rather than a new
// texture (the same sharing trick as snow and the desert valley layer above).
const canyonSiltValleyLayer: MaterialLayer = {
  id: "canyon-silt-valley",
  material: sandMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "curvature", op: "input", name: "reliefCurvature" },
      { output: "raw", op: "remap", input: "curvature", inMin: 3, inMax: 12, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

// Swamp is nearly flat (clamped detail noise), so its raised hummocks are subtle - reads as a
// negative reliefCurvature (a local high point) rather than the positive "valley" sign every
// other biome's layers look for. Reuses the plains grass material: dry ground poking through mud.
const swampGrassTuftRidgeLayer: MaterialLayer = {
  id: "swamp-grass-tuft-ridge",
  material: grassMaterial,
  weight: {
    noises: [],
    steps: [
      { output: "curvature", op: "input", name: "reliefCurvature" },
      { output: "ridge", op: "scale", input: "curvature", factor: -1 },
      { output: "raw", op: "remap", input: "ridge", inMin: 0.15, inMax: 0.6, outMin: 0, outMax: 1 },
      { output: "result", op: "clamp", input: "raw", min: 0, max: 1 },
    ],
  },
};

/** Layers checked on every face regardless of biome (kept few and cheap - this list's cost is
 *  paid at every single point in the world). */
export const UNIVERSAL_MATERIAL_LAYERS: MaterialLayer[] = [rockLayer, rockAltLayer, shoreLayer];

/** Layers checked only on faces whose own biome lists them, keyed by BiomeDefinition.id. This is
 *  what keeps per-face cost flat as more biomes grow their own layers: resolving a face only ever
 *  evaluates the universal list plus THIS biome's own (small) list, never every biome's layers put
 *  together - a mountains face never touches plains' rules and vice versa. */
export const PER_BIOME_MATERIAL_LAYERS: Record<string, MaterialLayer[]> = {
  plains: [plainsNorthFadeLayer, plainsSouthDryLayer, plainsValleyWeedsLayer],
  forest: [forestMossNorthLayer, forestLeafLitterValleyLayer],
  hills: [hillsNorthFadeLayer, hillsSouthDryLayer, hillsValleyWeedsLayer, hillsLakeShoreGrassLayer, hillsLakeGravelLayer],
  desert: [desertDuneShadowLayer, desertDampSandValleyLayer],
  mountains: [snowMountainsLayer, mountainsScreeValleyLayer],
  tundra: [snowTundraLayer, tundraFrostValleyLayer],
  canyon: [canyonSiltValleyLayer],
  swamp: [swampGrassTuftRidgeLayer],
};
