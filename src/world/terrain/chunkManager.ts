import type { CascadedShadowGenerator, Scene } from "@babylonjs/core";
import { createTerrainChunk, type TerrainChunk } from "./terrainMesh";
import type { TerrainSampler } from "./terrainSampler";
import type { MaterialLibrary } from "../materials/materialLibrary";
import type { TreeScatter } from "../foliage/treeScatter";
import type { TreeField } from "../foliage/treeField";

/** One level of detail: chunks whose centre is within `maxDistance` of the player (and beyond the
 *  previous level's) are built with `subdivisions` squares per side. */
export interface ChunkLodLevel {
  subdivisions: number;
  maxDistance: number;
}

/** How far past a level boundary a chunk has to be before it switches, so one sitting right on the
 *  boundary does not rebuild back and forth as the player shuffles about. */
const LOD_HYSTERESIS = 10;

/** How far the player moves between checks of which loaded chunks need a different level. */
const LOD_RECHECK_DISTANCE = 5;

/** Chunks are built until this much of a frame has gone on it (always at least one). A full-detail
 *  chunk alone takes more than this; coarse ones take a fraction of it, so several fit. */
const BUILD_BUDGET_MS = 4;

export interface ChunkManagerOptions {
  scene: Scene;
  sampleTerrain: TerrainSampler;
  materialLibrary: MaterialLibrary;
  scatterTrees: TreeScatter;
  /** Trees live and die with the chunk they stand on, so streaming them needs no radius of its
   *  own and they can never outlive the ground under them. */
  trees: TreeField;
  /** A chunk registers itself as a shadow caster the moment it is built and unregisters on unload,
   *  so hills self-shadow their own valleys the same way anything else does. What it registers is
   *  its shadow-only stand-in (see TerrainChunk.shadowMesh), not the mesh that is drawn. */
  shadowGenerator: CascadedShadowGenerator;
  chunkSize: number;
  /** Finest first; the last level's maxDistance should be Infinity. The first level's
   *  subdivisions is full detail, which every other level must divide. */
  lodLevels: ChunkLodLevel[];
  loadRadius: number;
  unloadRadius: number;
}

export interface ChunkManager {
  loadInitial: (x: number, z: number) => void;
  update: (x: number, z: number) => void;
  setRadii: (loadRadius: number, unloadRadius: number) => void;
  dispose: () => void;
}

interface ChunkCoord {
  cx: number;
  cz: number;
}

interface LoadedChunk {
  chunk: TerrainChunk;
  level: number;
}

function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

/**
 * Streams terrain chunk meshes in/out around a moving position based on a load/unload radius, and
 * rebuilds them at a coarser or finer level of detail as their distance changes.
 *
 * Neighbouring chunks at different levels draw their shared edge through different vertices; each
 * chunk's skirt (see terrainMesh.ts) covers the gap, so no chunk ever needs to know its
 * neighbours' levels. A chunk being rebuilt keeps its old mesh until the new one replaces it.
 */
