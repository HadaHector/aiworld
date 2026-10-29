# Feedback

The plan for the game's feedback: sound effects, particle effects and hit feel, driven by pack data
and tied into the ability system. It runs alongside step 8 of [GAMEPLAY.md](GAMEPLAY.md)'s build
order (disciplines and progression). Step 8 works in the server, so this one stays on the client,
in pack data, and in one field of skill definitions. When it is done, a fight with a wolf or the
training dummy on `?config=tiny` sounds and looks like a fight: swings whoosh, hits land with a
sound that depends on the weapon and what it struck, the struck body flashes and flinches, a
fireball roars in the caster's hands, flies, and bursts on its target, a crit shakes the camera
and pauses for an instant, deaths thud, and loot glints and chimes. A dev page plays every cue,
sound and particle effect on its own, so it can be tuned.

**Status: done** (steps 1-7). [As built](#as-built) notes where the build differs from this plan.

## Decisions

| Question | Decision |
|---|---|
| Hit feel | **Classic, with punch.** Every hit gets a sound, a flash and a small flinch. Camera shake and a short hit pause (30-60 ms) only for crits, big hits and Charge, and only in the player's own fights. Packs can make it stronger |
| Sounds for now | **Stylised synth.** Clearly synthetic but pleasant, rendered from recipes in packs. Samples will replace or layer over them later, and may change the style a lot; that is accepted |
| Particle look | **Both, per emitter.** An emitter draws either camera-facing sprites with generated textures (soft dots, sparks, smoke, rings, runes) or small flat-shaded meshes (shards, chips, embers) |
| Whose fights | **Own fights loudest.** Every unit in view gets its sounds and effects. Fights the player is in (its hits, hits on it, hits on its target) play at full volume with screen effects; others' are quieter, with fewer particles and no shake or pause |
| What drives it | **The combat events that exist.** The client maps events to cues and reads skills' `cues` field from the rules it already loads. The server gains no new event; the `effect` action (ABILITIES.md) names a cue for any moment a state wants one |
| Randomness | Cosmetic: pitch, volume and particle scatter come from a client-local stream, not the world seed. Nothing reads them back, so clients may differ |

## Principles

- **Client only, except one field.** Everything here is drawn and heard on the client. The only
  change in `src/sim` is that skill definitions accept a `cues` field (and entity looks a
  `feedback` field) and pass them through untouched; the server never reads them. A headless
  server loads packs with cues it does not use, and a client without a cue plays nothing for it.
- **Data first.** Sounds, particle effects, particle textures, cues and the mapping from events to
  cues are json5 in packs. The code knows generators, emitters, attachments and phases, never a
  fireball or a wolf by name. Modders use exactly what core uses.
- **Generated now, recorded later.** Every sound is a recipe of layers. A layer is either a synth
  recipe or a sample file. A pack adds samples over a sound without touching what names it, and
  generated layers marked `standIn` drop out once a sample layer has loaded.
- **Reuse the music's audio.** One `AudioContext` for the game, shared with the music player. Synth
  recipes are rendered to sample buffers in plain JS, as `src/music/instruments.ts` renders its
  synths, so they render in Node for the probe and cost nothing at play time.
- **Budgets, not hopes.** A voice limit for sounds, a particle budget for sprites and meshes, pools
  for both, and quieter, sparser feedback for fights that are not the player's own. Twenty players
  fighting in one place must not drop frames.
- **Readability over spectacle** (GAMEPLAY.md). Feedback says what happened: who hit whom, how hard,
  with what. A crit is louder and bigger than a hit; a hit on the player sounds different from a
  hit by it.

## Pack folders

New folders, read on the client only (the world's and the game rules' resolvers skip them, as they
skip `races/`):

| Folder | What it holds |
|---|---|
| `sounds/` | A sound: its layers (synth recipes or samples), bus, variation, falloff and voice limit |
| `particles/` | A particle effect: its emitters, one-shot or looping |
| `particleTextures/` | A generated texture for sprites: a kind (dot, spark, smoke, ring, rune...) and its parameters |
| `cues/` | A cue: the parts that play together - sounds, particle effects, flash, flinch, shake, pause |
| `rules/feedback.json5` | Which cue each event plays, surfaces for footsteps, weapon and armour kinds, mixing, budgets |

Samples sit in `packs/<pack>/sfx/`. The pack index lists them as MUSIC.md planned for instrument
samples, so editing one reloads the page.

## Cues

A cue is what plays together for one moment of a fight:

```json5
// cues/fireImpact.json5 - Fireball bursting on its target
{
  parts: [
    { sound: "impact.fire", at: "target" },
    { particles: "fireBurst", at: "target", bone: "chest" },
    { flash: [1, 0.55, 0.2], at: "target", time: 0.12 },
    { flinch: 0.6, at: "target" },
    { shake: 0.3, when: { crit: true } },        // camera parts only ever play in own fights
    { pause: 0.05, when: { crit: true } },
  ],
}
```

| Part | |
|---|---|
| `sound` | A sound id, played at the part's place. May hold placeholders (below) |
| `particles` | A particle effect id. Looping ones last as long as the cue's phase (a cast, an aura) |
| `flash` | A colour the unit's meshes are tinted toward for `time` seconds, fading out |
| `flinch` | 0-1: the unit's body jerks away from the source (*Hit feel*) |
| `shake` | 0-1 of trauma added to the camera |
| `pause` | Seconds the source's and the target's animations stop for (*Hit feel*) |

Every part may have:

- **`at`**: `source`, `target` (the event's), or `point` (an `effect` aimed at the ground), and
  **`bone`**: `chest` (default), `head`, `feet`, `mainHand`, `offHand`, `hands` (between both),
  `weapon` (the main hand's weapon tip). Capsules have no bones; each bone maps to a height on the
  capsule and, for hands, a side.
- **`when`**: conditions on the event - `crit`, `periodic`, `own` (the player's own fight), `role`
  (`dealt`: the player is the source; `taken`: the target). A part whose `when` fails is skipped.
- **`delay`**: seconds after the cue starts (a death's thud lands when the body does).
- **`scale`**: a number, or `amount` - grows with the hit's size relative to the target's maximum
  health, so a big hit shakes more than a tick.

**Placeholders.** A sound or particle id may name the event's details in braces:
`"hit.{weapon}.{armor}"`. It is resolved most specific first, dropping a part from the end each
time it is not found: `hit.blade.mail`, then `hit.blade`, then `hit`. So core can give a few
specific sounds and a general one, and a pack adds more without touching any cue. The details:

| Name | From |
|---|---|
| `weapon` | The source's main-hand item type, through `rules/feedback.json5`'s `weapons` (by item template or gear piece: sword → `blade`, mace → `blunt`), else its look's `feedback.weapon` (`fang`, `claw`, `tusk`), else `unarmed` |
| `armor` | The target's chest item's gear material, through `armors` (mail and plate → `metal`, linen → `cloth`), else its look's `feedback.armor` (`fur`, `chitin`, `wood`), else `flesh` |
| `family` | The look's `feedback.family` (`wolf`, `spider`, `humanoid`): deaths and creature voices |
| `school` | The skill's `school.*` tag (`fire`, `holy`), else `physical` |
| `surface` | Footsteps only: the ground under the foot (*Footsteps*) |

## Cues in skills

A skill names a cue for each **phase** it wants one for. The client finds the phases in the events
it already gets:

```json5
// skills/fireball.json5 gains
cues: {
  cast: "fireCast",          // loops in the caster's hands from castStart until the cast ends
  release: "fireRelease",    // castDone: the cast went off
  projectile: "fireBolt",    // flies from the caster's hands to the target at the travel speed
  impact: "fireImpact",      // its hit (or miss) lands
},
// skills/burn.json5
cues: { applied: "burnCatch", aura: "burning", tick: "burnTick", faded: "" },
```

| Phase | Plays on |
|---|---|
| `cast` | `castStart` with a bar: loops at the caster until `castDone`, `castStopped`, `interrupted` or `castFailed` |
| `channel` | The same for a channel bar |
| `release` | `castDone`: the moment the cast commits - instants too |
| `projectile` | `castDone` of a skill whose committing state's length is `{ travel: speed }`: a looping cue that moves from the caster's `hands` to the target's `chest` at that speed, following the target, ending when the hit arrives (or after its time plus 0.3 s) |
| `impact` | A `hit`, `miss`, `heal` or `absorbed` event carrying the skill |
| `tick` | The same with the `periodic` flag; `impact` if left out |
| `applied`, `aura`, `faded` | `auraOn`: one-shot, then `aura` loops on the host until `auraOff`, then `faded` |
| `swing` | The skill's `animation` event: a whoosh as the body swings |

- **The `effect` action is a cue by name.** `{ do: "effect", name: "totemPulse" }` in any state
  plays the cue `totemPulse` at its group; it already sends an event. A skill uses it for moments
  the phases above do not cover.
- **Auras only the host's frame shows are seen.** `auraOn` and `auraOff` are sent for displayed
  magics (`display: "buff"` or `"debuff"`). A hidden magic that wants a look uses `effect`.
- **Checked at load, on the client.** Every cue a skill names must exist: a missing one is a content
  error naming the skill and the phase, as with any other reference, but only where cues are
  loaded (the page and the probe). The server accepts the field and checks only that it is an
  object of strings.

## The event table

What a skill does not say, `rules/feedback.json5` does. Each event kind has a list of rules,
first match wins, matched on the skill's tags, the event's flags and its name:

```json5
// rules/feedback.json5
{
  events: {
    hit:         [{ tags: ["melee"], cue: "meleeHit" }, { tags: ["school.fire"], cue: "fireHit" }, { cue: "spellHit" }],
    miss:        [{ tags: ["melee"], cue: "whiff" }, { cue: "spellMiss" }],
    heal:        [{ cue: "heal" }],
    absorbed:    [{ cue: "absorb" }],
    interrupted: [{ cue: "interrupt" }],
    castFailed:  [{ cue: "error", role: "dealt" }],
    death:       [{ cue: "death" }],
    animation:   [{ name: "swing", cue: "swing" }],
    // client events: things the client sees happen, not combat events
    lootable:    [{ cue: "lootGlint" }],             // loops over a corpse or chest while it has loot
    lootOpen:    [{ cue: "lootOpen" }],
    itemTake:    [{ rarity: ["rare", "epic", "legendary"], cue: "itemTakeRare" }, { cue: "itemTake" }],
    moneyTake:   [{ cue: "coins" }],
    itemDrop:    [{ cue: "itemDrop" }], itemPickUp: [{ cue: "itemTake" }],
    equip:       [{ cue: "equip" }], use: [],
    target:      [{ cue: "targetTick" }],
    footstep:    [{ cue: "footstep" }],
    // later: levelUp, disciplineUp, questAccept, questDone, discovered - added by the steps that make them
  },
  weapons: { sword: "blade", axe: "blade", dagger: "blade", mace: "blunt", staff: "blunt" },
  armors:  { linen: "cloth", wool: "cloth", leather: "leather", studdedLeather: "leather", mail: "metal", plate: "metal", bronze: "metal", fur: "fur" },
  surfaces: { "*Grass": "grass", "*Sand": "sand", "snow*": "snow", cobblestone: "stone", "*": "dirt" },
  mix: { master: 0.8, combat: 1, footsteps: 0.45, ui: 0.6 },
  voices: 28,                               // sounds playing at once, at most
  particles: { sprites: 3000, meshes: 600 },
  others: { volume: 0.5, particles: 0.5 },  // fights the player is not in
}
```

- **A skill's own cue comes first.** A hit carrying Fireball plays Fireball's `impact`; a hit
  carrying a skill with no `impact` falls to the table.
- **Both may play.** A skill's cue can set `table: true` to play the table's cue as well (a melee
  skill that adds its own flourish over the ordinary hit).
- **Events that hit many targets at once** (Thunder Clap) play a cue's sound once per source per
  50 ms, a little louder, and its particles on each target.
- **Later events** - a level gained, a quest done - are new keys in `events`. Step 8 and the quest
  step add a client event where they show something, and the table plays it; no feedback code
  changes.
- **`rules/feedback.json5` is replaced whole by a later pack**, as the other rules files are.

## Sounds

```json5
// sounds/swing.json5 - a whoosh
{
  bus: "combat",
  near: 3, far: 40,          // full volume within near, silent beyond far
  maxVoices: 4,              // of this sound at once; the oldest stops
  pitch: [-1.5, 1.5],        // semitones of variation per play
  volume: [0.8, 1],
  takes: 4,                  // the generated layers are rendered this many times from different seeds
  layers: [
    { synth: { noise: "pink", filter: { type: "bandpass", from: 500, to: 2200, q: 1.5 }, env: { attack: 0.06, decay: 0.2 } }, standIn: true },
    { sample: ["sfx/swing1.wav", "sfx/swing2.wav"] },     // later: picked among, at random
  ],
}
```

**Synth generators**, small and composable, each with its own envelope, pitch curve and gain, and
an optional start `delay` so layers can follow one another:

| Generator | Good for |
|---|---|
| `tone` | An oscillator (`sine`, `triangle`, `square`, `saw`) with a pitch sweep: zaps, blips, falling deaths |
| `noise` | White, pink or brown noise through a filter that can sweep: whooshes, roars, rustles, footsteps |
| `modal` | A bank of decaying partials at given ratios: clangs, bells, chimes, wood knocks, coins |
| `fm` | A carrier and a modulator with an index envelope: magical shimmer, metallic stings |
| `pluck` | The music's Karplus-Strong string: twangs, plucked UI sounds |
| `crackle` | Random clicks at a density: fire, embers, gravel |

Shared effects on a layer or the whole sound: `drive` (soft clip), `crush` (bit depth and rate - the
stylised edge), `vibrato`, `tremolo`, `echo`. A sound renders each take once, the first time it is
needed, into an `AudioBuffer`; a looping sound (a cast, a burning aura) is rendered with a
crossfaded loop.

**Playing.** Each play picks a take, a pitch and a volume, and goes through a `PannerNode` placed
at its cue part's place, with the camera as listener: equal-power panning and a linear falloff from
`near` to `far` (simple and predictable to tune), a gentle low-pass with distance. UI sounds are not
positioned. Buses (`combat`, `footsteps`, `ui`, `ambient`) each have a gain from `mix`, under an
**Effects** volume next to the music's in the corner control.

**The voice limit.** At most `voices` sounds play at once. A new sound beyond that steals the
quietest playing one, after distance and the `others` factor; a sound in the player's own fight
outranks one that is not. Sounds beyond `far` are not started at all.

**Samples later.** A layer with `sample` lists files in the pack's `sfx/`, one picked at random per
play. When any sample layer of a sound has loaded, its `standIn` layers stop playing; layers not
marked play over the samples (a generated magical shimmer over a recorded thud). A later pack
replaces a sound by giving the same id, as with any pack file. Nothing that names the sound changes.

## Particles

```json5
// particles/fireBurst.json5 - one burst of flame, embers and smoke
{
  loop: false,
  emitters: [
    { sprite: "softDot", blend: "add", burst: 24, life: [0.3, 0.6],
      shape: { sphere: 0.25 }, speed: [2, 5], gravity: -1, drag: 2,
      size: [[0, 0.35], [1, 0.05]], colour: [[0, "#fff4c0"], [0.25, "#ff9020"], [1, "#a0200000"]] },
    { sprite: "smoke", blend: "alpha", burst: 6, delay: 0.08, life: [0.8, 1.3],
      speed: [0.4, 1], gravity: 0.8, spin: [-1, 1],
      size: [[0, 0.4], [1, 1.3]], colour: [[0, "#40302880"], [1, "#30302800"]] },
    { mesh: "ember", blend: "add", burst: 10, life: [0.6, 1], speed: [3, 6], gravity: -6, stretch: 0.04,
      size: 0.05, colour: [[0, "#ffd060"], [1, "#ff402000"]] },
  ],
}
```

| Emitter field | |
|---|---|
| `sprite` or `mesh` | A texture from `particleTextures/` drawn as a camera-facing quad, or a built-in low-poly shape: `shard`, `chip`, `ember`, `cube`, `leaf`, `ring` |
| `blend` | `add` (glows), `alpha` (smoke, dust, shards) |
| `rate`, `burst` | Particles per second while it runs, and/or a count at once (`[{ at: 0.2, count: 8 }]` for several) |
| `delay`, `duration` | When it starts, and how long it emits; a looping effect's emitters run until it is stopped |
| `life` | Seconds each particle lives, a range |
| `shape` | Where particles start, around the attachment: `point`, `sphere`, `ring`, `cone`, `box`, `line` (to the target, for beams) |
| `speed`, `direction`, `spread` | Initial velocity: outward from the shape by default |
| `gravity`, `drag` | Metres per second squared down (negative rises); a slowing factor |
| `size`, `colour` | A number or a curve over the particle's life (`[[t, value], ...]`); colours with alpha (`#rrggbbaa` or `[r, g, b, a]`) |
| `spin`, `stretch` | Rotation speed; stretching along the velocity (sparks, streaks) |
| `local` | Particles move with the attachment (a ring around a body) instead of staying where they were born (a trail) |
| `inherit` | How much of the attachment's own motion particles take on |

**Generated textures** are baked once into one atlas (1024², greyscale with alpha, tinted by the
colour curve):

```json5
// particleTextures/rune.json5
{ kind: "rune", size: 64, variants: 6, strokes: [3, 5], ring: true, glow: 0.35 }
```

Kinds: `dot` (a soft falloff, its power a parameter), `spark` (a streak), `star` (points, sharp or
soft), `smoke` (a noise puff, seeded per variant), `flame` (a teardrop with noise), `ring` (radius,
width, softness), `rune` (strokes snapped to a grid inside a circle, seeded per variant), `slash`
(an arc for a swing trail). A particle picks among a texture's variants at random.

**Drawing.** All sprites of one blend mode are one thin-instanced quad mesh with a small billboard
shader reading the atlas; each mesh shape is one thin-instanced mesh per blend mode. So the whole
system costs a handful of draw calls however many effects play. Particles are simulated on the CPU
in flat typed arrays (position, velocity, age, life, emitter), allocated once at the budget's size:
nothing is allocated while a fight goes on.

**The budget.** When the sprites or meshes would go over `particles`, new particles of effects in
others' fights are dropped first, then those farthest from the camera. Fights the player is not in
spawn `others.particles` as many. Effects beyond 60 m are not started.

## Hit feel

- **Flash.** The struck unit's meshes are tinted toward the flash colour and back over its `time`,
  through Babylon's overlay colour on each mesh of the body (or the capsule): no material is
  changed or copied.
- **Flinch.** CHARACTERS.md's animation gains a `flinch` input: a direction (away from the source)
  and a strength. The spine and head jerk back and recover over about 0.2 s, layered over whatever
  else plays, as the swing is. A capsule is pushed a few centimetres away and back. The workbench's
  *Play* menu gains *Flinch*. Dead units do not flinch.
- **Camera shake.** A trauma model: parts add trauma (capped at 1), it decays over about half a
  second, and the shake is trauma squared, as small rotations of the camera and offsets of its
  target from smooth noise. Only in the player's own fights. A **Screen shake** setting (0 to 1,
  0 turns it off) sits by the volume control.
- **Hit pause.** The animation clocks of the source's and the target's bodies, and the particles of
  the cue that asked for it, stop for its length (at most 0.08 s). The world, the camera, movement
  and the server go on: in an MMO a pause is a beat in the bodies, not a frozen game. Only in the
  player's own fights.

## Footsteps

Footsteps come from the bodies' gait. The animation reports each foot coming down (the gait phase
crossing a contact); a capsule steps at a cadence from its speed. The surface under the foot is the
dominant ground material there - from the terrain's material weights, which the client already has
for the ground it draws - turned into a surface by `surfaces` (patterns on material ids, so a new
material named `*Grass` is grass without a change), or a building's floor (`wood` or `stone`), or
shallow water (`water`). The `footstep` event plays `footstep.{surface}` through the table, on the
`footsteps` bus, for the own player and bodies within 25 m.

Core's surfaces: grass, dirt, stone, gravel, sand, snow, wood, water.

## Wiring into the game

What core's content gives each thing in a fight, all of it pack data:

| What | Feedback |
|---|---|
| Auto-attack | `swing`: a whoosh by weapon on the `animation` event, a slash trail sprite on the weapon; `meleeHit`: `hit.{weapon}.{armor}`, sparks (metal) or a puff (cloth, fur), flash, flinch; a crit louder with shake and pause; `whiff` on a miss |
| Heroic Strike, Bash, Gore | The melee hit with a heavier layer and a bigger flinch (`table: true`) |
| Charge | `release`: a rush whoosh and a dust trail at the caster's feet for the rush; Charge Stun's `applied`: a thud, a dust ring, shake and pause in own fights; its `aura`: stars circling the head |
| Fireball, burn | A roaring glow and runes at the hands while casting, a fire bolt with an ember trail, a burst on impact; the burn's flames on the host, a crackle each tick |
| Renew, Shield, Weakened Soul | Holy shimmer and rising motes; Shield a ring around the host while it holds and a glassy break when it is used up (`faded`) |
| Thunder Clap, its slow | A boom and a ground ring at the caster, a flinch on each target; a frosty drift on the slowed |
| Kick, interrupts | A sharp hit and the caster's cast effect snapping out with a broken-glass note |
| Searing Totem | A thump and a dust puff when summoned, a small fire bolt from it to its target each time it shoots |
| Creatures | Bites, gores, the spider's web and venom, the bandits' hex bolt: each skill's `cues`, by species through `{family}` and `{weapon}` |
| The dummy's bolt | A cast glow at its hands, a bolt, an impact on its target: something to kick and something to feel |
| Deaths | `death.{family}`: a falling synth voice by family, a thud and a dust puff when the body lands |
| Loot | The glint over a lootable corpse or chest becomes the `lootGlint` cue (replacing the spinning polyhedron); opening, taking an item (a brighter chime for rare and better), money, dropping and picking up, equipping (cloth or metal), eating |
| UI | Selecting a target, a cast that fails ("not ready", out of range) for the player only |

## Code

| File | What |
|---|---|
| `src/feedback/rules.ts` | Reads `sounds/`, `particles/`, `particleTextures/`, `cues/` and `rules/feedback.json5`, checks every reference (with skills' `cues` and looks' `feedback`), resolves ids to indices. Pure: runs in the page and in Node |
| `src/feedback/cues.ts` | Events to cues: skills' phases, the event table, placeholders, `when`, own versus others, coalescing; starting and stopping looping cues |
| `src/feedback/attach.ts` | Where a part plays: an entity, a bone of its body or a height on its capsule, a point, a moving projectile |
| `src/audio/context.ts` | The game's one `AudioContext`, unlocked on the first input; master and buses. The music's `Player` takes its context and output from here instead of making its own |
| `src/audio/dsp.ts` | Shared DSP: envelopes, filters, noise, oscillators, Karplus-Strong; moved out of `src/music/instruments.ts`, which imports them |
| `src/audio/synth.ts` | Sound recipes to sample buffers, takes and loops |
| `src/audio/sfx.ts` | Playing: takes, variation, panners, falloff, the voice limit, samples and stand-ins |
| `src/particles/textures.ts` | Generated textures and the atlas. Pure pixels, so the probe can check them |
| `src/particles/system.ts` | Pools, emitters, simulation, the budget |
| `src/particles/render.ts` | The thin-instanced sprite and mesh drawers and the billboard shader |
| `src/feedback/feel.ts` | Flash, flinch, camera shake, hit pause |
| `src/feedback/footsteps.ts` | Foot contacts, surfaces |
| `src/game/feedback.ts` | Ties it into the game: the combat events and client events from `main.ts`, the entity meshes and bodies, the camera |
| `src/character/animation.ts` | Gains `flinch` and reports foot contacts |
| `src/sim/rules/skillRules.ts`, `gameRules.ts` | Accept `cues` on skills and `feedback` on looks, as objects of strings, and pass them through |
| `fx.html`, `src/fxPage/` | The dev page |

## Dev page

`fx.html`, beside `music.html` and `workbench.html`: a small Babylon stage and panels, loading the
same packs and reloading on every pack edit, as the workbench does.

- **The stage**: a patch of ground, a caster and a target - each a body (race and outfit chosen) or
  a creature capsule - a few metres apart, the camera orbiting them. A slow-motion slider (0.1-1)
  and a distance slider that moves the camera away, to hear falloff.
- **Cues**: every cue in the packs, in a list with a filter. Play one between the caster and the
  target, as source or target, with toggles for crit, periodic and own, and with the placeholders
  picked (weapon, armour, family, school, surface). Looping cues play until stopped.
- **Skills**: every skill with `cues`, played as a whole: cast for its bar length, release,
  projectile at its speed, impact, applied, aura for a few seconds, faded. *Swing* and *Fight*
  buttons play auto-attacks on a loop, so the rhythm of a fight can be heard.
- **Sounds**: every sound, with play, its takes, its waveform, the layers sounding (generated,
  samples, stand-ins dropped), and the render time.
- **Particles**: every effect, played at a point or attached, with a live count against the
  budget; the texture atlas, with every generated texture and its variants.
- **Meters**: voices playing, particles alive, draw calls.

## The test

**Core content**: the sounds, particle effects, textures and cues for everything in *Wiring into
the game*; core's skills given `cues`; core's looks given `feedback` (the wolf a fang and fur,
the spider a fang and chitin, the boar a tusk and a hide, bandits humanoid, the dummy wood under
its armour).

**In the game** (`?config=tiny`): fight the dummy and wolves with every spell the player knows:
each swing and hit is heard and seen, with weapon and material telling apart a sword on mail from
a bite on fur; a crit shakes and pauses; the fireball casts, flies and bursts; the burn flickers
and ticks; Charge rushes and stuns with stars; the shield rings and breaks; Thunder Clap booms;
kicking the dummy's bolt snaps its cast; the totem thumps and shoots; wolves die with a thud and
their corpses glint; looting chimes and jingles; footsteps change from grass to the road's stone.
A second player from `addPlayer` fighting the dummy is heard more quietly and causes no shake.
Frames stay as they were with three wolves and the totem going.

**Headless**: `scripts/probe/feedback.mjs` (`npm run probe -- scripts/probe/feedback.mjs`):

- **Rules**: core's feedback content loads; broken content (an unknown sound, effect, texture,
  cue, generator, emitter field, a skill naming a cue that does not exist, a bad placeholder) gives
  the expected errors, naming file and path.
- **Sounds**: every core sound renders every take, with no NaN, no clipping past full scale, a
  length within its envelope, and loops that join without a click.
- **Textures**: every core texture renders, not empty, alpha falling to 0 at the edge.
- **Cues**: the fight bot's combat log (ABILITIES.md's fight) mapped to cues, printed, with every
  hit, cast and aura of the rotation finding one.

## Steps

Each leaves the game working: dev server, `npm run probe`, `npm run server`, `npm run build`.

1. **Rules and content, headless.** The pack folders and `rules/feedback.json5` read and checked;
   `cues` on skills and `feedback` on looks accepted in `src/sim`; a first set of core content
   (swing, melee hit, Fireball); synth rendering in `src/audio/dsp.ts` and `synth.ts`, with the
   music's DSP moved there; texture generation. The probe's rules, sounds and textures parts.
   Nothing plays yet.
2. **Sound in the game.** One `AudioContext` shared with the music; buses, 3D playing, variation,
   the voice limit, samples with stand-ins; the Effects volume. `fx.html` with the sounds panel.
   The table wired for swings, hits and misses, so auto-attacks on the dummy are heard.
3. **Particles.** Pools, emitters, the sprite and mesh drawers, the budget; `fx.html`'s stage and
   particles panel and the atlas view. Cues with sound and particle parts and attachments, so
   swings and hits have sparks and puffs in the game.
4. **Abilities.** Every phase - cast, channel, release, projectile, impact, tick, applied, aura,
   faded, swing, `effect` - and core's content for every player spell, the dummy's bolt and the
   creatures' skills, deaths included. `fx.html`'s cues and skills panels. Checked in the game on
   the dummy and wolves.
5. **Hit feel.** Flash, flinch (the animation's input, the capsule's push, *Flinch* on the
   workbench), camera shake with its setting, hit pause; own fights versus others'. Checked with
   a second player fighting the dummy.
6. **Loot, UI and footsteps.** The client events (lootable, loot open, take, money, drop, pick up,
   equip, use, target, cast failed); the glint as a cue; foot contacts and surfaces. Checked in
   the game.
7. **Wrap-up.** `public/packs/README.md` for the new folders, ABILITIES.md's *Not in this step*
   line on effects and sounds, CHARACTERS.md's animation inputs, the probe's cue part on the
   fight log; this file's *As built*; GAMEPLAY.md's feedback step marked done.

## As built

- **Step 1: rules and content.** `src/feedback/rules.ts` reads `sounds/`, `particles/`,
  `particleTextures/`, `cues/` and `rules/feedback.json5` (`FEEDBACK_FOLDERS` in
  `resolveContent.ts`, which the world's resolver skips) and checks them with skills' `cues` and
  looks' `feedback`; `resolveRef` fills placeholders and falls back, `matchesPattern` matches
  surfaces. `SkillDef.cues` and `EntityLook.feedback` are passed through by the game rules as
  objects of strings (`stringMap`) and are not in the rules' hash. The music's shared DSP moved to
  `src/audio/dsp.ts` unchanged, with Karplus-Strong as `pluckString`; `src/audio/synth.ts` reads and
  renders the six generators; `src/particles/textures.ts` draws the eight texture kinds and packs
  the atlas. Feedback ids may have dots (`hit.blade.metal`); other folders' may not.
- **Core content so far**: 9 textures; 10 sounds (swing, whiff, `hit`, `hit.blade`,
  `hit.blade.metal`, `hit.fang`, and Fireball's cast, release, bolt and impact); 6 particle effects;
  7 cues; Fireball's `cues`; `feedback` on the wolf, boar, spider, humanoid, player and dummy
  looks; an event table for melee hits, misses and swings.
- **Colours** in particles and cues take an alpha: `#rrggbbaa` or `[r, g, b, a]`, beside the
  `#rrggbb` and `[r, g, b]` the other pack files use.
- **Texture edges** are clear by pixel, not by radius: the outermost pixels of every texture have
  alpha 0, at every size.
- **The probe** (`scripts/probe/feedback.mjs`, 275 checks, about 2 s): rules, placeholders, 25 kinds
  of broken content, every take of every sound (no NaN, within full scale, not silent, its length,
  dying away, loops joining without a click, the same take from the same seed), every texture
  variant (drawn, clear at the edge, variants differing) and the atlas packing without overlaps.
- **Step 2: sound in the game.** `src/audio/context.ts` makes the page's one `AudioContext` on the
  first click or key press, with a music bus and an effects bus meeting in a gentle limiter; the
  music's `Player` takes its output (`gameMusic.ts` plays into the music bus; the music page still
  plays straight out). `src/audio/sfx.ts` plays sounds: a random take, pitch and volume per play, a
  `PannerNode` (equal power, linear from `near` to `far`) and a low-pass that dulls far sounds,
  buses from `mix`, each sound's `maxVoices` and the overall `voices` (the quietest gives way, the
  player's own fights counted louder), samples fetched from `packs/<pack>/<file>` with stand-ins
  dropping out once one has loaded, and every sound's takes rendered ahead, one sound per task.
  Babylon's world is left-handed and WebAudio's right-handed: z is flipped on the way in.
- **`src/feedback/cues.ts`** maps combat events to cues - a skill's phase (`impact`, `tick`,
  `release`, `swing` so far), else the event table, `effect` by name - and plays their sound parts.
  A source's same sound within 50 ms plays once. **Own fights**: the player is the source or the
  target, the target is the player's target, or - for an event with no target, as a swing has - the
  source is the player's target or is going for the player.
- **`src/game/feedback.ts`** ties it to the game: each unit's weapon (a worn item's template or id,
  else a gear piece, through `weapons`) and armour (the material of the outermost piece over the
  torso, through `armors`), falling back to the look's `feedback`, then `unarmed` and `flesh`;
  bones placed by height on the unit until bodies say (step 3); the listener on the camera.
  `__aiworld.feedback` has it, `feedback.sfx()` the player.
