import type { GroundMesh, Scene } from "@babylonjs/core";
import { createTerrainChunk } from "./terrainMesh";
import type { TerrainSampler } from "./terrainSampler";
import type { MaterialLibrary } from "../materials/materialLibrary";

export interface ChunkManagerOptions {
  scene: Scene;
  sampleTerrain: TerrainSampler;
  materialLibrary: MaterialLibrary;
  chunkSize: number;
  chunkSubdivisions: number;
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

function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

/** Streams terrain chunk meshes in/out around a moving position based on a load/unload radius. */
export function createChunkManager(options: ChunkManagerOptions): ChunkManager {
  const { scene, sampleTerrain, materialLibrary, chunkSize, chunkSubdivisions } = options;

  let loadRadius = options.loadRadius;
  let unloadRadius = options.unloadRadius;

  const loaded = new Map<string, GroundMesh>();
  const queued = new Set<string>();
  const buildQueue: ChunkCoord[] = [];

  let lastPlayerChunkX: number | null = null;
  let lastPlayerChunkZ: number | null = null;
  let lastX = 0;
  let lastZ = 0;

  function chunkCenter(cx: number, cz: number): { x: number; z: number } {
    return { x: (cx + 0.5) * chunkSize, z: (cz + 0.5) * chunkSize };
  }

  function withinRadius(cx: number, cz: number, x: number, z: number, radius: number): boolean {
    const center = chunkCenter(cx, cz);
    const dx = center.x - x;
    const dz = center.z - z;
    return dx * dx + dz * dz <= radius * radius;
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

  function buildChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const center = chunkCenter(cx, cz);
    const mesh = createTerrainChunk(scene, {
      name: `terrainChunk_${key}`,
      size: chunkSize,
      subdivisions: chunkSubdivisions,
      sampleTerrain,
      materialLibrary,
      originX: center.x,
      originZ: center.z,
    });
    loaded.set(key, mesh);
  }

  function enqueueMissingChunks(x: number, z: number): void {
    for (const { cx, cz } of candidateChunksInRadius(x, z, loadRadius)) {
      const key = chunkKey(cx, cz);
      if (!loaded.has(key) && !queued.has(key)) {
        queued.add(key);
        buildQueue.push({ cx, cz });
      }
    }
  }

  function unloadOutOfRangeChunks(x: number, z: number): void {
    for (const [key, mesh] of loaded) {
      const [cxStr, czStr] = key.split(",");
      const cx = Number(cxStr);
      const cz = Number(czStr);
      if (!withinRadius(cx, cz, x, z, unloadRadius)) {
        mesh.dispose();
        loaded.delete(key);
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

  function drainOneFromQueue(x: number, z: number): void {
    const next = takeNearestQueued(x, z);
    if (!next) return;

    const key = chunkKey(next.cx, next.cz);
    queued.delete(key);

    if (!withinRadius(next.cx, next.cz, x, z, unloadRadius)) {
      // Player moved on before this chunk was built; drop it instead of building then immediately disposing.
      return;
    }

    buildChunk(next.cx, next.cz);
  }

  function loadInitial(x: number, z: number): void {
    for (const { cx, cz } of candidateChunksInRadius(x, z, loadRadius)) {
      buildChunk(cx, cz);
    }
    lastPlayerChunkX = Math.floor(x / chunkSize);
    lastPlayerChunkZ = Math.floor(z / chunkSize);
    lastX = x;
    lastZ = z;
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

    drainOneFromQueue(x, z);
  }

  function setRadii(nextLoadRadius: number, nextUnloadRadius: number): void {
    loadRadius = nextLoadRadius;
    unloadRadius = nextUnloadRadius;
    // Re-evaluate immediately against the last known position so a draw-distance change takes
    // effect right away instead of waiting for the next chunk-boundary crossing.
    enqueueMissingChunks(lastX, lastZ);
    unloadOutOfRangeChunks(lastX, lastZ);
  }

  function dispose(): void {
    for (const mesh of loaded.values()) {
      mesh.dispose();
    }
    loaded.clear();
    queued.clear();
    buildQueue.length = 0;
  }

  return { loadInitial, update, setRadii, dispose };
}
