import { deriveSeed } from "../../rng";
import { smoothstep } from "../../mathUtils";
import { createBaseNoise2D } from "../noise";
import { compilePipeline, type CompiledPipeline } from "../pipeline/pipelineCompiler";
import type { BoundaryHillStyle } from "../../biomes/biomeTypes";
import {
  BOUNDARY_HILL_WIDTH,
  BOUNDARY_HILL_PEAK_HEIGHT,
  BOUNDARY_HILL_EDGE_NOISE_FREQUENCY,
  BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE,
  BOUNDARY_HILL_EDGE_NOISE_SALT,
} from "./boundaryHillsConfig";

export type BoundaryHillEvaluator = (style: BoundaryHillStyle | null, borderGap: number, worldX: number, worldZ: number) => number;

function compileBoundaryHillPipelines(seed: number, styles: BoundaryHillStyle[]): Map<string, CompiledPipeline> {
  const compiled = new Map<string, CompiledPipeline>();
  for (const style of styles) {
    compiled.set(style.id, compilePipeline(style.heightPipeline, seed, `boundary-${style.id}`));
  }
  return compiled;
}

/** Compiles all boundary-hill styles once per world, returning a per-position evaluator. */
export function createBoundaryHillEvaluator(seed: number, styles: BoundaryHillStyle[]): BoundaryHillEvaluator {
  const compiledStyles = compileBoundaryHillPipelines(seed, styles);
  // Dedicated, independent from areaField.ts's coastNoise2D - the hill's outer edge should wobble
  // on its own, not as a scaled copy of the coastline/area-border jitter.
  const edgeNoise2D = createBaseNoise2D(deriveSeed(seed, BOUNDARY_HILL_EDGE_NOISE_SALT));

  return function evaluateBoundaryHill(style: BoundaryHillStyle | null, borderGap: number, worldX: number, worldZ: number): number {
    if (style === null) return 0;

    const jitter =
      edgeNoise2D(worldX * BOUNDARY_HILL_EDGE_NOISE_FREQUENCY, worldZ * BOUNDARY_HILL_EDGE_NOISE_FREQUENCY) *
      BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE;
    // Smooth, symmetric, zero-slope at its own peak (border) and at the width edge - a proper bell,
    // not a pointy tent.
    const bell = 1 - smoothstep(0, BOUNDARY_HILL_WIDTH, borderGap + jitter);
    if (bell <= 0) return 0;

    // Two separate additive layers, not one noise field tapered by the bell: a guaranteed smooth
    // bump (bell * peak height) gives the hill its silhouette regardless of what the noise happens
    // to be doing at that point, and the style's own noise rides on top for surface texture - still
    // scaled by the same bell so it stays localized to the border and fades to 0 at the same edge,
    // rather than leaking its texture out past the intended width.
    const bump = bell * BOUNDARY_HILL_PEAK_HEIGHT;
    const texture = bell * compiledStyles.get(style.id)!(worldX, worldZ);
    return bump + texture;
  };
}
