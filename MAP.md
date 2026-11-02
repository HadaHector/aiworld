# Map

A **minimap** in the HUD and a **world map** window (M), drawn from one tile source and one marker
model. GAMEPLAY.md asks for "a map" with quest and map markers, and roads that guide the
player; QUESTS.md has been drawing its marks on the debug map until this exists.

**Status: done.** Steps 1 to 8, with changes the user asked for along the way: see [As built](#as-built),
which wins where it differs from the plan above it.

## Decisions

Agreed with the user in two question rounds and two rounds of changes to this plan.

| Question | Decision |
|---|---|
| Shape | **Round, north-up.** A bronze ring; the map stays fixed and the player arrow turns. The world map is north-up too, so the two read the same |
| Look | **The real terrain, cleaned up**: the world's own ground colours (biomes, rock, snow, sand, road surfaces) with soft hill shading and flat water; roads and rivers show as they are on the ground |
| Buildings and props | **Projected from above with a cut 8 m over the ground.** Everything set down in the world - houses, compounds' props, walls, fences, bridges, signs, trees, bushes, rocks - is drawn as seen from straight above, but anything higher than 8 m over the ground beneath it is cut away. A tall house shows its walls and rooms rather than its roof, a wood shows its crowns' cross-sections. Drawn from data, so it works at any distance and headless |
| Zoom | **1x to 0.5x of one resolution.** 1x is 1 m to a pixel (first 0.25 m; the user found that too dense once it was in the game), 0.5x is 2 m, changed smoothly by the minimap's buttons or the mouse wheel. On a 180 px ring that is about 90 to 180 m around the player. No zoomed-out levels: a whole-dimension view is the debug map's job |
| Trees under the cut | **Cut like everything else.** Trees stand 25-40 m, so at 8 m most show only their trunks; the user chose that over whole crowns (`treeCut` in map/things.ts can tell them apart) |
| Default markers | **Quests** ("!", "?" and the tracked objectives' areas) **and creatures nearby**. The others (NPC services, places, the home) are kinds a player can turn on |
| Fog of exploration | **None.** Everything is shown from the start; nothing about the map is stored per character except the player's own map settings. GAMEPLAY.md's "map that fills in" is dropped for now (see [Later](#later)) |
| Debug map | **Kept as it is.** It stays the way to see a whole dimension. The world map takes M; the debug map moves to Shift+M and stays on the menu bar's debug entries |
| Travel points | **None.** No travel points and no fast travel; the dimension's links and the home are shown as markers |
| Text under the minimap | **The settlement's name while inside one** (within its radius), else the zone's |

## Principles

- **One source, two views.** The minimap and the world map are the same `MapView` drawing the same
  tiles and the same markers, at different sizes, clips and zooms. Nothing about the map is coded
  twice.
- **Drawn from world data, never from the GPU.** Tiles come from `sampleTerrain`, the material
  library, the road network, the rivers, the settlement and compound layouts and the scatters - all
  pure and deterministic - rasterised by our own small software rasteriser into RGBA bytes. So a
  tile is identical in the browser, in a worker and in a Node probe, and the same seed always gives
  the same bytes.
- **Nothing stutters.** Tiles are built off the main thread, in the chunk workers that already hold
  their own copy of the world. The main thread only draws finished tiles and markers into a canvas,
  and only when something on it changed.
- **Markers are pack data.** What a marker kind looks like, how far it shows, what wins when two
  overlap and whether it points from the edge are in `mapMarkers/`. A game adds kinds without code
  when a source already exists.
- **The server says where gameplay things are.** Quest marks, NPC services, the home and zone levels
  reach the client as messages, as today's `markers` do, so a remote client sees exactly what a
  local one does. The terrain itself is never sent: each side generates it.

## The tiles

### One resolution

The map is drawn at one resolution, **0.25 m to a pixel**, and that is its 1x scale. A view shows it
at any scale from 1x down to 0.5x (0.5 m to a pixel), smoothly, by scaling the tiles as it draws
them: the same picture made smaller, with nothing appearing, disappearing or changing style. There
are no levels and no coarser copies. Seeing the whole dimension at once is not this map's job; the
debug map's way (a coarse sample of the whole world) stays for that, see [The world map](#the-world-map).

A tile is 256 × 256 pixels, so it covers 64 × 64 m. Tile `(tx, tz)` starts at `(tx, tz) × 64` in
world metres. Its key is `map/v<MAP_VERSION>/<world>/<dimension>/<tx>,<tz>`, where `<world>` is the
seed with the hash of the packs and the config (as `WorldRecord.packs` already records), so a pack
change can never show an old tile. `MAP_VERSION` goes up whenever the drawing changes.

### Drawing a tile

In passes, each into the same RGBA buffer:

1. **Ground.** One `sampleTerrain` per pixel (4 µs each, so about 0.3 s for a tile in a worker).
   Land takes its material's colour from `materialLibrary.resolveMaterialIndex` exactly as the debug
   map does - roads' cobbles and tracks, rock, snow, river banks - so roads and rivers are already
   in the ground at this resolution; ocean, lakes and rivers take flat water colours. Hill shading is
   a soft light from the north-west over the height grid, weaker than the debug map's emboss so
   colours stay true.
2. **Things set down, cut at 8 m.** Every building, prop, wall, fence, bridge and sign of the
   settlements, compounds and road cells under the tile, as `createWorldData` places them. Each
   model's triangles are rasterised from above, keeping per pixel the highest surface that is still
   below *ground + cut* (`cut: 8` in `rules/map.json5`). Colour is the vertex tint times the
   material's average colour, lit by the same north-west light through the face's normal. Faces
   that stand upright (walls) have no area from above, so their top edges under the cut are drawn as
   lines at least one pixel wide in the wall's colour: a cut house reads as its plan. The near model
   is used, so rooms and furniture show under a cut roof, unless step 2 finds it too slow.
3. **Trees, bushes and rocks.** The tree, bush and rock scatters for the tile's area, as the chunk
   workers run them. A tree is its crown's cross-section at the cut: a disc whose radius comes from
   its kind's model at that height (measured once per kind and variant), in its area's shade, with a
   darker rim so a wood reads as many trees. A trunk alone shows where the crown starts above the
   cut. Bushes and rocks are discs and blobs in their colours.

Text is never drawn into a tile: names and markers are drawn by the view at the screen's own
resolution.

### Building and caching them

- **In the chunk workers.** `chunkBuild.worker.ts` gains a `mapTile` job. Its world copy already has
  the sampler, the material blender and the scatters; it adds the layouts and models it needs on the
  first map job. Map jobs wait behind chunk jobs, so walking never waits for the map. Where workers
  are not available (a probe), the same function runs in the caller.
- **Ahead of need.** The views ask for the tiles under them plus a ring of one tile around, so
  walking on finds them ready: running at 6 m/s crosses a tile in about 10 s, and a new row of
  tiles costs a worker about a second.
- **Memory.** Finished tiles become `ImageBitmap`s in an LRU of about 120 tiles (about 30 MB),
  counted in the Memory panel.
- **IndexedDB.** Tiles are also written to a `mapTiles` store, by key, as PNG-compressed blobs,
  capped at a few thousand and pruned oldest first, so places walked through before cost nothing
  next time.

## Markers

### Kinds, in packs

`mapMarkers/<id>.json5`:

```json5
// mapMarkers/questGiver.json5
{
  name: "Quests",            // for the legend and the toggles
  icon: "map-quest",         // an icon name (ICONS.md); missing means the glyph below
  glyph: "!", colour: "#f2d64b",
  size: 16,                  // CSS pixels on the map
  priority: 90,              // drawn over lower ones; the winner when a cluster collapses
  minimap: { range: 400, edge: true },   // off the ring but within range (m): an arrow on its edge
  worldMap: true,            // shown on the world map too
  cluster: 12,               // within this many pixels, same-kind markers merge into one with a count
  default: true,             // on until the player turns it off
}
```

The core pack's kinds:

| Kind | Source | Default |
|---|---|---|
| `questAvailable`, `questReady`, `questActive`, `questSoon` | the server's quest marks (yellow "!", yellow "?", grey "?", grey "!") | on |
| `questArea` | the tracked quests' objective areas and `where` (a soft gold circle, not an icon) | on |
| `creatureHostile`, `creatureNeutral` | creatures the client can see (replicated), as dots, minimap only | on |
| `shop`, `trainer`, `inn`, `bank`, `mending` | NPCs' services, from the server (an `npcRoles/` role names its kind with `mapMarker`) | off |
| `settlement`, `feature` | names of places, from world data, world map only | on (world map) |
| `home` | the character's home | off |
| `link` | the dimension's links to other dimensions | off |
| `party` | other players in the party, later | on |

### Drawing them

- **Into the view's canvas**, every time the view redraws: icons from the icon set's atlas (a
  placeholder glyph in the kind's colour where there is none), sorted by priority. Hovering one shows
  a tooltip with its name (the NPC's name and title, the quest's title, the place's name).
- **Clusters.** Same-kind markers closer than `cluster` pixels merge into the highest-priority one
  with a small count.
- **Edge arrows.** A kind with `edge: true` out of the minimap's radius but within `range` is drawn
  as a small arrow on the ring pointing to it - the tracked quest's areas and "?" first.
- **Player arrow** in the centre, turned to the character's facing, with a faint cone for where the
  camera looks.

### Where they come from

- **Quest marks over the whole dimension.** Today the server sends `markers` for NPCs within 90 m.
  A new owner-only `mapMarks` message carries the marks of the quest NPCs the character has
  business with in its dimension (givers in settlements whose casts exist, quest people of active
  quests), sent when they change.
- **Map info** when entering a dimension: `mapInfo` with each zone's level band (CREATURES.md, the
  rings) and the pins of NPC services in settlements whose casts exist, updated as casts are filled
  near players; the home and the dimension's links. Multiplayer needs nothing more: every client
  gets the same messages over a real transport.
- **Client side**: creatures and party members from the entity mirror (replicated, so only what the
  player could see anyway); the tracked quests' areas from the quest mirror; place names from the
  world data the client already generates.

## The minimap

- **Where.** At the top of the HUD's `info` region (top right), above the "Saved" mark and the quest
  tracker, which move down under it. About 180 px across (`minimap.size` in `rules/map.json5`), in
  the HUD's bronze-and-gold ring, drawn at the screen's device pixels.
- **A name plate under the ring** says where the player is: the settlement's name while inside one
  (within its `radius`), else the zone's. It replaces today's zone label in the HUD. The biome and
  weather that label also shows go into the plate's tooltip and stay in the debug panel's position
  readout.
- **Buttons** on the ring: zoom in and out, the world map, and a toggle that folds the minimap to
  its name plate. The mouse wheel over it zooms. Clicking it opens the world map there.
- **What it costs.** It redraws when the player has moved half a pixel, turned, or a marker or tile
  changed - at most 30 times a second - and never otherwise. A redraw is a handful of `drawImage`s
  and markers, aimed at well under 0.3 ms.
- **Settings** (shown, zoom, which kinds are on) are kept with the character's `interface` record
  as the action bar is (FRONTEND.md, *Saves*), so they follow the character.

## The world map

- **M**, and the minimap's button. A large window in the HUD's look over the game, centred on the
  player when it opens.
- **The same tiles, bigger.** The same `MapView` as the minimap, square and filling most of the
  screen, at the same 1x to 0.5x. At 0.5x on a 1000 px window that is 500 m across: a village and
  its fields. Drag to pan anywhere in the dimension (tiles are built as they come into view), the
  wheel to zoom, a button to centre on the player.
- **The zone**: the window's title names the zone in view with its level band ("Holloway Vale,
  3-5"), coloured by its difference from the character's level - QUESTS.md's grey, green, yellow,
  orange and red.
- **Places**: settlements' and named features' names, from world data.
- **A legend** with each kind's icon and name and its own toggle; the world map's toggles are its
  own, apart from the minimap's.
- **Debug**: with the debug panel open, the debug map stays on Shift+M for teleporting, spawn points
  and starts.

## In the code

| File | What |
|---|---|
| `src/map/tiles.ts` (new) | Tile keys, the tile's world rectangle; `buildMapTile(sources, tx, tz)` → RGBA. Pure: no Babylon, no DOM |
| `src/map/raster.ts` (new) | The software rasteriser: pixels, triangles with a height test, lines, discs |
| `src/map/sources.ts` (new) | What a tile is drawn from, gathered from a world (sampler, materials, layouts, scatters) |
| `src/map/markers.ts` (new) | Marker kinds from packs, marker records, clustering, edge arrows. Pure |
| `src/map/tileCache.ts` (new) | The LRU of bitmaps, IndexedDB persistence, requests ahead of need |
| `src/world/terrain/chunkBuild.worker.ts`, `chunkBuildPool.ts` | The `mapTile` job, behind chunk jobs |
| `src/ui/mapView.ts` (new) | Draws tiles and markers for a centre, a scale and a clip (round or square); hover and clicks |
| `src/ui/minimap.ts` (new) | The ring, name plate, buttons, wheel, settings |
| `src/ui/worldMap.ts` (new) | The window: pan, zoom, zone names and tints, place names, legend |
| `src/sim/protocol.ts`, `src/sim/quests/system.ts`, `src/sim/npcs/` | `mapMarks` and `mapInfo` |
| `src/game/session.ts`, `src/game/dimensionView.ts` | Wiring: the views per dimension, M and Shift+M, settings into `interface` |
| `public/packs/core/mapMarkers/` (new), `rules/map.json5` (new), `npcRoles/*` (`mapMarker`) | The kinds, the cut height and zooms |
| `scripts/probe/mapTiles.mjs` (new) | The headless probe |

## Steps

Each leaves the game working: `?play` in the dev server, the probes, `npm run build`.

1. **Ground tiles, headless.** `src/map/tiles.ts` and `raster.ts`, the ground pass only, and the
   probe: a small config, tiles over the starting village; sizes, the same bytes
   twice, distinct keys, sea where the sampler says sea, timing per tile; PNGs written to the
   scratch folder to look at.
2. **Things set down.** The cut-at-8-m projection of buildings and props, trees, bushes and
   rocks. The probe checks building pixels in the village and road
   pixels on its road, and the cost per tile; near models kept only if they are affordable.
3. **Workers and cache.** The `mapTile` job, the bitmap LRU in the Memory panel, IndexedDB, asking
   ahead of need.
4. **The minimap in the HUD.** Ring, name plate (settlement or zone) in place of the zone label, tiles, player arrow,
   zoom, toggle, settings in the character's `interface`. Frame time checked with it open while
   running through the village.
5. **Markers.** `mapMarkers/` and `markers.ts`; quest marks and areas and creature dots on the
   minimap, clusters, edge arrows, tooltips.
6. **Server map data.** `mapMarks` over the dimension and `mapInfo` (zone levels, service pins, home,
   links).
7. **The world map (M).** The window on the same view: pan and zoom, the zone and its level band,
   place names, legend and toggles; the debug map to Shift+M.
8. **Checked in the game, and the docs.** A new character in the starting village: the minimap with
   the village's plan, the reeve's "!", the tracked objective's area and its edge arrow on the road
   to the first creatures, their dots; the world map from the minimap's button; the minimap settings
   kept after logging out and Continue; frame time with both open. GAMEPLAY.md updated.

## As built

All eight steps, each committed on its own. Where this differs from the plan above, this is how it is.

- **One resolution, 1 m a pixel.** `src/map/tiles.ts`: a tile is 256 px, 256 m. `MAP_VERSION` is 2. The
  ground pass blends each pixel's materials exactly as the chunks do (`buildMaterialBlend` with the
  chunks' own vertex context, curvature from a coarse grid round the tile), hill-shades it and draws
  water below sea level flat, darker with depth. About 0.6 s a tile on one thread, most of it the
  sampling and the blend.
- **North is +z.** The world is left-handed: seen from above, +x is right when +z is up. The first
  minimap drew +z down and was mirrored against the 3D view (the user caught it); the view now draws
  tiles upside down rather than changing the tiles.
- **The cut** (`src/map/things.ts`): every placed model's triangles clipped to 8 m over its foot and
  rasterised from above, the highest surface winning; upright faces drawn as their top edge, so cut
  walls read as a plan. The game uses the **far models** - at 1 m a pixel rooms and furniture are
  smaller than a pixel, and far models cost less (the probe can use near ones: `NEAR=1`). Trees,
  bushes and rocks are discs: a crown's width under the cut from its near model's leaves (95% of them,
  so a stray card does not make a crown), a trunk's from the middle of its wood at that height.
- **Colours** are the game's own: the ground's baked averages, building materials' averages (now kept
  by `bakeBuildingTextures`), and `TreeField.mapColors` (bark averages; leaves the middle of a
  kind's tint times a leaf green, since the leaf atlases are baked out of reach).
- **Built in the chunk workers** (`chunkBuild.worker.ts`): `mapColors` and `mapTile` messages; a
  tile is drawn a slice (16 rows) at a time with `setTimeout` between, so a chunk job waits a slice.
  The worker makes its building groups lazily on the first tile, from its own terrain
  (`createWorldData` takes one). Without workers, `World.buildMapTile` draws on the main thread,
  4 ms at a time. `src/map/maker.ts` gathers what a tile is drawn from.
- **Cache** (`src/map/tileCache.ts`): 120 bitmaps in memory; `aiworld-map` in IndexedDB as WebP,
  1500 tiles, oldest pruned; at most two tiles in the making, nearest wanted first. Keyed by the seed
  and a hash of the content's JSON, so a pack change never shows an old tile.
- **No `rules/map.json5`**: the cut (`MAP_CUT`), the ring's size and the zoom range are constants in
  `map/maker.ts`, `ui/minimap.ts` and `ui/mapView.ts`.
- **Marker kinds** (`mapMarkers/`, `src/map/markers.ts`): a kind says which NPCs it stands for with
  `mark` (a quest mark: "!", "?", "!grey", "?grey") or `service` (a role's service: vendor, trainer,
  innkeeper, repair) instead of a `mapMarker` field on roles. An NPC shows its quest kind and its
  highest-priority service kind. Shapes: icon (an icon name, else the glyph), dot, area, label. 15
  core kinds; services, the home and links start off.
- **Server** (`sim/server.ts`, `sim/protocol.ts`, `PROTOCOL_VERSION` 13): `mapPins` twice a second
  when it changed - every NPC within 400 m with its quest mark for the player and its role's services
  (`NpcSystem.servicesOf`), and the home if it is in this dimension; `mapZones` on coming to a
  dimension - each zone's level band. Creatures, the tracked quests' areas (`QuestLog.isTracked`) and
  links come from the client's own mirrors and content.
- **The minimap** (`ui/minimap.ts`, `ui/mapView.ts`, `ui/mapMarkers.ts`): top of the info region
  in place of the zone label, which is gone; the name plate under it (settlement within its radius,
  else the zone; biome and weather in its tooltip) with a fold toggle; zoom buttons, the wheel, an M
  button; redrawn on a move of half a pixel, a turn, a new tile, and ten times a second for moving
  markers. A redraw measured about 0.1 ms.
- **The world map** (`ui/worldMap.ts`): M, the minimap's M button or a click on it, and the menu bar's
  map button; Escape closes it with the other windows. Up to 1100 x 800 px; drag to pan (tiles
  stream in as they come into view), wheel to zoom about the pointer, *Centre* to follow the player
  again. The title is the zone at the middle with its level band, coloured as quests are by its
  lowest level against the character's. Settlements are named (the `settlement` label kind). The
  legend's checkboxes are its own choices. A full redraw measured about 0.5 ms; the frame rate is the
  same with it open or shut.
- **Saved**: the minimap's settings (shown, zoom, kinds) and the world map's choices go into the
  character record's `interface` beside the action bar, a second after the last change. A quick
  (`?play`) game keeps nothing.
- **The debug map** is Shift+M, as before otherwise.
- **Tests**: `npm run probe -- scripts/probe/mapTiles.mjs [outDir] [config]` builds nine tiles over
  the tiny world's starting village and checks their size, the same bytes twice, keys, a water pixel,
  that the village's buildings are drawn, and the marker rules (kinds read from the packs, an
  innkeeper giving a quest, a marker inside the ring, one pinned to its edge, ranges, a kind off by
  default, the drawing order); with `outDir` it writes the tiles as a PNG, and `AT=x,z` centres them
  elsewhere. Checked in the page (`?play&config=tiny`): the village on the minimap with its houses,
  the reeve's and others' "!", creature dots, the services when turned on, the grey "?" over the
  innkeeper after taking the reeve's quest, the world map's pan and zoom and the next village's name.
  **Not checked in the page:** a gather or reach objective's area and its edge arrow (covered by the
  probe's marker rules), and settings kept across logging out of a saved game.

## Later

- **Fog of exploration**, if wanted after all: a per-character, per-dimension bitset of revealed
  cells in the character record, drawn as a mask over the tiles. Nothing in the tile source needs to
  change for it.
- **Party members** on both maps once parties exist (the kind is already defined).
- **Dungeon and interior maps**, from the same rasteriser over a building's rooms.
