# Furniture

The plan for furnishing interiors - and, since a piece of furniture is a prop, for setting the same
pieces down outdoors (a bench by a door, a lantern on a post, a barrel in a yard). Worked through in
phases after it is agreed.

## Principles

- **Furniture is props.** Every piece is a prop (`props/`, a generator and its settings), built by
  the same shapes (`propShapes.ts`), placeable by a compound outdoors as much as by a room indoors.
  Nothing about a chair knows it is inside.
- **Rooms ask, a placer decides.** A room type lists what it is furnished with; the placer sets
  pieces down where they fit, in priority order, and leaves out what does not - as the interior
  generator does rooms. Never a full room: enough that it reads as lived in.
- **Multi-tile, four turns.** A piece covers as much floor as it measures - a stool a corner of a
  tile, a bed more than one tile, a bar along a whole wall - and stands turned to any of the four
  directions. It is placed on a grid finer than the tile (see the placer).
- **The way through stays clear.** Every door, stair foot and landing can be walked to from every
  other, and nothing stands in a doorway, on a stair or before a window.
- **The same scale** (about twice life size), **the same seed, the same room** - built from the
  building's seed, so it is the same whenever it is built.
- **Low poly, near only.** Furniture is part of the interior: built near the camera only, never in
  the far model, with collision for what is in the way.

## Style

Thick, crude parts at oversized dimensions, to sit with the oversized buildings: legs as thick as
posts, tops and seats as slabs, boards as planks, iron bands as straps, nothing turned fine or
carved thin. A chair's seat stands at about a metre, a table's top at about 1.6 m, a door of a
wardrobe is a plank door. Few parts, each chunky - it reads from across a room and keeps the
polygon count low. Many parts slightly tapered (`taper` on a box or a beam: a leg slimming to its
foot, a handle to its end, a cheek of stone leaning in) - the same eight corners, so the same count,
but shaped rather than sawn square. Not where a piece lies flat on its face or against a wall.
And `bevel` (metres) where an edge is handled or dressed - a top, a seat, a lid, a post, a cushion's
roll, a dressed stone: one face across each edge and a triangle at each corner, 26 faces for 6. Styles differ in what they are made of and how rough they are (split logs in a
camp, sawn and pegged boards in an inn, stone in a chapel), not in fine detail.

## Pieces

Each a generator of its own, rolled per variant, most with a few styles (a `style` setting) so a
camp's chair is not an inn's:

