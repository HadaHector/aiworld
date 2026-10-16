# Dimensions

The plan for step 2 of [GAMEPLAY.md](GAMEPLAY.md)'s build order. A *dimension* is one whole
generated world - a continent, an island chain, later an underworld or a dungeon - with its own
seed, size and biomes, centred on its own origin. The server can hold several at once, a player is
in one at a time, and moving between them goes through a loading screen. The multi-continent
layout inside one world goes away: one world is one landmass, normally within about 32 × 32 km
(at most 128 km, with a warning past 32).

**Status: done** (steps 1-6 below). Where the build differs from the plan, it says so where it
comes up; [As built](#as-built) has what was learned on the way.

## Decisions

| Question | Decision |
|---|---|
| Which dimensions run | Only those with players in them. A dimension is generated when the first player arrives and dropped when the last one leaves. What must outlive that (cleared camps, looted chests) is the saved delta's job, later |
| How one is defined | A new pack kind, `dimensions/<id>.json5`: game content like biomes. A world config picks which dimensions it runs, as it picks biomes |
| Dungeons and interiors | Interiors stay inside the world, as now. Dungeons will be dimensions later: small places that are not a landmass. Nothing is built for them now, but nothing assumes every dimension is terrain (see [Later](#later)) |
| Links | Data only in this step: a dimension lists where its portals or docks stand and where they come out. Travelling is a debug command. Portals and ships as things in the world come with entities (step 3) |

## Principles

- **A dimension is a world, not a region of one.** Its own seed, its own content (which biomes,
  hence which materials, trees and settlements), its own origin at 0, 0. Nothing in one dimension
  knows another's coordinates. Positions never need more than 32-bit precision to be drawn.
- **Defined by content, filtered by config.** As with biomes: packs say what dimensions exist, a
  world config says which of them a run uses and can shrink them all (CONFIG.md's test worlds).
- **The start dimension is the world we have.** With the default config, the start dimension is
  generated from the same seed and the same content as today's world, and hashes the same. Removing
  the continent ring changes no generated thing.
- **Joining is travelling.** A client that joins is sent to its first dimension by the same message
  that later moves it between dimensions, so the page has one path - load a dimension behind the
  loading screen - for the first load and every later one. The teardown is then exercised on every
  start, not only by the rare debug switch.
- **The server is the authority on where a player is**, dimension included. The client asks to
  travel (debug); the server decides and tells it where it now is.
- **Nothing generated is sent**, as before. A transfer names the dimension and its seed; the client
  generates it from its own packs.

## One landmass per world

What goes:

| Where | What |
|---|---|
| `cells/continentLayout.ts` | `planWorld`'s ring: the continent count roll, the ring radius and its jitter, `ContinentPlan[]`. Becomes `cells/worldLayout.ts`: `planWorld(seed, shape)` → `{ landSeed, areaCount, cellCount, radius, worldExtent }`, one landmass at 0, 0 |
| `cells/config.ts` | `CONTINENT_OCEAN_GAP`, `CONTINENT_COUNT_SALT`, `CONTINENT_LAYOUT_SALT`. `AREAS_PER_CONTINENT_SALT` and `CONTINENT_SEED_BASE` stay as `AREA_COUNT_SALT` and `LAND_SEED_SALT`, with the same values, so the landmass's seed and zone count roll exactly as continent 0's did |
| `cells/areaField.ts` | The loop over continents: one landmass, area ids from 0, `continents` out of `AreaWorld` |
| `cells/riverGeneration.ts` | `generateRiversForContinent` → `generateRivers`, `continentCells` → `landmassCells` |
| `terrain/terrainSampler.ts`, `worldData.ts`, `world.ts` | `continents` passed along: removed |
| `content/worldConfig.ts` | `WorldShape.continents` removed; `areasPerContinent` → `areas`, `riversPerContinent` → `rivers` |
| `public/configs/*.json5` | The renamed keys. An old key is a content error naming the new one |
| `debug/debugMap.ts` | Three views (World, Continent, Zone) become two: *World* (the old Continent framing, centred on 0) and *Zone* |
| `scripts/probe/extent.local.mjs`, comments in `roads/`, `settlements/`, `rivers/` | Updated |

**The size bound** is checked, not hoped for. `planWorld` throws a content error if the largest
`areas` a shape allows would make the world wider than `MAX_WORLD_EXTENT` (128 km), and logs a
warning when a rolled world is actually wider than `WORLD_EXTENT_WARNING` (32 km). Beyond about
32 km, the edges start to lose the 1-2 mm accuracy GAMEPLAY.md accepts. The default's 20-30 zones
make about 29 km. The warning starts at about 35 zones, the error at about 570.

Checked with `scripts/probe/worldHash.local.mjs`: the default world's layout and chunks hash the
same before and after.

## Defining a dimension

`packs/<pack>/dimensions/<id>.json5`:

```json5
{
  name: "The Sunward Isles",
  // Where a player arrives when nothing else says (a debug travel, a first join). Default [0, 0].
  spawn: [0, 0],
  // How big it is - any field left out is the full game's (DEFAULT_WORLD_SHAPE).
  world: { areas: [6, 8], rivers: [1, 2], riverLength: [5, 7] },
  // Which biomes its zones roll from: a whitelist (`only`) or a blacklist (`except`), not both.
  // Left out, every biome.
  biomes: { only: ["palmGrove", "savanna", "redBush", "maquis", "desert", "saltFlat"] },
  // or: biomes: { except: ["icePeaks", "polarDesert", "frozenBog"] },
  // Ways out: where each stands here, and where it comes out in the other dimension.
  links: [
    { id: "ferry", to: "mainland", at: [900, -300], arrive: [-2400, 5100] },
  ],
  // Entities standing here from the moment it loads (added in step 3, see ENTITIES.md); facing in
  // degrees. Templates are checked against the game rules.
  entities: [
    { template: "trainingDummy", at: [4, 5], facing: 200 },
  ],
}
```

- **One is the start**: `start: true`. Exactly one kept dimension must have it - or, if only one is
  kept, that one is the start. A pack set with no `dimensions` folder at all gets one implicit
  dimension, `main`, with the defaults: a mod that only adds biomes still makes a world.
- **The core pack gets two**: `mainland` (the start: the full game's size and every biome, so it
  is today's world) and `isles` (a few warm zones, small enough to load in a few seconds), linked
  both ways.
- **Seeds**: the start dimension uses the world seed as is - that is what keeps today's world.
  Every other dimension uses `deriveSeed(worldSeed, hash(id))`, so its world depends on its id and
  not on how many dimensions there are or in what order they load.
- **Links are checked**: `to` must be a kept dimension; `at` and `arrive` must lie inside the
  worlds' extents. Nothing in the world is placed at `at` yet; the debug map marks it.
- `dimensions` is a root kind (see CONFIG.md): a config's `only.dimensions` picks among them.

### Content per dimension

Each dimension has its own `WorldContent`, resolved from the same packs:

- **Biomes** are the dimension's `biomes` list applied to every biome there is: `only` keeps just
  the ones it names, `except` keeps all but those. Each id must name a biome, or it is a content
  error, as in a config's whitelist. The result is then filtered by the config's `only.biomes`. If that leaves
  none (a test config's single meadow against the isles' warm biomes), the dimension uses the
  config's biomes instead - test worlds are their own worlds anyway (CONFIG.md).
- **World size** is the dimension's `world`, with any field the config's `world` sets put over it.
  `small` and `tiny` therefore make every dimension small.
- Everything else is kept when used, exactly as now. `resolveContent(packs, config, dimension)`
  does the pruning; `content.dimension` says which one it is, as `content.config` names the config.
- The workbench resolves with `ALL_DIMENSIONS`: every biome a config keeps, as now.
- A link to a dimension the config leaves out is dropped, not an error: `small` with
  `only.dimensions: ["isles"]` is a world of its own.

## The server

`src/sim/server.ts` today is one world's collision and players. It is split:

| File | What |
|---|---|
| `sim/dimension.ts` | `createDimension(id, world, shared)`: one world's collision, its collision streamer, its buildings and the bodies in it. What `createServer` is today, minus connections |
| `sim/server.ts` | Connections, players, which dimension each is in, travel, snapshots. Holds `Map<id, Dimension>` |

```ts
createServer({
  seed,                       // the world seed: the start dimension's, the root of the others'
  dimensions,                 // every kept definition (ids, names, spawns, links)
  start,                      // the start dimension's id
  packs,                      // told to clients, as now
  loadDimension: (definition, seed) => Promise<DimensionWorld>,
})
// DimensionWorld = { world: WorldData, treeHulls?, buildingModels? }
```

- **The host provides worlds.** `loadDimension` is the host's: in Node it resolves the content for
  that dimension from disk and generates it; in the page it waits for the page's own build of that
  dimension and hands that over, as single player does today, so nothing is generated twice.
- **Loaded when the first player arrives, dropped when the last leaves.** A player in transit holds
  the target dimension open. Generating the full-size world blocks a Node server's tick for about
  10 s; moving generation into a worker is left for when a real co-op server needs it.
- **A player is in one dimension.** Its body lives in that dimension's collision world. Snapshots
  carry only the players in the receiver's dimension.

## Messages

`PROTOCOL_VERSION` goes to 3.

Client to server, new or changed:

```ts
{ type: "hello", protocol, name, dimension }   // dimension: debug, where to start; "" for the server's choice
{ type: "travel", dimension }                  // debug: go there (by a link if one leads there, else to its spawn)
{ type: "arrived" }                            // the client has built the dimension it was sent to
```

Server to client, new or changed:

```ts
{ type: "welcome", protocol, playerId, config, packs }          // seed moves to Transfer
{ type: "transfer", dimension, seed, x, z }                     // you are now in this dimension, at x, z
```

The flow, for joining and travelling alike:

1. The server takes the player out of its dimension (if any; dropping the dimension if that was its
   last player), sends `transfer`, and starts `loadDimension` for the target.
2. The client puts up the loading screen, tears down the old scene, loads the dimension's content,
   generates and builds it, then sends `arrived`.
3. When both the world is loaded and the client has arrived, the server puts the body at `x, z` on
   the ground and starts sending it snapshots again. Until then the player has no body, so nothing
   falls through unloaded ground while the client is busy.

All new messages are flat records, as SIMULATION.md's encoding requires (`dimension` a short string,
`seed` a u32, `x`/`z` f64).

## The client

`main.ts` today builds one world and lives with it. It is split into what lasts the whole page and
what belongs to one dimension:

| Lasts the page (`main.ts`) | Per dimension (`game/dimensionView.ts`, new) |
|---|---|
| Engine, canvas, render loop, resize | Babylon `Scene` - a new one per dimension |
| The loading screen (gains `show()`) | Content for the dimension, `WorldData`, `createWorld` and its worker pools |
| The local server and channel, intents, `command()` | Character, third-person and spectator cameras, camera collision, player lights |
| Music (fed the dimension's biomes and buildings), zone label, position panel | Debug map, place labels, texture browser, stats and collision panels, settings panel |
| Key bindings, right-click teleport (routed to the current view) | Last view (per config *and* dimension) |
| `__aiworld` (its `world`, `scene`, `camera`... point at the current view) | |

The settings panel is rebuilt per dimension, but what it was set to (draw distance, the toggles, the
hour) carries over.

- **Teardown** is `view.dispose()`: `scene.dispose()` (every mesh, material, texture and observer
  in it), then what lives outside the scene - `world.dispose()` (new: the chunk build, light bake
  and texture bake pools' workers, timers), the debug panels' DOM and listeners. A panel that is
  page-wide by nature (stats, music control) stays and is pointed at the new scene.
- **Checked for leaks**: travels back and forth under `small`, with WeakRefs on the old view, world,
  scene and character, and memory pressure to make the collector run. The old world goes; the
  texture count and the page's DOM stay the same; the heap stays at about 2 GB however often one
  travels.

## Debug travel

| Where | How |
|---|---|
| The game | Settings panel: a *Dimension* select; `__aiworld.travel("isles")`; `?dimension=isles` to start there |
| The debug map | Each link's `at` marked; clicking one travels by it |
| `npm run server` | `--dimension isles`: the bot starts there. `--travel 300`: the bot travels to the next dimension every 300 ticks. The line a second lists the loaded dimensions and who is in each |
| Console | `__aiworld.dimension` is the one drawn; `await __aiworld.travel("isles")` resolves once it is |
| Probes | `loadContent({ config, dimension })` |

## Steps

Each leaves the game working: dev server, `npm run probe`, `npm run server`, `npm run build`.

1. **One landmass.** Remove the continent ring and the `continents` field everywhere; rename the
   world shape's keys; the 128 km limit and the 32 km warning; debug map views. Default world hashes the same.
2. **The `dimensions` pack kind.** Reading and checking, per-dimension resolving, `only.dimensions`,
   seeds; `mainland` and `isles` in the core pack. The game still loads only the start dimension.
3. **The server holds dimensions.** `sim/dimension.ts`; protocol 3 with `transfer`, `arrived` and
   `travel`; `loadDimension` in Node and in the page; joining goes through `transfer`. Headless:
   `--dimension`, `--travel`.
4. **The client rebuilds.** `game/dimensionView.ts`, `world.dispose()`, disposable panels, the
   loading screen's `show()`; the first load goes through the same path.
5. **Debug travel in the game** - the select, `__aiworld.travel`, `?dimension=`, link markers on
   the map, last view per dimension - and the leak check.
6. **Wrap up.** CONFIG.md, SIMULATION.md and `public/packs/README.md` updated; GAMEPLAY.md's step 2
   marked done.

## As built

- **A dimension is generated twice in the page and once in Node**, as the start world was: the
  page builds it to draw it and hands the server its build, so in single player nothing is
  generated twice. `npm run server` generates on its own, blocking its tick: `small`'s isles take
  about 2 s.
- **Textures are baked per dimension.** The texture cache is keyed by seed, so a dimension's
  first visit bakes its materials (16 s for the isles in a background tab); later visits are cached.
- **Waiting for a paint in a background tab leaks until the tab is shown.** Frame callbacks stay
  queued while a tab is hidden, and the inline "two frames or 60 ms" promise kept its whole
  enclosing function's scope - a torn-down world - alive with them. All such waits now go through
  `world.ts`'s `nextPaint`. Teardown is in a plain function (`leave`), not inside the async
  `enter`, for the same reason. Babylon also disposes effects at the end of the next frame, so in a
  hidden tab an empty disposed `Scene` object stays until a frame is drawn; it holds nothing large.
- **The full-size world is at the edge of the in-app browser's memory.** Loaded on its own its JS
  heap reached about 4.8 GB, over Chrome's reported 4.4 GB limit. Travelling from the isles to the
  full mainland crashed the in-app browser pane twice (once with the pane hidden, once shown). A
  fresh full load then crashed too, with the old code from a baseline worktree as well as the new.
  But by then the pane had already crashed and was drawing 1-2 frames a second even with nothing
  rendering, so it is not settled whether the full world alone is over the limit or the pane was
  worn out. Under `small` every combination travels cleanly; the full mainland to the isles works.

## Later

- **Dungeons as dimensions.** A dimension definition will gain a `generator` field; today every
  dimension is a landmass, so the field is left out until a second kind exists. The server and the
  client already deal in "a dimension's world" rather than "the terrain", so a dungeon generator
  that makes its own collision and its own scene fits beside them. Instanced dungeons (one copy per
  party) would be several loaded copies of one definition, keyed by instance.
- **Portals, docks and ships** as entities standing at a link's `at`, using it when walked into or
  boarded (step 3 onwards).
- **The saved delta per dimension** (GAMEPLAY.md, *World delta*), keyed by dimension id.
- **Generating in a worker** on a dedicated server, so one player's travel does not stall the rest.
- **A character's dimension** saved with its position, replacing `hello`'s debug field.
- **The full world's memory** (see [As built](#as-built)): about 4.8 GB of heap is what blocks
  travelling into it reliably. The stats panel's *Memory* section (`debug/memoryPanel.ts`, or
  `__aiworld.memory()` in the console) shows where it goes: the JS heap, the GPU by texture and mesh
  family, and the big CPU buffers by what made them - every one with `?memory` in the URL.
