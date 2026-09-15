import { MeshBuilder, VertexBuffer, VertexData, type GroundMesh, type Scene } from "@babylonjs/core";
import { computeVertexColors } from "./terrainColors";
import type { TerrainSample, TerrainSampler } from "./terrainSampler";

export interface TerrainChunkOptions {
  name: string;
  size: number;
  subdivisions: number;
  sampleTerrain: TerrainSampler;
  originX: number;
  originZ: number;
}

/** Builds a displaced, vertex-colored ground mesh from a terrain sampler. No textures involved. */
export function createTerrainChunk(scene: Scene, options: TerrainChunkOptions): GroundMesh {
  const { name, size, subdivisions, sampleTerrain, originX, originZ } = options;

  const ground = MeshBuilder.CreateGround(
    name,
    { width: size, height: size, subdivisions, updatable: true },
    scene,
  );

  const positions = ground.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) {
    throw new Error("Ground mesh has no position data");
  }

  const samples: TerrainSample[] = new Array(positions.length / 3);
  for (let i = 0; i < positions.length; i += 3) {
    const worldX = originX + positions[i];
    const worldZ = originZ + positions[i + 2];
    const sample = sampleTerrain(worldX, worldZ);
    positions[i + 1] = sample.height;
    samples[i / 3] = sample;
  }

  const indices = ground.getIndices();
  if (!indices) {
    throw new Error("Ground mesh has no index data");
  }

  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);

  ground.updateVerticesData(VertexBuffer.PositionKind, positions);
  ground.updateVerticesData(VertexBuffer.NormalKind, normals);
  ground.setVerticesData(VertexBuffer.ColorKind, computeVertexColors(positions, normals, samples));

  ground.position.set(originX, 0, originZ);
  ground.updateCoordinateHeights();

  return ground;
}
