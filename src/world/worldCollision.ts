import { collisionStats, createCollisionWorld, type CollisionWorld, type ShapeDesc } from "./collision/index";
import type { ChunkGeometry } from "./terrain/chunkGeometry";
import type { TreeField } from "./foliage/treeField";

/**
 * The world as the player collides with it (see COLLISION.md): the ground and the trees of every
 * full-detail chunk - the ones within a couple of hundred metres - added and taken away with the
 * chunk. Buildings are not in it yet.
 */
export interface WorldCollision {
  readonly world: CollisionWorld;
  /** Replaces what a chunk puts in the way. Only a full-detail chunk (level 0) puts anything. */
  setChunk: (key: string, geometry: ChunkGeometry, centerX: number, centerZ: number, level: number, subdivisions: number) => void;
  clearChunk: (key: string) => void;
  /** Whether the ground under a point is in the collision world yet - its chunk built near enough. */
  hasGroundAt: (x: number, z: number) => boolean;
  /** How many chunks have their collision in, and how many shapes they hold in all - for profiling. */
  readonly chunkCount: number;
  readonly shapeCount: number;
}

export function createWorldCollision(trees: TreeField, chunkSize: number): WorldCollision {
  const world = createCollisionWorld();
  const batches = new Map<string, number>();
  const shapeCount = new Map<string, number>();

  function clearChunk(key: string): void {
    const batch = batches.get(key);
    if (batch === undefined) return;
    world.removeBatch(batch);
    batches.delete(key);
    shapeCount.delete(key);
  }

  function setChunk(key: string, geometry: ChunkGeometry, centerX: number, centerZ: number, level: number, subdivisions: number): void {
    clearChunk(key);
    if (level !== 0) return;
    const started = performance.now();
    const shapes: ShapeDesc[] = [ground(geometry, centerX, centerZ, subdivisions)];
    shapes.push(...trees.colliders(geometry.trees));
    batches.set(key, world.addBatch(shapes));
    shapeCount.set(key, shapes.length);
    collisionStats.chunksBuilt++;
    collisionStats.chunkMs += performance.now() - started;
  }

  /**
   * A chunk's ground, from its plain grid (ChunkGeometry.shadowPositions, before its skirts): rows
   * run from the chunk's far edge (+z) to its near one, so they are turned about into the
   * heightfield's order, which runs the other way. Each square split in four about its middle, as
   * the drawn ground is.
   */
  function ground(geometry: ChunkGeometry, centerX: number, centerZ: number, subdivisions: number): ShapeDesc {
    const size = subdivisions + 1;
    const positions = geometry.shadowPositions;
    const heights = new Float32Array(size * size);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        heights[(size - 1 - row) * size + col] = positions[(row * size + col) * 3 + 1];
      }
    }
    return {
      kind: "heightfield",
      originX: centerX - chunkSize / 2,
      originZ: centerZ - chunkSize / 2,
      cell: chunkSize / subdivisions,
      columns: size,
      rows: size,
      heights,
      split: "centre",
    };
  }

  function hasGroundAt(x: number, z: number): boolean {
    return batches.has(`${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}`);
  }

  return {
    world,
    setChunk,
    clearChunk,
    hasGroundAt,
    get chunkCount() {
      return batches.size;
    },
    get shapeCount() {
      let total = 0;
      for (const n of shapeCount.values()) total += n;
      return total;
    },
  };
}
