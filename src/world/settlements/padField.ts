import type { SettlementLayout } from "./settlementLayout";
import { PAD_BLEND_MAX, PAD_PAINT_OFFSET } from "./settlementConfig";

/** Ground that has to be level: a house footprint (a rectangle) or a square (a circle). */
interface Pad {
  x: number;
  z: number;
  y: number;
  /** Rectangle: unit width axis and half extents. A circle has radius and no axis. */
  ux: number;
  uz: number;
  hw: number;
  hd: number;
  radius: number;
}

export interface PadQuery {
  /** Distance from the nearest pad's edge, 0 inside it. */
  gap: number;
  /** The level that pad's ground is brought to. */
  height: number;
}

export interface PadField {
  /** The nearest pad within reach, or null. */
  query(x: number, z: number): PadQuery | null;
  padCount: number;
}

const BUCKET_SIZE = 32;
/** How far from a pad anything still cares: the widest the ground's blend back to its own level
 *  gets, or the road paint's fade, whichever reaches further. */
const REACH = Math.max(PAD_BLEND_MAX, 9 - PAD_PAINT_OFFSET + 4);

function bucketKey(gx: number, gz: number): number {
  return (gx + 32768) * 65536 + (gz + 32768);
}

function gapTo(pad: Pad, x: number, z: number): number {
  const dx = x - pad.x;
  const dz = z - pad.z;
  if (pad.radius > 0) return Math.max(0, Math.hypot(dx, dz) - pad.radius);
  const along = Math.abs(dx * pad.ux + dz * pad.uz) - pad.hw;
  const across = Math.abs(-dx * pad.uz + dz * pad.ux) - pad.hd;
  return Math.hypot(Math.max(0, along), Math.max(0, across));
}

/**
 * The level patches of ground settlements stand on - each house's footprint and each square - so the
 * terrain sampler can bring the ground to them (the same way it grades roads) and paint them with
 * the road surface. Bucketed like the road field, so a query away from any settlement is one miss.
 */
export function createPadField(layouts: SettlementLayout[]): PadField {
  const buckets = new Map<number, Pad[]>();
  let padCount = 0;

  function add(pad: Pad, extent: number): void {
    padCount++;
    const gxMin = Math.floor((pad.x - extent - REACH) / BUCKET_SIZE);
    const gxMax = Math.floor((pad.x + extent + REACH) / BUCKET_SIZE);
    const gzMin = Math.floor((pad.z - extent - REACH) / BUCKET_SIZE);
    const gzMax = Math.floor((pad.z + extent + REACH) / BUCKET_SIZE);
    for (let gx = gxMin; gx <= gxMax; gx++) {
      for (let gz = gzMin; gz <= gzMax; gz++) {
        const key = bucketKey(gx, gz);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(pad);
        else buckets.set(key, [pad]);
      }
    }
  }

  for (const layout of layouts) {
    const { square } = layout;
    add({ x: square.x, z: square.z, y: square.y, ux: 1, uz: 0, hw: 0, hd: 0, radius: square.radius }, square.radius);
    for (const house of layout.houses) {
      // Width axis runs along the street: perpendicular to the front.
      const ux = -house.frontZ;
      const uz = house.frontX;
      add(
        { x: house.x, z: house.z, y: house.y, ux, uz, hw: house.width / 2, hd: house.depth / 2, radius: 0 },
        Math.hypot(house.width, house.depth) / 2,
      );
    }
  }

  function query(x: number, z: number): PadQuery | null {
    const bucket = buckets.get(bucketKey(Math.floor(x / BUCKET_SIZE), Math.floor(z / BUCKET_SIZE)));
    if (!bucket) return null;
    let best: Pad | null = null;
    let bestGap = REACH;
    for (const pad of bucket) {
      const gap = gapTo(pad, x, z);
      if (gap < bestGap) {
        bestGap = gap;
        best = pad;
      }
    }
    return best ? { gap: bestGap, height: best.y } : null;
  }

  return { query, padCount };
}
