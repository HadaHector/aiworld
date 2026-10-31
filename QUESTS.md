# Quests

The second half of step 9 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: a **quest generator** that
puts quests together from parts in packs, anywhere in the world, with chains, text from
translatable templates, "!" and "?" markers, a quest log and map markers, and rewards through
[PROGRESSION.md](PROGRESSION.md) and [ITEMS.md](ITEMS.md). The people who give and take quests are
[NPCS.md](NPCS.md). The **intro chain** in the starting village is the first thing it makes, and
GAMEPLAY.md's 7-part *Test chain* must be one of the chains it can produce. Finishing it is the
first milestone.

**Status: planned.** Nothing here is built yet.

## Decisions

| Question | Decision |
|---|---|
| Where quests are | **Anywhere.** The generator works for any settlement in the world, with what is around it. It runs lazily, when a settlement's cast is first needed. The starting village's intro chain is one use of it, not a special case in code |
| Quest people | **Many NPCs exist only to fill a role in a quest**: the generator asks for a hermit at the ruin, a traveller on the road, and they are made to fit (see [Quest people](#quest-people)). *Read from the user's answer: "Mennyi mpc's árolni exit to fulfill roll in a quest". Correct this if it meant something else* |
| Story | **From the NPCs' relations and from the surroundings.** A quest's motive comes from who the giver is and who they are tied to (the smith's missing apprentice, a feud between two farms), and from what is near: the churchyard over the hill, the quarry, the bandit camp, the river, the next village down the road. No deep generated history yet |
| Co-op | **WoW-like.** Kill credit goes to everyone who took part in the kill; quest drops roll for every player who needs them; ground objects sparkle and can be taken only by players on the quest, each their own. Shared world, no competing over objectives |
| Item rewards | **A choice of one of two or three**, generated for the quest's level and the character (a weapon, an armour piece, a trinket...), alongside XP and money. Some quests give a fixed item instead |
| Failing | Possible, with nothing lasting. A failed quest can be abandoned and taken again |
| Repeating | Done once per character. Repeatable and daily quests stay out, but the record allows them (a `repeat` field later) |

## Principles

- **Templates, not simulation** (GAMEPLAY.md, *Quests*). A quest is not backed by world state: the
  wolves it asks for are the zone's wolves, the stolen tools are a quest drop, and nothing in the
  world changes when it is done.
- **Parts are data.** What a *kill* or a *gather* is, what it needs from the place, how its line in
  the log reads: all in `questParts/`. Which parts make a quest, and in what order, is
  `questPlots/`. The engine knows how to track a handful of objective kinds and nothing about wolves.
- **Deterministic.** A settlement's quests are a pure function of the seed, the settlement and the
  packs, worked out with its cast. A quest's id is stable for the seed, so a character saves ids
  and counts, never the quest itself. A saved id the packs no longer make is dropped and reported,
  as unknown items are.
- **Text is never a string made in code.** A quest stores text *keys and arguments*; the client
  renders them in its language. See [Text](#text).
- **The server is the authority** on what a character has accepted, done and earned. The client shows
  what it is told, and generates the same quests from the seed to draw their text.
- **Every event is a feedback cue** (FEEDBACK.md's event table), so quests sound and look like the
  rest of the game without code in the feedback system.

## A quest

What the generator makes, and what the server tracks:

```ts
interface Quest {
  id: string;                    // "q:mainland/100042/3" - dimension, settlement, index
  level: number;                 // its level: the zone band's, for colouring and rewards
  giver: string; ender: string;  // NPC ids; often the same
  chain?: { id: string; index: number; of: number };
  requires: { quests?: string[]; level?: number; standing?: [faction: string, tier: string]; origins?: Record<string, string[]> };
  objectives: Objective[];       // done in order, or all at once (`ordered`)
  ordered: boolean;
  text: { title: Text; offer: Text; progress: Text; done: Text };   // keys + args (Text below)
  rewards: Rewards;
  fail?: FailRule[];
  where: Area[];                 // where its objectives are, for the map
}

type Objective =
  | { kind: "talk"; npc: string }
  | { kind: "kill"; creatures: KindFilter; count: number; area?: Area }
  | { kind: "loot"; item: string; count: number; from: KindFilter; chance: number }   // a quest drop
  | { kind: "gather"; object: string; count: number; area: Area }                      // quest objects on the ground
  | { kind: "receive"; item: string; from: string }                                    // an NPC hands it over on talk
  | { kind: "use"; item: string; on: KindFilter | { object: string }; count: number }  // use an item on something
  | { kind: "deliver"; item: string; to: string }                                      // taken from the bag on talk
  | { kind: "reach"; area: Area };                                                     // go somewhere
```

**The test chain** (GAMEPLAY.md) is then one plot with seven quests, each a step's objective:
talk, kill + loot, talk, gather, talk + receive, use on an enemy, talk to finish.

## Parts

`questParts/<id>.json5`. A part is one objective with what it needs from the place, how big it is
at a level, and how it reads. Parts are what the user's "many kinds of part" means: kill, loot,
gather, receive, use, deliver, talk and reach are the *kinds* the engine tracks; the parts in packs
are many flavours of them.

```json5
// questParts/cullBeasts.json5 - kill some of a beast that lives near
{
  kind: "kill",
  needs: { creatures: { family: "beast", near: 600 } },          // a kind from the zone's roster, a spawn within 600 m
  count: { range: [6, 10] },
  text: {
    objective: "part.cullBeasts.objective",                       // "{creature.plural} slain: {n}/{count}"
    motive: ["part.cullBeasts.flock", "part.cullBeasts.road"],    // offer sentences, drawn from
  },
}

// questParts/recoverStolen.json5 - kill bandits and take back what they stole
{
  kind: "loot",
  needs: { camp: { near: 900 } },                                 // a camp's members; the drop is theirs
  item: { template: "questThing", kinds: ["tools", "ledger", "heirloom"] },   // a quest item made for it
  count: { range: [1, 6] }, chance: 0.5,
  text: { objective: "part.recoverStolen.objective", motive: ["part.recoverStolen.raid"] },
}

// questParts/gatherAtPlace.json5 - pick up things lying at a place near. It names no feature: any
// place whose `quest` block offers objects (see Places below) will do, a feature added later included.
{
  kind: "gather",
  needs: { place: { offers: "objects", near: 900 } },
  object: { from: "place" },                                      // one of the place's own objects
  count: { range: [5, 8] },
  text: { objective: "part.gatherAtPlace.objective", motive: ["part.gatherAtPlace.byPlace"] },
}

// questParts/layToRest.json5 - a part that wants a kind of place, by tag, not by id
{
  kind: "use",
  needs: { place: { tags: ["graves"], near: 900 } },
  item: { template: "questTool", kinds: ["ward"] },
  on: { object: "place" },
  count: { range: [3, 5] },
  text: { objective: "part.layToRest.objective", motive: ["part.layToRest.restless"] },
}

// questParts/useOnBeast.json5 - use a quest item on one of the beasts
{
  kind: "use",
  needs: { creatures: { near: 600 }, from: "craftsman" },          // a crafter-role NPC made the item (a receive before it)
  item: { template: "questTool", kinds: ["salve", "ward", "snare", "tonic"] },
  on: { below: 0.5 },                                               // the target at under half health
  count: { range: [1, 3] },
  text: { objective: "part.useOnBeast.objective", motive: ["part.useOnBeast.cure"] },
}
```

| Field | |
|---|---|
| `kind` | One of the objective kinds above |
| `needs` | What must be near the settlement for the part to be used: creatures (by family, faction, tags), a place (by its quest `tags` or what it `offers`: see [Places](#places)), an NPC with a role or a relation, a road to another settlement. Never a feature or building id. A part whose needs cannot be met here is not used here |
| `count`, `chance` | Sizes, as ranges or formulas of `quest.level` |
| `item`, `object` | The quest item or ground object it makes (below), or an existing item type |
| `text` | The log line and the offer sentences it contributes |
| `levels` | Optional: only for quests of these levels |

### Places

What a place in the world can be in a quest is said **by the place, in its own file**, so a new
feature brings its quest data with it and every existing part can use it at once. Parts and plots
only ask for tags and offers; they never name a feature.

```json5
// features/cemetery.json5 - beside its compound block
quest: {
  tags: ["graves", "sacred", "remote"],         // what kind of place it is, for parts' `needs`
  objects: [                                    // things a gather part may scatter here
    { item: "graveFlowers", tags: ["offering"] },
    { item: "brokenHeadstone", tags: ["evidence"] },
  ],
  people: [{ role: "sexton", at: "lychgate" }], // quest people who can live here (NPCS.md's roles)
  spots: { objects: "graves", people: "lychgate", reach: "yard" },   // its own anchors for the above
  text: "place.cemetery",                       // how it is named and spoken of: "the churchyard at {name}", "among the graves"
}

// features/quarry.json5
quest: {
  tags: ["work", "stone", "remote"],
  objects: [{ item: "chippedStone", tags: ["material"] }, { item: "lostTools", tags: ["stolen", "work"] }],
  people: [{ role: "quarryman", at: "edge" }],
  text: "place.quarry",
}
```

- **Who has a `quest` block:** features (compounds such as churchyards, quarries, logging camps,
  coaching inns), buildings (a smithy is `["work", "metal"]`, a chapel `["sacred"]`), camps
  (`["hostile", "bandits"]`), settlement styles, and biomes. Rivers, lakes and roads are built in,
  with tags from `rules/quests.json5` (`water`, `river`, `road`).
- **`objects`** are quest item templates (below), so the place says what lies there and the part
  says what is done with it. A part asks for `offers: "objects"` or for objects with a tag
  (`{ objects: { tags: ["stolen"] } }`).
- **`people`** are the roles a plot's quest people can take here ([Quest people](#quest-people)), with
  the anchor they stand at.
- **No block, little use.** A place without one can still be a `reach` target by its kind's
  generic tag (`place`), but nothing else picks it.
- **Adding to someone else's place.** A quest pack that wants more from an existing feature (a
  ghost story at churchyards) adds tags or objects with a patch (packs README, *Patches*):
  `{ target: "features/cemetery", append: { "quest.tags": ["haunted"], "quest.objects": [...] } }`.
  New parts that ask for `haunted` then find it. So the data comes with the feature, and a separate
  pack can extend it without replacing the feature's file.

### Quest items and ground objects

- **Quest items** are item types made per quest from `questItemTemplates/` (a name pattern, an icon,
  a look), with ITEMS.md's `quest: true`: not dropped, one held, taken away when the quest ends or
  is abandoned. A `use` item carries a skill (ITEMS.md, *Abilities*) whose effect on the target is
  what counts: a salve that calms, a snare that binds, a ward that drives off.
- **Quest drops** are a loot-table entry added to the creature kinds a `loot` part names, rolled
  only for players with that objective unfinished, and shown only to them (WoW-like co-op).
- **Ground objects** are a new entity template, `questObject`: a small thing with a sparkle, made at
  spots in the part's area while a player with the objective is near, takable (the interact key)
  only by such players, each their own. One taken comes back for others at once and for the taker
  after a short `respawn`. They are filled and released as spawn points are.

## Plots

`questPlots/<id>.json5`: how parts are put together into a quest or a chain, with the slots the
parts share (the same creature kind across two parts, the same NPC giving and ending).

```json5
// questPlots/troubledFlock.json5 - a standalone: a farmer's beasts are taken
{
  giver: { role: "farmer" },
  quests: [
    { parts: ["cullBeasts"], ender: "giver" },
  ],
  weight: 1,
}

// questPlots/strangeSickness.json5 - the test chain's shape: a sickness among the beasts, a cure
{
  giver: { roles: ["reeve", "innkeeper", "priest"] },
  cast: {
    healer: { relation: ["giver", "friend", "sibling"], role: ["priest", "herbalist", "hermit"], new: "allowed" },
    maker: { role: ["smith", "herbalist", "hermit"], new: "allowed" },
  },
  slots: { beast: { creatures: { family: "beast", near: 700 } } },
  quests: [
    { parts: [{ part: "talkTo", npc: "healer" }] },                                // 1. talk to an NPC
    { giver: "healer", parts: [{ part: "cullBeasts", creatures: "beast" }, { part: "lootFrom", from: "beast", thing: "sample" }] },  // 2. kill and loot
    { giver: "healer", parts: [{ part: "talkTo", npc: "maker" }] },                // 3. talk to another NPC
    { giver: "maker", parts: ["gatherAtPlace"] },                                // 4. pick up things on the ground
    { giver: "maker", parts: [{ part: "receiveFrom", npc: "maker", thing: "cure" }] },   // 5. get a quest item
    { giver: "maker", parts: [{ part: "useOnBeast", creatures: "beast", item: "cure" }] }, // 6. use it on an enemy
    { giver: "maker", ender: "giver", parts: [] },                                 // 7. back to the giver to finish
  ],
  weight: 0.5,
}
```

- **Slots** bind one thing (a creature kind, an NPC, a place, a quest item) and every part that
  names the slot uses it, so a chain is about the same wolves and the same cure throughout.
- **`cast`** names NPCs the plot needs beyond the giver, by role and relation to someone already
  in it. `new: "allowed"` lets the generator make one when the settlement has none: a quest person.
- **Chains** are plots with several quests; each quest requires the one before. A chain can end
  by pointing on: a final `deliver` or `talk` to an NPC in another settlement (by road), which may
  open that settlement's own quests.

### Quest people

When a plot's `cast` asks for a role nobody in the settlement has, and allows a new one, the
generator makes an NPC for it, in the way NPCS.md makes relatives: the relation and role first, then
a person to fit. A herbalist who is the giver's sister lives in a cottage at the edge; a hermit lives
at the ruin the plot is about; a traveller stands on the road to the next village. Their spot comes
from what the plot is about: at the feature, at the camp's edge out of its aggro, on a road's verge.
They belong to the settlement's cast, so they stand there for everyone whether or not anyone has
the quest, as WoW's quest NPCs do.

## The generator

`questsOf(settlement)`, after `castOf(settlement)`:

1. **Context.** What is around: the settlement's buildings and cast with their relations; the zone,
   its level band and creature roster; spawn points' kinds within reach; camps; features (churchyard,
   quarry, logging camp, coaching inn...) within reach; roads to other settlements and how far;
   rivers and lakes. Reach is a rule (`reach`, about 1 km for a village). This is the "what is
   nearby" that the story uses.
2. **Plots that fit.** Every plot whose giver, cast and slots can be filled from the context.
3. **Drawing.** Plots are drawn by weight, without repeating a plot in one settlement and without
   two quests on one slot unless a plot binds them, until the settlement has its quota (`quests` in
   the style's tier: a hamlet 2-3, a village 4-7, a town 8-12; chains count by their quests).
   Givers are spread so no NPC has more than two quest lines.
4. **Filling.** Counts, quest items, objects' spots and the areas of the objectives; the quest's
   level (the zone band, a step higher for later quests in a chain); the text (below); the rewards.
5. **Ids.** In the order drawn: `q:<dimension>/<settlement>/<n>`. Changing a plot's data changes
   only the quests drawn from it and after it in that settlement.

**The intro chain** is the starting settlement's first draw, made from the start's `intro` list in
the dimension's `starts` entry (NPCS.md): plots named in order (`welcome`, `strangeSickness`, then a
`roadOn` pointer), each drawn as above but required rather than weighted, and anchored to the start's
cast. It leads out into ring 0's creatures and features, and its last quest sends the character down
the road to the nearest ring-1 settlement, whose own quests are there when they arrive. The rest of
the starting village's quota is ordinary standalones.

## Text

The first translatable text in the game, so it brings the mechanism with it.

- **`text/<language>/*.json5`**: keys to strings, merged across packs as other kinds are. `en` is
  the only language for now. A string has `{arguments}`, and arguments can select forms: `{count,
  plural, one {# wolf} other {# wolves}}`, `{npc.he}`, `{creature.plural}`, `{place.the}` - a small
  ICU-like format, with the forms (plural, a/an, the, pronouns by sex) per language in code.
- **A `Text` is `{ key, args }`**, args being ids and numbers (`npc: "npc:..."`, `creature: "wolf"`,
  `count: 8`), never finished strings. The client resolves names from its own cast and rules.
- **About five sentences to offer a quest**, built from slots: a greeting by mood, the motive (the
  part's motive sentence, coloured by the relation and the place), the ask, a detail (where, how
  many, a hint), and the stakes or a promise. Each slot is a list of templates drawn by weight and
  by conditions (the giver's mood, the relation, the feature). A *progress* line and a *done*
  paragraph come the same way.

An example of what `strangeSickness`'s first quest might read like, given an innkeeper giver whose
friend is a hermit at a churchyard:

> Brenna wipes the same mug for the third time. The boars down by Coldwater Churchyard have gone
> strange, foaming and wild, and two of the Holloway lads came back bitten. Old Amsel keeps the
> churchyard; if anyone knows what ails them, it's him. Go and ask him, would you? I'll keep a bed
> warm for you when you're back.

## In the game

### Markers

Above an NPC, for the player looking:

| Marker | Means |
|---|---|
| Yellow **!** | A quest the character can take now |
| Grey **!** | A quest it will be able to take soon (a level or two short) |
| Grey **?** | A quest in progress that ends here |
| Yellow **?** | A quest ready to hand in here |

The server sends each player the markers of the NPCs it can see (owner-only data, as progress is),
updated when its quests change. The client draws them over the nameplate, in the HUD's gold.

### Talking

The NPC window (NPCS.md, *Services*) lists the NPC's quests for this character. Choosing one shows:

- **Offering**: the title, the offer text, the objectives, the rewards with the item choice shown,
  *Accept* and *Decline*.
- **In progress**: the progress line and the objectives.
- **Handing in**: the done text, the rewards; the item choice must be picked; *Complete*.

`talk` and `receive` and `deliver` objectives complete through this window (the item handed over
or taken away as the line says).

### The quest log and tracker

- **The quest log (L)**, a window in the HUD's look (`ui/theme.ts`), on the menu bar: the active
  quests grouped by zone, each with its level colour; the chosen one's text, objectives with counts,
  rewards, *Abandon* and *Track*. Up to 25 active quests (rules).
- **The tracker** on the right edge, under the zone name and the "Saved" mark: the tracked quests' objectives and
  counts, updated live, done lines struck through.
- **Map markers** on the map (M - today the debug map, until a player map comes): the givers with
  "!" and "?", and each tracked objective's area as a soft circle.
- **Level colours** as WoW: grey (far below), green, yellow (at level), orange, red, by the
  difference between the quest's level and the character's (`colours` in rules).

### Failing and abandoning

- **Fail rules** a part or plot may carry: a time limit (`within`, world seconds), a quest item
  destroyed, an NPC the quest protects dying (for later escort parts).
- A failed quest stays in the log marked *Failed*. Abandoning it (or any quest) takes its quest
  items and drops its progress; it can be taken again from its giver. Nothing else changes.

## Rewards

| Reward | How |
|---|---|
| XP | `progression.award(entity, "quest", { quest })`: the existing hook. Core's adventure discipline gains a `quest` source with an amount formula of `quest.level` and the character's level (Classic's shape: a quest at level is worth several kills, less when grey) |
| Money | A formula of `quest.level` in `rules/quests.json5` |
| Item choice | Two or three items from item templates (ITEMS.md) at `quest.level`, chosen by slots the character's class can use (a weapon, an armour piece in its armour kind, a trinket); rolled from the seed, the quest and the character, so logging out does not reroll them |
| Fixed item | A plot may name one instead |
| Standing | With the giver's faction (NPCS.md, *Factions*), an amount per quest in rules |
| Unlocks | PROGRESSION.md's `how: "quest"`: a quest may teach an ability or open a discipline |

## Saved

The character record (FRONTEND.md, *Saves*) gains, by id:

```ts
quests: {
  active: { id: string; counts: number[]; state: "active" | "failed"; accepted: number }[];
  done: string[];              // quest ids completed, for chains and markers
};
standing: Record<string, number>;   // NPCS.md, *Factions*
```

Quest items are in the bag as any item; a quest that is gone takes its items with it on load.
`version` goes up by one with a migration that adds empty quests and standing.

## Tracking

The server's quest system listens where the events already are:

| Objective | From |
|---|---|
| `kill` | The creature system's kill records: every player on the victim's threat table at death (PROGRESSION.md's `all` credit) with the objective counts it |
| `loot` | The loot system: quest drops rolled per eligible player, counted when taken from the corpse |
| `gather` | Taking a `questObject` |
| `use` | The item's skill's combat event (hit or applied) on a target matching the filter and condition |
| `receive`, `deliver`, `talk` | The NPC window |
| `reach` | The player's position against the area, checked a few times a second |

## Messages

`PROTOCOL_VERSION` goes up by one (with NPCS.md's, in the same step where both land).

```ts
// client -> server
{ type: "questAccept", npc, quest }
{ type: "questComplete", npc, quest, choice }       // choice: index into the item choice
{ type: "questAbandon", quest }
{ type: "questTrack", quest, on }
{ type: "questObjectTake", entity }                 // a ground object

// server -> client (owner only)
{ type: "questLog", active, done }                  // on entering
{ type: "questUpdate", quest, counts, state }       // a count changed, a quest failed, done, removed
{ type: "markers", list: [npc, marker][] }          // for NPCs in view
```

## Sounds and cues

New client events in FEEDBACK.md's table, with cues and generated sounds in the core pack:

| Event | When | Sound |
|---|---|---|
| `questAccept` | A quest taken | A short page-turn and a low note |
| `questProgress` | An objective's count goes up | A soft tick |
| `questObjectiveDone` | An objective finished | A light two-note rise |
| `questReady` | Every objective done: back to the ender | A brighter chord |
| `questComplete` | Handed in | A fanfare, shorter than a level-up |
| `questFailed`, `questAbandon` | | A muted falling note |
| `standingChange` | Reputation gained or lost | A soft chime |
| `talk`, `shopBuy`, `shopSell`, `repair`, `setHome` | NPCS.md's services | Coins for trade, an anvil ring for repair, a door for home |

## Pack data

| Kind | What |
|---|---|
| `questParts/` | Parts |
| `features/`, `buildings/`, `camps/`, `settlements/`, `biomes/` | `quest`: tags, objects, people, spots and text for places (new) |
| `questPlots/` | Plots and chains |
| `questItemTemplates/` | Quest items and ground objects, by kind |
| `text/en/quests.json5` | Every quest sentence |
| `rules/quests.json5` | Quotas, reach, the log's size, level colours, reward formulas, standing amounts |
| `dimensions/*.json5` | `starts[].intro`: the intro chain's plots |

## Code

| File | What |
|---|---|
| `src/core/text.ts` (new) | Text keys, arguments, the plural and pronoun forms; `renderText(text, language, names)` |
| `src/world/quests/context.ts` (new) | What is around a settlement |
| `src/world/quests/generator.ts` (new) | `questsOf(settlement)`: plots, slots, quest people, filling, ids. No Babylon: both sides run it |
| `src/sim/quests/system.ts` (new) | Accepting, tracking, failing, completing, rewards, markers, saving |
| `src/sim/quests/objects.ts` (new) | Ground objects filled near players |
| `src/ui/questLog.ts`, `questTracker.ts` (new) | The log and the tracker |
| `src/ui/npcWindow.ts` | The quest pages |
| `src/game/markers.ts` (new) | "!" and "?" over NPCs |
| `src/debug/debugMap.ts` | Givers and objective areas |
| `scripts/probe/quests.mjs` (new) | The checks below |

## Steps

After NPCS.md's five steps. Each leaves the game working: the dev server (`?play`),
`npm run probe`, `npm run server`, `npm run build`.

6. **Text.** `text/` packs, `src/core/text.ts`, and NPCS.md's titles and barks moved onto it.
7. **Quests by hand.** The quest model, the tracking of every objective kind, quest items and drops,
   ground objects, failing, abandoning, rewards (XP, money, item choice, standing), saving. Tested
   with one hand-written chain in a dev pack that is the test chain, before any generation, so the
   runtime is known good on its own.
8. **In the game.** Quest pages in the NPC window, markers, the quest log (L) and the tracker, map
   markers, the feedback events and their sounds.
9. **The generator.** Context, parts, plots, slots, quest people, quotas and ids, for every
   settlement; core's first parts and plots (at least a dozen parts and a dozen plots, standalones
   and chains). A probe generates every settlement of the full world for several seeds and checks
   each quest can be done (its creatures spawn in reach, its objects have spots, its NPCs exist).
10. **The intro chain.** The start's `intro`, the test chain drawn from `strangeSickness`, and the
    pointer on to ring 1. A probe plays it headless with a bot: a new character, every quest of
    the chain, its XP, the item choice, the money; a log out and enter half way, with the progress
    kept.
11. **Wrap up.** By hand in the page: a new world and character from the front end, the character
    on the starting village's square, the whole intro chain to its gear and level, logged out half
    way and continued. GAMEPLAY.md's step 9 and the first milestone marked done; FRONTEND.md's
    *Later* quest log, PROGRESSION.md's quest hook, ITEMS.md's shops, FEEDBACK.md's later events and
    `public/packs/README.md` updated.

## Later

- Repeatable and daily quests (`repeat`).
- Escorts, defend-a-place and timed events as parts.
- A generated history per settlement that chains uncover (GAMEPLAY.md, *History*).
- Party sharing of quests, once there are parties.
- More languages.
- A player map that fills in, and the markers on it.
- A dev page: the quest viewer (GAMEPLAY.md's *Later* list).
