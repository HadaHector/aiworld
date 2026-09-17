import { MeshBuilder, SubMesh, VertexBuffer, VertexData, type GroundMesh, type Scene } from "@babylonjs/core";
import type { TerrainSample, TerrainSampler } from "./terrainSampler";
import { buildFaceContext } from "../materials/materialContext";
import type { MaterialLibrary } from "../materials/materialLibrary";

export interface TerrainChunkOptions {
  name: string;
  size: number;
  subdivisions: number;
  sampleTerrain: TerrainSampler;
  originX: number;
  originZ: number;
  materialLibrary: MaterialLibrary;
}

/** Builds a displaced, per-face-textured ground mesh from a terrain sampler. */
export function createTerrainChunk(scene: Scene, options: TerrainChunkOptions): GroundMesh {
  const { name, size, subdivisions, sampleTerrain, originX, originZ, materialLibrary } = options;

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

  // Per-face material selection: bucket triangles by resolved material index, then rebuild the
  // index buffer bucket-by-bucket so each material's faces land in one contiguous range - the
  // layout a MultiMaterial's per-submesh materialIndex requires. No blending; each face reads
  // exactly one material, per this milestone's explicit v1 scope.
  const vertexCount = positions.length / 3;
  const gridSize = subdivisions + 1;
  const buckets: number[][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];

    const context = buildFaceContext(positions, normals, samples, gridSize, i0, i1, i2);
    const centroidX = originX + (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3;
    const centroidZ = originZ + (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3;
    const materialIndex = materialLibrary.resolveMaterialIndex(centroidX, centroidZ, context, samples[i0].primaryBiome.id);

    (buckets[materialIndex] ??= []).push(i0, i1, i2);
  }

  const reorderedIndices: number[] = [];
  const bucketRanges: { materialIndex: number; indexStart: number; indexCount: number }[] = [];
  let indexStart = 0;
  for (let materialIndex = 0; materialIndex < buckets.length; materialIndex++) {
    const bucket = buckets[materialIndex];
    if (!bucket || bucket.length === 0) continue;
    reorderedIndices.push(...bucket);
    bucketRanges.push({ materialIndex, indexStart, indexCount: bucket.length });
    indexStart += bucket.length;
  }

  // setIndices() replaces Babylon's own default submesh (spanning the whole mesh) as a side
  // effect, so the custom per-material submeshes must be (re)built after it, not before - building
  // them first meant every chunk silently rendered as one single submesh (materialIndex 0).
  ground.setIndices(reorderedIndices);
  ground.subMeshes = [];
  for (const range of bucketRanges) {
    new SubMesh(range.materialIndex, 0, vertexCount, range.indexStart, range.indexCount, ground);
  }
  ground.material = materialLibrary.multiMaterial;

  ground.position.set(originX, 0, originZ);
  ground.updateCoordinateHeights();

  return ground;
}
