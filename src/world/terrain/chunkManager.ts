import type { CascadedShadowGenerator, Scene } from "@babylonjs/core";
import { buildChunkGeometry, type ChunkBuildContext, type ChunkBuildRequest, type ChunkGeometry } from "./chunkGeometry";
import { createTerrainChunkMeshes, type TerrainChunkMeshes } from "./terrainMesh";
import type { ChunkBuildPool } from "./chunkBuildPool";
import type { MaterialLibrary } from "../materials/materialLibrary";
import type { TreeField } from "../foliage/treeField";
import type { GrassField } from "../foliage/grassField";

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

/** Main-thread builds (no worker pool, or an immediate load) run until this much of a frame has
 *  gone on them, always at least one. A full-detail chunk alone takes more than this; coarse ones
 *  take a fraction of it, so several fit. */
const BUILD_BUDGET_MS = 4;

export interface ChunkManagerOptions {
  scene: Scene;
  /** The world, for building chunks on the main thread - at load, for immediate loads, and as the
   *  fallback when there is no worker pool. */
  buildContext: ChunkBuildContext;
  /** Builds chunks off the main thread while walking around, so a full-detail chunk never costs a
   *  frame. Null builds everything on the main thread instead. */
  buildPool: ChunkBuildPool | null;
  materialLibrary: MaterialLibrary;
  /** Trees live and die with the chunk they stand on, so streaming them needs no radius of its
   *  own and they can never outlive the ground under them. */
  trees: TreeField;
  /** Like trees, grass comes and goes with its chunk - only full-detail chunks carry any. */
  grass: GrassField;
  /** A chunk registers itself as a shadow caster the moment it is built and unregisters on unload,
   *  so hills self-shadow their own valleys the same way anything else does. What it registers is
   *  its shadow-only stand-in (see TerrainChunkMeshes.shadowMesh), not the mesh that is drawn. */
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
  /** `immediate` builds queued chunks on the main thread this call instead of handing them to the
   *  workers - for a console session that wants a spot loaded now (see main.ts's gotoLoaded). */
  update: (x: number, z: number, immediate?: boolean) => void;
  setRadii: (loadRadius: number, unloadRadius: number) => void;
  dispose: () => void;
}

interface ChunkCoord {
  cx: number;
  cz: number;
}

interface LoadedChunk {
  meshes: TerrainChunkMeshes;
  level: number;
}

interface FinishedBuild extends ChunkCoord {
  level: number;
  geometry: ChunkGeometry;
}

function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

/**
 * Streams terrain chunk meshes in/out around a moving position based on a load/unload radius, and
 * rebuilds them at a coarser or finer level of detail as their distance changes.
 *
 * Neighbouring chunks at different levels draw their shared edge through different vertices; each
 * chunk's skirt (see chunkGeometry.ts) covers the gap, so no chunk ever needs to know its
 * neighbours' levels. A chunk being rebuilt keeps its old mesh until the new one replaces it.
 *
 * While walking, chunks are built by the worker pool: the nearest queued chunks are handed out a
 * few at a time, and each one that comes back is turned into meshes at the start of the next
 * update. A result can be stale by then - the player moved on, or the chunk needs another level -
 * so it is checked against where the player is at that point, not where they were when it was sent.
 */
