# Water

Swimming, drowning and water you can see, hear and feel: the water items of the first playthrough
(GAMEPLAY.md: "swim" and "drowning" are wanted dangers). Today the world draws water but the
simulation does not know it is there: a character walks along the bottom, takes no harm, makes no
splash, and nothing sounds or looks different underwater. This document is the plan, agreed with
the user before the feature is built.

**Status: done** - see *As built* at the end; *Water at its own level* (SLICE.md W10, W11) after it. The plan above it is as approved.

## Decisions

| Question | Decision |
|---|---|
| Drowning | **A `breath` resource.** Drains while the head is under water, refills fast in air, and hurts at zero (a share of max health each second). A normal resource defined in the packs (ENTITIES.md), so any game config can drop or change it |
| Swimming | **Slower than walking, free vertical movement.** About 60 % of walking pace in any direction; you float at the surface when idle, jump swims up, a dive key swims down. **Combat is not limited**: abilities, auto-attacks and casting work in water exactly as on land |
| Armour | **No weight in water.** Swimming is the same for everyone. A pack stat can add it later without code |
| Creatures | **Stay out of deep water** unless their kind is marked `swims`. Land creatures treat deep water as a wall (no path, no leash point, no spawn in it) and stop chasing at the shore |
| Everything else | Pack data wherever possible: the breath resource, the cues, the particles, the surfaces and the underwater look are all in the packs |

## The water query

One function the simulation, the client and the probes all call, headless and deterministic:

```ts
waterAt(x, z): { surface: number; depth: number }   // depth 0 on dry ground
```

- `src/world/water.ts`, built from the dimension's terrain: **the surface is the dimension's sea
  level** (`SEA_LEVEL` for the mainland; a dimension definition may give its own, or `null` for
  no water), and `depth = max(0, surface - groundHeight)`. Today every sea, lake, pond and river
  in the world is a hollow of the ground filled to that one level (the terrain shader and the ocean
  plane draw it so), so one level and the terrain sample are the whole answer: no mesh, no
  per-water-body data, the same on the server, in a worker and on the page.
- Under a bridge the query says water (the ground is under it); the bridge's deck is a floor, so a
  body standing on it is above the surface and not swimming. Building floors and cellars count as
  dry (the query is for outdoor ground; a body inside a building is never in water).
- `world.waterAt` joins `heightAt` on the world data; the dimension's server side wraps it with the
  building floors (`groundAt`).

## Pieces

| Piece | What |
|---|---|
| **Water state** (sim) | Each step, from the body's feet and head heights against the surface: `wading` (feet wet, knee deep: footsteps and splash only), `swimming` (the chest under: swim movement), `submerged` (the head under: breath drains). Kept on the entity next to its combat flags, replicated, and readable by packs as a condition (`when: "submerged"`) |
| **Swim movement** (`playerBody`) | Swimming replaces gravity with buoyancy: it floats to the surface, `jump` swims up, the new `dive` input swims down, pace is `swimSpeed` times walking (a `rules/` number, default 0.6). Forced motions (knockback) still work. Leaving the water over a bank climbs out as a step up |
| **Breath** (`resources/breath.json5`) | Max from a `maxBreath` stat (30 s base), `drain` while submerged, fast `regen` in air. At zero, `damage` of a share of max health per second (rules, default 8 %). The resource system gains the two small things this needs: rates that depend on a state, and an effect at empty. Shown as a bar under the health bar only while it is not full |
| **Creatures** | The water query joins the walkability test in the creature brain, spawn points (already skip water) and leash points. Kind field `swims: true` (traits or kind data) lets a kind in. Nothing else about their brains changes |
| **Body animation** | The client's `characterBody` already has a swim animation (CHARACTERS.md); it plays on the replicated `swimming` flag for every body, and the body lies horizontal at the surface |
| **Splash** | Cues `splash.enter` and `splash.leave` on crossing the surface (loudness and size by speed of entry), with particles (spray, rings on the surface) and a sound each. Pack cue files, so a game can change them |
| **Footsteps** | `footstep` reads the water depth under the foot: shallow is `water` (exists in the surface table); wading deeper adds a `water.deep` surface (a slosh). Fixes the "water footsteps are missing" note in FEEDBACK.md, which waited for this query |
| **Underwater look** | While the camera is under the surface: a blue-green tint and short fog (a post effect pass or the scene fog switched, set by `rules/water.json5`), a darker sky, caustic-like light is left for later. The surface seen from below is the water plane's underside, tinted |
| **Underwater sound** | Cue `underwater.on` / `.off` as the camera crosses the surface: the ambient and music buses get a low-pass and a lower volume (`feedback` rules `underwater` mix), a muffled bubble loop while submerged, and a gasp cue when breath runs low and on surfacing |
| **Debug** | `__aiworld.water(x, z)`, the map marks nothing new; the probe for the query |

