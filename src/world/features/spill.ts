import { smoothstep } from "../mathUtils";
import type { BuildingDef } from "../buildings/buildingTypes";
import type { PropDef, Spill } from "../props/propTypes";
import type { CompoundLayout } from "./compound";

/**
 * The ground a placed prop or building spills over (PropDef.spill, BuildingDef.spill) - sawdust
 * round a sawbuck, chips round a chopping block - painted with its material over everything else
 * there, the feature's own ground and the road included, fading out `reach` metres past its
 * footprint.
 */
export interface SpillField {
  /** How far (0-1) a spill covers the ground here and which of `spillMaterials` it is - the
   *  strongest of those reaching it - or null where none does. The result is reused. */
  at(x: number, z: number): { weight: number; material: number } | null;
}

/** Every material a prop or building spills, in a fixed order - props first, then buildings - so
 *  the terrain and the material blend number them alike. */
export function spillMaterials(content: { props: readonly PropDef[]; buildings: readonly BuildingDef[] }): string[] {
  const ids: string[] = [];
  for (const def of [...content.props, ...content.buildings]) if (def.spill && !ids.includes(def.spill.material)) ids.push(def.spill.material);
  return ids;
}

/** A spill's footprint: a rectangle (x, z its centre, its width along (ux, uz), half extents). */
interface Patch {
  x: number;
  z: number;
  ux: number;
  uz: number;
  hw: number;
  hd: number;
  reach: number;
  material: number;
}

const BUCKET_SIZE = 32;
/** How far a spill's edge wanders in and out, as a share of its reach - so it is no drawn line. */
const FRAY = 0.35;

function bucketKey(gx: number, gz: number): number {
  return (gx + 32768) * 65536 + (gz + 32768);
}

/** A smooth value noise, -1..1, about `scale` metres across - for a spill's ragged edge. */
function fray(x: number, z: number, scale: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const hash = (a: number, b: number): number => {
    let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    return ((h ^ (h >>> 13)) >>> 0) / 0x100000000;
  };
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const top = hash(ix, iz) + (hash(ix + 1, iz) - hash(ix, iz)) * sx;
  const bottom = hash(ix, iz + 1) + (hash(ix + 1, iz + 1) - hash(ix, iz + 1)) * sx;
  return (top + (bottom - top) * sz) * 2 - 1;
}

export function createSpillField(layouts: readonly CompoundLayout[], materials: readonly string[]): SpillField {
  const patches: Patch[] = [];
  const add = (spill: Spill | null, x: number, z: number, frontX: number, frontZ: number, halfWidth: number, halfDepth: number): void => {
    if (!spill) return;
    patches.push({ x, z, ux: frontZ, uz: -frontX, hw: halfWidth, hd: halfDepth, reach: spill.reach, material: materials.indexOf(spill.material) });
  };
  for (const layout of layouts) {
    for (const prop of layout.props) add(prop.prop.spill, prop.x, prop.z, prop.frontX, prop.frontZ, prop.halfWidth, prop.halfDepth);
    for (const house of layout.buildings) add(house.building.spill, house.x, house.z, house.frontX, house.frontZ, house.width / 2, house.depth / 2);
  }

  const buckets = new Map<number, Patch[]>();
  for (const patch of patches) {
    const extent = Math.hypot(patch.hw, patch.hd) + patch.reach * (1 + FRAY);
    for (let gx = Math.floor((patch.x - extent) / BUCKET_SIZE); gx <= Math.floor((patch.x + extent) / BUCKET_SIZE); gx++) {
      for (let gz = Math.floor((patch.z - extent) / BUCKET_SIZE); gz <= Math.floor((patch.z + extent) / BUCKET_SIZE); gz++) {
        const key = bucketKey(gx, gz);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(patch);
        else buckets.set(key, [patch]);
      }
    }
  }

  const found = { weight: 0, material: 0 };
  return {
    at(x, z) {
      const bucket = buckets.get(bucketKey(Math.floor(x / BUCKET_SIZE), Math.floor(z / BUCKET_SIZE)));
      if (!bucket) return null;
      let best = 0;
      let material = -1;
      for (const patch of bucket) {
        const dx = x - patch.x;
        const dz = z - patch.z;
        const along = Math.abs(dx * patch.ux + dz * patch.uz) - patch.hw;
        const across = Math.abs(-dx * patch.uz + dz * patch.ux) - patch.hd;
        const gap = Math.hypot(Math.max(0, along), Math.max(0, across)) + fray(x, z, patch.reach) * patch.reach * FRAY;
        const weight = 1 - smoothstep(0, patch.reach, gap);
        if (weight > best) {
          best = weight;
          material = patch.material;
        }
      }
      if (best <= 0 || material < 0) return null;
      found.weight = best;
      found.material = material;
      return found;
    },
  };
}
