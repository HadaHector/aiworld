import { MeshBuilder, VertexBuffer, VertexData, type GroundMesh, type Scene } from "@babylonjs/core";
import type { TerrainSample, TerrainSampler } from "./terrainSampler";
import { RELIEF_CURVATURE_RADIUS_STEPS, buildVertexContext } from "../materials/materialContext";
import type { MaterialLibrary } from "../materials/materialLibrary";
import type { TreeGround, TreePlacement, TreeScatter } from "../foliage/treeScatter";

export interface TerrainChunkOptions {
  name: string;
  size: number;
  subdivisions: number;
  sampleTerrain: TerrainSampler;
  originX: number;
  originZ: number;
  materialLibrary: MaterialLibrary;
  scatterTrees: TreeScatter;
}

export interface TerrainChunk {
  mesh: GroundMesh;
  /** The trees standing on this chunk. Scattered here, not by a system of their own, because the
   *  padded vertex grid below already holds the finished surface and a full TerrainSample at every
   *  vertex - so placing a tree costs a lookup instead of another few terrain samples, and it
   *  stands on exactly the triangle that gets drawn rather than on a second opinion about it. */
  trees: TreePlacement[];
}

/**
 * Builds a displaced, per-vertex-blended-texture ground mesh from a terrain sampler.
 *
 * Every rendered vertex samples a small ring of terrain beyond the chunk's own edge (see PAD
 * below) purely to compute normals and relief curvature - both are otherwise derived only from
 * this chunk's own vertex grid, which silently clamps at the chunk boundary instead of reading the
 * neighboring chunk's true terrain. That clamp produces two visible seams once shading/blending
 * actually depends on it closely: a lighting seam (independently-computed normals meeting at
 * slightly different angles right at the chunk edge - most visible on very flat terrain like
 * swamp, which has nothing else to hide it behind) and a material seam (curvature-driven layers
 * like valley snow/weeds reading a biased "surrounding ground" average in the last few vertices
 * before the edge). Sampling a bit further out costs a bit more terrain sampling (pure and cheap)
 * but needs no coordination with neighboring chunks at all.
 */
