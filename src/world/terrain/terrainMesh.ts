import { Mesh, VertexData, type Scene } from "@babylonjs/core";
import type { TerrainSample, TerrainSampler } from "./terrainSampler";
import { RELIEF_CURVATURE_RADIUS_STEPS, buildVertexContext } from "../materials/materialContext";
import { MATERIALS_PER_TRIANGLE, type MaterialLibrary } from "../materials/materialLibrary";
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
  mesh: Mesh;
  /** The trees standing on this chunk. Scattered here, not by a system of their own, because the
   *  padded vertex grid below already holds the finished surface and a full TerrainSample at every
   *  vertex - so placing a tree costs a lookup instead of another few terrain samples, and it
   *  stands on exactly the triangle that gets drawn rather than on a second opinion about it. */
  trees: TreePlacement[];
}

/** One material list, heaviest first, at most MATERIALS_PER_TRIANGLE long. */
type MaterialList = number[];

/** A point's weights over one owner's list, in that list's order, summing to 1. */
type SlotWeights = number[];

function averageWeights(maps: Map<number, number>[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const map of maps) {
    for (const [material, weight] of map) out.set(material, (out.get(material) ?? 0) + weight / maps.length);
  }
  return out;
}

function intersectLists(lists: MaterialList[]): Set<number> {
  const shared = new Set(lists[0]);
  for (let i = 1; i < lists.length; i++) {
    const other = new Set(lists[i]);
    for (const material of shared) if (!other.has(material)) shared.delete(material);
  }
  return shared;
}

/** `weights` restricted to the materials in `allowed`, laid out in `ownerList`'s order and
 *  renormalised - or null if nothing in `allowed` carries any weight here. */
function toSlots(weights: Map<number, number>, ownerList: MaterialList, allowed: Set<number>): SlotWeights | null {
  let sum = 0;
  const slots = ownerList.map((material) => {
    const weight = allowed.has(material) ? (weights.get(material) ?? 0) : 0;
    sum += weight;
    return weight;
  });
  if (sum <= 1e-6) return null;
  return slots.map((weight) => weight / sum);
}

/**
 * Builds a displaced, texture-blended ground mesh from a terrain sampler.
 *
 * Every rendered vertex samples a small ring of terrain beyond the chunk's own edge (see PAD
 * below) to compute normals, relief curvature and each border vertex's material list from the
 * neighbouring chunk's true terrain rather than a clamped copy of this one's - otherwise two
 * chunks would compute the same border vertex differently and meet at a seam.
 *
 * Material blending: each grid square is split into 8 triangles around its centre and edge
 * midpoints, so that every triangle has exactly one original grid vertex - its "owner" - and draws
 * only the owner's list of MATERIALS_PER_TRIANGLE materials. An owner's list is its heaviest
 * materials summed over itself and its 8 neighbours, so it also covers whatever the neighbouring
 * vertices are made of. A midpoint carries only the materials both its ends list, and a centre only
 * those all four corners list - a subset of every owner it borders - so:
 *  - every vertex of a triangle can express its weights in the owner's list, and
 *  - where triangles with different owners meet (midpoint-centre edges) only shared materials
 *    exist, so both sides agree and there is no seam.
 * The only thing lost is weight from materials beyond the top MATERIALS_PER_TRIANGLE around a
 * point, which drops out smoothly rather than turning up as a wrong material.
 */
