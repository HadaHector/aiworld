import type { CellPoint } from "./cellGrid";

export interface RiverQuery {
  /** True distance to the nearest river centreline, or `Infinity` past the search radius. */
  distance: number;
  /** Arc-length position along that river, 0 at its mouth and 1 at its source. */
  taper: number;
}

export interface RiverField {
  query(x: number, z: number): RiverQuery;
  /** Every centreline, for the debug map and for tests. Mouth first. */
  polylines: ReadonlyArray<ReadonlyArray<CellPoint>>;
}

interface Segment {
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  lengthSq: number;
  /** Arc-length fractions of this segment's two ends along its own river. */
  t0: number;
  t1: number;
}

/**
 * Buckets are sized so that every segment lands in few of them while a query only ever has to look
 * at ONE. That works because each segment is registered in every bucket its bounding box reaches
 * after being grown by the search radius - so a bucket holds everything that could possibly be
 * within range of any point inside it, and the query needs no ring search at all. Rivers are sparse
 * (a couple of hundred segments in the whole world), so the duplication is trivial and the
 * overwhelmingly common answer - "no river anywhere near here" - costs exactly one failed lookup.
 */
const BUCKET_SIZE = 1000;
const KEY_OFFSET = 1 << 15;
const KEY_STRIDE = 1 << 16;

function bucketKey(gx: number, gz: number): number {
  return (gx + KEY_OFFSET) * KEY_STRIDE + (gz + KEY_OFFSET);
}

/**
 * Distance to a set of river centrelines, as real geometry rather than as a property of the cell
 * diagram underneath them.
 *
 * Rivers used to be carved along Voronoi seams, identified by "are this point's two nearest cells
 * exactly this river's pair". That had two fatal properties. It is a *predicate on cell identity*,
 * so it flips abruptly - measured, 20% of those flips were a height step over 5 units, some over
 * 100, because the valley was still at full depth where the flip happened. And consecutive seams of
 * a path only touch when the path's cells i and i+2 happen to be adjacent, which is true about a
 * third of the time: measured over 10 seeds, 745 of 1166 river bends (63.9%) were a break, so
 * rivers were never continuous in the first place. One measured river was nine separate stretches
 * of water with dry barriers up to 109 units high between them.
 *
 * A polyline has neither problem. Distance to it is defined and continuous everywhere, so there is
 * no gate to flip, and the line is connected by construction, so there are no joints to miss.
 */
export function createRiverField(polylines: CellPoint[][], searchRadius: number): RiverField {
  const buckets = new Map<number, Segment[]>();
  const kept: CellPoint[][] = [];

  for (const polyline of polylines) {
    if (polyline.length < 2) continue;

    const lengths: number[] = [];
    let total = 0;
    for (let i = 0; i < polyline.length - 1; i++) {
      const length = Math.hypot(polyline[i + 1].x - polyline[i].x, polyline[i + 1].z - polyline[i].z);
      lengths.push(length);
      total += length;
    }
    if (total <= 0) continue;
    kept.push(polyline);

    let travelled = 0;
    for (let i = 0; i < polyline.length - 1; i++) {
      const a = polyline[i];
      const b = polyline[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segment: Segment = {
        x0: a.x,
        z0: a.z,
        dx,
        dz,
        lengthSq: dx * dx + dz * dz,
        t0: travelled / total,
        t1: (travelled + lengths[i]) / total,
      };
      travelled += lengths[i];
      if (segment.lengthSq <= 0) continue;

      const gxMin = Math.floor((Math.min(a.x, b.x) - searchRadius) / BUCKET_SIZE);
      const gxMax = Math.floor((Math.max(a.x, b.x) + searchRadius) / BUCKET_SIZE);
      const gzMin = Math.floor((Math.min(a.z, b.z) - searchRadius) / BUCKET_SIZE);
      const gzMax = Math.floor((Math.max(a.z, b.z) + searchRadius) / BUCKET_SIZE);
      for (let gx = gxMin; gx <= gxMax; gx++) {
        for (let gz = gzMin; gz <= gzMax; gz++) {
          const key = bucketKey(gx, gz);
          const bucket = buckets.get(key);
          if (bucket) bucket.push(segment);
          else buckets.set(key, [segment]);
        }
      }
    }
  }

  const searchRadiusSq = searchRadius * searchRadius;

  function query(x: number, z: number): RiverQuery {
    const bucket = buckets.get(bucketKey(Math.floor(x / BUCKET_SIZE), Math.floor(z / BUCKET_SIZE)));
    if (!bucket) return { distance: Infinity, taper: 0 };

    let bestDistSq = Infinity;
    let bestTaper = 0;
    for (const segment of bucket) {
      // Closest point on the segment, clamped to its ends - which is what rounds the outside of a
      // bend and keeps the inside of it sharp, exactly as a real channel cutting a corner does.
      const px = x - segment.x0;
      const pz = z - segment.z0;
      const u = Math.min(1, Math.max(0, (px * segment.dx + pz * segment.dz) / segment.lengthSq));
      const ox = px - u * segment.dx;
      const oz = pz - u * segment.dz;
      const distSq = ox * ox + oz * oz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestTaper = segment.t0 + (segment.t1 - segment.t0) * u;
      }
    }

    if (bestDistSq > searchRadiusSq) return { distance: Infinity, taper: 0 };
    return { distance: Math.sqrt(bestDistSq), taper: bestTaper };
  }

  return { query, polylines: kept };
}
