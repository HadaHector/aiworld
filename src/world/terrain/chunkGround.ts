import type { TerrainSample, TerrainSampler } from "./terrainSampler";
import { RELIEF_CURVATURE_RADIUS_STEPS } from "../materials/materialContext";
import type { TreeGround, TreePlacement, TreeScatter } from "../foliage/treeScatter";
import type { ChunkBuildRequest } from "./chunkGeometry";

/**
 * A chunk's ground, sampled on its grid with a padding ring round it, and the ground under what
 * stands on it - the part of building a chunk that both the drawn chunk (chunkGeometry.ts) and the
 * simulation's collision-only chunk (buildChunkCollision below) need, so the two stand on the same
 * ground among the same trees. Pure, no Babylon (see SIMULATION.md).
 */
export interface ChunkGround {
  /** Grid squares per side at this chunk's level of detail. */
  subdivisions: number;
  /** Full-detail squares per this level's squares. */
  detailRatio: number;
  /** How many steps out relief curvature looks, at this level. */
  curvatureSteps: number;
  /** Rows (and columns) of padding round the chunk's own grid. */
  pad: number;
  paddedSize: number;
  /** x, y, z of each padded grid point, in the chunk's local space (origin at its centre). Row 0 is
   *  the far (+z) edge. */
  paddedPositions: Float32Array;
  paddedSamples: TerrainSample[];
  /** A point of the chunk's own grid, as an index into the padded one (row and column may be -pad). */
  padded: (row: number, col: number) => number;
  /** The ground under a tree candidate - see probeGround below. */
  probeGround: (worldX: number, worldZ: number) => TreeGround | null;
}

/** The world a chunk's ground is sampled from. */
export interface ChunkGroundContext {
  sampleTerrain: TerrainSampler;
}

export function sampleChunkGround(request: ChunkBuildRequest, { sampleTerrain }: ChunkGroundContext): ChunkGround {
  const { size, subdivisions, detailSubdivisions, originX, originZ } = request;
  const gridSize = subdivisions + 1;
  const detailRatio = detailSubdivisions / subdivisions;
  const curvatureSteps = RELIEF_CURVATURE_RADIUS_STEPS / detailRatio;
  if (!Number.isInteger(detailRatio) || !Number.isInteger(curvatureSteps)) {
    throw new Error(`${subdivisions} subdivisions is not a level of detail ${detailSubdivisions} can be reduced to`);
  }
  // One ring more than curvature needs, so the ring just outside the chunk (whose material weights
  // feed border vertices' lists) gets its own curvature from real terrain too.
  const pad = curvatureSteps + 1;
  const paddedSize = gridSize + pad * 2;
  const step = size / subdivisions;

  // Z decreases as the grid row increases, matching the layout @babylonjs/core's CreateGround uses
  // (which this mesh used to be) so a grid position means the same thing it always has.
  const paddedPositions = new Float32Array(paddedSize * paddedSize * 3);
  const paddedSamples: TerrainSample[] = new Array(paddedSize * paddedSize);
  for (let row = 0; row < paddedSize; row++) {
    const rowActual = row - pad;
    const localZ = ((subdivisions - rowActual) * size) / subdivisions - size / 2;
    for (let col = 0; col < paddedSize; col++) {
      const colActual = col - pad;
      const localX = (colActual * size) / subdivisions - size / 2;
      const sample = sampleTerrain(originX + localX, originZ + localZ);

      const paddedIndex = row * paddedSize + col;
      paddedPositions[paddedIndex * 3] = localX;
      paddedPositions[paddedIndex * 3 + 1] = sample.height;
      paddedPositions[paddedIndex * 3 + 2] = localZ;
      paddedSamples[paddedIndex] = sample;
    }
  }

  const padded = (row: number, col: number): number => (row + pad) * paddedSize + (col + pad);

  /** A full-detail grid point's sample, taken from the padded grid when this chunk is at full
   *  detail (it is the same point, sampled the same way) and sampled afresh otherwise. */
  function detailSample(row: number, col: number): TerrainSample {
    if (detailRatio === 1) return paddedSamples[padded(row, col)];
    const localX = (col * size) / detailSubdivisions - size / 2;
    const localZ = ((detailSubdivisions - row) * size) / detailSubdivisions - size / 2;
    return sampleTerrain(originX + localX, originZ + localZ);
  }

  /**
   * The ground under a tree candidate.
   *
   * Which trees grow is decided on the full-detail surface at every level of detail, so a chunk
   * changing level re-scatters exactly the same trees: height is interpolated in the full-detail
   * square the point falls in, slope is that square's gradient there, and the sample is its nearest
   * corner's. Only where a trunk stands - `surfaceHeight` - comes from the grid actually drawn, so
   * a far tree sits on the coarse ground rather than floating over or sunk into it.
   */
  function probeGround(worldX: number, worldZ: number): TreeGround | null {
    const colF = (worldX - originX + size / 2) / step + pad;
    const rowF = subdivisions - (worldZ - originZ + size / 2) / step + pad;
    const col = Math.floor(colF);
    const row = Math.floor(rowF);
    if (col < 0 || row < 0 || col >= paddedSize - 1 || row >= paddedSize - 1) return null;
    const paddedHeight = (r: number, c: number): number => paddedPositions[(r * paddedSize + c) * 3 + 1];
    const surfaceHeight = heightInSquare(paddedHeight, row, col, colF - col, rowF - row);

    const detailStep = size / detailSubdivisions;
    const dColF = (worldX - originX + size / 2) / detailStep;
    const dRowF = detailSubdivisions - (worldZ - originZ + size / 2) / detailStep;
    const dCol = Math.floor(dColF);
    const dRow = Math.floor(dRowF);
    const u = dColF - dCol;
    const v = dRowF - dRow;
    const corners = [detailSample(dRow, dCol), detailSample(dRow, dCol + 1), detailSample(dRow + 1, dCol), detailSample(dRow + 1, dCol + 1)];
    const [h00, h10, h01, h11] = corners.map((sample) => sample.height);
    const height = heightInSquare((r, c) => corners[(r - dRow) * 2 + (c - dCol)].height, dRow, dCol, u, v);

    // Rise per world unit along each grid axis, from the square's bilinear gradient at (u, v).
    const gradU = ((h10 - h00) * (1 - v) + (h11 - h01) * v) / detailStep;
    const gradV = ((h01 - h00) * (1 - u) + (h11 - h10) * u) / detailStep;
    const gradient = Math.hypot(gradU, gradV);
    return {
      height,
      surfaceHeight,
      slope: gradient / Math.sqrt(1 + gradient * gradient),
      sample: corners[(v >= 0.5 ? 2 : 0) + (u >= 0.5 ? 1 : 0)],
    };
  }

  return { subdivisions, detailRatio, curvatureSteps, pad, paddedSize, paddedPositions, paddedSamples, padded, probeGround };
}

