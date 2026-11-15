// How creatures find their way (NAVIGATION.md). Pure: no Babylon, the same answers on the page's
// in-page server and the headless one.
import type { Vec3 } from "../collision/vec";

export interface NavQuery {
  /** Waypoints from a point to a point - the last one `to` - or null if no way is found within
   *  `budget` search nodes. */
  path(dimension: string, from: Vec3, to: Vec3, budget: number): Vec3[] | null;
  /** Whether a body could walk straight from one point to the other. */
  straight(dimension: string, from: Vec3, to: Vec3): boolean;
  /** Whether a point can be walked to from another - for wander and flee spots. */
  reachable(dimension: string, from: Vec3, to: Vec3): boolean;
}

/** Knows nothing of the world: every way is straight - what creatures did before there was nav. */
export const straightNav: NavQuery = {
  path: (_dimension, _from, to) => [{ x: to.x, y: to.y, z: to.z }],
  straight: () => true,
  reachable: () => true,
};