export function createTerrainChunk(scene: Scene, options: TerrainChunkOptions): TerrainChunk {
  const { name, size, subdivisions, sampleTerrain, originX, originZ, materialLibrary, scatterTrees } = options;

  const ground = MeshBuilder.CreateGround(
    name,
    { width: size, height: size, subdivisions, updatable: true },
    scene,
  );

  const positions = ground.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) {
    throw new Error("Ground mesh has no position data");
  }

  const gridSize = subdivisions + 1;
  const pad = RELIEF_CURVATURE_RADIUS_STEPS;
  const paddedSize = gridSize + pad * 2;

  // Mirrors @babylonjs/core's own CreateGroundVertexData position formula exactly (Z decreases as
  // the grid row increases), extended beyond [0, subdivisions] into the padding ring - so a padded
  // vertex's local (and therefore world) position always matches what the real, unpadded grid
  // would have produced had it extended that far.
  const paddedPositions = new Float32Array(paddedSize * paddedSize * 3);
  const paddedSamples: TerrainSample[] = new Array(paddedSize * paddedSize);
  for (let row = 0; row < paddedSize; row++) {
    const rowActual = row - pad;
    const localZ = ((subdivisions - rowActual) * size) / subdivisions - size / 2;
    for (let col = 0; col < paddedSize; col++) {
      const colActual = col - pad;
      const localX = (colActual * size) / subdivisions - size / 2;
      const worldX = originX + localX;
      const worldZ = originZ + localZ;
      const sample = sampleTerrain(worldX, worldZ);

      const paddedIndex = row * paddedSize + col;
      paddedPositions[paddedIndex * 3] = localX;
      paddedPositions[paddedIndex * 3 + 1] = sample.height;
      paddedPositions[paddedIndex * 3 + 2] = localZ;
      paddedSamples[paddedIndex] = sample;
    }
  }

  // Same winding as @babylonjs/core's CreateGroundVertexData (confirmed by reading its source):
  // per quad [a, a+1, a+paddedSize, a+paddedSize+1], triangles (a+W+1, a+1, a) and (a+W, a+W+1, a).
  const paddedIndices: number[] = [];
  for (let row = 0; row < paddedSize - 1; row++) {
    for (let col = 0; col < paddedSize - 1; col++) {
      const a = row * paddedSize + col;
      paddedIndices.push(a + paddedSize + 1, a + 1, a);
      paddedIndices.push(a + paddedSize, a + paddedSize + 1, a);
    }
  }
  const paddedNormals: number[] = [];
  VertexData.ComputeNormals(paddedPositions, paddedIndices, paddedNormals);

  const normals = new Float32Array(gridSize * gridSize * 3);
  const samples: TerrainSample[] = new Array(gridSize * gridSize);
  const matIndices0: number[] = [];
  const matIndices1: number[] = [];
  const matIndices2: number[] = [];
  const matWeights0: number[] = [];
  const matWeights1: number[] = [];
  const matWeights2: number[] = [];

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const realIndex = row * gridSize + col;
      const paddedIndex = (row + pad) * paddedSize + (col + pad);

      positions[realIndex * 3 + 1] = paddedPositions[paddedIndex * 3 + 1];
      normals[realIndex * 3] = paddedNormals[paddedIndex * 3];
      normals[realIndex * 3 + 1] = paddedNormals[paddedIndex * 3 + 1];
      normals[realIndex * 3 + 2] = paddedNormals[paddedIndex * 3 + 2];
      const sample = paddedSamples[paddedIndex];
      samples[realIndex] = sample;

      const context = buildVertexContext(paddedPositions, paddedNormals, paddedSamples, paddedSize, paddedIndex);
      const worldX = originX + positions[realIndex * 3];
      const worldZ = originZ + positions[realIndex * 3 + 2];
      const { indices, weights } = materialLibrary.buildMaterialBlend(worldX, worldZ, context, sample.areaWeights);

      matIndices0.push(indices[0], indices[1], indices[2], indices[3]);
      matIndices1.push(indices[4], indices[5], indices[6], indices[7]);
      matIndices2.push(indices[8], indices[9], indices[10], indices[11]);
      matWeights0.push(weights[0], weights[1], weights[2], weights[3]);
      matWeights1.push(weights[4], weights[5], weights[6], weights[7]);
      matWeights2.push(weights[8], weights[9], weights[10], weights[11]);
    }
  }

  ground.updateVerticesData(VertexBuffer.PositionKind, positions);
  ground.updateVerticesData(VertexBuffer.NormalKind, normals);
  // CreateGround computes its bounding box from the FLAT plane, and updateVerticesData leaves that
  // box alone unless asked to (its third argument, updateExtends, defaults to false). Displacing Y
  // therefore left every chunk claiming to be a zero-height plane at y=0 while its terrain sat
  // hundreds of units above - so frustum culling dropped chunks the camera was standing right on
  // top of, and they only reappeared when the camera tilted far enough down to bring y=0 into view.
  // Most visible on peaks, where the gap between real and claimed height is largest.
  ground.refreshBoundingInfo();
  ground.setVerticesData("matIndices0", matIndices0, false, 4);
  ground.setVerticesData("matIndices1", matIndices1, false, 4);
  ground.setVerticesData("matIndices2", matIndices2, false, 4);
  ground.setVerticesData("matWeights0", matWeights0, false, 4);
  ground.setVerticesData("matWeights1", matWeights1, false, 4);
  ground.setVerticesData("matWeights2", matWeights2, false, 4);
  ground.material = materialLibrary.terrainMaterial;

  ground.position.set(originX, 0, originZ);

  const step = size / subdivisions;

  /**
   * The ground under a point, read out of the grid that was just built rather than sampled again.
   *
   * Height is interpolated inside the actual triangle the point falls in - the same split the
   * index buffer above uses - so a trunk sits on the rendered surface exactly, with none of the
   * up-to-a-vertex error a bilinear or nearest read would leave on a slope. Normal and sample come
   * from the nearest vertex, which is at most 1.25 units away and only ever feeds fades measured
   * in tens of units.
   */
  function probeGround(worldX: number, worldZ: number): TreeGround | null {
    const colF = (worldX - originX + size / 2) / step + pad;
    const rowF = subdivisions - (worldZ - originZ + size / 2) / step + pad;
    const col = Math.floor(colF);
    const row = Math.floor(rowF);
    if (col < 0 || row < 0 || col >= paddedSize - 1 || row >= paddedSize - 1) return null;

    const u = colF - col;
    const v = rowF - row;
    const a = row * paddedSize + col;
    const h00 = paddedPositions[a * 3 + 1];
    const h10 = paddedPositions[(a + 1) * 3 + 1];
    const h01 = paddedPositions[(a + paddedSize) * 3 + 1];
    const h11 = paddedPositions[(a + paddedSize + 1) * 3 + 1];
    // The quad splits along the u = v diagonal: one triangle is (col,row)-(col+1,row)-(col+1,row+1),
    // the other (col,row)-(col,row+1)-(col+1,row+1).
    const height =
      u >= v ? h00 + u * (h10 - h00) + v * (h11 - h10) : h00 + v * (h01 - h00) + u * (h11 - h01);

    const nearest = (row + (v >= 0.5 ? 1 : 0)) * paddedSize + (col + (u >= 0.5 ? 1 : 0));
    const normalY = paddedNormals[nearest * 3 + 1];
    return {
      height,
      slope: Math.sqrt(Math.max(0, 1 - normalY * normalY)),
      sample: paddedSamples[nearest],
    };
  }

  const trees = scatterTrees(
    originX - size / 2,
    originZ - size / 2,
    originX + size / 2,
    originZ + size / 2,
    probeGround,
  );

  return { mesh: ground, trees };
}
