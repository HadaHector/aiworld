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

  return { points: relaxed, adjacency };
}