## Rules and data

| File | Holds |
|---|---|
| `rules/water.json5` (new) | `swimSpeed`, depths for wading / swimming / submerged, the buoyancy, the underwater look (tint, fog distance), the drowning damage share, how fast `dive` goes |
| `resources/breath.json5` (new) | The breath resource: max, drain, regen, what happens at empty |
| `stats/maxBreath.json5` (new) | The stat it reads |
| `cues/splash*.json5`, `underwater*.json5`, `particles/splash*.json5`, `sounds/` | The feedback |
| `dimensions/*.json5` | Optional `water: { level }` (or `null`) |
| creature kinds | `swims` |

## Done first

1. **Starts on dry ground.** `chooseStarts` (`src/world/settlements/starts.ts`) checks the start
   point and the home against the ground (above the water, off a river, outside a building) and
   moves them to the nearest standable point in rings out to 60 m. `scripts/probe/starts.mjs`
   asserts it for 8 seeds each of `tiny` and `small`. The playthrough's ocean spawn (world seed
   475982993, a medium world, elf priest) could not be reproduced: the server, a quick game and
   two worlds in one page all put the character on the square of Vysael Steps at (-128, 198), 20 m
   up. Left open.
2. **Roads under water.** The cause: a road is graded into the ground *before* the coast blend,
   so a road cut through a hill near the coast was pulled down toward the seabed afterwards, below
   the water, and was not bridged because bridges are planned on the ground without roads. Roads
   are now graded after the blend, from the ground as it then lies (`terrainSampler.ts`), so the
   level the roads were routed and bridged against is the level they get. At (8..75, 304..313) in
   world 475982993 the road is now 7-10 m up instead of -1 m. `scripts/probe/water.mjs` (then `roadWater.mjs`)
   samples every road point against the waterline over 14 worlds (tiny and small, 7 seeds): none
   under water, bridged ones excepted. Terrain near coasts with roads changed for every seed.

## Build order

Each step leaves the game working; each ends with a probe or a look in the running game.

1. **The query.** `waterAt` on the world data and the dimension, `rules/water.json5`, a probe that
   checks it against the terrain at known points (ocean, a lake, a river, a bridge, dry land) over
   several seeds and configs.
2. **Water state and swimming.** The state on entities, swim movement and the `dive` input (key in
   the HUD key list), the replicated flag and the swim animation. Probe: a body walked into the sea
   swims, floats, dives and climbs out.
3. **Breath and drowning.** The resource rule extension, `breath.json5`, the bar, the damage at
   empty; creatures kept out of deep water and the `swims` field. Probe: held under, it drains and
   hurts; surfaced, it refills.
4. **Feedback.** Splash cues and particles, water footsteps by depth, the underwater look and
   sound, gasp and bubbles.
5. **Docs.** GAMEPLAY.md, FEEDBACK.md (footsteps, cues), CHARACTERS.md (swim now live), ENTITIES.md
   (resource rates by state) and this file's *As built*.

## Left for later

Currents in rivers, fishing, boats, wet clothes and drying, swim and breath as discipline skills,
rain and snow on the surface, underwater light shafts and caustics, creature breath and drowning,
armour weight. Water that is not at one level: rivers have it now (*Water at its own level*, below);
a mountain lake above the sea does not yet.

## As built

- **The query.** `src/world/water.ts`: `createWaterAt(heightAt, surface)` and `WATER_SURFACE` (sea level
  less 0.1, where the ocean plane sits). `world.waterAt(x, z)` on the world data, on the page's `World`
  and so on the server's dimension. A dimension-specific level is not read yet (every dimension uses
  the one). `scripts/probe/water.mjs` checks it over three worlds.
- **Rules** are in `GameRules.water` (`src/sim/rules/waterRules.ts`, `rules/water.json5`): `swimSpeed`
  0.6, `wadeDepth` 0.35, `swimDepth` 1.2, `headDepth` 1.7, `floatDepth` 1.35, `verticalSpeed` 3.5, and
  the underwater `look`.
- **Water state.** `entity.water` 0-3 (dry, wading, swimming, head under), worked out by the body each
  step, replicated as `EntityMotion.water` (left out when 0). Protocol 15; the intent gains `rise`
  (Space held) and `dive` (X held). Swimming is in `src/sim/playerBody.ts`: the body floats with its
  feet `floatDepth` under the surface, rises and dives at `verticalSpeed`, moves at `swimSpeed` of
  walking pace (any `speed` stat applies), and a jump pressed at the surface is a hop out over a bank.
  Combat is not limited. Creatures' bodies swim too (kind `swims`) but are stopped at the shore.
