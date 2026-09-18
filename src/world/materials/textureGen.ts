import { Color3 } from "@babylonjs/core";
import { compilePipeline } from "../terrain/pipeline/pipelineCompiler";
import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";

export const TEXTURE_RESOLUTION = 256;

/** One paint layer contributing to a material's texture. `height` is this layer's own local
 *  surface elevation (roughly 0..1 by convention, like weight pipelines elsewhere in this project
 *  are conventionally clamped 0..1) - reused for BOTH which layer shows at a pixel (the locally
 *  tallest layer wins, see writeProceduralTexturePixels) and the bump/normal map, which is derived
 *  from the gradient of the final COMPOSITED height, never a separately-authored signal. */
export interface TexturePaintLayer {
  id: string;
  color: Color3;
  /** 0 = smooth/shiny, 1 = fully matte. Not physically-calibrated - a relative dial, tuned by eye. */
  roughness: number;
  height: PipelineDef;
}

export interface TextureDef {
  /** layers[0] is conventionally the base - typically a flat/near-flat height that every other
   *  layer has to rise above to show through. */
  layers: TexturePaintLayer[];
  /** How sharply a locally-taller layer takes over from its neighbors, in the same height units
   *  the layers' own pipelines output. Large (relative to the layers' height spread) gives a soft,
   *  continuous, all-over blend; small gives sharp, discrete, blob-edged patches. */
  heightBlendRange: number;
  /** How pronounced this material's baked-in bump (normal map) reads - 0 disables it. */
  bumpStrength: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface CompiledPaintLayer {
  color: Color3;
  roughness: number;
  evaluate: (x: number, y: number) => number;
}

// One composite cell = [r, g, b, roughness, height].
const COMPOSITE_STRIDE = 5;

/** Height-blends every layer at one grid cell into `grid` (at `cellIndex * COMPOSITE_STRIDE`): the
 *  locally tallest layer wins outright, and every other layer fades to 0 over `heightBlendRange`
 *  below that max - the standard real-time-terrain "height blend" technique, applied here at
 *  texture-pixel scale (materialLibrary.ts's world-scale material blend uses the same "fade below
 *  the winner" shape of idea, just with additive weights rather than height). Always sums to 1 -
 *  the tallest layer's raw contribution is always exactly 1. Writes in place (no per-call
 *  allocation) since this runs once per grid cell across every material's whole bake. */
function compositeInto(grid: Float64Array, cellIndex: number, layers: CompiledPaintLayer[], heightBlendRange: number, heightsScratch: Float64Array, x: number, y: number): void {
  let maxHeight = -Infinity;
  for (let i = 0; i < layers.length; i++) {
    const h = layers[i].evaluate(x, y);
    heightsScratch[i] = h;
    if (h > maxHeight) maxHeight = h;
  }

  // Two passes over the (small, fixed-size) layer list: every raw contribution must be known
  // before it can be normalized by their sum, so the weighted accumulation below has to come
  // after this loop, not fused into it.
  let rawSum = 0;
  for (let i = 0; i < layers.length; i++) {
    rawSum += clamp01((heightsScratch[i] - maxHeight) / heightBlendRange + 1);
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let roughness = 0;
  let height = 0;
  for (let i = 0; i < layers.length; i++) {
    const raw = clamp01((heightsScratch[i] - maxHeight) / heightBlendRange + 1);
    const weight = raw / rawSum;
    r += layers[i].color.r * weight;
    g += layers[i].color.g * weight;
    b += layers[i].color.b * weight;
    roughness += layers[i].roughness * weight;
    height += heightsScratch[i] * weight;
  }

  const idx = cellIndex * COMPOSITE_STRIDE;
  grid[idx] = r;
  grid[idx + 1] = g;
  grid[idx + 2] = b;
  grid[idx + 3] = roughness;
  grid[idx + 4] = height;
}

/** Writes one material's tileable, layered-noise textures (no image assets, matching this
 *  project's fully-procedural convention) into layer `layerIndex` of two shared buffers sized for
 *  a pair of `RawTexture2DArray`s (materialLibrary.ts) - every material's textures are one layer of
 *  each combined array texture, so the terrain shader can sample any of them via one pair of
 *  samplers. Deterministic per (seed, materialId).
 *
 *  `colorBuffer` gets RGB color (height-blended across `texture.layers`) plus roughness baked into
 *  the otherwise-unused alpha channel. `normalBuffer` gets a tangent-space normal map derived from
 *  the gradient of the SAME composited height field, scaled by `texture.bumpStrength`, plus the
 *  composited height itself baked into its own unused alpha channel - not consumed by anything
 *  yet, but there for a future height-based blend between different materials at world scale.
 *
 *  The gradient needs each pixel's composite plus its right/down neighbor's - computed once into a
 *  (RESOLUTION+1)-per-side grid up front (each cell composited exactly once) rather than
 *  recomputing the center/right/down composite independently per pixel (which would redundantly
 *  re-evaluate most cells 3x, since a pixel's "right" is its neighbor's "center"). */
export function writeProceduralTexturePixels(colorBuffer: Uint8Array, normalBuffer: Uint8Array, layerIndex: number, seed: number, materialId: string, texture: TextureDef): void {
  const compiledLayers: CompiledPaintLayer[] = texture.layers.map((layer) => ({
    color: layer.color,
    roughness: layer.roughness,
    // tilePeriod is what makes the bake seamless: every noise in the layer becomes exactly periodic
    // over one texture tile, so the pixel at RESOLUTION-1 genuinely neighbors the pixel at 0. Before
    // this, the wrap was a hard discontinuity in both color and normals, and because
    // TEXTURE_WORLD_TILE_SIZE divides CHUNK_SIZE it landed exactly on chunk boundaries - which is
    // what the "chunk border seams" turned out to be.
    evaluate: compilePipeline(layer.height, seed, `texture-${materialId}-${layer.id}`, { tilePeriod: TEXTURE_RESOLUTION }),
  }));

  const gridSize = TEXTURE_RESOLUTION + 1;
  const grid = new Float64Array(gridSize * gridSize * COMPOSITE_STRIDE);
  const heightsScratch = new Float64Array(compiledLayers.length);

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      compositeInto(grid, gy * gridSize + gx, compiledLayers, texture.heightBlendRange, heightsScratch, gx, gy);
    }
  }

