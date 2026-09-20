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
  const buckets = new Map<string, number[]>();

  function bucketKey(gx: number, gz: number): string {
    return `${gx},${gz}`;
  }

  points.forEach((point, index) => {
    const gx = Math.floor(point.x / cellSize);
    const gz = Math.floor(point.z / cellSize);
    const key = bucketKey(gx, gz);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(index);
    } else {
      buckets.set(key, [index]);
    }
  });

  function query(x: number, z: number): VoronoiQuery {
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    let secondNearestIndex = -1;
    let secondNearestDistance = Infinity;

    const centerGx = Math.floor(x / cellSize);
    const centerGz = Math.floor(z / cellSize);

    for (let ring = 0; ring <= MAX_RING; ring++) {
      for (let gx = centerGx - ring; gx <= centerGx + ring; gx++) {
        for (let gz = centerGz - ring; gz <= centerGz + ring; gz++) {
          const onRingEdge = Math.max(Math.abs(gx - centerGx), Math.abs(gz - centerGz)) === ring;
          if (!onRingEdge) continue;

          const bucket = buckets.get(bucketKey(gx, gz));
          if (!bucket) continue;

          for (const index of bucket) {
            const point = points[index];
            const dx = point.x - x;
            const dz = point.z - z;
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

      for (let gx = centerGx - ring; gx <= centerGx + ring; gx++) {
        for (let gz = centerGz - ring; gz <= centerGz + ring; gz++) {
          const onRingEdge = Math.max(Math.abs(gx - centerGx), Math.abs(gz - centerGz)) === ring;
          if (!onRingEdge) continue;

          const bucket = buckets.get(bucketKey(gx, gz));
          if (!bucket) continue;

          for (const index of bucket) {
            if (!accept(index)) continue;
            const point = points[index];
            const dx = point.x - x;
            const dz = point.z - z;
            const distSq = dx * dx + dz * dz;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              bestIndex = index;
            }
          }
        }
      }
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

      for (let gx = centerGx - ring; gx <= centerGx + ring; gx++) {
        for (let gz = centerGz - ring; gz <= centerGz + ring; gz++) {
          const onRingEdge = Math.max(Math.abs(gx - centerGx), Math.abs(gz - centerGz)) === ring;
          if (!onRingEdge) continue;

          const bucket = buckets.get(bucketKey(gx, gz));
          if (!bucket) continue;

          for (const index of bucket) {
            const point = points[index];
            const dx = point.x - x;
            const dz = point.z - z;
            const distSq = dx * dx + dz * dz;
            if (distSq > maxDistanceSq) continue;

            const group = groupOf(index);
            const best = nearestSqByGroup.get(group);
            if (best === undefined || distSq < best) {
              nearestSqByGroup.set(group, distSq);
            }
          }
        }
      }
    }

    const result = new Map<number, number>();
    for (const [group, distSq] of nearestSqByGroup) result.set(group, Math.sqrt(distSq));
    return result;
  }

  return { query, queryNearestWhere, queryNearestPerGroup };
}
