# Backlog

Known work that was deliberately deferred, with enough measurement attached that picking one up
does not mean re-deriving why it matters. Newest first within each section.

## Performance

### Every loaded chunk is a shadow caster, however far past the shadow's own reach

`chunkManager` registers every chunk it builds as a shadow caster, with no distance cutoff of its
own - simplest correct thing to do, and cheap at the default draw distance (400: 6.46ms/frame with
shadows against 1.53ms without, still 155fps). It stops being cheap at the top of the draw-distance
slider: at 1200 (1806 chunks) shadows cost 44.8ms/frame against 6.77ms without - 22fps. Shadows
themselves only reach SHADOW_FAR_DISTANCE (900 world units, see sunLighting.ts) before fading out,
so every chunk loaded past that is paying to render into a shadow map that then discards it.

Fix is straightforward: only register a chunk as a caster if it is within shadow reach of the
POSITION IT WAS BUILT AT, and drop it from the caster list (not just the scene) once the unload
radius pushes it out - right now a caster registered near the shadow's reach stays one for as long
as the chunk stays loaded, however far the player then walks. Deferred because it only matters
above the draw distances anyone plays at today.

### Rebuilding the tree instance buffers copies every tree

`treeField.flush` rewrites the whole instance buffer from every loaded chunk whenever one chunk
comes or goes. Measured at a 1200-unit draw distance (6236 trees): 0.2 ms median, which is fine -
the matrices themselves are composed once at chunk build and only copied here, which is what took
this down from 18.5 ms.

It is still O(all trees) per chunk event, so it grows with draw distance while the actual change
is one chunk. A swap-remove into a slot table would make it O(one chunk) and upload only the
changed range, and is worth doing if the draw distance ceiling ever rises much above 2000.

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

### Road crossings are fords, and the road passes under the water

Where a road crosses a river it is graded down the carved channel and back up, so it goes under the
sea-level water plane for the width of the crossing. It reads as a ford, which is honest, but the
beds run to -8 near a river mouth and nobody fords eight units of water.

It does not dam anything - measured, 0 of 570 road samples inside a river bed are above sea level,
because ROAD_PROFILE_MAX_FILL holds the road within five units of the ground it was routed over and
that ground is the channel. The decision taken earlier stands: ford where the bed is shallow, a
generated deck where it is not. A heightfield cannot express a road over water, so a deck would have
to be its own mesh - the one place the everything-is-terrain rule has to give.

### Two roads sharing a stretch can disagree about its height

50 points of 82792 sit more than a unit off their own road's profile, away from a coast and away
from an end taper; worst 8.1. They are places where two links were snapped onto the same line but
computed their profiles separately: each smooths over a window in arc length, and beyond the shared
stretch those windows cover different ground, so the profiles drift apart. The field then hands the
terrain whichever segment is marginally nearer, which is a step wherever the winner changes.

The fix is the splice already backlogged above for the geometry: a shared stretch should be one road
with one profile, not two that happen to agree within a few units.

### The road wander is stored rather than computed

`wobble` displaces the straight parts of a road by a couple of units, which needs the line stored at
a few units per point rather than a few hundred: the network went from 6128 points to 82792, and the
road field therefore holds 82548 segments.

It has cost nothing measurable - a terrain sample on a road is 9 us against 35 us for one far out
over ocean, because the field is a single bucket lookup and the buckets are small. The wander is a
pure function of world position, so it could be applied analytically against a sparse line instead
if the segment count ever becomes the thing that hurts. It is not today.

### Worker-based terrain chunk generation

Discussed in theory and backlogged by request. Texture baking already runs across a worker pool
(`textureBakePool.ts`); chunk terrain generation still runs on the main thread. A pool of workers
kept warm and generating chunks ahead of the player would smooth out the hitching when moving fast
or teleporting.

Note the transferable-`ArrayBuffer` constraint that applies to the texture pool applies here too:
`SharedArrayBuffer` needs COOP/COEP headers, which the dev server does not set.

## Known artifacts

### The cells of one zone can be cut off from each other by cliffs

Seen in the map's zone view: one highlighted zone of several cells, each cell its own plateau with
a band of cliff along the edges between them, so a cell (the one in the bottom right, say) cannot be
walked to from the rest of its own zone. A zone should be one piece of land: every one of its cells
reachable on foot from every other, without leaving it.

Likely cause: each cell's height is rolled and blended on its own, and where two cells of the zone
land at different heights the band between them squeezes the whole difference into a wall. Nothing
checks that a zone stays connected.

Possible fixes: roll the height-shaping values once per zone rather than per cell (the `params`
mechanism is close to this already), or narrow how far apart cells of one zone may land, or cut
walkable ramps through the edges between them. Worth a probe that walks every edge inside each zone
and reports the zones whose cells are not all connected.

