# Prop effects

The plan for flames, smoke and embers on props: the wall torch, candles, sconces, the fireplace - and
anything a pack or a mod names later (braziers, campfires, chimneys, cauldrons). **Not built yet - it
waits for approval; the open questions are at the end.**

## 1. What exists

**Particles** (FEEDBACK.md, *Particles*; `src/particles/`). Effects are pack data (`particles/*.json5`):
a list of emitters (sprite or mesh, blend `add`/`alpha`, rate/burst, life, shape, curves for size and
colour, `local`, `hold`...). `system.ts` simulates every particle on the CPU in flat typed arrays
allocated once (3000 sprites, 600 meshes, `feedback.json5` `particles`); `render.ts` draws all of them
as four thin-instanced meshes, so any number of effects is four draw calls. `spawn(effect, attachment,
{count, size, own})` returns a handle (`stop`, `kill`); a looping effect runs until stopped; the
attachment is a function asked every frame. Textures are generated into one atlas
(`particleTextures/`); `flame` (teardrop with noise, 3 variants), `smoke`, `softDot`, `spark` are
already there, and `burning.json5` is a small looping flame-and-smoke effect. When the pool is full,
non-`own` particles are dropped first, so ambient fires always lose to the player's own fight.
`spawn` refuses an effect farther than 60 m from the camera - but only at the start; nothing stops a
looping one that is already running when the camera leaves. The system lives in `game/feedback.ts`
(`particles.update(dt, eye)` each frame, `clear()` on dimension change); the dev page `fx.html`
(`src/fxPage`) plays effects standalone and is the model for building one outside the game.

**Cues** (`cues/*.json5`) bundle `sound`, `particles`, ... for an event, played `at` a place; a sound
may `loop` (`cues/burning.json5` does) and is placed through a panner (`audio/sfx.ts`, listener on the
camera).

