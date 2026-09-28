import { VertexData } from "@babylonjs/core";
import type { TerrainSample, TerrainSampler } from "./terrainSampler";
import { RELIEF_CURVATURE_RADIUS_STEPS, buildVertexContext } from "../materials/materialContext";
import { MATERIALS_PER_TRIANGLE, type MaterialBlender } from "../materials/materialBlend";
import type { TreeCover, TreeGround, TreePlacement, TreeScatter } from "../foliage/treeScatter";
import { scatterGrass, type ChunkGrass } from "../foliage/grassScatter";
import type { GrassKindDef } from "../foliage/grassConfig";
import { BUSH_MAX_DETAIL_RATIO, ROCK_MAX_DETAIL_RATIO } from "../foliage/foliageConfig";

/** Where a chunk is and at what level of detail - everything a build needs besides the world
 *  itself, and plain data, so it can be posted to a worker. */
export interface ChunkBuildRequest {
  size: number;
  /** Grid squares per side at this chunk's level of detail. */
  subdivisions: number;
  /** Grid squares per side at full detail. `subdivisions` must divide it, and the ratio must divide
   *  RELIEF_CURVATURE_RADIUS_STEPS, so every coarse vertex is also a full-detail one and relief
   *  curvature can look out the same world distance at every level. */
  detailSubdivisions: number;
  originX: number;
  originZ: number;
}

/** The world a chunk is built from. A worker makes its own from the same seed and content. */
export interface ChunkBuildContext {
  sampleTerrain: TerrainSampler;
  materialBlender: Pick<MaterialBlender, "buildMaterialBlend" | "materialDefs">;
  seed: number;
  /** Each material's average baked colour by index, for grass roots (see scatterGrass). Null until
   *  the material textures have been baked. */
  groundColors: [number, number, number][] | null;
  scatterTrees: TreeScatter;
  scatterBushes: TreeScatter;
  scatterRocks: TreeScatter;
  /** How wooded the ground is, for material rules (see materialContext.ts). */
  treeCover: TreeCover;
  grassKinds: GrassKindDef[];
}

/** How far a skirt hangs below the lowest point a neighbour's edge can reach (see skirtDepth), so
 *  it also covers the hairline cracks where one chunk's edge vertex sits mid-edge on another's. */
const SKIRT_MARGIN = 0.5;

/**
 * A built chunk as plain typed arrays, in the chunk's local space (origin at its centre) - what
 * terrainMesh.ts turns into meshes. Typed arrays so a worker can hand them over without a copy.
 */
