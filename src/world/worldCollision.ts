import { collisionStats, createCollisionWorld, type CollisionWorld, type ShapeDesc, type Vec3 } from "./collision/index";
import type { ChunkGeometry } from "./terrain/chunkGeometry";
import type { TreeField } from "./foliage/treeField";
import type { TerrainCut } from "./materials/materialLibrary";

/**
 * The world as the player collides with it (see COLLISION.md): the ground and the trees of every
 * full-detail chunk - the ones within a couple of hundred metres - added and taken away with the
 * chunk, and whatever else is put in by key (the buildings of the settlements near the player).
 */
export interface WorldCollision {
  readonly world: CollisionWorld;
  /** Replaces what a chunk puts in the way. Only a full-detail chunk (level 0) puts anything. */
  setChunk: (key: string, geometry: ChunkGeometry, centerX: number, centerZ: number, level: number, subdivisions: number) => void;
  clearChunk: (key: string) => void;
  /** Puts other shapes in, under a key of their own - replacing whatever was there under it. */
  setExtra: (key: string, shapes: ShapeDesc[]) => void;
  clearExtra: (key: string) => void;
  /** Whether the ground under a point is in the collision world yet - its chunk built near enough. */
  hasGroundAt: (x: number, z: number) => boolean;
  /** How many chunks have their collision in, and how many shapes they and the rest hold in all -
   *  for profiling. */
  readonly chunkCount: number;
  readonly shapeCount: number;
}

/** How deep the pieces of ground left round a cellar's hole reach under the surface. */
const PATCH_DEPTH = 1;

/**
 * `cellarCuts` are where the ground is taken out over cellars (see buildings/buildingRenderer.ts): the
 * ground's collision is cut there too, so a cellar can be walked down into.
 */
export function createWorldCollision(trees: TreeField, chunkSize: number, cellarCuts: readonly TerrainCut[] = []): WorldCollision {
  const world = createCollisionWorld();
  const batches = new Map<string, number>();
  const shapeCount = new Map<string, number>();
  let chunks = 0;

  function clear(key: string): void {
    const batch = batches.get(key);
    if (batch === undefined) return;
    world.removeBatch(batch);
    batches.delete(key);
    shapeCount.delete(key);
  }

  function set(key: string, shapes: ShapeDesc[]): void {
    clear(key);
    batches.set(key, world.addBatch(shapes));
    shapeCount.set(key, shapes.length);
  }

  function chunkKey(key: string): string {
    return `chunk:${key}`;
  }

  function clearChunk(key: string): void {
    if (batches.has(chunkKey(key))) chunks--;
    clear(chunkKey(key));
  }

  function setChunk(key: string, geometry: ChunkGeometry, centerX: number, centerZ: number, level: number, subdivisions: number): void {
    clearChunk(key);
    if (level !== 0) return;
    const started = performance.now();
    const shapes = ground(geometry, centerX, centerZ, subdivisions);
    shapes.push(...trees.colliders(geometry.trees));
    set(chunkKey(key), shapes);
    chunks++;
    collisionStats.chunksBuilt++;
    collisionStats.chunkMs += performance.now() - started;
  }

  /**
   * A chunk's ground, from its plain grid (ChunkGeometry.shadowPositions, before its skirts): rows
   * run from the chunk's far edge (+z) to its near one, so they are turned about into the
   * heightfield's order, which runs the other way. Each square split in four about its middle, as
   * the drawn ground is.
   *
   * Where a cellar's cut crosses a square, the square is a hole - and what of it lies outside the
   * cut is put back, as slabs of ground of its own.
   */
  function ground(geometry: ChunkGeometry, centerX: number, centerZ: number, subdivisions: number): ShapeDesc[] {
    const size = subdivisions + 1;
    const cell = chunkSize / subdivisions;
    const originX = centerX - chunkSize / 2;
    const originZ = centerZ - chunkSize / 2;
    const positions = geometry.shadowPositions;
    const heights = new Float32Array(size * size);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        heights[(size - 1 - row) * size + col] = positions[(row * size + col) * 3 + 1];
      }
    }
    const shapes: ShapeDesc[] = [];
    const cuts = cellarCuts.filter((cut) => {
      const reach = Math.hypot(cut.halfWidth, cut.halfDepth);
      return cut.x + reach > originX && cut.x - reach < originX + chunkSize && cut.z + reach > originZ && cut.z - reach < originZ + chunkSize;
    });
    let holes: Uint8Array | undefined;
    if (cuts.length > 0) {
      holes = new Uint8Array(subdivisions * subdivisions);
      const h = (col: number, row: number): number => heights[row * size + col];
      for (let row = 0; row < subdivisions; row++) {
        for (let col = 0; col < subdivisions; col++) {
          const x0 = originX + col * cell;
          const z0 = originZ + row * cell;
          const crossing = cuts.filter((cut) => squareMeetsCut(x0, z0, cell, cut));
          if (crossing.length === 0) continue;
          holes[row * subdivisions + col] = 1;
          // The square's four triangles about its middle, less the cuts.
          const p00: Vec3 = { x: x0, y: h(col, row), z: z0 };
          const p10: Vec3 = { x: x0 + cell, y: h(col + 1, row), z: z0 };
          const p11: Vec3 = { x: x0 + cell, y: h(col + 1, row + 1), z: z0 + cell };
          const p01: Vec3 = { x: x0, y: h(col, row + 1), z: z0 + cell };
          const mid: Vec3 = { x: x0 + cell / 2, y: (p00.y + p10.y + p11.y + p01.y) / 4, z: z0 + cell / 2 };
          for (const triangle of [[p00, mid, p10], [p10, mid, p11], [p11, mid, p01], [p01, mid, p00]]) {
            let pieces: Vec3[][] = [triangle];
            for (const cut of crossing) pieces = pieces.flatMap((piece) => subtractCut(piece, cut));
            for (const piece of pieces) {
              if (areaXZ(piece) < 1e-3) continue;
              shapes.push({ kind: "convex", points: [...piece, ...piece.map((p) => ({ x: p.x, y: p.y - PATCH_DEPTH, z: p.z }))] });
            }
          }
        }
      }
    }
    shapes.unshift({ kind: "heightfield", originX, originZ, cell, columns: size, rows: size, heights, split: "centre", holes });
    return shapes;
  }

  function hasGroundAt(x: number, z: number): boolean {
    return batches.has(chunkKey(`${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}`));
  }

  return {
    world,
    setChunk,
    clearChunk,
    setExtra: (key, shapes) => set(`extra:${key}`, shapes),
    clearExtra: (key) => clear(`extra:${key}`),
    hasGroundAt,
    get chunkCount() {
      return chunks;
    },
    get shapeCount() {
      let total = 0;
      for (const n of shapeCount.values()) total += n;
      return total;
    },
  };
}

