# Interiors

The plan for walking into buildings. Worked through in phases, the inn (a tavern) first. Furniture
and interior lighting come after it, as a step of their own.

## Principles

- **Most buildings stay shut.** A building without an `interior` block is not enterable: its doors
  are closed, and nothing is built behind its walls. Interiors are for the few buildings worth going
  into - inns, chapels, halls, the odd shop.
- **Never fill a whole building.** The interior generator lays out the rooms its program asks for,
  and stops. Whatever is left is unbuilt space, sealed off behind plain walls or fake doors. A big
  building may be open in only a few of its rooms.
- **Whole storeys.** Every floor lies on a storey line of the outside. A room's height is a whole
  number of levels: one, two or more - never a fraction. A tall room is open through the levels it
  spans.
- **Static openings.** Windows are opaque, inside and out. Doors are open or fake; none of them
  move. A shut door is always a fake one, with nothing behind it - a door into a room stands open,
  a real hole through the wall.
- **The outside decides the shell.** The interior is laid inside the masses, storeys and roof the
  house plan built, and fits the openings already on the walls: every outer window and door lands on
  a room's wall or on sealed space.
- **The same scale as the outside** (about twice life size). Buildings with interiors are sized by
  their authors to fit their rooms, stairs included.
- **Same seed, same building.** The interior is built from the building's seed and variant, so it
  always matches the outside, whenever it is built.

## Model

- **Levels**: the house's cellars, its storeys, and an attic under the roof (its ceiling the slope).
- **Cell**: one tile on one level - the unit everything is placed in.
- **Room**: a set of cells - a box of tiles, one or more levels tall, open through all of them. It
  has a room type, which gives it its styles: floor, ceiling, walls, inner doors, window insides,
  stair. Styles are constant within a room (later features may override them per cell).
- **Stair**: rises one level against a wall inside a room, or in a stair cell of its own, and ends
  on a **landing** at the next floor - its top step, or a **gallery** along one or more walls of a
  tall room.
- **Door**: on a face between two cells at one level - between rooms, between a room and a landing
  or gallery, or out of the building (an **exit**). Open, or fake (shut, into unbuilt space).
- **Trapdoor**: a stair through a floor, where there is no wall to rise against - the way into a
  cellar.

The section the user drew, as the model sees it: a taproom two levels tall at the entrance; beside
it a kitchen on the ground level and a guest room stacked on it; a stair along the taproom's wall up
to a landing at the upper level, and an open door from the landing into the guest room.

## The room program

A building's `interior` names a generator (`type`), its settings under the generator's name - as a
house's `plan` does. The first, `rooms`, takes a list of rooms with requirements, placed in priority
order; each is tried with its chance, and one that does not fit is left out, the rooms after it laid
without it:

```json5
interior: {
  type: "rooms",
  rooms: {
    exits: [1, 2],                    // doors out: the front one, and maybe a back or side one
    rooms: [
      { room: "taproom", priority: 10, levels: [2, 2], tiles: [6, 9], at: "entrance", stair: true },
      { room: "kitchen", priority: 8, tiles: [3, 4], next: "taproom" },
      { room: "guestRoom", priority: 6, count: [2, 4], level: "upper", tiles: [2, 4] },
      { room: "cellar", priority: 4, chance: 0.8, level: "cellar", tiles: [3, 8], under: "taproom" },
      { room: "store", priority: 2, chance: 0.5, tiles: [2, 3], next: "kitchen" },
    ],
  },
},
```

Requirements, all optional:

- `count`, `chance` - how many, and how likely each is.
- `levels` - how many levels tall; `level` - which kind it starts on (`cellar`, `ground`, `upper`).
- `tiles` - its floor area, in tiles.
- `at: "entrance"` - behind the front door (`near: "entrance"`: there if it can be); `next`,
  `under`, `over` - beside, below or above another room.
- `stair` - the stairs up go in it: only such a room (and a cellar, for its own way up) holds a
  stair; `windows` - must have an outer wall.

How each room is reached is not asked for: the generator joins them up (see below).

Room types (`rooms/<id>.json5`, a new pack folder) hold the styles: which interior parts make the
floor, ceiling, walls, doors, window insides and stair, and their materials.

## The generator

1. Read the shell: each level's tiles (from the masses), the outer openings, the chimneys, the roof.
2. Place the rooms in priority order, each where its requirements hold, on free cells.
   Then grow them into what is left, a row of tiles at a time, each up to its largest size.
3. Connect them: every room reachable from an exit - by doors, stairs ending on landings or
   galleries, and trapdoors. A room that cannot be reached is taken out again.
4. Place the exits: the front door, and as many more as `exits` asks for, on ground-level walls of
   rooms that are built.
5. Seal the rest: faces between built and unbuilt cells get walls - or, now and then, a fake door.

## Geometry

- Outer walls get a thickness; inner walls are thinner. Open doors and archways are cut through.
- Floors and ceilings per room: flat, or the roof's slope in the attic.
- Window insides: opaque panels or shutters in the outer window's place.
- Stairs, landings, galleries and their railings, trapdoors.
- A mesh of its own, built only near the camera, never part of the far detail level.

## Status

All five phases are in (see the README's "Interiors" for the content side): the inn, the chapel
and the town hall have interiors. Not yet: the attic as a level, hearths against chimneys, per-cell
style overrides, and a camera that keeps out of the walls (it only closes in indoors).

## Phases

1. **Layout as data.** Cells, the room program, rooms, stairs, landings, doors and exits as a plain
   result, checked by probe; a plan view and a section view in the workbench.
2. **Shell.** Wall thickness, inner walls, floors and ceilings, holes for open doors.
3. **Vertical.** Stairs, landings, galleries, railings, trapdoors, the attic.
4. **Styles.** Room types and interior parts in content; per-room styles.
5. **In the world.** Interiors built near the camera; the camera walks in.

The inn first - a taproom, a kitchen, guest rooms upstairs, a cellar - then the chapel (one tall
nave) and the town hall (a hall over the arcade).

## Later

- Furniture, and the light that comes with it (hearths, lamps).
- Per-cell style overrides.
- Rooms that are not boxes.
- Outside cellar doors.
