# Characters

The plan for step 5 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: a character spike, done early
because it is the riskiest piece. The question it answers: does a low-poly humanoid built
procedurally from parts, textured and animated procedurally, look good enough for a
WoW-Classic-like third-person RPG? Afterwards a body can be looked at in the workbench with any
race and outfit, playing any of its animations, and the own player in the game is drawn with one.

**Status: building.** Steps 1-2 are built: the human in the workbench (`?asset=core/races/human`),
painted, and its Atlas view; gear materials in `gearMaterials/`.

## Decisions

| Question | Decision |
|---|---|
| Proportions | Stylised, WoW-like: broad shoulders, big hands and feet, a slightly large head, so body and gear read from the third-person camera (as buildings are authored ~2× life size) |
| Geometry | Each bone's shape is four profile curves along it (front, back, left, right); loops (cross-section rings) are sampled from them. Branches (pelvis, chest, hands, feet) are a few fixed-topology *junction patches* whose borders are *ports* that limb loops plug into. A lattice deform shapes the finished mesh |
| Gear | Real geometry, not only texture: heavier gear means more loops, more vertices and more pieces. Three kinds: shells, replacement segments, rigid pieces |
| Texture | Low-poly but textured: one painted atlas per character, composited in layers (skin, face, clothing and armour per slot) |
| Gear materials | New materials made for gear (`gearMaterials/`: linen, wool, leather, mail, plate, bronze, fur...), not the world's ground and building materials. Same pipeline format, so the tools and the workbench's texture view work for them, but authored at a character's scale |
| Races in the spike | Human, dwarf, tall elf, one skeleton shared, different templates |
| Animation | Procedural: idle, walk, run, jump and fall, swim, melee swing, blended. No foot IK: feet follow the cycle on slopes |
| Where it is judged | First in the workbench (bodies and gear are pack data like everything else), then on the own player in the game |

## Principles

- **Client only.** A body is how an entity is drawn. The simulation keeps its capsule; nothing in
  `src/sim` changes. What the client knows of a body comes from the entity's template (its race
  and look) and later from its equipment.
- **Data first.** Races, outfits and gear pieces are json5 in packs. The code knows bones, curves,
  loops, patches, lattices and the three kinds of gear geometry, never a race or an item by name.
- **Deterministic from a seed.** The same character seed gives the same face, colours and body
  every time, on every client.
- **Topology lives in the patches; everything else is free.** Loops can have any vertex count and
  are zipped together by angle. Only where one loop becomes two or three does topology have to be
  designed, and that is done once, in a patch.
- **Built in place of loaded.** No hand-made meshes or textures: patches are a handful of numbers
  in code, shapes and paint are rules in data.

## Skeleton

One humanoid skeleton, about 20 bones: root, pelvis, spine, chest, neck, head; per side clavicle,
upper arm, forearm, hand, thigh, shin, foot; plus *attachment bones* that carry gear and animate
with their parent: `mainHand`, `offHand`, `back`, `helm`, `shoulderL`, `shoulderR`, `belt`.

A race template gives bone lengths and widths (as factors of a base), a posture (spine curve, how
far the shoulders sit forward) and limits for the look sliders. The skeleton is built once per
character in the bind pose, and the mesh is skinned to it with Babylon's `Skeleton`, so animation
only moves bones.

## Body from curves

