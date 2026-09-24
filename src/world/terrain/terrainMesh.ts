import { Mesh, VertexData, type Scene } from "@babylonjs/core";
import type { MaterialLibrary } from "../materials/materialLibrary";
import type { ChunkGeometry } from "./chunkGeometry";

/** A layer no camera has (cameras default to 0x0FFFFFFF), so a mesh on it is never drawn in the
 *  main view. The shadow map does not check layer masks against its render list, so it still is. */
const SHADOW_ONLY_LAYER = 0x10000000;

export interface TerrainChunkMeshes {
  mesh: Mesh;
  /** A position-and-normal-only stand-in for `mesh`, drawn only into the shadow map. A child of
   *  `mesh`, so disposing `mesh` disposes it too. */
  shadowMesh: Mesh;
}

/** Turns a built chunk (see chunkGeometry.ts) into its meshes - the only part of a chunk build that
 *  has to happen on the main thread, and a small one: the arrays are handed to the GPU as they are. */
export function createTerrainChunkMeshes(
  scene: Scene,
  name: string,
  geometry: ChunkGeometry,
  originX: number,
  originZ: number,
  materialLibrary: MaterialLibrary,
): TerrainChunkMeshes {
  const mesh = new Mesh(name, scene);
  const vertexData = new VertexData();
  vertexData.positions = geometry.positions;
  vertexData.normals = geometry.normals;
  vertexData.indices = geometry.indices;
  vertexData.applyToMesh(mesh);
  mesh.setVerticesData("matIndices", geometry.matIndices, false, 4);
  mesh.setVerticesData("matWeights", geometry.matWeights, false, 4);
  mesh.material = materialLibrary.terrainMaterial;
  mesh.position.set(originX, 0, originZ);

  const shadowMesh = new Mesh(`${name}_shadow`, scene);
  const shadowData = new VertexData();
  shadowData.positions = geometry.shadowPositions;
  // Only for the shadow generator's normalBias; nothing else reads it.
  shadowData.normals = geometry.shadowNormals;
  shadowData.indices = geometry.shadowIndices;
  shadowData.applyToMesh(shadowMesh);
  // The shadow generator needs a material for its render state even though it draws with its own
  // depth shader - see MaterialLibrary.shadowCasterMaterial.
  shadowMesh.material = materialLibrary.shadowCasterMaterial;
  shadowMesh.layerMask = SHADOW_ONLY_LAYER;
  shadowMesh.isPickable = false;
  // Parented so it is disposed and enabled together with the visible mesh.
  shadowMesh.parent = mesh;

  return { mesh, shadowMesh };
}
