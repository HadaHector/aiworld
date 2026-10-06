// Counters for profiling the collision system - bumped as it works, read and reset by whoever is
// watching (see debug/collisionPanel.ts). Plain increments, cheap enough to leave on.

export const collisionStats = {
  /** Queries asked of the world. */
  sweeps: 0,
  overlaps: 0,
  nearests: 0,
  rays: 0,
  /** Shape pairs - a heightfield's each triangle counting as one - a query actually tested. */
  pairs: 0,
  /** Conservative-advancement steps over all of a sweep's pairs. */
  advances: 0,
  /** GJK runs, and their iterations in all. */
  gjkCalls: 0,
  gjkIterations: 0,
  /** Batches added, and the milliseconds spent adding them (shapes made, trees built). */
  batchesAdded: 0,
  batchMs: 0,
  /** Time the game spends on it, reported by its callers: the player's motor, and the chunks'
   *  collision being built (their trees' pieces moved into place, and the batch added). */
  motorMs: 0,
  chunkMs: 0,
  chunksBuilt: 0,
};

export type CollisionStats = typeof collisionStats;

/** A copy of the counters, and all of them back to zero. */
export function takeCollisionStats(): CollisionStats {
  const taken = { ...collisionStats };
  for (const key of Object.keys(collisionStats) as (keyof CollisionStats)[]) collisionStats[key] = 0;
  return taken;
}
