# NPCs

The first half of step 9 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: the **starting site**, the
**people** who live in settlements, **factions** with reputation, and the **services** NPCs give
(trainers, a shop, the inn). The second half, the quest generator, is [QUESTS.md](QUESTS.md). The
two are built in the order of [Steps](#steps) here and there, and together they reach the first
milestone.

**Status: in progress.** Step 1 is done (see [As built](#as-built)).

## Decisions

| Question | Decision |
|---|---|
| Starting places | **One shared start for now.** Every new character starts in the same generated village, so friends in co-op begin together. A start is a rule with an optional filter (people, later faction), so a start per people is a data change later, not a code change |
| The old start | **The fixed pieces around (0, 0) become village NPCs and props.** The trainer becomes class trainer NPCs, the strongbox goes to the innkeeper, and the dummy and the chest stand in the starting village. The mainland's fixed `entities` list goes |
| Shops | **A simple shop.** A vendor sells a stock from pack data and buys anything at a share of its `value`. Prices are fixed: no area prices, no buyback, no limited stock |
| Population | **The roles and villagers, indoors and out.** Quest givers, trainers, a vendor and an innkeeper, plus about one villager for every two or three houses. They stand inside enterable buildings (the innkeeper in the taproom, the priest in the nave) as well as by doors, on the square and in the street. Only settlements near a player are filled, as creature spawn points are |
| Quest people | **Many NPCs exist only to fill a role in a quest**: a hermit at a ruin, a traveller on a road, a sexton at a churchyard. The quest generator asks for them and they are made to fit, as relatives are (QUESTS.md, *Quest people*) |

## Principles

- **Relations first, people second.** A settlement's *cast* is planned as roles and relations
  (a smith and her apprentice, two brothers who fell out, a widow and her son at the farm), and the
  NPCs are then made to fit them: a son is younger than his mother, shares her family name and
  some of her colouring. No large families of look-alikes.
- **Deterministic and lazy.** A settlement's cast is a pure function of the world seed and the
  settlement's id. It is worked out the first time anything asks for it (a player coming near, a
  quest that names someone there) and costs nothing before. The server and every client agree on
  who lives where without sending it.
- **Nobody lives a life.** No schedules, no sleeping, no moving house or changing job (GAMEPLAY.md,
  *People*). An NPC stands at its spot, turns to whoever talks to it, says a bark now and then, and
  at most walks a patrol route. If one dies, it comes back on a timer, as a creature does.
- **Roles are pack data.** What a smith is, where it stands, what it sells, what it says: all in
  `npcRoles/`. A game with different jobs changes the data, not the code.
- **Every text is a template.** Names, titles and barks come from translatable templates
  (QUESTS.md, *Text*), never from strings put together in code.
- **One authority.** The server decides who is where and what they offer; the client draws bodies,
  nameplates, bubbles and windows from what it is told and from its own generation of the same cast.

## The starting site

Today a dimension's `spawn` is a fixed point, so the starting zone and ring 0 of the zone levels
(CREATURES.md, *Levels*) land wherever that point falls. After this step the start is decided by
world generation.

### In the dimension's definition

`dimensions/<id>.json5` gains `starts`, a list of starting places. Each has either fixed
coordinates or a rule, and an optional filter for who starts there.

```json5
// dimensions/mainland.json5
{
  name: "The Mainland",
  start: true,
  starts: [
    {
      id: "common",
      // Who starts here: left out, everyone. Later, e.g. { people: ["dwarf"] } for a dwarven start.
      // for: { people: ["dwarf"] },
      // Either a fixed point...
      // at: [0, 0], facing: 90,
      // ...or a rule the seed fills: a settlement that matches everything below.
      rule: {
        tiers: ["village"],                       // settlement tiers that may be the start
        buildings: ["inn", "chapel"],             // it must have one of each
        biomes: { only: ["meadow", "bluebellWood", "autumnWood", "heatherMoor", "alpineMeadow"] },
        centre: 0.45,                             // within this share of the world's half-extent from 0, 0
        prefer: { centre: 0.5, score: 0.5 },      // the tie-break: nearer the centre, better ground
      },
      // Where a new character appears in the chosen place, and what stands there for the start.
      arrive: { at: "square", facing: "inn" },    // anchors: below
      entities: [
        { template: "trainingDummy", at: "square", offset: [9, 4] },
        { template: "chest", at: { building: "inn", room: "guestRoom" } },
      ],
      // The intro chain's plots, in order (QUESTS.md, *The generator*).
      intro: ["welcome", "strangeSickness", "roadOn"],
    },
  ],
  links: [ { id: "ferry", to: "isles", at: [120, 40], arrive: [0, 0] } ],
}
```

- **The seed picks a match.** `chooseStarts(world, definition)` runs once when the dimension's world
  is generated. It lists every settlement that passes the rule, scores them by `prefer`, and takes
  the best; ties break on the settlement id, so the same seed always picks the same place.
- **Relaxing.** A small world may have no match (`tiny` has one zone). The rule then drops its
  conditions in a fixed order (`centre`, then biomes, then `buildings`, then `tiers`), puts back any it did not need, and logs a
  warning naming what it dropped. With no settlement at all, the start falls back to `spawn`, as now.
- **Anchors.** Places inside a settlement are named, not given as coordinates, because the layout
  is generated: `square` (its centre), `gate` (the one nearest the world's centre), `{ building:
  "inn" }` (in front of its door), `{ building: "inn", room: "taproom" }` (a free floor spot in that
  room, from the furnishing's free slots), and `facing` toward any of them. The same anchors place
  NPCs ([Where NPCs stand](#where-npcs-stand)).
- **`spawn` stays** for debug travel and as the last fallback. A dimension with no `starts` behaves
  exactly as today.

### What the start sets

| What | From the chosen start |
|---|---|
| Where a new character appears | `src/sim/spawn.ts`'s `startingPlace`, still the one place it is decided (FRONTEND.md, *Where a new character starts*). It now reads the dimension's chosen starts and the character's origins against each start's `for` |
| Its first home | The starting place's inn: home is set at an innkeeper (see [The inn](#the-inn)), and a new character's first home is the start's innkeeper, standing in front of the inn |
| Ring 0 of the zone levels | The zone the starting settlement is in. `createZones` takes the start's point instead of `spawn`. With several starts (later), every start's zone is ring 0 and rings count from the nearest |
| Creatures kept away | The start's settlement and its entities join the creature spawner's keep-out list, as `spawn` and links are now |

**A new character's place is resolved on entering, not on creating.** The start needs the
dimension's generated world, and a server may not have it loaded when a character is made. The
record is written with `travel.fresh: true`; on `enterWorld` the server loads the start dimension,
asks `startingPlace`, and writes the position and home then. Everything after that is as now.

**The client** learns the start the same way the server does: it generates the same world and
runs the same `chooseStarts`. The debug map marks each start and its rule's candidates.

## NPCs

### A settlement's cast

`castOf(settlement)` is worked out in this order. Each step draws from the settlement's own seed,
so changing one step's data does not reshuffle the others more than it must.

1. **Roles from the buildings.** Each building kind names the roles it brings (an inn brings an
   innkeeper and maybe a serving hand, a smithy a smith, a chapel a priest, a town hall a reeve or a
   mayor). The settlement style adds what its tier needs that no building brought: every village
   gets at least one quest giver, the starting village gets one trainer per class (generated
   classes included), and a town gets a guard or two.
2. **Households.** Each lived-in house (cottages, farmhouses, town houses) gets a household of one
   to four; workplaces (smithy, shop) belong to one of them. About one in two or three households has
   a member out on the street at any time: that is the villager population.
3. **Relations.** Drawn from `npcRelations/` with weights: within a household (spouses, parent
   and child, siblings), across households (friends, rivals, a feud, a debt, courting, master and
   apprentice), and to places outside (a brother at the next village, a daughter who went to the
   quarry). A relation is chosen first, then its people are made or picked to fit its constraints
   (ages, sexes where the relation needs them, shared family name, shared colouring).
4. **People.** For each NPC: a people from the settlement's mix (below), a sex, an age band (young,
   adult, old), a name, a look, an outfit from its role, and a mood that colours its barks (cheerful,
   gruff, weary, nervous).
5. **Quest people.** The quest generator may add NPCs that live outside any household: see
   QUESTS.md, *Quest people*. They join the cast of the settlement whose quests they belong to and
   stand where the quest needs them.

The cast is plain data: ids, names, roles, relations, looks and spots. An NPC's id is
`npc:<dimension>/<settlement>/<n>`, stable for the seed, so quests, saves and reputation can name it.

### Who lives there

`settlements/<style>.json5` gains `peoples`, the mix of peoples its NPCs are drawn from, e.g.
`{ human: 6, dwarf: 1, elf: 1 }` for a farm village and `{ dwarf: 5, human: 2 }` for a stone
village. The voice that names the place (its biome's `voice`) names its people too, so a place and
its people sound alike.

### Names

- **A given name** from the race's own name sounds (a new `names` block in `races/*.json5`, in the
  voice format of `voices/`), so a dwarf in a meadow village still sounds dwarven.
- **A family name** from the settlement's voice, shared by a household and by relatives.
- **A title** from the role, through a template: "Brenna Holloway, Innkeeper"; "Old Tam" for an
  old villager with no role. Titles show under the name on the nameplate, WoW style.

### Looks

Through CHARACTERS.md's bodies, as players are drawn: `chooseAppearance(race, seed, sex, sliders,
choices)`. Relatives share a seed's colour picks (skin, hair colour, eye colour) by passing them as
`choices`, and nothing else, so a family looks related without looking cloned. The age band moves
the height and build sliders and greys the hair of the old. The outfit comes from the role
(`outfits/`, as creatures' and classes' do); a villager wears a plain one from a small set.

### Roles

`npcRoles/<id>.json5`, one file per job:

```json5
// npcRoles/innkeeper.json5
{
  title: "role.innkeeper",                    // a text key: "Innkeeper"
  outfit: "apron",
  stand: [{ building: "inn", room: "taproom" }, { building: "inn" }],   // the first that fits
  services: { innkeeper: true, banker: true },
  questGiver: 0.6,                            // how likely the generator is to give it quests
  barks: "innkeeper",                         // a bark set (below)
}

// npcRoles/smith.json5
{
  title: "role.smith",
  outfit: "smith",
  stand: [{ building: "smithy" }],            // the smithy has no interior: by its door
  services: { vendor: "smithStock", repair: true },
  questGiver: 0.4,
  barks: "smith",
}

// npcRoles/classTrainer.json5: one per class, made for each class the world has
{
  title: "role.classTrainer",                 // "{class} Trainer"
  outfit: "fromClass",                        // the class's own outfit
  stand: [{ building: "chapel", room: "nave", classes: ["priest"] }, { building: "townHall" }, { at: "square" }],
  services: { trainer: { teaches: "class" } },  // what its class unlocks to learn from a trainer
  barks: "trainer",
}
```

| Field | |
|---|---|
| `title` | Text key, with `{class}`, `{settlement}` and the like filled in |
| `outfit` | An outfit id, `fromClass`, or a list to draw from |
| `stand` | Where it stands: anchors, tried in order |
| `services` | `trainer`, `vendor` (a stock id), `banker`, `repair`, `innkeeper`: what talking to it offers |
| `questGiver` | 0..1, the generator's weight for picking it as a giver |
| `barks` | A bark set id |
| `patrol` | A route: `gates` (round the gates and the square), `street` (up and down its street), `square` (round the square). Walked at a stroll with pauses; no other movement |
| `faction` | Left out: the settlement's |

The core roles: innkeeper, serving hand, smith, shopkeeper (general goods), priest, reeve, farmer,
class trainer, guard (patrols the gates), villager, and the quest people's roles (hermit,
traveller, sexton, forester, quarryman...).

### Where NPCs stand

- **Indoors** where a role asks for a room and the building has an interior (INTERIORS.md): on a free
  floor slot of that room from the furnishing (`FurnishResult`), facing the room's entrance or a
  counter. The inn, chapel, town hall, bunkhouse, cookhouse, saw shed and stable have interiors
  today. A room that is not built (its roll left it out) falls through to the next anchor.
- **By a door**: two to four metres in front of the building's front door, facing out or along
  the street.
- **On the square and the street**: villagers on a ring round the square and along main streets,
  clear of each other and of the buildings' colliders.
- **Out in the land** for quest people: at a feature (a churchyard's lychgate, a quarry's edge),
  a camp's edge, or a road's verge, from the anchors QUESTS.md lists.

Every spot is checked against collision with the body's radius, as spawn points are, and moved to
the nearest clear one. Spots are part of the cast, so they are the same every time.

### NPCs in the world

- **Filled when a player is near.** A settlement within `activeRadius` (rules) of a player has its
  NPCs made as entities; one nobody has been near for `releaseAfter` seconds has them dropped.
  The same mechanism as creature spawn points, keyed `npc:<...>` in the world delta when one dies.
- **The entity template** `npc` (abstract, over `humanoid`) carries the look, a faction, health, and
  no brain beyond: turn to a player who talks to it, walk its patrol, return to its spot. Guards
  get the creature brain's aggro against hostile factions, so a wolf that wanders into the village
  meets them; other NPCs flee a fight and come back.
- **Not attackable by friends.** Whether a player can attack an NPC is the factions' answer (below):
  a village NPC is friendly, so it cannot be targeted for harm. It can be killed by creatures, and
  comes back after `respawn`.
- **Nameplates** show the name and the title; a quest marker sits above (QUESTS.md, *Markers*).

### Barks

Short lines, said as a speech bubble over the head and a line in the chat area (when there is a
chat; until then the combat log's text tab), heard by players near.

- **When:** a player comes within a few metres and the NPC has not barked at that player for a
  while (`bark.cooldown` in rules), a player clicks it with nothing to offer, a guard sees a hostile
  creature, an NPC is hit.
- **What:** `barks/<set>.json5`, a list of text keys with conditions, drawn by weight: by role, mood,
  time of day (morning, night), the zone's weather, the player's standing, and the NPC's relations
  ("Have you seen {relation.sibling}? He owes me a shilling."). Quest givers drop hints about their
  quests ("Those wolves took two more lambs last night.").
- Barks never carry information a quest needs; they are flavour.

## Factions

`factions/<id>.json5`:

```json5
// factions/bandits.json5
{
  name: "faction.bandits",
  relations: { villagers: -100, players: -100 },   // -100..100, how this faction regards another
  reputation: false,                               // standing cannot change
}

// factionTemplates/folk.json5: generates one faction per zone with settlements
{
  name: "faction.folkOf",                          // "the Folk of {zone}"
  relations: { players: 0, bandits: -100, wildlife: -20 },
  reputation: true,
  per: "zone",
}
```

- **Every entity has a faction**: players `players`, a settlement's NPCs the folk of its zone, a
  creature kind the faction its species names (`wildlife` by default, `bandits` for bandits).
  Creature hostility today (hostile, neutral) becomes the creature faction's relation to players.
- **Standing** is a number per character per faction that has `reputation: true`, starting at the
  faction's relation to `players`. Tiers (`rules/factions.json5`): hated, hostile, unfriendly,
  neutral, friendly, honoured, revered, exalted, with their thresholds as data.
- **What standing does**: below unfriendly, NPCs of the faction will not talk or trade; at hated
  they attack. Vendors give a discount by tier (data, 0% at neutral). Quests may ask for a tier.
- **Changes** only come from quests (QUESTS.md, *Rewards*) and from killing a faction's members
  (a rule per faction, off for the folk). Saved with the character (`standing` in its record).
- The reputation panel is a tab of the character's progression panel (P).

## Services

Talking to an NPC (right-click it, or the interact key with it targeted, within `talkRange`)
opens the **NPC window**, in the HUD's look: its name and title, a greeting from its bark set, its
quests (QUESTS.md), and one button per service.

### Trainers

The placed `trainer` entity goes; class trainers take its place. A class trainer teaches its own
class's abilities that the character has unlocked to learn from a trainer (`trainer: { teaches:
"class" }`), at their `cost`, through the existing `learn` message and window. The starting
village has one per class; other villages get one or two classes each, drawn from the world's
classes. Prices by area stay out (later).

### The vendor's shop

`vendorStocks/<id>.json5`: what a vendor sells, as item types, item templates at a level band, or
tags, each with an optional count per purchase:

```json5
// vendorStocks/general.json5
{ items: [{ item: "bread", count: 5 }, { item: "waterskin" }, { template: "bag", levels: "zone" }, { tag: "tool" }] }
```

- **Buying**: at the item's `value`, less the standing discount. Stock is endless.
- **Selling**: anything that is not a quest item, at `rules/items.json5`'s `sellRate` (0.25) of its
  value, rolled stats and durability counted in. Gone once sold: no buyback.
- **Repair**: a `repair: true` NPC repairs worn and carried gear for money (ITEMS.md's repair cost),
  as the strongbox does today.
- **The shop window** sits beside the bag: a grid of the stock with prices, buying by click or drag
  to the bag, selling by drag from the bag to the window. Item tooltips as everywhere.

### The inn

- **The innkeeper** keeps the bank (the strongbox's job until now), and sells food and drink.
- **Home**: *Make this inn your home* sets the character's home to the inn, where it respawns
  (PROGRESSION.md's `home`, already read by respawn). A character starts with its start's inn as
  home. Fast travel home (a hearthstone) is later.

## Messages

`PROTOCOL_VERSION` goes up by one.

```ts
// client -> server
{ type: "talk", npc }                         // open the NPC window: within talkRange, standing allows it
{ type: "shopBuy", npc, index, count }        // index into the stock the window was sent
{ type: "shopSell", npc, from: SlotRef }
{ type: "repair", npc, what: "all" | SlotRef }
{ type: "setHome", npc }                      // at an innkeeper

// server -> client
{ type: "npcWindow", npc, greeting, services, stock?, quests }   // greeting: a text key and args
{ type: "bark", npc, text }                   // text: a text key and args, to everyone near
{ type: "standing", faction, value }          // owner only, on change
```

The NPCs' bodies, names and titles are not sent: the client builds the same cast from the seed.
Spawns carry the NPC's id, so the client finds its cast entry.

## Pack data

| Kind | What |
|---|---|
| `dimensions/*.json5` | `starts` (new) |
| `settlements/*.json5` | `peoples` (new) |
| `buildings/*.json5` | `roles`: the roles a building brings (new) |
| `races/*.json5` | `names`: given-name sounds (new) |
| `npcRoles/` | Roles, as above |
| `npcRelations/` | Relation kinds: who, constraints, weights, and the text keys that name them |
| `barks/` | Bark sets |
| `factions/`, `factionTemplates/` | Factions and the ones generated per zone |
| `vendorStocks/` | What vendors sell |
| `rules/npcs.json5` | Activation radii, bark cooldown, talk range, standing tiers and discounts, NPC respawn |
| `text/en/*.json5` | Titles, barks, names' templates (QUESTS.md, *Text*) |

## Code

| File | What |
|---|---|
| `src/world/settlements/starts.ts` (new) | `chooseStarts(world, definition)`, anchors in a settlement |
| `src/sim/spawn.ts` | `startingPlace` from the chosen starts and the character's origins |
| `src/sim/creatures/zones.ts` | Rings from the starts |
| `src/world/npcs/cast.ts` (new) | `castOf(settlement)`: roles, households, relations, people. No Babylon: the server and client both run it |
| `src/world/npcs/names.ts`, `looks.ts`, `spots.ts` (new) | Names, appearances, where each stands |
| `src/sim/npcs/system.ts` (new) | Filling and releasing settlements, NPC entities, patrols, barks, talk, services |
| `src/sim/factions.ts` (new) | Factions, relations, standing, the hostility check the skills and the brain ask |
| `src/sim/items/shop.ts` (new) | Buying, selling, repair at an NPC |
| `src/ui/npcWindow.ts`, `shopWindow.ts` (new) | The windows |
| `src/game/barks.ts` (new) | Speech bubbles over heads |
| `src/debug/debugMap.ts` | Starts and their candidates, NPC spots in the settlement under the cursor |

## Steps

Each leaves the game working: the dev server (`?play`), `npm run probe`, `npm run server`,
`npm run build`. QUESTS.md's steps follow these.

1. **The starting site.** `starts` in dimension definitions, `chooseStarts` with relaxing, anchors,
   `startingPlace` from it, `travel.fresh` resolved on entering, rings and the creature keep-out from
   it; the dummy and the chest placed by anchors, the strongbox and trainer kept where they were
   until steps 4 and 5 replace them. The debug map marks it. A probe: the same start for the same
   seed in Node and the page, a start found (or relaxed, with a warning) under `tiny`, `small` and
   the full world over 20 seeds; a new character made in the front end appears on the square.
2. **Factions and standing.** The pack kinds, a folk per zone, creatures given factions, hostility
   through factions with the same results as today, standing saved with the character.
3. **Casts.** Roles, households, relations, peoples, names, looks and spots, as data. A probe prints
   a village's cast and checks it is the same in Node and the page; a dev console view lists it
   (`__aiworld.npcs.cast()`).
4. **NPCs in the world.** NPC entities filled near players, bodies, nameplates with titles, indoor
   and outdoor spots, patrols, guards' aggro, barks with bubbles. The strongbox's bank moves to the
   innkeeper.
5. **Services.** The NPC window, class trainers (the placed trainer goes), the shop and repair,
   *Make this inn your home*. Feedback cues for talk, buy, sell, repair and home.

## As built

- **Step 1.** `starts` in `dimensions/*.json5` (`DimensionDef.starts`), chosen by
  `src/world/settlements/starts.ts`'s `chooseStarts` in the server (when a dimension loads) and in
  the page (after `createWorldData`, before the chunks are built round the arrival).
  - **Who starts where needs no world.** `startingPlace` picks a start by `for` and returns its id;
    the point comes from `startPoint(starts, id)` once the world is generated. A Transfer gains
    `start` (a start's id, or ""), and the page works out the same point itself. Protocol 12.
  - **A new character's record** has `travel.start` until it first enters; the server then writes
    its point, facing and first home (in front of the inn) and drops `start`.
  - **Quick games** (`?play`, bots) start there too, and debug travel to a dimension without a link
    arrives at its start. Respawn with no home in the dimension goes to its first start's home.
  - **Relaxing** drops `centre` first, then biomes, buildings and tiers, and puts back whatever was
    not needed. On `tiny`, 3 of 8 seeds dropped `centre` (its one zone's villages lie further out).
  - **Anchors** today are `square`, `gate`, `{ building }` (in front of the door of the one nearest
    the square) and `[x, z]`. A room anchor comes with step 4, with NPCs indoors.
  - **The core mainland** puts the dummy and chest on the square, the strongbox by the inn and the
    trainer by the chapel; the fixed `entities` list is gone. Ring 0 and the creatures' keep-out
    follow the start. The debug map marks each start with a gold star (click to go there), and
    `__aiworld.starts` lists them.
  - **Checked:** `scripts/probe/starts.mjs`: 8 seeds each of `tiny` and `small`, and with `full` 3 of
    the full world, all found a village with an inn and a chapel; the same start twice; ring 0 at the
    start; `for` filters; on a server a quick character and a new saved one appear there, the home
    is written and kept. In the page (`?play&config=small`) the player stood on Nathcas's square with
    the dummy, chest, strongbox and trainer around. The other probes needed only their fixed (0, 0)
    positions moved to where the start puts things; the hunting bot is put back on the open ground
    at the old spawn, since by the starting village the nearest creatures were a bandit camp whose
    corpses it could not reach in its 10 s.

## Later

- Starts per people or faction, as data (`for`).
- Prices by area, limited stock, buyback.
- A hearthstone home; fast travel between travel points (GAMEPLAY.md, *Exploration*).
- NPCs in towns' other interiors as more buildings gain them.
- Pickpocketing (GAMEPLAY.md, *Later*).
- A dev page: the NPC inspector (GAMEPLAY.md's *Later* list).
