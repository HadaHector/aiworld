import type { CellPoint } from "../cells/cellGrid";
import type { RoadLink } from "./roadNetwork";
import { ROAD_MESH_POINT_SPACING } from "./roadConfig";

/** A contiguous run of road centreline inside one chunk, with one point of overlap at each end so
 *  neighbouring chunks' ribbons meet exactly. */
export interface RoadRun {
  points: CellPoint[];
  /** Arc length of this run's first point along its whole road, so a texture running down the road
   *  is continuous across chunk boundaries rather than restarting in each one. */
  arcOffset: number;
}

export interface RoadChunkIndex {
  runsIn(chunkX: number, chunkZ: number): RoadRun[];
  /** Total points held, for reporting what the index actually costs. */
  pointCount: number;
}

function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

/**
 * Resamples every road to a fixed spacing and files the pieces by chunk.
 *
 * Two reasons for the resample rather than using the stored polyline directly. The ribbon is draped
 * over the terrain by sampling its height at every vertex, so it needs vertices often enough to
 * follow the ground rather than cut through it - the stored line has points every 7 units on
 * average but hundreds apart on a straight with no wander. And a stored segment can cross a chunk
 * without either of its endpoints being inside it, which would leave a hole in that chunk's ribbon;
 * at a spacing well under the chunk size that cannot happen.
 *
 * Each run carries one point beyond its chunk at each end. A ribbon vertex is built from the
 * tangent at its centreline point, so two chunks that both hold a boundary point compute the same
 * vertex for it only if they can both see its neighbours - without the overlap the ribbon would
 * kink and part at every chunk edge.
 */
export function createRoadChunkIndex(links: RoadLink[], chunkSize: number): RoadChunkIndex {
  const cells = new Map<number, RoadRun[]>();
  let pointCount = 0;

  for (const link of links) {
    // Resample the whole road first, so spacing is uniform across chunk boundaries too.
    const dense: CellPoint[] = [];
    const arcs: number[] = [];
    let travelled = 0;
    for (let i = 0; i < link.points.length - 1; i++) {
      const a = link.points[i];
      const b = link.points[i + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length <= 0) continue;
      const steps = Math.max(1, Math.ceil(length / ROAD_MESH_POINT_SPACING));
      for (let k = 0; k < steps; k++) {
        const u = k / steps;
        dense.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
        arcs.push(travelled + length * u);
      }
      travelled += length;
    }
    if (dense.length < 2) continue;
    dense.push(link.points[link.points.length - 1]);
    arcs.push(travelled);

    // Walk the resampled line, cutting a run wherever it leaves the chunk it was in.
    let runStart = 0;
    let runCx = Math.floor(dense[0].x / chunkSize);
    let runCz = Math.floor(dense[0].z / chunkSize);

    const emit = (from: number, to: number, cx: number, cz: number): void => {
      const first = Math.max(0, from - 1);
      const last = Math.min(dense.length - 1, to + 1);
      if (last - first < 1) return;
      const run: RoadRun = { points: dense.slice(first, last + 1), arcOffset: arcs[first] };
      pointCount += run.points.length;
      const key = cellKey(cx, cz);
      const existing = cells.get(key);
      if (existing) existing.push(run);
      else cells.set(key, [run]);
    };

    for (let i = 1; i < dense.length; i++) {
      const cx = Math.floor(dense[i].x / chunkSize);
      const cz = Math.floor(dense[i].z / chunkSize);
      if (cx !== runCx || cz !== runCz) {
        emit(runStart, i - 1, runCx, runCz);
        runStart = i;
        runCx = cx;
        runCz = cz;
      }
    }
    emit(runStart, dense.length - 1, runCx, runCz);
  }

  return {
    runsIn: (chunkX, chunkZ) => cells.get(cellKey(chunkX, chunkZ)) ?? [],
    pointCount,
  };
}
