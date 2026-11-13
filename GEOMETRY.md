# How I design procedural geometry

My order of work for buildings and other built features. It is written in my own voice (the project owner's).
Sessions that generate architecture, dungeons, props or settlements should follow it, and ask me when a case does not fit.

## Summary

1. Decide first whether it has an interior. If it does, keep it in mind the whole time.
2. Scale first, then parts, then composition, then interior, then surroundings.
3. Make a rough blockout (boxes, cylinders, roofs, labelled) before any detail.
4. Detail by subdividing: by height, then along the run, then what goes where, then the roof.
5. Plan in a 3D grid, decide the trims, then build the geometry bottom to top: framing, dents, fill, details. No gaps or holes.
6. UV rules: same V for the same height, continuous UV across faces of the same material, trims use a long repeating texture.
7. Interior: floor plan per level, with logic and cross-visibility, built with the same steps as the outside.
8. Design for a character plus a third-person camera, with room to fight: paths at least 5 m wide, 10 m recommended.
9. An open area is fine, but divide it gently with set pieces, so there is cover and more interesting gameplay.

## 0. Interior or not

The first decision is whether the building will have an interior. If it does, keep it in mind at every later step.

## 1. Scale

When I first imagine a building I decide its scale. It usually comes from:

- how much of the map this feature should cover
- how large it needs to be to be recognizable
- how large it needs to be for multiple players to use it without blocking each other
- how large it needs to be to cover its function in theory

## 2. Parts

Next I think about what parts the feature has (tower, gate, several buildings, and so on):

- which parts are iconic
- which parts are important for gameplay
- what will be accessible to the player, and on what route

After deciding the parts, I decide how each one fits into the building:

- where it is in the building composition
- which way it faces
- its scale: does it need to be exaggerated, or enlarged to contain a feature?
- how important it is for generation: can it be optional, and how many of it appear?

After placing the main parts, the rest can be filled with more generic building parts, keeping the next step in mind.

## 3. Interior design

If the building has an interior, I decide:

- where the connections between interior and exterior are: gates and openings (windows are currently opaque, so matching them up matters less)
- what rooms there will be, and where they are
- how the rooms connect: directly, or through a corridor
- how and where the vertical connection is solved: stair, ramp, or maybe a collapsed part of a ruin
- how the ground meets the feature, and whether there are ground-level terraces

### A good floor plan needs logic

A floor plan is not just room after corridor after room. It needs logic about what room comes after what.
It is not only doors but also cross-visibility: seeing an upper-floor path from below, or another room divided only by a row of pillars.
This is hard to explain.
Do not be afraid of dead ends. A dead end can still hold an enemy or some loot.

As the Expanse books put it: "I keep warning you. Doors and corners, kid. That's where they get you."
Doors and corners are where I usually find a lack of detail.

## 4. Surroundings

After that I think about what is around the feature:

- what terrain complements it (flattening, material)
- how it connects to the world (roads)
- where it can appear in the world (biome, nearby water, elevation)

## 5. Blockout

Once these are decided, a rough blockout can happen. It is mostly boxes (not axis-aligned), cylinders and roofs.
It may be shown with each shape labelled with the building or building part it stands for.

## 6. Detailing

### 6.1 Subdividing large surfaces

First I think about how to subdivide the large surfaces.

**By height.** For example, a different design at the ground floor and the top floor (think of how a palazzo divides its facade).
This is not needed every time, but it is a good option.

**Along the run.** I think about how to subdivide it horizontally:

- at the ends of the run, I may want a different style or some geometric offset
- in the middle, or aligned to another building part, there can also be a change
- the rest can have periodic details, such as columns and pilasters

### 6.2 What goes where

After the subdivision I decide what to put where:

- which parts get a window and which do not, and in what style
- other details, such as a flag, a banner or some wall damage

### 6.3 Roofs

Then I think about how to detail the tops of the roofs:

- whether the roof is subdivided into parts
- whether there is a walkable rooftop, and different roofing styles or directions
- how the roof parts connect
- how the roof and the walls connect (overhang or not)
- larger roof details such as dormers (and their style) and chimneys

## 7. Before building the mesh

At this point there is a more detailed plan of what to build, but still no final mesh.

**The grid.** If it is hard to visualize, build it mentally as a 3D table, grid or lattice of what goes where.
Then assign the wall data to the faces of this grid.

**The trims.** One more decision is needed before building geometry: the trims.
One of the most important details is how building parts meet other parts, or the terrain.
These can be assigned to the borders (edges) of the grid.

## 8. Building the geometry

I build from bottom to top: foundation, first-floor floor, first-floor walls, first-floor ceilings, second floor, and so on.
Roofing can be the last step. Wall dormers need special attention.

For each level:

1. First create the framing and the borders, horizontally as well as vertically.
2. Then add any detail that puts a dent in the future surface, like a window or a gate. Geometry that comes outward is not as problematic.
3. Then fill in the rest. Now you know how much space the framing takes and which parts to avoid filling.
4. Then add the remaining details.

The most important thing in this step is to avoid creating gaps and holes in the geometry.

## 9. UVs

- **Trims:** use a long repeating texture along the trim's direction. A trim sheet can be useful.
- **Vertical walls:** the UV is not hard, but keep the same V value for the same Z (the vertical axis) all over the building.
- **Faces of the same material:** if there is no trim between them, two meeting faces with the same material should have a continuous UV.
- **Floors:** a simple planar top-down projection works, but align it to the building's axes.

## 10. Building the interior

After the exterior, I hope the gates that connect to the interior exist, because the interior is next.
Draw the floor plan for each level and build the geometry with the same logic and steps as the outside.
In the interior, instead of the roof, think about the ceiling: is it flat, or subdivided?

## 11. Where this recipe stops

These recipes are good for a big chunk of architecture. Some of the most iconic set dressing cannot be described with them.
Such pieces need either big extra steps (for example turning a building into a ruin, where meeting indoor and outdoor is hard), or very good art pieces, or organic shapes.
If I ask for something like this, ask me how to approach it before building.

## 12. Playable scale

Important not to forget: you are not designing the sizes so that a player can just fit in.
You are designing for a character plus a third-person camera, and there must be space for fights.
So rooms need space:

- 5 m is the minimum width for a path
- 10 m is recommended
- it only gets too big above 30 m, and even that is not always a problem, because sometimes we want open areas

### Open areas

Sometimes I design an open area on purpose. In that case, try to divide it gently into parts with carefully placed set pieces, so there is cover and the gameplay is more interesting.