export function createTerrainChunk(scene: Scene, options: TerrainChunkOptions): TerrainChunk {
  const { name, size, subdivisions, sampleTerrain, originX, originZ, materialLibrary, scatterTrees } = options;

  const gridSize = subdivisions + 1;
  // One ring more than curvature needs, so the ring just outside the chunk (whose material weights
  // feed border vertices' lists) gets its own curvature from real terrain too.
  const pad = RELIEF_CURVATURE_RADIUS_STEPS + 1;
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

  const padded = (row: number, col: number): number => (row + pad) * paddedSize + (col + pad);

  // Full material weights for the rendered grid plus one ring around it (rows/cols -1..gridSize).
  const ringSize = gridSize + 2;
  const blends: Map<number, number>[] = new Array(ringSize * ringSize);
  const blendAt = (row: number, col: number): Map<number, number> => blends[(row + 1) * ringSize + (col + 1)];
  for (let row = -1; row <= gridSize; row++) {
    for (let col = -1; col <= gridSize; col++) {
      const index = padded(row, col);
      const context = buildVertexContext(paddedPositions, paddedNormals, paddedSamples, paddedSize, index);
      blends[(row + 1) * ringSize + (col + 1)] = materialLibrary.buildMaterialBlend(
        originX + paddedPositions[index * 3],
        originZ + paddedPositions[index * 3 + 2],
        context,
        paddedSamples[index].areaWeights,
      );
    }
  }

  // Each rendered vertex's list: its heaviest materials summed over itself and its 8 neighbours.
  // Ties break on material index so a border vertex gets the same list in both chunks it belongs to.
  const lists: MaterialList[] = new Array(gridSize * gridSize);
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const totals = new Map<number, number>();
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          for (const [material, weight] of blendAt(row + dr, col + dc)) {
            totals.set(material, (totals.get(material) ?? 0) + weight);
          }
        }
      }
      lists[row * gridSize + col] = [...totals.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, MATERIALS_PER_TRIANGLE)
        .map(([material]) => material);
    }
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const matIndices: number[] = [];
  const matWeights: number[] = [];
  const indices: number[] = [];

  function pushVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, ownerList: MaterialList, slots: SlotWeights): number {
    const index = positions.length / 3;
    positions.push(x, y, z);
    const length = Math.hypot(nx, ny, nz) || 1;
    normals.push(nx / length, ny / length, nz / length);
    for (let slot = 0; slot < 4; slot++) {
      matIndices.push(ownerList[slot] ?? 0);
      matWeights.push(slots[slot] ?? 0);
    }
    return index;
  }

  /** A point's slot weights for one owner: its shared materials if they carry any weight here,
   *  else (the rare case of more materials meeting in one square than one list holds) whatever of
   *  the owner's own list it has, else the owner's own weights outright. */
  function slotsFor(weights: Map<number, number>, sharedList: Set<number>, ownerList: MaterialList, ownerWeights: SlotWeights): SlotWeights {
    return toSlots(weights, ownerList, sharedList) ?? toSlots(weights, ownerList, new Set(ownerList)) ?? ownerWeights;
  }

  // Corner vertices: one per grid point, used by every triangle that point owns.
  const cornerVertex: number[] = new Array(gridSize * gridSize);
  const cornerSlots: SlotWeights[] = new Array(gridSize * gridSize);
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const g = row * gridSize + col;
      const list = lists[g];
      // If none of its own materials made its own list (its neighbours outweigh it entirely), it
      // takes its list's heaviest material outright.
      const slots = toSlots(blendAt(row, col), list, new Set(list)) ?? list.map((_, i) => (i === 0 ? 1 : 0));
      cornerSlots[g] = slots;
      const p = padded(row, col);
      cornerVertex[g] = pushVertex(
        paddedPositions[p * 3], paddedPositions[p * 3 + 1], paddedPositions[p * 3 + 2],
        paddedNormals[p * 3], paddedNormals[p * 3 + 1], paddedNormals[p * 3 + 2],
        list, slots,
      );
    }
  }

  /** A new vertex at the average of some grid points, carrying only the materials all of them list
   *  - one copy per owner, since each owner lays its slots out in its own order. */
  function pushAveragedVertex(gridPoints: number[][], owner: number[]): number {
    let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0;
    for (const [row, col] of gridPoints) {
      const p = padded(row, col);
      x += paddedPositions[p * 3]; y += paddedPositions[p * 3 + 1]; z += paddedPositions[p * 3 + 2];
      nx += paddedNormals[p * 3]; ny += paddedNormals[p * 3 + 1]; nz += paddedNormals[p * 3 + 2];
    }
    const n = gridPoints.length;
    const weights = averageWeights(gridPoints.map(([row, col]) => blendAt(row, col)));
    const shared = intersectLists(gridPoints.map(([row, col]) => lists[row * gridSize + col]));
    const g = owner[0] * gridSize + owner[1];
    const slots = slotsFor(weights, shared, lists[g], cornerSlots[g]);
    return pushVertex(x / n, y / n, z / n, nx, ny, nz, lists[g], slots);
  }

  /** Babylon treats clockwise-from-above as front-facing for ground - the same winding the grid had
   *  when it was a CreateGround mesh - so each triangle is ordered to match. */
  function pushTriangle(a: number, b: number, c: number): void {
    const ax = positions[a * 3], az = positions[a * 3 + 2];
    const crossY = (positions[b * 3 + 2] - az) * (positions[c * 3] - ax) - (positions[b * 3] - ax) * (positions[c * 3 + 2] - az);
    if (crossY < 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  }

  // An edge's midpoint is used by the triangles on both sides of it that share an owner, so each
  // (edge, owner) vertex is built once.
  const midpointVertices = new Map<string, number>();
  function midpointVertex(owner: number[], other: number[]): number {
    const key = `${owner[0]},${owner[1]}>${other[0]},${other[1]}`;
    let vertex = midpointVertices.get(key);
    if (vertex === undefined) {
      vertex = pushAveragedVertex([owner, other], owner);
      midpointVertices.set(key, vertex);
    }
    return vertex;
  }

  for (let row = 0; row < subdivisions; row++) {
    for (let col = 0; col < subdivisions; col++) {
      const corners = [[row, col], [row, col + 1], [row + 1, col + 1], [row + 1, col]];
      for (let k = 0; k < 4; k++) {
        const owner = corners[k];
        const next = corners[(k + 1) % 4];
        const prev = corners[(k + 3) % 4];
        const ownerVertex = cornerVertex[owner[0] * gridSize + owner[1]];
        const toNext = midpointVertex(owner, next);
        const toPrev = midpointVertex(owner, prev);
        const centre = pushAveragedVertex(corners, owner);
        pushTriangle(ownerVertex, toNext, centre);
        pushTriangle(ownerVertex, centre, toPrev);
      }
    }
  }

  const mesh = new Mesh(name, scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.normals = normals;
  vertexData.indices = indices;
  vertexData.applyToMesh(mesh);
  mesh.setVerticesData("matIndices", matIndices, false, 4);
  mesh.setVerticesData("matWeights", matWeights, false, 4);
  mesh.material = materialLibrary.terrainMaterial;
  mesh.position.set(originX, 0, originZ);

  /**
   * The ground under a point, read out of the grid that was just built rather than sampled again.
   *
   * Height is interpolated inside the actual triangle the point falls in - the same 8-way split the
   * mesh above uses - so a trunk sits on the rendered surface exactly. Normal and sample come from
   * the nearest grid vertex, which is at most 1.25 units away and only ever feeds fades measured in
   * tens of units.
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
    const height =
      du >= dv
        ? hOwner + (du - dv) * 2 * (hAlongU - hOwner) + dv * 2 * (centre - hOwner)
        : hOwner + (dv - du) * 2 * (hAlongV - hOwner) + du * 2 * (centre - hOwner);

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

  return { mesh, trees };
}