/** Height inside one grid square, split the same 8 ways the visible mesh is. */
export function heightInSquare(heightOf: (row: number, col: number) => number, row: number, col: number, u: number, v: number): number {
  const h00 = heightOf(row, col);
  const h10 = heightOf(row, col + 1);
  const h01 = heightOf(row + 1, col);
  const h11 = heightOf(row + 1, col + 1);
  const centre = (h00 + h10 + h01 + h11) / 4;

  // The quadrant nearest (u, v) is owned by that corner; inside it, the owner-to-centre diagonal
  // splits it into the triangle toward the horizontal-edge midpoint and the one toward the
  // vertical-edge midpoint.
  const ou = u < 0.5 ? 0 : 1;
  const ov = v < 0.5 ? 0 : 1;
  const hOwner = [[h00, h01], [h10, h11]][ou][ov];
  const hAlongU = (hOwner + [[h10, h11], [h00, h01]][ou][ov]) / 2;
  const hAlongV = (hOwner + [[h01, h00], [h11, h10]][ou][ov]) / 2;
  // Distances from the owner corner, measured toward the centre, each in 0..0.5.
  const du = Math.abs(u - ou);
  const dv = Math.abs(v - ov);
  return du >= dv
    ? hOwner + (du - dv) * 2 * (hAlongU - hOwner) + dv * 2 * (centre - hOwner)
    : hOwner + (dv - du) * 2 * (hAlongV - hOwner) + du * 2 * (centre - hOwner);
}

/** What a chunk puts in the way: its ground's grid (as worldCollision.ts reads it) and its trees. */
export interface ChunkCollisionSource {
  /** x, y, z of each point of the chunk's own grid, (subdivisions + 1)² of them first, row 0 at
   *  the far (+z) edge, in the chunk's local space - anything after them (a drawn chunk's skirts)
   *  is not read. */
  shadowPositions: Float32Array;
  trees: TreePlacement[];
}

/**
 * Just what a chunk puts in the way, without its materials, grass, bushes or boulders - for the
 * simulation, which collides with the world but never draws it. Its ground and trees are the same a
 * drawn chunk at the same level has, since both come from sampleChunkGround.
 */
export function buildChunkCollision(request: ChunkBuildRequest, context: ChunkGroundContext & { scatterTrees: TreeScatter }): ChunkCollisionSource {
  const { size, originX, originZ } = request;
  const ground = sampleChunkGround(request, context);
  const gridSize = ground.subdivisions + 1;
  const shadowPositions = new Float32Array(gridSize * gridSize * 3);
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const p = ground.padded(row, col) * 3;
      const q = (row * gridSize + col) * 3;
      shadowPositions[q] = ground.paddedPositions[p];
      shadowPositions[q + 1] = ground.paddedPositions[p + 1];
      shadowPositions[q + 2] = ground.paddedPositions[p + 2];
    }
  }
  const trees = context.scatterTrees(originX - size / 2, originZ - size / 2, originX + size / 2, originZ + size / 2, ground.probeGround);
  return { shadowPositions, trees };
}
