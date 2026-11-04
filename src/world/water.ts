import { SEA_LEVEL } from "./cells/areaField";

/** Every sea, lake, pond and river of the world is a hollow of the ground filled to this one level:
 *  the ocean plane sits here, and the terrain shader tints what is under it (WATER.md). A little
 *  under SEA_LEVEL, so the plane never lies exactly on ground that is at sea level. */
export const WATER_SURFACE = SEA_LEVEL - 0.1;

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
 */
export function createWaterAt(heightAt: HeightAt, surface: number | null = WATER_SURFACE): (x: number, z: number) => WaterSample {
  return (x, z) => {
    if (surface === null) return { surface: -Infinity, depth: 0 };
    return { surface, depth: Math.max(0, surface - heightAt(x, z)) };
  };
}
