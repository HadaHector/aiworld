# Navigation

How creatures find their way: round houses, fences and trees on the surface, and through crypts and
caves under it. **Status: plan, waiting for approval.** Nothing is built.

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
creature loses nothing. **Interiors and their stairs**: creatures stay out of houses (open question
1); a house is its footprint.

The search is A* on 8 neighbours within a window round the two ends (the leash's 60 m, and a
margin), capped at a node budget (4 000 by default, in the rules). The path is pulled taut by the
grid's own `straight` test, so it is a few waypoints, not one per metre.

### Dungeons: the layout graph and walk lines

A dungeon already is a graph: parts as nodes, joined sockets as edges, and every kit part has walk
lines measured at load. So:

- **Between parts**: A* on the layout graph (tens of nodes: free), socket to socket, costed by the
  walk lines' lengths.
- **Along a way** (corridor, stair, spiral, connector): follow its walk line. Ways are 6 m wide and
  clear by DUNGEONS.md's own check; nothing to avoid but other bodies. Spirals and stairs stacked
  over each other are no problem, since the graph is in 3D.
- **In a room** (`room: true`: halls, tombs, the rotunda, the boss halls): a small grid in the
  part's own frame, built once per part **definition** at pack load from its colliders (rays down
  every metre, up to two floors a cell for the two-storey halls) and cached with the content hash.
  A placed room reuses its part's grid through its transform, so a dungeon costs nothing to build
  beyond its layout.
- **Caves** (the field builder) have no per-part colliders, but their shapes are analytic: a
  tunnel's centre line and a chamber's floor give walk lines and a room's disc. Done with the cave
  step of DUNGEONS.md, not before.

Space dungeons (their own dimension) use the same graph; nothing differs.

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

Small fixes to one part's grid are checked on that part alone, not the full probe.

## Steps

1. **The follower.** `Brain.path`, `steer`, plan and re-plan triggers, the `unreachable` evade, the
   path line in debug - with a `NavQuery` that only answers "straight". Behaviour unchanged; the
   seam is in.
2. **Dungeons.** The layout graph search, walk lines, room grids per part definition. The biggest
   win: this is where straight lines fail most. Crypt probe cases.
3. **The surface.** Lazy tiles, A*, string-pulling, regions; `reachable` for wander and flee spots.
   House, fence, water cases.
4. **Steering.** Look-ahead round trunks, separation in a group.
5. **Surround slots** round a melee target.
6. **Caves.** Walk lines from field parts' shapes - with DUNGEONS.md's cave step.

**Cut order**, last first: 5, then 4's separation, then 6 waits for caves. 1-3 are the plan; without
them nothing changes for the player.

## Open questions

1. **Houses**: may creatures go into houses with rooms (a bandit in a farmhouse, a wolf through an
   open door)? Proposed: no, a house is a wall; interiors need doors and stairs in the nav and give
   players an easy escape to argue about.
2. **The dungeon's mouth**: may a surface creature chase a player down into a seamless crypt, and a
   crypt's creature chase them out? Proposed: no - each side's creatures leash at the mouth (a crypt's
   creatures are its own, and the switch of drawing at the second flight would show them popping).
3. **Detours and the leash**: should the leash measure along the path walked rather than as the crow
   flies? Proposed: as now; a creature drawn round a long wall gives up sooner, which reads fine.
4. **Pressing on a wall**: should a creature that has no path stand and growl (Classic's "evade"
   look) or run home at once? Proposed: evade at once, as now, only without the 4 s of pushing.
5. **Swimmers and fliers**: swimmers get the water cells; is there a flier anywhere in the plan? If
   so it needs no nav at all (straight, with a height), but say so before step 3.