- **The corner control** has an Effects slider (✦) after the music's, kept in
  `aiworld.effects.volume`.
- **`fx.html`** (`src/fxPage/`): every sound - play it varied or take by take, its waveforms (the
  loop shaded), its layers with stand-ins marked, the render time - and every cue, played with crit,
  periodic and own toggled and the weapon, armour and family picked; distance and angle sliders
  move the sound or the cue's target round a listener facing +z; a voice meter and Stop all.
- **Checked in the game** (`?config=tiny`): auto-attacking the dummy plays a swing at the sword and
  `hit.blade.metal` on its chest; a frost wolf's bites play `hit.fang`, its swings at the player
  count as the player's own fight; misses whiff; no console errors. The probe gained the mapping
  (285 checks).
- **Step 3: particles.** `src/particles/system.ts` simulates every effect on the CPU in two pools
  (sprites, meshes) of flat typed arrays sized by `particles`, allocated once: bursts and rates,
  shapes, direction within `spread` (a point throws every way, a sphere or ring straight out, unless
  a direction is given), gravity, drag, spin, size and colour curves, `local` particles moving with
  their attachment, `inherit`. Attachments are asked again every frame, so an effect follows the
  bone it is on; one whose unit has gone stops where it was. Over budget, others' particles are
  dropped and the player's own push out the oldest of others'. `src/particles/render.ts` draws each
  blend mode as one mesh of camera-facing quads (sorted far to near when blended) and one of small
  flat-shaded shapes, rebuilt each frame into buffers allocated once - four draw calls in all.
  Streaks stretch along their velocity as the camera sees it. Not in the plan: the atlas is the
  smallest power of two the textures fit (core's is 512²), and alpha particles take a `light`
  factor (1 for now; day and night can set it later).
- **Bones.** `CharacterBody.place(bone)` says where a body's chest (mid-torso), head, feet, hands
  (between them, a little ahead), main and off hand (`handR`, `handL`) and weapon (along the right
  hand) are; the player's character and `entityMeshes` pass it on, and units without a body keep
  the heights from step 2. Cues spawn their particle parts there, following the unit, with
  placeholders filled (`hit.{armor}`), fewer for others' fights, and return a handle that stops a
  cue's loops - what step 4's casts and auras need.
- **`fx.html`** gained a stage: a scout and a knight on a patch of ground with rings at 5, 10, 20 and
  40 m, the camera as listener, the distance and angle sliders moving the knight, a speed slider
  slowing the particles; a Particles tab (each effect played on the knight's chest or feet, or the
  scout's hands, weapon or head, with its emitters listed) and an Atlas tab (the atlas, the picked
  texture's variants outlined and drawn larger); a particle meter. `window.__fx` has the stage's
  systems for the console.
- **Content**: core's hand fire, bolt and hit effects were made larger after seeing them on the stage.
- **Cost**: a full pool (3000 sprites, 600 meshes) steps in about 0.7 ms in Node and costs about
  3.4 ms a frame in the game with the drawers; a fight on the dummy uses a few dozen.
- **Checked**: on `fx.html`, the hand fire on the scout, and the fire burst and the hit effects on
  the knight, at full speed and slowed; the atlas tab; in the game
  (`?config=tiny`), auto-attacks on the dummy throwing sparks off its plate. The probe gained the
  particle system and cue particles (297 checks).
- **Step 4: abilities.** Every phase is played (`src/feedback/cues.ts`): `castStart` loops the
  skill's `cast` (or `channel`, from the event's flags) - or the table's `castStart` - at the caster
  until `castDone`, `castStopped`, `castFailed`, an `interrupted` naming it as target, or its death;
  `castDone` plays `release` and, when the committing state's length is `{ travel: speed }` and the
  speed is a plain number (20 m/s otherwise), sends the `projectile` cue flying from the caster's
  hands to the target's chest at that speed, ended by the skill's next hit, miss or heal on that
  target or 0.3 s after it is due; `auraOn` plays `applied` and loops `aura` on the host (the event's
  target) by host, skill and caster, so an aura applied again goes on as it was; `auraOff` stops it
  and plays `faded`. Lasting sounds follow what they are on each frame; a unit leaving view takes
  its cast and auras with it; changing dimension stops them all.
- **The event table gained `type`** (`spell`, `physical`): `castDone` plays a release only for
  spells. **Core's table** carries most of it by school, through placeholders: `spellCast` (sound and
  glow `cast.{school}`), `spellRelease`, `spellHit` (`impact.{school}`), `dotTick` (`tick.{school}`),
  `heal` and `healTick`, `spellMiss`, `interrupt`, `error` (a failed cast, the player's only),
  `summon`, `death` (`death.{family}`, then a thud and dust as the body lands). Skills name only
  what is their own: Fireball and Hex Bolt their `bolt`, Web its shot; the burn, Renew, Shield, the
  stuns, the slows, Chilled and Webbed their applied, aura and faded cues; Heroic Strike a heavier
  hit over the table's (`table: true`); Charge and Gore a rush; Thunder Clap a boom and a ground ring;
  Sunder a crunch; the totem's bolt a lash of embers from the totem to its target; bread a crunch.
  Fireball's step 1 cues gave way to the table's (`fire.cast` became `cast.fire`, and so on).
- **Core content now**: 50 sounds, 40 particle effects, 9 textures, 35 cues. Schools with their own:
  fire, holy, shadow, frost, nature, physical (bleeds); arcane (the dummy) and anything new fall back
  to the general `cast`, `release`, `bolt`, `impact` and `tick`.
- **Small changes on the way**: an FM `index` may be 0; a mesh particle that does not spin keeps the
  shape's own orientation (a ring lies flat); the ring shape has 24 segments and a thin band; mesh
  particles draw with a small depth offset so they do not flicker on the ground.
- **Old-school melee, at the user's asking.** The metal hit's ring ("ding") on every sword blow was
  too much: swings, misses and hits (`hit`, `hit.blade`, `hit.blade.metal`, `hit.fang`) are now short
  dull thwacks in the manner of Old School RuneScape - a punchy low thump and a slap, crushed to a
  low sample rate - and the metal hit's long ring is in one take of eight. That needed a synth
  layer's **`chance`**: the share of a sound's takes it is in, at least one (each layer starts on a
  different take); rendered without its take's place, a draw decides. Every take of a sound stays as
  long as all its layers. `impact.frost` lost its pitched tinkle for a crack, crackling ice and a long
  cold hiss.
- **`fx.html`** gained a **Skills** tab: a skill played whole - the events the server would send, at
  its times, fed to the cue player: its cast bar, release, flight over the stage's distance, hit or
  heal, the auras it applies with their ticks, an aura on its own for 5 s - with crit and own
  toggles, and **Fight**, auto-attacks on a loop with misses and crits.
- **Checked** in the game (`?config=tiny`): Fireball's cast, release, bolt, impact, the burn catching
  and burning; Charge's rush, stun and stars (and its stun interrupting the dummy's bolt); Heroic
  Strike and Sunder; Renew; Shield; the totem and its bolts; the dummy's arcane cast and bolt; a
  failed Thunder Clap's error; a frost wolf's bites, Frost Bite's chill, bleed ticks and its death,
  thud and dust; no console errors. On `fx.html`: Fireball's flight and burn, Thunder Clap's ring and
  slow, Charge's stars. Not checked in the game: Thunder Clap landing (rage ran short), Kick's own
  interrupt, Hex Bolt, Web, and the spider's and boar's deaths. The probe gained the lasting phases
  (813 checks).
