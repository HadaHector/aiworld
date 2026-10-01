import { BoundingInfo, Mesh, Vector3, VertexData, type Scene } from "@babylonjs/core";
import { SEA_LEVEL } from "../cells/areaField";
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
  /** The chunk's floating sheet - duckweed and the like on its water (MaterialDef.floats) - or none
   *  where nothing floats. A child of `mesh` too. */
  floatingMesh: Mesh | null;
}

/** A vertex this far over the water still counts as under it - a triangle reaching the water from it
 *  still needs its share of the sheet. */
const FLOAT_REACH = 0.2;
/** A floating material's weight at a vertex below this is no cover at all. */
const FLOAT_MIN_WEIGHT = 0.02;

/**
 * The triangles of `geometry` a floating sheet needs: those with some floating material at one of
 * their corners, and a corner under the water. None, for most chunks.
 */
function floatingIndices(geometry: ChunkGeometry, floating: ReadonlySet<number>): number[] {
  if (floating.size === 0) return [];
  const { positions, indices, matIndices, matWeights } = geometry;
  const covered = (v: number): boolean => {
    for (let k = 0; k < 4; k++) if (matWeights[v * 4 + k] > FLOAT_MIN_WEIGHT && floating.has(Math.round(matIndices[v * 4 + k]))) return true;
    return false;
  };
  const wet = (v: number): boolean => positions[v * 3 + 1] < SEA_LEVEL + FLOAT_REACH;
  const kept: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    if ((wet(a) || wet(b) || wet(c)) && (covered(a) || covered(b) || covered(c))) kept.push(a, b, c);
  }
  return kept;
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

  // The floating sheet: the chunk's own vertices (raised to the water by its shader), only the
  // triangles with something floating on them.
  let floatingMesh: Mesh | null = null;
  const sheet = floatingIndices(geometry, materialLibrary.floatingMaterials);
  if (sheet.length > 0) {
    floatingMesh = new Mesh(`${name}_floating`, scene);
    const sheetData = new VertexData();
    sheetData.positions = geometry.positions;
    sheetData.normals = geometry.normals;
    sheetData.indices = sheet;
    sheetData.applyToMesh(floatingMesh);
    floatingMesh.setVerticesData("matIndices", geometry.matIndices, false, 4);
    floatingMesh.setVerticesData("matWeights", geometry.matWeights, false, 4);
    floatingMesh.material = materialLibrary.floatingMaterial;
    floatingMesh.isPickable = false;
    floatingMesh.parent = mesh;
    // Its bounds reach up to the water it is drawn on - the ground's alone may lie wholly under it.
    const bounds = floatingMesh.getBoundingInfo();
    const top = Math.max(bounds.maximum.y, SEA_LEVEL + FLOAT_REACH);
    floatingMesh.setBoundingInfo(new BoundingInfo(bounds.minimum, new Vector3(bounds.maximum.x, top, bounds.maximum.z)));
  }

  return { mesh, shadowMesh, floatingMesh };
}