- **Breath.** `resources/breath.json5` + `stats/maxBreath.json5` (24 s + half of stamina). The
  resource format gained `regen.submerged` (a rate used while the head is under), `hurtAtEmpty`
  (a share of max health lost each second at 0, applied once a second through the new
  `skills.hurt`, a combat `hit` event with no source and no skill), `harmName` (what the log calls
  it: "Drowning") and `hideWhenFull` (the HUD bar). Characters and the test player have breath.
- **Creatures** that cannot swim (`swims: false`, the default in species files) are put back at
  the edge of deep water unless they are already in it (`src/sim/creatures/system.ts`).
- **Feedback** (`src/game/feedback.ts`, `underwater.ts`): events `splashIn` and `splashOut` (a body
  crossing into or out of swimming, any body in view), `underwaterOn` / `underwaterOff` (the camera
  crossing the surface), `gasp` (surfacing with under half the breath); cues, sounds
  (`splash.in`, `splash.out`, `underwater.on`, `underwater.off`, `gasp`, `footstep.waterDeep`) and
  particles (`splash`, `splash.small`) in core. Footsteps read `waterAt`: under 0.1 m the ground's,
  to 0.7 m `water`, deeper `waterDeep`. Under the surface the fog turns to the water's tint and
  closes in (applied just before each camera renders, so the sky's own fog does not undo it), a
  tinted wash lies over the screen, and the page's audio goes through a low-pass (`GameAudio.muffle`,
  600 Hz) that opens again on surfacing.
- **Checked.** `scripts/probe/swim.mjs` (a real server: floats, pace under 0.6 of walking, dives and
  rises, climbs out, breath drains, drowning hurts, breath returns), in the page by diving in a
  small world: the swim animation, the breath bar, the fog and the cues.
- **Not done.** The music is not muffled underwater (only the effects and the page's output are, by
  the shared low-pass: the music is under it too - it was not listened to). Other dimensions' own
  water level. Nothing keeps a creature that is knocked into water from drowning (it has no
  breath). The bank hop uses the ordinary jump, so a high bank may need the dive-and-rise step.

## Water at its own level (SLICE.md W10, W11, G1 stopgap)

Built 2026-11-20 for the vertical slice. **Off by default**: a world turns it on in its `world` shape, so
the full game is drawn exactly as before (`scripts/probe/waterHash.local.mjs` hashed heights, water,
roads, bridges and chunks with their grass and trees of three worlds: identical before and after).

```json5
world: { rivers: [2, 2], riverLength: [4, 6], riverTributaries: [1, 1], riverLevels: true }
```

- **The ocean underground (G1 stopgap).** `terrain/ocean.ts` turns the ocean plane off as soon as
  `sunLighting.underground` starts to rise, and the inland water below does the same. Checked in a
  cave chamber 7 m under the sea's level: neither drawn. The real drawing switch (G1, `world.ts`) is
  still to come.
- **Shape keys** (`content/worldConfig.ts`): `riverLevels` (a boolean) and `riverTributaries` (a range:
  how many of the later rivers start beside one already placed, `cells/riverGeneration.ts`, its own
  random stream so a world asking for none rolls as before). With `riverLevels` a river whose mouth is
  within 600 m of an earlier river's line has its line carried on to it (`cells/riverField.ts`).
- **Tributaries join part way.** A tributary starts beside one of its trunk's middle cells - not its first
  or last, clear of its ends and the coast where it can be - and drains into the one furthest down the
  trunk; boxed in, it tries another spot (up to 6). With no middle to join (a trunk too short) it is a
  river of its own, kept from beside the others' ends. Before, half the vale's seeds had the "tributary"
  starting at the trunk's source - one river drawn as two (the user's catch, `vale` seed 1000); now 12 of
  12 join 31-92 % of the way up (`scripts/probe/riverJoins.local.mjs`). A river also stays under its own
  channel where it comes back past itself (a hairpin): its ceiling reads its own stations further than
  twice its reach plus 40 m along it.
