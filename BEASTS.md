# Beasts

The plan for the step CREATURES.md left out ("beast bodies") and CHARACTERS.md's *Next steps* 6:
non-humanoid bodies. Afterwards wolves, boars, spiders, bears and giant ants are drawn as animated, painted,
procedural beasts instead of capsules - built from parts and numbers in packs, deterministic from the
seed, in the spirit of the humanoids - and a new beast is pack data, not code.

**Status: plan, awaiting approval. Nothing is built.**

## Decisions

| Question | Decision |
|---|---|
| First beasts | **Wolf, boar, bear (four legs), spider (eight) and a giant ant (six)** - the user added the bear and the ant. The ant is there so the model is not tied to 4 or 8 legs: limb counts, trunk segments and gaits are data |
| Style | **WoW-like chunky**, as the humanoids: big heads, paws, tusks, horns and eyes (the ~2x rule), so a beast reads from the third-person camera. A wolf lean but big-pawed, a boar a wedge of shoulder, a bear a mound, a spider a bulbous abdomen on thick legs |
| What varies | **Colour and markings** (palette, stripes, patches, belly, scars), **size and build** (overall size, lean to heavy, leg length, head size), **horns, tusks, mane, ruff** (parts that appear or grow with traits). Not in this step: glowing eyes, spines and other fantastical add-ons beyond these - but every part has a size that can be pushed past nature, so a kind's trait can make tusks or a mane absurd |
| Spider | **Eight legs, wave gait** (alternating sets of legs), a low bobbing body, a rear-up bite and a web spit from the mouth |
| Sticking-out parts | **Alpha-masked cards** (added at the user's asking): hair, mane, ruff, bristles, fur tufts, tentacles, frills and whiskers are thin strips and cards whose shape comes from an alpha mask painted in a texture, not from geometry. See *Alpha cards* |
| More beasts | The rig is general (any trunk of segments, any limb sets and counts): crabs, centipedes, serpents and rearing beasts are plans, not code; see *Range of the generator*. Birds (wings) and flyers are under *Later* |
| Other | Collision stays the sim's capsule. Nothing in `src/sim` changes in shape (see *Connection*) |

## Principles

- **Client only, as the humanoids.** A beast body is how an entity is drawn. The server's capsule is
  what collides and is picked.
- **Data first.** A *body plan* (`beasts/<id>.json5`) holds bones, lengths, curves, limb counts,
  gaits, parts and paint rules. The code knows spines, limb chains, curves, parts and gaits, never a
  wolf.
- **A new module next to the humanoid one**, `src/character/beast/`, sharing code through the small
  seams that exist already (`curve.ts`, `meshKit.ts`, `lattice.ts`, the workers, `bodyTiming`,
  `workSlicer`) and not editing the humanoid builders. Another session is adding weapons and shields
  to `bodyMesh.ts`/`gearDef.ts` at the same time, so shared files are touched only where this plan
  says so, and lightly.
- **Deterministic from a seed.** An individual's size, markings and parts come from its entity seed
  (already in its spawn); a kind's traits (rabid, old, frost...) shift the ranges.
- **Built, not loaded.** No hand-made meshes or textures.

## The body plan

```json5
// beasts/wolf.json5   (sketch - numbers settle in the workbench)
{
  trunk: ["head", "neck", "chest", "belly", "hip"],   // body segments; limb sets below sit on them
  size: [0.8, 1.0, 1.1],        // unit scale range (metres of body length at 1.0 = base)
  skeleton: {                   // metres at scale 1 (limb sets: count, segments, angles, tip; see Skeleton model)
    spine: { length: 1.0, segments: 4, hip: 0.62, shoulder: 0.7 },  // heights of hip and shoulder joints
    neck: 0.28, head: 0.32, tail: { length: 0.6, segments: 3 },
    legs: {                     // one entry per leg pair: front, hind
      front: { at: 0.85, spread: 0.13, segments: [0.30, 0.26, 0.14], paw: 0.16 },   // upper, lower, pastern; paw length
      hind:  { at: 0.05, spread: 0.12, segments: [0.30, 0.28, 0.16], paw: 0.18 },
    },
  },
  curves: { /* four profile curves per bone, as races */ },
  parts: [                      // rigid or lofted extras, on bones, each with a size range and a trait/seed gate
    { id: "ears", bone: "head", shape: "cone", ... },
    { id: "ruff", bone: "neck", ..., chance: 0.4, scale: [0.8, 1.6] },
  ],
  gaits: { walk: {...}, trot: {...}, run: {...} },
  paint: { palette: {...}, layers: [ { fur: ... }, { stripes: ... }, { belly: ... } ] },
}
```

### Skeleton model

Not "a quadruped" and "an arachnid" as two hard-coded layouts: one general model in which those are
plans. A body is:

- **A trunk**: an ordered chain of **body segments** (`trunk: [head, thorax, abdomen]` for an ant or
  spider, `[head, neck, chest, belly, hip]` for a wolf; a centipede's is twenty identical
  segments). Each segment is a bone chain with its own curves, length, width, joint stiffness and
  a bend axis; it can be fused to the next (a spider's cephalothorax) or pinched (an ant's waist).
- **Limb sets**: any number of them, each `{ on: segment, count, side: "pairs"|"single"|"ring",
  segments: [lengths], joint axes, spread, angle, rest height, tip: paw|hoof|claw|pad|foot }`.
  A wolf has two sets of two (fore, hind); an ant three sets of two (every leg pair on its own
  thorax segment); a spider four sets of two, all on the cephalothorax; a centipede a pair per trunk
  segment; a crab a ring of five; a bear two sets of two with a plantigrade foot; a rearing
  kangaroo-like beast a big hind set and small fore set; an octopus a ring of eight soft limbs
  (tentacles as limb chains with no joints stiffness - the same card/chain code as *Alpha cards*).
- **Appendages**: tail (a chain; a scorpion's curls over the back and ends in a stinger), neck-and-head
  chain, jaw or mandibles, antennae, wings (listed under *Later*, but the model reserves them),
  and the **parts** and **cards** below.
- **Attachment bones** (`mouth`, `head`, `chest`, `feet`, `back`, `tail`, `sting`) ride on their
  parents as the humanoids' do.

A *body plan* is just this data, so the first four plus an ant are five files and there is no "arachnid
code": limb count and trunk layout come from the plan. What the code owns is the **builders**
(trunk chain, limb chain, junction ports, parts, cards) and the **gait generator**, which makes
the footfall pattern for any limb count (below). Limbs on a trunk segment plug into **ports** (side
patches on the segment, like the humanoid pelvis and chest), with the junction vertex counts fixed
and the limb's first loop matching it.

### Range of the generator - what "a quadruped" should be able to make

The generator is tested against extremes, not only the four species; if these can be authored as
data, ordinary animals come easily:

- **Count**: 2 (a hopping biped, a raptor) 4, 6 (ant, beetle), 8 (spider, scorpion), 10 and up
  (crab, a many-legged lizard), 2n (centipede, millipede), 0 (a worm or a serpent: a trunk with a
  body wave and no limbs), tentacle rings.
- **Layout**: low and sprawled (a lizard, a crocodile, a spider), upright on the hind legs (a rearing
  bear), digitigrade (wolf) or plantigrade (bear) feet, hoofed (boar), a long swan neck, a
  hump (bison, camel), a barrel, a squat toad, a long pinched ant waist.
- **Scale**: from a rat to a house (a dragon-sized crawler, a giant crab); size is a plan range and
  an individual factor, and stride, bob and clip speed follow it (a big beast moves slowly with
  long strides; a small one scurries). Legs scale with size, not with skeleton lengths alone, so
  the gait cycle is valid at any size.
- **Anatomy gone wrong**: mismatched pairs (a huge fore pair and tiny hind), extra legs, a second
  head on a second neck, a head at each end, a spine of spikes, armour plates over a trunk
  (rigid pieces on segments), a shell, wings that do not fly, an extra eye, a mouth in the chest.
  A plan can list a **variant's** extra limb sets or segments (a two-headed wolf, a six-legged
  boar) and a **trait** can add one; individuals and kinds can differ by data alone.
- **Material**: fur, hide, scale, chitin, bone, slime, stone, crystal; carried by the palette and
  the coat layers (*Painted atlas*), and by alpha cards (hair, feathers, spines, tentacles, frills,
  whiskers).
- **Motion families**, picked per limb count and plan: the gait generator makes a footfall pattern
  from a few numbers (`pattern: "walk" | "trot" | "pace" | "bound" | "gallop" | "tripod" | "wave" |
  "metachronal"`, duty factor, stride, lift): four-leg walk, trot and gallop; a **tripod** for six
  legs (the ant: legs 1-3-5 against 2-4-6, fast); a **wave** for eight (the spider); a
  **metachronal** wave rippling down a centipede's legs, which is a phase offset per segment; and
  for no limbs a **body wave**. Everything is baked with IK into keyframes (see *Animation*), so
  any pattern costs the same at runtime.

For this step the plans are the four above plus the **giant ant** (six legs, three trunk segments
with a pinched waist, mandibles, antennae, a tripod gait, a bite and a spray of acid from the
mouth); the model and the generator cover the rest of the range, which the workbench lets you try
by editing a plan's counts, and which a pack may then add as data. Nothing in the range needs new
code except the part builders and the gait patterns named here.

### Body from curves

As CHARACTERS.md: each bone's shape is four profile curves (front/back/out/in) sampled into loops,
zipped by angle, smooth-shaded, skinned with inverse-distance weights and a hand-set blend at joints.
What is new:

- **Fewer junctions.** A quadruped's torso is one long chain with the legs plugging in at
  **hip and shoulder junction patches** (like the humanoid's pelvis, but ports at the sides rather
  than below); the head is a chain with a snout (a tapering loop run) and a **jaw bone** that can
  open; the tail is a chain. The spider's legs plug into ports round the cephalothorax; the abdomen
  is a separate swollen chain.
- **Bumps** (as races have) for a boar's shoulder hump, a bear's, a wolf's chest and haunch.
- **Parts**: horns, tusks, ears, mane and ruff (lofted tapered prisms or cones on a bone, a few
  loops each), fangs and mandibles, eyes (as painted shapes, with a bump socket), claws. A part has a
  size range and a gate (`chance`, a trait, a variant), rolled from the individual's seed, so a
  boar's tusks run from stubs to a threat and a mane exists on some wolves only.
- **Lattice** (existing `lattice.ts`) for the overall silhouette: a deep chest, a heavy jaw.
- **Individuals** are the plan scaled: size, build (girth), leg length and head size from the seed
  and the kind's traits, as humanoids differ by scale on one cached body. Parts' presence and
  sizes change geometry, so they are part of a body's cache key.

### Alpha cards

Anything that sticks out of the body in many thin pieces - a wolf's ruff, a boar's bristle crest, a
bear's shaggy shoulders, a mane, a spider's leg hair, tentacles, a frill, whiskers - is a **card
group**, not lofted geometry. The shape is in an **alpha mask** painted procedurally.

- **A card** is a small quad strip (2-4 segments along its length so it can bend) rooted on a
  *place* on the body (a bone and a region of its surface: along the neck's top, down the spine,
  round the jaw, under the abdomen) and pointing out along the surface normal, blended with a
  direction (backswept, drooping, curling). Cards are scattered by rules from the plan and the seed:
  `count`, `length` and `width` ranges, `lean`, `curl`, `droop`, `clump` (strands in bunches), and a
  `gate` (chance, trait, variant) as for other parts. A tentacle is the same with a long card
  chain that has its own bones (see below) and a wave.
- **The mask.** Each group names a small **card atlas** (64-256 px, one per kind and tint): a strip
  texture with RGB (fur, hair, or skin colour with a lit gradient root to tip, darker at the root)
  and an **alpha** that cuts the strand's outline - tapering hairs, pointed tufts, fringed or
  serrated frills, wavy tentacle edges with suckers drawn into the colour. Alpha is painted from
  rules (`strands`, `tuft`, `fringe`, `frond`), not authored, in the same painter family as the
  atlas. Several mask variants sit in one texture, and each card picks one by seed, so a mane is
  not one repeated shape.
- **Rendering.** Alpha test (a hard cutout with alpha-to-coverage where available), not blending,
  so cards need no sorting, cast shadows, and cost little; double-sided. One mesh per group
  material, merged into the body's skinned mesh set, so it is a draw call or two per beast.
- **Skinning and motion.** Cards are skinned to their bone like any part, so a mane moves with the
  neck. A **sway** is added in the animator for free ends: cards on a group flagged `soft` get
  secondary motion from the body's acceleration and a little wind (a spring-lag turn of the group's
  tip bones, or a cheap vertex sway by distance from the root in the shader). Tentacles are
  chains of 4-6 bones with a travelling wave, driven by the gait and idle, and can reach (an
  attack clip may name a tentacle chain to lash).
