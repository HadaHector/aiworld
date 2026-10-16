import type { WorldShape } from "../content/worldConfig";
import { mulberry32, deriveSeed } from "../rng";
import { CELLS_PER_AREA, GROWTH_RADIUS_SAFETY_FACTOR, CELL_SPACING, AREA_COUNT_SALT, LAND_SEED_SALT } from "./config";

/**
 * The widest a world may be, in world units (metres). Positions are drawn in 32-bit floats, so the
 * farther from the origin the coarser they get: past WORLD_EXTENT_WARNING the edges lose the 1-2 mm
 * GAMEPLAY.md accepts, and a shape that could roll wider than this is a content error. More land
 * belongs in another dimension (see DIMENSIONS.md).
 */
export const MAX_WORLD_EXTENT = 128_000;
/** A rolled world wider than this logs a warning. */
export const WORLD_EXTENT_WARNING = 32_000;

/** One world is one landmass, centred on 0, 0 - where the player spawns by default. */
export interface WorldLayout {
  /** The landmass's own seed: its growth, zones and rivers derive from it. */
  landSeed: number;
  areaCount: number;
  cellCount: number;
  /** How far from 0, 0 its land can reach (with the growth's safety margin). */
  radius: number;
  worldExtent: number;
}

function randomIntInRange(rng: () => number, [min, max]: [number, number]): number {
  return Math.round(min + rng() * (max - min));
}

function landRadius(cellCount: number): number {
  return CELL_SPACING * Math.sqrt(cellCount / Math.PI) * GROWTH_RADIUS_SAFETY_FACTOR;
}

/** How wide a world of `areaCount` zones is. */
export function worldExtentFor(areaCount: number): number {
  return 2 * landRadius(areaCount * CELLS_PER_AREA);
}

/**
 * Rolls how many zones the landmass has (a range, per seed) and derives the world's size from it,
 * so the land never reaches the generated region's edge. The salts are the ones the first
 * continent of the old multi-continent layout used, so a world rolls as it always did.
 */
export function planWorld(seed: number, shape: WorldShape): WorldLayout {
  const areaCount = randomIntInRange(mulberry32(deriveSeed(seed, AREA_COUNT_SALT)), shape.areas);
  const cellCount = areaCount * CELLS_PER_AREA;
  const radius = landRadius(cellCount);
  const worldExtent = 2 * radius;
  if (worldExtent > WORLD_EXTENT_WARNING) {
    console.warn(`[shaping] The world is ${(worldExtent / 1000).toFixed(1)} km across (${areaCount} zones); past ${WORLD_EXTENT_WARNING / 1000} km its edges are drawn less accurately than 1-2 mm`);
  }
  return { landSeed: deriveSeed(seed, LAND_SEED_SALT), areaCount, cellCount, radius, worldExtent };
}
