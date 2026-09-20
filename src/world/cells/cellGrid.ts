import { Delaunay } from "d3-delaunay";
import { mulberry32, deriveSeed } from "../rng";
import { GRID_JITTER_SALT, LLOYD_RELAX_ITERATIONS } from "./config";

export interface CellPoint {
  x: number;
  z: number;
}

export interface CellBounds {
  xMin: number;
  zMin: number;
  xMax: number;
  zMax: number;
}

export interface CellDiagram {
  points: CellPoint[];
  adjacency: number[][];
  /**
   * Midpoint of the Voronoi edge two adjacent cells share - the point on the ground exactly between
   * them, which is where a river running along their border actually is.
   *
   * Deliberately NOT the midpoint of the two cells' sites: that is a point on the same bisector
   * line, but the shared edge is only a bounded segment of that line and does not have to contain
   * it. Falls back to the site midpoint when the shared edge cannot be recovered (cells clipped by
   * the world bounds share their edge with the bounding box rather than with each other).
   */
  seamMidpoint(a: number, b: number): CellPoint;
}

export function computeCellBounds(centerX: number, centerZ: number, terrainSize: number, margin: number): CellBounds {
  const half = terrainSize / 2 + margin;
  return { xMin: centerX - half, zMin: centerZ - half, xMax: centerX + half, zMax: centerZ + half };
}

function generateJitteredGridPoints(seed: number, bounds: CellBounds, spacing: number): CellPoint[] {
  const rng = mulberry32(deriveSeed(seed, GRID_JITTER_SALT));
  const points: CellPoint[] = [];
  const jitterAmount = spacing * 0.4;

  for (let gx = bounds.xMin; gx <= bounds.xMax; gx += spacing) {
    for (let gz = bounds.zMin; gz <= bounds.zMax; gz += spacing) {
      const x = gx + (rng() * 2 - 1) * jitterAmount;
      const z = gz + (rng() * 2 - 1) * jitterAmount;
      points.push({ x, z });
    }
  }

  return points;
}

function relaxPoints(points: CellPoint[], bounds: CellBounds, iterations: number): CellPoint[] {
  let current = points;
  const boundsArray: [number, number, number, number] = [bounds.xMin, bounds.zMin, bounds.xMax, bounds.zMax];

  for (let i = 0; i < iterations; i++) {
    const delaunay = Delaunay.from(
      current,
      (p) => p.x,
      (p) => p.z,
    );
    const voronoi = delaunay.voronoi(boundsArray);

    current = current.map((point, index) => {
      const polygon = voronoi.cellPolygon(index);
      if (!polygon || polygon.length === 0) {
        return point;
      }

      let sumX = 0;
      let sumZ = 0;
      for (const [px, pz] of polygon) {
        sumX += px;
        sumZ += pz;
      }
      const count = polygon.length;
      return { x: sumX / count, z: sumZ / count };
    });
  }

  return current;
}

/** Two Voronoi cells that share an edge share its two endpoints EXACTLY - both are computed from
 *  the same Delaunay circumcenter - so vertices can be matched by value rather than by proximity.
 *  Rounded only to absorb the last bit or two of float noise. */
function vertexKey(x: number, z: number): string {
  return `${Math.round(x * 1e6)},${Math.round(z * 1e6)}`;
}

function buildSeamMidpoints(points: CellPoint[], bounds: CellBounds): (a: number, b: number) => CellPoint {
  const delaunay = Delaunay.from(
    points,
    (p) => p.x,
    (p) => p.z,
  );
  const voronoi = delaunay.voronoi([bounds.xMin, bounds.zMin, bounds.xMax, bounds.zMax]);
  // Built on demand: only the handful of cells along a river ever get asked for.
  const polygons = new Map<number, Map<string, CellPoint>>();

  function polygonOf(index: number): Map<string, CellPoint> {
    const cached = polygons.get(index);
    if (cached) return cached;
    const vertices = new Map<string, CellPoint>();
    const polygon = voronoi.cellPolygon(index);
    if (polygon) {
      for (const [x, z] of polygon) vertices.set(vertexKey(x, z), { x, z });
    }
    polygons.set(index, vertices);
    return vertices;
  }

  return function seamMidpoint(a: number, b: number): CellPoint {
    const shared: CellPoint[] = [];
    const polyB = polygonOf(b);
    for (const [key, vertex] of polygonOf(a)) {
      if (polyB.has(key)) shared.push(vertex);
    }
    if (shared.length !== 2) {
      return { x: (points[a].x + points[b].x) / 2, z: (points[a].z + points[b].z) / 2 };
    }
    return { x: (shared[0].x + shared[1].x) / 2, z: (shared[0].z + shared[1].z) / 2 };
  };
}

function buildAdjacency(points: CellPoint[]): number[][] {
  const delaunay = Delaunay.from(
    points,
    (p) => p.x,
    (p) => p.z,
  );

  return points.map((_, index) => [...delaunay.neighbors(index)]);
}

/** Jittered grid -> Lloyd-relaxed points -> Delaunay adjacency graph. Runs once at world generation. */
export function generateCellDiagram(seed: number, bounds: CellBounds, spacing: number): CellDiagram {
  const jittered = generateJitteredGridPoints(seed, bounds, spacing);
  const relaxed = relaxPoints(jittered, bounds, LLOYD_RELAX_ITERATIONS);
  const adjacency = buildAdjacency(relaxed);
  const seamMidpoint = buildSeamMidpoints(relaxed, bounds);

  return { points: relaxed, adjacency, seamMidpoint };
}
