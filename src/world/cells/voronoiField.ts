export interface VoronoiPoint {
  x: number;
  z: number;
}

export interface VoronoiQuery {
  nearestIndex: number;
  nearestDistance: number;
  secondNearestIndex: number;
  secondNearestDistance: number;
}

export interface VoronoiNearest {
  index: number;
  distance: number;
}

export interface VoronoiField {
  query(x: number, z: number): VoronoiQuery;
  /**
   * Nearest point satisfying `accept`, or `{ index: -1, distance: Infinity }` if there is none
   * within `maxDistance`.
   *
   * Unlike `query`'s second-nearest, this is a min over a *fixed* subset of points, so it varies
   * continuously with position even where the identity of the winning point changes - which is
   * what makes it usable as the basis of a smooth falloff. `maxDistance` bounds the ring search:
   * without it, a query from deep inside a large region would expand outward until it found
   * something, which is exactly where the answer does not matter.
   */
  queryNearestWhere(x: number, z: number, accept: (index: number) => boolean, maxDistance: number): VoronoiNearest;
  /**
   * The distance to the nearest point of EACH distinct group within `maxDistance`, keyed by group
   * id - one sweep rather than one query per group.
   *
   * Each entry is a minimum over a fixed subset of points, so it varies continuously with position
   * even where the winning point within a group changes. That is what makes these usable as blend
   * weights: a group's distance grows smoothly as its region recedes, so it can fade out rather
   * than pop out. Unlike queryNearestWhere this cannot stop at its first hit - it has to sweep the
   * whole radius to be sure it has seen every group.
   */
  queryNearestPerGroup(x: number, z: number, groupOf: (index: number) => number, maxDistance: number): Map<number, number>;
}

const MAX_RING = 12;

