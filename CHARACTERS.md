# Characters

The plan for step 5 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: a character spike, done early
because it is the riskiest piece. The question it answers: does a low-poly humanoid built
procedurally from parts, textured and animated procedurally, look good enough for a
WoW-Classic-like third-person RPG? Afterwards a body can be looked at in the workbench with any
race and outfit, playing any of its animations, and the own player in the game is drawn with one.

**Status: done - judged good enough; the approach stays** (see [Verdict](#verdict)). Steps 1-6 are built - the player in the game has a body
(`?race=dwarf&outfit=knight&sex=female&look=7` picks it) - and before that: three races (human, dwarf, elf), male and female, in the
workbench (`?asset=core/races/human`), painted, with an Atlas view and a Line-up view, playing their
animations, in three outfits; gear materials in `gearMaterials/`, gear in `gear/`, outfits in
`outfits/`.

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
- **Bumps** add what four curves cannot: a swelling at a place along the bone and an angle round it
  (a pec, a shoulder blade, a buttock, a breast), fading over a length and a width. A bump can mark
  a point at its peak for the painter (`mark: "nipple"`).
- **Sexes.** A race has a `male` and a `female` block: factors on its skeleton's lengths and on
  bones' curves, bumps added, and its own share of beards. A character's seed picks its sex.
- **Race pieces.** A race can carry rigid pieces of its own, in its skin's colour: the elf's long
  ears are tapering spikes on the head bone.
- **Sliders.** A race gives each slider a range - `height` (all its lengths) and `build` (the girth
  of every bone below the head, and how far apart the shoulders and hips are) - and a character's
  seed picks where in it the character falls. The workbench can force low, middle or high.
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
between it and the neck, so the neck rises out of a slope; each arm starts with a root ring over the
joint tilted halfway between the torso's side and the arm, then a ring blended halfway from the hole
to it and puffed out, so the shoulder rounds over into the arm (the deltoid) instead of turning at a
crease; zips there measure angles round that halfway axis, since down an arm hanging beside a wall
the hole's top and bottom fall at the same angle. The race sets how far under the shoulder joint the
armpit is (`armpit`) and how far under the hips the legs part (`crotch`); the hip ring dips toward
the middle to meet them. The arms are built hanging 77° below level, against the chest's side, near how they
stand, so standing deforms the shoulders little. The body is smooth-shaded: corners keep their own
atlas places, but share their vertex's normal.

**Skinning.** Every vertex of a loop belongs to its bone, with a blend over the last and first
loops either side of a joint, so elbows and knees bend without collapsing. Patch vertices carry
their weights in the patch. As built: a vertex follows the nearest of its own bone and the bones next to it
(inverse distance to the fourth power, its own bone favoured); where the body joins itself the
weights are set by hand - the shoulder's hole, the ring over it and the arm's root go from mostly
the chest to mostly the arm in steps, the clavicle in each so a shrug lifts them, and the collar is
shared by the chest and the neck. The shoulder's joining triangles are unrolled with the torso in the
atlas, and every empty texel is filled from its neighbours, so nothing samples black.

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

As built (`src/character/gearDef.ts`, gear in `bodyMesh.ts`): a piece paints the atlas over shares
of regions' lengths (`paint`), and adds `shells` (a chain of bones - torso, head, arms, hands, legs,
feet - grown out by a thickness between two shares of its length, flared at its ends, a lip at each
edge showing its thickness, `cap` closing a helm), `skirts` (level rings hanging from the torso,
flaring, following the thighs) and `pieces` (a `dome` of lames - a pauldron - or a `blade` with its
hilt, on one bone). Gear is built with the body, so it follows the lattice and is skinned the same
way, rigid pieces wholly to their bone. Each material and tint is its own mesh, textured by its gear
material in metres round and along, sharing the body's skeleton. Body triangles under gear are kept:
nothing showed through in the three outfits, but a stride can push a thigh through a long skirt, and
shells over the feet sink a centimetre into the ground. The spike's outfits: an apprentice (a
painted robe with a skirt, belt, sandals - about 1500 triangles), a scout (mail, a leather jerkin,
boots, bracers - about 2200) and a knight (breastplate, tassets, three-lame pauldrons, gauntlets,
leg plate, helm, sword over mail - about 3300).

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

