# Prop rendering

The plan for drawing props apart from buildings: their own shaders and materials, and each prop
culled and faded by its size. **Agreed. Steps 1 and 2 built (see their status); steps 3-4 not started.**

## 1. Why

Props are `BuildingModel`s drawn by the building shader (`buildings/buildingMesh.ts`). That shader
holds every building material in the pack at once, as one layer of two 1024 px texture arrays
(colour+roughness, normal+height - about 10 MB of GPU memory a material, mips included) and as one
slot of five uniform arrays. `MAX_BUILDING_MATERIALS = 32`; the pack has 31. The arrays are what let
a building of many materials be one mesh and one draw call - right for houses. But a prop that needs
a texture of its own (a hide, an antler, dried herbs) costs a full 1024 px layer for the whole pack,
loaded whether or not anything uses it, and it counts against the buildings' cap. The hunting lodge
(`lodge-concepts`, 6 new materials, 37 in all) cannot load.

## 2. What exists

- **Outdoor props are one mesh each, near and far.** A compound's props, its walls, road fences,
  fingerposts and bridges go to the building renderer as "houses" (`worldData.ts`), each built twice
  (`generateProp(..., far)`), each its own near and far mesh. The renderer switches every one on and
  off every frame by the world's draw distance (`setDrawDistance`, the player's setting) and swaps
  near for far at `FAR_DETAIL_DISTANCE = 220` m (`buildingRenderer.ts`). Nothing is merged, so a
  prop is already about one draw call, and a cut by its own distance needs no new mesh layout.
- **Furniture is part of its house.** `houseGenerator.ts` lays each piece into the house's own model
  (`b.append`) and its colliders into the house's. The house's lights are baked against that one
  model (`lighting/lightBake.ts`: the faces it lights and the faces it is shadowed by), into one
  lightmap per house. The same for a dungeon part's fixtures (candles, urns, the altar, chandeliers:
  `dungeons/kitMesh.ts`).
- **Lighting.** The lightmap is optional per mesh (`lightmapOn`); everything else - sun or moon,
  cascaded shadows, the ambient, fog - is the shared lighting (`materials/litShading`). An outdoor
  prop has no lightmap and needs none.
- **Effects** (PROP_EFFECTS.md) follow a near mesh being drawn (`effectGroups`, `shown`).

## 3. The plan

### Step 1 - each prop culled and faded by its size

- A prop's **cull distance** from its size: `clamp(k * reach, min, max) * quality`, `reach` its
  measured half-diagonal (and height), `quality` from the draw-distance setting. A candle goes at a
  few tens of metres, a cart or gallows far later. No prop is drawn past the world's draw distance.
- A **dithered fade** over the last few metres before it: the shader drops a screen-space pattern of
  pixels, thicker with distance (a per-mesh uniform: where the fade starts and ends). No blending,
  no sorting, so it stays an opaque draw. The mesh is switched off once past it - the fade is the
  look, switching off is the saving.
- **Shadows** stop with the mesh (it is switched off), so a faded prop does not leave its shadow.
- **Far models for small props**: a prop whose cull distance is short of `FAR_DETAIL_DISTANCE` needs
  no far model - not built, saving its mesh.
- **Exempt**: what a player has a reason to find - a quest pickup, a place's sign (`label`), what can
  be used - keeps a floor on its distance.
- This works in today's building shader; it does not wait for step 2.

**Status: built.** A compound's props (not its walls, not a place's sign, not road fences, fingerposts
or bridges) are `Placed.bySize`; the building renderer gives each a cull distance of
`clamp(80 * size * drawDistance / 800, 24, drawDistance)` m, `size` the larger of its reach and its
height, and a fade over the last quarter (at least 4 m) - the shader's `fadeRange` uniform, set per
mesh (`setMeshFade`), a 4x4 ordered dither. The draw-distance setting rescales them live. A prop's
far mesh is made only when first wanted. In the small world at the default draw distance the props'
cull distances run 68-436 m, median 92 m; at one compound 16 props were drawn where 31 were before.
Known limit: the ambient occlusion's geometry pass ignores the dither, so a prop fading out may
leave a faint darkening on the ground until it is switched off.

### Step 2 - the outdoor prop shader and its own materials

- A **prop shader**: the building shader's lighting (shared `litShading`: sun, shadows, ambient,
  fog, the shine and bump), without the lightmap, with the fade of step 1. Written so the same
  source builds both variants (`#define LIGHTMAP` for step 3).
- **Its own material set, a texture each** (decided: not an array). Each prop material is its own
  colour and normal texture, baked only once a prop that uses it is built, at a size of its own
  (a material file may ask for 256, 512 or 1024 px - a herb bundle needs far less than a cart's
  boards). No cap at all.