| Piece | Generator | What it is | Mount |
|---|---|---|---|
| Table | `table` | Top on four legs (or trestles), long or square, `length` rolled | floor |
| Chair | `chair` | Seat, legs, a back of slats or rails | floor |
| Armchair | `armchair` | A deep seat, arms, a high back, a cushion (cloth) | floor |
| Stool | `stool` | Round or square seat on three or four legs | floor |
| Bench | `bench` | A long seat on legs or trestles | floor |
| Bed | `bed` | Frame, head and foot boards, mattress and blanket (cloth), a pillow | floor, against a wall |
| Wardrobe | `cabinet` | A tall cupboard, two doors, a cornice | floor, against a wall |
| Chest | `chest` | A box with a lid, iron bands, a lock | floor |
| Crate, barrel | (exist) | | floor |
| Sack | `sack` | A lumpy turned bag, tied at the top, leaning | floor |
| Bar | `counter` | A counter: front panel, top, a shelf behind; its `length` in tiles | floor, against a wall or free |
| Fireplace | `fireplace` | Stone hearth, cheeks and lintel, a mantel; flat back | wall (the chimney's) |
| Stove | `stove` | An iron box on feet, a door, a pipe up | floor, near a wall |
| Lantern | `lantern` | A frame of iron with glass panes, a ring; standing, or hung | floor, table, ceiling |
| Altar | `altar` | A stone or wooden block, a cloth over it, candlesticks | floor, against a wall |
| Wall lamp / candle | `sconce` | A bracket off the wall, a candle or a lamp on it | wall |
| Banner | `banner` | Cloth on a pole, hanging flat against the wall, a fringe | wall |
| Tool rack | `rack` | A board on the wall, pegs, tools hung on it (axe, saw, rake) | wall |

New building materials: `cloth` (woven, for blankets, cushions, banners - tinted per piece),
`iron` (a dark worn metal); stone and wood as the buildings have them.

Lights are drawn lit - a flame, a glowing pane - but cast no light of their own yet: interior
lighting is a step after this one.

## Mounting

A prop declares how it is set down - `mount`:

- `floor`: stands on the floor (or the ground) - the default; `against: "wall"` keeps its back to a
  wall (a bed's head, a wardrobe), else it may stand free;
- `wall`: hangs on a wall face at a height (`at`, metres up), its back flat on the wall - only where
  that stretch of wall has no door, window or stair;
- `ceiling`: hangs from the ceiling or a beam, a chain's length down;
- `on`: stands on another piece's top (a lantern on a table) - as group members already do.

Outdoors, `floor` props are what compounds place now; a `wall` prop outdoors goes on a building's
outer wall (a lamp by a door, a tool rack on a shed) - later, once the indoor placer works.

## The placer

Per room, from the interior layout (`interiorLayout.ts`), after the geometry:

1. **The grid.** Each tile of the room's floor split into `SLOTS` x `SLOTS` slots (4: about 0.7 m
   at the houses' 2.6-3.4 m tiles). Each slot free or taken; each wall slot-edge plain, or a door,
   window or stair.
2. **Reserved first:** a doorway's swing (two slots deep before each door), the stair's tiles and
   its foot, a landing's, a gallery's edge, the slots before each window (low pieces may stand under
   it - a bench, a chest - not tall ones).
3. **Pieces in order:** the room type's `furnish` list, highest priority first - each rolled
   (`count`, `chance`), measured (`measureProp`: its half width and depth, rounded up to slots - a
   piece spans as many slots and tiles as it needs), then tried at every free spot and each of the
   four turns its `mount` allows, scored by where it asks to be (`at`):
   - `wall` - back against a plain wall; `corner` - into a corner; `centre` - in the open, away
     from the walls; `hearth` - against the chimney's wall; `window` - under a window; `door` - by
     the door, not in its way; `facing: <piece>` - turned toward an earlier one (chairs to a table);
   - and placed where it scores best, its slots taken. A piece that fits nowhere is left out.
4. **The way kept clear:** after each piece, every door, stair foot and landing must still reach
   every other through free slots (a flood fill on the slot grid); a piece that would cut them off
   is tried elsewhere, then left out.
5. **Groups** set down as one: a table and its chairs, a bed and a chest at its foot - a group's
   members are a list of transforms (as now), its footprint the union of theirs, placed and turned
   as one piece.

```json5
// rooms/taproom.json5
furnish: [
  { prop: "counter", at: "wall", priority: 10, settings: { length: [2, 3] } },
  { prop: "fireplace", at: "hearth", priority: 9 },
  { group: "tableWithChairs", count: [2, 4], at: "centre", priority: 6 },
  { prop: "barrel", count: [1, 3], at: "corner", priority: 4 },
  { prop: "sconce", count: [2, 4], at: "wall", priority: 2 },
],
```

## In the world

- The furniture's models are built into the house's interior model (its own builder, the near
  detail only), turned and moved into place - no mesh or draw call of its own per piece.
- Its colliders join the house's: a table and a bed are in the way, a candle is not (`collide`).
- The interior layout gains what the placer needs and the outside already knows: each window's
  place on its wall, and where a hearth room's chimney stands.

## Workbench

- Every new piece previews in the props folder, as the camp's props do (Variant, Detail,
  Colliders).
- A building with an interior gets a **Furnished** view: its plan with each room's slots, what was
  placed and turned where, what was left out and why - and the 3D cutaway with the furniture in.
- Probe: every room's way through clear, nothing overlapping, nothing on a stair or in a doorway,
  every wall piece on a plain wall.

## Status

Phase 1 is in: 17 generators (`src/world/props/generators/furniture.ts`) and 18 props (`props/`:
table, chair, armchair, stool, bench, bed, wardrobe, chest, sack, bar, fireplace, stove, lantern,
hangingLantern, altar, sconce, banner, toolRack), with the crate and barrel there already; the
building materials `cloth`, `iron` and `flame` - a building material's `glow` (0-1) draws it with its
own light, the same in sun and shadow, for flames and lit panes. Each previews in the workbench's
props folder.

Phase 2 is in, and with it most of phase 3: a prop's `mount` (`floor`, `wall` at a rolled height,
`ceiling`), a room type's `furnish` list (a prop or a group, `count`, `chance`, `priority`, `at`), and
the placer (`src/world/buildings/furnish.ts`) - slots a quarter tile across, doors' fronts and stair
feet and landings kept as the way through (checked by a flood fill after each piece), stairs, holes
and stalls no floor, windows letting only what stands below their sill before them; floor pieces
backed onto a wall for `wall`, `corner`, `hearth` (the chimney's wall - the house now records where
each chimney went), `window` and `door`, or anywhere in any of the four turns for `centre` and `any`,
the best-scoring place that keeps the way clear taken; wall pieces on a stretch of wall clear of
doors, windows, stairs and anything standing before it; hung pieces over open floor nearest the
room's middle. Its pieces are built into the house's own model and colliders (ModelBuilder and
ColliderBuilder `append`), near only, from a seed of the layout's own. Groups `diningTable` and
`messTable`; the taproom, kitchen, guest room, cellar, store, mess hall, bunk loft, camp kitchen,
camp store, tool room and nave are furnished; the taproom and the mess hall became hearth rooms.
Probe: `scripts/probe/furnish.local.mjs` (no overlaps, nothing out of its room, on a stair or before
a door). Not yet: the workbench's Furnished plan view, outdoor wall pieces, the town hall's rooms.

## Phases

1. **Pieces.** The generators and their content, `cloth` and `iron`; each checked in the workbench.
2. **The placer.** Slots, reserves, scoring, the clear way, groups; a plan view and the probe.
3. **In the world.** Built into the interior model with its colliders; windows and chimneys passed
   through.
4. **Rooms furnished.** Every room type's `furnish` list - the inn, the chapel, the town hall, the
   camp's buildings.
5. **Outdoors.** Wall props on outer walls; furniture in compounds' prop lists (benches, lanterns).

## Later

- Interior lighting from the lamps, candles and hearths.
- Clutter on tables and shelves (mugs, plates, books) - an `on` pass.
- Rugs and things lying on the floor.
