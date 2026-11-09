# Quests

The second half of step 9 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: a **quest generator** that
puts quests together from parts in packs, anywhere in the world, with chains, text from
translatable templates, "!" and "?" markers, a quest log and map markers, and rewards through
[PROGRESSION.md](PROGRESSION.md) and [ITEMS.md](ITEMS.md). The people who give and take quests are
[NPCS.md](NPCS.md). The **intro chain** in the starting village is the first thing it makes, and
GAMEPLAY.md's 7-part *Test chain* must be one of the chains it can produce. Finishing it is the
first milestone.

**Status: done.** Steps 6 to 11 (see [As built](#as-built)); with [NPCS.md](NPCS.md), step 9 of GAMEPLAY.md and the first milestone.

## Decisions

| Question | Decision |
|---|---|
| Where quests are | **Anywhere.** The generator works for any settlement in the world, with what is around it. It runs for the whole world at once, when its dimension loads (see [The generator](#the-generator)): every settlement's cast and quests are made together, in a seed-shuffled order, before anyone is near. The starting village's intro chain is one use of it, not a special case in code |
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
  the log reads: all in `questParts/`. Which parts make a quest is a **segment**
  (`questSegments/`); segments fit together into chains by tags (see [Segments](#segments)), and a
  fixed order of them is a recipe in `questPlots/`. The engine knows how to track a handful of
  objective kinds and nothing about wolves.
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
  | { kind: "drop"; item: string; count: number; from: KindFilter; chance: number }   // a quest item the creatures drop, counted as taken
  | { kind: "loot"; count: number; from: KindFilter; chance: number }               // a quest drop only counted, no item (the simple form)
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

- **Quest items** are item types with ITEMS.md's `quest: true` (a salve, a ward, a letter, a
  parcel): never dropped, taken away when the quest ends or is abandoned. A `use` item carries a skill
  (ITEMS.md, *Abilities*) whose effect on the target is what counts: a salve that calms, a snare that
  binds, a ward that drives off.
  **An item belongs to its quest line, not to its type.** The *roll* of the item instance - which a
  quest item has no use for - is made from the line's id (the chain's, or the quest's own). A
  character can hold a letter for each of two errands made from the same template, because they are
  different items; a `deliver` takes the letter of its own errand and no other; a `use` counts only
  the item of its own quest line (the item system tells the quest system which item was used); and
  abandoning a quest takes exactly its items. So a similar quest from the same template never uses
  another's item. Characters entering the world are swept of quest items no quest line of theirs
  that is not finished could use.
  **Each is named and drawn for its line.** A quest line's item is called after the person or place it
  is about - "Letter for Lavora of Suthvyldael", "Reply for Rofiel", "Safell's Salve", "Ward of
  Theaniel", "Package for Shizven" - from name patterns on the parts (`itemName`, drawn like any
  line, with `{npcGiven}` the person it is delivered to or was given by, and a part reference can
  override them: the road letter and a reply do), and drawn with an icon and a tint from lists in
  `rules/quests.json5`'s `itemLooks` (one of each for the line, so two letters are not the same
  picture). The generator puts them in the quest as `itemLooks`, the same in every quest of the line;
  the client names an item it holds from the quest it was told of, by the item's roll (`ui/questItemLook.ts`),
  in the bag, the tooltip (which also says which quest it is for) and the loot window, and a
  character entering is sent the quests whose items it holds between two of a line. The art set core
  installs has no paper or parcels, so letters and parcels differ by tint on the placeholder; the salve
  has six icons and the charm one. Add icon names to a list when a set has them.
  **Unique, by construction.** *Technical identity:* a line's roll is made of where the line is - its
  dimension's number (6 bits), its settlement (16) and the index of its first quest there (10), the
  `n` of `q:<dimension>/<site>/<n>` (`bindFor`) - and stored in the quest as `bind`. No two lines can
  have the same, with nothing to look up; it does not change when a quest elsewhere does; and
  generating fails loudly if a number outgrows its bits (more than 63 dimensions, 65 535
  settlements or 1 022 quest lines in one) rather than quietly clashing. (A quest made by hand has no
  `bind` and takes the hash of its id.) *Display name:* chosen from the patterns, preferring one no
  other line's item of the type has; if all are taken, two lines share a name and the roll tells them
  apart - the tooltip says which quest each is for. An icon and tint are picked by a scramble of the roll.
  Rules: when a quest is **handed in**, its items go, except those a later quest of the same chain
  uses (the next in a chain uses the salve it was given). When it is **abandoned**, all go, and an item
  it uses but does not give itself is **handed again** when it is taken again, so a chain is not
  stuck for the want of it.
- **Quest drops** are quest items the creatures leave in their loot (the `drop` objective), only while
  the quest is active, and for the players on it alone (WoW-like co-op). When a creature dies, each
  player on its threat table who has the objective open - not finished, and the current one in an
  ordered quest - rolls: `chance` (the part's, which a segment's use of the part can set for itself)
  times the rules' `dropChance` (1 as written; 0.5 halves every drop, 0 stops them all). A success puts one
  item in the corpse's loot **for that player only**: it is in their loot window after the shared
  items, it makes the corpse glint for them and nobody else, and it is taken like any item (a full
  bag leaves it on the corpse). It is the quest line's own item (the roll of its instance, so it is
  not another quest's), it stacks on that line's stack and nowhere else, it cannot be dropped, and
  the objective counts as it is taken; handing in or abandoning takes the stack. A creature with no
  loot table of its own still leaves one, and the corpse lasts for its usual time and then its private
  items go with it. The older `loot` objective, which only counts and leaves no item, is still there
  for a quest that wants the simple form; core's blood sample and pelts are drops now (`questBlood`,
  `questPelt`, named for the creature or the giver like any quest item).
- **Ground objects** are a new entity template, `questObject`: a small thing with a sparkle, made at
  spots in the part's area while a player with the objective is near, takable (the interact key)
  only by such players, each their own. One taken comes back for others at once and for the taker
  after a short `respawn`. They are filled and released as spawn points are.

## Segments

`questSegments/<id>.json5`: one quest of a chain, and the tags that say where it fits. This is the
Lego: a settlement's chains are not written out, they are put together from segments that can follow
each other, so the same few dozen pieces make many stories. A plot (below) is the other way: a
recipe naming segments in a fixed order, for what must always be the same, like the intro.

```json5
// questSegments/wardmaker.json5 - the predators are not the end of it: someone knows a charm
{
  weight: 1,
  roles: ["middle"],                     // where it can stand: opener, middle, closer (a quest can be several)
  theme: ["predators"],                  // what the chain is about; a segment follows only a chain of a shared theme (or none)
  requires: ["problem:predators"],       // tags the chain must have by now
  provides: ["met:contact", "knows:wards"],   // tags it adds
  uses: ["beast"],                       // names that must already be bound: a person, beast, place, road
  people: { contact: { roles: [], make: ["traveller"] } },   // people it brings in (the plot format)
  quest: { ender: "contact", parts: [{ part: "talkTo", npc: "contact" }], title: ..., offer: [...], progress: ..., done: ... },
}
```

- **Openers** also say who gives them (`giver`: roles). Their creatures, place and road needs are
  the same as a plot's. A segment with no `giver` of its own is given by whoever ended the one
  before; with no `ender`, by whoever gave it.
- **Tags** are the story so far: `problem:predators`, `has:cure`, `delivered`. A segment that
  `requires` one can only follow a segment that `provides` it, so the dependencies *are* the plot:
  nothing hands you a cure before the herbs. **Names** are people and things by slot: `contact` is
  whoever the chain sent you to, whichever segment brought them (a parcel's friend, a hermit at a
  ruin, a traveller on the road), so `contactReply` ends any story that has one.
- **Creatures are asked for by what they are like**, not by name: `creatures: { hostility, family,
  tags }`, where `tags` (all of them) come from the species' and variant's `tags` in
  `creatures/*.json5` (CREATURES.md). Pelts ask for `furred`, a sickness for `mammal`; a quest's text
  can follow what it got (`when: { creature: ["arachnid"] }` says it only of a spider: webbing across
  the gate instead of tufts of fur). A settlement whose zone has no creature with the tags does not
  get the quest at all, rather than a hunt for something that is not there.
- **Merging.** A chain's needs of the world are merged, so it is about one kind of creature and one
  place throughout; a chain whose merged needs nothing in the settlement meets is not drawn there.
- **Length.** `rules/quests.json5`'s `chain` gives the most segments one chain has (`max`, 4) and
  how likely each next one is where the chain could end (`more`). A chain that dead-ends falls back
  to where it last could have ended. A segment is a solo (`roles: ["opener", "closer"]`) when it
  makes a whole quest on its own.
- **`free: false`** keeps an opener out of free drawing: it belongs to a story only a plot's `draw`
  tells (below). **`forbids`** are tags the chain must *not* have, the other half of `requires`: a
  branch that shuts out another (a curse cannot follow a sickness; the same help is not asked twice).
- **A segment that cannot stand in the middle** (`roles` without `middle`) ends the chain where it is.
- **Checked** by the quests probe without any world: every opener reaches a closer, every segment
  is on some chain, and segments that cannot go together do not compose.

A plot can say `segments: ["a", "b", ...]` in place of `quests`; the loader puts them together once
(and refuses a recipe that does not fit). Or `draw: { themes, min, max }`: a chain **drawn** for each
world from the segments of those themes, between `min` and `max` quests - how the intro gets a
different story each time. The chain rules above apply; one that comes out shorter than `min`, or
that this settlement cannot fill, is tried again with another opener.

### Stories: starts, forks, twists and endings

The intro (`questPlots/affliction.json5`, `draw: { themes: ["affliction"], min: 4, max: 6 }`) is the
example. Something is wrong in the settlement and a healer is asked; what comes of it is drawn:

| | Choices |
|---|---|
| **Start** | the beasts fall sick · a neighbour raves · omens and bad signs |
| **Fork** (the investigation) | a sample from the beasts (`cause:sickness`) · signs gathered where it began, at the graves or the fields' edge (`cause:curse`) - each `forbids` the other |
| **Sickness** | ask the maker, *or find them dead* (the twist) and learn from who they taught · herbs · the salve · tried on a beast |
| **Curse** | ask the sexton or hermit what the signs mean · a ward, tried on a beast; *or find who laid it* and ask them to their face |

Twelve stories of four to six quests; the test chain (talk, kill and loot, talk, gather, receive, use,
talk) is the plain sickness one, so GAMEPLAY.md's "must be one the generator can produce" holds. A
line of text can follow the story it is in: `when: { tags: [...] }` says it only for a chain that
has those tags, so the same quest closes differently after a death, and an omens start thanks you for
the crows leaving the roofs, not a neighbour eating.

- **Someone who is gone.** A segment's person can be `gone: true`: one of the settlement's people who
  stay at home (a relative of the giver's first), named in the text and never met. A quest cannot be
  given, ended or done by them (the loader refuses a chain that tries), and a part can say its own
  log `line` ("Go to {goneGiven}'s house") when the talk objective is with someone else - the one
  who tells you the news. The twist is in the words and the order, not in the world: nothing is
  killed, and nobody standing in a settlement is ever a dead person. (A death a *met* NPC suffers,
  so that you come back and they are not there, would need an NPC's state per character - a
  system, not a segment: see [Later](#later).)
- **A place need can shut objects out**: `place: { not: ["evidence"] }`, so a quest to pick herbs
  never asks for the candle stubs left at a crime.

## Voices

The same quest should not read the same from everyone. Segments say what happens; **voices** say how
the person giving it speaks. `questVoices/<id>.json5` is a bank of lines for one slot, and a quest's
text asks for it with `"$name"`:

```json5
// questVoices/hook.json5
{ slot: "hook", lines: [
    { text: "You. Yes, you. Hear me out.", when: { mood: "gruff" }, weight: 2 },
    { text: "Mind the sparks, and hear me out.", when: { role: "smith" }, weight: 3 },
    { text: "", weight: 1.5 },                       // say nothing
] }
```

Core's banks: `hook` (how they open), `promise` (what they offer), `progress` and `thanks`.

- **Lines** are a string or `{ text, weight, when }`. `when` holds any of `mood`, `role`, `sex`,
  `age` (of the speaker), `place` (tags of the quest's place), `object` (tags of what a gather
  picks up: herbs grow, lost things lie about), `creature` (its creature's family),
  `tags` (what the chain has so far) and `tier`; each takes one value or a list, and all the keys
  must match. Lines nobody's `when` fits fall back to the unconditioned ones.
- **Any text can use them**, not only voices: an offer is a list of groups, a title, progress or done
  is one group, and each group is a list of lines and `"$bank"`s from which **one is drawn**. `"$motive"`
  is where the parts' motive sentences go. Parts' `motive` is a group too, so a cull can read
  differently for a farmer, a priest and a smith.
- **Alternatives** `[this|that|]` inside a line are drawn when the quest is made, one possibly nothing.
- **Fresh before stale.** A sentence already used in a settlement's quests is passed over while
  another fits, so the settlement's own quests do not repeat each other.
- **Facts.** Besides the names, a text can say `{neighbour}` (another of the settlement's people, by
  given name), `{when}` (from `rules/quests.json5`'s `whens`: "these three nights") and each person's
  `{contactSex, select, male {him} female {her} other {them}}`.
- **Stored as before**: the drawn English is the key and the arguments are the fill, so the client
  does not know about any of this. (A translation therefore has the whole offer as one string; with
  this many variants a language is better served by translating the pool than its output: a later
  step.)

## Plots

`questPlots/<id>.json5`: a **recipe** - how parts (or [segments](#segments)) are put together into a
chain in a fixed order, with the slots the parts share (the same creature kind across two parts, the
same NPC giving and ending). Most chains are now drawn from segments; plots are for what must be the
same each time (the intro) or does not break into pieces.

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

## Weighting

What the generator uses is not drawn evenly. Wherever it chooses a place, a creature kind, an object,
a plot or the next segment of a chain, each candidate has a score, and the draw is by score:

| Factor | Score | Why |
|---|---|---|
| **Distance** | `1 / (1 + (d / distance)^2)` - half as likely at `distance` metres (400) as at the door | The place a quest sends you should be a walk, not a trek |
| **Reuse** | `1 / (1 + here x uses in this settlement + elsewhere x uses in the others)` for a place or object (`reuse`: 2 and 0.5), and for a creature kind (`kind`: 1 and 0.15, which a whole zone shares) | Two quests in one village should not send you to the same field for the same herb; neighbours may share, with a smaller penalty |
| **Crowding** | `1 / (1 + each x objectives within radius of the place)` (0.7, 150 m) | Where a lot is already asked of the player, ask elsewhere. Gathering and going count at their place, hunting at the settlement |

- **Plots and chains use the best they could.** A plot's or chain's fitness is the best place and the
  best creature it could use, so one whose only place is far, used or crowded is drawn less, and one
  that needs something the zone lacks (pelts, no furred creature) is not drawn at all. It multiplies
  an opener's weight, a recipe's weight and each next segment's weight.
- **Shared, in order.** The scores read a `WorldQuestState` that every settlement's generation adds
  to, in `questOrder` - the seed-shuffled order, so no settlement always has the first pick. This is
  why quests are made globally ([The generator](#the-generator)): a settlement can see what the
  ones before it used. The result is still a pure function of the seed and the packs, but a change
  to one plot's data can now reshuffle quests in settlements made after it, not only its own.
- **Data.** `rules/quests.json5`'s `weighting`: `distance`, `reuse`, `kind`, `crowding`. A pack that
  sets them to nothing (`reuse` and `crowding` to 0, `distance` huge) gets the old even draw.
- **Not yet:** distance for creatures (the roster is the zone's; spawn points are not in the
  generator's context), and a hard cap on objectives in an area - the weights only make a crowd
  unlikely.

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

Rewards follow the task, and are fixed by the seed: a quest pays the same to everyone, so logging out
rerolls nothing.

| Reward | How |
|---|---|
| XP | The quest's **effort** times a kill's XP at its level times `rate`, through `progression.award(entity, "quest", ...)`, falling to `greyShare` as the character outgrows it |
| Money | The effort times `money.base + money.perLevel x level` |
| Item choice | `rewardChoices` (3) items from the reward templates, **balanced** (below). Only a chain's last quest gives one today |
| Consumables | Some of the other quests give a few: bread, a healing draught - a fixed reward, not a choice (below) |
| Nothing | **Most quests give no item at all**: XP and money are the reward. That is the default; only a segment that says `choice: true` asks for an item |
| Standing | With the giver's faction (NPCS.md, *Factions*), a flat amount per quest in rules |
| Unlocks | PROGRESSION.md's `how: "quest"`: a quest may teach an ability or open a discipline |

### Effort

A quest's effort is counted in **kill-equivalents**, from what its objectives ask and how far they
take the player (`rules/quests.json5`'s `effort`):

| Objective | Effort |
|---|---|
| kill | 1 each, a tenth more for each level a kind stands above the zone's middle |
| loot | 0.8 for each kill a drop takes (the count over its chance) |
| gather | 0.7 each |
| talk, receive, deliver | 0.4 each |
| use | 1.5 each |
| reach | 0.5 |
| **walking** | 0.4 per 100 m to the farthest place or person: out and back, but one way for a letter to the next settlement |

So a word with the innkeeper is worth a fraction of a kill, a hunt pays more than the kills it asks
for (which are paid as well), a gathering out at a far churchyard pays more than one at the fields,
and a letter to the next village pays for the road. XP is the effort times `(45 + 5 x level) x 1.5`:
the kill XP of PROGRESSION.md's adventure discipline, and a quest's rate over it.

A chain's **last quest also pays a share** (`finale`, 0.3) of everything the rest of it paid, so a
long story ends better than a short one.

### Item choices

- **The items' level matches the quest's.** An item is only offered if its level is within
  `rewardLevel` (2) of the quest's: a level 4 quest does not give level 1 gear. The options are of one
  tier: the one nearest the quest's level that any template has, and each template's own nearest to
  it. A template with nothing within reach is left out of that choice (a sword where the metals'
  levels are 1, 4 and 8 and the quest is at 6), and the swords' metals are 1, 4 and 8 so one is near
  every level up to the 8s.
- **One rarity.** Every option in a choice is of the same rarity: the best that all the templates it
  draws on have, up to the one aimed for (`rewardRarity`: `uncommon` for a quest, `rare` for a chain's
  last), so the end of a story is better than a single errand.
- **Kinds go round.** The kind (weapon, armour) offered least so far in the world comes first and
  again; within a kind the template used least, and then the type used least. Over a world the
  weapons and the armour are about even and no choice is all swords, however many quests give one.
  A kind is the item type's `kind`, so a new template (rings, a shield) joins in by being listed in
  `rewardTemplates`.
- **No item twice in a choice.** All of this reads the same shared world state as the weighting
  ([Weighting](#weighting)).
- **Which kinds a quest may give** is the quest's own say - a filter in its data, not a roll per
  character, so the reward is the same for everyone: `reward: { only: ["armour"] }` lists the item
  kinds (`weapon`, `armour`) or templates (`sword`, `boots`) it may be, `reward: { not: ["weapon"] }`
  those it may not. A hermit's curse-breaking gives no weapon; a traveller's ward gives armour only.
  A quest with neither gives anything the templates make; the kinds still go round within what is
  allowed. A template shut out is not in the choice at all, and where nothing is allowed at the quest's
  level it gives consumables. This is how a quest is made for a kind of character: a priest's
  errand `not: ["weapon"]`, a smith's `only: ["weapon", "armour"]`.
- **Not class-aware per character**: the quest does not know who takes it, so a class-specific item
  still needs the quest (or its giver's trade) to say so.

### Consumables, and no item at all

A quest that gives no choice has `choice: []` and `items: []`, and pays XP, money and standing: that
is most of them. Some give a **fixed reward of consumables** instead (`rewardConsumables`): a quest
of at least `minEffort` gives some with probability `chance` - `perEffort` of them for each unit of
effort, most `max` - of a kind available at its level (bread from level 1, a healing draught from 3).
The client shows them together ("Bread x3"), the quest system gives each on hand-in, and a bag too
full to hold them refuses the hand-in like any item. Where a chain's last quest should give a choice
and nothing fits its level, it gives consumables rather than nothing.

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
| `drop` | The creature system's kill records: each credited player who needs it rolls, and a success puts the item in the corpse's loot for them; counted when it is taken (the item system tells the quest system). `loot` counts at the roll, leaving no item |
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
| `questSegments/` | Segments: quests that fit into chains by tags |
| `questPlots/` | Recipes: fixed chains, or fixed lists of segments |
| `questVoices/` | Banks of lines for how people talk (hook, promise, progress, thanks) |
| `questItemTemplates/` | Quest items and ground objects, by kind |
| `text/en/quests.json5` | Every quest sentence |
| `rules/quests.json5` | Quotas, reach, the log's size, level colours, reward formulas, standing amounts |
| `dimensions/*.json5` | `starts[].intro`: the intro chain's plots |

## Code

| File | What |
|---|---|
| `src/sim/text.ts` (new) | Text keys, arguments, the plural and pronoun forms; `renderText(text, language, names)` |
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

6. **Text.** `text/` packs, `src/sim/text.ts`, and NPCS.md's titles and barks moved onto it.
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

## As built

- **Step 6, text.** `src/sim/text.ts`. Where the build differs from the plan: **the English written
  in the packs is the key**, as in gettext, rather than separate keys with an English file. A
  language pack adds `text/<any>.json5` as `{ language: "hu", strings: { "Good day to you.": "..." } }`,
  read into the game rules as `rules.text`. A `Text` is `{ text, args }`: the template as written
  and what fills it; `fillText` does `{name}`, `{count, plural, one {# wolf} other {# wolves}}` and
  `{sex, select, male {he} female {she} other {they}}`, and `renderText` translates first. Barks
  and NPC greetings now go to the client as a template and arguments (`bark { text, args }`,
  `npcWindow`'s `greeting` and `greetingArgs`), and the client words them. Only English plurals
  so far; the language is always "en" until Options has a choice.
- **Step 7, quests by hand.** `src/sim/quests/quest.ts` (the model, `rules/quests.json5`) and
  `src/sim/quests/system.ts` (the server's quest system). Where the build differs from the plan:
  - **The client is sent each quest whole** (`questDefs`) when it is offered one or has one in its
    log, rather than generating the same quests itself: simpler, and a quest's text is templates
    and arguments anyway, so it is still worded on the client.
  - **Kill, loot and gather objectives are counts**, as WoW's "Wolf Fangs: 3/5": a quest drop is
    rolled for each credited player who needs it and counted, not carried, so quest items stay
    "one held" (ITEMS.md). Receive, use and deliver objectives use real quest items: the core pack's
    `herbalSalve` and `wardingCharm` (whose use casts `applySalve` / `applyWard` on the target),
    `sealedLetter` and `wrappedParcel`. A quest's items are taken back when it ends, unless a quest
    the character has not done yet asks for them (the next in a chain uses the salve it was given).
  - **Ground objects** (`questObject`, a small gold box) are shared: eight stand in an objective's
    area while a player who needs them is within 150 m; one taken is gone for 30 s. Right-click takes
    one (`questObjectTake`), counted only for someone on the quest.
  - **A `use` objective** counts when its item's skill finishes casting on a creature of the kind,
    at or under `below` of its health.
  - Talking to an NPC does every talk, receive and deliver objective with it, in order; taking a
    quest does the giver's too. Ordered quests count only their current objective.
  - **Rewards** on handing in: XP through PROGRESSION.md's `quest` source (full at the quest's level,
    falling to a tenth six levels over), money, the chosen item (an index; refused without one), any
    fixed items, and standing. **Failing:** `within` seconds run out: failed, kept in the log until
    abandoned; abandoning takes its items and leaves it to be taken again.
  - **Saved** as the record's `quests` (`active` with counts and states, `done`), sent whole on
    entering (`questLog`), each change as `questUpdate`.
  - **Checked:** `scripts/probe/quests.mjs`, 41 checks: the text's plurals and selects, then
    GAMEPLAY.md's test chain built by hand from the starting village's reeve, priest and smith and
    its zone's beasts, on a real `tiny` server with a saved character: offered only in order, the
    client told each quest, talk, two kills then the sample (ordered), a log out and in half way with
    everything kept, eight ground objects and three picked, the salve received and kept, not
    droppable, used on a beast, handed in at the first giver with a choice of three swords - XP,
    75 copper, 250 standing, the sword, the salve taken back - and not offered again; a timed quest
    failed and abandoned.
- **Step 8, in the game.** `src/game/questMirror.ts`, `src/ui/questLog.ts`, the NPC window's quest
  pages, quest marks and sounds.
  - **The NPC window** lists the NPC's quests for the character with a yellow "!" (to take), a
    yellow "?" (to hand in) or a grey "?" (in progress); a quest's page has its title in its level
    colour, its text for the moment, objectives with counts, rewards, the item choice as buttons, and
    *Accept* or *Complete*.
  - **Markers:** twice a second the server works out the marks over the NPCs within 90 m of each
    player and sends them when they change (`markers`): "?" over "!" over grey "?" over grey "!" (a
    quest a level or two off). The nameplates draw them over the name.
  - **The quest log is J**, not L, which the spell book already has; two panes, the quests on the left
    and the chosen one on the right; it is on the menu bar with a
    scroll. It lists the quests by level colour, with the chosen one written out, *Track*/*Untrack*
    and *Abandon*. **The tracker** sits under the zone name with up to five tracked quests'
    objectives, struck through when done.
  - **The map** (M, the debug map until a player map) shows the marked NPCs' "!" and "?" and soft
    circles over gather and reach areas and each quest's `where`.
  - **Sounds** (generated, the `ui` bus): taken, a count up, an objective done, ready, handed in (a
    short fanfare), failed or abandoned, and a chime when standing rises. A refusal plays `uiError`
    and is said in the NPC window.
  - Right-click on a ground object takes it.
  - **Checked in the page** with a quest defined from the console: the "!" over the reeve, its page,
    *Accept*, the "!" gone and the tracker showing the objective, the "?" over the smith after talking,
    "Ready to hand in", *Complete*: done, 30 copper and 132 XP (the human's 10% over 120).
- **Step 9, the generator.** `src/sim/quests/generator.ts` (`generateQuests`), `src/sim/quests/plots.ts`
  (reading `questParts/` and `questPlots/`), the features' `quest` blocks, and quest people.
  - **When:** a settlement's quests are made the moment its cast is (the NPC system's `castMade`,
    when a player first comes near), and defined with the quest system. *(Replaced: see "Global
    generation" below.)* Ids are
    `q:<dimension>/<site>/<n>` in the order drawn. A character back in the world whose quests are
    made only then is sent them (`questDefs`).
  - **Context:** the cast (people out, with roles and relations), the zone's level band and roster
    (from the creature system's zones), every feature within `reach` (1 km) with a `quest` block,
    the settlement's own fields (a place every settlement has, out past a gate:
    `rules/quests.json5`'s `fields`), and the three nearest other settlements, the next ring's first,
    each with its reeve (from its own cast, made the same way).
  - **Places** say what they can be (QUESTS.md, *Places*): `features/*.json5` gained `quest` -
    `tags`, `objects` (names with tags), `people` (roles that can live there) and `text`. Core: the
    churchyard (graves, sacred, remote; gravebloom, grave moss, a fallen candle; a sexton or a
    hermit), the quarry, the logging camp and the coaching inn. Camps and biomes have no blocks yet.
  - **Parts** (core: talk to, cull beasts, loot from, hunt pelts, gather at, receive the cure, salve
    a beast, receive and deliver a letter or a parcel, visit a place): a kind, sizes, an item where
    the kind has one, the log line and motive sentences. **Plots** (core: welcome, strange sickness,
    the road on - the intro - and troubled flock, pelts, gatherings, a parcel for a friend, word from
    a remote place): givers by role, people by role and relation to the giver, else made new, a
    creature need, a place need, a road, and their quests with title, offer (groups of alternatives,
    one drawn from each, with `$motive` for the parts'), progress and done lines, and an item choice.
  - **Drawing:** the intro first, in its start's order, each plot chained after the one before; then
    plots by weight until the tier's quota (`rules/quests.json5`: hamlet 2-3, village 4-6, town 7-10).
    An NPC gives at most two plots' quests, the intro aside. A plot whose giver, people, creatures,
    place or road the settlement cannot fill is not used.
  - **Quest people** (`addPerson` in `npcs/cast.ts`): made for a role (hermit, sexton, quarryman,
    forester, traveller: roles nobody holds otherwise), alone, appended to the cast so they carry on
    its ids, standing at the plot's place (`spot`). A settlement also fills when a player is near one
    of its quest people out at their place.
  - **Text:** every argument a plot's texts can use - the settlement, zone, giver and each person
    (name, given name, title), place, object and creature with plurals (`rules/quests.json5`'s
    `plurals` by a name's last word) - is in each text's `args`. One offer as a reader sees it:
    "There's something wrong with the Swift Giant Spiders round Nathcas. Two of the herders came back
    bitten, and one of them is still abed. Thilsell - Innkeeper - knows more of sickness than anyone
    here. Go and ask what can be done. I'll see you're paid for your trouble."
  - **Rewards:** XP from `rules/quests.json5`'s `xp` at the quest's level (doubled for a plot's last
    quest), money, 250 standing with the zone's folk, and for a quest that asks it an item choice:
    one of each reward template (sword, chestpiece) near the level, not common where it can, and a
    third sword.
  - Adding the quest people's roles moved the casts of every seed: each role draws once from the
    cast's stream. The same packs and seed still give the same people.
  - **Checked:** the quests probe's generator, 3 seeds each of `tiny` and `small` (14 to 56 quests a
    world): the same quests twice; the start's intro beginning with the reeve, as a chain; its parts
    in the test chain's order; the road on to another settlement; an item choice at the chain's end;
    every quest's people, items, creatures and places there, and every text filled.
- **Step 10, the intro chain.** The mainland's start names `intro: ["welcome", "strangeSickness",
  "roadOn"]`: find the inn; the strange sickness - GAMEPLAY.md's test chain (talk to the healer, cull
  and take a sample, talk to the maker, gather the herb, receive the salve, use it on a weakened
  beast, back to the giver to choose a reward); then a letter to the reeve of a settlement down the
  road, the next ring's where it can, whose own quests are there when the letter arrives.
  - **Checked:** the quests probe plays it on a real `tiny` server with a character made through the
    front end's messages: the "!" over each giver, each quest offered, every objective done as a
    player would (walking to NPCs, fighting the zone's creatures, picking up the herbs, using the salve
    on a weakened beast, carrying the letter to the next village), each handed in, a log out and in
    after the fourth with everything kept. The character went from level 1 to 4 with 192 copper,
    chose and wore a Bronze Greatsword, and gained standing with the village's folk.
- **Step 11, wrap up.** In the page: a world ("Milestone", tiny) and a character (Wren) made from
  the main menu; Wren entered on the square of Faesell, the generated starting village, home in front
  of its inn; the reeve's "!" seen across the square, *A Bed in Faesell* read and accepted, the
  innkeeper talked to, *Exit to menu*, the page reloaded, *Continue*: the quest still ready, in the
  tracker; handed in for 18 copper and level 2. Fixed on the way: quest givers' marks now show out to
  90 m (the names only within 28 m), and quests made after a character re-enters are sent to it.
- **After the user tried it:**
  - The "!" and "?" are centred over the name (the plate's lines are stretched and centred).
  - Handing a quest in opens the NPC's window straight on the next in the chain, where that NPC
    offers it.
  - A quest's level is the middle of its zone's band, plus the creatures' kind offset for a quest
    about creatures (a spider quest in ring 0 is level 4, not 2, as spiders there are 2-5).
  - Creatures stand alone for now (`rules/creatures.json5`'s `groups` all singles); the creature
    probe turns groups back on to test them. Camps are unchanged.
  - Ground objects glint as loot does, and the glint is twice the size it was. Hovering anything
    that can be right-clicked - loot, a ground item or object, a person - shows a hand, and its name except for a person, whose name is over their head.
  - The NPC window is a list: its quests ("!" to take, "?" to hand in) and then a row for each
    service - "$ Shop", Train, Bank, Repair all, Make this inn your home. The shop is a page of its
    own, opened from its row (with Back), and stays open while buying and selling.
  - Talking to an NPC with one thing only to offer goes straight to it: a class trainer opens the
    progression panel at it, a banker alone the bag, one quest its page, a shop alone its shop page, with no Back button to a list of one. Only when it is newly talked to, not when the window
    is asked for again after an action.

- **Segments and voices.** The plots' monolithic quests are cut into `questSegments/` that fit
  together by tags, and the quests' words come from pools with `when` conditions and voice banks
  (see [Segments](#segments), [Voices](#voices)). `src/sim/quests/chains.ts` composes and checks chains
  (shared by the loader, which puts recipes together, and the generator, which draws chains);
  `plots.ts` reads segments, voices and condition-bearing lines; `generator.ts` draws an opener by
  weight like a plot and grows it segment by segment. Core: fifteen segments - the sickness chain's
  six, and `foldTrouble` → `wardmaker` → `wardCharm` (predators), `silentKeeper` and `parcelErrand`
  (each a solo or the start of a story) with `contactFavour` and `contactReply` (end any story that
  brought a contact), `pelts`, `smallKindness` - and four voice banks. The old standalone plots
  (troubled flock, pelts, gatherings, a hermit's word, a parcel for a friend) became segments;
  `strangeSickness` is now a recipe. `{when}`, `{neighbour}` and each person's `{xSex}` are new
  arguments. **Checked:** the probe walks every possible chain without a world (38 at most 4 long),
  and over the generated worlds that no offer repeats, no text has an empty argument or stray markup.

- **Global generation.** Quests are no longer made lazily. The NPC system makes every settlement's
  cast as a dimension loads and hands them all to the server (`castsMade`), which makes every
  settlement's quests in one pass, in `questOrder` (the settlements shuffled by the seed, so no
  settlement always has the first pick and the order does not depend on how they are listed), and
  defines them together. Why: it costs next to nothing (the full default world, 62 settlements, takes
  81 ms for casts and quests together, against some 23 s to shape the world), and it lets a settlement
  see what the others have used, which is what weighting by distance, reuse and crowding needs
  ([Later](#later)). Also: the road-on pointer reads the other settlement's real cast, not a copy made
  for it; a quest person out at a ruin stands there, and is met, before anyone has been near their
  settlement; a character back in a dimension has its quests defined at once. A settlement's quests
  are still a pure function of the seed and the packs; today they do not depend on the order, and
  once weighting reads what earlier settlements used they will, in `questOrder`'s fixed one - and a
  change to one plot's data can then reshuffle quests in settlements made after it, not only in its
  own. **Checked:** every settlement of a world has quests before anyone is near, and the order is a
  permutation that is the same however the settlements are listed and differs by seed.

- **Stories.** The intro is no longer one chain; it is drawn (see [Stories](#stories-starts-forks-twists-and-endings)):
  `strangeSickness` became `affliction`, a `draw` plot, and its six segments became fourteen with
  three starts, a fork between a sickness and a curse, a death twist and three endings. New in the
  engine: `forbids`, `free`, `gone` people, a part's own `line`, `draw` plots, `place.not`,
  `when.object`, and chains that end at a closer-only segment. The curse can happen at the
  settlement's own fields as well as at a churchyard, so it does not depend on one being near.
  **Checked:** the probe enumerates the stories (12) and asserts several starts, endings and a twist, that
  the test chain is among them, and that segments in the wrong order or with someone gone as the
  ender do not compose; it plays four different stories with the bot (the curse lifted, the
  culprit asked, a death on the way, the plain sickness) from the "!" to the item worn, and over
  the generated worlds that the story the intro drew is one the rules can make.

- **Creature tags.** Species and variants have `tags`; a creature need asks for them. Core: wolf
  `furred, mammal, predator`; boar `furred, mammal`; spider `arachnid, venomous`; bandit `armed`.
  The pelts quest asks for `furred` (no more pelts of spiders) and the sickness for `mammal`.
  **Checked:** every tag a segment asks for is one some creature has, and in generated worlds every
  pelt, blood-sample and salve objective is on a creature with the right tag.

- **Weighting.** `src/sim/quests/generator.ts` scores places, objects and creature kinds by distance,
  reuse and crowding (see [Weighting](#weighting)), picks by score, and weighs plots, openers and the
  next segment of a chain by the best place and creature each could use. `WorldQuestState` (uses by
  key, and where the objectives lie) is made by the server for each dimension and passed from
  settlement to settlement in `questOrder`. **Checked:** the probe generates five `small` worlds
  with the weights on and off: with them the gathering and going objectives lie 257 m from their
  settlement on average (360 m without), 6 pairs of them within 150 m of each other (12 without), and
  a greater share are at different places (90% against 81%).

- **Rewards by effort.** XP and money follow the task (see [Rewards](#rewards)): effort in
  kill-equivalents, a rate over a kill's XP, a share of the chain for its last quest. A chain's quests
  after the first ask no level, and the intro's none at all (a character just made would be stuck
  after one word with the innkeeper, which now pays 36 XP). Item choices are balanced (one rarity,
  one tier, kinds going round), a chain's last quest aims one rarity higher, and there are two new
  reward templates, boots and helm, and a rare chestpiece. **Measured** in six generated worlds: a
  word pays 1.1 kill-equivalents on average, a gathering 2.4, a hunt 6.0 and a letter down the road
  4.1; the starting settlement's 12-14 quests give 3300-4000 XP on their own (level 5), the intro
  alone 1450-2430 (level 4 or so) - generous, and `xp.rate` is the number to turn down. Of 29 item
  choices, 44 of 87 options are weapons. (Gathering was then 0.25 an object and averaged 2.4; at 0.7 it
  averages 4.5, close to a hunt's 6.0, and the starting settlement gives 3400-4300 XP.)

- **Reward items match the quest's level, and not every quest gives one.** Choices only offer items
  within `rewardLevel` of the quest's level (a mid-tier "Hardened" sword, level 4, joins bronze and
  iron so a weapon is near every level), and consumables are a fixed reward (bread, and a new healing
  draught, `drinkDraught`). **Measured** over six worlds, 236 quests: 149 give no item, 58 give
  consumables, 29 a choice; the options' level minus the quest's is between -2 and +2 (mostly +1 and +2:
  the armour tiers are 1, 5 and 10).

- **Quest items are the quest line's own.** An item's roll is the line's id (`bindOf` in
  `system.ts`); `holds` is per type and roll, `give`/`take`/`has` take it, a `use` counts only for the
  item used (`itemUsed`, from the item hook), abandoning takes exactly the quest's items, and
  taking an abandoned use quest again hands the item again. **Checked** by the probe (10 of its 15
  new checks fail without it): two errands with one kind of letter hold two letters, each delivered to
  its own errand, abandoning one leaves the other; two cures use only their own salve; a salve is
  kept between two quests of a line, goes with an abandoned try and is handed again; a leftover letter is
  swept as a character enters. **Names and looks:** see the
  paragraph above; **checked** by the probe: every quest item of every generated quest has a name that
  fills, an icon and a tint from its lists, the same all along its line, with different names for
  different lines (letters showed five different tints over six worlds, salves three icons), the client's
  naming by roll on a real quest, and the held-between-quests definitions sent on entering.

- **Dropped quest items.** The `drop` objective (see *Quest items*): the item system's `LootPart`
  gains `private` (item ids by player), the loot window and the glint are per viewer
  (`lootSeenBy`, `lootable(entity, viewer)`), `dropFor` leaves an item for one player, `ItemWorld.gained`
  tells the quest system what was taken, quest items that stack merge only within a line (`receiveItem`),
  and the quest system rolls on a kill. `dropChance` in `rules/quests.json5` and a part reference's
  `chance` are the settings. **Checked:** the probe plays it with a second player on the threat table:
  nothing drops without the quest, the player on it gets the item in their loot and the other does
  not, it counts only when taken, two stack into one, it cannot be dropped, abandoning takes the stack
  and taking it again starts from nothing, a chance of 0 and a rule factor of 0 drop nothing and a
  chance of 1 drops on every kill; and the intro bot takes its blood sample from a corpse.

## Later

- Item choices a character's class can use (a priest is still offered a sword), and a trinket kind.
- A death a character *meets*: an NPC the quest has killed is not there when the character comes
  back, or is found dead. That needs an NPC's state per character (hidden or dead for those on the
  quest) in a shared world, and a quest effect to set it.


- Repeatable and daily quests (`repeat`).
- Escorts, defend-a-place and timed events as parts.
- A generated history per settlement that chains uncover (GAMEPLAY.md, *History*).
- Party sharing of quests, once there are parties.
- More languages.
- A player map that fills in, and the markers on it.
- A dev page: the quest viewer (GAMEPLAY.md's *Later* list).