export interface ChunkGeometry {
  positions: Float32Array;
  normals: Float32Array;
  /** MATERIALS_PER_TRIANGLE material indices per vertex, padded to 4. */
  matIndices: Float32Array;
  /** The weights for `matIndices`, padded to 4. */
  matWeights: Float32Array;
  indices: Uint32Array;
  /** The plain grid, positions and normals only, for the shadow map. */
  shadowPositions: Float32Array;
  shadowNormals: Float32Array;
  shadowIndices: Uint32Array;
  /** The trees standing on this chunk. Scattered here, not by a system of their own, because the
   *  padded vertex grid below already holds the finished surface and a full TerrainSample at every
   *  vertex - so placing a tree costs a lookup instead of another few terrain samples, and it
   *  stands on exactly the triangle that gets drawn rather than on a second opinion about it. */
  trees: TreePlacement[];
  /** The bushes, placed the same way - but only on chunks near enough to see them (see
   *  BUSH_MAX_DETAIL_RATIO). */
  bushes: TreePlacement[];
  /** The boulders, placed the same way, out to ROCK_MAX_DETAIL_RATIO. */
  rocks: TreePlacement[];
  /** Only full-detail chunks carry grass: each kind is only drawn within its own fadeEnd of the
   *  camera (see grassConfig.ts), inside the full-detail range. */
  grass: ChunkGrass | null;
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
 * Builds a displaced, texture-blended ground chunk from a terrain sampler, as plain arrays - pure
 * calculation, so it runs the same in a worker (see chunkBuild.worker.ts) as on the main thread.
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
export function buildChunkGeometry(request: ChunkBuildRequest, context: ChunkBuildContext): ChunkGeometry {
  const { size, subdivisions, detailSubdivisions, originX, originZ } = request;
  const { sampleTerrain, materialBlender, scatterTrees, scatterBushes, scatterRocks, treeCover, seed, groundColors, grassKinds } = context;

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
      const worldX = originX + paddedPositions[index * 3];
      const worldZ = originZ + paddedPositions[index * 3 + 2];
      const context = buildVertexContext(paddedPositions, paddedNormals, paddedSamples, paddedSize, index, curvatureSteps, {
        cover: treeCover,
        worldX,
        worldZ,
      });
      blends[(row + 1) * ringSize + (col + 1)] = materialBlender.buildMaterialBlend(worldX, worldZ, context, paddedSamples[index].areaWeights);
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

  /**
   * How far this chunk's skirts hang. A neighbour one level finer or coarser draws the shared edge
   * through different vertices, so the two edges part; wherever this chunk's edge is the higher
   * one, its skirt is what fills the gap. Both cases are measured along this chunk's own edges:
   *  - a coarser neighbour skips every other vertex and draws straight between the rest;
   *  - a finer one adds a vertex between each pair, sampled exactly where it will sample it.
   * The deepest gap found, plus SKIRT_MARGIN, is the depth - usually well under a metre, several
   * metres only along cliffs.
   */
  function skirtDepth(): number {
    let deepest = 0;
    const edges: [number, number, number, number][] = [
      [0, 0, 0, 1],
      [subdivisions, 0, 0, 1],
      [0, 0, 1, 0],
      [0, subdivisions, 1, 0],
    ];
    for (const [row0, col0, dRow, dCol] of edges) {
      const heightAt = (i: number): number => paddedPositions[padded(row0 + dRow * i, col0 + dCol * i) * 3 + 1];
      if (subdivisions % 2 === 0) {
        for (let i = 1; i < subdivisions; i += 2) {
          deepest = Math.max(deepest, heightAt(i) - (heightAt(i - 1) + heightAt(i + 1)) / 2);
        }
      }
      if (detailRatio > 1) {
        const finer = subdivisions * 2;
        for (let i = 0; i < subdivisions; i++) {
          const row = (row0 + dRow * i) * 2 + dRow;
          const col = (col0 + dCol * i) * 2 + dCol;
          const localX = (col * size) / finer - size / 2;
          const localZ = ((finer - row) * size) / finer - size / 2;
          const between = sampleTerrain(originX + localX, originZ + localZ).height;
          deepest = Math.max(deepest, (heightAt(i) + heightAt(i + 1)) / 2 - between);
        }
      }
    }
    return deepest + SKIRT_MARGIN;
  }
  const skirt = skirtDepth();

  /** A copy of `vertex` `skirt` lower, with the same normal and materials, so a skirt looks
   *  like the edge it hangs from. */
  function pushDroppedVertex(vertex: number): number {
    const index = positions.length / 3;
    positions.push(positions[vertex * 3], positions[vertex * 3 + 1] - skirt, positions[vertex * 3 + 2]);
    normals.push(normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]);
    for (let slot = 0; slot < 4; slot++) {
      matIndices.push(matIndices[vertex * 4 + slot]);
      matWeights.push(matWeights[vertex * 4 + slot]);
    }
    return index;
  }

