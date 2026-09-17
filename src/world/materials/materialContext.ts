import type { FloatArray } from "@babylonjs/core";
import type { TerrainSample } from "../terrain/terrainSampler";

// How far out (in grid steps of the chunk's own vertex grid) reliefCurvature looks for its
// "surrounding ground" average. 4 steps * (CHUNK_SIZE=50 / CHUNK_SUBDIVISIONS=20) = 10 world
// units - local enough to stay well inside one area/biome, wide enough to read as a hillside
// trend rather than just re-deriving slope from the immediately adjacent vertices.
const RELIEF_CURVATURE_RADIUS_STEPS = 4;

/** A second-derivative-ish "how does this point's height compare to the ground around it" signal
 *  - the "derivative layer" a valley/ridge rule needs, since slope alone (the first derivative)
 *  can't tell a valley floor from a hillside partway up. Reuses the chunk's own already-computed
 *  vertex height grid - no extra terrain sampling. Positive = local basin (valley), negative =
 *  local high point (ridge/hilltop), clamped to the chunk edge rather than crossing into it, which
 *  slightly under-reads curvature right at a chunk boundary (an accepted approximation, same
 *  caliber as the per-chunk normal seam from Milestone 4). */
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
 * A named-value bag for one triangle, consumed by material weight pipelines via the pipeline
 * engine's "input" step (pipeline/pipelineTypes.ts). Biome membership itself is NOT in here -
 * materialLibrary.ts's PER_BIOME_MATERIAL_LAYERS already scopes which layers run for a given
 * biome, so a layer never needs to check its own biome from inside the pipeline.
 */
export function buildFaceContext(
  positions: FloatArray,
  normals: FloatArray,
  samples: TerrainSample[],
  gridSize: number,
  i0: number,
  i1: number,
  i2: number,
): Record<string, number> {
  const indices = [i0, i1, i2];

  let height = 0;
  let slope = 0;
  let slopeFacing = 0;
  let landmass = 0;
  let lakeFactor = 0;
  let riverGap = Infinity;
  for (const i of indices) {
    height += positions[i * 3 + 1];
    slope += normals[i * 3 + 1];
    slopeFacing += normals[i * 3 + 2];
    landmass += samples[i].landmass;
    lakeFactor += samples[i].lakeFactor;
    // min, not average - averaging with Infinity (the "not a river edge" value) would wrongly
    // wash out a face that's genuinely close to the river just because one of its 3 vertices
    // isn't itself flagged as a river-edge cell pair.
    riverGap = Math.min(riverGap, samples[i].riverGap);
  }

  const context: Record<string, number> = {
    height: height / 3,
    slope: slope / 3,
    // Sign is an arbitrary but fixed convention (positive = the slope's normal tilts toward -Z,
    // called "north" here) - there's no in-game compass/sun to anchor it to, only internal
    // consistency between this and the north/south material rules that read it.
    slopeFacing: -(slopeFacing / 3),
    landmass: landmass / 3,
    lakeFactor: lakeFactor / 3,
    riverGap,
    reliefCurvature: computeReliefCurvature(positions, gridSize, i0),
  };

  return context;
}
