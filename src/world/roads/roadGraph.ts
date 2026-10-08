import type { CellPoint } from "../cells/cellGrid";
import type { RoadLine } from "./roadField";
import type { RoadClassId } from "./roadConfig";

/**
 * One stretch of road as it is laid in the world: between two junctions (or a junction and a gate),
 * laid once however many routes run along it. The terrain is graded to stretches, never to routes -
 * a route that follows a road already there adds no road of its own, it only adds to that road's
 * traffic.
 */
export interface RoadStretch extends RoadLine {
  id: number;
  points: CellPoint[];
  heights: number[];
  /** Set once every route is laid - see RoadGraph.classify. */
  widthScale: number;
  roadClass: RoadClassId;
  /** The routes (RoadLink ids) that run along it, and their summed weight - what makes it grand. */
  routes: Set<number>;
  traffic: number;
  /** A stretch always meets a gate or another stretch at its ends, so its grading never fades out. */
  taperEnds: false;
}

/** Where a point lies on the road: which stretch, how far along which of its segments, and the
 *  point and surface height there. */
export interface RoadHit {
  stretch: RoadStretch;
  segment: number;
  u: number;
  x: number;
  z: number;
  height: number;
  distance: number;
}

export interface RoadGraph {
  /** The stretches standing, in the order they were laid (a split stretch's halves in its place). */
  readonly stretches: RoadStretch[];
  /** Lays a new stretch, with no traffic yet. */
  add(points: CellPoint[], heights: number[]): RoadStretch;
  /** The nearest point of any stretch within `reach` of (x, z), or null. */
  nearest(x: number, z: number, reach: number): RoadHit | null;
  /** Where the straight line a-b crosses a stretch: each crossing, with how far along a-b (0-1). */
  crossings(a: CellPoint, b: CellPoint): (RoadHit & { t: number })[];
  /**
   * Splits a stretch at a point on it, so a road can join or leave there: its two halves replace it,
   * sharing its traffic. Nothing is split within `endSnap` of either end - the end itself is the
   * junction. Returns the junction: the point, and its height.
   */
  splitAt(hit: RoadHit, endSnap: number): { x: number; z: number; height: number };
  /** Adds a route's weight to a stretch, once per route. */
  use(stretch: RoadStretch, route: number, weight: number): void;
}

const BUCKET_SIZE = 64;

function bucketKey(gx: number, gz: number): number {
  return (gx + 32768) * 65536 + (gz + 32768);
}

interface IndexedSegment {
  stretch: RoadStretch;
  segment: number;
}

