import type { House, SettlementLayout } from "./settlementLayout";
import type { CompoundLayout } from "../features/compound";
import { PAD_BLEND_MAX, PAD_BLEND_MIN, PAD_PAINT_OFFSET, PAD_SIDE_SLOPE } from "./settlementConfig";

/** Ground that has to be level: a house footprint (a rectangle) or a square or a yard (a circle). */
export interface Pad {
  x: number;
  z: number;
  y: number;
  /** Rectangle: unit width axis and half extents. A circle has radius and no axis. */
  ux: number;
  uz: number;
  hw: number;
  hd: number;
  radius: number;
  /** Levelled even beside a road or a lane, which otherwise keeps its own grade there - a prop's
   *  small pad, where a trail bending round it does no harm. */
  firm?: boolean;
  /** How it blends back to the ground round it (see PadBlend) - the settlements' own if left out. */
  blend?: PadBlend;
}

/**
 * How a pad's ground blends back to the ground round it: over a margin as wide as `slope` needs -
 * the steepest its cut or fill may stand (rise over run; lower, a wider, gentler bank) - but never
 * narrower than `min` nor wider than `max` metres.
 */
export interface PadBlend {
  slope: number;
  min: number;
  max: number;
}

export const DEFAULT_PAD_BLEND: PadBlend = { slope: PAD_SIDE_SLOPE, min: PAD_BLEND_MIN, max: PAD_BLEND_MAX };

/** How wide a pad's blend back to the ground is, where the ground stands `drop` off its level. */
export function padMargin(blend: PadBlend, drop: number): number {
  return Math.min(blend.max, Math.max(blend.min, Math.abs(drop) / blend.slope));
}

export interface PadQuery {
  /** Distance from the nearest pad's edge, 0 inside it. */
  gap: number;
  /** The level that pad's ground is brought to. */
  height: number;
  /** Whether it is levelled beside roads too (Pad.firm). */
  firm: boolean;
  /** How it blends back to the ground round it. */
  blend: PadBlend;
}

export interface PadField {
  /** The nearest pad within reach, or null. */
  query(x: number, z: number): PadQuery | null;
  padCount: number;
}

const BUCKET_SIZE = 32;
/** How far from a pad anything still cares: the widest its ground's blend back to its own level
 *  gets, or the road paint's fade, whichever reaches further. */
const reachOf = (pad: Pad): number => Math.max((pad.blend ?? DEFAULT_PAD_BLEND).max, 9 - PAD_PAINT_OFFSET + 4);

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

/** A house's footprint as a pad: its width along its street, square to its front. */
function housePad(house: House): Pad {
  return { x: house.x, z: house.z, y: house.y, ux: -house.frontZ, uz: house.frontX, hw: house.width / 2, hd: house.depth / 2, radius: 0 };
}

/** Every settlement's square and house plots. */
export function settlementPads(layouts: SettlementLayout[]): Pad[] {
  return layouts.flatMap((layout) => {
    const { square } = layout;
    return [{ x: square.x, z: square.z, y: square.y, ux: 1, uz: 0, hw: 0, hd: 0, radius: square.radius }, ...layout.houses.map(housePad)];
  });
}

/** The level ground under each of a compound's props standing on the ground - at the height
 *  settleProps gave it, a little wider than it. Listed before the yards (see createPadField: the
 *  first of two pads a point is inside wins), so the yard's edge under a prop is the prop's. */
export function propPads(layouts: CompoundLayout[]): Pad[] {
  return layouts.flatMap((layout) =>
    layout.props
      .filter((prop) => !prop.on)
      .map((prop) => ({ x: prop.x, z: prop.z, y: prop.y, ux: -prop.frontZ, uz: prop.frontX, hw: prop.halfWidth + 0.3, hd: prop.halfDepth + 0.3, radius: 0, firm: true, blend: layout.padBlend })),
  );
}

/** Every compound's yard and the ground under its buildings. */
export function compoundPads(layouts: CompoundLayout[]): Pad[] {
  return layouts.flatMap(({ yard, buildings, padBlend }) => [{ x: yard.x, z: yard.z, y: yard.y, ux: 1, uz: 0, hw: 0, hd: 0, radius: yard.level, blend: padBlend }, ...buildings.map((house) => ({ ...housePad(house), blend: padBlend }))]);
}

/**
 * The level patches of ground places stand on - each house's footprint, each square and each
 * compound's yard - so the terrain sampler can bring the ground to them (the same way it grades
 * roads) and paint them with the road surface. Bucketed like the road field, so a query away from
 * any of them is one miss.
 */
export function createPadField(pads: Pad[]): PadField {
  const buckets = new Map<number, Pad[]>();
  let padCount = 0;

  function add(pad: Pad): void {
    padCount++;
    const extent = pad.radius > 0 ? pad.radius : Math.hypot(pad.hw, pad.hd);
    const reach = reachOf(pad);
    const gxMin = Math.floor((pad.x - extent - reach) / BUCKET_SIZE);
    const gxMax = Math.floor((pad.x + extent + reach) / BUCKET_SIZE);
    const gzMin = Math.floor((pad.z - extent - reach) / BUCKET_SIZE);
    const gzMax = Math.floor((pad.z + extent + reach) / BUCKET_SIZE);
    for (let gx = gxMin; gx <= gxMax; gx++) {
      for (let gz = gzMin; gz <= gzMax; gz++) {
        const key = bucketKey(gx, gz);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(pad);
        else buckets.set(key, [pad]);
      }
    }
  }

  for (const pad of pads) add(pad);

  function query(x: number, z: number): PadQuery | null {
    const bucket = buckets.get(bucketKey(Math.floor(x / BUCKET_SIZE), Math.floor(z / BUCKET_SIZE)));
    if (!bucket) return null;
    let best: Pad | null = null;
    let bestGap = Infinity;
    for (const pad of bucket) {
      const gap = gapTo(pad, x, z);
      if (gap < bestGap && gap < reachOf(pad)) {
        bestGap = gap;
        best = pad;
      }
    }
    return best ? { gap: bestGap, height: best.y, firm: best.firm === true, blend: best.blend ?? DEFAULT_PAD_BLEND } : null;
  }

  return { query, padCount };
}