  // Skirts: each edge segment hangs a quad straight down. Two-sided (both windings), because which
  // side a gap is seen from depends on which neighbour's edge ends up higher. Each segment is one
  // owner's (corner to midpoint), so its two vertices already share a material list.
  const borderEdges: [number[], number[]][] = [];
  for (let i = 0; i < subdivisions; i++) {
    borderEdges.push([[0, i], [0, i + 1]], [[subdivisions, i], [subdivisions, i + 1]]);
    borderEdges.push([[i, 0], [i + 1, 0]], [[i, subdivisions], [i + 1, subdivisions]]);
  }
  for (const [a, b] of borderEdges) {
    const segments = [
      [cornerVertex[a[0] * gridSize + a[1]], midpointVertex(a, b)],
      [midpointVertex(b, a), cornerVertex[b[0] * gridSize + b[1]]],
    ];
    for (const [top0, top1] of segments) {
      const low0 = pushDroppedVertex(top0);
      const low1 = pushDroppedVertex(top1);
      indices.push(top0, top1, low1, top0, low1, low0);
      indices.push(top0, low1, top1, top0, low0, low1);
    }
  }

  // The plain grid, 2 triangles per square: the 8-way split above only exists to carry material
  // lists - its extra vertices are averages of the corners and add no height detail - so the depth
  // pass can draw the same surface with a quarter of the vertices and triangles.
  const shadowPositions: number[] = [];
  const shadowNormals: number[] = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const p = padded(row, col);
      shadowPositions.push(paddedPositions[p * 3], paddedPositions[p * 3 + 1], paddedPositions[p * 3 + 2]);
      shadowNormals.push(paddedNormals[p * 3], paddedNormals[p * 3 + 1], paddedNormals[p * 3 + 2]);
    }
  }
  const shadowIndices: number[] = [];
  for (let row = 0; row < subdivisions; row++) {
    for (let col = 0; col < subdivisions; col++) {
      const a = row * gridSize + col;
      shadowIndices.push(a + gridSize + 1, a + 1, a);
      shadowIndices.push(a + gridSize, a + gridSize + 1, a);
    }
  }
  // The same skirts, so light cannot leak through a level-of-detail gap either.
  for (const [a, b] of borderEdges) {
    const top0 = a[0] * gridSize + a[1];
    const top1 = b[0] * gridSize + b[1];
    const low0 = shadowPositions.length / 3;
    const low1 = low0 + 1;
    for (const top of [top0, top1]) {
      shadowPositions.push(shadowPositions[top * 3], shadowPositions[top * 3 + 1] - skirt, shadowPositions[top * 3 + 2]);
      shadowNormals.push(shadowNormals[top * 3], shadowNormals[top * 3 + 1], shadowNormals[top * 3 + 2]);
    }
    shadowIndices.push(top0, top1, low1, top0, low1, low0);
    shadowIndices.push(top0, low1, top1, top0, low0, low1);
  }
  /** Height inside one grid square, split the same 8 ways the visible mesh is. */
  function heightInSquare(heightOf: (row: number, col: number) => number, row: number, col: number, u: number, v: number): number {
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

  const trees = scatterTrees(
    originX - size / 2,
    originZ - size / 2,
    originX + size / 2,
    originZ + size / 2,
    probeGround,
  );

  const bushes =
    detailRatio <= BUSH_MAX_DETAIL_RATIO
      ? scatterBushes(originX - size / 2, originZ - size / 2, originX + size / 2, originZ + size / 2, probeGround)
      : [];

  const rocks =
    detailRatio <= ROCK_MAX_DETAIL_RATIO
      ? scatterRocks(originX - size / 2, originZ - size / 2, originX + size / 2, originZ + size / 2, probeGround)
      : [];

  const grass =
    detailRatio === 1
      ? scatterGrass(
          {
            size,
            subdivisions,
            originX,
            originZ,
            blendAt,
            surfaceHeight: (row, col, u, v) =>
              heightInSquare((r, c) => paddedPositions[(r * paddedSize + c) * 3 + 1], row + pad, col + pad, u, v),
          },
          materialBlender.materialDefs,
          grassKinds,
          seed,
          groundColors,
        )
      : null;

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    matIndices: new Float32Array(matIndices),
    matWeights: new Float32Array(matWeights),
    indices: new Uint32Array(indices),
    shadowPositions: new Float32Array(shadowPositions),
    shadowNormals: new Float32Array(shadowNormals),
    shadowIndices: new Uint32Array(shadowIndices),
    trees,
    bushes,
    rocks,
    grass,
  };
}
