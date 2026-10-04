import type { BuildingModel } from "./buildingTypes";
import { cellKey, type FaceDir } from "./interiorLayout";

/** A building's interior as built: its layout, levels, and where its tiles start (model space). */
export type BuiltInterior = NonNullable<BuildingModel["interior"]>;

/**
 * What one stands on at a point inside a building (model space): the highest floor under it that is
 * no more than `stepUp` over the feet - a room's floor, a gallery, or a stair's slope part way up -
 * or null where no room's floor is: outside, or in unbuilt space, where the ground takes over. A
 * room's floor counts out to its tiles' edges, so a doorway through a wall is stood on too.
 */
export function interiorFloorAt(interior: BuiltInterior, x: number, z: number, feet: number, stepUp: number): number | null {
  const { layout, levels, X0, Z0, tile } = interior;
  const fi = (x - X0) / tile;
  const fj = (z - Z0) / tile;
  const i = Math.floor(fi);
  const j = Math.floor(fj);
  let best: number | null = null;
  const consider = (height: number): void => {
    if (height <= feet + stepUp && (best === null || height > best)) best = height;
  };
  for (const level of levels) {
    const k = level.index;
    const key = cellKey(i, j, k);
    const id = layout.cells.get(key);
    if (id === undefined) continue;
    const room = layout.rooms.find((r) => r.id === id);
    if (!room) continue;
    const floored = (k === room.base || layout.gallery.has(key)) && !layout.holes.has(key);
    if (floored) consider(level.floor);
  }
  for (const stair of layout.stairs) {
    const n = stair.tiles.findIndex(([a, b]) => a === i && b === j);
    if (n < 0) continue;
    const floor = levels.find((level) => level.index === stair.level)!.floor;
    const rise = levels.find((level) => level.index === stair.level + 1)!.floor - floor;
    const u = fi - i;
    const v = fj - j;
    const along: Record<FaceDir, number> = { px: u, nx: 1 - u, pz: v, nz: 1 - v };
    consider(floor + (rise * (n + along[stair.dir])) / stair.tiles.length);
  }
  return best;
}