export function createRoadGraph(): RoadGraph {
  const stretches: RoadStretch[] = [];
  const buckets = new Map<number, IndexedSegment[]>();
  /** Stretches split since they were indexed: their segments are skipped, and dropped lazily. */
  const gone = new Set<RoadStretch>();
  let nextId = 0;

  function index(stretch: RoadStretch): void {
    const { points } = stretch;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const gxMin = Math.floor(Math.min(a.x, b.x) / BUCKET_SIZE) - 1;
      const gxMax = Math.floor(Math.max(a.x, b.x) / BUCKET_SIZE) + 1;
      const gzMin = Math.floor(Math.min(a.z, b.z) / BUCKET_SIZE) - 1;
      const gzMax = Math.floor(Math.max(a.z, b.z) / BUCKET_SIZE) + 1;
      for (let gx = gxMin; gx <= gxMax; gx++) {
        for (let gz = gzMin; gz <= gzMax; gz++) {
          const key = bucketKey(gx, gz);
          const bucket = buckets.get(key);
          const entry = { stretch, segment: i };
          if (bucket) bucket.push(entry);
          else buckets.set(key, [entry]);
        }
      }
    }
  }

  function make(points: CellPoint[], heights: number[], routes: Set<number>, traffic: number): RoadStretch {
    return { id: nextId++, points, heights, widthScale: 1, roadClass: "road", routes, traffic, taperEnds: false };
  }

  function add(points: CellPoint[], heights: number[]): RoadStretch {
    const stretch = make(points, heights, new Set(), 0);
    stretches.push(stretch);
    index(stretch);
    return stretch;
  }

  function nearest(x: number, z: number, reach: number): RoadHit | null {
    // A reach within one bucket of the point's own is covered by the bucket margin; wider looks round.
    const ring = Math.max(0, Math.ceil(reach / BUCKET_SIZE) - 1);
    const gx0 = Math.floor(x / BUCKET_SIZE);
    const gz0 = Math.floor(z / BUCKET_SIZE);
    let best: RoadHit | null = null;
    for (let gx = gx0 - ring; gx <= gx0 + ring; gx++) {
      for (let gz = gz0 - ring; gz <= gz0 + ring; gz++) {
        for (const { stretch, segment } of buckets.get(bucketKey(gx, gz)) ?? []) {
          if (gone.has(stretch)) continue;
          const a = stretch.points[segment];
          const b = stretch.points[segment + 1];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const lengthSq = dx * dx + dz * dz;
          const u = lengthSq > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0;
          const px = a.x + dx * u;
          const pz = a.z + dz * u;
          const distance = Math.hypot(px - x, pz - z);
          if (distance <= reach && (!best || distance < best.distance)) {
            const height = stretch.heights[segment] + (stretch.heights[segment + 1] - stretch.heights[segment]) * u;
            best = { stretch, segment, u, x: px, z: pz, height, distance };
          }
        }
      }
    }
    return best;
  }

  function crossings(p: CellPoint, q: CellPoint): (RoadHit & { t: number })[] {
    const found: (RoadHit & { t: number })[] = [];
    const seen = new Set<string>();
    const rx = q.x - p.x;
    const rz = q.z - p.z;
    for (let gx = Math.floor(Math.min(p.x, q.x) / BUCKET_SIZE); gx <= Math.floor(Math.max(p.x, q.x) / BUCKET_SIZE); gx++) {
      for (let gz = Math.floor(Math.min(p.z, q.z) / BUCKET_SIZE); gz <= Math.floor(Math.max(p.z, q.z) / BUCKET_SIZE); gz++) {
        for (const { stretch, segment } of buckets.get(bucketKey(gx, gz)) ?? []) {
          const id = `${stretch.id}:${segment}`;
          if (gone.has(stretch) || seen.has(id)) continue;
          seen.add(id);
          const a = stretch.points[segment];
          const b = stretch.points[segment + 1];
          const sx = b.x - a.x;
          const sz = b.z - a.z;
          const denominator = rx * sz - rz * sx;
          if (Math.abs(denominator) < 1e-9) continue;
          const t = ((a.x - p.x) * sz - (a.z - p.z) * sx) / denominator;
          const u = ((a.x - p.x) * rz - (a.z - p.z) * rx) / denominator;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const height = stretch.heights[segment] + (stretch.heights[segment + 1] - stretch.heights[segment]) * u;
          found.push({ stretch, segment, u, x: a.x + sx * u, z: a.z + sz * u, height, distance: 0, t });
        }
      }
    }
    return found.sort((m, n) => m.t - n.t);
  }

  function splitAt(found: RoadHit, endSnap: number): { x: number; z: number; height: number } {
    // A hit found before another split (the second of two crossings on one line) may name a
    // stretch that is gone: the point is on one of its pieces now.
    const hit = gone.has(found.stretch) ? nearest(found.x, found.z, 0.01) : found;
    if (!hit) return { x: found.x, z: found.z, height: found.height };
    const { stretch, segment, u } = hit;
    const { points, heights } = stretch;
    // How far along the stretch the point is, to see whether it is at an end.
    let along = 0;
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const length = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
      if (i < segment) along += length;
      if (i === segment) along += length * u;
      total += length;
    }
    if (along <= endSnap) return { x: points[0].x, z: points[0].z, height: heights[0] };
    if (total - along <= endSnap) {
      const last = points.length - 1;
      return { x: points[last].x, z: points[last].z, height: heights[last] };
    }
    const at = { x: hit.x, z: hit.z };
    const first = make([...points.slice(0, segment + 1), at], [...heights.slice(0, segment + 1), hit.height], new Set(stretch.routes), stretch.traffic);
    const second = make([at, ...points.slice(segment + 1)], [hit.height, ...heights.slice(segment + 1)], new Set(stretch.routes), stretch.traffic);
    gone.add(stretch);
    stretches.splice(stretches.indexOf(stretch), 1, first, second);
    index(first);
    index(second);
    return { x: hit.x, z: hit.z, height: hit.height };
  }

  function use(stretch: RoadStretch, route: number, weight: number): void {
    if (stretch.routes.has(route)) return;
    stretch.routes.add(route);
    stretch.traffic += weight;
  }

  return { stretches, add, nearest, crossings, splitAt, use };
}
