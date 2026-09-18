import { Color3 } from "@babylonjs/core";
import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { TextureDef } from "./textureGen";

export interface MaterialDef {
  id: string;
  name: string;
  texture: TextureDef;
}

// The same fine-grained mottling noise every simple two-tone material used before this project's
// texture-pipeline milestone - kept as one shared pipeline (safe to reuse: compilePipeline seeds
// each call from its own namespace string, not from this object's identity) so a plain two-color
// material stays a one-liner. heightBlendRange=0.85 was picked numerically, not guessed: a
// height-blend's contrast doesn't fall out of the noise's own amplitude the way a linear lerp's
// does, so this is the value whose baked pixel std-dev matches the old `clamp(raw*0.5+0.5)` lerp's
// (measured ~60.6 either way, at this noise's own params) - visual parity with the pre-pipeline
// look, confirmed numerically rather than by eye alone.
const MOTTLE_HEIGHT_PIPELINE: PipelineDef = {
  noises: [{ name: "detail", type: "fbm", octaves: 3, frequency: 0.05, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
  steps: [{ output: "result", op: "sample", noise: "detail" }],
};
const FLAT_ZERO_HEIGHT_PIPELINE: PipelineDef = { noises: [], steps: [{ output: "result", op: "constant", value: 0 }] };
const TWO_TONE_HEIGHT_BLEND_RANGE = 0.85;

// A second, higher-frequency fbm layer - same shape as MOTTLE_HEIGHT_PIPELINE, just a tighter
// grain, for materials that read as too soft/blurry with only one (broad) noise scale in play.
const FINE_GRAIN_HEIGHT_PIPELINE: PipelineDef = {
  noises: [{ name: "grain", type: "fbm", octaves: 2, frequency: 0.18, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
  steps: [{ output: "result", op: "sample", noise: "grain" }],
};

// A third, lower-frequency fbm layer for gentle, large-area tonal shifts (sun-bleached patches,
// soft shadowing) - broader and gentler than MOTTLE_HEIGHT_PIPELINE, meant to read as a big, soft
// area of slightly different tone, not a repeating close-up pattern.
const BROAD_TONE_HEIGHT_PIPELINE: PipelineDef = {
  noises: [{ name: "broad", type: "fbm", octaves: 2, frequency: 0.012, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
  steps: [{ output: "result", op: "sample", noise: "broad" }],
};

/** A natural, non-directional crack/fracture network (see WorleyNoiseSpec in pipelineTypes.ts) -
 *  the "edge" mode is near 0 exactly along a cell boundary and grows away from it, so remapping it
 *  with inMin above inMax (here inMax=0) inverts the sense: right on a boundary -> full height,
 *  a little off it -> 0 and below. Deliberately not ridged noise: ridged's creases follow the
 *  underlying gradient field and read as directional waves, not the irregular polygonal fracture
 *  pattern real cracked rock/mud actually shows. */
function crackHeightPipeline(frequency: number, edgeWidth: number, peak: number): PipelineDef {
  return {
    noises: [{ name: "web", type: "worley", frequency, amplitude: 1, mode: "edge" }],
    steps: [
      { output: "raw", op: "sample", noise: "web" },
      { output: "result", op: "remap", input: "raw", inMin: edgeWidth, inMax: 0, outMin: 0, outMax: peak },
    ],
  };
}

/** Rounded, grain/pebble-like blobs centered on each cell's own point (see WorleyNoiseSpec's "f1"
 *  mode) - a more geometric, grain-like shape than billow's soft blobs, better suited to actual
 *  small stones/pebbles than an organic growth pattern like lichen or moss tufts. */
function grainHeightPipeline(frequency: number, radius: number, peak: number): PipelineDef {
  return {
    noises: [{ name: "grain", type: "worley", frequency, amplitude: 1, mode: "f1" }],
    steps: [
      { output: "raw", op: "sample", noise: "grain" },
      { output: "result", op: "remap", input: "raw", inMin: radius, inMax: 0, outMin: 0, outMax: peak },
    ],
  };
}

/** A plain two-color mottled material, expressed as a (degenerate, 2-layer) texture pipeline -
 *  the base color sits at a flat height, the variation color rises and falls with the shared
 *  mottling noise above/below it, and a wide heightBlendRange keeps the result close to a smooth
 *  continuous lerp rather than sharp patches. See leafLitterMaterial below for a texture that
 *  actually exploits per-layer height/shape instead of just migrating the old two-tone look. */
function twoToneTexture(baseColor: Color3, variationColor: Color3, roughness: number, bumpStrength: number): TextureDef {
  return {
    layers: [
      { id: "base", color: baseColor, roughness, height: FLAT_ZERO_HEIGHT_PIPELINE },
      { id: "variation", color: variationColor, roughness, height: MOTTLE_HEIGHT_PIPELINE },
    ],
    heightBlendRange: TWO_TONE_HEIGHT_BLEND_RANGE,
    bumpStrength,
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
  texture: twoToneTexture(new Color3(0.28, 0.42, 0.2), new Color3(0.38, 0.55, 0.28), 0.75, 0.4),
};

// Every accent layer below shares heightBlendRange with the calibrated mottle layer
// (TWO_TONE_HEIGHT_BLEND_RANGE) rather than getting its own smaller range - a smaller blendRange
// would also sharpen the mottle layer itself (its ~-1.75..1.75 spread was specifically calibrated
// against 0.85, see twoToneTexture's comment), turning the familiar soft mottling into a harsh,
// high-contrast patchwork as a side effect. Instead each accent's own height output is scaled well
// past the mottle's own peak (~1.75) - roughly to 3+, comfortably outside blendRange's reach of it
// - so it reliably wins where it's meant to show, without having to touch the shared blend range.
//
// Rock: the usual mottle, a second FINER grain layer (fbm at a much higher frequency - the broad
// mottle alone read as too soft/uniform, this adds actual close-up detail), natural crack lines
// (Worley "edge" - an irregular fracture network, not ridged noise's directional creases), and
// sparse lichen patches (billow, an organic growth shape rather than a geometric one).
const rockMaterial: MaterialDef = {
  id: "rock",
  name: "Rock",
  texture: {
    layers: [
      { id: "base", color: new Color3(0.35, 0.33, 0.32), roughness: 0.88, height: FLAT_ZERO_HEIGHT_PIPELINE },
      { id: "mottle", color: new Color3(0.48, 0.46, 0.44), roughness: 0.9, height: MOTTLE_HEIGHT_PIPELINE },
      { id: "grain", color: new Color3(0.4, 0.38, 0.37), roughness: 0.92, height: FINE_GRAIN_HEIGHT_PIPELINE },
      { id: "cracks", color: new Color3(0.13, 0.12, 0.11), roughness: 0.95, height: crackHeightPipeline(0.02, 0.13, 2.8) },
      {
        id: "lichen",
        color: new Color3(0.43, 0.47, 0.32),
        roughness: 0.82,
        height: {
          noises: [{ name: "patches", type: "billow", octaves: 2, frequency: 0.025, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
          steps: [
            { output: "raw", op: "sample", noise: "patches" },
            { output: "norm", op: "remap", input: "raw", inMin: 0.3, inMax: 1.3, outMin: 0, outMax: 3 },
            { output: "result", op: "clamp", input: "norm", min: 0, max: 3 },
          ],
        },
      },
    ],
    heightBlendRange: TWO_TONE_HEIGHT_BLEND_RANGE,
    bumpStrength: 1.1,
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
    layers: [
      { id: "base", color: new Color3(0.76, 0.68, 0.48), roughness: 0.6, height: FLAT_ZERO_HEIGHT_PIPELINE },
      { id: "mottle", color: new Color3(0.86, 0.78, 0.58), roughness: 0.6, height: MOTTLE_HEIGHT_PIPELINE },
      { id: "broadTone", color: new Color3(0.7, 0.61, 0.42), roughness: 0.58, height: BROAD_TONE_HEIGHT_PIPELINE },
      { id: "grains", color: new Color3(0.44, 0.37, 0.26), roughness: 0.82, height: grainHeightPipeline(0.12, 0.4, 3) },
    ],
    heightBlendRange: TWO_TONE_HEIGHT_BLEND_RANGE,
    bumpStrength: 0.5,
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
    layers: [
      { id: "base", color: new Color3(0.92, 0.93, 0.96), roughness: 0.35, height: FLAT_ZERO_HEIGHT_PIPELINE },
      { id: "mottle", color: new Color3(0.98, 0.99, 1.0), roughness: 0.35, height: MOTTLE_HEIGHT_PIPELINE },
      { id: "broadShading", color: new Color3(0.83, 0.87, 0.94), roughness: 0.32, height: BROAD_TONE_HEIGHT_PIPELINE },
      {
        id: "glints",
        color: new Color3(1.0, 1.0, 1.0),
        roughness: 0.12,
        height: {
          noises: [{ name: "sparkle", type: "billow", octaves: 2, frequency: 0.22, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
          steps: [
            { output: "raw", op: "sample", noise: "sparkle" },
            { output: "norm", op: "remap", input: "raw", inMin: 1.1, inMax: 1.5, outMin: 0, outMax: 3 },
            { output: "result", op: "clamp", input: "norm", min: 0, max: 3 },
          ],
        },
      },
    ],
    heightBlendRange: TWO_TONE_HEIGHT_BLEND_RANGE,
    bumpStrength: 0.3,
  },
};

const tundraGroundMaterial: MaterialDef = {
  id: "tundraGround",
  name: "Tundra Ground",
  texture: twoToneTexture(new Color3(0.52, 0.56, 0.52), new Color3(0.68, 0.71, 0.68), 0.8, 0.5),
};

// Mud: the usual mottle, a web of dry-cracked-mud fractures (Worley "edge" - the textbook natural
// use for cellular noise, an irregular polygonal crack network, not ridged noise's directional
// creases), and darker, notably glossier wet patches (billow, broad, with a much lower roughness
// than the surrounding dry mud).
const mudMaterial: MaterialDef = {
  id: "mud",
  name: "Mud",
  texture: {
    layers: [
      { id: "base", color: new Color3(0.22, 0.19, 0.13), roughness: 0.55, height: FLAT_ZERO_HEIGHT_PIPELINE },
      { id: "mottle", color: new Color3(0.33, 0.34, 0.2), roughness: 0.55, height: MOTTLE_HEIGHT_PIPELINE },
      { id: "cracks", color: new Color3(0.14, 0.11, 0.07), roughness: 0.7, height: crackHeightPipeline(0.015, 0.16, 2.8) },
      {
        id: "wetPatches",
        color: new Color3(0.15, 0.13, 0.09),
        roughness: 0.22,
        height: {
          noises: [{ name: "damp", type: "billow", octaves: 2, frequency: 0.03, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
          steps: [
            { output: "raw", op: "sample", noise: "damp" },
            { output: "result", op: "remap", input: "raw", inMin: 0.2, inMax: 1.3, outMin: 0, outMax: 3 },
          ],
        },
      },
    ],
    heightBlendRange: TWO_TONE_HEIGHT_BLEND_RANGE,
    bumpStrength: 0.5,
  },
};

// Plains-only variety layers (see the north/south/valley layers below) - never a biome's base, so
// not registered in MATERIAL_REGISTRY, only referenced directly by their MaterialLayer.
const grassPaleMaterial: MaterialDef = {
  id: "grassPale",
  name: "Faded Grass",
  texture: twoToneTexture(new Color3(0.48, 0.54, 0.4), new Color3(0.58, 0.63, 0.48), 0.75, 0.4),
};

const grassDryMaterial: MaterialDef = {
  id: "grassDry",
  name: "Dry Grass",
  texture: twoToneTexture(new Color3(0.56, 0.5, 0.26), new Color3(0.66, 0.58, 0.34), 0.75, 0.4),
};

const weedsMaterial: MaterialDef = {
  id: "weeds",
  name: "Weeds",
  texture: twoToneTexture(new Color3(0.13, 0.2, 0.09), new Color3(0.2, 0.3, 0.15), 0.78, 0.45),
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
    layers: [
      { id: "base", color: new Color3(0.16, 0.26, 0.2), roughness: 0.8, height: FLAT_ZERO_HEIGHT_PIPELINE },
      { id: "mottle", color: new Color3(0.22, 0.36, 0.28), roughness: 0.8, height: MOTTLE_HEIGHT_PIPELINE },
      { id: "grain", color: new Color3(0.19, 0.31, 0.24), roughness: 0.82, height: FINE_GRAIN_HEIGHT_PIPELINE },
      {
        id: "tufts",
        color: new Color3(0.3, 0.44, 0.3),
        roughness: 0.75,
        height: {
          noises: [{ name: "clumps", type: "billow", octaves: 2, frequency: 0.1, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
          steps: [
            { output: "raw", op: "sample", noise: "clumps" },
            { output: "norm", op: "remap", input: "raw", inMin: 0.5, inMax: 1.4, outMin: 0, outMax: 3 },
            { output: "result", op: "clamp", input: "norm", min: 0, max: 3 },
          ],
        },
      },
    ],
    heightBlendRange: TWO_TONE_HEIGHT_BLEND_RANGE,
    bumpStrength: 0.6,
  },
};

// The flagship example for this project's layered texture pipeline: not a mechanical two-tone
// migration like the materials above, but a real physical composition - a grass-green base at a
// flat, low height, with brown leaf clusters that actually rise above it wherever a low-frequency,
// blobby noise clears a threshold. A narrow heightBlendRange (relative to the leaf layer's own
// 0..0.85 height range) gives the clusters a defined, blob-like edge instead of a soft tint
// gradient, and bumpStrength gives the raised clusters a genuine, visible bump (see
// writeProceduralTexturePixels - bump comes from the gradient of this same composited height).
const leafLitterMaterial: MaterialDef = {
  id: "leafLitter",
  name: "Leaf Litter",
  texture: {
    layers: [
      { id: "grass", color: new Color3(0.26, 0.38, 0.19), roughness: 0.75, height: { noises: [], steps: [{ output: "result", op: "constant", value: 0.3 }] } },
      {
        id: "leaves",
        color: new Color3(0.34, 0.24, 0.11),
        roughness: 0.8,
        height: {
          noises: [{ name: "blobs", type: "fbm", octaves: 2, frequency: 0.02, amplitude: 1, persistence: 0.5, lacunarity: 2.0 }],
          steps: [
            { output: "raw", op: "sample", noise: "blobs" },
            { output: "result", op: "remap", input: "raw", inMin: -0.3, inMax: 0.6, outMin: 0, outMax: 0.85 },
          ],
        },
      },
    ],
    heightBlendRange: 0.2,
    bumpStrength: 0.5,
  },
};

const duneShadowMaterial: MaterialDef = {
  id: "duneShadow",
  name: "Dune Shadow",
  texture: twoToneTexture(new Color3(0.62, 0.52, 0.34), new Color3(0.72, 0.6, 0.4), 0.62, 0.5),
};

const screeMaterial: MaterialDef = {
  id: "scree",
  name: "Scree",
  texture: twoToneTexture(new Color3(0.42, 0.38, 0.32), new Color3(0.52, 0.47, 0.4), 0.88, 1.0),
};

const frostPatchMaterial: MaterialDef = {
  id: "frostPatch",
  name: "Frost Patch",
  texture: twoToneTexture(new Color3(0.72, 0.8, 0.84), new Color3(0.84, 0.9, 0.93), 0.4, 0.3),
};

// A second, warmer-toned rock so any steep slope in any biome shows two-rock variety instead of
// one flat texture - see rockAltLayer below.
const rockAltMaterial: MaterialDef = {
  id: "rockAlt",
  name: "Weathered Rock",
  texture: twoToneTexture(new Color3(0.4, 0.31, 0.26), new Color3(0.52, 0.42, 0.34), 0.9, 1.2),
};

// Lake-bed gravel for hills - see hillsLakeGravelLayer below. Cooler and smaller-grained-reading
// than rock/scree, since it's meant as a rounded lakebed material, not a boulder/rubble one.
const gravelMaterial: MaterialDef = {
  id: "gravel",
  name: "Gravel",
  texture: twoToneTexture(new Color3(0.5, 0.5, 0.47), new Color3(0.6, 0.6, 0.56), 0.85, 0.7),
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
