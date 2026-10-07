# Collision

The plan for colliding with the world: walking and jumping, and rays for sight, shots and the
camera. No rigid or soft bodies, and characters do not collide with each other. This is the system
only; which content makes which colliders is a step of its own, after it.

## Principles

- **True 3D.** Any rotation, any slope. Ceilings, roof undersides and beams stop a jump the same way
  walls stop a walk.
- **Colliders are authored, never taken from the render mesh.** Each is a few simple shapes,
  coarser than what is drawn. The system takes any detail - one box per house or one per beam - but
  coarser is cheaper.
- **Any capsule.** Nothing assumes a character's size; radius, height, step and slope are settings.
- **Pure TypeScript.** No Babylon inside `src/world/collision/`, so it runs in Node probes and in
  workers alike.
- **Continuous.** Moves are swept, never just tested at their end, so nothing tunnels through a thin
  wall however fast it goes.
- **Ready for navigation.** The same shapes can be read back - by bounds, or as triangles - for a
  navmesh or a grid later.

## Shapes

| Shape | Data |
|---|---|
| `sphere` | centre, radius |
| `capsule` | segment a-b, radius |
| `box` | centre, half-extents, any rotation |
| `convex` | points, and the face planes of their hull |
| `heightfield` | origin, cell size, a grid of heights, optional holes |

- A heightfield's cell is two triangles, split along the diagonal from its (col, row) corner to its
  (col + 1, row + 1) one. **Ground is solid only through its top**: whatever is under it is pushed
  up, but its outer edges and the sides of its holes are open - a cellar dug through it needs walls
  of its own.

- Everything but the heightfield is convex and answers one question - its furthest point in a
  direction - which is all the general tests need.
- Concave things are several shapes. An optional `group` names what they belong to (a house), so a
  ray can say what it hit as well as which piece.
- Each shape carries **layers**, a bit mask - solid, blocks sight, walkable and so on - and every
  query says which layers it sees. A hedge can block sight but not shots; glass the other way.

## World

- Shapes are added in **batches** (a chunk, a settlement) and removed the same way, as the world
  streams.
- Each batch keeps a **bounding-box tree** of its shapes, built once; the batches themselves are a
  short list of their bounds.
- A **heightfield** is never one big box: a query walks only the grid cells it touches.

## Queries

- **Ray cast**: the first hit along a ray - point, normal, shape and group - or whether anything is
  hit at all (sight checks stop at the first one). A ray starting inside a shape never hits it.
- **Sweep**: how far a sphere or capsule moves along a straight line before it touches something,
  and what it touches.
- **Overlap**: every shape a sphere or capsule is inside, how deep and which way out.
- **Distance**: how far a shape is from the nearest solid - clearance, for ground probes and
  navigation.

What asks - sweeps, overlaps, distances - is always a sphere or a capsule: a point or a segment, and
a radius. Against every shape that is GJK, which finds the gap between two convex hulls of points,
with the radii taken off after. When the point or segment itself is inside a box or a hull, the way
out is found exactly by the separating-axis test rather than by EPA. Sweeps step forward by the gap
over the closing speed (conservative advancement), which can never step past a touch.

## Character motor

A capsule moved by velocity, gravity and jumps:

- **Collide and slide**: sweep, stop just short of the hit, slide the rest of the move along what
  was hit; a few times a step. In a crease between two walls it slides along the crease.
- **Ground, wall, ceiling**: a hit is ground if it is no steeper than the slope limit, ceiling if it
  faces down - which ends the rise of a jump - and wall otherwise.
- **Steps**: blocked while on the ground, it tries up by the step height, across, and down again,
  and keeps that if it lands on ground.
- **Staying down**: on the ground and not rising, it follows the ground down slopes and stairs
  rather than flying off them. The ground is looked for with a sphere narrower than the capsule, so
  the edge of a step brushed by its round bottom is not taken for the floor; and a step's edge it
  lands on counts as ground when there is walkable ground just past it.
- **Never launched**: running into a slope or a step's edge takes speed away, but never turns it
  upward.
- **Jumps** only from the ground, or a moment after leaving it.
- **Pushed out**: if it ever ends up inside something - spawned, teleported - it is pushed out the
  shortest way.

## Sandbox

A page of its own (`collision.html`) to try all of it:

- a heightfield and the player's capsule on the motor - walk, jump - with the third-person camera;
- spawn spheres, capsules, boxes and random convex hulls ahead of the character, any size and
  rotation, solid or blocking sight only; shift-click one to delete it, or clear them all;
- preset scenes: a stair, a low-ceilinged corridor, a ramp too steep, a pile of tilted shapes, a
  wedge of two walls, a gap too narrow;
- colliders drawn as wireframes, contacts and their normals coloured ground / wall / ceiling;
- click to cast a ray and see its hit and normal; a line of sight to a marker;
- the capsule's size on sliders;
- the scene and the camera kept in the URL.

Beside it, a Node probe (`npm run probe -- scripts/probe/collision.mjs`) checks the maths at random: the general tests against exact answers, rays
against brute force, sweeps never ending inside anything, and the motor's scenarios - a wall, a
stair, a steep ramp, a ceiling, a spawn inside a box.

## Phases

Done:

1. Shapes, the trees and ray casts.
2. GJK, the separating-axis way out, overlap and distance.
3. Sweeps.
4. The character motor.
5. The sandbox.

Colliders so far:

- **Trees**: a generated tree's trunk and roots - never its branches or leaves - come out of the
  generator as a few convex pieces (`TreeGeometry.colliders`): each limb cut into nearly straight
  runs, each run the hull of its rings, a buttress root's the hull of its wedges, and anything wholly
  under the ground left out. `TreeField.colliders` puts a chunk's trees' pieces in the world. The
  workbench draws them over a tree (Colliders), and the sandbox's "Trees from the packs" plants one
  of each kind to walk into.

- **Ground**: each full-detail chunk's plain height grid, as a heightfield split four ways about each
  square's middle - as the ground is drawn - with its trees' pieces, in a batch that comes and goes
  with the chunk (worldCollision.ts). Where a cellar's cut crosses a square, the square is a hole
  and the rest of it is put back as slabs, so a cellar can be walked down into.

- **Buildings**: coarse boxes and a few convex pieces, made by the generator with the near model
  (buildingColliders.ts). A house with no rooms is solid, storey by storey, out to its jetties; one
  with rooms has hollow walls - cut round the doors that open - floors, slabs under open sky, solid
  unbuilt space, railings, a smooth slope for each stair, and a ramp up the plinth to each door out.
  Every roof block is one solid piece, plinths are boxes, supports and terraces their own boxes.
  Small things - frames, beams, shut doors and windows - are the wall or nothing. A settlement's
  buildings come into the world within 120 m of its edge and go past 180 m. The workbench draws a
  building's (Colliders) in place of the building.

The motor's step (0.75 m) and steepest ground (52 degrees) are set for these: a plinth is stepped
onto, and the steepest stair (50 degrees) walked up.

The game's player walks on the motor through these: WASD, Shift to run, Space to jump. Where its
chunk's collision is not built yet it stands on the terrain's own height. The settings panel's
"Spectator" swaps it for a free-flying camera with no body.

Later, each its own step: the camera kept out of walls by a ray; navigation.
