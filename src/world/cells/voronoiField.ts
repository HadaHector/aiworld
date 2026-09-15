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

export interface VoronoiField {
  query(x: number, z: number): VoronoiQuery;
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

  return { query };
}
