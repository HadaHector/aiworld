import { buildChunkCollision } from "../world/terrain/chunkGround";
import type { ChunkBuildRequest } from "../world/terrain/chunkGeometry";
import type { TreeScatter } from "../world/foliage/treeScatter";
import type { TerrainSampler } from "../world/terrain/terrainSampler";
import type { WorldCollision } from "../world/worldCollision";
import type { PlacedBuildings } from "../world/buildings/buildingCollision";

/** Chunks this wide, at this many squares a side - the drawn world's full detail, so the server's
 *  ground is the same heightfield the client draws near the player. */
export const COLLISION_CHUNK_SIZE = 64;
const SUBDIVISIONS = 24;

/** What builds a chunk's collision: the same request for the same chunk every time, so whoever
 *  else scatters its trees (see trunks.ts) gets the trees it holds. */
export function collisionChunkRequest(cx: number, cz: number): ChunkBuildRequest {
  return { size: COLLISION_CHUNK_SIZE, subdivisions: SUBDIVISIONS, detailSubdivisions: SUBDIVISIONS, originX: (cx + 0.5) * COLLISION_CHUNK_SIZE, originZ: (cz + 0.5) * COLLISION_CHUNK_SIZE };
}

/** A chunk comes in once its middle is this near a player, and goes again past UNLOAD_RADIUS. */
const LOAD_RADIUS = 128;
const UNLOAD_RADIUS = 192;

export interface CollisionStreamer {
  /** Brings in the chunks around `points` (the players) nearest first, until `budgetMs` is spent -
   *  always at least one - and drops those no point is near any more. */
  update: (points: readonly { x: number; z: number }[], budgetMs: number) => void;
  /** Brings in every chunk around a point now - after a teleport - and the buildings near it;
   *  `points` are where every player now is, that point among them. */
  loadAround: (x: number, z: number, points: readonly { x: number; z: number }[]) => void;
  readonly chunkCount: number;
}

/**
 * Keeps what is around the players in the server's collision world: the ground and trees of the
 * chunks near each (collision-only chunks: see terrain/chunkGround.ts), and the buildings of the
 * settlements and compounds near each. The drawn world keeps its own collision for the camera; this
 * one is what bodies walk on (see SIMULATION.md).
 */
export function createCollisionStreamer(
  context: { sampleTerrain: TerrainSampler; scatterTrees: TreeScatter },
  collision: WorldCollision,
  buildings: PlacedBuildings,
): CollisionStreamer {
  const loaded = new Set<string>();
  const key = (cx: number, cz: number): string => `${cx},${cz}`;
  const centre = (c: number): number => (c + 0.5) * COLLISION_CHUNK_SIZE;

  function build(cx: number, cz: number): void {
    const request = collisionChunkRequest(cx, cz);
    collision.setChunk(key(cx, cz), buildChunkCollision(request, context), request.originX, request.originZ, 0, SUBDIVISIONS);
    loaded.add(key(cx, cz));
  }

  /** The chunks a point wants and does not have yet, nearest first. */
  function wanted(x: number, z: number): { cx: number; cz: number; distance: number }[] {
    const reach = Math.ceil(LOAD_RADIUS / COLLISION_CHUNK_SIZE) + 1;
    const out: { cx: number; cz: number; distance: number }[] = [];
    const px = Math.floor(x / COLLISION_CHUNK_SIZE);
    const pz = Math.floor(z / COLLISION_CHUNK_SIZE);
    for (let cx = px - reach; cx <= px + reach; cx++) {
      for (let cz = pz - reach; cz <= pz + reach; cz++) {
        const distance = Math.hypot(centre(cx) - x, centre(cz) - z);
        if (distance <= LOAD_RADIUS && !loaded.has(key(cx, cz))) out.push({ cx, cz, distance });
      }
    }
    return out;
  }

  function update(points: readonly { x: number; z: number }[], budgetMs: number): void {
    // Out first: whatever no point is near.
    for (const k of loaded) {
      const [cx, cz] = k.split(",").map(Number);
      if (points.every((p) => Math.hypot(centre(cx) - p.x, centre(cz) - p.z) > UNLOAD_RADIUS)) {
        collision.clearChunk(k);
        loaded.delete(k);
      }
    }
    buildings.updateCollision(points, collision.setExtra, collision.clearExtra);
    const queue = points.flatMap((p) => wanted(p.x, p.z)).sort((a, b) => a.distance - b.distance);
    const started = performance.now();
    for (const { cx, cz } of queue) {
      if (loaded.has(key(cx, cz))) continue;
      build(cx, cz);
      if (performance.now() - started >= budgetMs) break;
    }
  }

  function loadAround(x: number, z: number, points: readonly { x: number; z: number }[]): void {
    for (const { cx, cz } of wanted(x, z)) build(cx, cz);
    buildings.updateCollision(points, collision.setExtra, collision.clearExtra);
  }

  return {
    update,
    loadAround,
    get chunkCount() {
      return loaded.size;
    },
  };
}