- **Each river's water** (`terrain/rivers/riverLevels.ts`): stations every 24 m along the line, each with
  a surface level, the depth of water under it and how far from the line the water reaches. The surface
  starts at the ground at the source and runs down never rising, never above the ground anywhere across
  the river's width (less 0.6 m of bank), falling at least 0.3 % and smoothed; at the mouth it meets the
  sea, or its trunk's level. Where a tributary's valley lies below its trunk's water where they meet, the
  trunk falls to it there (a rapid or a fall) and runs on no higher. Its **width and depth grow with the
  river above** each station - its own length back to its spring plus every tributary joined above it -
  as 1 - e^(-length / 2 km), from a **spring** (a bed 5 m wide, 0.6 m of water) toward 60 m and 3.5 m: a
  0.5 km stream ends about 17 m wide, a trunk with its tributary 40-50 m, and a trunk widens below a join
  (the user's call: every river used to end 60 m wide, short or long). The spring has boulders gathered
  round it (`TerrainSample.springGap`, the rock scatter). The ceiling also
  counts the other rivers' valleys (a second pass): where two come close the higher no longer stands
  over the lower's cut (the user's catch at a source). A river falls at most 15 % a metre, and less the
  wider it is (no more than 0.7 m over its own flat bed's width): a wide flat bed reaches back up the
  river and a steep wide river cut under its own water. **Fords**, one or two a river over 700 m long, are 70 m stretches where it is 0.25 m deep.
- **The carve** (`terrainSampler.ts`, `riverEvaluator.ts`): the bed is the surface less the depth, cut
  after the coast's blend (cut before it, a bed near the coast was dragged toward the seabed far under
  its water). Every
  river segment in reach clips the ground and the lowest result wins - a min of continuous carves is
  continuous, where the nearest segment's alone stepped up to 18 m where two stretches of different
  levels were equally near (the inside of a bend, a confluence). Every `TerrainSample` carries
  `waterSurface`: the nearest segment's level where the point is in its reach, else `WATER_SURFACE`.