  const layerOffset = layerIndex * TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;

  for (let y = 0; y < TEXTURE_RESOLUTION; y++) {
    for (let x = 0; x < TEXTURE_RESOLUTION; x++) {
      const centerIdx = (y * gridSize + x) * COMPOSITE_STRIDE;
      const rightIdx = (y * gridSize + (x + 1)) * COMPOSITE_STRIDE;
      const downIdx = ((y + 1) * gridSize + x) * COMPOSITE_STRIDE;

      const pixelIndex = layerOffset + (y * TEXTURE_RESOLUTION + x) * 4;
      colorBuffer[pixelIndex] = clamp01(grid[centerIdx]) * 255;
      colorBuffer[pixelIndex + 1] = clamp01(grid[centerIdx + 1]) * 255;
      colorBuffer[pixelIndex + 2] = clamp01(grid[centerIdx + 2]) * 255;
      colorBuffer[pixelIndex + 3] = clamp01(grid[centerIdx + 3]) * 255;

      const centerHeight = grid[centerIdx + 4];
      const dx = grid[rightIdx + 4] - centerHeight;
      const dy = grid[downIdx + 4] - centerHeight;
      const nx = -dx * texture.bumpStrength;
      const ny = -dy * texture.bumpStrength;
      const nz = 1;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);

      normalBuffer[pixelIndex] = (nx * invLen * 0.5 + 0.5) * 255;
      normalBuffer[pixelIndex + 1] = (ny * invLen * 0.5 + 0.5) * 255;
      normalBuffer[pixelIndex + 2] = (nz * invLen * 0.5 + 0.5) * 255;
      normalBuffer[pixelIndex + 3] = clamp01(centerHeight) * 255;
    }
  }
}
