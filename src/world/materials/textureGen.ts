import { compileOutputs } from "../terrain/pipeline/pipelineCompiler";
import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";

export const TEXTURE_RESOLUTION = 1024;

/** Used when a texture's pipeline declares no `roughness` output. Matte-ish, matching the bulk of
 *  this project's ground materials. */
const DEFAULT_ROUGHNESS = 0.8;

/**
 * A material's surface, as one pipeline producing several named outputs.
 *
 * The pipeline's `outputs` map keywords to step names:
 *  - `diffuse` (required, color) - the albedo.
 *  - `roughness` (optional, scalar) - 0 = smooth/shiny, 1 = fully matte. Defaults to
 *    DEFAULT_ROUGHNESS. Not physically-calibrated; a relative dial tuned by eye.
 *  - `height` (optional, scalar) - the surface's own elevation, used to derive the bump/normal
 *    map and stored in the normal texture's alpha for the terrain's height blend - re-centred there
 *    so the material's typical surface (its median height) sits at 0.5, cracks below, bumps above
 *    (see storedHeightShift). Nothing depends on it for visibility, so a recessed feature is authored
 *    simply by making its height low - e.g. a crack can be dark *and* a groove. That was impossible
 *    under the earlier paint-layer design, where a feature could only show where it was the tallest
 *    layer, which silently baked every dark crack as a raised ridge.
 *
 *    Only the stored alpha is clamped to 0..1; the bump reads the raw values. Since the stored
 *    height is re-centred, not rescaled, what matters for the blend is the spread: cracks reaching
 *    about 0.5 below the typical surface and bumps 0.5 above use the whole range.
 */
