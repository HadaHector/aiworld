# Creatures

The plan for step 6 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: creatures. Afterwards the wilds
are populated: every zone has a roster of creature kinds rolled from the world seed, generated from
species templates in packs; spawn points with stable ids are derived from the seed, carrying lone
creatures, groups and camps; creatures exist only near players, think on the server (idle, wander,
aggro, chase, fight with abilities, leash and evade, flee), die, lie as lootable corpses, and come
back on timers that the world delta can hold. A bot fights them headless.

**Status: done** (steps 1-6 below). [As built](#as-built) notes where the build differs.

## Decisions

Asked and answered before this plan was written:

| Question | Decision |
|---|---|
| Bodies | **Capsules in this step.** Upright, sized and tinted per kind. Beast bodies (a quadruped from the curves-along-bones approach) are their own later step. Humanoid creatures (bandits) use CHARACTERS.md's bodies, which already work for any template whose look names a race |
| Where kinds come from | **Species templates that generate kinds**, as `itemTemplates/` make item types: a species (wolf) with variants (timber, frost...) makes one kind per variant, and the world seed picks each kind's traits. Rosters per zone are rolled from the seed |
| Density | **WoW Classic:** a group or camp every 60-120 m of wild ground, singles and pairs between. Respawn about 5 minutes for most, longer for camps; set per species |
| Behaviour | **Group aggro** (pulling one member of a group or camp pulls all of it) and **fleeing at low health** for kinds that opt in. No call for help beyond the group, no creatures fighting creatures |
| Zone levels (stub) | **Rings from the start:** the zone the dimension's spawn is in gets the start range; each zone one step further (by zone adjacency) a level band higher. So every zone borders one of the next level, as GAMEPLAY.md wants. Numbers in data |
| Leash | **Classic evade:** past its leash a creature drops its threat, runs home immune, and arrives at full health |
| First roster | Wolf packs (hostile, a bleed), boars (neutral, a charge, flee), a bandit camp (hostile humanoids with bodies: a bruiser and a caster), and a fantastical beast (a giant spider: poison and a web that roots) |

## Principles

- **The engine has mechanisms; packs have rules.** The engine knows species, variants, traits,
  rosters, spawn points, groups, camps, a brain with a few states, and the world delta. It knows no
  wolf, no biome by name and no number of minutes. Core's creatures are content like anyone's.
- **A creature is an entity.** It is made from an entity template (ENTITIES.md) with stats,
  resources, spells (ABILITIES.md), a threat table, loot (ITEMS.md) and a look. This step adds a
  body that walks for non-players, and a *brain* part. Nothing in abilities or items learns that
  creatures exist: the brain drives a unit through the same calls a player's messages make (move,
  target, attack, cast).
- **Deterministic from the seed.** Which kinds a world has and what traits they carry, which kinds
  live in which zone, where every spawn point is and what stands at it, and where a creature comes
  back are all derived from the world seed and stable keys. The same seed gives the same wilds on
  every server.
- **Nothing is simulated where nobody is.** Spawn points are worked out lazily, cell by cell, around
  players; creatures exist only near players and are dropped, not stored, when nobody is near. What
  survives is only what GAMEPLAY.md's world delta allows: who is dead, until when.
- **Saved later, saveable now.** The delta is a map of stable key to world time, per dimension,
  kept by the server beside its dimensions (it outlives a dimension being unloaded). Character and
  world saves can write it as it is.

## Species, variants and kinds

`creatures/<id>.json5`, read by a new `src/sim/rules/creatureRules.ts` (the folder joins
`GAME_FOLDERS`):

