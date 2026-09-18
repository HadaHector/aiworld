import type { FloatArray } from "@babylonjs/core";
import type { TerrainSample } from "../terrain/terrainSampler";

// How far out (in grid steps) reliefCurvature looks for its "surrounding ground" average. 4 steps
// * (CHUNK_SIZE=50 / CHUNK_SUBDIVISIONS=20) = 10 world units - local enough to stay well inside
// one area/biome, wide enough to read as a hillside trend rather than just re-deriving slope from
// the immediately adjacent vertices. terrainMesh.ts pads its sampling grid by exactly this many
// extra rings on every side specifically so this never has to clamp at a chunk edge - a query
// index within RELIEF_CURVATURE_RADIUS_STEPS of the (padded) grid's own edge would previously read
// a clamped, slightly-wrong "surrounding ground" average there, which showed up as a visible seam
// in curvature-driven layers (valley snow, valley weeds) right at chunk boundaries once those
// layers started contributing to a smooth per-vertex blend instead of a single per-face pick.
export const RELIEF_CURVATURE_RADIUS_STEPS = 4;

/** A second-derivative-ish "how does this point's height compare to the ground around it" signal
 *  - the "derivative layer" a valley/ridge rule needs, since slope alone (the first derivative)
 *  can't tell a valley floor from a hillside partway up. Positive = local basin (valley), negative
 *  = local high point (ridge/hilltop). Clamps at the edge of whatever grid it's given - callers
 *  that need this to be accurate right up to a chunk's own boundary must pass a grid padded by at
 *  least RELIEF_CURVATURE_RADIUS_STEPS rings beyond what's actually rendered (see terrainMesh.ts),
 *  so the clamp never actually triggers for a real, rendered vertex. */
function computeReliefCurvature(positions: FloatArray, gridSize: number, vertexIndex: number): number {
  const row = Math.floor(vertexIndex / gridSize);
  const col = vertexIndex % gridSize;

  const heightAt = (r: number, c: number): number => {
    const clampedRow = Math.min(gridSize - 1, Math.max(0, r));
    const clampedCol = Math.min(gridSize - 1, Math.max(0, c));
    return positions[(clampedRow * gridSize + clampedCol) * 3 + 1];
  };

  const center = heightAt(row, col);
  const neighborAvg =
    (heightAt(row - RELIEF_CURVATURE_RADIUS_STEPS, col) +
      heightAt(row + RELIEF_CURVATURE_RADIUS_STEPS, col) +
      heightAt(row, col - RELIEF_CURVATURE_RADIUS_STEPS) +
      heightAt(row, col + RELIEF_CURVATURE_RADIUS_STEPS)) /
    4;

  return neighborAvg - center;
}

/**
 * A named-value bag for one vertex, consumed by material weight pipelines via the pipeline
 * engine's "input" step (pipeline/pipelineTypes.ts). Biome membership itself is NOT in here -
 * materialLibrary.ts's PER_BIOME_MATERIAL_LAYERS already scopes which layers run for a given
 * biome, so a layer never needs to check its own biome from inside the pipeline.
 */
export function buildVertexContext(
  positions: FloatArray,
  normals: FloatArray,
  samples: TerrainSample[],
  gridSize: number,
  vertexIndex: number,
): Record<string, number> {
  const sample = samples[vertexIndex];
  return {
    height: positions[vertexIndex * 3 + 1],
    slope: normals[vertexIndex * 3 + 1],
    // Sign is an arbitrary but fixed convention (positive = the slope's normal tilts toward -Z,
    // called "north" here) - there's no in-game compass/sun to anchor it to, only internal
    // consistency between this and the north/south material rules that read it.
    slopeFacing: -normals[vertexIndex * 3 + 2],
    landmass: sample.landmass,
    lakeFactor: sample.lakeFactor,
    riverGap: sample.riverGap,
    reliefCurvature: computeReliefCurvature(positions, gridSize, vertexIndex),
  };
}

