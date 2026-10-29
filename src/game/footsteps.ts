// What a foot comes down on (see FEEDBACK.md, *Footsteps*): inside a building its floor, else the
// ground material that wins at that point - asked of the world's material rules
// as the debug map asks them, from a few terrain samples round the point - turned into a surface
// by the feedback rules' patterns. Asked once a metre and kept.

import type { World } from "../world/world";
import { matchesPattern, type FeedbackRules } from "../feedback/rules";

export interface SurfaceProbe {
  /** The surface at a point: `grass`, `stone`, `wood`... */
  at: (x: number, y: number, z: number) => string;
}

/** Metres between the samples a slope and the ground's curvature are taken from. */
const STEP = 1;
const CURVATURE = 10;
/** Points kept, at most, before the oldest half is forgotten. */
const KEEP = 4096;

export function createSurfaceProbe(world: World, rules: FeedbackRules): SurfaceProbe {
  const kept = new Map<string, string>();
  const surfaces = rules.config.surfaces;
  const byMaterial = new Map<string, string>();
  const surfaceOf = (material: string): string => {
    let surface = byMaterial.get(material);
    if (surface === undefined) {
      surface = surfaces.find(([pattern]) => matchesPattern(pattern, material))?.[1] ?? "dirt";
      byMaterial.set(material, surface);
    }
    return surface;
  };
  const ground = (x: number, z: number): string => {
    // No water here yet: whether a point is under water depends on the dimension's own sea, which
    // a test world (tiny) does not draw, so `isLand` and the height cannot say. Water steps come when
    // the world can.
    const sample = world.sampleTerrain(x, z);
    const h = (dx: number, dz: number): number => world.sampleTerrain(x + dx, z + dz).height;
    const dHdx = (h(STEP, 0) - h(-STEP, 0)) / (2 * STEP);
    const dHdz = (h(0, STEP) - h(0, -STEP)) / (2 * STEP);
    const invLen = 1 / Math.sqrt(dHdx * dHdx + dHdz * dHdz + 1);
    const reliefCurvature = (h(0, -CURVATURE) + h(0, CURVATURE) + h(CURVATURE, 0) + h(-CURVATURE, 0)) / 4 - sample.height;
    const context: Record<string, number> = {
      height: sample.height,
      slope: invLen,
      slopeFacing: dHdz * invLen,
      landmass: sample.landmass,
      lakeFactor: sample.lakeFactor,
      riverGap: sample.riverGap,
      roadGap: sample.roadGap,
      roadMiddle: sample.roadMiddle,
      featureKind: sample.featureKind,
      featureGap: sample.featureGap,
      featureDepth: sample.featureDepth,
      reliefCurvature,
    };
    const library = world.materialLibrary;
    const index = library.resolveMaterialIndex(x, z, context, sample.primaryBiome);
    return surfaceOf(library.blender.materialDefs[index]?.id ?? "");
  };
  return {
    at(x, y, z) {
      // A floor under a roof: wood (a later pack can say stone by building, when buildings say).
      if (world.buildingAt(x, y + 0.5, z)) return "wood";
      const key = `${Math.floor(x)},${Math.floor(z)}`;
      let surface = kept.get(key);
      if (surface === undefined) {
        surface = ground(x, z);
        if (kept.size >= KEEP) for (const k of [...kept.keys()].slice(0, KEEP / 2)) kept.delete(k);
        kept.set(key, surface);
      }
      return surface;
    },
  };
}