```json5
// creatures/wolf.json5
{
  entity: "beast",                    // the entity template kinds are made on (stats, resources, look)
  name: "{variant} Wolf",             // filled from the variant's name (a translatable key later)
  family: "beast",                    // a free string: shown, and matched by skills' filters later
  hostility: "hostile",
  // Base stats at level 1, and what each level above adds (flat). `level` itself comes from the spawn.
  stats: { stamina: 8, strength: 9, agility: 12, armor: 40, weaponMin: 3, weaponMax: 6, weaponSpeed: 2 },
  perLevel: { stamina: 3, strength: 1.5, agility: 1.5, armor: 20, weaponMin: 1.2, weaponMax: 1.8 },
  spells: [{ skill: "autoAttack" }, { skill: "bite" }],
  // What the brain does with them (see *The brain*); auto-attack needs no entry.
  tactics: [{ skill: "bite", every: [5, 8] }],
  speed: { walk: 0.3, run: 1 },       // shares of the body's walk and run: wandering, chasing
  group: { size: [2, 4], spread: 6 }, // a pack: how many, how far apart they stand
  habitat: { meadow: 2, bluebellWood: 3, autumnWood: 3, snowyTaiga: 2, frostSteppe: 2 },
  levelOffset: 0,                     // added to the zone's rolled level
  respawn: [240, 360],                // seconds of world time, rolled per death
  loot: "wolf",                       // a loot table (ITEMS.md)
  look: { height: 1.0, radius: 0.55, color: [0.45, 0.42, 0.38] },
  variants: [
    { id: "timber", name: "Timber", habitat: ["meadow", "bluebellWood", "autumnWood"] },
    { id: "frost", name: "Frost", habitat: ["snowyTaiga", "frostSteppe"], color: [0.85, 0.88, 0.92],
      stats: { armor: 60 }, spells: [{ skill: "frostBite" }] },
  ],
  traits: { pick: [0, 1], pool: ["rabid", "thickHide", "swift", "old"] },
}
```

- **One kind per variant**: `wolf.timber`, `wolf.frost`. A kind is a flat entity template made at
  load: the species' `entity` template, then the species' fields, then the variant's (objects merge
  key by key, lists replace, as templates do; a variant's `spells` add to the species'). It joins the
  template table, so spawning, replication and the client look it up by id like any template. A
  species without variants makes one kind, named by `name` with `{variant}` left out.
- **Traits** come from `creatureTraits/<id>.json5`: a few modifiers, spells or tactics, and an
  optional name prefix (`{ name: "Rabid", spells: [{ skill: "rabidBite" }], modifiers: [...] }`).
  **Which traits a kind gets is picked from the world seed and the kind's id**, `pick` of them from
  the pool, so one world's Timber Wolves are swift and another's thick-hided, and the same seed
  always the same. This is what makes kinds procedural rather than a fixed bestiary, as rolled extra
  stats do for item types.
