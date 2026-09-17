import { Color3 } from "@babylonjs/core";
import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { ProceduralTextureParams } from "./textureGen";

export interface MaterialDef {
  id: string;
  name: string;
  texture: ProceduralTextureParams;
}

/** A rule tying one MaterialDef to a weight pipeline. Several layers may point at the same
 *  MaterialDef (see the two snow layers below) - the material and the rule that selects it are
 *  deliberately separate. */
export interface MaterialLayer {
  id: string;
  material: MaterialDef;
  weight: PipelineDef;
}

// Continues this project's salt-numbering convention (cells/config.ts 601-618, terrainSampler.ts
// 402, boundaryHillsConfig.ts 611-612) in a new 701+ range for material texture noise.
const grassMaterial: MaterialDef = {
  id: "grass",
  name: "Grass",
  texture: { baseColor: new Color3(0.28, 0.42, 0.2), variationColor: new Color3(0.38, 0.55, 0.28), salt: 701 },
};

const rockMaterial: MaterialDef = {
  id: "rock",
  name: "Rock",
  texture: { baseColor: new Color3(0.35, 0.33, 0.32), variationColor: new Color3(0.48, 0.46, 0.44), salt: 702 },
};

const sandMaterial: MaterialDef = {
  id: "sand",
  name: "Sand",
  texture: { baseColor: new Color3(0.76, 0.68, 0.48), variationColor: new Color3(0.86, 0.78, 0.58), salt: 703 },
};

const snowMaterial: MaterialDef = {
  id: "snow",
  name: "Snow",
  texture: { baseColor: new Color3(0.92, 0.93, 0.96), variationColor: new Color3(0.98, 0.99, 1.0), salt: 704 },
};

const tundraGroundMaterial: MaterialDef = {
  id: "tundraGround",
  name: "Tundra Ground",
  texture: { baseColor: new Color3(0.52, 0.56, 0.52), variationColor: new Color3(0.68, 0.71, 0.68), salt: 705 },
};

const mudMaterial: MaterialDef = {
  id: "mud",
  name: "Mud",
  texture: { baseColor: new Color3(0.22, 0.19, 0.13), variationColor: new Color3(0.33, 0.34, 0.2), salt: 706 },
};

// Plains-only variety layers (see the north/south/valley layers below) - never a biome's base, so
// not registered in MATERIAL_REGISTRY, only referenced directly by their MaterialLayer.
const grassPaleMaterial: MaterialDef = {
  id: "grassPale",
  name: "Faded Grass",
  texture: { baseColor: new Color3(0.48, 0.54, 0.4), variationColor: new Color3(0.58, 0.63, 0.48), salt: 707 },
};

const grassDryMaterial: MaterialDef = {
  id: "grassDry",
  name: "Dry Grass",
  texture: { baseColor: new Color3(0.56, 0.5, 0.26), variationColor: new Color3(0.66, 0.58, 0.34), salt: 708 },
};

const weedsMaterial: MaterialDef = {
  id: "weeds",
  name: "Weeds",
  texture: { baseColor: new Color3(0.13, 0.2, 0.09), variationColor: new Color3(0.2, 0.3, 0.15), salt: 709 },
};

const mossMaterial: MaterialDef = {
  id: "moss",
  name: "Moss",
  texture: { baseColor: new Color3(0.16, 0.26, 0.2), variationColor: new Color3(0.22, 0.36, 0.28), salt: 710 },
};

const leafLitterMaterial: MaterialDef = {
  id: "leafLitter",
  name: "Leaf Litter",
  texture: { baseColor: new Color3(0.32, 0.24, 0.1), variationColor: new Color3(0.42, 0.34, 0.16), salt: 711 },
};

const duneShadowMaterial: MaterialDef = {
  id: "duneShadow",
  name: "Dune Shadow",
  texture: { baseColor: new Color3(0.62, 0.52, 0.34), variationColor: new Color3(0.72, 0.6, 0.4), salt: 712 },
};

const screeMaterial: MaterialDef = {
  id: "scree",
  name: "Scree",
  texture: { baseColor: new Color3(0.42, 0.38, 0.32), variationColor: new Color3(0.52, 0.47, 0.4), salt: 713 },
};

const frostPatchMaterial: MaterialDef = {
  id: "frostPatch",
  name: "Frost Patch",
  texture: { baseColor: new Color3(0.72, 0.8, 0.84), variationColor: new Color3(0.84, 0.9, 0.93), salt: 714 },
};

// A second, warmer-toned rock so any steep slope in any biome shows two-rock variety instead of
// one flat texture - see rockAltLayer below.
const rockAltMaterial: MaterialDef = {
  id: "rockAlt",
  name: "Weathered Rock",
  texture: { baseColor: new Color3(0.4, 0.31, 0.26), variationColor: new Color3(0.52, 0.42, 0.34), salt: 715 },
};

// Lake-bed gravel for hills - see hillsLakeGravelLayer below. Cooler and smaller-grained-reading
// than rock/scree, since it's meant as a rounded lakebed material, not a boulder/rubble one.
const gravelMaterial: MaterialDef = {
  id: "gravel",
  name: "Gravel",
  texture: { baseColor: new Color3(0.5, 0.5, 0.47), variationColor: new Color3(0.6, 0.6, 0.56), salt: 716 },
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
      { output: "raw", op: "remap", input: "curvature", inMin: 0.5, inMax: 2.5, outMin: 0, outMax: 1 },
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
