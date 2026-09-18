import { compileOutputs } from "../terrain/pipeline/pipelineCompiler";
import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";

export const TEXTURE_RESOLUTION = 256;

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
 *  - `height` (optional, scalar) - the surface's own elevation, **by convention spanning 0..1**,
 *    used to derive the bump/normal map and stashed in the normal texture's alpha for a future
 *    world-scale blend. Nothing depends on it for visibility, so a recessed feature is authored
 *    simply by making its height low - e.g. a crack can be dark *and* a groove. That was impossible
 *    under the earlier paint-layer design, where a feature could only show where it was the tallest
 *    layer, which silently baked every dark crack as a raised ridge.
 *
 *    Only the stored alpha is clamped to 0..1; the bump reads the raw values, so straying outside
 *    the range costs nothing visually today - but it throws away the signal the future world-scale
 *    blend will want, which is why the convention is worth holding to.
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
 * Writes one material's tileable textures (no image assets, matching this project's fully-procedural
 * convention) into layer `layerIndex` of two shared buffers sized for a pair of `RawTexture2DArray`s
 * (materialLibrary.ts). Deterministic per (seed, materialId).
 *
 * `colorBuffer` gets the `diffuse` output plus `roughness` baked into the otherwise-unused alpha
 * channel. `normalBuffer` gets a tangent-space normal map derived from the gradient of the `height`
 * output, scaled by `texture.bumpStrength`, plus that height itself in its own alpha channel - not
 * consumed by anything yet, but there for a future height-based blend between materials at world
 * scale.
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

  const wrap = TEXTURE_RESOLUTION - 1;
  for (let y = 0; y < TEXTURE_RESOLUTION; y++) {
    for (let x = 0; x < TEXTURE_RESOLUTION; x++) {
      const centerHeight = heights[y * TEXTURE_RESOLUTION + x];
      const dx = heights[y * TEXTURE_RESOLUTION + ((x + 1) & wrap)] - centerHeight;
      const dy = heights[(((y + 1) & wrap) * TEXTURE_RESOLUTION) + x] - centerHeight;
      const nx = -dx * texture.bumpStrength;
      const ny = -dy * texture.bumpStrength;
      const nz = 1;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);

      const pixelIndex = layerOffset + (y * TEXTURE_RESOLUTION + x) * 4;
      normalBuffer[pixelIndex] = (nx * invLen * 0.5 + 0.5) * 255;
      normalBuffer[pixelIndex + 1] = (ny * invLen * 0.5 + 0.5) * 255;
      normalBuffer[pixelIndex + 2] = (nz * invLen * 0.5 + 0.5) * 255;
      normalBuffer[pixelIndex + 3] = clamp01(centerHeight) * 255;
    }
  }
}