- **Step 5: hit feel.** `src/feedback/feel.ts` has `Feelable` - flash, flinch, pause - which bodies
  (`CharacterBody`), capsules (`entityMeshes.feelable`) and the player's character hand over, and the
  shake: trauma added by parts, capped at 1, losing 1.8 a second, the camera moved by its square
  through two sines at unrelated rates, up to 0.35 screen units, by setting the camera's
  `targetScreenOffset` - so the orbit, the player's controls and camera collision are left alone.
- **Flash**: Babylon's overlay on every mesh of the body (or the capsule), 0.6 at its height, fading
  over the part's `time`. **Flinch**: `animation.ts` gained a `flinch` input - where the blow came from
  in the body's frame and how hard - laid over everything but death: the spine, chest and head jerk
  away (at their furthest after 0.05 s, home by 0.28 s); a capsule is pushed up to 12 cm away and
  back. **Hit pause**: the body's pose stops (the animator is not stepped) while it still goes where
  its entity is. A capsule has nothing to pause.
- **Own fights only**: the cue player plays `shake` and `pause` only when the fight is the player's;
  flashes and flinches play for everyone. **`scale: "amount"`** works now: the hit's amount against
  the struck unit's maximum health (0.3 for a tick, 1 at a tenth of it, up to 2).
