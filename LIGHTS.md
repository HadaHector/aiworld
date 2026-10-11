# Lights

The plan for props that give light - a fire in the fireplace, a lantern, a candle on a sconce, the
stove's door - lighting what is round them, **with shadows**: a light that shines through a wall is
worse than none. Being explored; worked through in phases after it is agreed.

## Where it starts from

- Every custom shader (terrain, grass, trees, buildings, ocean) shares one lighting block,
  `LIT_SHADING_GLSL` (`materials/litShading.ts`): the sun or moon, the ambient sky-fill, the cascaded
  shadow map, fog. There is no other light.
- Houses and outdoor props are drawn by the building shader (`buildings/buildingMesh.ts`), **one
  mesh and one draw call per house or prop**, all its materials in one texture array. The furniture
  is built into its house's near model. Houses are generated on the main thread when they come near.
- Every face is a flat convex polygon laid by `ModelBuilder` (`face`, `surface`), mostly boxes and
  quads, already with a texture laid in metres.
- Flames and lit panes are drawn lit (a building material's `glow`); they light nothing.

## The idea: bake it

A house and everything in it stand still, and so do its lights - only their strength flickers. So
their light can be worked out once, shadows and all, when the house is built, and stored in a
**lightmap**: a small texture per house, laid over its faces by a second set of texture coordinates.
Drawing it costs one texture read per pixel, however many lights and however complex their shadows.

The sun and moon stay as they are (dynamic, the cascaded shadow map); the bake is only the house's
own lights.

### Laying the lightmap (the unwrap)

- Each polygon is a chart: flattened onto its own plane (it already is flat), scaled to a texel
  density, packed into the house's atlas with a gutter of a texel or two round it. Coplanar polygons
  sharing edges (a wall's pieces either side of a window) merged into one chart, so there is no seam.
- **Density**: about 4 texels a metre (a texel 25 cm - fine for the oversized world). An inn's
  inside is some hundreds of square metres: an atlas of 128-256 texels square.
- **Small faces get no texels.** A bevel's strip, a chair rail, a candle: below an area, a face is
  lit per vertex instead (the bake writes its corners' light into a vertex attribute). Furniture's
  many small parts would otherwise waste most of the atlas on gutters.
- Faces no light reaches (the outside of the walls, the roof, the far model) get no texels either:
  they read a black texel or a zero attribute.

### The bake

- **Direct light, ray-traced**: from each texel's point on its face (and each small face's corners)
  a ray to each light within its radius - against the house's own triangles in a bounding-volume
  tree (a few thousand triangles). Blocked or not, times the falloff and the face's facing.
- **Soft shadows**: each light a small sphere (a candle's flame, a fire's bed), a few rays to points
  across it - 4 to 16 - so shadows have soft edges, and a texel's light is the fraction that got
  through.
- **One bounce** (later, if it is worth it): the light a lit floor throws back up, gathered at the
  texels - what makes a room lit by a fire glow, rather than lit in a spot and black in the corners.
- **In a worker**, as the textures and chunks are already baked (`textureBakePool`,
  `chunkBuildPool`), from the house's geometry and its lights; the house is drawn without its light
  until it is ready. Cached by the house's seed and the content's hash, so it is baked once.
- Then dilated (the gutters filled from their charts' edges) so filtering never reads black.

### Flicker

The bake stores the light split in two: the steady lights (lamps, candles behind glass) in the
lightmap's colour, the fires' in its fourth channel as a strength. The shader adds
`steady + fire * fireColour * flicker(time)`: a house's fires flicker together, which is how a room
lit by one hearth looks anyway. Half-float (RGBA16F, filtered in WebGL2), so a light may be
brighter than 1.

### In the shader

One more attribute (the lightmap coordinate, or for a small face its baked light) and one texture
per house, bound as the mesh is drawn - still one draw call per house. A house with no lights draws
as now: no texture read.

## Moving things

Baked light falls only on what was there when it was baked. The player (and later any creature)
walking past the fire is lit by it **dynamically, without shadows** - better than nothing, and cheap,
since there is one player and a light or two near them:

- The few lights nearest the player (2-4), picked once a frame, are Babylon's own point lights. The
  player is drawn with a `StandardMaterial`, so it takes them; the world's own shaders are custom and
  ignore Babylon's lights, so nothing else pays for them. A fixed pool, made once and moved and
  dimmed rather than added and removed - a `StandardMaterial` recompiles when its count of lights
  changes.
- So a fire does not light the player through a wall, each is checked once a frame by a ray from
  the light to the player's middle against the collision world: blocked, it fades out over a few
  tenths of a second rather than switching. One ray per light per frame.
- Later, if moving things grow many: **light probes** - the bake also writes the light at points
  through each room, and a figure takes its light from the nearest.

## Outdoors

A lantern on a post, a lamp by a door: lighting the ground, the grass and the trees, which are not
one house's. Not baked (the ground is chunked, grass and trees are instanced across the world): a
short list of the outdoor lights nearest the camera in `LIT_SHADING_GLSL`, unshadowed - outdoors
there is little to shine through. A house's own bake takes in the outdoor lights near it too, so its
outer walls are lit by the lamp at its door, with shadows. Interior lights stay out of the outdoor
list.

## Measuring

- **The bake's cost**: per house, in a worker - time and texel count, from a probe that bakes every
  building with lights and writes their lightmaps out as images (to look at).
- **Its memory**: an atlas per near house; RGBA16F at 256 square is half a megabyte.
- **Drawing**: frame time in the inn at night and down a town street, lights on against off -
  baselined from a worktree, as every other timing.

## Rejected

- **Dynamic point lights clipped to room boxes**: cheap and simple, but no shadows from furniture,
  and a box only approximates a room - it leaks round doors and open galleries.
- **Shadow cubemaps per light, rendered once when the house loads**: real shadows and exact
  per-pixel falloff, but six depth maps per light, a cube sampled per light per pixel, and the few
  texture units WebGL2 has already mostly taken.
- **Babylon's own lights**: our shaders are custom (one draw call per house); its standard ones cap
  and recompile per light count.
- **Baking into vertex colours alone**: a wall is one big quad - a light's falloff would smear
  across it, and no shadow would fall on it.

## Phases

1. **A light on a prop, and a probe.** `light` on a prop (place, colour, strength, radius, size,
   fire or steady); `BuildingModel.lights`; the unwrap and the bake in a probe, lightmaps written out
   as images for a few houses, with the times.
2. **Drawn.** The second texture coordinates, the lightmap per house in the shader, the flicker;
   baked in a worker, cached. Fireplace, stove, lanterns, sconce and altar lit. Measured.
3. **Workbench.** Lights and a Night time in the building and prop previews; the lightmap shown.
4. **The player lit**: the nearest lights on the player's mesh, line of sight by a ray.
5. **Bounce, probes**, if the first look asks for them.
6. **Outdoors.** The nearest-lights list for the ground, grass and trees; lanterns in compounds.

## Status

Phase 1 is in, and the drawing half of phase 2, in the workbench only:

- A prop's `light` (`color`, `intensity`, `radius`, `size`), placed by its generator
  (`PropContext.light`) - the fireplace over its fire, the stove before its door's slot, a lantern in
  its panes, each candle (sconce, altar) over its flame. `BuildingModel.lights`, carried through
  `ModelBuilder.append` into the house. Each light in its own colour; no flicker.
- Windows' daylight: a window part's `light` (`intensity`, `radius`) puts a light just inside each
  window into a room with its glass in, as wide as the window (its source no wider than 0.8 m),
  shining into the room only (`facing`: most straight ahead, nothing back along the wall). Baked as
  a strength into the lightmap's fourth channel, lit as it is drawn by the sky as it is then (its
  fill and half the sun's or moon's strength) - so it dims at dusk and is gone by night, with no
  bake again.
- Panes seen from inside: a building material's `inside` names what it is seen as from inside a
  room (glass: `dayPane`), and the window built again on the wall's inner face takes it; `daylight`
  (0-1) draws a material with the daylight through it rather than lit - bright by day, dark blue by
  night - by the same sky term as the windows' light. From outside, glass is as it was.
- The bake (`src/world/lighting/lightBake.ts`): a patch per face a light can reach, laid in its own
  plane at 4 texels a metre; faces turned by their stored normal (corners are not wound one way);
  rays to points across each light's source (4, then 16 where they disagree) against a
  surface-area-split tree of the house's triangles, flames and lit panes casting no shadow; a patch
  dark all over dropped to the one black texel, one even all over kept as one texel; packed on
  shelves. The falloff: full at the light, half a third of the way out, nothing at its radius.
- Drawn: `lightUv` per vertex, a half-float lightmap per mesh bound as the mesh is drawn (one shader
  for lit and unlit houses).
- Probe `scripts/probe/lightBake.local.mjs`: per building with lights, its faces, patches, atlas size
  and bake time, and the atlas as a picture. At variant 3, with its windows, the inn bakes in about
  2.7 s (32 lights, 16 000 occluding triangles, 3 M rays) to 512 x 204 texels; the others under 2 s.

- In the game: each house's lights are baked the first time its near model is shown, in a pool of
  two workers (`lighting/lightBake.worker.ts`, `lightBakePool.ts`) - the nearest waiting house
  first - from its near mesh's own vertex data and its lights placed as the mesh is; the lightmap
  and each vertex's place on it laid onto the mesh when it comes back (`applyLightmap`).
- The player lit (`lighting/playerLights.ts`): the three house lights nearest it whose reach it is
  in, as a fixed pool of point lights lighting its mesh only, each as strong as the bake would make
  it there (window lights in the sky's colour); a ray from each light to the player against the
  collision world fades a light out over a sixth of a second while a wall is between them.
- Cached between visits (`lighting/lightCache.ts`, IndexedDB `aiworld-lightmaps`, least recently
  used past 256 MB): keyed by a hash of exactly what is baked - the mesh, which materials cast
  shadow, the lights - and of the bake's code (`virtual:light-bake-code-hash`), so a changed house,
  content or bake bakes again. Looked up and kept by the worker; the texture cache's Clear clears it
  too.
- Windows lit at night, from outside: a house's `litWindows` (0-1) is the share of its windows with
  a lamp behind them - lived-in houses only; barns, sheds and stables have none. Their glass is its
  material's `lit` (glass: `litGlass`), whose `lamp` colour it is drawn in as the daylight fails
  (dusk to dawn, or a dark enough day) - glowing, not lighting anything round it.

Open: indoors the sky's ambient light is as strong as outdoors, everywhere - so a window's light
hardly shows by day. Not yet: the workbench's own Lights view.