**Props** (`public/packs/core/props/*.json5`, `src/world/props/`). A prop def names a `generator`
(TypeScript in `generators/*.ts`, mostly `furniture.ts`), settings, `parts` (paints), `mount`
(floor/wall/ceiling) and an optional **`light`**. The generator builds geometry into a `ModelBuilder`
and calls `ctx.light(at)` where a flame burns; that pushes onto `BuildingModel.lights`, which
`ModelBuilder.append` carries into a house's model (placed with the furniture), and from there into
the lightmap bake (LIGHTS.md), `buildingRenderer.worldLights` and the dungeon meshes
(`dungeonMeshes.ts`, `setExtraLights`). The flames themselves are **geometry**: `flame()` in
`furniture.ts` lays two crossed lathe slivers painted with the `flame` building material (a `glow`
material: lit by itself, static). So a lit prop already knows, in model space, exactly where each
flame is. Props in question: `wallTorch` (crypt corridors; also the dungeon kit's torches), `candles`
(some burnt out - no flame, no light), `sconce`, `lantern`, `altar`, `fireplace`, `stove`,
`chandelier` (another session's, untracked).

**Houses and streaming.** Every house/prop is one near mesh and one far mesh; `buildingRenderer`
enables the near mesh within `FAR_DETAIL_DISTANCE` each frame, and builds the model (and so lights) the
first time. Furniture is part of the house's near model, so it streams in and out with it.

**Lights are already decided** (LIGHTS.md): baked into a per-house lightmap with shadows, plus the
three nearest as real point lights on the player only. No flicker yet (its plan: a fire channel in the
lightmap modulated by one time function).

**Time and weather.** `world.getTimeOfDay()` (hours), `weather` (rain, wind blended per area),
`setUnderground` for dungeons. Options window: `hud.options.graphics` (draw distance, trees, grass,
shadows...).

**Where a hook fits.** The same place the lights go: a generator says "a flame is here", the model
carries it with the house, the renderer knows which houses are near. Effects are a second consumer of
that list.

## 2. Data model

### In a prop's file

```json5
// props/wallTorch.json5
{
  light: { ... },                          // as now
  effects: [
    { mount: "flame",                      // a mount point the generator lays (below)
      effect: "flame.torch",               // a particles/ effect, looping
      extra: ["smoke.torch", "embers"],    // only at high quality
      scale: 1,                            // on top of the mount's own size
      offset: [0, 0, 0],                   // metres, in the mount's frame
      sound: "fireCrackle",                // optional, see 4
    },
  ],
}
```

A mod's prop uses the same keys with its own generator or an existing one; a mod's particle effects
are just more files in `particles/`. Nothing about which prop gets which effect is in code.

### Mounts, from generators

`ctx.mount(name, at, size)` beside `ctx.light(at)`: names a place on the model (`at` in model space,
`size` = the flame's radius and height in metres, so a big fire gets big effects without the pack
saying so). It lands in `BuildingModel.mounts`, carried by `ModelBuilder.append` and placed with the
house exactly as lights are. A generator that builds no flame (a burnt-out candle) lays no mount, so
no effect - the static world already says which candles burn. Because every flame in
`furniture.ts` goes through the one `flame()` helper, laying the mount there covers the torch,
candles, sconce, fireplace, stove, altar, chandelier and lantern in **one place**; a prop's `effects`
then decides which of its mounts get something. A generator may name other mounts (`"chimney"` on a
house's flue, `"cauldron"`) - the pack's `mount:` picks them.

### Authoring the effects

New files only, nothing in code beyond what is below:

- `particles/flame.torch.json5`: a looping effect, three emitters - the licking tongues (`flame`
  sprite, add, a short upward life, `size` curve shrinking), a hotter small core, and a faint warm
  `softDot` halo (a big, very low-alpha sprite: the **fake glow**, the same on every fire).
- `particles/smoke.torch.json5`: a thin dark `smoke` column, `alpha` blend, slow, 1.5-2 s life.
- `particles/embers.json5`: a few `spark`/`ember` motes drifting up, very low rate.
- `flame.candle`, `flame.fire` (the hearth: a wider `box`/`sphere` shape, more tongues, logs' glow).
  Sizes follow the mount's size via `SpawnOptions.size`.
- Probably **no new textures**; if the flame sprite looks too round, a `flameTongue` variant of the
  `flame` kind (taller, more tapered) - a parameter change, not a new kind.

Small engine changes (shared files, kept minimal): `spawn(..., {still: true})` so a fixed attachment
skips the per-frame vector copy and velocity estimate; nothing else in `system.ts`.

## 3. Cost

Thousands of mounts exist; only a few dozen may run. Rules, all in one manager
(`src/world/props/propEffects.ts`, owning the handles; created with the world, given the particle
system):

- **Only near houses.** The mount list lives with each house like its lights. Each frame the manager
  walks the houses once (the renderer already does, for the near/far mesh switch) and activates a
  house's mounts only while its **near mesh is shown** and it is within the effect distance (about
  35 m, 20 on low); it stops them with a small hysteresis. A house streamed out takes its effects
  with it; streamed in, it starts them. No effect lives on a far model, and none behind the camera
  (a dot test) beyond a few metres.
- **A cap on running effects** (48 high, 16 low), nearest first, re-chosen every few frames, not
  every frame. Players see fires within ~30 m; beyond that the **geometry flame** (already there,
  glowing) is the whole look - that is the "far" version of the effect for free.
- **Indoors inside walls.** An interior's effects only run while the player is in or near that house
  (walls block sight; the existing near-mesh test is enough).
- **Particle cost.** A torch is about 6 live sprites, a candle 2-3, a hearth 20-30. Fifty running
  effects is a few hundred sprites: 4 draw calls as now, a few hundred particle steps on the CPU.
  The pools are shared with combat and ambient fires are `own: false`, so a fight evicts them, never
  the reverse. Measured, not guessed (see 5).
- **Memory.** No new textures or buffers (the atlas is shared and the pools preallocated); per mount a
  small record; handles only for running effects. No geometry, no per-instance material.
- **Quality setting** in the options window's graphics section: *Flames: Low / Medium / High* (no Off; see Decisions) -
  distance, cap, and whether `extra` (smoke, embers) and the halo run. Off still leaves the geometry
  flame. Stored with the other view settings.
- **Light: the fake.** Real lights are already budgeted (baked + three on the player), so effects add
  **none**. The glow is (a) the halo sprite in the effect, additive, costing a few fill pixels; (b)
  the `flame` material's own `glow`; (c) later, the lightmap's fire flicker from LIGHTS.md - the
  manager exposes one shared `fireFlicker(t)` so the halo and the baked light can breathe together.
  A baked light card or emissive decal on the wall was considered and rejected: the lightmap is
  already that, with shadows.

## 4. Behaviour

- **Static in the saved world.** Which props exist and which candles burn is their seed's; the
  manager derives everything from the model, so nothing is saved and no per-instance state exists.
- **Time of day.** `when: "always"` (crypt torches, hearths, indoor candles: the lightmap is baked lit
  regardless of the hour, and windows already dim by their own rule), or `"night"` for outdoor
  fires (campfire, braziers, lamps), fading the effect with the sun. An outdoor `night` fire would
  still have a baked/outdoor light by day - the outdoor lights list (LIGHTS.md, phase 6) should take
  the same switch; until then outdoor fires are lit always, or I leave them out.
- **Occupied house.** The fireplace being lit "when someone is home" needs the simulation's notion of
  occupancy, which props do not have. v1: a hearth burns always (as its light does); a later `when:
  "occupied"` can read the NPC home state - flagged, not planned.
- **Rain and wind** (cheap): outdoors only, the manager scales an open flame's `count`/`size` by
  `1 - 0.6*rain` and leans the smoke with the weather's wind (`direction` is per emitter; one
  shared uniform lean is simpler than per-effect). Interiors and dungeons ignore both. Optional,
  late.
- **Sound.** `sound: "fireCrackle"` names a looping sound (synthesised, like `burning`), played at
  the mount through the existing panner. Only the **nearest 3-4** fire sounds exist at once, gain
  by distance, faded in and out; a house's hearth is heard, a hall of 20 torches is one or two
  voices. Needs a new `sounds/fireCrackle` (and a quieter candle variant); checked against the
  voice budget in `audio/sfx.ts`.
- **Dungeons.** Crypt torches go through the same mounts; `dungeonPresence` already hands the
  world its lights, and hands the manager its mounts the same way. Underground ignores time and
  weather.

## 5. How to look at it and check it

- **Workbench** (`workbench.html`, props/buildings preview): create a particle system from the pack
  rules as `fxPage` does and run the manager on the previewed prop with the preview camera as the
  viewer - so a flame is seen on the torch while it is edited. Edits to `effects` in the pack
  hot-reload.
- **`npm run shot -- props/wallTorch`**: shots are still frames; I add a warm-up of N simulated
  seconds (the system runs in Node - `particles/system.ts` imports no Babylon) before the capture so
  the flame is mid-lick, and a `fx=off` switch to compare with the bare geometry. Contact sheets of
  torch, candles, fireplace, sconce. This judges **shape, colour, size**.
- **Numbers, not eyes, for motion and cost:**
  1. a Node probe stepping the system with 100-500 looping instances for 10 simulated seconds:
     ms per update, live particle counts, allocations (should be none after warm-up);
  2. a workbench/game stress scene with hundreds of mounts around the camera: frame time with the
     manager off / low / high, `performance.memory` before and after, baselined from a worktree as
     in the timing notes (never from a stash);
  3. the crypt, a town interior and a street with chimneys.
- **What I cannot judge:** the Browser pane draws a few frames a second, so I cannot see flicker,
  flame motion or whether smoke rises at a good speed; I judge those from the numbers (life, speed,
  size curves read as a table) and short sequences of shots, and say so. Whether the effect *feels*
  right is your call in the running game.

## 6. Steps

1. **A flame on the torch, in the workbench.** `PropDef.effects` read from packs; `ctx.mount` in
   `flame()`; `BuildingModel.mounts` carried by `append`; `flame.torch` effect; the manager minimal
   (no culling) in the workbench's prop preview. Shots of the torch.
2. **In the game.** The manager in the world: per-house activation with distance and a cap; crypt
   torches (dungeon path) and town interiors. Candles, sconce, lantern.
3. **The fireplace and stove**, and smoke; `flame.fire`; chimney smoke if you want it (below).
4. **Quality option** in the graphics options, and the stress measurements written up.
5. **Sound** (fire crackle, nearest few).
6. (dropped: time of day, weather, flicker - see Decisions)

If it grows: cut 6, then 5, then smoke/embers (keeping flames), then the quality option's Off/Low
split (one cap only). Steps 1-2 alone give the visible result.

## Working notes

- Files I touch in shared code: `propTypes.ts`, `propGenerator.ts`, `buildingGeometry.ts` /
  `buildingTypes.ts` (mounts beside lights), `furniture.ts` (one line in `flame()`),
  `resolveContent.ts` (reading `effects`), a hook in `buildingRenderer.ts`, the dungeon meshes' list,
  and a few lines in the session wiring. The caves-and-dungeons session has uncommitted edits in
  `furniture.ts`, `kitMesh.ts`, `dungeonDefs.ts` and the workbench; I will commit only my own hunks
  (`git add -p`) and not touch their files before they land if I can avoid it.
- New files are mine alone: `propEffects.ts`, `particles/flame*.json5`, `smoke*.json5`, `embers.json5`,
  this doc.

## Decisions (the owner's, 2026-11-16)

- Effects are **always on**, whatever the time of day (and weather): no `when`, no night/occupied
  switching, no rain or wind scaling. Step 6 is dropped.
- **Sound only for large fires** (fireplace, stove, campfire, brazier): `sound` is set on those
  props' `effects`, never on torches, candles or sconces.
- **No light flicker**; the lightmap and the flame material are left as they are. No shared
  `fireFlicker`.
- **Quality has no Off**: *Flames: Low / Medium / High*. It changes the **cutoff distance** (20 / 30 /
  45 m) and with it the cap on running effects (16 / 32 / 48); `extra` effects (smoke, embers) and the
  halo run on Medium and High. Geometry flames are always there.
- Not answered, so I go with the proposals: chunky bold flames; a faint smoke wisp on torches (High);
  chimney plume later if wanted; no real lights added.

## Status

- Step 1 (done): `effects` on a prop, `ctx.mount` laid in `flame()`, `BuildingModel.effects` carried
  with the house, `propEffects.ts` (distance/cap by quality), `flame.torch` + `smoke.torch`, run in the
  workbench (`workbench/propFx.ts`).
- Step 2 (done): the game. `World.effectGroups` (each house's flames, shown while its near mesh is),
  the manager in `game/feedback.ts` (`feedback.flames`), a dungeon's flames added by
  `dungeonPresence`. Torch, candles, sconce, altar, chandelier (`flame.candle`), fireplace and stove
  (`flame.fire`, `embers`). The placeholder flame mesh is gone - a prop that names no effect burns
  unseen, and beyond the cutoff distance a flame is not drawn at all.
- Quality is still fixed at High; the options-window setting, the measurements and sound are next.