/** A cut's four half-planes, each as (a, b, c): a point (x, z) is inside where a x + b z + c <= 0. */
function cutPlanes(cut: TerrainCut): [number, number, number][] {
  // Its width runs along u, its depth along w, square to it.
  const wx = -cut.uz;
  const wz = cut.ux;
  const along = (ax: number, az: number, half: number, sign: number): [number, number, number] => [sign * ax, sign * az, -sign * (ax * cut.x + az * cut.z) - half];
  return [along(cut.ux, cut.uz, cut.halfWidth, 1), along(cut.ux, cut.uz, cut.halfWidth, -1), along(wx, wz, cut.halfDepth, 1), along(wx, wz, cut.halfDepth, -1)];
}

/** Whether a square of the ground and a cut overlap - by the separating axis test in plan. */
function squareMeetsCut(x0: number, z0: number, size: number, cut: TerrainCut): boolean {
  const corners = [[x0, z0], [x0 + size, z0], [x0 + size, z0 + size], [x0, z0 + size]];
  // The cut's own axes: the square wholly past one of its sides.
  for (const [a, b, c] of cutPlanes(cut)) if (corners.every(([x, z]) => a * x + b * z + c >= 0)) return false;
  // The square's axes: the cut wholly past one of the square's sides.
  const wx = -cut.uz;
  const wz = cut.ux;
  const cutCorners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([s, t]) => [
    cut.x + s * cut.ux * cut.halfWidth + t * wx * cut.halfDepth,
    cut.z + s * cut.uz * cut.halfWidth + t * wz * cut.halfDepth,
  ]);
  if (cutCorners.every(([x]) => x <= x0) || cutCorners.every(([x]) => x >= x0 + size)) return false;
  if (cutCorners.every(([, z]) => z <= z0) || cutCorners.every(([, z]) => z >= z0 + size)) return false;
  return true;
}

/** The parts of a flat convex polygon outside a cut, in plan: at most four convex pieces. */
function subtractCut(polygon: Vec3[], cut: TerrainCut): Vec3[][] {
  const pieces: Vec3[][] = [];
  let remaining = polygon;
  for (const [a, b, c] of cutPlanes(cut)) {
    const outside = clip(remaining, -a, -b, -c);
    if (outside.length >= 3) pieces.push(outside);
    remaining = clip(remaining, a, b, c);
    if (remaining.length < 3) break;
  }
  return pieces;
}

/** A convex polygon cut to where a x + b z + c <= 0 - its height carried along its edges. */
function clip(polygon: Vec3[], a: number, b: number, c: number): Vec3[] {
  const out: Vec3[] = [];
  for (let k = 0; k < polygon.length; k++) {
    const p = polygon[k];
    const q = polygon[(k + 1) % polygon.length];
    const fp = a * p.x + b * p.z + c;
    const fq = a * q.x + b * q.z + c;
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t });
    }
  }
  return out;
}

function areaXZ(polygon: Vec3[]): number {
  let sum = 0;
  for (let k = 0; k < polygon.length; k++) {
    const p = polygon[k];
    const q = polygon[(k + 1) % polygon.length];
    sum += p.x * q.z - q.x * p.z;
  }
  return Math.abs(sum) / 2;
}