export interface TextureDef {
  pipeline: PipelineDef;
  /** How pronounced the baked bump reads - 0 disables it. */
  bumpStrength: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The resolution every authored `bumpStrength` is calibrated against. The bump comes from the
 * height difference between *adjacent pixels*, so the same feature on a finer grid produces
 * proportionally smaller steps - without this, raising TEXTURE_RESOLUTION would silently flatten
 * every normal map in the project rather than just sharpening it.
 */
const BUMP_REFERENCE_RESOLUTION = 256;

/**
 * Writes one material's tileable textures (no image assets, matching this project's fully-procedural
 * convention) into layer `layerIndex` of two shared buffers sized for a pair of `RawTexture2DArray`s
 * (materialLibrary.ts). Deterministic per (seed, materialId).
 *
 * `colorBuffer` gets the `diffuse` output plus `roughness` baked into the otherwise-unused alpha
 * channel. `normalBuffer` gets a tangent-space normal map derived from the gradient of the `height`
 * output, scaled by `texture.bumpStrength`, plus that height itself in its own alpha channel, its
 * median moved to 0.5, for the terrain's height blend between materials (materialLibrary.ts's
 * heightShare).
 *
 * The gradient reads each pixel's right/down neighbour, wrapping with `& (RESOLUTION-1)` at the
 * edge. That wrap is exact rather than approximate because the pipeline's noise is compiled
 * periodic over the tile (see tilePeriod below), so pixel RESOLUTION genuinely *is* pixel 0 - which
 * is what lets this run on a plain RESOLUTION² grid instead of the padded one it needed before.
 */
export function writeProceduralTexturePixels(colorBuffer: Uint8Array, normalBuffer: Uint8Array, layerIndex: number, seed: number, materialId: string, texture: TextureDef): void {
  // tilePeriod is what makes the bake seamless: every noise becomes exactly periodic over one
  // texture tile, so the wrap is just another interior pixel boundary. Without it the wrap is a
  // hard discontinuity in both color and normals, and because TEXTURE_WORLD_TILE_SIZE divides
  // CHUNK_SIZE it lands exactly on chunk boundaries - which is what "chunk border seams" were.
  const compiled = compileOutputs(texture.pipeline, seed, `texture-${materialId}`, { tilePeriod: TEXTURE_RESOLUTION });

  const diffuse = compiled.output("diffuse");
  if (diffuse === undefined || diffuse.type !== "color") {
    throw new Error(`Material "${materialId}" texture pipeline must declare a color "diffuse" output`);
  }
  const roughness = compiled.output("roughness");
  if (roughness !== undefined && roughness.type !== "scalar") {
    throw new Error(`Material "${materialId}" texture pipeline's "roughness" output must be a scalar`);
  }
  const height = compiled.output("height");
  if (height !== undefined && height.type !== "scalar") {
    throw new Error(`Material "${materialId}" texture pipeline's "height" output must be a scalar`);
  }

  const { slots, run } = compiled;
  const pixelCount = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION;
  const layerOffset = layerIndex * pixelCount * 4;
  const heights = new Float64Array(pixelCount);

  for (let y = 0; y < TEXTURE_RESOLUTION; y++) {
    for (let x = 0; x < TEXTURE_RESOLUTION; x++) {
      run(x, y);

      const pixelIndex = layerOffset + (y * TEXTURE_RESOLUTION + x) * 4;
      colorBuffer[pixelIndex] = clamp01(slots[diffuse.offset]) * 255;
      colorBuffer[pixelIndex + 1] = clamp01(slots[diffuse.offset + 1]) * 255;
      colorBuffer[pixelIndex + 2] = clamp01(slots[diffuse.offset + 2]) * 255;
      colorBuffer[pixelIndex + 3] = clamp01(roughness === undefined ? DEFAULT_ROUGHNESS : slots[roughness.offset]) * 255;

      heights[y * TEXTURE_RESOLUTION + x] = height === undefined ? 0 : slots[height.offset];
    }
  }

  const shift = storedHeightShift(heights);
  const wrap = TEXTURE_RESOLUTION - 1;
  const bumpGain = texture.bumpStrength * (TEXTURE_RESOLUTION / BUMP_REFERENCE_RESOLUTION);
  for (let y = 0; y < TEXTURE_RESOLUTION; y++) {
    for (let x = 0; x < TEXTURE_RESOLUTION; x++) {
      const centerHeight = heights[y * TEXTURE_RESOLUTION + x];
      const dx = heights[y * TEXTURE_RESOLUTION + ((x + 1) & wrap)] - centerHeight;
      const dy = heights[(((y + 1) & wrap) * TEXTURE_RESOLUTION) + x] - centerHeight;
      const nx = -dx * bumpGain;
      const ny = -dy * bumpGain;
      const nz = 1;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);

      const pixelIndex = layerOffset + (y * TEXTURE_RESOLUTION + x) * 4;
      normalBuffer[pixelIndex] = (nx * invLen * 0.5 + 0.5) * 255;
      normalBuffer[pixelIndex + 1] = (ny * invLen * 0.5 + 0.5) * 255;
      normalBuffer[pixelIndex + 2] = (nz * invLen * 0.5 + 0.5) * 255;
      normalBuffer[pixelIndex + 3] = clamp01(centerHeight + shift) * 255;
    }
  }
}

/**
 * How far to move a material's heights so its median - the typical surface, neither crack nor
 * bump - lands on 0.5. Every material then meets every other on the same baseline in the height
 * blend, so a material authored low or high does not win or lose everywhere, only where its own
 * cracks and bumps are. Moved, never stretched: a flat material stays flat.
 */
function storedHeightShift(heights: Float64Array): number {
  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  if (max - min < 1e-9) return 0.5 - min;
  // The median from a fine histogram - to well within one stored step, and far cheaper than a sort.
  const bins = new Uint32Array(4096);
  const perBin = bins.length / (max - min);
  for (const h of heights) bins[Math.min(bins.length - 1, Math.floor((h - min) * perBin))]++;
  let seen = 0;
  for (let i = 0; i < bins.length; i++) {
    seen += bins[i];
    if (seen * 2 >= heights.length) return 0.5 - (min + (i + 0.5) / perBin);
  }
  return 0.5 - max;
}