- **A prop's parts by material**: its model split into one sub-mesh per material it uses (all its
  timber parts one sub-mesh), each drawn with that material - a prop of three materials is three
  draw calls. Plain-colour parts (no material) go together in one. Step 1's culling is what keeps
  the count down; measure it (open question 5).
- Instances of the same prop and variant may later share one mesh and be drawn instanced - not
  needed to begin with.

**Status: built.** `props/propMesh.ts`: the props' shader (the building
shader's lighting, one material's uniforms instead of the arrays, the fade, `#ifdef LIGHTMAP` ready
for step 3, and Babylon's instance matrices under `#ifdef INSTANCES`), one `ShaderMaterial` per
building material a prop uses (made when first used) plus a plain colour's, and a `MultiMaterial`
per set of them. A prop's mesh is its model in its own space, faces sorted into a sub-mesh per
material, placed by a frozen, decomposed world matrix (`placedAxes`) - so the same `propKey` (prop
and variant) is an instance of one mesh (below). `Placed.propKey`
marks what is drawn so: a compound's props and fingerposts by key, wall, fence and bridge stretches
with `null` (their own). A prop with lights keeps the building shader (its lightmap) until step 3.
For now each material reads its texture from a layer of the buildings' arrays - nothing baked twice;
textures of their own come with step 4. In the small world: 524 prop meshes, 15 prop materials,
1.6 sub-meshes (draws) a prop on average - at one compound 23 props drawn in 48 draws.
Not yet: the workbench and the shots still draw props with the building shader.

**Instanced.** A prop has a few variants (`variants` in its file, default 6 -
`DEFAULT_PROP_VARIANTS`; it was one out of 2^20, so no two props were alike): each placed one is
one of them, rolled as before. Every prop of a key is an `InstancedMesh` of one hidden source mesh
(`prop:<id>:<variant>[:bySize][:far]`), so all of a key that are shown are one draw per material.
The fade is set on the source (`setMeshFade` follows an instance to it) - one size, one fade for
all. Walls, fences and bridges (their own shape each) stay meshes of their own. In the small world:
371 props from 77 meshes; at a graveyard 294 props shown in 49 draws, where one mesh each would be
376. The instances are in the shadow casters' list and Babylon's shadow pass draws them the way the
main pass does, but their shadows were not seen by eye (overcast). Fewer variants changes how big
the props measure, so where they are set down moves (a new layout, the same rules).

### Step 3 - furniture and fixtures as meshes of their own, lightmapped

- Furniture (and a dungeon part's fixtures) built into a **mesh of its own** beside its house's,
  drawn by the prop shader's lightmapped variant.
- **Baked together, drawn apart**: the house's bake still takes the house and its furniture as one
  (so a table still shades the floor and the hearth still lights the chairs), and gives back one
  lightmap and each vertex's place on it; the furniture's vertices go to the furniture mesh. Both
  meshes bind the same lightmap.
- Colliders stay where they are (the house's, from the same pieces).
- Its cost: one more draw call a furnished house near the camera.

### Step 4 - the building array for buildings

- Materials only props use leave `buildingMaterials/` for the prop set; the building array keeps
  what walls, roofs, floors and dungeons are made of. The lodge's six land here.

## 4. Open questions

1. ~~Prop textures: a texture each or a prop array of their own?~~ **Decided: a texture each**, a
   prop's parts as one sub-mesh per material.
2. ~~The lodge before step 3: wait, or a stopgap now?~~ **Decided: the lodge waits.** No stopgap
   in the building shader; `lodge-concepts` stays parked until step 4 frees the building array.
3. The fade's numbers: `k`, the floor and ceiling, how long the fade - first values in step 1's
   status; to be tuned by eye in the game.
4. Where prop materials live: their own folder (`propMaterials/`), or `buildingMaterials/` with a
   flag saying which set bakes them.
5. Measure first: how many props are drawn at once in a village and a compound now, so step 1's
   saving and the per-material draws are numbers, not guesses.
6. ~~How many variants a prop has~~ **Decided: a few** - `variants`, default 6. Each placed copy
   still differs by its turn and tilt; a per-instance tint (an instance colour) could come later.

## 5. What else it touches

- The workbench's stage (`workbench/stage.ts`) and its prop and material views, and the shots
  (SHOTS.md: `keepBuildingCpuCopies`) - they draw props through the building material today.
- The light bake (`castsByLayer`: which layers cast) - step 3 gives it the prop set's too.
- Dungeons (DUNGEONS.md) - step 3 for their fixtures; their walls stay on the building shader.
- Quest pickups as props, and anything else that finds a prop by its mesh.