export function createChunkManager(options: ChunkManagerOptions): ChunkManager {
  const { scene, buildContext, materialLibrary, trees, grass, shadowGenerator, chunkSize, lodLevels } = options;
  const detailSubdivisions = lodLevels[0].subdivisions;
  let buildPool = options.buildPool;

  let loadRadius = options.loadRadius;
  let unloadRadius = options.unloadRadius;

  const loaded = new Map<string, LoadedChunk>();
  const queued = new Set<string>();
  const buildQueue: ChunkCoord[] = [];
  /** Chunks a worker is building, by key. */
  const inFlight = new Set<string>();
  const finished: FinishedBuild[] = [];
  let disposed = false;

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

  function buildRequest(cx: number, cz: number, level: number): ChunkBuildRequest {
    const center = chunkCenter(cx, cz);
    return {
      size: chunkSize,
      subdivisions: lodLevels[level].subdivisions,
      detailSubdivisions,
      originX: center.x,
      originZ: center.z,
    };
  }

  /** Puts a built chunk in the world, replacing whatever version of it was there. */
  function install(cx: number, cz: number, level: number, geometry: ChunkGeometry): void {
    const key = chunkKey(cx, cz);
    const center = chunkCenter(cx, cz);
    const meshes = createTerrainChunkMeshes(scene, `terrainChunk_${key}`, geometry, center.x, center.z, materialLibrary);
    const previous = loaded.get(key);
    if (previous) {
      previous.meshes.mesh.dispose();
      shadowGenerator.removeShadowCaster(previous.meshes.shadowMesh);
    }
    loaded.set(key, { meshes, level });
    trees.setChunk(key, geometry.trees);
    grass.setChunk(key, geometry.grass, center.x, center.z, chunkSize);
    shadowGenerator.addShadowCaster(meshes.shadowMesh);
  }

  function buildNow(cx: number, cz: number, level: number): void {
    install(cx, cz, level, buildChunkGeometry(buildRequest(cx, cz, level), buildContext));
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
    for (const [key, { meshes }] of loaded) {
      const [cxStr, czStr] = key.split(",");
      const cx = Number(cxStr);
      const cz = Number(czStr);
      if (!withinRadius(cx, cz, x, z, unloadRadius)) {
        meshes.mesh.dispose();
        loaded.delete(key);
        trees.clearChunk(key);
        grass.clearChunk(key);
        shadowGenerator.removeShadowCaster(meshes.shadowMesh);
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
   * instead of working through a stale ordering. The scan is O(queue length) per chunk taken, over
   * a queue of at most a few hundred entries.
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

  /**
   * The next queued chunk that actually needs building, and at what level - or undefined once the
   * queue is empty. Levels are decided here rather than when a chunk is queued, so one that sat in
   * the queue while the player moved still comes out right, or turns out not to need a rebuild.
   */
  function takeNextBuild(x: number, z: number): (ChunkCoord & { level: number }) | undefined {
    for (;;) {
      const next = takeNearestQueued(x, z);
      if (!next) return undefined;
      const key = chunkKey(next.cx, next.cz);
      queued.delete(key);
      // Player moved on before this chunk was built; drop it instead of building then immediately disposing.
      if (!withinRadius(next.cx, next.cz, x, z, unloadRadius)) continue;
      // Already on its way; once it lands, applyFinished queues it again if it needs another level.
      if (inFlight.has(key)) continue;
      const current = loaded.get(key)?.level;
      const level = levelFor(next.cx, next.cz, x, z, current);
      if (level === current) continue;
      return { ...next, level };
    }
  }

  function drainOnMainThread(x: number, z: number): void {
    const start = performance.now();
    do {
      const next = takeNextBuild(x, z);
      if (!next) return;
      buildNow(next.cx, next.cz, next.level);
    } while (performance.now() - start < BUILD_BUDGET_MS);
  }

  function dispatchToWorkers(pool: ChunkBuildPool, x: number, z: number): void {
    while (inFlight.size < pool.capacity) {
      const next = takeNextBuild(x, z);
      if (!next) return;
      const { cx, cz, level } = next;
      const key = chunkKey(cx, cz);
      inFlight.add(key);
      pool.build(buildRequest(cx, cz, level)).then(
        (geometry) => finished.push({ cx, cz, level, geometry }),
        (error: unknown) => {
          inFlight.delete(key);
          if (disposed) return;
          // Whatever broke the worker would break every later build too, so fall back to the main
          // thread for good rather than retrying into the same failure.
          console.error("Chunk build worker failed; building on the main thread from now on.", error);
          buildPool = null;
          enqueue(cx, cz);
        },
      );
    }
  }

  /** Installs whatever the workers finished since the last update, unless it is stale by now. */
  function applyFinished(x: number, z: number): void {
    for (const { cx, cz, level, geometry } of finished.splice(0)) {
      const key = chunkKey(cx, cz);
      inFlight.delete(key);
      if (!withinRadius(cx, cz, x, z, unloadRadius)) continue;
      const current = loaded.get(key)?.level;
      // Built on the main thread in the meantime (an immediate load).
      if (current === level) continue;
      const wanted = levelFor(cx, cz, x, z, current);
      if (current !== undefined && level !== wanted) {
        // A rebuild overtaken by the player's movement: the version already there does until the
        // right level is built.
        enqueue(cx, cz);
        continue;
      }
      install(cx, cz, level, geometry);
      // A chunk that was missing goes in even at the wrong level, since that beats a hole, and is
      // queued again for the right one.
      if (level !== wanted) enqueue(cx, cz);
    }
  }

  function loadInitial(x: number, z: number): void {
    for (const { cx, cz } of candidateChunksInRadius(x, z, loadRadius)) {
      buildNow(cx, cz, levelFor(cx, cz, x, z));
    }
    lodCheckX = x;
    lodCheckZ = z;
    lastPlayerChunkX = Math.floor(x / chunkSize);
    lastPlayerChunkZ = Math.floor(z / chunkSize);
    lastX = x;
    lastZ = z;
    trees.flush();
  }

  function update(x: number, z: number, immediate = false): void {
    lastX = x;
    lastZ = z;

    applyFinished(x, z);

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

    if (buildPool && !immediate) dispatchToWorkers(buildPool, x, z);
    else drainOnMainThread(x, z);
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
    disposed = true;
    for (const [key, { meshes }] of loaded) {
      meshes.mesh.dispose();
      trees.clearChunk(key);
      grass.clearChunk(key);
      shadowGenerator.removeShadowCaster(meshes.shadowMesh);
    }
    loaded.clear();
    queued.clear();
    buildQueue.length = 0;
    finished.length = 0;
  }

  return { loadInitial, update, setRadii, dispose };
}
