# Navigation

How creatures find their way: round houses, fences and trees on the surface, and through crypts and
caves under it. **Status: steps 1-2 done** (the follower, and ways through crypts: [As built](#as-built)); steps 3-7 to come.

## Today

The brain (`src/sim/creatures/brain.ts`) heads straight for its goal - a wander spot, its foe, home -
through the character motor. Nothing steers. A wanderer that meets a wall gives up when its 20 s
run out; a chaser that gets no closer for `stuck` (4 s) evades. Land creatures stop at deep water
(`system.ts`). In open country that is fine and should stay as it is. It fails in three places:

- **Round a building or a fence**: a wolf chasing a player behind a house presses on the wall,
  then evades.
- **In a dungeon**: a crypt is corridors, stairs and spirals; the straight line to a player one
  room on is almost always through rock.
- **Wandering and fleeing** pick spots by `open(x, z)` alone, which says nothing about whether the
  spot can be walked to.

## Principles

- **Straight first.** Most moves are in the open, and a straight line is free. A path is planned
  only when the straight line is blocked - known blocked from nav data, or found blocked by the body.
- **From what exists.** No new authored data. The surface's nav comes from what the sim already
  has (heights, water, trunks, building footprints, fences); a dungeon's from its layout graph and
  its parts' walk lines, which DUNGEONS.md already measures at load ("that graph is reused by
  everything inside: navigation").
- **Pure, deterministic, in the sim.** `src/world/nav` with no Babylon, built from the seed; the
  same query gives the same path on the page's in-page server and the headless one. Ties in a
  search are broken by cell index, never by insertion order or a random number.
- **Lazy and bounded.** Nothing is built for places no creature is planning in. Every search has a
  node budget; the whole tick has a time budget, as the collision streamer has.
- **Fails back to today.** No data yet, budget spent, no path found: the creature walks straight,
  and the existing stuck and leash rules still catch it - only sooner, since "no path" is known.

## One query, two kinds of data

```ts
interface NavQuery {
  /** A path from a point to a point, as waypoints, or null if none within budget. */
  path(dimension: string, from: Vec3, to: Vec3, budget: number): Vec3[] | null;
  /** Whether a body could walk straight from one to the other (a ray along the nav data). */
  straight(dimension: string, from: Vec3, to: Vec3): boolean;
  /** Whether a point can be walked to from another - for wander and flee spots. */
  reachable(dimension: string, from: Vec3, to: Vec3): boolean;
}
```

The query looks where each end is - `dimension.dungeons.at(x, y, z)` - and uses the dungeon's graph
or the surface's tiles. A path from the surface into a seamless dungeon goes to its mouth and on
down the graph; see the open questions for whether creatures may do that at all.

### The surface: lazy grid tiles

Weighed against a navmesh and a waypoint graph:

| | Grid tiles | Navmesh | Waypoint graph |
|---|---|---|---|
| Built from | Cheap point tests the sim already has | Rasterising collision, then regions and polygons (Recast) | Hand-placed or sampled points |
| Cost to build a tile | ~1-3 ms, guess (to measure) | Tens of ms; a big dependency or a lot of code | Cheap, but where do the points come from |
| Small things (trunks, fence posts) | Exact to a cell | Exact | Missed |
| Code | Small | Large | Small, but poor in the open |

**Grid tiles win for the surface**: 32 m tiles of 1 m cells, made when a search first reaches them,
kept in a cache of the most recently used (256 tiles, about 0.8 MB: per cell a height as int16 and a
flags byte). A cell is walkable when:

- its slope is under the motor's steepest ground (52°), from `world.heightAt` at its corners;
- its water is not deep, unless the creature swims (a flag in the cell, read per kind) -
  the same test as `system.ts`;
- `trunks.clear(x, z, radius)` - trees and building footprints, already cheap and collision-free;
- no fence, wall or camp prop stands in it (from the roads' fence segments and the placed
  buildings' colliders, rasterised into the tile when it is made; to check in step 3 what the trunk
  field already covers).

Heights go with the cell, so a step between neighbours over the motor's step height is a wall: a
terrace wall or a cellar's edge stops a path as it stops a body.

**Bridges**: one walkable layer per cell, the highest; the river under a bridge is water, so a land
creature loses nothing. **Houses** are their footprint on the surface's tiles, with a way in at
each outer door; inside, they are a graph of their own ([Houses](#houses)).

The search is A* on 8 neighbours within a window round the two ends (the leash's 60 m, and a
margin), capped at a node budget (4 000 by default, in the rules). The path is pulled taut by the
grid's own `straight` test, so it is a few waypoints, not one per metre.

### Dungeons: the layout graph and walk lines

A dungeon already is a graph: parts as nodes, joined sockets as edges, and every kit part has walk
lines measured at load. So:

- **One graph of walk lines** (as built: finer than the part graph, and enough on its own): every
  placed part's walk lines, cut into 3 m pieces, each line's ends joined to the nearest point of any
  other line within 1.2 m, and lines crossing at a shared point joined there. A stair's flight meets
  its landings, a doorway's short line meets both parts', a hall's two lines meet in its middle.
  Spirals and stairs stacked over each other are no problem, since the graph is in 3D. A* over it.
- **Along a way** (corridor, stair, spiral, connector): follow its walk line. Ways are 6 m wide and
  clear by DUNGEONS.md's own check; nothing to avoid but other bodies.
- **Off the lines** (a spawn spot by a wall, a player in a hall's corner): rays through the dungeon's
  colliders, which are in the dimension's collision world whenever the dungeon is open - at the
  knees either side and the chest, and a floor under the way every 2 m. A body walks straight onto
  the nearest nodes they allow, and off them to its goal. *Planned as room grids per part
  definition; not needed: the rays found a way to every room and from every spawn spot.*
- **Caves** (the field builder) have no per-part colliders, but their shapes are analytic: a
  tunnel's centre line and a chamber's floor give walk lines and a room's disc. Done with the cave
  step of DUNGEONS.md, not before.

Space dungeons (their own dimension) use the same graph; nothing differs.

### Houses

Needed (the user's call, 2026-11-15), built after the rest. A house with rooms is the same shape of
problem as a dungeon, only smaller, and its interior layout (`interiorLayout.ts`) already holds the
graph: `rooms` as nodes, `InnerDoor`s (only the `open` ones) and `Stair`s as edges, the outer doors
as the ways onto the surface's tiles.

- **In a room**: a grid of 0.5 m cells per floor, from the built interior's floors
  (`interiorFloorAt`) and its furniture's colliders, made when the house's collision comes in and
  dropped with it. Rooms are small: a few hundred cells.
- **Doors and stairs**: a waypoint either side of each, and the stair's line between.
- **Who fits**: a doorway narrower than a kind's body is not an edge for it - a boar may follow
  through a farmhouse door, a giant spider may not. The width is read from the door, the body's
  radius from the kind.
- A path that ends in a house plans on the tiles to its door, then on the house's graph.

## Following a path

The brain gains a little:

```ts
interface Brain {
  // ...as now
  /** The waypoints it is following, and the next one; empty when walking straight. */
  path: Vec3[];
  next: number;
  /** When it may next plan: one plan per half second at most. */
  nextPlan: number;
}
```

- `toward(...)` becomes `steer(...)`: to the next waypoint if there is a path, else straight.
- **Plan when**: the goal is not straight-walkable (`straight` false), or the body made no progress
  for a second while walking straight. **Re-plan when** a chased target has moved more than a third
  of the remaining path's length from the path's end, or a waypoint has not been reached in its
  expected time twice over.
- **No path**: the chaser evades at once (`why: "unreachable"`), instead of pressing on the wall for
  4 s. The wanderer picks another spot.
- **Wander and flee spots** must be `reachable` (on the same connected region; a tile keeps a region
  id per cell, flood-filled when made). A fleeing creature picks the reachable spot furthest from
  its foe among a few rolled.
- **Leash** stays measured as the crow flies from the pull: simple, and a long detour is reason
  enough to give up.

## Local steering

Kept small: three things, all in `steer`, none planned.

- **Trees and props in the open**: a short look-ahead (2 m) with `trunks.clear`; if blocked, steer
  to the side with room. Cheap, and stops most "rubbing on a trunk" without a plan.
- **Other creatures**: a separation push from members of its own group within 1.5 m, so a pack does
  not merge into one capsule.
- **Round a melee target**: each chaser takes a slot round its target (a ring at melee reach, a
  slot per attacker by entity id), so a pack surrounds rather than queues. Optional, cut first.

No velocity obstacles, no flow fields: at Classic density a pack is three to six bodies.

## Budget

At Classic density a player has some 20-60 creatures active round them; most stand or walk straight.

- **Steering**: a few `trunks.clear` calls a creature a step - micro-seconds.
- **Planning**: rare (on blocking, at most two a second a creature), queued, and given **1 ms a tick**
  across the server, like the collision streamer's budget. A creature waiting for its plan walks
  straight meanwhile.
- **Tiles**: made inside that budget; a tile not ready yet counts as straight-walkable.
- **Measured** by the probe (below): per search, per tile, per tick, with a hundred creatures
  chasing round a village.

## Debug

- **The path**: drawn as a line from each creature (`?debug` and the inspector's creature line,
  which also gains the state: straight, following, waiting for a plan, unreachable).
- **The tiles**: a debug map layer, walkable cells green, blocked red, regions tinted (MAP.md's
  workers already draw 1 m/px tiles).
- **Chat**: `/nav` toggles both; `/nav path` plans from the player to where the camera looks and
  draws it.
- Dev-only messages from the server; nothing in the protocol for players.

## Tests

`scripts/probe/navigation.mjs`, headless:

- **Round a house**: a chaser behind a house reaches a player in front of it, in under the time a
  straight run would take plus the detour.
- **Fence and gate**: through the gate, not along the fence.
- **Water**: a land creature goes round a pond, a swimmer across.
- **A crypt**: three hundred layouts; from the foot of the entrance to every room a path is found,
  and the motor walks it to within 1 m of its end. The two-storey halls and every spiral included.
- **Unreachable**: a target on a roof evades at once, not after `stuck`.
- **Deterministic**: the same query twice, and on a fresh server, gives the same waypoints.
- **Budget**: no tick over its 1 ms; a hundred chasers in a village.

A small fix to one part's ways is checked on that part alone, not the full probe.

## Steps

1. **The follower** (done). `Brain.path`, `steer`, plan and re-plan triggers, the `unreachable` evade, the
   path line in debug - with a `NavQuery` that only answers "straight". Behaviour unchanged; the
   seam is in.
2. **Dungeons** (done). The walk lines' graph, rays off it, crypt probe cases. The biggest win:
   this is where straight lines fail most.
3. **The surface.** Lazy tiles, A*, string-pulling, regions; `reachable` for wander and flee spots.
   House, fence, water cases.
4. **Steering.** Look-ahead round trunks, separation in a group.
5. **Surround slots** round a melee target.
6. **Caves.** Walk lines from field parts' shapes - with DUNGEONS.md's cave step.
7. **Houses.** The interior graph, room grids, doors by body width; probe cases for a chase from
   the street to an upstairs room and for a kind too big for the door.

**Cut order**, last first: 5, then 4's separation; 6 waits for caves; 7 is needed but may come
later than the rest. 1-3 are the plan; without them nothing changes for the player.

## As built

**Step 1, the follower** (2026-11-15):

- `src/world/nav/navQuery.ts`: the `NavQuery` interface and `straightNav`, which answers every way
  as straight - what the server uses until step 2. `createServer({ nav })` and the creature
  system's `CreatureWorld.nav` take a real one.
- `brain.ts`: `steer` in place of `toward` for wandering, evading home and chasing. It walks straight
  while `straight` says so; it plans when `straight` says not, or when it has got no nearer (by
  0.25 m) to what it heads for for 1 s; at most one plan every 0.5 s, 4 000 nodes each (constants
  for now, to the rules when the searches are real). A way goes stale when the goal moves off its
  end by more than a third of what is left of it (2 m at least). Waypoints are passed within 0.75 m.
  The way is dropped on every change of state. Fleeing still runs straight (step 3 picks reachable
  spots).
- No way: a chaser evades with `why: "unreachable"` at once; a wanderer stands; an evader runs
  straight home, and the 20 s teleport home still catches it.
- `Brain.path`, `next`, `nextPlan`, `aimBest`, `aimAt`; the inspector's creature line says
  `straight` or `following 2/5`.
- Debug: `__aiworld.creatures.showPaths()` draws each creature's way ahead as a cyan line
  (`src/game/navDebug.ts`); `showPaths(false)` stops. `/nav` waits for step 3's tiles.
- Probe: `creatures.mjs` gains a *navigation* section with a made-up nav: a chaser plans a detour,
  passes its waypoint and reaches its target, plans at most twice a second, and with no way evades
  as unreachable sooner than `stuck`. 90/93 checks pass; the three that fail (`social`, and the
  hunting bot's kill and loot) fail the same on the tree without this step.

**Step 2, dungeons** (2026-11-15):

- `src/world/nav/dungeonNav.ts`: `buildDungeonGraph(layout)` (the walk lines' graph, above; 5.5 ms
  and about 600 nodes for a crypt), `walkableStraight(world, a, b)` (the rays), `shortcut` (the same,
  and never across a doorway on the slant: a sill crossed so can wedge a body - only walk lines go
  through a doorway, square to it), `dungeonPath(graph, world, from, to, budget)`.
- A way: straight when the ends are under 30 m apart and a shortcut joins them; else each end onto
  the graph (the nearest nodes by distance, height counting four times; up to 24 tried, those
  within 3 m of one that failed passed over, two kept), A* with ties to the lower node, the nodes on
  straight runs dropped, and the ends pulled taut over their first and last four points. The middle
  keeps to the lines and their bends: rays cost, and a corridor's middle is a fine way to walk it.
- `src/sim/nav.ts`: the server's `NavQuery` - a dungeon's graph made on first use per placed dungeon;
  on the surface straight (until step 3). A way between a dungeon and anywhere outside it is none, so
  a creature outside chasing a player down into a crypt evades as unreachable (the user's call:
  each side stays put).
- The brain looks at `straight` once a plan slot (0.5 s) at most - in a dungeon it is rays. Homes
  carry their height, so the way home ends on the right floor.
- Probe: `scripts/probe/navigation.mjs [layouts]` (200 by default, about a minute): crypts on flat
  ground; a way from the arrival to every room (1437/1437) and from every spawn spot to the arrival
  (4514/4514), the ends' shortcuts walkable, none to a point in the rock over the boss (200/200),
  the same way twice, the motor walking door to boss (20/20 since de0d5b0). Then on a `tiny` server: a wolf 34 m
  off behind a crypt wall plans round it and reaches the player; the player put in the rock, it
  evades as unreachable. 1465/1465 checks.
- Cost: a search 0.68 ms and 28 rays on average (rays about 24 µs each), the slowest 17.5 ms. There
  is no queue yet: a plan runs when the brain asks. At the budget's 1 ms a tick, the rare slow one is
  a hitch to watch for when crypts are filled with creatures.
- Found and fixed by the dungeons work (de0d5b0): a ledger stone standing 0.29 m proud of a stair
  hall's floor across its walk line wedged the motor met on the slant; ledgers now collide with
  their top edges sloped at 45 degrees, and the motor walks 20/20 door to boss. A stall is still
  printed as a note, not failed: the share is checked.

## Decisions

| Question | Decision |
|---|---|
| Creatures in houses | **Needed** (the user, 2026-11-15); may come after the rest - step 7 |
| Fliers | **None planned**: every creature walks or swims |
| The dungeon's mouth | **Each side stays put** (the user, 2026-11-16): a surface creature does not follow a player down into a crypt, nor a crypt's creature out of it; a way between them is none, so the chaser evades as unreachable |

## Open questions

1. **Detours and the leash**: should the leash measure along the path walked rather than as the crow
   flies? Proposed: as now; a creature drawn round a long wall gives up sooner, which reads fine.
2. **Pressing on a wall**: should a creature that has no path stand and growl (Classic's "evade"
   look) or run home at once? Proposed: evade at once, as now, only without the 4 s of pushing.
