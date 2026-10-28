# Progression

The plan for step 8 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: disciplines and progression.
Afterwards a character is made from **origins** (a people and a class, or whatever slots a game
defines) and carries any number of **disciplines**, each with its own XP, level and curve. XP comes
from data-defined **sources**: kills, a dummy beaten, hits dealt and taken, casts, items and skills
that grant it, and hooks for quests, gathering and crafting. Levels give **unlocks**: abilities
(learned at once, from a trainer, from an item or from a talent), stat modifiers, resources,
talent points and knowledge. **Talent trees** cover both point trees and milestone choices.
Disciplines and classes can be **generated per seed from templates**, as item types and creature
kinds are, so a game's rules can be procedural too. The server owns all of it, tells the owner,
and emits XP and level-up events for the feedback system's cues.

**Status: done** (steps 1-7 below). [As built](#as-built) notes where the build differs.

## Decisions

Asked and answered before this plan was written:

| Question | Decision |
|---|---|
| Model | **Configurable, not chosen.** The engine must express Classic (one character level from kills), class levels, OSRS (use-based skills, a combat level as a formula), gear-based progression and any mix. Nothing in code means "combat" or "class"; the game config does |
| Kill credit | **Configurable** per XP source: everyone who fought, split evenly, by damage share, first to hit, or most threat |
| Pace and cap | **Configurable**: a curve formula and a cap formula per discipline |
| Learning abilities | **Configurable, every way**: automatic at a level, from a trainer, from an item, from a talent; quests later. One mechanism: an unlock makes an ability *available* or *known* |
| Generation | **Templates now.** `disciplineTemplates/` and `originTemplates/` make disciplines and classes per seed - axes, rolled curves, abilities and talents picked from pools - as `itemTemplates/` make item types |
| Core's first configuration | **A mixed showcase**: a character level from kills, a class level from casting class abilities, use-based weapon skills and defence, gathering and crafting with hooks only, one trainer-taught and one book-taught ability |
| Talents | **Both shapes in core**: a small point tree per class, and a milestone choice row (pick one of three) on the character level |
| Races and classes | **A separate, generic folder**: `origins/`. An origin fills a *slot* the game config names (`people`, `class`; a game could add `background` or `deity`). A people names a body race (CHARACTERS.md's `races/`) for its look; the server never reads bodies |

## Principles

- **The engine has mechanisms; packs have rules.** The engine knows disciplines, XP, curves, caps,
  sources, unlocks, points, talent trees, origins and their slots. It knows no discipline, class or
  people by name. The one link to the rest is that a discipline may name a stat its level is
  written into, and `level` is only a stat that core's character discipline happens to set.
- **Levels are stats.** A discipline with `stat: "swordSkill"` sets that stat's base to its level.
  So every formula in the game can read it: derived stats (a combat level is a formula), skills
  (ABILITIES.md's attributes), item `requires` (ITEMS.md), creatures' aggro radius, loot `when`.
  Nothing in those systems learns that disciplines exist.
- **Unlocks go through the doors that exist.** Abilities are spells granted under a source
  (ABILITIES.md, *Spells*), modifiers are modifiers under a source (ENTITIES.md), resources are
  added to the entity's block. Taking them away is removing the source.
- **Saved later, saveable now.** A character's progress is a small record of ids and numbers: its
  origins, each discipline's level and XP, its talent ranks, what it has learned and how. Everything
  else (points left, what is unlocked, its modifiers) is worked out again from that record, so
  loading a save is the same code as levelling up.
- **Deterministic from the seed.** Generated disciplines, classes and talent trees come from the
  packs and the world seed. The same seed gives the same ruleset on every server and client.
- **Progression is gameplay content.** Its folders are read into `ProgressionRules` beside the
  others, once per server, with the seed; the world resolver skips them.
- **Server side.** XP is worked out on the server only. The client is told its own numbers and
  draws a panel. Others see only a level-up (so it can glow) and whatever stats are `visible: "all"`.

## Pack folders

New, read by `src/sim/rules/progressionRules.ts` (joining `GAME_FOLDERS`):

| Folder | What it holds |
|---|---|
| `disciplines/` | Authored disciplines |
| `disciplineTemplates/` | Templates that generate disciplines |
| `origins/` | Authored origins: peoples, classes, anything a slot holds |
| `originTemplates/` | Templates that generate origins |
| `talentTrees/` | Authored talent trees |
| `rules/progression.json5` | The game config: slots, defaults, which discipline is "the" level for the HUD |

## Disciplines

`disciplines/<id>.json5`:

```json5
// disciplines/adventure.json5 - the character level, Classic style
{
  name: "Adventure",
  stat: "level",                        // its level is the base of this stat
  start: 1,                             // the level a character starts at (origins can raise it)
  cap: 60,                              // a formula of the earner's stats; it is checked when XP comes in
  next: { add: [{ mul: [{ pow: ["level", 2] }, 40] }, { mul: ["level", 60] }] },   // XP from `level` to the next
  overflow: "lose",                     // XP past the cap: "lose" or "keep" (banked, used if the cap rises)
  rate: "adventureXpRate",              // an optional stat every gain is multiplied by (a people's +10%)
  xp: [                                 // where its XP comes from (see *XP sources*)
    { on: "kill", amount: { ... }, credit: "all" },
    { on: "defeat", amount: { mul: [10, "victim.xpValue"] } },
    { on: "quest" },
  ],
  unlocks: [                            // what levels give (see *Unlocks*)
    { at: [3, 6, 9], points: { choice: 1 } },
    { from: 2, points: { talent: 1 } },
  ],
  visible: "all",                       // others see its level-ups; its numbers go to the owner only
}

// disciplines/defence.json5 - OSRS style: rises by being hit, gives armour every level
{
  name: "Defence",
  stat: "defenceSkill",
  cap: { mul: ["level", 5] },           // can't run ahead of the character
  next: { add: [20, { mul: ["level", 8] }] },
  xp: [{ on: "hitTaken", amount: { min: [{ div: ["amount", 4] }, 5] } }],
  unlocks: [{ from: 1, modifiers: [{ stat: "armor", kind: "flat", value: { mul: ["level", 4] } }] }],
}
```

| Field | |
|---|---|
| `name` | Shown |
| `stat` | A stat whose base is the discipline's level. Optional: a discipline without one is still read as `disc.<id>` in progression formulas |
| `start` | The starting level, default 1. 0 means the character does not have it until something gives it (*Having a discipline*) |
| `cap` | Highest level, a formula of the earner's stats (so a cap can follow another discipline) |
| `next` | XP needed from `level` to `level + 1`, a formula of `level` and the earner's stats. Checked at load to be positive up to the cap's static bound |
| `overflow` | `lose` (default) or `keep` |
| `rate` | A stat every gain is multiplied by |
| `xp` | Its sources, below |
| `unlocks` | Its unlocks, below |
| `visible` | `owner` (default) or `all`: whether others are told of its level-ups |
| `group`, `order` | For the panel: `combat`, `gathering`, `crafting`... free strings, and an order |

**Having a discipline.** A character has every discipline whose `start` is above 0. One with
`start: 0` is gained when an unlock or an origin gives it (`disciplines: { mining: 1 }`), so a
class discipline exists only for characters with a class, and a game can hide a profession until it
is taught.

**A level-up** happens when XP reaches `next`: the level rises, the stat is set, the XP over
`next` carries on to the following level (several levels at once if it is enough), and that
level's unlocks apply. XP never goes down in this step (death penalties are later).

## XP sources

A source is `{ on, amount, ...filters }` in a discipline's `xp`. `amount` is a formula; its names
depend on the source. Every source may have `when` (a formula that must not be 0) and `rate`
(multiplied in).

| `on` | When | Names in `amount` and `when` |
|---|---|---|
| `kill` | A creature dies (CREATURES.md's kill record). `credit` says who earns: `all` (default: everyone on its threat table at death, full amount), `split` (evenly), `damage` (by share of damage dealt), `first` (the first to hit it), `top` (most threat). Non-players never earn | `victim.<stat>`, `earner.<stat>`, `earners` (how many), `share` (this earner's share, 0-1) |
| `defeat` | A unit that does not die (`mortal: false`, the dummy) reaches 0 health: credit as `kill`, once until it is back above 0 | as `kill` |
| `hitDealt`, `hitTaken` | A combat `hit` the earner dealt or took. `tags` / `notTags` on the skill, `weapon` (below), `periodic` | `amount` (the damage), `caster.<stat>`, `target.<stat>`, `earner.<stat>` |
| `healDealt` | A `heal` the earner did. Overheal does not count | as above |
| `cast` | The earner's cast went off (`castDone`). `tags`, `spellSource` (a prefix of the spell's source: `origin:class` for the class's own abilities) | `caster.<stat>`, `level` (the spell's) |
| `skill` | A skill's `xp` action (*Actions* below) gave it: eating, a potion, any skill a gathering node or a recipe casts later | `amount` as the action passed it |
| `gather`, `craft`, `quest` | Hooks for later steps: `progression.award(entity, on, details)` with a `tags` list. Nothing calls them yet | `amount`, `earner.<stat>`, `node.level` / `recipe.level` / `quest.level` |

- **`weapon`** matches the earner's main-hand item: `{ template: "sword" }`, `{ type: "rustyKnife" }`,
  `{ kind: "weapon" }` or `"none"` (bare hands). This is what makes a weapon skill rise only with
  that weapon.
- **Credit for `damage` and `first`** comes from the hits the progression system sees: it keeps, per
  victim, who hit it first and how much each dealt, dropped when it dies, despawns or evades home.
  The skill and creature systems need no change.
- **Level difference** is the formula's business, as everything is. Core's kill XP is Classic's
  shape: `45 + 5 × victim.level` at the same level, more above, less below, and 0 once the victim is
  grey (`victim.level` at or below a gap that grows with the earner's level).
- **`xpValue`** is a core stat (default 1) that templates and species set to scale what a unit is
  worth: the dummy 0.2, a camp's captain 2. It is content, not engine.

## Unlocks

A list per discipline; each entry applies at some levels:

```json5
unlocks: [
  { at: 2, skill: "thunderClap" },                               // learned at once (how: "auto")
  { at: 4, skill: "kick", how: "trainer", cost: 100 },           // available: a trainer teaches it, for money
  { at: 6, skill: "frostNova", how: "item" },                    // available: a book teaches it (*Learning*)
  { from: 1, modifiers: [{ stat: "armor", kind: "flat", value: { mul: ["level", 4] } }] },
  { from: 2, points: { talent: 1 } },                            // one talent point each level from 2
  { at: [3, 6, 9], points: { choice: 1 } },
  { at: 5, resource: "rage" },                                   // a resource the character did not have
  { at: 10, disciplines: { mining: 1 } },                        // starts another discipline
  { at: 15, knows: ["recipe.ironIngot"] },                       // free knowledge: recipes, map lore, later
]
```

| Field | |
|---|---|
| `at`, `from`, `every`, `to` | Which levels: one or a list (`at`), or every `every` levels (default 1) from `from` to `to` |
| `skill`, `level`, `how`, `cost` | An ability. `how`: `auto` (default: granted now), `trainer`, `item`, `talent` (only a talent node grants it), `quest` (later). `level` is the spell's level (a rank). `cost` is money for a trainer |
| `modifiers` | `{ stat, kind, value }`, `value` a formula of the discipline's `level` and the earner's stats. Held under the source `disc:<id>` and worked out again on each level-up, so per-level growth is one entry |
| `points` | Talent points by pool name: `{ talent: 1 }` |
| `resource` | A resource the character gains (filled to its `start`) |
| `disciplines` | Disciplines it starts, at the given level |
| `knows` | Free strings a later system checks (`recipe.*`, `lore.*`): kept and saved, checked by nobody yet |

- **Origins add unlocks too**, keyed by discipline: a class says what its class discipline's levels
  give (*Origins*). A character's unlocks are the discipline's own plus those of its origins for it.
- **Unlocks apply in order of level**, and the same code applies them on loading a save: a character
  loaded at level 9 gets everything a character that levelled to 9 has.
- **Abilities known** are spells under the source `learn:<how>` (`learn:auto`, `learn:trainer`...),
  so the spellbook and the inspector say where each one came from, and a reset takes them away by
  source. Keys 1-9 keep casting in spellbook order, which now grows as abilities are learned.

### Learning

- **`auto`**: granted when the level is reached.
- **`trainer`**: the ability becomes *available*; an entity whose template has `trainer: { teaches }`
  (a list of skills, `"*"` for any) teaches it within `trainRange` for `cost`. Core places a trainer
  near the start beside the strongbox; NPC trainers come with step 9. Message: `learn { trainer, skill }`.
- **`item`**: available, and an item whose `use` casts a skill with a `learn` action teaches it -
  a book. Using it before the level is refused ("not yet"), and the book is not used up.
- **`talent`**: only a talent node's `skill` grants it.
- **Without an unlock** a trainer, a book or a talent may still teach an ability if its own entry
  says `free: true` - a book of a spell anyone may learn. Otherwise "you cannot learn that".

## Talent trees

`talentTrees/<id>.json5`. One mechanism for both shapes:

```json5
// talentTrees/warriorArms.json5 - a point tree
{
  name: "Arms",
  points: "talent",                       // the pool its nodes cost
  tiers: [
    { requires: 0 },                      // points spent in this tree to open the tier
    { requires: 3 },
    { requires: 6 },
  ],
  nodes: {
    toughness: { tier: 0, ranks: 3, modifiers: [{ stat: "armor", kind: "percent", value: { mul: ["rank", 3] } }] },
    swiftStrikes: { tier: 0, ranks: 2, modifiers: [{ stat: "weaponSpeed", kind: "percent", value: { mul: ["rank", -4] } }] },
    longStun: { tier: 1, ranks: 2, modifiers: [{ stat: "stunDuration", kind: "flat", value: { mul: ["rank", 0.25] } }] },
    deepWounds: { tier: 1, ranks: 1, requires: ["swiftStrikes"], skill: "deepWounds" },
    mortalStrike: { tier: 2, ranks: 1, requires: ["deepWounds"], skill: "mortalStrike", cost: 1 },
  },
}

// talentTrees/milestones.json5 - a choice row: one pick per tier
{
  name: "Milestones",
  points: "choice",
  tiers: [
    { requires: 0, pick: 1, level: 3 },   // `level`: the character must be this level in the tree's discipline
    { requires: 0, pick: 1, level: 6 },
    { requires: 0, pick: 1, level: 9 },
  ],
  discipline: "adventure",
  nodes: {
    vigour: { tier: 0, modifiers: [{ stat: "stamina", kind: "percent", value: 10 }] },
    focus: { tier: 0, modifiers: [{ stat: "intellect", kind: "percent", value: 10 }] },
    haste: { tier: 0, modifiers: [{ stat: "speed", kind: "percent", value: 8 }] },
    ...
  },
}
```

| Field | |
|---|---|
| `points` | The point pool its nodes cost |
| `tiers` | Each: `requires` (points spent in this tree to open it), `pick` (how many nodes of the tier may be taken; default all), `level` (a level of the tree's `discipline` needed) |
| `nodes` | Each: `tier`, `ranks` (default 1), `cost` per rank (default 1), `requires` (nodes that must be at full rank), and what it gives per rank - `modifiers` (formulas of `rank`), `skill` (granted at rank 1, `level` from `rank` for ranked abilities), `resource`, `points` |
| `discipline` | The discipline `level` in tiers refers to |

- **Who has which trees**: origins list them (`trees: ["warriorArms"]`), and so can disciplines (core's
  milestones belong to `adventure`).
- **Talents are attributes**, as ABILITIES.md planned: a node is mostly modifiers on stats that
  skills read (`stunDuration`, `fireCastTime`), under the source `talent:<tree>`. Nodes that grant
  an ability grant it under `learn:talent`.
- **Choosing** is `talentPick { tree, node }`; refused unless the tier is open, the pick count and
  `requires` hold, and the pool has points. **Resetting** is `talentReset { tree }`, whose cost is a
  formula in `rules/progression.json5` (`respec: { cost: ... }`, money) - free in core for now.
- **Points** are worked out, not stored: every pool's total from the unlocks of the levels reached,
  minus what the ranks taken cost.

## Origins

`origins/<id>.json5`. An origin fills one slot; a character has one per slot the game config lists.

```json5
// rules/progression.json5
{
  slots: {
    people: { required: true, default: "human" },
    class: { required: true, default: "warrior" },
  },
  level: "adventure",          // the discipline the HUD and the panel show as "the" level
  trainRange: 4,
  respec: { cost: 0 },
}

// origins/dwarf.json5 - a people
{
  slot: "people",
  name: "Dwarf",
  look: { race: "dwarf" },                         // the body (CHARACTERS.md); the player's own look still wins
  stats: { stamina: 2, strength: 1, agility: -1 }, // added to the player template's bases
  modifiers: [{ stat: "armor", kind: "percent", value: 5 }],
  disciplines: { mining: 5 },                      // starting levels
  spells: [],                                      // a racial ability would go here
  never: ["mage"],                                 // origins this one cannot be combined with
}

// origins/mage.json5 - a class
{
  slot: "class",
  name: "Mage",
  resources: ["mana"],
  stats: { intellect: 4, stamina: -1 },
  spells: [{ skill: "autoAttack" }, { skill: "fireball" }],
  disciplines: { class: 1 },
  unlocks: { class: [{ at: 2, skill: "frostNova" }, { at: 3, skill: "searingTotem", how: "trainer", cost: 50 }] },
  trees: ["mageFire"],
}
```

| Field | |
|---|---|
| `slot` | Which slot it fills |
| `name`, `look` | `look` merges over the player template's (a people's body race, a class's outfit) |
| `stats`, `modifiers`, `resources`, `spells` | As a template's (ENTITIES.md): stats *add* to the player template's bases, modifiers sit under `origin:<slot>`, resources and spells add |
| `disciplines` | Disciplines it starts and their levels; a higher start wins over the discipline's own |
| `unlocks` | By discipline id: entries as in *Unlocks* |
| `trees` | Talent trees it gives |
| `only`, `never` | Origins it must or must not be combined with |

- **A character's template is made from its origins.** For each allowed combination the rules make a
  flat template, `player.<people>.<class>` (slots in config order), from `player` with each origin
  merged over it. It joins `GameRules.templates`, as creature kinds do, so spawning, replication and
  the client need nothing new; the client makes the same table from the same packs and seed.
- **Choosing**: Hello gains `origins` (slot → origin id), from the page's address
  (`?people=dwarf&class=mage`) until character creation. A missing or unknown one takes the slot's
  `default`; a combination that `never` forbids takes the defaults.
- **The look**: a people's body race is used unless the player's own look names one (the address's
  `?race=` stays, for the workbench's sake).

## Generated disciplines and origins

`disciplineTemplates/` and `originTemplates/` make many from parts, as `itemTemplates/` do (ITEMS.md,
*Generated item types*), and the seed varies them:

```json5
// disciplineTemplates/weaponSkill.json5 - one discipline per weapon, its curve rolled per seed
{
  name: "{weapon}",
  stat: "{weapon.stat}",
  group: "combat",
  cap: { mul: ["level", 5] },
  next: { add: [{ mul: ["var.base", 1] }, { mul: ["level", "var.slope"] }] },
  vars: { base: [8, 14], slope: [2, 4] },          // rolled from the seed and the discipline's id
  axes: {
    weapon: [
      { id: "sword", name: "Swords", stat: "swordSkill", match: { template: "sword" } },
      { id: "unarmed", name: "Unarmed", stat: "unarmedSkill", match: "none" },
    ],
  },
  xp: [{ on: "hitDealt", tags: ["melee"], weapon: "{weapon.match}", amount: 1 }],
}

// originTemplates/hybrid.json5 - classes the seed invents from parts
{
  slot: "class",
  name: "{school} {role}",                         // "Flame Warden", "Holy Blade"...
  keep: [2, 2],                                    // how many of the combinations a world keeps
  axes: {
    role: [
      { id: "blade", name: "Blade", resources: ["rage"], spells: [{ skill: "autoAttack" }, { skill: "heroicStrike" }], stats: { strength: 3 } },
      { id: "warden", name: "Warden", resources: ["mana"], spells: [{ skill: "autoAttack" }, { skill: "shield" }], stats: { stamina: 3 } },
    ],
    school: [
      { id: "flame", name: "Flame", resources: ["mana"], spells: [{ skill: "fireball" }] },
      { id: "holy", name: "Holy", resources: ["mana"], spells: [{ skill: "renew" }] },
    ],
  },
  abilities: { pick: [2, 3], pool: [{ skill: "charge" }, { skill: "thunderClap" }, { skill: "kick" }, { skill: "searingTotem" }], at: [2, 6] },
  tree: { name: "{school} {role}", nodes: { pick: [5, 6], pool: "talentPools/general" } },
  disciplines: { class: 1 },
  only: [],
  never: [{ role: "warden", school: "holy" }],
}
```

- **Disciplines**: one per combination of the axes' parts, ids `<template>.<part>...`
  (`weaponSkill.sword`); `{axis}` and `{axis.field}` fill strings anywhere in the template. `vars` are
  rolled from the world seed and the discipline's id and read as `var.<name>` in its formulas, so one
  world's swords level faster than another's. Each part's `stat` must be a stat that exists: the
  stat table is not generated (*Not in this step*).
- **Origins**: one candidate per combination, minus `never`; the world keeps `keep` of them, picked
  from the seed. Each kept one gets its parts merged (lists add, as a creature's variant does), then
  `abilities.pick` abilities drawn from the pool, learned at levels spread over `at`, and a talent
  tree built from `tree`: nodes drawn from a node pool (`talentPools/<id>.json5`: nodes without
  tiers) and laid out in tiers by their `weight` order.
- **Whitelists and blacklists** (GAMEPLAY.md): `only` and `never` on combinations, and
  `rules/progression.json5`'s `never` for whole templates, disciplines or origins a game turns off.
- **Names** are templates filled from the parts' names, for localisation later as item names are.
- **The same seed, the same ruleset**: generated content is resolved with the seed in the page and in
  Node, and Welcome carries a hash of the progression tables (`progression`, u32).

## Actions

Two new action kinds, registered by the progression module through ABILITIES.md's `registerAction`,
so skills can use them and nothing in `src/sim/skills` changes:

| Kind | What it does |
|---|---|
| `learn` | `skill`: teaches the group (default the host) that ability - what a book's skill does. Fails for a character that may not learn it yet, and the item is then not used up |
| `xp` | `discipline`, `amount` (a formula): gives XP through that discipline's `skill` source - a potion, eating, later a gathering node's or a recipe's skill |

## The character's progress

A `progress` part on every player entity:

```ts
// src/sim/progression/progress.ts
interface ProgressPart {
  origins: Map<string, string>;             // slot -> origin id
  disciplines: Map<number, { level: number; xp: number; banked: number }>;  // by discipline index
  talents: Map<number, Map<number, number>>;  // tree -> node -> rank
  learned: Map<number, string>;             // skill index -> how ("trainer", "item", "talent", "auto")
  available: Set<number>;                   // skills unlocked to be taught (trainer, item)
  knows: Set<string>;
  // worked out, never saved:
  points: Map<string, number>;              // pool -> points left
  trees: number[];                          // trees it has
}
```

**Saved state** (GAMEPLAY.md, *Saved state*: "every discipline's level and progress, talent trees and
choices, the spells known") is this, by id:

```ts
interface SavedProgress {
  origins: Record<string, string>;
  disciplines: Record<string, { level: number; xp: number; banked?: number }>;
  talents: Record<string, Record<string, number>>;
  learned: Record<string, string>;          // skill id -> how
  knows: string[];
}
```

- `exportProgress(entity)` and `importProgress(entity, saved)` exist now and the probe round-trips
  them; character saves will call them. Loading applies every unlock up to each level, then the
  talents, then the learned abilities, in that order. An id the packs no longer have is skipped and
  reported, never an error that stops a load.
- **XP debt and other death penalties** are game config (GAMEPLAY.md, *Death*) and come later; the
  record has room for a `debt` per discipline.

## Messages

Server to client:

```ts
// The own player only: everything on arrival, then what changed.
{ type: "progress", origins: string[], disciplines: DisciplineState[], points: PointState[],
  talents: TalentState[], learned: LearnedState[], available: number[] }
{ type: "progressEvents", events: ProgressEvent[] }      // the own player only, once per step

DisciplineState { discipline, level, xp, next, cap }    // u16, u16, f64, f64, u16
PointState      { pool, left, total }                   // short string, u16, u16
TalentState     { tree, node, rank }                    // u16, u16, u8
LearnedState    { skill, how }                          // u16, short string
ProgressEvent   { kind, discipline, amount, level, skill, source }
                // kind: xp, levelUp, learned, unlocked, talent, refused; source: what gave the XP ("kill", "hitTaken"...)
```

- **Level-ups are combat events too**: a new kind `levelUp` (source the character, `amount` the new
  level, `name` the discipline id), so everyone who sees the character gets it, for a glow and a
  sound. Only for disciplines marked `visible: "all"`.
- **XP and level-up for the feedback system**: the client raises client events `xpGained`,
  `levelUp`, `disciplineUp` (a discipline other than the config's `level`), `learned` and
  `talentPicked` from these. FEEDBACK.md's event table gets those keys (its *Later events*); no
  feedback code changes for them.
- Client to server: `talentPick { tree, node }`, `talentReset { tree }`, `learn { trainer, skill }`;
  debug `debugXp { discipline, amount }` and `debugLevel { discipline, level }`.
- **Welcome gains** `progression` (u32, the tables' hash). `PROTOCOL_VERSION` goes up by one.

## The client

- **`game/progressMirror.ts`**: what the server last said of the own progress.
- **A minimal panel** (`ui/progressPanel.ts`, `P`): the origins; every discipline with its level, an
  XP bar and its cap, grouped; points left per pool; each talent tree as tiers of nodes that a click
  takes (greyed when not open, ranks shown); abilities known and how, and those available with where
  to learn them; at a trainer, its list with *Learn*. Debug buttons: +XP and +1 level on any
  discipline. Plain DOM, as the inventory; HUD proper is step 10.
- **The own frame** shows the config's `level` and a thin XP bar under it; a level-up flashes it.
- **Floating text**: "+50 XP" over the own player (Adventure only, as Classic shows it), and the
  discipline's name and new level on a level-up.
- **The rule book** (`ui/ruleBook.ts`, `K`, asked for after the plan): a screen that explains how
  this game works, written from the rules the client loaded, so it is right for any pack set and any
  seed. Simple now - chapters and plain tables - and made friendlier later. Chapters: *Disciplines*
  (each one's levels, cap, XP table for the first levels, where its XP comes from, what levels give),
  *Origins* (each people and class: stats, abilities, unlocks by level, trees), *Talents* (each tree's
  tiers and nodes), *Stats* (each stat and its formula), *Resources*, *Combat* (the GCD, the roll
  formulas) and *Abilities* (cost, cooldown, range). Formulas are shown as readable text by a pure
  `formulaText` (`45 + 5 × victim level`), the page's own character's numbers beside them where it
  has them.
- `__aiworld.progress` - `mine()`, `xp(discipline, n)`, `level(discipline, n)`, `pick(tree, node)`,
  `reset(tree)`, `learn(trainer, skill)`, `export()`, `import(saved)`, `rules()`.

## Core content: the showcase

| What | |
|---|---|
| `adventure` | The character level (`level`): kills (credit `all`, Classic's shape) and the dummy's `defeat`; cap 60; level 2 after about five same-level kills; a talent point a level from 2, a choice at 3, 6 and 9 |
| `class` | The class level, `start: 0`, given by every class: XP from casting the class's own abilities (`spellSource: "origin:class"`), cap the character's level. Each class's unlocks hang on it |
| `defence` | Use-based: XP from hits taken, cap 5 × level, +4 armour a level |
| `weaponSkill.sword`, `weaponSkill.unarmed` | Generated: XP from melee hits with that weapon, cap 5 × level, curves rolled per seed. Iron swords `require` sword skill 10 (an item requirement) |
| `mining`, `herbalism`, `cooking` | Gathering and crafting, `start: 0`: hooks only (dwarves start mining at 5, elves herbalism); eating bread gives cooking a little XP through the `xp` action, to show the path |
| Peoples | `human` (+10% adventure XP through `adventureXpRate`), `dwarf` (stamina, armour, mining), `elf` (agility, intellect, herbalism) |
| Classes | `warrior` (rage: Heroic Strike, Charge; Thunder Clap at class 2, Kick from the trainer at 3), `mage` (mana: Fireball; Searing Totem at 2, Frost Nova from a book at 3), `priest` (mana: Renew, Shield; a smite at 2), plus two generated `hybrid` classes per seed: five, as GAMEPLAY.md says |
| Trees | `warriorArms`, `mageFire`, `priestLight` (about six nodes in three tiers each), the hybrids' generated trees, and `milestones` on adventure |
| Items, entities | A trainer by the start (`trainer: { teaches: "*" }`), the *Tome of Frost Nova* (a book), and `xpValue` on the dummy and the species |

Today's test kit (every spell on every player) goes: the classes split it. The inspector keeps a
*learn everything* button for testing skills.

## Debug, the server and the test

- **The inspector** shows the progress part of any player (from `server.debug` in single player).
- **`npm run server -- --config tiny --bot --hunt`** prints XP gained per kill and level-ups;
  `--class mage --people dwarf` picks the bot's origins.
- **The probe**, `scripts/probe/progression.mjs`:
  - Rules: core's disciplines, origins, trees and templates load; generated disciplines and classes
    are the same for one seed twice and differ for another; broken content (an unknown stat, skill,
    tree, node, origin, slot, a cycle in `requires`, a curve that is not positive, a tier no node
    can open) gives the expected errors naming file and path.
  - Curves: XP to a level, several levels from one gain, the cap with `lose` and `keep`, a cap that
    follows another discipline rising.
  - Sources: kill credit under each rule with two players and damage split 70/30; the dummy's
    defeat once per 0; hits with and without a sword for the weapon skills; `cast` only for class
    spells; the `xp` action.
  - Unlocks: an `auto` ability at its level, a `trainer` one available and then taught (range,
    cost), a book refused before its level and taught after, modifiers growing per level, a resource
    added, a discipline started.
  - Talents: points per level, a tier opening at 3 spent, `pick: 1` refusing a second, `requires`,
    a reset giving every point back and removing its modifiers and abilities.
  - Origins: every allowed combination's template, `never` refused, stats adding, the look's race.
  - Saves: export at level 7 with talents and learned abilities, import into a fresh character, the
    same stats, spells and points.
  - On a real `tiny` server with a client: killing a wolf gives the expected XP and `progress`
    messages; a level-up is a `levelUp` combat event the second client sees.
- **In the game** (`?config=tiny&class=warrior`): beat the dummy and kill wolves; XP floats up; at
  level 2 Thunder Clap is learned and keys to the next number; `P` shows disciplines rising (sword
  skill from swinging, defence from being bitten); a talent point spent changes the stat in the
  inspector; at 3 the trainer teaches Kick and the milestone row opens. `?class=mage` reads the Tome.

## Code

| File | What |
|---|---|
| `src/sim/rules/progressionRules.ts` | The six folders: disciplines, origins, trees, templates and generation, origin combinations as templates, checks, the hash |
| `src/sim/progression/progress.ts` | The part: XP, levels, unlocks, points, talents, learning - pure functions |
| `src/sim/progression/sources.ts` | Kill and defeat credit, events to XP, the damage ledger |
| `src/sim/progression/actions.ts` | The `learn` and `xp` action kinds |
| `src/sim/progression/system.ts` | What the server calls: adopt with origins, kills, events, messages, the trainer, debug |
| `src/sim/progression/save.ts` | Export and import |
| `src/sim/progression/replication.ts` | `progress` and `progressEvents` for the owner |
| `src/game/progressMirror.ts`, `src/ui/progressPanel.ts` | The client |
| `src/sim/rules/formulaText.ts`, `src/ui/ruleBook.ts` | Formulas as readable text; the rule book |
| `src/sim/resources.ts` | Gains `addResource` (a block's resources are no longer fixed by the template alone) |

## Steps

Each leaves the game working: dev server, `npm run probe`, `npm run server`, `npm run build`.

1. **Rules.** `progressionRules.ts` with authored disciplines, origins and trees, the config, the
   checks and the hash; loaded in the page and in Node (errors on the loading screen). Core's
   content, with the player template unchanged so far. The probe's rules part.
2. **Progress, headless.** The part, curves, unlocks, talents, learning, save and load, as pure
   functions over an entity. The probe's curves, unlocks, talents and saves parts.
3. **Sources and the server.** The system in the server: origins from Hello and their templates,
   kills, defeats, events, the `learn` and `xp` actions, the trainer and the book; core's player
   template split into classes. `--hunt` prints XP. The probe's sources and origins parts.
4. **Generation.** `disciplineTemplates/`, `originTemplates/`, `talentPools/`: weapon skills and the
   hybrid classes. The probe's generation parts.
5. **Messages and the client.** The protocol bump, the messages, the `levelUp` combat event, the
   mirror, the panel, the frame's XP bar, floating XP, client events for feedback,
   `__aiworld.progress`. The probe's server part. Checked in `?config=tiny`.
6. **The rule book.** `formulaText`, `ui/ruleBook.ts` with its chapters; the probe prints every
   formula of core as text. Checked in the game.
7. **Wrap up.** `public/packs/README.md` (the new folders), SIMULATION.md's message list,
   ENTITIES.md, ABILITIES.md, ITEMS.md and CREATURES.md where they point at progression; this file's
   *As built*; GAMEPLAY.md's step 8 marked done.

## As built

- **Files**: `src/sim/rules/progressionRules.ts` (the folders, readers, checks, origin combinations,
  `checkProgressionItems`), `progressionTemplates.ts` (templates to raw objects the same readers
  read), `formulaText.ts`; `src/sim/progression/`: `progress.ts` (the part and every rule of it),
  `system.ts` (what the server calls: origins, kills, defeats, events, trainers, books, debug),
  `actions.ts`, `replication.ts`, `save.ts`. Client: `game/progressMirror.ts`, `ui/progressPanel.ts`,
  `ui/ruleBook.ts`; the combat HUD's own frame has an XP bar, floating text a `say`. Small additions:
  `addResource` (resources.ts), `killed` in the creature world, `source` on compiled formulas,
  `scripts/diskContent.mjs`'s `loadProgressionRulesFromDisk`.
- **Names in formulas.** A stat keeps its own name, so in a discipline's `cap` and `next` `level` is
  the character's level stat; the discipline's own level is **`own`** (and `disc.<id>` any other's,
  `var.<name>` a rolled var). Unlock modifiers read `own`, talent nodes `rank`. Sources read
  `earner.<stat>`, `victim.<stat>` (also `other.<stat>`: the other unit of a hit or a cast),
  `amount`, `earners`, `share`, `own` and `spellLevel`. The examples above that write `level` for a
  discipline's own level mean `own`.
- **The base template.** Origins merge over `rules/progression.json5`'s `base`, core's abstract
  `entities/character.json5`; `player` extends it with the old test kit and is what a server without
  progression makes (the ability and item probes). The page's player is a human warrior unless the
  address says `?people=` and `?class=`; a people's body race is used unless it says `?race=`.
- **Trainers are named in the config** (`trainers: { trainer: { teaches: "*" } }`), not by a template
  field, so the entity templates' reader needed no change. Core places one by the mainland's start.
- **`progress` is sent whole** whenever it changed (and on arriving somewhere), not as a difference:
  it is a few dozen numbers. Events go in `progressEvents`, once a step.
- **Sources of spells**: `learn:<how>` for what was learned, `talent:<tree>` for a node's ability
  (with its modifiers). A `learn` action teaches the way `item`. `cast` sources with
  `spellSource: "origin:<slot>"` match the skills that slot's origin gives or unlocks.
- **Class XP banks** while the class is at the character's level (cap `level`, `overflow: "keep"`) and
  flows on when the character levels - banked XP flows after any level change, `setLevel` included.
- **Generated content**: `weaponSkill` makes Swords and Unarmed with rolled curves; `hybrid` keeps two
  of three role-and-school classes per world (seed 1338: Holy Blade and Flame Warden), each with two
  or three abilities from a pool at class levels 2-6 and a tree of five or six nodes from
  `talentPools/general` (`<origin>.tree`). Iron swords require sword skill 10 through their template
  part's own `requires`.
- **Not built**: `free: true` on books and trainers; a respec cost (the formula is read, core's is 0).
- **The rule book explains itself** (asked for after the step): `src/sim/rules/ruleIndex.ts` finds, in
  the rules, what reads each stat (derived stats, resources, skills, rolls, item requirements,
  disciplines) and what changes it (disciplines, unlocks, origins, talents, items, auras);
  `skillText.ts` describes each skill from its actions. The book opens with *Your character*, gives
  every stat and discipline "what it does / where it comes from / how it rises" with the player's own
  values, every ability its effects and who gets it, and links every name to its page. The panel has
  a Character section of the own stats, and its names open the book there (`book.open(key)`). It
  shows honestly where a discipline does nothing yet (Unarmed, Mining, Herbalism).
- **Feedback**: the `levelUp` combat event reaches everyone near; the page raises the client events
  `xpGained`, `levelUp`, `disciplineUp`, `learned` and `talentPicked`, which play nothing until the
  feedback rules list them (`CLIENT_EVENTS`) and core maps them to cues.
- **Headless**: `npm run server -- --config tiny --bot --hunt --class mage --people dwarf` prints XP
  per kill, level-ups and what is learned.
- **The probe** (`scripts/probe/progression.mjs`, 140 checks, about 20 s): rules and refusals,
  generation per seed, the rule book's text, curves, unlocks, talents and saves on a stand-in
  character, and a real `tiny` server with two clients - origins, kill credit, the dummy's defeat,
  use-based XP, the class bank, a level-up seen by the other client, the owner's messages, the
  trainer, the book, the iron sword's requirement and a talent picked by message.
- **Checked in the game** (`?config=tiny&class=warrior&people=dwarf`): a dwarf warrior with its kit;
  the dummy beaten gives 27.6 XP once per 0, a timber wolf 50; swords and defence rise from fighting;
  Adventure 2 and class 2 teach Thunder Clap onto key 3; P shows every discipline, the trees and the
  available Kick, which the trainer's Learn button teaches for 50 copper; Might taken from the panel
  adds 2 strength; K opens the rule book with this world's generated classes.

## Not in this step

- Generated stats: a generated discipline's `stat` must exist in `stats/`. Generating the stat table
  itself would make every rules table depend on the seed; later, if a game needs it.
- Character creation (a screen to pick origins and looks): the address picks them until step 10's
  screens.
- Saving to disk: the record and its export and import exist; writing them comes with character saves.
- Death penalties (XP debt): game config, later.
- Quests, gathering nodes and recipes: their sources and `knows` are hooks for the steps that make them.
- Party XP sharing and tagging rules for parties: `credit` covers solo and co-op until parties come.
- Creatures with disciplines: a creature's level stays its spawn's.
- Trainers as NPCs with prices by area: a placed trainer entity until step 9.
