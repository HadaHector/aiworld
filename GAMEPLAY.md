# Gameplay

The scope of the game built on top of the world: what is in, what is out, and what the systems must
allow later. Agreed in two question rounds; nothing here is designed in detail yet. Each system gets
its own plan document when it is started, as zones and music did.

## Vision

- **An open-world fantasy RPG with the feel of an early MMO.** Classic WoW's sense of a whole
  world, Valheim's coziness, Old School RuneScape's freedom. Tone moves between cozy, adventurous,
  grim, comedic and heroic.
- **The player explores, fights and trades**, in that order. There is no end goal.
- **A session is one to two hours**, and the aim is that it passes without the player noticing.
- **Not just a game: a framework.** aiworld is meant to be an open-source base that anyone can use
  to build their own open-world game. The engine knows nothing that only one game needs. Our game
  is content in packs, like anyone else's.
- **Not wanted:** soulslike punishment, goofy Fortnite-style content.

## Principles

- **Everything is procedural, and deterministic from the seed.** NPCs, quests, items, history,
  dungeons, even races and classes: the same seed gives the same world. Authored content is the
  *rules, templates and parts*, never the finished thing. Each generated kind has a config saying
  how far generation may go (white- and blacklists of what it may change).
- **Data first, scripts second.** Gameplay content lives in packs (json5) alongside biomes and
  buildings: items, creatures, NPCs, quests, abilities, factions. Behaviour that data cannot
  express goes in scripts, which are a separate kind of pack (see [Modding](#modding)).
- **The engine has mechanisms; the game config has rules.** Resources, disciplines, progression, death
  penalties and the like are generic systems. The core pack decides what they mean.
- **Server-authoritative from the start.** All gameplay runs in the server; the client only shows
  it and sends input. Single player runs the same server inside the client.
- **No simulation where faking it works.** No economy simulation, NPC schedules or world change
  over time. Areas nobody is near are not simulated.
- **Readability over purity.** Quest markers, map markers, nameplates and a normal HUD are fine.
  Gameplay is allowed to ask for visual compromises. The art style itself is swappable: other
  games may replace it.

## Multiplayer

| Topic | Decision |
|---|---|
| Scale | Co-op, up to about 20 players per server. One server process, nothing distributed |
| Single player | The same server, run inside the client (as in Minecraft) |
| Hosting | Single player and co-op from the game itself; anyone can run a dedicated server, and it runs without a client (headless) |
| Shared world | Mobs, gathering nodes and chests are shared between players |
| Social | Parties, chat, direct trade, mail. Guilds and an auction house maybe later |
| PvP | Opt-in (flag or duel), low priority |
| Networking | Not yet. Client and server are kept apart behind a message boundary in one process; a real transport comes later |

## Modding

- **Datapacks** are content only: json5 plus assets. Tools are made for them so they need no
  programming knowledge.
- **Mods** carry scripts. Some must be trusted (for example ones that extend the world generator),
  much as a Minecraft server operator trusts the plugins they install. Sandboxing is a later,
  optional layer for the kinds of script where it is possible.
- **Servers do not send packs to clients**, but the handshake says which packs and config a server
  runs, so a client can tell the player what is missing or different.
- **Expertise is expected** for mods, as in any modding scene.
- **Licence: still open.** The wish is: open, not enforced hard, attribution required, and nobody
  may sell it as something else entirely. Apache 2.0 fits closely (requires attribution and keeps
  the project's name and marks from being used for others' products); MPL 2.0 would also require
  that changes to engine files are shared back.

## World

| Topic | Decision |
|---|---|
| Size | Bounded, configurable, up to about 50 × 50 km. Rendering uses 32-bit floats, so positions at the edge are accurate to 1-2 mm, which is acceptable |
| Dimensions | One continent per world. More land comes as further *dimensions* (another continent, an underworld...), each its own generated world with its own origin, reached through a loading screen from a portal, a ship or similar. Multi-continent layout inside one world is dropped |
| Persistence | The world regenerates from the seed. A small saved delta remembers what is cleared, looted or gathered until it respawns; permanent world changes are rare, contained exceptions (e.g. one building upgrading to its next stage). See [Saved state](#saved-state) |
| Terrain editing | None by the player |
| Change over time | None, apart from the contained exceptions above |
| History | Generated per seed, and can go deep: one mystery spread over several quests and NPCs |
| Zones | Matter for gameplay: creatures, resources, level, cultures |
| Zone levels | Set per zone, partly random, but every zone must border a zone of the next level. Level range and starting zones are configurable |
| Day and night | Decoration; rarely matters |
| Weather | Decoration only |
| Saving | Continuous, like Minecraft; save slots in single player |

## Character

| Topic | Decision |
|---|---|
| Identity | Customisable: race, class, looks and RPG choices |
| Races and classes | Generated from templates; the core pack starts with about 3 races and 5 classes |
| Camera | Third person |
| Resources | Health always. Others (mana, rage, energy, hunger...) depend on class or game config; any number must be possible |
| Progression | Many *disciplines*, each with its own level and progression. Combat level, class level, gathering and crafting are all disciplines; the game's rules say what each means. (Called "skills" until step 4, when that word went to abilities: see ABILITIES.md) |
| Talents | Talent trees and talent choices must be possible (as modifiers on attributes skills read: ABILITIES.md) |
| Death | The world keeps going and the player respawns at a location ("home"). Penalties are configurable: none, durability loss, corpse run, XP debt |
| Movement | Walk, run, jump, swim, plus movement skills (dash, leap...) as abilities |
| Mounts | Yes. Other vehicles maybe later |
| Looks | Low-poly, built from parts, with procedural animation where it works. To be tried out and judged early |

## Combat

- **A core pillar.** Real-time tab-target combat with cooldowns and a global cooldown, in the
  WoW Classic mould.
- **One robust ability system.** Abilities are made of composable effects (damage, heal, aura,
  damage over time, movement, summon...) defined in data. Most combat, class and item behaviour is
  expressed through it.
- **Threat tables**, which also have to handle summons and companions.
- **Mob AI is simple:** aggro, leash, a few abilities. Dungeon bosses may be more complex.
- **Creatures:** wildlife is an important source of fights. Most creatures are fantastical, even
  when they look like real animals. Taming is possible later. The creature roster is pack data,
  per zone.
- **Spawning:** mobs and nodes respawn on timers (saved, see [World delta](#world-delta)), at a random spot within a range rather
  than at the exact same coordinates.
- **Other dangers:** falling, drowning, maybe traps.
- **Stealth:** possible, without a big system.
- **Dungeons:** yes, procedural but fixed, so a place is the same when you come back. Raids are
  out of scope.

## Items and economy

| Topic | Decision |
|---|---|
| Inventory | Grid, limited slots. Bags maybe, not a copy of WoW |
| Bank | Yes |
| Kinds | Tools, weapons, armour, clothing, food, materials, keys, books and notes, trinkets, quest items |
| Variation | Items of one type differ only slightly (stats within a range). Players can improve them later (enchant, upgrade). Item types themselves are procedural too |
| Rarity | Yes, tiers matter. Set items maybe |
| Durability | Yes, with repair |
| Equipment | Many slots; the main slots show on the character |
| Money | One main currency, plus support for minor ones |
| Trading | With NPCs, prices can differ by area. No supply and demand. Direct trade between players |
| Containers | Chests and the like in the world hold loot |
| Theft | No taking from houses. Pickpocketing maybe |
| Ownership | Housing later; land and shops not planned |

## Gathering and crafting

- **Gathering from nodes:** trees, ore, herbs, fish and so on. Tools can be required and can give
  bonuses.
- **Crafting up to workstation level** (forge, loom, kitchen...), no deep production chains.
- **Cooking is crafting**, not a system of its own.
- **Farming at most RuneScape level.**
- **Building by the player:** later, maybe. Repairing the world only through quests.

## People

- **Populated like an MMO:** villages and towns full of NPCs.
- **No schedules.** At most a patrol route.
- **Procedural NPCs**, without big look-alike families. When NPCs are related, the relationship is
  invented first and the NPCs are made to fit it.
- **Talk:** barks and quest text. No dialogue trees.
- **Factions** with relations to each other and reputation per faction. Only chosen factions'
  standing can change.
- **NPCs** can die but respawn; they are never born, never move house, never change jobs.
- **Companions, romance, marriage:** no (romance only inside a quest).
- **Roles a village needs:** quest givers, shops, trainers, innkeeper.

## Quests

- **Procedural, from a generator that combines quest parts.** There should be many kinds of part
  and many kinds of quest.
- **Both standalone quests and chains** that form longer story arcs.
- **Templates, not simulation.** A quest does not need to be backed by real world state.
- **No main story** per seed.
- **Quest givers show "!" and "?"**, with a quest log and map markers.
- **Done once per character.** No dailies yet; repeatable quests should be easy to add later.
- **Failing is possible; it has no lasting consequences.**
- **Rewards:** XP, money, items, reputation, unlocks, knowledge, story.
- **Text:** about five sentences to start a quest.

### Test chain

The first chain the generator must be able to make, and the yardstick for its parts:

1. Talk to an NPC.
2. Kill creatures and loot something from them.
3. Talk to another NPC.
4. Pick up items lying on the ground.
5. Talk to an NPC and get a quest item.
6. Use the quest item on an enemy.
7. Talk to an NPC to finish.

## Exploration

- **The world is vast**, with every kind of point of interest: ruins, shrines, caves, camps, towers,
  wrecks, treasure.
- **A map** that fills in as zones and areas are explored.
- **Collections and discovery logs:** later, maybe.
- **Puzzles and secrets:** only in dungeons.
- **Fast travel:** limited, by teleporting between travel points (as in FFXIV).
- **Roads and fingerposts** guide the player to places they have not yet explored.

## Setting

- **Fantasy, with technology up to the first muskets** (see [FEATURES.md](FEATURES.md)).
- **Magic is uncommon, not rare.**
- **Religion, rituals and festivals: yes.**
- **Technology can differ a little between cultures.**

## Interface

- **A normal HUD** and all the usual screens: inventory, character, crafting, map, quest log,
  dialogue, shop.
- **Text in English first,** but built for localisation. Generated text must therefore come from
  translatable templates, not strings put together in code.
- **Keyboard and mouse first.**
- **Sound:** combat needs good sound effects; how they are made is open.

## Saved state

Two things are saved: characters, and a small *world delta*.

| Per character | |
|---|---|
| Identity | Race, class, looks |
| Progression | Every discipline's level and progress, talent trees and choices, the spells known |
| Belongings | Inventory, equipment, bank, money and minor currencies |
| Quests | Active quests and their progress, completed quests |
| Standing | Reputation per faction |
| Travel | Where they logged out, explored map, unlocked travel points, current home |

### World delta

The world is regenerated from the seed, and the delta records only how it differs from a fresh
generation, so quitting and coming back does not refill chests or bring back a cleared camp.
This holds for single player and for a restarted dedicated server alike.

- **Keyed by generated ids.** Every spawn point, node, chest and dungeon has a stable id derived
  from the seed, so the delta needs no positions or copies of the things themselves.
- **Entries expire.** A killed mob, a gathered node or an emptied chest is stored with the world
  time when it comes back. Once that time has passed, the entry is dropped, so the delta stays
  small however long a world is played.
- **The world clock runs only while the server runs.** Time does not pass while a single-player
  world is closed. What was cleared stays cleared until you have played long enough.
- **Also in the delta:** the state of a dungeon run in progress, items dropped on the ground
  (until they expire), and the contained permanent exceptions (e.g. a building's upgrade stage).
- **Not in it:** where mobs stand, their health or what they are doing. A mob that was alive is
  regenerated fresh at its spawn point.

## First milestone

Complete a quest that needs combat, and come out of it with XP, disciplines, loot and equipment.

## Out, and later

| Out | Later (design so it can be added) |
|---|---|
| Terrain editing | Housing |
| Economy simulation, supply and demand | Player building |
| NPC schedules, NPC lives | Pets, taming |
| Dialogue trees | Vehicles other than mounts |
| A main story | Collections, discovery logs |
| Weather and day/night as gameplay | Pickpocketing |
| Companions, romance | Item improvement (enchanting, upgrading) |
| Soulslike difficulty | Guilds, auction house |
| Raids | Real network transport |
| Distributed servers | Script sandboxing |
| Sending packs from server to client | Daily and repeatable quests |
| Large-world rendering; several continents in one world | Dev pages per system (quest viewer, NPC inspector) |

## Architecture notes

What the answers above force on the code, before any one system is designed.

- **Two halves.** A *simulation* (world generation, collision, entities, gameplay rules) that runs
  in Node without Babylon, and a *client* (rendering, audio, input, UI) that only reads what the
  simulation tells it. Today 123 of the 142 files in `src/world` already import nothing from
  Babylon, and collision is our own code, so the split follows lines that mostly exist.
- **One message boundary.** The client sends intents (move, target, cast, use, talk); the server
  sends state and events. In single player both run in one process over an in-memory channel. A
  WebSocket can replace that channel later without the gameplay code noticing.
- **Small worlds, many of them.** The renderer's 32-bit floats are accurate to 1-2 mm out to about
  25 km from the origin, so one world stays within about 50 × 50 km, centred on 0. Large-world
  rendering (64-bit positions, a moving render origin) is not needed. Further land comes as more
  dimensions, each centred on its own origin. Collision runs in 64-bit JS numbers and is exact
  everywhere.
- **Entities made of data-defined parts.** Creatures, NPCs, players, nodes, chests and projectiles
  are all entities. Their stats, resources and abilities come from packs.
- **Determinism.** Everything generated derives its seed from the world seed (`src/world/rng.ts`),
  so a server and every client agree on what exists without sending it.
- **Every rule a game might want to change sits behind a pack-defined config or a script hook.**

## Build order

A proposal, to be confirmed. Each step gets its own plan document.

1. **Split simulation from client: done** - see [SIMULATION.md](SIMULATION.md). Move world
   generation and collision behind a headless module that runs in Node; an in-process server with
   the message boundary above; a `npm run server` that runs it without a client. The game still
   plays exactly as now.
2. **Dimensions: done** - see [DIMENSIONS.md](DIMENSIONS.md). A server hosts several worlds, each
   with its own seed, content and origin, loaded while players are in them; players move between
   them through a loading screen. The multi-continent layout inside one world is removed. (The saved
   delta per dimension comes with saves; large-world positions were planned here and dropped: see
   Architecture notes.)
3. **Entities, stats and resources: done** - see [ENTITIES.md](ENTITIES.md). Entities built from
   parts, stats and derived stats as formula trees in packs, modifier kinds whose order and stacking
   are data, any number of resources with regen and decay, templates with inheritance; replicated
   to clients near them, the owner seeing everything and others only what is marked visible.
4. **Ability system: done** - see [ABILITIES.md](ABILITIES.md). Skills, spells and magics: skills
   as state machines of composable actions in packs, auras and gameplay elements as magics with a
   stacking model, engine control flags, attributes in every expression; casting with tab
   targeting, range and sight, cast times, channels, the GCD and a queue, interrupts; deterministic
   rolls, threat with summons, combat events; a target frame, a combat log, a server-driven swing,
   and bodies that fall when they die.
5. **Character spike: done** - see [CHARACTERS.md](CHARACTERS.md). A body built from curves along
   the bones, a painted atlas, gear as geometry, three races and two sexes, procedural animation, on
   the player in the game; judged good enough, and the approach stays.
6. **Creatures: done** - see [CREATURES.md](CREATURES.md). Species templates in packs that make a
   kind per variant, with traits picked from the world seed; rosters per zone, and zone levels in
   rings from the start as a stub; spawn points with stable keys derived from the seed - lone
   creatures, groups and camps - filled only near players and dropped when nobody is near; a brain
   on the server (wander, aggro, group aggro, chase, tactics, flee, leash and evade); corpses with
   loot, respawn at a random spot from the world delta; kill records for progression to read.
   Bodies stay capsules (bandits have humanoid bodies); beast bodies are a later step.
7. **Items: done** - see [ITEMS.md](ITEMS.md). Item types from packs and from templates that
   generate them per seed, rolled stats, rarity, durability and repair, stacks, currencies; a bag, a
   bank and equipment that adds modifiers and shows on the body; loot tables, loot from the dummy,
   a chest and the ground; items cast skills on use and equip.
8. **Disciplines and progression:** XP per discipline, levels, unlocks.
9. **NPCs and the quest generator,** up to the test chain.
10. **HUD and screens:** unit frames, action bar, inventory, quest log.

Step 10 reaches the first milestone. After it: character saves, zone levels in world generation,
parties, chat, trade and mail, then real networking.
