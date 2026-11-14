// Fill (GEOMETRY.md, section 8, step 3: what stands or lies in a space once its surfaces are done):
// ledger stones - the slabs over graves let into a floor, in rows down a room, some of the places
// taken and some not. Pure geometry like the trims and dents beside it: a builder hands in its
// floors and what stands on them, and gets back each slab as the points of a convex piece.

import type { V3 } from "./trims";

export interface LedgerSpec {
  /** Each slab's length (laid along the room's longer side) and width. */
  length: number;
  width: number;
  /** Between slabs end to end and side by side. */
  gap: number;
  /** The share of the rows begun (most of a begun row's places hold a slab). */
  fill: number;
  /** Kept this far from anything standing on the floor (a wall, a pillar, a tomb). */
  margin: number;
  /** How far a slab stands out of the floor; its top edge is bevelled. */
  proud: number;
}

/** A floor seen from above: a flat convex polygon, its corners round it. */
export interface FloorFace {
  corners: V3[];
}

export interface LedgerSurroundings {
  /** Whether anything stands in this box (a wall, a pillar, a trim, a tomb). */
  blocked(lo: V3, hi: V3): boolean;
  /** A number in [0, 1) for a point, the same every time. */
  random(p: V3): number;
}

/**
 * Ledger stones over a room's floors: places in rows on a grid centred on the room's plan (x0..x1,
 * z0..z1), a slab's length along its longer side; a place is taken where the whole slab lies on one
 * level floor, nothing stands within `margin` of it, and the draw lets it. Each slab: its foot just
 * under the floor, its top `proud` over it with the edge bevelled.
 */
export function ledgers(floors: readonly FloorFace[], plan: { x0: number; z0: number; x1: number; z1: number }, around: LedgerSurroundings, spec: LedgerSpec): V3[][] {
  const alongX = plan.x1 - plan.x0 > plan.z1 - plan.z0;
  const hx = (alongX ? spec.length : spec.width) / 2, hz = (alongX ? spec.width : spec.length) / 2;
  const px = 2 * hx + spec.gap, pz = 2 * hz + spec.gap;
  const mx = (plan.x0 + plan.x1) / 2, mz = (plan.z0 + plan.z1) / 2;
  const nx = Math.floor((plan.x1 - plan.x0) / 2 / px), nz = Math.floor((plan.z1 - plan.z0) / 2 / pz);
  const levels = floors.map((f) => f.corners[0][1]);
  /** The height of the floor a point lies on, or null. */
  const floorAt = (x: number, z: number): number | null => {
    for (let i = 0; i < floors.length; i++) if (inPolygon(floors[i].corners, x, z)) return levels[i];
    return null;
  };
  const slabs: V3[][] = [];
  // Rows of graves side by side across the room, centred on its middle: a place on it when there
  // are an odd number, else either side. A row is begun or not by the draw, and most of a begun
  // row's places are taken.
  for (let i = -nx; i <= nx; i++) {
    for (let k = -nz; k <= nz; k++) {
      const x = mx + i * px, z = mz + k * pz;
      const row: V3 = alongX ? [x, 0, mz] : [mx, 0, z];
      if (around.random(row) >= spec.fill || around.random([x, 1, z]) >= PLACE_TAKEN) continue;
      const y = floorAt(x, z);
      if (y === null) continue;
      // The whole slab on that floor (each corner a hair inside), level.
      const e = 0.02;
      if (![[x - hx + e, z - hz + e], [x + hx - e, z - hz + e], [x + hx - e, z + hz - e], [x - hx + e, z + hz - e]].every(([cx, cz]) => {
        const h = floorAt(cx, cz);
        return h !== null && Math.abs(h - y) < 1e-3;
      })) continue;
      const m = spec.margin;
      if (around.blocked([x - hx - m, y + 0.05, z - hz - m], [x + hx + m, y + 2, z + hz + m])) continue;
      const b = Math.min(0.03, spec.proud);
      const foot: V3[] = [[x - hx, y - 0.02, z - hz], [x + hx, y - 0.02, z - hz], [x + hx, y - 0.02, z + hz], [x - hx, y - 0.02, z + hz]];
      const top: V3[] = [[x - hx + b, y + spec.proud, z - hz + b], [x + hx - b, y + spec.proud, z - hz + b], [x + hx - b, y + spec.proud, z + hz - b], [x - hx + b, y + spec.proud, z + hz - b]];
      const edge: V3[] = foot.map(([fx, , fz]): V3 => [fx, y + spec.proud - b, fz]);
      slabs.push([...foot, ...edge, ...top]);
    }
  }
  return slabs;
}

/** The share of a begun row's places that hold a slab. */
const PLACE_TAKEN = 0.8;

/** Whether (x, z) lies in a convex polygon's plan. */
function inPolygon(corners: readonly V3[], x: number, z: number): boolean {
  let sign = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    const c = (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0]);
    if (Math.abs(c) < 1e-9) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