- **Levels.** A kind has no level of its own: a spawned creature's level is its zone's rolled level
  plus `levelOffset` (a camp's leader gets more, *Camps*). Its stats are `stats + perLevel × (level -
  1)`, set as the entity's bases when it is made, so step 3's derived stats (max health from stamina
  and level) and step 4's skills (damage from `weaponMin`, `strength`) scale with it.
- **Hostility** is a template field already (ABILITIES.md): `hostile` creatures aggro by proximity,
  `neutral` ones only fight when attacked. Both are enemies of players.
- **Whitelists and blacklists** (GAMEPLAY.md): `rules/creatures.json5`'s `never` names species,
  variants or traits a game turns off; a variant's `never: ["swift"]` keeps a trait off it.
- **Checked at load**: an unknown entity template, skill, loot table, trait, stat or biome is a
  content error naming the file and path. A biome that the world config drops is simply not there.
- **The catalogue depends on the seed** (traits), so it is resolved with it, as item rules are:
  `resolveCreatureRules(packs, gameRules, seed)` in the page and in Node. The client resolves the
  same from Welcome's seed and gets the same kinds; a hash of the catalogue goes in Welcome
  (`creatures`, u32) as `rules` and `items` do.

## Zones: rosters and levels

A zone is an area of the world (`primaryAreaId` in the terrain sample), with its biome.

**Rosters**, rolled per zone from the seed and the zone's id:

- Every kind whose habitat (the variant's, else the species') lists the zone's biome is a
  candidate, weighted by the species' habitat weight.
- The zone keeps `rosterSize` of them (`rules/creatures.json5`, default `[3, 5]`), drawn without
  replacement by weight; at most one variant per species.
- Each kept kind gets a weight in the zone (its habitat weight × a roll of 0.5-1.5), which the spawn
  points draw from. Camps are rostered the same way (*Camps*).
- A zone with no candidates has no creatures. Nothing breaks.

**Levels** (the stub; zone levels in world generation come after step 10, GAMEPLAY.md):

```json5
// rules/creatures.json5
{
  levels: { start: [1, 4], step: 3, width: 3, cap: 60 },  // ring 0: 1-4, ring 1: 4-7, ...
  ...
}
```

- **The ring** of a zone is how many zone borders lie between it and the zone the dimension's spawn
  is in, by zone adjacency (worked out once per dimension: two zones touch where neighbouring land
  cells belong to them - `areaField` gains this). Its level band is `start` shifted by `ring × step`,
  `width` wide, capped.
- A dimension's own `levels` (the isles starting higher) is left for later; every dimension uses
  the rules'.
- A creature's level is drawn evenly from its zone's band at its spawn point, plus its kind's
  offset.

## Spawn points

Worked out lazily, one lattice cell at a time, from the seed and the cell's coordinates, so the
world needs no list of them and a 50 km world costs nothing until someone walks it.

- **Candidates**: one per cell of a lattice at `spacing` (default 80 m), moved by a roll within 0.4
  of a spacing of the cell's middle. A candidate is dropped when it stands in water or on ground too steep
  (`maxSlope`), on a road, inside a settlement or a compound's ground, inside a building, or within
  `safeRadius` (default 60 m) of the dimension's spawn or a link. One that falls on a tree - in its
  trunk, or its roots where they stand higher than a step - moves to the nearest spot with room for a
  body, up to 16 m off, before it is dropped.
- **Room for a body** (`src/sim/trunks.ts`): every spot a creature is put down at - the point, each
  member's, a respawn, a wander goal - keeps a body's radius and some clear of every tree and building.
  A tree is rings round its foot: how high its collision pieces stand at each distance, all the way
  round, from its kind's hulls; it is in the way where a piece stands higher than a step and lower
  than a head over the ground there. The trees are the ones the server's collision chunks scatter,
  so the check holds whether that chunk's collision is in yet or not.
- **What stands there** is drawn from the roster of the zone it is in: a kind, and how many - a
  lone creature, a pair, or the species' `group` size - or, with `campChance`, a camp. A small share
  of points (`emptyChance`) stay empty so the land is not a lattice.
- **Stable keys**: `<dimension>/s/<i>,<j>` for the point (its lattice cell), and `/<member>` for
  each creature in it. These are the delta's keys (GAMEPLAY.md, *World delta*) and seed every roll about that
  creature (its level, where it stands, where it comes back).
- **Members stand** around the point within the group's `spread`, each at its own rolled spot, and
  wander within `wander` (default 8 m) of it.

### Camps

`camps/<id>.json5`:

```json5
// camps/banditCamp.json5
{
  habitat: { meadow: 1, bluebellWood: 1, sageHills: 1, maquis: 1 },
  radius: 14,
  members: [
    { kind: "bandit.thug", count: [2, 3] },
    { kind: "bandit.hexer", count: [1, 2] },
    { kind: "bandit.thug", count: 1, levelOffset: 2, name: "Bandit Captain", at: "centre" },
  ],
  respawn: [480, 600],
  wander: 4,
}
```

- **A camp is one group**: pull one and the camp comes (group aggro). Members stand around the
  centre within its radius; one marked `at: "centre"` stands in the middle.
- **Members name kinds** (`species.variant`, or a species to take whichever variant its habitat
  fits the zone) and may override the level offset and name.
- **No props yet.** Tents and a campfire need world content placed from the same point (a compound
  feature); until then a camp is its members. The world's hash stays untouched.

## Spawning near players

The server keeps, per dimension, a **spawner**:

- **Activating.** Each step (spread over a few steps, so it costs little), every spawn point within
  `activeRadius` (140 m, just inside the 150 m interest radius) of a player in that dimension is
  active. An active point makes each of its members that is not alive and not in the delta.
- **Despawning.** A point with no player within `releaseRadius` (180 m) for `releaseAfter` (30 s)
  drops its creatures - unless one of them is in combat or evading home - and its corpses. Nothing
  about them is kept: a creature that was alive is made fresh next time (GAMEPLAY.md: no positions,
  health or doings in the delta).
- **A dimension being unloaded** drops all of them; the delta is the server's, not the dimension's,
  and stays.
- **Bodies.** A creature gets a walking body from the dimension (`createBody`), the capsule a player
  has, so it stands on terrain and building floors and collides as a player does. Where collision
  has not streamed in yet the body stands on the terrain, as a player's already does. A body that
  has not moved and has no reason to (idle, not wandering) is not stepped.

### Death, corpses and respawn

- **Death** is step 4's: at 0 health the creature dies, gets `dead`, its magics end, and its body
  falls (a capsule lies down on the client, *The client*). Its loot table is rolled at 0 health
  (ITEMS.md), with the looter taken from its threat table **at the moment of death** (kept for
  this, since dying clears threat).
- **The corpse** stays for `corpse.time` (120 s), or `corpse.emptied` (30 s) after its loot is
  taken, then despawns. Anyone in `lootRange` loots it, first come (ITEMS.md).
- **The respawn timer** starts at death: the member's key goes into the delta with the world time it
  comes back (`now + respawn`, rolled from the species' or camp's range). While the entry stands, an
  active point does not make that member. Once the time passes, the entry is dropped and the member
  is made again **at a random spot within its spread** of the point, from a stream seeded by its
  key and the time it died - not where it stood before.
- **A camp** respawns member by member on its own timer; the camp's `respawn` overrides the
  species'.
- **World time** is the server's clock, which runs only while the server runs (GAMEPLAY.md, *World
  delta*): a cleared camp stays cleared across a restart once saving comes, until enough has been
  played.

```ts
// src/sim/creatures/worldDelta.ts
interface WorldDelta {
  get(key: string): number | undefined;   // world time it comes back, if it has not yet
  set(key: string, until: number): void;
  prune(now: number): void;               // drops entries that have passed: the delta stays small
  entries(): [string, number][];          // for saving later, and the inspector
}
```

Chests (ITEMS.md's `respawn`) move onto the same delta in this step, keyed by their placement key.

## The brain

A **brain** part on every creature entity, stepped by the server after players' bodies move and
before the skill system, so the brain's casts and moves land in the same step:

```ts
interface Brain {
  state: "idle" | "wander" | "combat" | "flee" | "evade";
  home: { x: number; z: number };     // its spot at the point; where it walks back to
  group: number;                      // its spawn point's group: who comes when it is pulled
  until: number;                      // when the current idle, wander or flee ends
  pulledAt: { x: number; z: number }; // where combat started: what the leash measures from
  lastProgress: number;               // the last time a chase got closer - for being stuck
  tactics: number[];                  // per tactic, the time it may next be used
}
```

| State | What it does |
|---|---|
| `idle` | Stands for a few seconds, facing a rolled way. A hostile creature looks for players to aggro |
| `wander` | Walks (at its `speed.walk` share) to a rolled spot within `wander` of home, then idles |
| `combat` | Targets the top of its threat table (taunt respected), turns on auto-attack, chases at its run share to melee reach - or, for a kind with `keepRange`, to that range - and uses its tactics |
| `flee` | At `flee.at` of its health (opt-in), runs away from its target for `flee.time` seconds, then fights again. Once per pull |
| `evade` | Runs home immune; on arrival back to full health, threat gone, idle |

- **Aggro** (hostile kinds, idle or wandering): a living, unstealthed player within its aggro
  radius and in sight. The radius is a formula in `rules/creatures.json5` of the creature and the
  player - Classic's is about `20 + (creature level - player level)`, clamped to 5-45 m - and a
  species may scale it (`aggro: 0.6` for a skittish one). Aggro puts the player on its threat table
  with a little threat, which starts combat.
- **Neutral kinds** never aggro; they enter combat the moment they are on a table or have a table,
  i.e. when attacked - step 4's threat already does that.
- **Group aggro**: when a member enters combat, every member of its group that is alive and idle
  gets the same players on its table, with a token amount, and enters combat too.
- **Tactics** are the brain's use of spells: a list in the species (and its traits), each `{ skill,
  every: [min, max], when: formula }` - used when its cooldown in the brain has passed, the spell is
  ready, and `when` (a formula of `caster.*` and `target.*`, e.g. `{ lt: ["target.healthPct", 0.3] }`)
  holds, cast through the same `cast` the player's message uses, at its target or itself. The first
  ready one in the list goes. Auto-attack needs no entry.
- **Leash.** It evades when it has been drawn more than `leash` (default 60 m) from where the pull
  started (not while fleeing), or its table is empty, or the chase has made no progress - got no
  closer and covered no ground - for `stuck` (4 s): there is no pathfinding, and a creature that
  cannot get round a wall gives up rather than running at it.
  Evading applies the rules' `evadeSkill` (core's `evade`: a magic holding `immune`, ended on
  arriving), clears threat, and runs home at full run speed. Hits on it show "Immune", as on any
  immune unit.
- **Line of sight** for aggro uses the same ray as casting (ABILITIES.md). Chasing does not need
  sight; losing the target out of range is the leash's business.
- **Moving** is the body's `step` with an input the brain sets: a direction, a share of run or walk
  speed. Turning to face a target in place sets facing directly, so melee and `facing` checks pass.
- **Fear, charm and sleep** (ABILITIES.md's settled point 4) are not in this step: the brain is
  ready for them (a flag that takes over its state), but no skill sets them yet.

## Kills and XP

Step 8 (disciplines) may run in parallel, so this step leaves a hook rather than XP:

- **Every creature death adds a `kill` record** to a list the server drains each step:
  `{ creature, kind, level, dimension, credit: entity ids }`, where `credit` is everyone on its
  threat table at death (the tagging rules - first hit, party - are progression's to decide).
- `server.debug.creatures.drainKills()` reads it, and `createServer` takes an `onKill` option the
  progression system will pass. The combat event `death` already reaches clients for the log.

## Messages

Little changes on the wire: creatures are entities, so spawns, values, flags, casts, auras, deaths
and despawns already reach the clients that see them.

- **Welcome gains `creatures`** (u32): the creature catalogue's hash.
- **No level field**: `level` is already a stat visible to all, sent in every spawn.
- **No debug messages**: the page's tools read the server in the page (`server.debug.creatures`),
  as the inspector already does; a remote client has none of them.
- `PROTOCOL_VERSION` goes up by one.

## The client

- **Capsules per kind**, upright, of the kind's size and colour (the template look), as now. A
  dead creature's capsule **lies down** along its facing over half a second and stays so (bodies
  already fall: ABILITIES.md's death animation).
- **The target frame** shows the kind's name and level, coloured by hostility (red hostile, yellow
  neutral) - Classic's convention; the level coloured by difference to the player's (grey to red).
- **Bandits** have bodies: their kinds' looks name a race and an outfit.
- **The map** (debug) marks spawn points near the player when asked, by kind, with their delta
  times; `__aiworld.creatures` - `points()`, `spawn(kind, level)`, `delta()`, `zone()` (the zone
  the player is in: its ring, level band and roster) - for the console and probes.
- **The inspector** shows a creature's brain state, home, leash distance and tactics, from
  `server.debug` in single player.

## The test

**Core content**:

- **Species**: `wolf` (timber, frost; packs of 2-4, `bite` and the trait pool), `boar` (a variant
  per biome family; neutral, alone or in pairs, `gore` charge, flees at 20%), `bandit` (thug and
  hexer variants on a `humanoid` entity template with a human race and outfits; only in camps),
  `spider` (`giantSpider`: hostile, alone, `venom` - a poison DoT - and `web` - a 3 s root).
- **Camps**: `banditCamp`.
- **Skills**: `bite`, `frostBite` (a slow), `rabidBite` (a bleed), `gore` (a charge with a short
  stun), `hexBolt` (a cast to kick), `venom`, `web`, `evade`.
- **Traits**: `rabid`, `thickHide`, `swift`, `old`.
- **Loot tables**: `wolf` (pelts and fangs - new material items), `boar` (meat, hide), `bandit`
  (money, bread, the item templates' weapons), `spider` (silk, venom sac).
- **Habitats** reach most of the 25 biomes, and every one of the four is in the meadow, so
  `?config=tiny` (one meadow zone) has all of them.

**In the game** (`?config=tiny`, then the full world): walk out from the start; wolves in packs
aggro and come together; boars stand until hit, gore and run at low health; a bandit camp comes as
one; the spider roots and poisons; dragging any of them past 60 m makes them evade home; corpses
lie, glint and are looted with E, then vanish; walking away and back finds the living fresh and
the dead still dead until their timers pass.

**Headless**:

- `scripts/probe/creatures.mjs` (`npm run probe -- scripts/probe/creatures.mjs`):
  - Rules: core's species, traits and camps load; the catalogue is the same for one seed twice and
    traits differ for another; broken files (an unknown skill, biome, trait, template) give the
    expected errors.
  - Zones: rings and level bands on `small`'s four zones; rosters stable per seed.
  - Points: the same cell gives the same points and keys twice; none in water, on roads, in
    settlements or near the spawn; density within the expected range over a few square km.
  - Lifecycle, on a real `tiny` server with a scripted client: points activate near it, creatures
    are made, despawn after it leaves, come back fresh; a killed creature is in the delta, is not
    made again before its time, and comes back within its spread after it.
  - Brain: aggro by radius and level, neutral ignoring, group aggro, chase, tactics cast, flee,
    leash and evade back to full health, stuck behind a wall evading.
- `npm run server -- --config tiny --bot --hunt`: the bot walks to the nearest living creature,
  fights it with its rotation, loots the corpse, and repeats, printing the combat log and its bag;
  `--hunt` with the default config does the same in the full world.

## Code

| File | What |
|---|---|
| `src/sim/rules/creatureRules.ts` | `creatures/`, `creatureTraits/`, `camps/`, `rules/creatures.json5`: species to kinds (templates), traits from the seed, checks, the hash |
| `src/sim/creatures/zones.ts` | Zone adjacency, rings and level bands, rosters per zone |
| `src/sim/creatures/spawnPoints.ts` | Points per cell: candidates, filters, what stands there, keys |
| `src/sim/creatures/worldDelta.ts` | The delta: key to world time |
| `src/sim/creatures/spawner.ts` | Activating and releasing points, making members, corpses, respawn |
| `src/sim/creatures/brain.ts` | The brain's states, aggro, group aggro, chase, tactics, leash, flee, evade |
| `src/sim/creatures/system.ts` | What the server calls: step, kills, debug |
| `src/world/cells/areaField.ts` | Gains area adjacency |
| `scripts/server/huntBot.mjs` | The hunting client `--hunt` and the probe use |

## Steps

Each leaves the game working: dev server, `npm run probe`, `npm run server`, `npm run build`.

1. **Creature rules.** `creatureRules.ts` with species, variants, traits, camps and the rules file;
   kinds joining the template table; loaded in the page and in Node (errors on the loading screen);
   Welcome's hash. Core's four species, traits, camp, skills and loot tables. The probe's rules part.
   Nothing spawns yet.
2. **Zones and spawn points.** Area adjacency, rings, level bands, rosters, points per cell with
   keys; `__aiworld.creatures.zone()` and `points()`, the map markers. The probe's zones and points
   parts.
3. **Spawning and the delta.** The spawner: creatures made near players with bodies and their
   levels, released when nobody is near; death, corpses, the delta and respawn at a random spot;
   chests onto the delta; kill records. Creatures stand idle. The probe's lifecycle part. Checked in
   `?config=tiny`.
4. **The brain.** Idle and wander, aggro, neutral, group aggro, chase and facing, tactics, flee,
   leash and evade. The probe's brain part; `--hunt` headless.
5. **The client.** Lying capsules, the target frame's level and hostility colours, the inspector's
   brain view, `__aiworld.creatures.spawn()` and `delta()`. Checked in `?config=tiny` and the full
   world.
6. **Wrap up.** `public/packs/README.md` (the new folders), SIMULATION.md's message list,
   ENTITIES.md and ITEMS.md where they point at creatures; GAMEPLAY.md's step 6 marked done.

## Not in this step

- **Beast bodies** - a quadruped skeleton from curves, its gait and bite: the next step after this,
  as CHARACTERS.md's *Next steps* 6.
- Call for help beyond a group, creatures fighting creatures, predators and prey.
- Pathfinding: a creature that cannot reach its target evades.
- Fear, charm and sleep; taming and pets.
- Camp props (tents, fires) and named rare creatures; elites and dungeon bosses.
- Dynamic respawn when many players crowd an area.
- XP itself (step 8 reads the kill records), skinning and gathering from corpses.
- Saving the delta (with world saves).
- Zone levels in world generation (after step 10).

## As built

- **Files**: `src/sim/rules/creatureRules.ts` (species to kinds, traits, camps, the config,
  `levelBand`); `src/sim/creatures/`: `zones.ts`, `spawnPoints.ts` (the lattice, `open` ground,
  `respawnSpot`), `worldDelta.ts`, `creature.ts` (the part and the brain's state), `brain.ts`,
  `system.ts` (spawner, bodies, corpses, kills, debug); `src/sim/trunks.ts` (room for a body among
  the trees and buildings, `Dimension.trunks`). `scripts/server/huntBot.mjs`. Small additions:
  `GameRules.rawTemplates` and `makeTemplate` (gameRules.ts), `areaNeighbours` (areaField.ts, through
  the terrain sampler), `PlayerBody.face`, `CombatPart.killers`, `ItemSystem.hasLoot`/`release` and
  `ItemWorld.delta`; `createServer` takes `creatures` and `onKill`, `server.debug` has `creatures`
  and `delta`.
- **Kinds are made at load and added to `GameRules.templates`**, in the page and in Node, before the
  item rules (which check their loot). Variants' `spells` and `tactics` add to the species';
  `stats` set over them; traits' stats and modifiers add, a trait's `speed` multiplies the run.
  Variant fields that override the species: `levelOffset`, `speed`, `flee`, `keepRange`, `aggro`,
  `habitat` (a list keeps the species' weights).
- **Levels**: a group stands at one level give or take one, so a member can sit a level over its
  zone's band; a camp's captain sits two over.
- **The leash** measures the creature's own distance from where it was pulled, not its target's: a
  pull from 60 m away does not evade at once. Fleeing runs at half pace (a fleeing boar at full run
  outran its own leash and came back at full health) and does not leash.
- **Threat tables of creatures do not forget by time**: ABILITIES.md's `forgetAfter` would drop a
  kited player after 6 s; the leash decides instead.
- **Evading** clears threat every step, ends the `evade` magic on arriving home, and refills every
  resource. One that cannot get home in 20 s is put there. The inspector says why it evaded (`leash`,
  `stuck`, `no foes left`).
- **Kill records** are kept (the latest 256) for `server.debug.creatures.drainKills()` when no
  `onKill` reads them.
- **Health bars** (asked for after the step, `src/game/healthBars.ts`): a bar floats over every
  living hostile (red) or neutral (yellow) unit within 50 m, the target's outlined white, a red glow
  round the bar of every unit targeting the player; drawn as DOM over the canvas like the floating
  numbers. Finer threat (Classic's warnings before pulling aggro) would need the player's threat
  share sent; it is not yet.
- **The client**: dead capsules tip over along their facing in half a second; neutral units are
  yellow on the target ring and the frame's name; the inspector has a creature line (kind, traits,
  point, brain state, distance from home and from the pull). `__aiworld.creatures` - `kinds()`,
  `zone()`, `points(r)`, `showPoints(r)` (dots on the debug map: red hostile, yellow neutral, purple
  camps, grey all dead), `spawn(kind, level)`, `delta()`, `kills()`, `server()`.
- **Bandits' bodies were a stall**: each humanoid body painted its 512² atlas in one go on the main
  thread, about 4 s, so walking up to a camp froze the page for seconds. The atlas's occlusion now
  buckets vertices under numeric keys without allocating (the same pixels, 5-6x faster), and the game
  paints in 4 ms slices between frames (`dressCharacter`'s `pause`). Four bandits appearing at once
  now cost frames of up to about 0.3 s (building the mesh), not a 12 s freeze.
- **Core's numbers** were tuned with the hunt bot: a level 1 player kills a same-level wolf or boar
  in 25-35 s and wins most fights; three at once, or a bandit camp, kill it. Then made easier at the
  user's asking: creatures chase at 0.40-0.45 of the body's run (4.8-5.4 m/s), below a player's
  6 m/s walk, so a player can always get away (the 12 m/s run is a stand-in sprint); swings every
  2.8-3.2 s and tactics half as often; and mostly alone - `groups` 60% single, 28% pairs, 12% packs
  of two or three.
- **The probe** (`scripts/probe/creatures.mjs`, 85 checks, about 45 s): rules and refusals, traits
  from the seed, zones and points on `small`, the lifecycle and the brain on a real `tiny` server,
  and a hunt. Not covered: a creature stuck behind a wall (the `stuck` rule), camps' group aggro
  (only a pack's).
- **Checked**: in the game (`?config=tiny`): wolves aggro, chase, bite; corpses lie and glint, E
  loots them, the delta shows their times; bandits (with bodies), a spider and the neutral boar's
  yellow frame; the spawn points on the map. Headless in the full world: `--hunt` killed 12
  creatures in six and a half minutes (spiders, wolves, boars), looting most.
