import type { CellPoint } from "../cells/cellGrid";

/** Anything the ground is graded to and painted as road: countryside roads and settlement streets. */
export interface RoadLine {
  points: CellPoint[];
  heights: number[];
  /** How wide this line is next to a countryside road (1): its level ground, painted surface and
   *  verge all scale with it. Streets are narrower. */
  widthScale?: number;
  /** False for a line that joins another at its ends (a road at a gate, a street at a junction),
   *  whose grading must not fade out there. */
  taperEnds?: boolean;
}

export interface RoadQuery {
  /** Distance to the nearest road centreline in countryside-road units: the true distance divided
   *  by that line's widthScale, so everything keyed on it - grading, the painted surface, grass and
   *  tree clearance - narrows with the line. Infinity past the search radius. */
  distance: number;
  /** The road surface height there - the smoothed profile, not the ground under it. */
  height: number;
  /** 0 at either end of the road, 1 once clear of both. What lets a road's grading die away
   *  instead of leaving a step where the road stops. */
  taper: number;
}

const MISS: RoadQuery = { distance: Infinity, height: 0, taper: 0 };


interface Segment {
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  lengthSq: number;
  h0: number;
  h1: number;
  /** Arc length of this segment's two ends along its own road. */
  a0: number;
  a1: number;
  total: number;
  /** 1 / widthScale: multiplies true distance into countryside-road units. */
  inverseWidth: number;
  taperEnds: boolean;
}

/**
 * Buckets much smaller than riverField's.
 *
 * Same construction - a segment goes into every bucket its bounding box reaches once grown by the
 * search radius, so a query is one lookup and no ring search - but roads are two orders of
 * magnitude denser than rivers: 82792 points against a few hundred. At riverField's 1000-unit
 * bucket a single bucket in road country would hold a couple of thousand segments and every
 * terrain sample would test all of them. At 100 a bucket spans its own width plus the radius
 * either side, which is a couple of hundred units of road - a few dozen segments.
 */
const BUCKET_SIZE = 100;
const KEY_OFFSET = 1 << 15;
const KEY_STRIDE = 1 << 16;

function bucketKey(gx: number, gz: number): number {
  return (gx + KEY_OFFSET) * KEY_STRIDE + (gz + KEY_OFFSET);
}

export interface RoadField {
  query(x: number, z: number): RoadQuery;
  /** Segments held, for reporting what the index costs. */
  segmentCount: number;
}

/**
 * Distance to the nearest road, and the height that road's surface has there.
 *
 * The same shape as riverField, and for the same reason: a distance to a real polyline is defined
 * and continuous everywhere, so terrain can be graded toward a road as a smooth function of it with
 * no gate to flip. The addition is that this carries the road's own surface height, because a road
 * is not a depth to subtract from the ground - it is a level the ground is brought to.
 */
export function createRoadField(links: RoadLine[], searchRadius: number, endTaper: number): RoadField {
  const buckets = new Map<number, Segment[]>();
  let segmentCount = 0;

  for (const link of links) {
    const points = link.points;
    const heights = link.heights;
    if (points.length < 2 || heights.length !== points.length) continue;

    const lengths: number[] = [];
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const length = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
      lengths.push(length);
      total += length;
    }
    if (total <= 0) continue;

    let travelled = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      const segment: Segment = {
        x0: a.x,
        z0: a.z,
        dx,
        dz,
        lengthSq,
        h0: heights[i],
        h1: heights[i + 1],
        a0: travelled,
        a1: travelled + lengths[i],
        total,
        inverseWidth: 1 / (link.widthScale ?? 1),
        taperEnds: link.taperEnds ?? true,
      };
      travelled += lengths[i];
      if (lengthSq <= 0) continue;
      segmentCount++;

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

  function query(x: number, z: number): RoadQuery {
    const bucket = buckets.get(bucketKey(Math.floor(x / BUCKET_SIZE), Math.floor(z / BUCKET_SIZE)));
    if (!bucket) return MISS;

    let bestDistSq = Infinity;
    let best: Segment | null = null;
    let bestU = 0;
    for (const segment of bucket) {
      const px = x - segment.x0;
      const pz = z - segment.z0;
      const u = Math.min(1, Math.max(0, (px * segment.dx + pz * segment.dz) / segment.lengthSq));
      const ox = px - u * segment.dx;
      const oz = pz - u * segment.dz;
      // Nearest in scaled units, so a wide road beside a narrow street still owns the ground its
      // own width covers.
      const distSq = (ox * ox + oz * oz) * segment.inverseWidth * segment.inverseWidth;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = segment;
        bestU = u;
      }
    }
    if (!best || bestDistSq > searchRadiusSq) return MISS;

    const arc = best.a0 + (best.a1 - best.a0) * bestU;
    const fromEnds = Math.min(arc, best.total - arc);
    const t = best.taperEnds ? Math.min(1, Math.max(0, fromEnds / endTaper)) : 1;
    return {
      distance: Math.sqrt(bestDistSq),
      height: best.h0 + (best.h1 - best.h0) * bestU,
      taper: t * t * (3 - 2 * t),
    };
  }

  return { query, segmentCount };
}

/** Re-exported for callers that only need the point type. */
export type { CellPoint };