- **Budget.** A card is 2-6 triangles; a plan's groups total about 300-600 cards (a wolf's ruff
  about 80, a bear's coat 250, a mane 150), about 1000-2500 extra triangles for the shaggiest beast,
  which the cache and a distance limit (below) keep cheap; far away, cards beyond a distance are
  dropped and the body's painted fur carries the look.
- **Data.** In the plan: `cards: [{ id, place, count, length, width, lean, curl, droop, mask,
  tint, soft, gate }]`; masks are rules in the plan (`masks: { strands: { ... } }`). A pack adds
  a hair, a mane or a tentacle by data alone, and a trait can turn a group on or scale its length
  (a rabid wolf's bristling ruff, an old bear's shag).

### Painted atlas

One atlas per body (256 to 512 square) laid out by construction, as CHARACTERS.md: each chain a
cylinder, the head, legs and parts in their own regions. Painted in layers by rules from the plan's
palette and the individual's seed and kind's traits:

1. **Base coat**: fur, hide, bristle or chitin - a mottled colour from the species palette with
   light and occlusion painted in from the real geometry (lighter on top, dark in creases), the
   same painter idea as the humanoid's.
2. **Pattern layers**: `stripes` (tiger bands on a spider's legs, a boar's piglet-like stripes
   gone), `patches` (a wolf's saddle, a bear's chest blaze), `belly` and `mask` (a paler underside
   and muzzle: a countershade by surface normal), `socks` (paler lower legs), `scars` (a few
   seed-placed marks), `spots` (a spider's abdomen mark).
3. **Features**: eyes, nose, mouth line, claws, tusk and horn tint, mane colour.
4. **Kind tint**: the kind's `look.color` (frost wolf white, jungle spider green) is the palette's
   centre; traits shift it (old = greyer).

Same painter structure as `paint.ts` (a per-texel region buffer, painted from what each texel lies
on), in `beast/paintBeast.ts`; no new texture pipeline.

## Animation

Procedural, from data, on the same animator seam (`Animator.update(input, dt)` giving a pose per
bone). Inputs are what the humanoid's already are - speed, grounded, `swing`/`play`, `flinch`,
`dead`, `snap` - so `entityMeshes.ts` and the feedback system feed a beast as they feed a body.
The beast animator is a new file; the humanoid's `animation.ts` stays as it is.

- **Idle**: breathing (the chest and flank), ear and tail flicks, the head turning, a weight shift;
  now and then a sniff or a look. Sit and sleep (a wolf curled, a bear sitting) are one-shot
  poses a plan may name, played on request; only if cheap, otherwise left to *Later*.
- **Locomotion by gait.** A gait is data: for each leg a **phase offset**, a duty factor (how long
  the foot is down), stride length and lift, and the body's bob, pitch and spine wave. Phase advances
  with the distance covered, so feet do not slide on the flat, and stride grows with speed. Walk,
  trot and run are three gaits blended by speed (wolf: a loping walk, a trot, a gallop with a
  suspended phase and a flexing spine; boar: a short trot and a stiff-legged charge; bear: a heavy
  walk and a lumbering run with the shoulders rolling). **No real-time IK** (the user's call: not
  feasible at crowd scale). Instead **IK is a baking tool**: when a body is made (in the worker, or
  offline in the probe), each gait is solved once - two-bone IK takes every foot along its path
  (a footfall on the ground, an arc between lift-off and touch-down, planted for the duty factor)
  at N phase samples and writes the result as **forward-kinematic keyframes** (a turn per leg bone
  per phase sample, looped, plus the body's bob and pitch). The runtime only samples those
  keyframes by phase and blends gaits by speed - no solving per frame. Feet follow the cycle on
  slopes as the humanoids' do; if hillsides show floating feet, a cheap per-leg lift of the
  whole body from the ground under it is the fallback, not IK. The same baker makes the spider's
  eight-leg cycle and may bake attack poses (a reach to a target point) for clips.
- **Many legs** (spider, ant, and any other count; the generator makes the pattern, see *Range of the generator*): the spider's eight legs with an **alternating wave gait** (legs 1 and 3 on one side
  with 2 and 4 on the other, in antiphase), each leg with its own phase and reach, a low body that
  sways, a fast skittering run; legs lift high and splay on the stride. Turning in place steps
  the legs round. The ant runs a **tripod** (three legs down, three swinging), fast and low, antennae
  sweeping.
- **Attacks** by name, one-shot clips defined in the plan and chosen from the creature's skill
  (ABILITIES.md's `animation` field): **bite** (lunge, jaw opens and snaps, head shakes), **claw
  swipe** (a rear-up and a sweep of one front leg, for the bear), **gore** (head down, a lunge and an upward
  toss, for the boar and its charge) and the spider's **venom bite** and **web spit** (rear on the
  hind legs, mandibles spread, abdomen pumps, and the glob leaves the `mouth` bone). The skills'
  `animation: swing` falls back to the plan's `attack` clip; a skill naming a clip the plan has plays
  it. A plan lists its clips; the engine plays them by name as it plays humanoid clips.
- **Hit reaction**: the flinch seam - the spine and head jerk away from the blow, the body
  shoves a few centimetres - plus the existing body hit flash (FEEDBACK.md) on the body's meshes.
- **Death and corpse**: the legs fold, the body tips onto its side (the side the blow came from
  if known, else seeded), a settle, the legs curl or splay (a spider curls its legs over its
  body), the head down; then it lies still until despawn. A unit first seen dead lies at once
  (`snap`). The plan names the corpse pose; it is a keyframed one-shot like the humanoid's death,
  with `dead` as the input.
- **Speed follows the entity's movement speed**: a beast animates at the speed over the ground
  the client works out from snapshots, as the humanoid gait does; the species' `speed.walk/run`
  shares just decide which gait it is in. So a creature chasing at 5 m/s gallops and one
  wandering strolls, and a slow kind (old trait) takes shorter strides at the same pace.
- **Footsteps** are reported (`step`) per foot touch-down so FEEDBACK.md's footstep sounds and dust
  work, with the feet bone mapped to the paws.

## Connection

- **A creature species names its body plan.** `creatures/wolf.json5` gains `look.beast: "wolf"`
  (an entity template look field next to `race`), a plan id; variants and traits shift it through
  `look.beast` options (`bodyTraits`) - sizes, tusk length chances, palette. Nothing about this
  reaches the server's behaviour; `look` is already client data and is read by the client's
  resolved rules (the page resolves the same catalogue as the server, so a kind's trait ids are
  known at the client; step 1 confirms that and what the spawn already carries).
- **`src/game/beastBody.ts`** (next to `characterBody.ts`): `createBeastBody(scene, name, kit, look,
  seed)`, returning a `CharacterBody`-shaped object (`show`, `swing`, `play`, `stop`, `place`,
  `steps`, `flash`, `flinch`, `pause`, `dispose`). `entityMeshes.ts` takes a look with `beast` the
  way it takes one with `race`: a capsule stands in while the body builds, then hides, stays as the
  picking and ring capsule. This is the one shared-file change of any size, and it is a few lines
  choosing a factory.
- **Bones for cues**: `BodyPlace` gains `mouth` (the jaw bone's tip) and keeps `feet` (the paws'
  mean), `head`, `chest`, `hands` -> forepaws; effect cues in FEEDBACK.md that name `mouth` for
  bites or `feet` for dust find it on beasts; an unknown place on a body falls back to its chest.
- **Nameplate and health-bar heights** follow the body: `look.height` stays the capsule's, and the
  body reports its real top (`body.height`, scaled by the individual's size), which
  `healthBars.ts` and the target frame use if present.
- **Collision** is the capsule, as now. The species' `look.height`/`radius` are adjusted per kind
  to match the beast's size and shape (a wolf's capsule shorter and longer in radius than it is now;
  a bear wide and tall; a spider low and broad), and an individual's size scale is not sent to the
  server (the capsule is the kind's); a large individual is a few percent over its capsule at most
  (size ranges are narrow enough, step 5 checks it).
- **The attack animation** plays from the creature's skills: the ability system already sends an
  `animation` event by name; a beast plays the clip of that name from its plan, falling back to
  `attack` for `swing`.
- **Hit flash and flinch** are the `Feelable` the body gives.
- **Neutral and hostile wildlife** get bodies; a capsule stays for any kind whose look names no
  plan. Bandits keep their human bodies.

## Performance

- **Built in the worker pool**, as bodies are (`bodyBuild.worker.ts` gets a second task, "beast",
  in a file of its own so the humanoid's is not changed): the geometry, the atlas layout and the
  paint base are plain numbers from plain data. The page gets the result and paints only the
  individual's coat in 4 ms slices between frames (`sliceBreak`).
- **Cached by kind and seed.** A body's key is the plan (by identity), the geometry's parts and
  scale class (sizes in steps, so fifty wolves are a few dozen bodies, not fifty), and the
  palette hash for the atlas, bounded by size and least-recently-used out as the humanoid caches
  are. A wolf pack of three of one variant shares one geometry (a mesh clone with its own scale),
  with a painted atlas each (small: 256, about 20 ms) unless the palettes are the same.
- **Smaller than humanoids**: a beast target of about 600-900 triangles for a quadruped and about
  1000 for a spider (eight legs), and a 256 atlas.
- **Measured at the end, reported in this file**: a camp of 8 beasts and a village with 10-14
  wandering animals appearing at once: the main thread's longest frame, total main-thread ms and
  time to the last beast drawn, from `__bodyTiming` and a probe that adds the creatures, against
  the humanoid baseline of the *Caches* section.
- **Many on screen**: instances where the same cached body is drawn (thin instances are not
  usable with skinning, so mesh clones sharing geometry and skeleton posing per beast); a beast far
  away is not animated every frame (every third frame beyond 60 m, not at all beyond 120 m).

## Workbench

A **Beasts** line-up in the existing workbench (the same Line-up and Model patterns, a
`?asset=core/beasts/wolf` page): every plan side by side, **all five at several seeds** in a row
(wolf, boar, spider, bear, ant x 4-5 seeds), with a *Play* menu - idle, walk, run, bite/claw/gore/
web, flinch, die - a speed slider, wireframe, bones and an Atlas view, and Stats (triangles per
part). Editing the plan's json5 rebuilds it, as for races. The user judges looks and gaits here, and
numbers are tuned from that.

## Code

| File | What |
|---|---|
| `src/character/beast/beastDef.ts` | `beasts/` plans: parsing, checks, ranges (as `raceDef.ts`) |
| `src/character/beast/beastSkeleton.ts` | Trunk and limb-set rigs from a plan (any counts) |
| `src/character/beast/beastMesh.ts` | Torso, head, jaw, tail and limb chains, junction patches, parts, skinning, lattice |
| `src/character/beast/beastPaint.ts` | The atlas: layout, base coat, patterns, features |
| `src/character/beast/beastCards.ts` | Alpha cards: placing, card meshes, painted masks, sway, tentacle chains |
| `src/character/beast/beastGait.ts`, `beastAnimation.ts` | Gaits sampled from baked keyframes, attacks, hit and death |
| `src/character/beast/beastBake.ts` | The IK baker: gait data and rig to looped FK keyframes (offline or in the worker) |
| `src/character/beast/beastMake.ts` | `makeBeast` (worker-safe) and the cache keyed by plan, parts and palette |
| `src/character/beastBuild.worker.ts` | The pool's task for beasts |
| `src/game/beastBody.ts` | The body drawn in the game, CharacterBody-shaped |
| `src/game/entityMeshes.ts` | Chooses a beast factory when the look names a plan (small) |
| `src/sim/rules/gameRules.ts` | `EntityLook.beast` and `bodyTraits` read (small) |
| `src/workbench/beastLineup.ts` | The Beasts line-up |
| `public/packs/core/beasts/{wolf,boar,spider,bear,ant}.json5` | The five plans |
| `public/packs/core/creatures/*.json5` | `look.beast` and per-variant body options |
| `scripts/probe/beast.mjs` | Builds each plan at several seeds in Node: triangle counts, determinism, bones |

## Build steps

Each leaves the game working (dev server with `?play`, probes, `npm run server`, typecheck,
`npm run build`) and gets committed with only its own files.

1. **Plan data and quadruped rig.** `beastDef`, `beastSkeleton`, the wolf's plan; bones only,
   shown in the workbench; the probe checks it builds deterministically.
2. **Quadruped body and atlas.** Meshes from curves, junction patches, head and jaw, tail, skinning;
   the base coat and patterns; wolf, boar and bear plans; the line-up page with Model and Atlas.
   *First thing for the user to look at.*
2b. **Alpha cards.** The card builder, painted masks, alpha-tested material, sway; the wolf's ruff,
   boar's bristles and bear's shag first; a mane and a tentacle chain shown on a test plan in the
   line-up (the spider's leg hair comes with step 4).
3. **Quadruped animation.** Gaits from data baked with IK into keyframes, idle, bite, claw, gore, flinch,
   death; the line-up's Play menu. Tune with the user.
4. **Spider and ant.** Many-limb sets on a segmented trunk, the wave and tripod gaits, bite, web spit and acid spray; the two plans; the line-up. Then a stress plan in the workbench with odd counts (2, 10, a centipede, a no-limb serpent) to prove the generator's range.
5. **In the game.** `beastBody.ts`, the factory in `entityMeshes.ts`, `look.beast` on the five
   species, cue bones, nameplate heights, capsules adjusted. Fight each beast in `?play` /
   `?config=tiny`.
6. **Workers, cache and numbers.** The pool task, the cache, far-away animation throttling; the
   camp and village measurements, reported here.
7. **Wrap up.** BEASTS.md as built, CHARACTERS.md (*Next steps* 6, *Out of scope*), CREATURES.md
   (*Decisions: Bodies*, *Not in this step*), `public/packs/README.md` (the `beasts/` folder), and
   a pack-only test: a fifth beast added with no code (a fox, a second spider plan).

## Size ranges (starting numbers, tuned in the line-up)

| Beast | Body length | Height at shoulder | Individuals vary | Capsule (height x radius) |
|---|---|---|---|---|
| Wolf | 1.3-1.6 m | 0.9-1.0 m | size +-12%, build lean to sturdy, ruff on some, saddle or blaze | 1.0 x 0.55, kept |
| Boar | 1.2-1.5 m | 0.85-1.0 m | size +-15%, tusks (stub to long), bristle crest | 0.95 x 0.6 |
| Spider | 1.2-1.7 m legspan 2.5-3.2 m | 0.8-1.0 m | size +-15%, abdomen mark, eye cluster | 1.1 x 0.75, kept |
| Bear | 1.8-2.2 m | 1.2-1.4 m | size +-10%, hump, chest blaze, scars | 1.4 x 0.8 |
| Giant ant | 1.4-1.8 m | 0.7-0.9 m | size +-15%, mandible size, abdomen tint, antenna length | 0.9 x 0.7 |

All about 1.5-2x natural proportion in paws, heads and tusks. (The bear is a new species: CREATURES.md
has no bear yet, so the plan adds `creatures/bear.json5` - neutral or hostile in mountain and
forest habitats, a `maul` skill with the claw animation - as the fourth species, with loot and
its habitat in the packs. Needs a confirm below.)

## Later (not in this step)

Birds (wings and a flapping gait), serpents (limbless chains), flyers, big cats and horses/mounts
as more plans; sit and sleep poses if not cheap; more fantastical add-ons (glowing eyes, spines,
extra heads, as traits adding parts); beasts that carry riders; feather cards (the card builder allows them); skinning
corpses; instancing with thin instances if skinning allows it; a lower detail far away.

## Open questions for the user

1. **Bear and giant ant**: decided - both are added as new species (`bear.json5`, `ant.json5`) with
   skills, loot and habitats in the core pack.
2. **Leg IK**: decided - none at runtime; IK only bakes the gait keyframes.
3. **Size ranges** in the table above: right as a start? (Tuned in the line-up anyway.)
