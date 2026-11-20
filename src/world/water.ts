import { SEA_LEVEL } from "./cells/areaField";

/** The sea's surface, and the level the legacy rivers, lakes and ponds stand at: the ocean plane sits
 *  here, and the terrain shader tints what is under it (WATER.md). A little under SEA_LEVEL, so the
 *  plane never lies exactly on ground that is at sea level. Water that is not the sea has a surface of
 *  its own (see `WaterBodies`). */
export const WATER_SURFACE = SEA_LEVEL - 0.1;

/** The line a point's water is read against for "is this ground wet": SEA_LEVEL for the sea (where
 *  every shore rule has always been measured), a river's own surface where it stands over the point
 *  (TerrainSample.waterSurface). So a world without water at its own levels reads exactly as before. */
export function waterLineOf(waterSurface: number): number {
  return waterSurface > WATER_SURFACE ? waterSurface : SEA_LEVEL;
}

/** The water at a point: where its surface is and how deep it is over the ground there (0 on dry land). */
export interface WaterSample {
  surface: number;
  depth: number;
}

/** What `waterAt` needs of a world: its ground height. */
export type HeightAt = (x: number, z: number) => number;

/**
 * The water query (WATER.md): the surface height and depth at a point, for the simulation, the
 * client and the probes alike - pure, deterministic, from the terrain alone. `surface` is the level
 * the world's water stands at. Under a bridge it says water: a body on the deck is above it.
 *
 * This is the sea-level-only form: one surface everywhere. A world with water at its own level uses
 * `createWaterQuery`.
 */
export function createWaterAt(heightAt: HeightAt, surface: number | null = WATER_SURFACE): (x: number, z: number) => WaterSample {
  return (x, z) => {
    if (surface === null) return { surface: -Infinity, depth: 0 };
    return { surface, depth: Math.max(0, surface - heightAt(x, z)) };
  };
}

// --- Water at its own level -------------------------------------------------------------------

/**
 * A body of still water at one height that is not the sea: a pond or lake (outdoors, over ground that
 * dips below `level` inside `polygon`) or a pool (inside a cave or a building: a volume between
 * `bottom` and `ceiling` that the ground above knows nothing of).
 */
export interface FlatWater {
  id: string;
  kind: "pond" | "pool";
  /** The surface height. */
  level: number;
  /** A pool's floor: its depth is `level - bottom`. A pond's depth is the ground's. */
  bottom?: number;
  /** A pool's roof: a body above it is not in the pool. Defaults to a metre over the surface. */
  ceiling?: number;
  /** The footprint, counter-clockwise or not, in x and z. */
  polygon: ReadonlyArray<{ x: number; z: number }>;
}

/** What the terrain sampler says of a point's water: the ground there and the river's surface over it. */
export interface WaterGround {
  height: number;
  /** The surface of the water that stands over this point, `WATER_SURFACE` where it is only the sea. */
  waterSurface: number;
}

function inside(polygon: FlatWater["polygon"], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

/**
 * The water bodies a world has beyond its sea: the rivers (read through the terrain's own `waterSurface`)
 * and the flat bodies registered with `add` - the lake, the mill pond, a cave's pool. Features add their
 * own as they are placed; `waterAt` sees them at once.
 */
export interface FlatWaters {
  readonly flats: readonly FlatWater[];
  add(body: FlatWater): void;
}

export function createFlatWaters(): FlatWaters {
  const flats: FlatWater[] = [];
  return { flats, add: (body) => void flats.push(body) };
}

/**
 * The water query for a world whose water has its own levels: at a point, the highest surface that
 * has water under it - the sea, the river whose valley the point lies in, a pond over a dip, a pool
 * the height `y` is inside - and how deep the water is there. `y` (a body's height) is only read to
 * tell a cave's pool from the ground above it; without it only the open air's water answers.
 */
export function createWaterQuery(
  ground: (x: number, z: number) => WaterGround,
  waters: FlatWaters,
  seaSurface: number | null = WATER_SURFACE,
): (x: number, z: number, y?: number) => WaterSample {
  return (x, z, y) => {
    if (seaSurface === null) return { surface: -Infinity, depth: 0 };
    const g = ground(x, z);
    let surface = g.waterSurface;
    let depth = Math.max(0, surface - g.height);
    for (const body of waters.flats) {
      if (body.kind === "pool") {
        if (y === undefined || y < (body.bottom ?? -Infinity) || y > (body.ceiling ?? body.level + 1) || !inside(body.polygon, x, z)) continue;
        surface = body.level;
        depth = body.level - (body.bottom ?? body.level - 1);
      } else if (body.level > g.height && body.level >= surface - 1e-9 && inside(body.polygon, x, z)) {
        surface = body.level;
        depth = body.level - g.height;
      }
    }
    return { surface, depth };
  };
}