- **Core**: `meleeHit` flashes white and flinches by the hit's size, shakes a little by its size and
  harder on a crit, with a 0.04 s pause on a crit; `spellHit`, `stunHit` (Charge, Gore: a 0.06 s
  pause and a 0.45 shake), Thunder Clap, Heroic Strike and the interrupt carry their own.
- **Screen shake** setting: a third slider (≈) in the corner control, kept in `aiworld.effects.shake`;
  0 keeps the camera still.
- **The workbench** plays *Flinching*: a blow every 0.9 s from the front, the +x side, behind and the
  -x side in turn. **`fx.html`** shakes its camera and flashes, flinches and pauses its bodies.
- **Checked**: on `fx.html` with the body driven by hand, a crit's melee hit holds the knight still
  for three frames, then its head jerks 15 cm away from the scout and eases back while the flash
  fades; in the game (`?config=tiny`, frames driven by hand while the pane was hidden), auto-attacks
  on the dummy flash its body, and the camera shakes (trauma up to 0.26). The probe gained the hit
  feel (892 checks). Not looked at by eye in the game: the pane was hidden, so no screenshot.
- **Runes cut, not scribbled** (asked for after step 5): a `rune` texture is now made the way runes
  are cut - one straight vertical stave with short twigs at about 45 degrees off its top, middle or
  bottom, often in mirror pairs; or two staves joined by a crossbar, a cross or a diagonal; or now
  and then a closed diamond - instead of a random walk on a grid. `strokes` is about how many lines.
