# Backlog

Known work that was deliberately deferred, with enough measurement attached that picking one up
does not mean re-deriving why it matters. Newest first within each section.

## Performance

### Ocean terrain samples are ~17x more expensive than land ones

Measured per `sampleTerrain` call: land 12.5 us, near coast 11.1 us, deep ocean 62.7 us, far ocean
**213.0 us**. The debug map's World view is mostly open ocean at 160k samples, so it takes ~20 s to
render; Continent and Zone views are ~3 s because they are mostly land.

Cause: the Voronoi ring searches never terminate early for a point far from any cell.
`queryNearestPerGroup` (added in `cf8d3ca` for multi-zone material blending) is given
`nearLand.nearestDistance + blendReach` as its search radius, so for a point 30 km out to sea that
is 30 km, and it sweeps every ring to `MAX_RING` without ever breaking. `landField.query` has the
same shape of problem.

Does not affect gameplay: chunks are near the player, and coastal samples are cheap. Only the World
map view is visibly slow.

Likely fix: at a point that far out the area weights cannot affect anything, because the final
height comes entirely from the ocean floor (`landBlend` is 0). Short-circuit the whole area-weight
sweep once `landmass` is fully ocean, and verify no rendered terrain changes.

### Worker-based terrain chunk generation

Discussed in theory and backlogged by request. Texture baking already runs across a worker pool
(`textureBakePool.ts`); chunk terrain generation still runs on the main thread. A pool of workers
kept warm and generating chunks ahead of the player would smooth out the hitching when moving fast
or teleporting.

Note the transferable-`ArrayBuffer` constraint that applies to the texture pool applies here too:
`SharedArrayBuffer` needs COOP/COEP headers, which the dev server does not set.

## Known artifacts

### Lake shores are still a binary gate

The last remaining discontinuity of a class that has been fixed everywhere else (area borders in
`20a0329`, boundary hills and rivers in `9cdc232`). `computeLakeFactor` branches on whether the
*second-nearest cell* is a lake, which is a predicate on cell identity and so flips abruptly.

Measured: of the height steps over 20 units found anywhere near a river valley, **all 102 were lake
shores** - zero rivers, zero coastline. Worst seen: `lakeFactor` 1.00 -> 0.00 across two world
units, height -10 -> +64.

The fix is the same move used for the others: derive the factor from a distance that is a minimum
over a fixed subset, so it varies continuously even where the winning cell changes.

### Material slot ordering costs ~0.25% of border pairs

`buildMaterialBlend` packs up to 12 material slots and emits them sorted by material index, which
removed the block-swap artifact (51 -> 15 bad pairs out of 6000). The 15 that remain are *set*
changes: a material entering the roster inserts in sorted position and shifts every later slot.

Not fixable with compacted slots. The clean fix is one slot per material - indices become
compile-time constants and the whole class of bug disappears - at 36 texture fetches instead of 24,
and 18-20 slots. Measured as affordable; deferred as a decision rather than a task.

## Rendering

### Textures stretch vertically on near-vertical cliffs

Material UVs use a planar XZ projection, so a near-vertical face samples a thin sliver of texture
stretched over its whole height. Triplanar projection would fix it, at 3x the texture fetches for
the blend weights.

### Tiling repetition is visible on flat open ground

One 1024 texture per material, tiled. Most visible in the desert, where large flat areas share one
sand texture with nothing to break up the repeat.

## Pipeline

### Domain warping and coordinate inputs are not expressible

The material pipeline has no way to feed a computed value back in as a *coordinate*, so domain
warping - the standard trick for turning smooth noise into something organic - cannot be written.
Coordinate inputs (world x/z) are similarly unavailable, so nothing can vary by position except
through the noise operations' own internal sampling.
