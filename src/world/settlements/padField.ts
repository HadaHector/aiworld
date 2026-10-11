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
  /** Not painted as a road: levelled only - a compound's, whose own ground layer paints it (see
   *  FeatureKindDef.ground). */
  unpainted?: boolean;
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
  /**
   * The ground at (x, z), `height` as it lies, brought to the pads near it - each pulling it toward
   * its own level as far as its blend reaches (and `roadClear`, 0-1, lets a pad that is not firm
   * reach: none of it onto a road's own level ground), the pads it is nearest pulling hardest, so
   * where two pads' blends overlap the ground runs smoothly from one level to the other rather than
   * stepping where one stops being the nearest. And how far it is from the nearest painted pad's
   * edge, for its paint (Infinity with none - see Pad.unpainted); and from the nearest pad's edge,
   * painted or not, `edge` - what keeps trees off it. Null where no pad is near. The result is
   * reused - read it before the next call.
   */
  level(x: number, z: number, height: number, roadClear: number): { height: number; gap: number; edge: number } | null;
  padCount: number;
}

const BUCKET_SIZE = 32;
/** How much more a firm pad (a prop's) weighs where it overlaps others - its level holds on a yard. */
const FIRM_WEIGHT = 100;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
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
      .filter((prop) => !prop.on && prop.prop.ground !== "slope")
      .map((prop) => ({ x: prop.x, z: prop.z, y: prop.y, ux: -prop.frontZ, uz: prop.frontX, hw: prop.halfWidth + 0.3, hd: prop.halfDepth + 0.3, radius: 0, firm: true, blend: layout.padBlend, unpainted: true })),
  );
}

/** Every compound's yard and the ground under its buildings. */
export function compoundPads(layouts: CompoundLayout[]): Pad[] {
  return layouts.flatMap(({ yard, buildings, padBlend }) => [
    // A roadside one has no yard of its own.
    ...(yard.level > 0 ? [{ x: yard.x, z: yard.z, y: yard.y, ux: 1, uz: 0, hw: 0, hd: 0, radius: yard.level, blend: padBlend, unpainted: true }] : []),
    // A roadside one's buildings each have a path up to the door, which would otherwise keep its own
    // grade across the pad's front: they hold their level beside it - standing back far enough from
    // the road not to reach it.
    ...buildings.map((house) => ({ ...housePad(house), blend: padBlend, unpainted: true, firm: yard.level === 0 })),
  ]);
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

  const levelled = { height: 0, gap: 0, edge: Infinity };
  function level(x: number, z: number, height: number, roadClear: number): { height: number; gap: number; edge: number } | null {
    const bucket = buckets.get(bucketKey(Math.floor(x / BUCKET_SIZE), Math.floor(z / BUCKET_SIZE)));
    if (!bucket) return null;
    let near = false;
    let nearest = Infinity;
    let edge = Infinity;
    let weights = 0;
    let weighted = 0;
    let strength = 0;
    for (const pad of bucket) {
      const gap = gapTo(pad, x, z);
      if (gap >= reachOf(pad)) continue;
      near = true;
      edge = Math.min(edge, gap);
      if (!pad.unpainted) nearest = Math.min(nearest, gap);
      const margin = padMargin(pad.blend ?? DEFAULT_PAD_BLEND, height - pad.y);
      if (gap >= margin) continue;
      const pull = (1 - smoothstep(0, margin, gap)) * (pad.firm ? 1 : roadClear);
      if (pull <= 0) continue;
      // Nearer pads weigh more, without bound at their own edge - so on a pad its own level holds -
      // and a firm one (a prop's, on a yard) more again.
      const weight = (pull * (pad.firm ? FIRM_WEIGHT : 1)) / (gap * gap + 0.0001);
      weights += weight;
      weighted += weight * pad.y;
      strength = Math.max(strength, pull);
    }
    if (!near) return null;
    levelled.gap = nearest;
    levelled.edge = edge;
    levelled.height = weights > 0 ? height + (weighted / weights - height) * strength : height;
    return levelled;
  }

  return { query, level, padCount };
}