Each bone's shape is defined by **four profile curves** running along it: **front**, **back**,
**out** (away from the body's middle) and **in**. Each says how far the surface stands from the
bone's axis, from the bone's start (0) to its end (1), as a modeller draws a limb from a front and a
side silhouette. A bone in the middle (pelvis, spine, chest, neck, head) has one `side` for both
sides; a foot has `top` and `sole` for front and back:

```json5
thigh: {
  front: [[0, 0.11], [0.3, 0.115], [1, 0.075]],  // [along, distance] - smooth through its points
  back:  [[0, 0.12], [0.2, 0.12], [1, 0.075]],
  out:   [[0, 0.12], [0.4, 0.105], [1, 0.075]],
  in:    [[0, 0.095], [1, 0.07]],                 // the inner side, flatter
  round: 0.7,                                     // between the curves: boxy (0) to round (1)
  loops: 2, verts: 8,                             // how finely it is cut
}
```

- A curve is a few points, interpolated smoothly (monotone cubic, so it never overshoots between
  them). The body's other side is the same curves mirrored.
- **Loops are sampled from the curves**, not authored. A loop at some point along the bone is a
  ring whose four extremes are the four curves' distances there, filled between them as a
  superellipse of the given `round`. `loops` and `verts` say how many rings and how many vertices
  each: the low-poly cut is a setting, not part of the shape. Rings are spread evenly along each
  bone for now; placing them where the curves bend most, so a calf or a shoulder keeps its outline
  with few loops, is left for when it shows.
- A race gives the curves; look sliders scale them (all four, or front/back only for a belly,
  left/right only for breadth).

**Loop to loop.** Two neighbouring loops are joined by walking both rings by angle and zipping
them with a strip of triangles. That works whatever their counts, so a 6-vertex wrist can meet a
10-vertex gauntlet cuff.

**Junction patches.** Where the body branches, a patch of fixed topology joins them:

```
          torso loop (12)
        ┌──────────────┐
        │   pelvis     │   ← fixed topology, shaped by the race's proportions
        └──┬────────┬──┘     front and back centre vertices shared by both legs
       leg port (8) leg port (8)
           │            │
       thigh loops ... (any count, zipped by angle)
```

The spike needs four: **pelvis** (torso to two legs), **chest** (torso to neck and both arms),
**hand** (wrist to a mitten with a thumb) and **foot** (ankle to a wedge). Their vertices sit where
the curves of the bones they join put them, so a dwarf's pelvis is the same patch made wider. A
port's vertex count is fixed; the chain plugged into it starts with a loop of that count and is
free after.

**Lattice deform.** Once the mesh is built, a coarse lattice (a box of control points, a few per
axis) around the whole body or one region bends it as a last pass: free-form deformation, moving
every vertex by the control points around it. It shapes what curves along single bones cannot,
across bones and patches at once: a hunched back, a barrel chest that spills over the shoulders,
a heavy jaw, a pot belly, the dwarf's squat mass or the elf's lean lift. Lattices are data, in the
race (its overall shape) and in look sliders (each slider moves some control points by an
amount). It runs in the bind pose, before skinning, and the joints are moved through the same
lattice so the skeleton still sits inside the deformed body. Gear shells are built after it, from
the deformed body, so they fit whatever the lattice made.

As built: the shoulders' top ring slopes down from the neck to the arms; a collar ring sits halfway
between it and the neck, so the neck rises out of a slope; and between each arm hole and the arm's
first ring is a ring blended halfway and puffed out, so the shoulder rounds over into the arm (the
deltoid) instead of turning at a crease. The arms are built hanging 70° below level, near how they
stand, so standing deforms the shoulders little. The body is smooth-shaded: corners keep their own
atlas places, but share their vertex's normal.

**Skinning.** Every vertex of a loop belongs to its bone, with a blend over the last and first
loops either side of a joint, so elbows and knees bend without collapsing. Patch vertices carry
their weights in the patch.

**The head** is a short chain on the head bone with its own four curves (front gives nose, chin
and brow in profile, the sides give cheeks and jaw), and a lattice of its own for the face's
broad shape; ears (an elf's long ones) are rigid pieces on the head bone. The face itself is
painted.

## Gear as geometry

Gear adds geometry three ways, and a piece can use several:

1. **Shells** - the body's own curves offset outward, on the same bones, so they follow the body
   and its skinning for free. A breastplate is the torso's curves plus its thickness, with its own
   curve points for a flared rim and a raised centre ridge (a sharp point in the front curve).
   Greaves and vambraces are the same. A heavier tier is thicker, more finely cut (more loops,
   more vertices) and has more shape in its curves.
2. **Replacement segments** (WoW's geosets) - a piece takes over a stretch of a bone chain instead
   of covering it: a robe or tassets replace the thighs with a skirt hanging from the pelvis's
   ports; gauntlets replace the hand with a bigger one; boots replace the foot and part of the shin.
3. **Rigid pieces** - helm, pauldrons, weapon, shield, belt pouch, ears: separate meshes, also built
   from curves (a pauldron is a dome lofted along a short curve set), each moving with one attachment bone.

Body loops under a shell or a replacement are left out, so nothing pokes through and no triangles
are spent where nobody sees them. The aim is about 400 triangles for a body in plain clothes and
about 1500 for full plate.

A gear piece is defined once and fits every race: its curves are given relative to the body's
(offsets and factors), so the same breastplate sits on a dwarf and on an elf.

## Texture: a painted atlas

Each character has one texture atlas (512² to start). Every loop chain, patch, shell and piece is
unwrapped by construction: a chain is a cylinder, its loops' angle across and length along, put in
its own region of the atlas. No unwrapping by hand.

The atlas is painted in layers when a character is made and when its gear changes:

1. **Skin** - from the race's palette and the seed, with light painted in: lighter on top, darker
   in creases and at joints. Most of the hand-made look on few polygons comes from this.
2. **Face** - in the head's region: eyes, brows, mouth, the shadow of the nose, beard or stubble,
   drawn as shapes from parameters (the race's ranges and the seed).
3. **Clothing and armour** - each piece paints the regions it covers (a shirt the torso and upper
   arms, trousers the legs), and its own shells and pieces. Fills come from gear materials (below);
   procedural trim goes on top: hems, stitching, rivets, mail rings, a belt and buckle, edge wear.

**Gear materials** are their own pack folder, `gearMaterials/`, made for gear rather than borrowed
from the world: linen, wool, leather, studded leather, mail, plate, bronze, fur, wood for hafts and
shields. They use the same texture pipeline as world materials (`TextureDef`), so they bake the
same way and the workbench's Texture view shows them, but they are authored at a character's scale
(a weave, a ring or a rivet sized to read on a body from the third-person camera, at the 2x rule)
and can be tinted, so one leather serves brown, black and dyed pieces. A gear piece names its
material and tint; the world's materials stay the world's.

Resolution and filtering are settings, so two looks can be compared on the same body: 512 smooth
(hand-painted) and 128 nearest (chunky retro).

As built (step 2): the atlas is rasterised once into a buffer that says, per texel, which region it
is in, where on the bind-pose body and which way its smooth normal faces; every layer paints from
that, so the face is drawn in the head's own measures (`look.face` in the race gives the heights of
eyes, brows, nose, mouth and hairline) and light and occlusion come from the body's real shape.
Until there is gear, the workbench's *Smallclothes* paints linen over the hips as a stand-in.

## Animation

Procedural, on the bones, from a few inputs: speed over the ground, whether it is grounded,
vertical speed, swimming, and a swing trigger.

- **Idle** - breathing in the chest, a slow weight shift, the head looking around now and then.
- **Walk and run** - one gait cycle whose phase advances with distance travelled, so feet do not
  slide on flat ground. Stride, bounce, lean and arm swing grow with speed; walk and run are one
  blend by speed, not two clips. No foot IK: on slopes the feet follow the cycle.
- **Jump and fall** - a crouch on take-off, legs tucked while rising, reaching down while falling,
  a dip on landing.
- **Swim** - a horizontal body, a breaststroke with the arms, a kick with the legs. Only on the
  workbench for now: the simulation has no water state yet.
- **Melee swing** - wind-up, strike and follow-through for the arm with the weapon, the spine
  twisting with it, played over whatever the legs do.

Each is a function from time and inputs to a pose (a rotation per bone). Poses are blended by
weights that ease in and out, and the swing is layered on the upper body.

## Data

New pack folders, read on the client only (the world's and the game rules' resolvers skip them):

| Folder | What it holds |
|---|---|
| `races/` | A skeleton's proportions, its four curves per bone, its lattices, posture, palettes for skin and hair, face ranges, slider limits |
| `gearMaterials/` | Materials for gear: a texture pipeline, as world materials, plus the tints it allows |
| `gear/` | One piece: its slot, its shells, replacements and rigid pieces, its paint (regions, material, trim) |
| `outfits/` | A named set of gear pieces, for the workbench and for test characters |

The player template's `look` gains a race and an outfit (`look: { race: "human", outfit:
"peasant" }`); the capsule fields stay for entities without a body.

## Workbench

Races, gear, outfits and gear materials show up in the workbench like any other pack folder, and editing the
json5 rebuilds the preview at once:

- **Model** (3D) - the body on a small patch of ground, turning or still. Options: race, outfit,
  seed, look sliders, animation (idle, walk, run, a speed slider, jump, swim, swing), wireframe,
  bones, texture look (smooth or retro). A gear piece is shown worn by a chosen race.
- **Line-up** (3D) - the three races side by side in the same outfit, to judge gear fitting each.
- **Atlas** (2D) - the painted texture.
- **Stats** - triangle count per part, so the cost of gear is visible.

## In game

The own player is drawn with a body instead of the capsule, from the player template's look,
animated from what the client already gets: position, facing and `grounded` per snapshot (speed
and vertical speed are worked out from the change in position). A key plays the swing. Other
entities keep their capsules for now.

## Build steps

1. **Skeleton and bare body in the workbench.** Bones, four curves per bone and loops sampled
   from them, the four junction patches, the lattice pass, skinning; one race (human); the Model view with wireframe and bones; a still pose.
   *This is the first thing to look at.*
2. **Atlas.** Unwrapping by construction, skin and face painted, the Atlas view, both texture looks;
   the first gear materials (linen, leather, plate) in `gearMaterials/`.
3. **Animation.** Idle, walk/run blend, jump and fall, swim, swing, with the options in the Model
   view.
4. **Gear.** Shells, replacements, rigid pieces and their paint; three outfits: cloth (a robe),
   leather and mail (thin shells, boots), heavy plate (thick shells, pauldrons, helm, gauntlets).
5. **Races.** Dwarf and elf templates, look sliders, the Line-up view.
6. **In game.** The own player drawn with a body and animated.
7. **Verdict.** The user judges it; the verdict and next steps are written below.

## Out of scope for the spike

Foot IK; bodies on creatures, NPCs and other players; mounts; equipment from items (step 7);
character creation screens; level of detail and instancing for many bodies; cloth or hair
simulation; facial animation.

## Verdict

Not judged yet.
