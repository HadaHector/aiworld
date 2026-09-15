import { MeshBuilder, VertexBuffer, VertexData, type GroundMesh, type Scene } from "@babylonjs/core";
import type { HeightSampler } from "./noise";
import { computeVertexColors } from "./terrainColors";

export interface TerrainChunkOptions {
  size: number;
  subdivisions: number;
  heightSampler: HeightSampler;
}

/** Builds a displaced, vertex-colored ground mesh from a height sampler. No textures involved. */
export function createTerrainChunk(scene: Scene, options: TerrainChunkOptions): GroundMesh {
  const { size, subdivisions, heightSampler } = options;

  const ground = MeshBuilder.CreateGround(
    "terrain",
    { width: size, height: size, subdivisions, updatable: true },
    scene,
  );

  const positions = ground.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) {
    throw new Error("Ground mesh has no position data");
  }

  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] = heightSampler(positions[i], positions[i + 2]);
  }

  const indices = ground.getIndices();
  if (!indices) {
    throw new Error("Ground mesh has no index data");
  }

  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);

  ground.updateVerticesData(VertexBuffer.PositionKind, positions);
  ground.updateVerticesData(VertexBuffer.NormalKind, normals);
  ground.setVerticesData(VertexBuffer.ColorKind, computeVertexColors(positions, normals));

  ground.updateCoordinateHeights();

  return ground;
}