- **Firefox**: its audio listener (and in some versions panners) has no position AudioParams, and
  the error stopped every frame - the particles with it. `sfx.ts` falls back to `setPosition` and
  `setOrientation` when they are missing.
- **Step 6: loot, UI, progression and footsteps.** `src/game/feedback.ts` plays what the client sees
  happen itself, through the event table's client events:
  - **The glint** over a lootable corpse, chest or ground item is the looping `lootable` cue (core:
    golden twinkles), started and stopped as the mirror's `lootable` changes; the spinning
    polyhedron in `entityMeshes.ts` is gone.
  - **Loot opening** plays when the server's open loot changes to a new entity (the belongings
    mirror), at that entity. **Taking, picking up, dropping, equipping and using** play on the
    intent, as the hand does it (`itemIntent`, from `main.ts`'s `sendItem`): taking all sounds like
    its best item's rarity, and the coins if there is money; equipping by what the piece is made of
    (`equip.{armor}`, through `armors`). **Picking a target** plays a blip.
  - **Progression** (PROGRESSION.md): `CLIENT_EVENTS` gained `xpGained`, `levelUp`, `disciplineUp`,
    `learned` and `talentPicked`, which the game's client sends. A level-up comes twice - a combat
    event everyone near is told, and the player's own client event - so a client event that is also a
    combat event is not played: the character's level (`adventure`) plays from the combat event,
    by its name; other disciplines from the client's `disciplineUp`, for the player only.
  - **Particle parts coalesce** too, by cue, source and target within 50 ms: five levels at once
    rise as one pillar, a blow on five targets still bursts on each.
- **Footsteps**: the animator reports a foot coming down (`AnimatedPose.step`: the gait phase passing
  0.25 for the +x foot, 0.75 for the other, grounded, faster than 0.5 m/s); bodies count their
  steps (`CharacterBody.steps`, and `steps` on the player's character and `entityMeshes`), and a
  capsule steps every 0.5 m plus half its height of ground covered. Units within 25 m of the player
  are heard. **The surface** (`src/game/footsteps.ts`): a building's floor is `wood`; else the ground
  material that wins there, asked of the world's material rules from five terrain samples as the
  debug map asks them, kept per metre, through `surfaces` (patterns, first match wins). **Not done**:
  water - whether a point is under water depends on the dimension's own sea, which the test world
  does not draw, so neither `isLand` nor the height says; `footstep.water` waits for the world to.
- **Core content**: sounds for loot, items, coins, the target blip, a level-up fanfare (an
  old-school square-wave arpeggio), a discipline's jingle, learning and talents, and footsteps on
  dirt, grass, gravel, sand, snow, wood, mud, leaves and water - stone keeps the plain dirt step, which
  the user found better than its own click; mud is a soft low wet crunch like gravel's, wood a deep
  hollow thud with a faint creak (both reworked after listening); a glint and a level-up pillar;
  13 cues; `surfaces` for every core ground material.
- **Checked** in the game (`?config=tiny`, frames driven by hand): a second player walking a circle
  steps on `sand` (the ground there is sand); the chest glints, opens with `loot.open`, take-all plays
  `item.take` and `coins` and the glint goes; a plate chestpiece equips with `equip.metal`; a target
  blips; XP for the character level plays the fanfare and the pillar, a class level its jingle and
  `learned`; no console errors. The E key did not reach the page while driven this way, so loot was
  opened through `__aiworld.items.loot()`. The probe gained the client events and surfaces (1339
  checks).
- **Step 7: wrap-up.** The probe's last part fights ABILITIES.md's fight on a real `tiny` server -
  the fight bot's rotation on the dummy for 60 s - and feeds its whole combat log to a cue player,
  on the server's clock: every hit, miss, heal, cast start and aura finds feedback; the only silent
  events are the ones meant to be (Weakened Soul, which only keeps a rule; stacks counted; auras and
  casts ending; a physical instant going off, which its swing and hit carry). 1311 checks, about
  15 s. `public/packs/README.md` lists the new folders and has a section on them; ABILITIES.md's
  `effect` action and *Not in this step* point here; CHARACTERS.md's animation has the flinch and
  the steps; GAMEPLAY.md's feedback step is marked done.
- **Aggro and creatures' swings** (asked for after step 7): a creature - a unit with a threat table
  that can die, so not players and not the dummy - turning on someone (its replicated target going
  from nobody to a unit) plays the client event `aggro`, at most once in 4 s, with its own family in
  the placeholder: core's wolf snarls into a bark, the spider hisses and chitters, the boar squeals,
  bandits shout, anything else growls. The swing cue became `swing.{weapon}`, so a bite snaps with a
  growl (`swing.fang`) and a tusk huffs (`swing.tusk`) where a blade keeps the whoosh. Checked by the
  probe (1459 checks); not yet heard in the game.
- **The screens** (asked for after the HUD came): `GameFeedback.watchScreens` watches the HUD's
  windows region - a window (its direct child) whose `display` changes plays `windowOpen` or
  `windowClose`, whatever opened or closed it - and the action bar's drags through document
  listeners on its own drag type: lifting a spell or item (`barLift`), putting it on the bar
  (`barPlace`, when the bar took the drop) and dragging a slot off (`barClear`), with no change to
  the bar or the windows themselves. Unequipping plays `unequip.{armor}`. Taking loot is louder,
  with a bag's rustle under the pluck, and opening it louder. Checked in the game: the inventory
  and spell book opening and closing, a bronze sword taken off (`unequip.metal`), a slot put on the
  bar and dragged off, and the chest's loot with its window's sounds.
- **Left for later**, beside *Not in this step*: water underfoot (the world has to say where its sea
  is); recorded samples (the format and the stand-ins are ready, no sample set is chosen); creature
  voices beyond deaths; and the alpha particles' `light`, which day and night could set.

## Not in this step

- Recorded samples: the format takes them, but the sounds stay generated until a sample set is
  chosen.
- Ambience (wind, birds, water, a busy town) and the music reacting to fights: the music's
  Director (MUSIC.md) and an ambience system later.
- Creature voices beyond deaths (aggro growls, pain), NPC barks.
- Lights flashing with effects (LIGHTS.md has the light budget), decals (scorch marks), screen
  effects (vignette at low health, a red edge when hit): later, as cue parts.
- Weapon trails as ribbons; the swing trail is a sprite for now.
- Spell animations on the body (casting poses): CHARACTERS.md's *Next steps* 5.
- Occlusion of sounds by walls, reverb by place (inside a building versus outdoors).
- An options screen: the volume and shake settings sit in the corner control until step 10.
