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

### Road generation costs ~6 s at load

The A* pass samples 435k distinct grid nodes, and a terrain sample is ~12.5 us, so the network
costs roughly six seconds on top of the settlements' one. Everything cheap has already been done:
the samples are cached across links, the search is confined to an ellipse around each straight
line, and the heuristic is deliberately inadmissible to keep the frontier tight.

What is left is either a coarser grid - measured, grid 40 builds MORE links from 257k samples, but
a wider step measures grade over a longer run and the grade term starts meaning less - or making
`sampleTerrain` itself cheaper, or moving the whole pass to a worker.

### 22 settlements the roads cannot properly serve

Measured at seed 1337, after the access pass: 199 of 211 settlements are on the road network in
three components, one per continent. **12 have no road at all**, and a further **10 have roads but
none from inside their own zone** - every route to their same-zone neighbours was impassable.

They are not on islands: the straight line to a neighbour is mostly dry. They are canyon-rim and
mountain sites ringed by ground steeper than ROAD_MAX_GRADE. One measured case had a 57-unit cliff
across a 24-unit span between two settlements 1422 apart. Raising the expansion budget does not
recover any of them (measured at 12k and 40k: identical results), so this is the terrain, not the
search.

Either they stay unreachable, which reads as deliberate, or stage 2's terrain work carves a way in.
A decision, not a defect.

### Roads that share a town still run side by side for a while

Down to 2.9% of road length in a sustained run - over 250 units - within 12 to 150 units of another
road, from 11.2% when this was first measured. What remains is pairs of links that leave one
settlement within a few degrees of each other and separate gradually.

Two approaches are already ruled out by measurement, so they should not be tried again. Grading the
reuse discount outward in rings made it worse (roads exactly overlaid fell from 41.6% to 39.2%),
because cheap ground beside a road is an invitation to use the ground rather than the road.
Lowering ROAD_HEURISTIC_WEIGHT to 0.35 raised overlaid road to 46.2% but left parallel stretches at
22% and cost time.

What fixed most of it was resampling before snapping (see `snapToNetwork`). The rest would want a
real splice - where a new route follows an existing road, adopt that road's own points rather than
snapping a copy onto them - which would also stop the shared stretch being stored twice.

### Road crossings are fords, and the road goes under the water

Where a road crosses a river it follows the carved channel down and back up, so it is submerged
under the sea-level water plane for the width of the crossing. It reads as a ford, which is honest,
but the beds run to -8 near a river mouth and nobody fords eight units of water.

The decision taken earlier stands: ford where the bed is shallow, a generated deck where it is not.
Neither needs a model - a deck is a quad strip with an arch - but both need the crossing depth
measured first, and a heightfield cannot express a road over water, so the deck has to be its own
mesh.

### The road wander is stored rather than computed, and the chunk index holds 302k points

`wobble` displaces the straight parts of a road by a couple of units, which needs the line stored at
a few units per point rather than a few hundred: the network went from 6128 points to 82792. The
chunk index then resamples to 2.5 units for the mesh and holds 302205 points, which is the real
memory cost - a few megabytes of small objects.

The wander is a pure function of world position and the resample is deterministic, so neither has to
be stored. A chunk could resample its own runs on demand from the sparse line and apply the
displacement as it goes, trading a little build time for all of that memory. Worth doing if the
index ever becomes the thing that hurts; it is not today.

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