- **The water query** (`water.ts`): `createWaterQuery` answers from `waterSurface` and from the **flat
  bodies** in `terrain.waters` - `add({ kind: "pond" | "pool", level, polygon, bottom?, ceiling? })`. A
  pond is water over ground below its level inside its polygon; a pool is a volume (a cave's) found only
  when `waterAt(x, z, y)` is given a height inside it. `waterLineOf` is the line "is this ground wet" is
  read against: the sea level, or a river's own surface.
- **What reads it**: bridges (`roads/bridges.ts`: wet where the ground - or the road's own planned height,
  which grading sinks into the valley later - is more than 0.3 m under a river's surface, so a road wades a
  ford and is bridged over deeper water; the deck clears the water it spans), grass (`grassScatter.ts`, via
  `chunkGeometry.ts`), trees (none in a river's water, fading in from 0.4 to 1.6 m over it), the map tiles
  and the debug map. Swimming, breath, footsteps, the underwater look and creatures already go through
  `waterAt`.
- **Waterside plants and ground** follow a river up the hill: a layer input `aboveWater` (the height less
  `TerrainSample.waterLine` - the sea's level, 0, or by a river at its own level that river's surface,
  falling back to the sea's 0.35 m a metre past its reach) for layers that mean "this near the water".
  By the sea it is the height itself, so nothing changes there (three worlds hash the same). Every
  biome's waterline rules read it - 42 of them: reed beds, wet stones, duckweed, mud, palms and mangroves,
  bananas by the water, the desert's shore, "no snow under the water", the boulders at the waterline -
  and the foliage scatter's graphs get it too. Rules about altitude (snow lines, treelines, terraces, the
  ice peaks' glacier on the valley floors) stay on `height`. The rule for a new one: about the water,
  `aboveWater`; about how high the land is, `height`. `scripts/probe/aboveWaterRewire.mjs` (deleted 2026-11-25; in git history) did the
  switch (a height read only by masks within 8 m of 0 switched; one read both ways split).
- **Drawn** (`terrain/riverWater.ts`): a ribbon per river at its stations' levels, stepping down with them,
  as wide as the ground scanned across each station says the water is (1.5 m past it, so the bank draws
  the shore); where no bank holds it (a confluence, the sea) its edge is laid onto the ground rather than
  left hanging. Its own body colour by the depth of water under each vertex (the ocean leaves colour to
  the terrain shader, which only knows the sea's level), reflection and glint as the ocean's, foam where it
  falls steeply. The ripple pattern lives in the river's own frame (across, along) and runs downstream at
  one speed for the whole river: a speed that varied from vertex to vertex, times the clock, smeared it
  into streaks (the user's catch). At the spring the ribbon runs straight on 4 m past where the ground
  meets the water, so the ground draws where it starts (the user's call: no rounded cap).
  Where a river's water stands above the sea over ground below it (its last stretch, its channel cut
  below the sea's level), the **ocean plane is cut away** under it (`OceanPlane.setHoles`: the ribbon's own footprint between two rows, which the
  ribbon records, up to 64), or the sea showed inside the channel a metre under the river's own surface
  (the user's catch); a ribbon starting from the sea begins one station earlier, tucked 4 cm under the
  sea's surface, so the river runs down into it. (A shallow estuary - the bed kept above the sea instead -
  was tried and dropped: the river turned into a pale sheet. `scripts/probe/riverDepth.local.mjs` prints a
  river's real depth along its line.) Flat bodies are drawn as planes. Stretches at the sea's level are left
  to the ocean plane. Hidden underground; flat bodies (pools) are not.
- **Checked**: `scripts/probe/riverLevels.mjs` - one-zone autumn-wood worlds, four seeds: surfaces never
  rise toward the mouth nor go below the sea, the water query finds the river along 90 %+ of it, a
  tributary meets its trunk's level, no ground step across a river worse than the legacy world's (worst
  2.05 m in a metre against 2.9), water under every bridge and its deck above it, no road through water
  deeper than a ford off a bridge, no water standing over a pit (ground more than 1 m under the river's own
  bed), no road junction within 90 m of a river (its 75 m road corridor and a margin), no two bridges
  meeting end to end, no levels without the flag. `water.mjs` (with roadWater's checks) still
  pass. In the page (`?play&config=rivers&seed=4242`, `public/configs/rivers.json5`): a river at 22 m
  over the sea, drawn and on the minimap.
- **Crossings are one bridge** (2026-11-25, the owner's ruling: roads meeting over a river is a road-maker
  bug). Bridges are planned per road stretch (`bridges.ts`), so a junction in a river had every stretch
  meeting there bridged on its own, the decks meeting low over the water (seed 7, at -143, 117: three
  bridges, their ends 0.98 m over it). The road search (`roadPathfinder.ts`) now never joins, leaves or
  cuts across a road on a lattice node within `ROAD_JUNCTION_RIVER_CLEARANCE` (120 m) of a river's
  centreline, and a track to the nearest road never ends on one (`roadNetwork.ts`): a road crossing a
  river runs on its own, bank to bank, and meets the others away from it. Over the riverLevels and vale
  probe worlds (10): junctions within 120 m of a river 26 of 50 -> 1 of 28 (an anchor off its node, at
  114 m), bridges meeting end to end 8 -> 0, low bridge ends 2 -> 0, bridges 25 -> 26, road 40.0 -> 41.4 km;
  every settlement and feature still has its road, though more candidate links find no route (6 against 2).
- **A bridge's approach banks down like any road** (2026-11-25). The ground is graded to the nearest road
  *off* a bridge (`RoadQuery.groundDistance`, `roadField.ts`), not to the nearest road: where the deck
  became the nearest, grading stopped, and an approach filled above the ground beside it ended in a wall
  along that line (seed 7 with the polygon logging camp, by 865, 192: 6.4 to 2.8 m in a metre). Past an
  approach's end at a bridge its level ground stops at the deck's start and the bank fans out from there
  at `ROAD_SIDE_SLOPE`. And an approach between a deck and its stretch's end (a gate, a junction) comes
  down to that end's level, steeper than `BRIDGE_APPROACH_GRADE` where it must, instead of lifting the
  end over the street it meets (seed 1338, by 1604, 1051: 2.2 m). Steepest 1 m step within 30 m of a
  bridge end over the 10 probe worlds, water and pads aside: 6.23 -> 2.35 m.
- **Not done.** Where a river meets the sea there is a visible seam: the two surfaces are different
  shaders (the ocean draws reflection and glint only, its colour from the terrain's tint; the river its own
  body colour, its ripples in its own frame). Agreed with the user to leave for later; the way to do it:
  a per-vertex "to the sea" weight over the last few stations, lerping the river's ripples to the ocean's
  world-space waves and its body colour to the terrain's tint under the sea, so the two match at the seam.
  Lakes are still sea-level hollows: a mountain lake needs a lake body at its own level
  (the flat `pond` is ready for it, and for W13's mill pond), nothing generates one yet. A cave pool needs
  `sim/playerBody.ts` to pass the body's height to `waterAt` inside a dungeon (it skips water there) and
  the cave session to add the pool. Fords are rolled, but roads choose their own crossings: in the four
  probe worlds none crossed at a ford - steering roads to them belongs with W6. The slice's own dimension
  (W1) has to set the shape keys. The terrain's own water tint and floating sheet still follow the sea's
  level only (the ribbon's body colour stands in). Frame cost not measured (a few hundred vertices a
  river). Some seeds give a trunk that is lowered to the sea all along by a tributary joining near its
  source (seed 1338), a sea-level river like the legacy ones.