export function createChunkManager(options: ChunkManagerOptions): ChunkManager {
  const { scene, sampleTerrain, materialLibrary, scatterTrees, trees, shadowGenerator, chunkSize, lodLevels } = options;
  const detailSubdivisions = lodLevels[0].subdivisions;

  let loadRadius = options.loadRadius;
  let unloadRadius = options.unloadRadius;

  const loaded = new Map<string, LoadedChunk>();
  const queued = new Set<string>();
  const buildQueue: ChunkCoord[] = [];

  let lastPlayerChunkX: number | null = null;
  let lastPlayerChunkZ: number | null = null;
  let lastX = 0;
  let lastZ = 0;
  let lodCheckX = 0;
  let lodCheckZ = 0;

  function chunkCenter(cx: number, cz: number): { x: number; z: number } {
    return { x: (cx + 0.5) * chunkSize, z: (cz + 0.5) * chunkSize };
  }

  function withinRadius(cx: number, cz: number, x: number, z: number, radius: number): boolean {
    const center = chunkCenter(cx, cz);
    const dx = center.x - x;
    const dz = center.z - z;
    return dx * dx + dz * dz <= radius * radius;
  }

  /** The level a chunk should be at, keeping `current` while within LOD_HYSTERESIS of the boundary
   *  it would cross. */
  function levelFor(cx: number, cz: number, x: number, z: number, current?: number): number {
    const center = chunkCenter(cx, cz);
    const distance = Math.hypot(center.x - x, center.z - z);
    let level = lodLevels.findIndex((l) => distance <= l.maxDistance);
    if (level < 0) level = lodLevels.length - 1;
    if (current === undefined || level === current) return level;
    const boundary = lodLevels[Math.min(level, current)].maxDistance;
    return Math.abs(distance - boundary) < LOD_HYSTERESIS ? current : level;
  }

  function candidateChunksInRadius(x: number, z: number, radius: number): ChunkCoord[] {
    const chunkRadius = Math.ceil(radius / chunkSize) + 1;
    const centerCx = Math.floor(x / chunkSize);
    const centerCz = Math.floor(z / chunkSize);

    const candidates: ChunkCoord[] = [];
    for (let cx = centerCx - chunkRadius; cx <= centerCx + chunkRadius; cx++) {
      for (let cz = centerCz - chunkRadius; cz <= centerCz + chunkRadius; cz++) {
        if (withinRadius(cx, cz, x, z, radius)) {
          candidates.push({ cx, cz });
        }
      }
    }
    return candidates;
  }

  function buildChunk(cx: number, cz: number, level: number): void {
    const key = chunkKey(cx, cz);
    const center = chunkCenter(cx, cz);
    const chunk = createTerrainChunk(scene, {
      name: `terrainChunk_${key}`,
      size: chunkSize,
      subdivisions: lodLevels[level].subdivisions,
      detailSubdivisions,
      sampleTerrain,
      materialLibrary,
      scatterTrees,
      originX: center.x,
      originZ: center.z,
    });
    const previous = loaded.get(key);
    if (previous) {
      previous.chunk.mesh.dispose();
      shadowGenerator.removeShadowCaster(previous.chunk.shadowMesh);
    }
    loaded.set(key, { chunk, level });
    trees.setChunk(key, chunk.trees);
    shadowGenerator.addShadowCaster(chunk.shadowMesh);
  }

  function enqueue(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (queued.has(key)) return;
    queued.add(key);
    buildQueue.push({ cx, cz });
  }

  /** Queues every loaded chunk whose level no longer fits its distance. */
  function enqueueLevelChanges(x: number, z: number): void {
    lodCheckX = x;
    lodCheckZ = z;
    for (const [key, { level }] of loaded) {
      const [cx, cz] = key.split(",").map(Number);
      if (levelFor(cx, cz, x, z, level) !== level) enqueue(cx, cz);
    }
  }

  function enqueueMissingChunks(x: number, z: number): void {
    for (const { cx, cz } of candidateChunksInRadius(x, z, loadRadius)) {
      if (!loaded.has(chunkKey(cx, cz))) enqueue(cx, cz);
    }
  }

  function unloadOutOfRangeChunks(x: number, z: number): void {
    for (const [key, { chunk }] of loaded) {
      const [cxStr, czStr] = key.split(",");
      const cx = Number(cxStr);
      const cz = Number(czStr);
      if (!withinRadius(cx, cz, x, z, unloadRadius)) {
        chunk.mesh.dispose();
        loaded.delete(key);
        trees.clearChunk(key);
        shadowGenerator.removeShadowCaster(chunk.shadowMesh);
      }
    }
  }

  /**
   * Takes the queued chunk nearest the player, rather than the oldest.
   *
   * The candidate scan is a row-major sweep over a bounding box, so draining the queue in insertion
   * order filled the view in visible column-by-column bands - obvious whenever a lot of chunks are
   * pending at once, i.e. after a teleport or at speed. Picking by current distance instead makes
   * terrain grow outward from the player in rings.
   *
   * Distance is measured against where the player is *now*, not where they were when the chunk was
   * queued, so this also self-corrects when they keep moving: the queue reorders itself for free
   * instead of working through a stale ordering. The scan is O(queue length) once per frame, over a
   * queue of at most a few hundred entries.
   */
  function takeNearestQueued(x: number, z: number): ChunkCoord | undefined {
    if (buildQueue.length === 0) return undefined;

    let bestIndex = 0;
    let bestDistanceSq = Infinity;
    for (let i = 0; i < buildQueue.length; i++) {
      const center = chunkCenter(buildQueue[i].cx, buildQueue[i].cz);
      const dx = center.x - x;
      const dz = center.z - z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestIndex = i;
      }
    }

    return buildQueue.splice(bestIndex, 1)[0];
  }

  function drainQueue(x: number, z: number): void {
    const start = performance.now();
    do {
      const next = takeNearestQueued(x, z);
      if (!next) return;

      const key = chunkKey(next.cx, next.cz);
      queued.delete(key);

      if (!withinRadius(next.cx, next.cz, x, z, unloadRadius)) {
        // Player moved on before this chunk was built; drop it instead of building then immediately disposing.
        continue;
      }
      // Levels are decided when a chunk is built rather than when it is queued, so one that sat in
      // the queue while the player moved still comes out right - or turns out not to need a rebuild.
      const current = loaded.get(key)?.level;
      const level = levelFor(next.cx, next.cz, x, z, current);
      if (level === current) continue;

      buildChunk(next.cx, next.cz, level);
    } while (performance.now() - start < BUILD_BUDGET_MS);
  }

  function loadInitial(x: number, z: number): void {
    for (const { cx, cz } of candidateChunksInRadius(x, z, loadRadius)) {
      buildChunk(cx, cz, levelFor(cx, cz, x, z));
    }
    lodCheckX = x;
    lodCheckZ = z;
    lastPlayerChunkX = Math.floor(x / chunkSize);
    lastPlayerChunkZ = Math.floor(z / chunkSize);
    lastX = x;
    lastZ = z;
    trees.flush();
  }

  function update(x: number, z: number): void {
    lastX = x;
    lastZ = z;

    const playerChunkX = Math.floor(x / chunkSize);
    const playerChunkZ = Math.floor(z / chunkSize);

    if (playerChunkX !== lastPlayerChunkX || playerChunkZ !== lastPlayerChunkZ) {
      lastPlayerChunkX = playerChunkX;
      lastPlayerChunkZ = playerChunkZ;
      enqueueMissingChunks(x, z);
      unloadOutOfRangeChunks(x, z);
    }
    if (Math.hypot(x - lodCheckX, z - lodCheckZ) >= LOD_RECHECK_DISTANCE) {
      enqueueLevelChanges(x, z);
    }

    drainQueue(x, z);
    // One rebuild of the instance buffers per frame at most, however many chunks came and went -
    // and none at all on the frames where nothing did.
    trees.flush();
  }

  function setRadii(nextLoadRadius: number, nextUnloadRadius: number): void {
    loadRadius = nextLoadRadius;
    unloadRadius = nextUnloadRadius;
    // Re-evaluate immediately against the last known position so a draw-distance change takes
    // effect right away instead of waiting for the next chunk-boundary crossing.
    enqueueMissingChunks(lastX, lastZ);
    unloadOutOfRangeChunks(lastX, lastZ);
    trees.flush();
  }

  function dispose(): void {
    for (const [key, { chunk }] of loaded) {
      chunk.mesh.dispose();
      trees.clearChunk(key);
      shadowGenerator.removeShadowCaster(chunk.shadowMesh);
    }
    loaded.clear();
    queued.clear();
    buildQueue.length = 0;
  }

  return { loadInitial, update, setRadii, dispose };
}