As built (`src/character/animation.ts`): walking (about 1.2-1.5 m/s) and running (a jog, about
3 m/s; the game's own speeds are not final) are two cycles on one phase, blended between 1.8 and
2.6 m/s. The jog has a flight between steps, the heel kicking up behind, the knee driving in front
and the elbows bent and pumping. A cycle covers more ground the faster it goes. Both lower the body
as far as the leg under it has shortened, which keeps that foot on the ground on the flat. Take-off has no crouch: the animation
learns of a jump only when the body leaves the ground. The workbench's *Play* menu runs each
animation on the spot or round a circle, at the game's speeds, jumping and swinging on a timer.

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
  As built: every race in the packs, shortest first, in the same outfit, sex, seed and animation.
- **Atlas** (2D) - the painted texture.
- **Stats** - triangle count per part, so the cost of gear is visible.

## In game

The own player is drawn with a body instead of the capsule, from the player template's look,
animated from what the client already gets: position, facing and `grounded` per snapshot (speed
and vertical speed are worked out from the change in position). A key plays the swing. Other
entities keep their capsules for now.

As built (`src/game/playerBody.ts`): there is no character creation yet, so who the player is comes
from the page's address - `race`, `outfit`, `sex` and `look` (the character's seed), a human scout
if left out - rather than from the player template, which keeps `src/sim` untouched. The body is
built while the dimension loads; the capsule stands in until it is ready and then stays, unseen, as
what the camera and the house lights follow. Speed and vertical speed come from how far the player
moved since the last snapshot, eased; a move of more than 3 m is a teleport. The body turns toward
the player's facing rather than snapping. 1 or F swings. The game's own walk (6 m/s) and run
(12 m/s) are not final: at them the gait runs; at 1.2-1.5 and 3 m/s it would walk and jog as tuned.

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

**Good enough for a WoW-Classic-like game: keep this approach.** Judged by the user on the workbench
and in the game, after the rounds of fixes this spike went through (smooth shading, the shoulders,
neck and crotch, a rounder chest, the face's heights, a walk and a jog of their own).

What the spike showed:

- **Bodies from curves work.** Four profile curves per bone, bumps and a lattice give a humanoid
  that reads at third-person distance, and three races and two sexes come from data alone. The hard
  part was where the body joins itself - the shoulders above all - and it needed fixed places in
  code (ports, a tilted root ring, a blended deltoid ring, hand-set weights) rather than more data.
- **A painted atlas carries the face and the look.** Unrolling regions as cylinders and painting
  from what each texel is on the body gives faces, hair, beards, smallclothes and painted light
  without any hand-made texture.
- **Gear as geometry carries the WoW feel.** Shells, skirts, layered pauldrons and a sword, built
  with the body and skinned with it, fit every race unchanged. A knight is about 3300 triangles, a
  bare body about 1300-1500.
- **Procedural animation is enough** for idle, walk, jog, jump, swim and a swing, driven only by what
  the client already knows of an entity.

## Next steps

In rough order of need; each belongs to the build-order step named, or is its own task.

1. **Bodies for everyone, not just the own player.** Other players, NPCs and humanoid creatures
   drawn with bodies (replacing `entityMeshes.ts`'s capsules), animated from the mirror's motion as
   the player's is. Needs the template's `look` to name a race and outfit and each entity's look seed
   to reach the client - a small change to the game rules' template reader and to what is
   replicated (ENTITIES.md), which this spike left alone.
2. **Many bodies at once.** One body shared by every character with the same race, sex, sliders,
   seed and gear; a lower detail far away (the `detail` setting already halves it); gear meshes of
   one material merged; smaller atlases far away. Measure first with a crowd in a town.
3. **Equipment from items (build step 7).** Item types name gear pieces, equipment slots replace
   outfits, gear tints and materials come from the item's rarity and kind. Mixing pieces already
   works in the data.
4. **Character creation and saves.** A screen to pick race, sex, look seed and sliders, saved with
   the character (GAMEPLAY.md, *Saved state*) - replacing the address's `?race=&outfit=&sex=&look=`.
5. **Animation from abilities (build step 4).** Swings, casts and hits played by the ability system
   instead of a key; a swing per weapon kind (one-handed, two-handed, bow, staff); a take-off crouch
   once the server says a jump started; swimming once the simulation has water.
6. **Creatures (build step 6).** Non-humanoid skeletons - quadrupeds, birds - from the same parts:
   bones carrying curves, junction patches for their own branchings.
7. **Known flaws to fix when they show:** a long skirt lets a striding thigh through; shells over
   the feet sink a centimetre into the ground; a dwarf's sword is a human's length and drags; a darker
   band under the armpit from some angles; the gait is tuned for 1.2-1.5 m/s walking and 3 m/s
   running, so the game's speeds and the gait should be settled together. Hair is painted only - hair
   geometry (tails, braids, beards that stand out) can come with character creation. Foot IK stays
   out unless slopes show feet floating badly.