/** Generic nearest/second-nearest seed-point lookup, bucketed into a grid for fast queries. */
export function createVoronoiField(points: VoronoiPoint[], cellSize: number): VoronoiField {
  // The buckets: a dense grid over the points' extent, each bucket a run of `order` (point indices,
  // in the order they were given) from `start` for `count` - integers all the way, since a query
  // visits dozens of buckets and building a string key for each was most of its cost.
  let minGx = Infinity, maxGx = -Infinity, minGz = Infinity, maxGz = -Infinity;
  const gxOf = new Int32Array(points.length);
  const gzOf = new Int32Array(points.length);
  points.forEach((point, index) => {
    const gx = Math.floor(point.x / cellSize);
    const gz = Math.floor(point.z / cellSize);
    gxOf[index] = gx;
    gzOf[index] = gz;
    minGx = Math.min(minGx, gx); maxGx = Math.max(maxGx, gx);
    minGz = Math.min(minGz, gz); maxGz = Math.max(maxGz, gz);
  });
  if (points.length === 0) minGx = maxGx = minGz = maxGz = 0;
  const columns = maxGx - minGx + 1;
  const rows = maxGz - minGz + 1;
  const count = new Int32Array(columns * rows);
  for (let i = 0; i < points.length; i++) count[(gzOf[i] - minGz) * columns + (gxOf[i] - minGx)]++;
  const start = new Int32Array(columns * rows);
  for (let b = 1; b < start.length; b++) start[b] = start[b - 1] + count[b - 1];
  const order = new Int32Array(points.length);
  const filled = new Int32Array(columns * rows);
  for (let i = 0; i < points.length; i++) {
    const b = (gzOf[i] - minGz) * columns + (gxOf[i] - minGx);
    order[start[b] + filled[b]++] = i;
  }
  const px = Float64Array.from(points, (p) => p.x);
  const pz = Float64Array.from(points, (p) => p.z);

  /** The bucket at grid (gx, gz), or -1 off the grid or where it is empty. */
  function bucketAt(gx: number, gz: number): number {
    if (gx < minGx || gx > maxGx || gz < minGz || gz > maxGz) return -1;
    const b = (gz - minGz) * columns + (gx - minGx);
    return count[b] > 0 ? b : -1;
  }

  /**
   * Every bucket on the edge of the square ring `ring` round (cx, cz), in the order a sweep of the
   * whole square would meet them - x, then z, rising - but without visiting its inside.
   */
  function forEachRingBucket(cx: number, cz: number, ring: number, visit: (bucket: number) => void): void {
    for (let gx = cx - ring; gx <= cx + ring; gx++) {
      const edgeColumn = gx === cx - ring || gx === cx + ring;
      if (edgeColumn || ring === 0) {
        for (let gz = cz - ring; gz <= cz + ring; gz++) {
          const b = bucketAt(gx, gz);
          if (b >= 0) visit(b);
        }
      } else {
        const low = bucketAt(gx, cz - ring);
        if (low >= 0) visit(low);
        const high = bucketAt(gx, cz + ring);
        if (high >= 0) visit(high);
      }
    }
  }

  function query(x: number, z: number): VoronoiQuery {
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    let secondNearestIndex = -1;
    let secondNearestDistance = Infinity;

    const centerGx = Math.floor(x / cellSize);
    const centerGz = Math.floor(z / cellSize);

    for (let ring = 0; ring <= MAX_RING; ring++) {
      // The ring's edge, as forEachRingBucket walks it - written out here, the hottest loop there is.
      for (let gx = centerGx - ring; gx <= centerGx + ring; gx++) {
        const edgeColumn = ring === 0 || gx === centerGx - ring || gx === centerGx + ring;
        for (let gz = centerGz - ring; gz <= centerGz + ring; gz += edgeColumn ? 1 : 2 * ring) {
          if (gx < minGx || gx > maxGx || gz < minGz || gz > maxGz) continue;
          const b = (gz - minGz) * columns + (gx - minGx);
          for (let k = start[b], end = start[b] + count[b]; k < end; k++) {
            const index = order[k];
            const dx = px[index] - x;
            const dz = pz[index] - z;
            const distSq = dx * dx + dz * dz;

            if (distSq < nearestDistance) {
              secondNearestDistance = nearestDistance;
              secondNearestIndex = nearestIndex;
              nearestDistance = distSq;
              nearestIndex = index;
            } else if (distSq < secondNearestDistance) {
              secondNearestDistance = distSq;
              secondNearestIndex = index;
            }
          }
        }
      }

      const ringBound = ring * cellSize;
      if (ringBound * ringBound >= secondNearestDistance) {
        break;
      }
    }

    return {
      nearestIndex,
      nearestDistance: Number.isFinite(nearestDistance) ? Math.sqrt(nearestDistance) : Infinity,
      secondNearestIndex,
      secondNearestDistance: Number.isFinite(secondNearestDistance) ? Math.sqrt(secondNearestDistance) : Infinity,
    };
  }

  function queryNearestWhere(x: number, z: number, accept: (index: number) => boolean, maxDistance: number): VoronoiNearest {
    let bestIndex = -1;
    let bestDistSq = Infinity;

    const centerGx = Math.floor(x / cellSize);
    const centerGz = Math.floor(z / cellSize);
    const maxDistanceSq = maxDistance * maxDistance;

    for (let ring = 0; ring <= MAX_RING; ring++) {
      // Lower bound on the distance to anything in this ring or beyond. It is (ring - 1), not
      // ring: the query point sits somewhere inside its own bucket, so a point just across the
      // boundary of an adjacent bucket can be arbitrarily close. Using `ring` here skipped the
      // neighbouring buckets entirely whenever maxDistance was smaller than one bucket - which,
      // with CELL_SPACING-scale buckets far larger than the boundary-hill reach, was always.
      const ringBound = Math.max(0, ring - 1) * cellSize;
      if (ringBound * ringBound >= Math.min(bestDistSq, maxDistanceSq)) break;

      forEachRingBucket(centerGx, centerGz, ring, (b) => {
        for (let k = start[b], end = start[b] + count[b]; k < end; k++) {
          const index = order[k];
          if (!accept(index)) continue;
          const dx = px[index] - x;
          const dz = pz[index] - z;
          const distSq = dx * dx + dz * dz;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestIndex = index;
          }
        }
      });
    }

    if (bestDistSq > maxDistanceSq) return { index: -1, distance: Infinity };
    return { index: bestIndex, distance: Math.sqrt(bestDistSq) };
  }

  function queryNearestPerGroup(x: number, z: number, groupOf: (index: number) => number, maxDistance: number): Map<number, number> {
    const nearestSqByGroup = new Map<number, number>();

    const centerGx = Math.floor(x / cellSize);
    const centerGz = Math.floor(z / cellSize);
    const maxDistanceSq = maxDistance * maxDistance;

    for (let ring = 0; ring <= MAX_RING; ring++) {
      // Same (ring - 1) lower bound as queryNearestWhere - see the note there. There is no
      // best-so-far to bound against here, since every group still has to be found.
      const ringBound = Math.max(0, ring - 1) * cellSize;
      if (ringBound * ringBound >= maxDistanceSq) break;

      forEachRingBucket(centerGx, centerGz, ring, (b) => {
        for (let k = start[b], end = start[b] + count[b]; k < end; k++) {
          const index = order[k];
          const dx = px[index] - x;
          const dz = pz[index] - z;
          const distSq = dx * dx + dz * dz;
          if (distSq > maxDistanceSq) continue;

          const group = groupOf(index);
          const best = nearestSqByGroup.get(group);
          if (best === undefined || distSq < best) {
            nearestSqByGroup.set(group, distSq);
          }
        }
      });
    }

    const result = new Map<number, number>();
    for (const [group, distSq] of nearestSqByGroup) result.set(group, Math.sqrt(distSq));
    return result;
  }

  return { query, queryNearestWhere, queryNearestPerGroup };
}