### A road cut steps other layers that key on height or curvature

Where a road crosses tundra its edge is a hard staircase, and it is not the road's edge: it is the
SNOWLINE. Tundra's snow layer remaps height 7 to 9.5, the road here sits at 7.5, and the cut drops
the ground straight through that band - so snow switches over a couple of units of height and steps
at the terrain's own 2.5-unit vertex resolution. Widening the road's material fade does not touch
it; measured, the staircase is unchanged at 3.5 units of fade and at 5.

The same thing happens in plains, through `slopeFacing` rather than height. `plainsNorthFadeLayer`
ramps from 0.08 to 0.35 and a road bank cut at ROAD_SIDE_SLOPE 0.55 has a facing of about 0.48, so
faded grass fires at full strength along whichever side of the road faces that way - measured
across a road at 2636,-3835, material 9 (Faded Grass) owns everything from 8 to 18 units out on one
side while the other side is plain grass. A band two or three vertices wide, so it aliases into a
staircase.

Softening the bank does not fix it: to keep facing under 0.08 a road would need a gradient of 0.08,
which is a 62-unit shoulder for a 5-unit cut. These layers are working as designed - they respond
to which way ground faces, and a road makes two facing slopes right next to each other.

The real fix is for layers keyed on slope, facing or curvature to ignore road-made relief, by
reading roadGap and damping themselves near one. That is a change to how eight biomes look, not to
roads, so it is a decision rather than a task.

### Lake shores are still a binary gate

The last remaining discontinuity of a class that has been fixed everywhere else (area borders in
`20a0329`, boundary hills and rivers in `9cdc232`). `computeLakeFactor` branches on whether the
*second-nearest cell* is a lake, which is a predicate on cell identity and so flips abruptly.

Measured: of the height steps over 20 units found anywhere near a river valley, **all 102 were lake
shores** - zero rivers, zero coastline. Worst seen: `lakeFactor` 1.00 -> 0.00 across two world
units, height -10 -> +64.

The fix is the same move used for the others: derive the factor from a distance that is a minimum
over a fixed subset, so it varies continuously even where the winning cell changes.

### Two of 28 biome pairs need a 13th material slot

Per-zone road surfaces push the worst two-area roster from 12 to 13 - measured, 2 of 28 biome pairs,
worst at hills+desert. A three-area junction now needs up to 17 against 15 before, overflowing in 31
of 56 combinations, though three-area junctions already overflowed.

This is survivable because overflow now drops the LIGHTEST materials rather than the highest-numbered
ones, so what is lost at a border is something contributing almost nothing. Raising the capacity is
not a one-line change: slots are packed into vec4 vertex attributes, so 12 goes to 16, which means
eight attributes and varyings instead of six and 32 texture fetches instead of 24.

### Material slot ordering costs ~0.25% of border pairs

`buildMaterialBlend` packs up to 12 material slots and emits them sorted by material index, which
removed the block-swap artifact (51 -> 15 bad pairs out of 6000). The 15 that remain are *set*
changes: a material entering the roster inserts in sorted position and shifts every later slot.

Not fixable with compacted slots. The clean fix is one slot per material - indices become
compile-time constants and the whole class of bug disappears - at 36 texture fetches instead of 24,
and 18-20 slots. Measured as affordable; deferred as a decision rather than a task.

## Foliage

### Trees do not know settlements are there

A settlement site is a named point with nothing rendered on it yet, and the tree scatter has never
heard of one - so a village clears no ground and the first buildings placed will land inside a
wood. Cheap to fix when there is something to clear for: a bucket index of the settlements (the
shape `roadField` already uses) and another fade on `densityAt`, but it means plumbing the
settlement list down to chunk building.

### Nothing collides with a tree

The character samples terrain height and walks through trunks. The spacing guarantee
(`TREE_SPACING`, measured closest pair 10.21) is what would make trunk collision cheap - a query
only ever has to consider the 3x3 lattice block around the player - but there is no collision
system to hang it on yet.

### Every tree is drawn at full detail, at every distance

One draw call each for trunks and canopies, ~112 triangles a tree, no LOD and no per-instance
culling: 6236 trees at a 1200-unit draw distance is ~700k triangles, all of them submitted whether
they are behind the camera or a mile away. The master meshes are marked
`alwaysSelectAsActiveMesh`, so Babylon does not even test them.

Not currently a problem, and the fixes are known and independent: a billboard or two-triangle LOD
past some distance, and splitting the field into a few buckets by direction so the frustum can
reject whole groups.

### The medium and small foliage levels do not exist

Bushes and grass are named in `foliageConfig.ts` and nothing else. They are deliberately not the
tree system with a smaller radius: grass wants far more instances, far shorter view distance, no
individual placement rules worth the cost, and probably to be drawn as camera-facing quads rather
than geometry.

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
