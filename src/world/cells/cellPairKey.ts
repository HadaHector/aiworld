/**
 * Canonical bidirectional key for an (unordered) pair of cell indices - sorted before encoding, so
 * it works as an edge key regardless of which id is "first" at generation time (a river path can
 * walk from a higher cell index to a lower one) vs. at query time (the nearest/second-nearest cell
 * from a Voronoi query isn't guaranteed to be the lower id either). Both river-edge insertion and
 * river-edge membership lookup MUST go through this one function, or the encoding can silently
 * drift between the two call sites.
 *
 * Safe up to 65536 distinct cell ids (packs the low id into the high 16 bits): total cell count
 * across the whole generated world stays in the low thousands (CONTINENT_COUNT_RANGE x
 * AREAS_PER_CONTINENT_RANGE x CELLS_PER_AREA), nowhere near that ceiling.
 */
export function cellPairKey(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return ((lo << 16) ^ hi) >>> 0;
}
