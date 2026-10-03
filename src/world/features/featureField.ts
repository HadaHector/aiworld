import { smoothstep } from "../mathUtils";
import type { FeatureSite } from "./featureSites";
import { QUARRY_REACH, quarryGap, quarryHeight } from "./quarry";

/** What the features do to the ground at one point. */
export interface FeatureGround {
  height: number;
  /** The kind (index into WorldContent.featureKinds) of the nearest feature in reach, -1 for none. */
  kind: number;
  /** Distance past that feature's edge, 0 inside it; Infinity where there is none. */
  gap: number;
  /** How far the ground was cut down or built up here. */
  depth: number;
  /** 0-1: how far plants are cleared off it - 1 on ground a feature took. */
  clear: number;
}

export interface FeatureField {
  /** The ground at a point, with every feature in reach applied to `natural`, its own height. */
  apply(x: number, z: number, natural: number): FeatureGround;
}

const BUCKET_SIZE = 128;
const NONE_HERE = { kind: -1, gap: Infinity, depth: 0, clear: 0 };
/** How much cut or fill counts as ground a feature took, for clearing. */
const CLEAR_DEPTH: [number, number] = [0.3, 1.0];

function bucketKey(gx: number, gz: number): number {
  return (gx + 32768) * 65536 + (gz + 32768);
}

/**
 * The ground edits of every feature, bucketed so that a point far from any - nearly all of them -
 * costs one map lookup. The terrain sampler applies it before the roads are graded in, so a road
 * (a quarry's own track included) is laid on the ground the feature left.
 */
export function createFeatureField(features: FeatureSite[]): FeatureField {
  const buckets = new Map<number, FeatureSite[]>();
  for (const feature of features) {
    // A settlement's ground is its streets and plots - see settlements/padField.ts.
    const { quarry } = feature;
    if (!quarry) continue;
    const extent = Math.hypot(quarry.halfLength, quarry.halfWidth) + QUARRY_REACH;
    const gxMin = Math.floor((feature.x - extent) / BUCKET_SIZE);
    const gxMax = Math.floor((feature.x + extent) / BUCKET_SIZE);
    const gzMin = Math.floor((feature.z - extent) / BUCKET_SIZE);
    const gzMax = Math.floor((feature.z + extent) / BUCKET_SIZE);
    for (let gx = gxMin; gx <= gxMax; gx++) {
      for (let gz = gzMin; gz <= gzMax; gz++) {
        const key = bucketKey(gx, gz);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(feature);
        else buckets.set(key, [feature]);
      }
    }
  }

  function apply(x: number, z: number, natural: number): FeatureGround {
    const bucket = buckets.get(bucketKey(Math.floor(x / BUCKET_SIZE), Math.floor(z / BUCKET_SIZE)));
    if (!bucket) return { height: natural, ...NONE_HERE };
    let height = natural;
    let nearest: FeatureSite | null = null;
    let nearestGap = Infinity;
    for (const feature of bucket) {
      const quarry = feature.quarry!;
      const gap = quarryGap(quarry, x, z);
      if (gap >= QUARRY_REACH) continue;
      height = quarryHeight(quarry, gap, height);
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = feature;
      }
    }
    if (!nearest) return { height: natural, ...NONE_HERE };
    const depth = Math.abs(height - natural);
    const [inner, outer] = nearest.kind.clearing;
    const clear = Math.max(1 - smoothstep(inner, outer, nearestGap), smoothstep(CLEAR_DEPTH[0], CLEAR_DEPTH[1], depth));
    return { height, kind: nearest.kindIndex, gap: nearestGap, depth, clear };
  }

  return { apply };
}
