# Dungeons

The plan for caves and dungeons: places under the ground, generated from the seed out of parts in
packs, the same every visit (GAMEPLAY.md, *Combat*), where the puzzles and secrets of the game live
(*Exploration*). Two styles first: a natural cave, shaped as a whole from a distance field, and a
crypt, built from stone parts. **Status: plan, waiting for approval.** The spike is done (see
[Spike](#spike)); nothing is built in the game yet.

## Decisions

Asked and answered before the plan was written.

| Question | Decision |
|---|---|
| How one gets in | **Seamless, every size** (the user's call, 2026-11-15, replacing *mixed by size*): walked down into from the terrain, under it, no loading screen; parts streamed by the player's distance. The style keeps the switch to a space of its own (a loading screen, like a dimension) for some later style that needs it |
| A crypt's mouth | **A wide mausoleum** (2026-11-15): about 30 m by 16 m at the game's doubled scale - a 6 m way cannot go down under a small one. Its way down zig-zags so the dungeon is never seen from outside nor the door from the dungeon: a vestibule along its front down a steep flight (0.25 m on 0.5 m) to a turn round a spine wall, a second flight back along its rear down past its end into the rock, a landing 19 m down whose way on runs into the hill. The camera stepping onto the second flight switches the drawing from the world to the dungeon (the user's idea: one or the other, never both). Its walls hide where the ground's collision is holed; the terrain needs no cut |
| How big | **Varies by kind**, set by the style: a lair of 4-8 rooms (5-10 minutes), a dungeon of 15-30 rooms on 1-3 floors (30-45 minutes) |
| Styles first | **A natural cave and a crypt** |
| Gameplay first | No preference given. Proposed: a boss and a key for a locked door first; traps, levers and secret rooms in a later step |
| Instancing | **Shared, like the world.** One copy per server; mobs and chests shared; cleared state and respawn in the world delta. Large dungeons are built so a copy per party can come later |
| Entrances | **Their own features**, sited by the terrain (a cave mouth on a hillside), **and other places'** (the churchyard's crypt building, a bandit camp's cave): the place declares the entrance |
| Cave shape | **Organic, from parts in a distance field.** A cave's parts (chamber, tunnel, fork) are shapes in one signed-distance field, meshed in a worker; joins blend by themselves, with no seams and no transition meshes |

## Principles

- **A dungeon is a place, not a level.** It is generated from its owner's seed - the feature or
  building it is under - so the same place always opens on the same dungeon, and nothing of it is
  saved but what was cleared.
- **Parts and rules are content.** A style is a pack file; its parts are pack files. The engine
  knows sockets, bounds, spots and shapes; it knows nothing of crypts or caves. A mod adds a sewer
  by adding a style and parts.
- **Always succeeds.** Generation from a seed never fails: it retries on a derived seed and falls
  back to a minimal layout that is always valid (an entrance, a corridor, a room).
- **One generator, two builders.** The layout - parts, where they stand, how they join - is the
  same for every style. What turns a placed part into a mesh and colliders is the style's builder:
  `kit` (built parts, ModelBuilder and boxes) or `field` (shapes in a distance field, meshed).
- **Pure.** Layout, the field, the mesh's positions and the colliders come out of `src/world` code
  with no Babylon, so the headless server builds the same collision the page does.
- **Built once, in a worker, and cached**, as chunks, textures and light bakes are.
- **Big spaces.** Nothing walkable is under 6 m wide or 6 m high, and much is far more (see
  [Scale](#scale)).
- **Dark, but never blind.** No flashlight is needed: the places light themselves (torches,
  glowing fungi, light through the mouth), and the player always has a little light of their own.

## Spike

`scripts/probe/dungeonSpike.local.mjs` (Node, no graphics; `[voxel] [chunk] [scale]`). A cave of
six chambers and six tunnels - a chain, a branch and a loop - as a distance field with two octaves
of noise on the walls, sampled on a grid, meshed by surface nets in chunks of 16³ cells, and given
a triangle-mesh collider: each triangle one-sided, solid behind, found by the existing
bounding-box tree and tested by the heightfield's own triangle code (`separateTriangle`), with the
field itself saying what is inside the rock. The character motor then walked every tunnel, there
and back, at 30 steps a second. Then a per-vertex light bake of twelve lights against the
collider's tree.

At [the minimum size](#scale) - no tunnel under 6 m wide or high - the cave is 130 × 47 × 105 m and
falls 26 m from the mouth; about a minute of walking end to end:

| Voxel | Samples | Sample the field | Mesh | Triangles | Mesh (GPU) | Collider tree | Motor step | In the rock |
|---|---|---|---|---|---|---|---|---|
| **0.75 m** | 1.6 M | 2.9 s | 0.4 s | 73 400 | 1.9 MB | 0.7 s | 0.09 ms | never |
| 0.5 m | 5.3 M | 9.3 s | 0.9 s | 166 700 | 4.3 MB | 1.7 s | 0.11 ms | never |

(The first run, at the old half size - 75 × 29 × 61 m, 2-2.6 m tunnels - took 1.9 s at 0.5 m for
51 000 triangles; it is what showed 0.5 m was then needed. At 6 m and more 0.75 m keeps the shape.)

At 0.75 m the motor was on the ground 99% of the time, got stuck in no tunnel, never ended a step
inside the rock, and was back at the mouth at the end. The same motor walked a 6 × 6 m crypt
corridor of 22 boxes down a stair of twelve 0.25 m steps in 0.09 ms a step. The light bake took
1.8 s for 0.13 M shadow rays (14 µs a ray with the spike's JS objects). The cave's faces are 24%
floor, 31% wall and 44% ceiling.

What it settles:

- **Per-triangle collision works and is cheap.** About 45-70 triangle tests a step, a tenth of a
  millisecond. The existing motor needs no change: ground, walls, ceilings and slopes come out of
  the mesh's normals. A `mesh` shape kind is a small addition (below).
- **Voxels are not too slow** when bounded and built once: about 4 s in a worker for the whole
  cave at 0.75 m, most of it sampling the field, which a chunk test (skip chunks wholly in rock:
  about 70% of them) and fewer noise octaves cut to one or two. The voxel is a style setting:
  0.75 m by default, 0.5 m for a style with finer shapes.
- **Joins must be flush.** In the first try at the bigger size the tunnels ran from chamber centre
  to chamber centre, so a tunnel rose inside its chamber and met the chamber's floor as a 4 m
  ledge: 16 stuck legs. With the tunnel starting at a socket on the chamber's floor by its wall, as
  the generator's sockets will, none. The layout check measures every join (below).
- **Noise eats size.** Walls' noise took up to 0.8 m off a tunnel's width and height: shapes are
  sized as the minimum plus the noise's reach, and the check measures what is left.
- **Memory is small**: the field 6 MB while building (dropped after), the mesh 1.9 MB, the
  collider about 4 MB as typed arrays (11 MB as the spike's JS objects, which the real shape will
  not use). A seamless cave is about 10 MB; a dungeon space under 50 MB.
- **Seamless needs one change to the ground**: a heightfield is solid all the way down (its bounds
  reach to minus infinity and anything under it is pushed up), so a cave under the terrain would
  throw the player up to the surface. The ground gets a depth: solid only from its surface to a few
  metres under it (below).
- **Built parts stay convex boxes**, as buildings do. Only the field builder needs the mesh shape.

## Scale

- **6 m is the floor, not the size.** Every corridor, tunnel, doorway and stair is at least 6 m
  wide and 6 m high, measured where it is tightest, after noise. Rooms and chambers are as big as
  their parts make them: a crypt's burial hall 12-20 m across with an 8-10 m vault, a cave's great
  chamber 30-40 m across and 20 m high.
- **Why so big.** The world is at about twice life size (buildings' details are authored so),
  the third-person camera needs room behind the player, fights with a group need room to move, and
  a large creature or a boss must fit through the way it comes.
- **Details stay at the world's scale**: a step 0.25 m high (a crypt stair 6 m wide), a burial
  niche 2.5 m, a stalactite up to 4 m, so the spaces read as huge rather than as a small place
  scaled up.
- **Checked, not hoped for.** Sockets carry a size (width and height, both at least 6). Every
  part's walk lines are measured by rays on its own colliders when the packs load - a floor
  underfoot, and the width and height every 1.5 m and at each socket - and a part under the minimum
  stops loading, saying where. Parts join only face to face at sockets, so an assembled layout is
  as clear as its parts; the probe measures fifty assembled layouts with every part's colliders in
  place to show it. The rules hold the minimum (`rules/dungeons.json5`: `minClear: [6, 6]`), so a
  game can change it.
- **Headroom on stairs**: each step's vault is one step higher than its floor plus 6 m, so even at
  a step's edge, under the next one down's vault, there are 6 m.
- **Floors' slopes** stay under the motor's steepest ground (52°), and tunnels under about 25°, so
  they are walked, not climbed.

## Under the ground

A dungeon lies under the terrain, and no part of it may show through: not a ceiling poking out of
a hillside, not a tunnel crossing under a valley floor with a metre of rock over it. The layout is
built for that, not patched after.

- **Cover, checked per part.** The style sets `cover`, the rock that must lie between the top of
  any part (its bounds, including the noise's reach) and the ground above it: 8 m by default, so
  the ground's collision depth (3 m, [below](#the-grounds-depth)) and the terrain's mesh are far
  from the ceiling. The generator samples the final ground height (after roads, flattening and
  rivers) every 2 m over the part's footprint, grown by 2 m, and keeps the part only if its top
  is `cover` under the lowest sample. Only the entrance part may reach the surface.
- **Under other places, deeper.** Where a footprint lies under a building, a cellar or another
  feature's ground, the cover needed doubles, so no cellar floor ever opens into a cave.
- **Parts that go down.** Every style has parts whose job is to descend, so the layout can dive
  first and spread once it is deep:
  - crypt (built): a straight stair (6 m wide, 24 steps of 0.25 m, 6 m down over 18 m), a turning
    stair (two flights and a landing, 6 m down inside its own footprint, out beside where it went
    in), a spiral stair round a pillar (20 m across, a turn and a half, 11.5 m down - about 7.7 m a
    turn, the least that leaves a vault and a floor between laps), and the entrance, the same
    spiral two and a half turns and 19.5 m deep;
  - cave: a sloping tunnel (up to 25°), a curving descent (a tunnel bent along an arc or a helix,
    8-15 m down over a quarter to three quarters of a turn), a chamber on terraces, a rubble ramp
    down a drop.
  A part's sockets carry their heights, so each part knows its `drop` from the socket it was
  entered by; curved and spiral ones drop the most for the least ground, which is what thin cover
  needs.
- **Diving first.** Where the cover over an open socket is thin (under `cover` plus `thinCover`,
  20 m), parts that drop are rolled four times as often and parts that rise not at all; once deep,
  the style's own weights apply. Sockets facing into the hill (where the ground rises ahead) are
  grown first, since going in gains cover for free.
- **Spaces too.** A large dungeon behind a loading screen has no terrain drawn over it, but its
  layout is checked against the ground over its entrance all the same, so its map lines up with
  the world and it could later be made seamless.
- **Where an entrance can go.** Under a ridge, or with a valley a little way in, there is no room
  for a dungeon: the generator falls back to its minimal layout. So an entrance is sited where the
  hill keeps rising behind the door (the probe takes hillsides that rise 5 m within 20 m and 12 m
  within 40 m), and step 5's sitings generate the layout and pass over a site whose layout is the
  minimal one.
- **Proved in the probe** (`scripts/probe/dungeons.mjs`): a thousand layouts on the real terrain,
  at the cemeteries' crypts and at 400 hillsides, every part under its cover measured at twice the
  generator's sampling (the least rock over any part 7.8 m, never showing), zero exceptions.

## Materials

Floors, walls and ceilings are different materials, and a cave has no edges to change material
at, so where one gives way to another is worked out, as the terrain's layers are.

**Built parts (crypt)** are simple: each face is laid by ModelBuilder with its own material and UVs
in metres, as buildings are - flagstones on the floor, ashlar or brick on the walls, a plastered
or stone vault overhead, worn steps. A transition part (a crypt doorway broken into a cave) carries
both: rough masonry on its crypt side and rubble spilling into the cave's floor.

**Stairs** have materials of their own (built): `stairTread` on a step's top and `stairRiser` on
its front, both bevelled where they meet - a pale, rounded nosing, a shadow under it on the riser.
Each is laid by the step itself: in metres along the step, but exactly once from the nosing (the
edge the step drops away from) to its back, and from the riser's foot to its top - so the bevel is
on the edge whatever the step's size. A spiral's wedge-shaped steps stretch it a little toward the
pillar; its level landings are floor. The style names them (`look.tread`, `look.riser`).

**The field (cave)** has no UVs and no faces of its own:

- **No unwrap: triplanar.** Textures are laid in world space from three sides and blended by the
  normal, at each material's own scale in metres. A floor reads its texture from above, a wall from
  the side, with no stretching however the surface turns. The blend is sharp (a weight to the
  fourth power or so) so the three projections do not smear into each other, and each axis is
  offset so repeats do not line up.
- **Layers by weight, per vertex.** The worker writes each vertex's weights for a few layers - as
  the terrain's material blend does - from what it knows there:
  - **floor** (gravel, silt, mud): where the surface faces up (the normal), is near its part's
    floor height, and lies in a hollow (the field gives how enclosed a point is cheaply);
  - **wall** (the bedrock): what faces sideways;
  - **ceiling** (the same rock, darker, with flowstone and drip marks): what faces down;
  - **accents** a part asks for: moss and roots near the mouth where daylight reaches, wet streaks
    under drips and round pools, mycelium in a fungal chamber, crystal in a geode.
  The ground under a part's floor level always stays floor, so a lump in the floor does not turn
  into wall rock.
- **Wide, ragged changes.** Floor gives way to wall over a band of about a metre or two, broken
  up by noise and by the floor texture's own height (gravel collecting in the wall's cracks), never
  along a straight line where the slope crosses a threshold (the moors' layers are the reference).
- **At most two layers a pixel**: the worker keeps each vertex's strongest two, so the shader
  reads two triplanar materials (six samples and their normal maps), not every layer.
- **Materials are pack data**, baked by the same texture graphs as the terrain's ground
  (`materials/`): `caveRock`, `caveGravel`, `caveSilt`, `flowstone`, `caveMoss`, `mycelium`, cached
  as ground textures are.
- **Where field meets kit** (a crypt opening into a cave) the transition part's mesh covers the
  edge, and the field near its socket takes a `rubble` accent so the two floors meet in something
  that belongs to both.

## Light

Dungeons are dark: no sun, no sky, no moon. Light is baked, like houses' (LIGHTS.md), and placed
by the parts.

- **Fixtures are part of the parts.** A part's `light` spots name what stands there - a torch on
  a sconce, a brazier, a candle niche, a glowing fungus cluster, a crystal - from the style's
  fixture tags. The fixture is a prop with a light (colour, reach, a fire's flicker or a steady
  glow). Not every spot is lit: a style says how many, so some rooms are dim.
- **Baked per part.** Each part's light is baked on its own, with its own fixtures and its
  neighbours' that reach into it, against the dungeon's triangles; a part is the unit of baking
  and caching (by the dungeon's seed, the part's place and the content's hash), and the bake runs
  in the light-bake workers, several parts at once.
  - **Built parts**: LIGHTS.md's lightmap, laid on the part's own faces (they are flat polygons,
    as a house's are).
  - **The cave**: its triangles belong to the part whose shape is nearest. The light is stored per
    vertex: surface nets' vertices are about 0.75 m apart - coarser than a house's 25 cm texels,
    but a torch's light across rock is soft anyway, and nothing has to be unwrapped. If it looks blotchy in
    the cave step, the fallback is a lightmap per chunk laid by triplanar charts.
  - The spike's per-vertex bake, twelve lights and four soft-shadow rays each, took 1.8 s for the
    whole cave in one thread.
- **Daylight through the mouth**: the entrance part bakes a skylight term - rays to the mouth's
  opening - so the first parts are lit grey-blue from outside, by day only (scaled by the sky's
  light as the hour turns), fading to nothing a part or two in.
- **Flicker** as LIGHTS.md: fires in the lightmap's fourth channel, flickering together per part.
- **The player's own light**: one soft point light on the character, no shadows, small, so the
  darkest corner is dim, never black, and no torch is needed to play. Creatures carry none.
- **A little ambient** (`light.ambient` in the style) so unlit rock is a dark shape against the
  lit, not a hole.
- **Moving things** (characters, creatures, dropped loot) are lit by the nearest fixtures as
  dynamic lights, the few strongest near the camera, as LIGHTS.md does for things in houses.

## A style

`packs/<pack>/dungeonStyles/<id>.json5`:

```json5
{
  name: "Natural cave",
  builder: "field",                  // or "kit"
  // How big: the generator places rooms until it has this many, then closes every open socket.
  sizes: {
    lair:    { rooms: [4, 8],   floors: [1, 1], entry: "seamless" },
    dungeon: { rooms: [15, 25], floors: [1, 2], entry: "space" },
  },
  // The shape of the graph: how often a room has two ways on, how many loops, how many dead ends.
  branching: 0.35, loops: [0, 2], deadEnds: [1, 3],
  // Where the special rooms go.
  boss: { part: { tags: ["boss"] }, at: "deepest" },
  keys: { locks: [0, 1], on: "bossBranch" },        // a lock on the way to the boss, its key in another branch
  cover: 8,                          // rock over every part's top, metres (see Under the ground)
  deepest: 60,                       // how far under the entrance it may reach
  parts: { tags: ["cave"] },         // which parts it uses
  light: { ambient: 0.02, mouth: true, fixtures: { tags: ["fungi"] } },
  voxel: 0.75,                       // the field's cell, metres (field builder)
  materials: { floor: "caveGravel", wall: "caveRock", ceiling: "flowstone", accents: { mouth: "caveMoss", wet: "caveSilt" } },
  music: "cave",                     // MUSIC.md's theme
  ambience: "drips",                 // a sound bed (FEEDBACK.md)
  creatures: { tags: ["cave", "lair"] },
  loot: { chests: "caveChest", boss: "caveBoss" },
  quest: {                           // QUESTS.md's place block, as features have
    tags: ["cave", "dark", "remote", "dungeon"],
    objects: [{ item: "lostLantern", tags: ["lost"] }],
    text: "place.cave",
  },
}
```

## A part

`packs/<pack>/dungeonParts/<id>.json5`. A part is a piece of the layout with sockets on it, and how
it is built.

```json5
{
  tags: ["cave", "chamber"],
  weight: 3,
  stage: [0, 1],                     // where in the dungeon it may go: 0 the mouth, 1 the deepest
  apart: ["spiral"],                 // never joined straight onto a part with any of these tags (optional)
  bounds: [[-18, -1, -16], [18, 20, 16]], // what it takes up, for the generator's overlap test
  // On the floor by the wall, so a tunnel's floor meets this one flush. Size: width and height of
  // the way through, never under the rules' minimum (6 x 6).
  sockets: [
    { at: [-15, 0, 0], facing: 270, type: "tunnel", size: [7, 7] },
    { at: [15, 0, 4], facing: 90, type: "tunnel", size: [7, 8] },
    { at: [0, 0, 13], facing: 0, type: "tunnel", size: [6, 7], optional: true },
  ],
  // field builder: shapes in the distance field
  shape: [
    { ellipsoid: [0, 6, 0], radius: [18, 12, 16], floor: 0 },
    { noise: { scale: 0.35, amount: 0.6 } },
    { stalactites: { count: [4, 10] } },
  ],
  // kit builder instead: its colliders and walk lines (built, step 2), a ModelBuilder recipe (step 3)
  // colliders: [{ box: [x0, y0, z0, x1, y1, z1] }, { stair: { from, to, width, ceiling } },
  //             { spiral: { centre, top, inner, outer, start, turns, drop, ceiling } }],
  // paths: [[[x, y, z], ...]],      // the lines the floor is walked along, measured at load
  // room: true,                      // counts toward the style's rooms (else a way between them)
  spots: {                            // anchors for what fills it, as features have
    spawns: [[0, 0, 0], [4, 0, -3]], chest: [[-6, 0, 5]], light: [[6, 4, -6]],
    quest: [[2, 0, 4]], boss: [[0, 0, 0]],
  },
}
```

- **Sockets are typed**, and a part may carry several types. Two sockets join when their types are
  compatible (`rules/dungeons.json5` lists which types meet) and their sizes overlap; a joined pair
  faces each other exactly.
- **Transition parts** are parts whose sockets are of two types: a crypt doorway with a crypt
  socket on one side and a `tunnel` on the other is how a crypt breaks into a cave. In the field
  builder a socket also carves: the tunnel is opened to the doorway's exact frame, and the frame's
  mesh hides the edge. Between two field parts no transition is needed; their shapes blend.
- **The entrance part** carries a terrain connector: its mouth socket is of type `surface`, it
  says how the ground is cut over it (a terrain cut, as cellars have), and the generator places it
  where its owner stands, facing out of the slope.
- **A descent** is a part like any other; its sockets differ in height. A curving cave descent:

  ```json5
  { tags: ["cave", "descent"], weight: 2, stage: [0, 0.8],
    sockets: [
      { at: [0, 0, 0], facing: 180, type: "tunnel", size: [7, 7] },
      { at: [14, -11, 14], facing: 90, type: "tunnel", size: [7, 7] },  // 11 m down, a quarter turn on
    ],
    shape: [{ helix: { radius: 14, turn: 0.25, drop: 11, width: 7.5, height: 7.5 }, floor: true }],
  }
  ```

- **Caps** close a socket nobody joined: a rock fall, a bricked-up arch, a tunnel's rounded end.
  Every style has at least one per socket type, so closing always succeeds.

## The generator

`src/world/dungeons/layout.ts`, pure and deterministic:

1. Place the entrance part at the owner's spot.
2. Grow toward a room count rolled in the size's range: take an open socket (breadth first; a
   part's further sockets kept open by the style's branching, else set aside as spare and grown
   from only when nothing else is open), pick a part with a compatible socket by weight among
   those allowed at this stage (descents weighted up while the cover is thin, [Under the
   ground](#under-the-ground)), line its socket up with the open one, and keep it if its bounds
   overlap no placed part and its top lies `cover` under the ground everywhere over it (both
   measured on its box in the layout's own frame - the entrance's, turned to its door - where
   every part is square to the axes; a box square to the world round a part turned 37° is half as
   big again, and refused most of what fits). Each
   option is tried once, up to `triesPerSocket`, then the socket is capped. At a dead end with
   nothing else open, the corridor or stair just laid is taken back and something else tried
   where it began (up to 40 times an attempt). The ground comes in as a `heightAt(x, z)` and a
   `builtAt(x, z)`, so the generator stays pure.
   **One way, one direction**: along a way - parts with one way in and one out, the entrance's
   stair among them, with no room or branching between - stairs never turn back. Walking back from
   an open end, the first part that changes height says which way the way is going, and a part that
   would go the other way is not tried there (up, down, up again on one corridor makes no sense). A
   room, or a part where ways branch, frees it. Loops keep to it at both their ends.
3. Loops, made on purpose (the user's call: a layout that circles back is easy to get lost in, and
   that is fun). Every pair of open ends at most `loopReach` (60 m) apart and at least `loopSpan`
   (4) joins apart along the layout is a candidate, the longest way round first. Between the two,
   routes on the layout's square grid: straight on, one turn, a dog-leg or a U - with a run out of
   either end and a turn first (0, 12 or 24 m), so ends facing away from each other meet too; any
   change of height spread over the straights as flights with landings. The shortest sixteen are
   tried; each is laid piece by piece - corridors and flights the generator sizes to fit (built
   as the kit's corridors and stairs are: floor, walls, vault, 6 m clear), and the style's corner
   (`cryptCorner`, turning either way) - and taken back whole if any piece will not fit, until one
   does. The style's `loops` range is rolled; an attempt short of its least (1) is retried, the
   first that passes kept if none reaches it. The style declares how: `connector: { socket, corner,
   width, height, wall, rise, tread }`.
4. The boss room: on the leaf room furthest from the entrance (by the graph), in its place, or at
   the furthest open end - straight on, or past a corridor or a stair laid first when it will not
   fit there; a lock on the join into it, its key in the furthest other room.
5. Close every open socket with a cap.
   Then a **doorway** across every join and cap, and at the mouth ([Doorways](#doorways)), rolled
   on their own so they never change the layout. A cap may sit in a neighbour's wall (solid in solid); it
   never reaches into anyone's way through.
6. Check: every room reachable from the entrance, the boss behind its lock and the key this side
   of it, at least the size's least rooms, the boss placed, every part under its cover - looked at
   again twice as finely (every metre), so a dip narrower than the sampling, a stream's bed, is
   never missed. Failing
   that, start again from a seed derived from the last; after `attempts` (8), the minimal layout
   (the entrance, a room if one fits, caps).

Measured (the probe, a thousand layouts on the real terrain, with loops): 1.85 retries a layout,
0.6% minimal, 40 parts and 7.7 rooms each, the deepest room 37 m down on average; 858 loops - in
51% of lairs and 89% of dungeons, the longest 36 joins round; 220 ms a layout (the slowest 0.87 s),
nearly all of it sampling the real terrain's height (5-10 ms on made-up ground). Before the
frame's boxes and loops: 8.6% minimal, no loops, 56 ms.

The layout is a graph - parts as nodes, joined sockets as edges - and that graph is reused by
everything inside: navigation, the map, quest spots.

## Building it

| | Kit (crypt) | Field (cave) |
|---|---|---|
| Mesh | ModelBuilder recipes per part, in the building shader - one mesh per part, textures from the building materials | The whole cave's field sampled at the style's voxel (0.75 m), meshed by surface nets in chunks of 16³ cells (12 m), in a worker; layer weights per vertex, triplanar materials ([Materials](#materials)) |
| Collision | Boxes and convex pieces per part, authored with it, as buildings' colliders | A `mesh` shape per chunk |
| Light | LIGHTS.md's lightmap bake, per part | Baked per part, stored per vertex ([Light](#light)) |
| Cached | By the dungeon's seed and the content's hash | Same |

### The mesh shape

`src/world/collision`: a fifth kind of shape beside the heightfield.

```ts
interface MeshDesc {
  kind: "mesh";
  positions: Float32Array;     // x, y, z per vertex
  indices: Uint32Array;        // three per triangle, wound counter-clockwise from the open side
  inside?: (p: Vec3) => boolean;  // optional: whether a point is in the solid (a cave's field)
}
```

- Each triangle is solid behind its face only, as the ground is; the shape keeps its own
  bounding-box tree over its triangles, built once.
- Sweeps, overlaps and nearest go through `separateTriangle` as heightfield triangles do; rays
  through a ray-triangle test. Nothing in the motor changes.
- `inside` makes the way out robust at edges and corners (the heightfield's `underGround` does the
  same); a cave passes its field, quantised to bytes after building (about 1.6 MB).
- The collision probe gains cases for it: a closed box as a mesh against the same box as a box,
  sweeps never ending inside, the motor's scenarios in a mesh corridor.

### The ground's depth

A heightfield gains `depth` (default infinite, as now): solid only from its surface to `depth` under
it, open below. The game's terrain sets about 3 m, so a cave more than 3 m down is not pushed up
through the surface, and the cellar slabs keep working. The style's `cover` (8 m) keeps every part
well below that.

## The crypt's parts

Two sizes of way: `crypt` (corridors, 6 m wide and high) and `cryptLarge` (galleries, 10 m wide, 8 m
high). Ways of one size join only their own; rooms with both kinds of opening are where they meet.

- **Ways**: corridor, corridor with an alcove, corner, stair, turning stair, spiral, the entrance's
  spiral; gallery, gallery with alcoves, grand stair; junctions - crossing, tee, and the rotunda (a
  round crossing 45 m across, a ring of pillars round its middle). Never the end of a route.
- **Rooms**: the 18 m hall and the tomb (corridors only); the long hall, the L, the fat T, the smaller
  hall, the pillared hall (written from their outlines by `scripts/dungeonRooms.py`), the great hall
  and two halls of two storeys - a terrace, a stair 10 m wide down to the floor 6 m below with 21 m
  of floor at its foot, one entered along the stair and one from the side - all with both kinds of
  way.
- **Bosses**: the boss hall (28 m square, a corridor in) and the great boss hall (40 by 44 m, 16 m
  high, a gallery in, four piers well out from its middle).
- **Caps** (one a size) stand inside the opening they close.

## Doorways

Where two parts meet, neither part's own geometry is trusted to meet the other's: their walls are
different shapes (a spiral's round wall against a corridor's flat one leaves gaps either side of
the opening), and two faces in one plane flicker. So the meeting is a part of its own:

- **A doorway part** (`dungeonParts/`, a `doorway` block in place of colliders): `kind` - `frame`
  (jambs, a sill, a lintel), `arch` (straight jambs to the springing, `rise` under the opening's
  top, then a ring of voussoirs over it, a keystone at the crown rising over the rest) or `door` (a
  frame and two leaves standing open into the part beyond, drawn but not in the way) - with `jamb`
  (1.5 m: the band's width), `lintel`. Every kind has a stop round the opening at its middle, inset
  0.3 m - the doorway's depth showing - and a threshold across it, 0.15 m high, stepped over. Its
  stone is the style's `look.frame` (`doorStone`: big blocks, chamfered joints, paler than the walls).
- **The one exception to 6 m**: a doorway's opening is its socket's size less its stop (5.4 m), and
  an arch narrows over its springing. The probe measures everything else at 6 m and passes over the
  doorways.
- **As thick as where it stands**: each socket says how far a doorway may reach into its part -
  `reach` (1 m by default, the walls' depth: corridors, stairs, corners), 1.5 m into a hall, a tomb
  or the boss hall (so the frame stands half a metre proud of the wall) and into a spiral (covering
  its round wall where it curves away from the opening, as far as its walkway allows) - and
  `reachOver`, how far its lintel or arch may (a spiral's 1 m: the next lap passes close over the
  door). Set down, a doorway is built for the two sockets it stands between.
- **Set by the generator** across every join, and at the entrance's mouth - not at a cap, whose
  wall closes the way (a frame round it could reach into a neighbour's opening); the style's
  `doorways` say which, by weight.
- **Thick and overlapping**: it reaches into both parts, covering where their walls meet. Drawn, a
  part gives way to its doorways - its faces cut where a doorway lies in front of them, or where a
  doorway's face lies on its own - and a doorway is cut and seen against both parts it stands
  between. Nothing z-fights, nothing is left open.

## Seamless and separate

| | Seamless (lairs, small crypts) | A space of its own (large dungeons) |
|---|---|---|
| Entering | Walked into: the mouth cuts the terrain (a terrain cut, as cellars, and holes in the ground's collision), the cave lies under the surface | A door or a deep stair in the entrance part; walking into it starts a transfer, as a dimension's |
| Collision | Batches beside the chunk's, streamed in within about 150 m of the mouth and out past 200 m, as buildings are | Its own collision world on the server, like a dimension's |
| Drawing | Its meshes stream with it; the surface keeps drawing above (the rock hides it) | Its own scene: no terrain, sky or weather built at all |
| Light | Its materials ignore the sun and sky but for the light through the mouth | Same, nothing else to ignore |
| Cost | The terrain's depth, cuts, streaming; at most three seamless dungeons near at once (the terrain shader holds eight cuts) | A dimension kind with a `dungeon` generator; one in memory per occupied dungeon |
| Server | Part of the dimension it is in | `createDimension` with a dungeon world in place of a landmass (DIMENSIONS.md, *Later*) |

The style's size decides: a lair is seamless, a dungeon a space. Both use the same layout, builders
and contents, so a space could later become seamless, or a lair become its own space, by changing
the style.

## Entrances

- **Their own features**: `features/caveMouth.json5`, a small feature sited on a slope steep enough
  to face into (a cliff foot, a hillside), with a `dungeon` block: which styles and sizes, and
  where the mouth stands.
- **Other places' entrances**: a feature or building declares a `dungeon` block of its own. First:
  the churchyard's `crypt` building (its door leads down a stair into a crypt), and a bandit camp's
  cave on a slope. Like a place's `quest` block, a pack can patch one onto someone else's place.
- **The dungeon's id is its owner's**: `mainland/feature/1234/dungeon`, the key of its world delta.

## What fills it

- **Light**: fixtures at parts' `light` spots, baked per part ([Light](#light)).
- **Creatures.** Spawn points at parts' `spawns` spots, from the style's creature tags and the
  zone's level, filled when a player is near, as outdoors (CREATURES.md). The boss is a named
  elite at the boss room's spot with its own loot table and a few more tactics.
- **Moving inside.** The brain has no pathfinding and gives up when stuck (CREATURES.md, *Leash*).
  Underground it steers by the layout's graph: the path of parts and sockets from where it is to
  its target, walking to each socket in turn, then straight once in the same part. The same graph
  leads an evading creature home. Bodies are put on the floor by a ray down the collision, never by
  the terrain's height.
- **Chests** at `chest` spots, from the style's loot table (ITEMS.md); a locked door's key drops
  from a creature or lies in a chest in its room.
- **Quests.** The style's `quest` block makes every dungeon a place quests can use: `reach` (its
  deepest room), `kill` (its boss, its creatures), `gather` (objects at its `quest` spots). Parts
  and plots ask for its tags; nothing names a dungeon.
- **The world delta** keeps what was cleared, by the dungeon's id and its spawn points' and chests'
  ids, with respawn times as outdoors. A boss comes back after hours, not minutes.
- **The map.** Inside, the minimap and world map draw the dungeon's own plan from the layout and
  the floor's mesh, one floor at a time (by height band), with the same marker kinds. Outside, a
  dungeon is a marker at its mouth.
- **Music and sound.** The style's theme plays while inside (MUSIC.md), the ambience bed under it.
  Footsteps by the floor's material (FEEDBACK.md).

## Dev pages

- **`dungeons.html`** (built, step 2): a line-up of generated layouts for one style, size and seed
  range, under made-up ground (flat, a hillside, below a ridge, a valley behind), each as a plan
  from above - darker deeper, the graph, the lock and the key's room drawn over it - and a side
  view along the way in with the ground's line and the cover's line over it. "Walk it" opens one in
  the collision sandbox.
- **Workbench, dungeon parts** (later): one part on its own, its sockets drawn as arrows with their
  types, its spots, its colliders.
- **The collision sandbox** gains a cave and a crypt corridor to walk (step 1), and a generated
  dungeon (`?preset=dungeon&style=crypt&size=lair&seed=3&ground=hill`), its entrance in a pit in
  the ground.
- **In the game**: `/dungeon` (CHAT.md) to go to the nearest entrance, `__aiworld.dungeon` with
  the layout and timings.

## Steps

Each leaves the game working: dev server with `?play`, `npm run probe`, `npm run server`,
`npm run typecheck`, `npm run build`; each checked in the running game.

1. **Collision.** The `mesh` shape, the heightfield's `depth`; probe cases; the spike's cave and
   corridor as sandbox scenes. *Done*: a mesh agrees with the convex hull it is made from (inside,
   rays, gaps, push-outs) and is swept through by nothing; a slab of ground holds 1 m under it and
   not 10 m; the motor walks the sandbox cave (22,600 triangles, 0.23 s to sample and mesh at
   0.75 m) chamber to chamber at 0.03 ms and 26 triangle tests a step, never in the mesh, with or
   without the field as its inside test; and down the crypt's stair, never pushed up to the surface.
   `src/world/dungeons/surfaceNets.ts` meshes a field; `collision.html?preset=cave` / `crypt`.
2. **Layouts.** The style and part pack kinds and their checks, `rules/dungeons.json5`, the
   generator, the crypt's parts as plain boxes, its stairs (straight, turning, spiral); the
   clearance check (6 m everywhere) and the cover check (nothing near the surface), diving first;
   the workbench line-up with the ground's line drawn over a side view; a probe that generates a
   thousand seeds on the real terrain and checks every rule. *Done*: `src/world/dungeons/`
   (`dungeonDefs.ts`, `kitShapes.ts`, `clearance.ts`, `layout.ts`), the crypt style and its nine
   parts in the core pack, `dungeons.html`, the sandbox's dungeon scene, and
   `scripts/probe/dungeons.mjs`: a thousand layouts on the real terrain, all 424,738 checks good
   (cover, overlaps, joins, sockets closed, reachable, boss, lock and key, the same from the same
   seed, 6 m everywhere in fifty assembled ones), eleven walked from the door to the boss on the
   character motor. Numbers under [The generator](#the-generator).
   *Then loops*: routed between far-apart ends with corridors, corners and flights sized to fit;
   parts kept apart by their boxes in the layout's frame. A thousand layouts again: 850,904 checks
   good, each loop a real way round of at least four joins; loops in half the lairs and nine
   dungeons in ten; 0.6% minimal.
3. **The crypt.** Its parts built (ModelBuilder recipes and materials, colliders, transition
   pieces, caps), torches as fixtures, the lightmap bake per part; as a space of its own entered by
   a debug command; walked end to end.
   *So far*: `kitMesh.ts` draws a part from its own colliders - every side of every solid cut as
   convex pieces wherever another solid lies just in front of it, only pieces with open space in
   front kept (a pillar through four laps of a spiral is seen only between them), painted by what
   its solid is (a step's every face dressed stone, a floor's top flagstones, a vault's underside
   rubble, anything else coursed stone), round walls and pillars textured round them. Wall torches
   (`props/wallTorch.json5`) at the parts' light spots, 80% lit; each part's light baked in the
   light-bake workers (a crypt: about 1 M texels, 4-9 s across two workers, cached). The spiral:
   its first turn's vault raised to the top landing's - an open stairwell, a railing to jump over
   where the landing stops - and a wall past the bottom landing. Doorways ([Doorways](#doorways)).
   Underground the sun and sky fade out (`World.setUnderground`), rain stops, fog goes dark; the
   torches light the player. The game's ground is 3 m deep. `/dungeon [size] [seed] [style]` opens
   one at the nearest crypt or hillside and puts the player at the foot of its entrance; `/dungeon
   leave`. Workbench: `dungeonParts` (one part, lit) and `dungeonStyles` (a whole generated
   dungeon, as a cutaway plan), with an Underground light. Open: the server keeps a dungeon in its
   dimension's own collision world (not one of its own); the client draws it in the same scene,
   the world above not drawn over it only because rock is in the way.
   *Set dressing* (the user judging each in the workbench; GEOMETRY.md's method): trims (plinth,
   cornice, ribs on pilasters, copings), loculi and arcosolia, tombs, stone benches and ledger
   stones (colliders, placed when a part is read); candles (lit wax glowing) on benches, ledgers and
   at tombs' heads, urns in open loculi and on benches; breaches in the walls and fallen vaults,
   each with a heap of rubble under it. *Vaults*: a part with a `barrel` (rooms, corridors,
   galleries; not those with piers, nor the L and T halls) is drawn in the style's `barrels` share
   with a barrel vault springing at its flat vault's height - a half circle where it rises half its
   width, else a basket-handle arch (`src/world/architecture/vaults.ts`) - its arches following it
   round onto pilasters, a beam over an alcove opening under it; drawn only, it collides as its flat
   vault, and its bounds reach over it. A straight flight's vault is one sloping slab, its cornice
   sloping with it. Large rooms hang chandeliers on chains from their vaults' middles; the boss
   halls have an altar against the far wall (a collider; tombs, niches and heaps keep clear of it).
   Not yet: carved symbols, roots; none of this walked in a whole dungeon in the game.
4. **The cave.** The field builder: shapes (the helix descent among them), the worker, chunks, the mesh collider; the cave
   materials (triplanar, layer weights per vertex, floor to wall to ceiling); fungi as fixtures and
   the per-part, per-vertex bake; the crypt-to-cave transition part; as a space first.
5. **Entrances.** `caveMouth`, the crypt building's stair, the bandit cave; seamless lairs under
   the terrain (cuts, depth, streaming); large dungeons through the loading screen; walking in and
   out of both.
6. **Inside.** Spawn points, the graph steering, the boss, chests and loot tables, one locked door
   and its key, the world delta.
   *So far*: spawn points (`src/sim/creatures/dungeonSpawns.ts`) at the parts' `spawns` spots, given to
   the creature system when a dungeon opens: the style's `creatures` - for the crypt the restless
   dead, grave robbers and spiders, two of the three in each crypt (the user's call) - a group a
   spot, at the zone's level over the mouth and a level up every 8 parts in; at the boss's spot the
   strongest of them, named, 2 levels up. Bodies are put on the spot's floor; creatures find their
   way by NAVIGATION.md's dungeon graph. The undead are humanoids tinted bone-pale until they have
   bodies of their own. The workbench labels a part's spots (spawns, boss, chest, quest).
7. **Around it.** Dungeons' quest blocks and a plot that uses one, the map's floors, music and
   ambience, the player's own light, daylight through the mouth.
8. **Wrap up.** COLLISION.md, GAMEPLAY.md, MAP.md, the packs README; as built.

Later, each its own step: traps, levers, secret rooms and simple puzzles; more styles (mine, ruin
cellars, sewer, lair of a beast); per-party copies of large dungeons; dungeons in the headless
server's own worker; the torches' and candles' flames as particles (src/particles) in place of the
crossed slivers the props draw now.

## Done means

A cave style and a crypt style generated from pack data, entered from the surface (a lair seamless,
a large dungeon through the loading screen), fully walkable with collision, lit, with creatures, a
boss and a chest, a quest objective inside, cleared state kept in the world delta - and DUNGEONS.md,
COLLISION.md and GAMEPLAY.md updated.
