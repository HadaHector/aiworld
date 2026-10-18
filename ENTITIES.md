# Entities

The plan for step 3 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: entities, stats and resources,
defined in packs and owned by the server. Afterwards the player is an entity with health and the
other resources its template gives it; a training dummy stands near the start; stats come from
data, derived ones from formulas in data, and modifiers from any source stack on them in an order
the packs set. The client sees its own player in full and others in part, through spawn, update
and despawn messages. Step 4 (the ability system: effects, auras, cooldowns, threat) is built on
this, so modifiers are made for auras and gear from the start.

**Status: done** (steps 1-6 below). [As built](#as-built) notes where the build differs.

## Decisions

| Question | Decision |
|---|---|
| Entity model | Light: an entity is an id, a dimension, a position and facing, a template, and optional typed *parts* (stats, resources, body). Systems are plain functions over the entities that have a part. No ECS storage |
| Formulas | JSON trees in the pack files (`{ add: [20, { mul: ["stamina", 10] }] }`), compiled once at load. No string parser |
| What others see | Set per stat and per resource in its file: `visible: "owner"` or `"all"`. Default: stats `owner`, resources `all`. The owner sees everything, modifiers included |
| How modifiers stack | Set in data: each *modifier kind* (`modifiers/<id>.json5`) says where it applies (`order`), how its modifiers combine (`gather`), and what it does to the value (`apply`, a formula). The core pack defines flat, percent and multiplier |

## Principles

- **The server owns every value.** Stats, modifiers and resources live in the server's entities
  and nowhere else. The client is told values; it never works one out, not even its own player's.
- **Definitions are not sent.** Both ends resolve the same packs (Welcome already names them), so
  a stat is sent as its index in a table both sides built from the same files, plus a number.
  Welcome carries a hash of those tables, so a client with different packs says so at once
  instead of showing the wrong stat under the wrong name.
- **The engine has mechanisms; packs have rules** (GAMEPLAY.md). The engine knows that stats
  exist, that modifiers come in kinds, and that a resource has a current value, a maximum taken
  from a stat, and a rate. It knows no stat by name. The one name it does know is `health`: every
  entity with resources has one, because death (later) is when it reaches 0.
- **Gameplay content is not world content.** Stats, resources, modifier kinds and templates are
  read by their own resolver into `GameRules`, once per server, not per dimension. The world's
  resolver skips their folders. No world hashes differently.
- **Deterministic and safe formulas.** A formula is a tree of a few dozen fixed operations over
  numbers and stat names. No loops, no calls out, no randomness, no time; every name is checked
  at load, and stats that depend on each other in a circle are a content error.
- **Messages stay flat records** (SIMULATION.md, *Encoding*): a stat or resource value is a
  record of an index and numbers; a modifier a record of indices, a number and a short string.

## The entity model

```ts
// src/sim/entity.ts
interface Entity {
  id: number;                  // u32, unique on the server for its run; never reused
  template: string;            // its template's id - the client looks it up for a name and a look
  name: string;                // the template's, or the player's own
  look: EntityAppearance;      // its seed, and a player's race, outfit and sex - see *Looks* below
  dimension: string;           // the dimension it is in ("" while a player travels)
  x: number; y: number; z: number;   // feet, f64
  facing: number;              // radians about y, 0 facing +z
  inCombat: boolean;           // worked out by the ability system from threat and hostile acts (ABILITIES.md)
  // Parts - each optional, each its own module:
  stats?: StatBlock;           // src/sim/stats.ts
  resources?: ResourceBlock;   // src/sim/resources.ts
  body?: PlayerBody;           // src/sim/playerBody.ts: players now, creatures that walk later
}
```

- **Players are entities.** A player's entity is made when its client says Hello and lasts until
  it leaves, travel included: its stats, modifiers and resources go with it from one dimension to
  the next. Welcome's `playerId` is its entity id. The body is made and dropped as now.
- **Other entities belong to a dimension.** `Dimension` gains `entities: Map<id, Entity>`. When a
  dimension loads, the entities its definition places are made in it; when it is dropped they
  go with it. Players in it are in the same map while they have a body.
- **Placed entities** are a new field of a dimension's definition:

  ```json5
  // dimensions/mainland.json5
  entities: [
    { template: "trainingDummy", at: [6, 4], facing: 180 },  // facing in degrees
  ],
  ```

  They stand on the ground (or a building's floor) at `at`. Each gets a stable key,
  `<dimension>/<index>` - what the world delta (GAMEPLAY.md) will key a looted chest or a killed
  camp by. Portals at a link's `at` come this way later.
- **Nodes, chests, creatures and NPCs** are templates with other parts (an inventory, an AI, a
  loot table) in later steps. Nothing in this step assumes an entity has stats or a body.
- **Systems** are functions the server's step calls in order: bodies move (as now), then
  `stepResources` over every entity with resources, then replication.

## Stats

`stats/<id>.json5`:

```json5
// stats/stamina.json5 - a primary stat: its base comes from the template
{ name: "Stamina", default: 0, min: 0 }

// stats/maxHealth.json5 - a derived stat: its base is a formula of other stats
{
  name: "Max health",
  formula: { add: [20, { mul: ["stamina", 10] }, { mul: ["level", 15] }] },
  min: 1,
  round: "floor",
  visible: "all",
}
```

| Field | |
|---|---|
| `name` | Shown in the inspector, later the character screen. Defaults to the id |
| `default` | The base value of a primary stat when a template does not set it. 0 if left out |
| `formula` | Makes the stat derived: its base is this, worked out from other stats' final values. A template may not set a derived stat's base |
| `min`, `max` | The final value is clamped to these. Default no limits |
| `round` | `none` (default), `floor`, `round` or `ceil`, applied after clamping |
| `visible` | `owner` (default) or `all` |

**A stat's final value**: its base (the template's or its default, or its formula's result), then
each modifier kind in order applied to it, then clamped and rounded. Modifiers apply to derived
stats too: a +10% max-health aura is a percent modifier on `maxHealth`.

**Recomputed when something changes**, not every step: adding or removing a modifier or setting a
base marks the block dirty, and the next read works out every stat again, in the order of their
dependencies (found once, at load). A block holds a few dozen numbers in `Float64Array`s indexed
by stat, so this costs microseconds.

## Formulas

A formula is a number, a name, or an object with exactly one key, an operation:

| Operation | Value |
|---|---|
| `3.5` | the number |
| `"stamina"` | that stat's final value (in a modifier kind's `apply`: `value` and `total` instead, see below) |
| `{ add: [a, b, ...] }`, `{ mul: [a, b, ...] }` | sum, product |
| `{ sub: [a, b] }`, `{ div: [a, b] }` | a - b, a / b (0 when b is 0) |
| `{ neg: a }`, `{ abs: a }`, `{ sqrt: a }` | -a, \|a\|, √a (0 below 0) |
| `{ min: [...] }`, `{ max: [...] }`, `{ clamp: [x, lo, hi] }` | |
| `{ floor: a }`, `{ ceil: a }`, `{ round: a }` | |
| `{ pow: [a, n] }` | a to a whole power n from -16 to 16 (repeated multiplication) |
| `{ gt: [a, b] }`, `lt`, `ge`, `le`, `eq` | 1 if true, else 0 |
| `{ and: [...] }`, `{ or: [...] }`, `{ not: a }` | on 0 / not 0, giving 1 or 0 |
| `{ if: [cond, then, else] }` | `then` where `cond` is not 0 |

- **Compiled at load** into nested closures reading a `Float64Array` by index: no tree is walked
  and no name looked up while the game runs.
- **Checked at load**: an unknown operation, the wrong number of arguments, a name that is no
  stat, or a cycle between derived stats is a content error naming the file and the path in it.
- **Bit for bit the same everywhere**: only `+ - * /`, `sqrt` and rounding, which IEEE 754 fixes
  exactly. `pow` takes only whole exponents for that reason (`Math.pow` is not exactly specified
  in JavaScript). A result that is not finite becomes 0.
- **The same evaluator** serves a stat's `formula`, a modifier kind's `apply`, and a resource's
  rates. Each says which names it may use.

## Modifiers

A modifier changes one stat of one entity, of one kind, by a value, from a source:

```ts
interface Modifier {
  stat: number;     // index into the stat table
  kind: number;     // index into the modifier kind table
  value: number;
  source: string;   // who put it there: "template", "gear:chest", "aura:812", "debug"
}
```

- **Sources are how modifiers go away.** `addModifier(entity, m)` and `removeSource(entity,
  source)`, which removes every modifier with that source, whatever stat. An aura adds all its
  modifiers under its own instance's source and takes them off together when it ends; a piece of
  gear the same with its slot. Sources are opaque strings to the engine; the conventions above are
  the game's.
- **A modifier of a stat or kind that does not exist** is a content error where packs define it,
  a thrown error where code adds it.

### Modifier kinds

`modifiers/<id>.json5` - the core pack's three:

```json5
// modifiers/flat.json5 - +10 stamina
{ order: 100, gather: "sum", apply: { add: ["value", "total"] } }

// modifiers/percent.json5 - +10 is +10%; two +10% make +20%
{ order: 200, gather: "sum", apply: { mul: ["value", { add: [1, { div: ["total", 100] }] }] } }

// modifiers/multiplier.json5 - x1.1; two make x1.21
{ order: 300, gather: "product", apply: { mul: ["value", "total"] } }
```

| Field | |
|---|---|
| `order` | Kinds apply in ascending order (then by id), so a mod adds a kind between two of core's by its number |
| `gather` | How the kind's modifiers on one stat become one `total`: `sum`, `product`, `max` (only the strongest counts - buffs that do not stack) or `min` |
| `apply` | A formula of `value` (the stat so far) and `total`: the stat after this kind. A kind with no modifiers on a stat is skipped |
| `name` | For the inspector |

So with core's kinds a stat is `(base + Σflat) × (1 + Σpercent / 100) × Πmultiplier`, then
clamped and rounded - and a game that wants percentages to multiply, or a "highest buff wins"
kind, changes or adds a file.

## Resources

`resources/<id>.json5`:

```json5
// resources/health.json5
{
  name: "Health",
  max: "maxHealth",                 // the stat that is its maximum
  start: 1,                         // a fraction of the maximum, when the entity is made
  // Per second; negative is decay. Formulas of the entity's stats.
  regen: { outOfCombat: { mul: ["maxHealth", 0.02] }, inCombat: 0 },
  interval: 2,                      // seconds between regen ticks: 0 is smooth
  visible: "all",
}

// resources/rage.json5 - starts empty, decays out of combat
{ name: "Rage", max: "maxRage", start: 0, regen: { outOfCombat: -1.5, inCombat: 0 }, interval: 1 }
```

| Field | |
|---|---|
| `max` | A stat id, required. When the maximum changes the current value is kept, clamped to it (`onMaxChange: "keep"`); `"scale"` keeps the fraction instead |
| `start` | Fraction of the maximum it starts at. Default 1 |
| `regen` | `outOfCombat` and `inCombat` rates per second, numbers or formulas; default 0. The current value never leaves 0 to max |
| `interval` | Regen comes in ticks this many seconds apart, as WoW's every-two-seconds ticks; each tick adds rate × interval. 0 (default): every step, by rate × dt |
| `visible` | `all` (default) or `owner` |

- **Health always.** Every entity whose template has resources has `health`, listed or not; the
  game rules fail to load if no pack defines `resources/health.json5`. Nothing happens at 0 yet:
  death and respawn come with combat.
- **Any number of others.** A template lists which it has; class and race templates will add
  theirs the same way (mana for one class, rage for another, hunger for every player).
- **Spending** (`spend(entity, resource, amount)`, `restore`) is what abilities will call. A
  "no regen for five seconds after spending" rule is left for step 4, where spending happens.
- **Regen ticks per entity** start when the entity is made, so a crowd does not all tick on the
  same step.

## Templates

`entities/<id>.json5`:

```json5
// entities/creature.json5 - abstract: a base for others, never made itself
{ abstract: true, stats: { level: 1 }, resources: ["health"], look: { shape: "capsule", color: [0.6, 0.5, 0.4] } }

// entities/trainingDummy.json5
{
  extends: "creature",
  name: "Training Dummy",
  stats: { level: 10, stamina: 500 },
  resources: ["health", "rage"],
  modifiers: [{ stat: "maxHealth", kind: "percent", value: 100 }],   // source "template"
  look: { race: "human", outfit: "knight", color: [0.75, 0.6, 0.35], height: 1.9, radius: 0.45 },
}

// entities/player.json5 - what every player is made from
{ name: "Adventurer", stats: { level: 1, stamina: 12, intellect: 10, spirit: 8 }, resources: ["health", "mana", "rage"] }
```

| Field | |
|---|---|
| `extends` | One parent template. Objects (`stats`, `look`) merge key by key, the child's winning; lists (`resources`, `modifiers`) are replaced whole; `abstract` is never inherited |
| `abstract` | A base for others: cannot be placed or spawned |
| `name` | What the entity is called |
| `stats` | Base values of primary stats; the rest take their `default` |
| `resources` | Which resources it has (`health` always added) |
| `modifiers` | Standing modifiers, under the source `template` |
| `look` | For the client only: how to draw it. `race`, `outfit` and `sex` name a body (CHARACTERS.md) from the packs' `races/` and `outfits/`; without a `race` it is a capsule of `color`. `height` and `radius` size the capsule, which is also what a click hits. `shape: "capsule"` |

- **Chains are resolved at load** into flat templates; a cycle or a missing parent is a content
  error.
- **Players are made from `player`**, by convention, as `health` is a convention. Races and
  classes (later) will be templates the player's own is made from in turn.
- A template with no `stats` and no `resources` makes an entity with no such parts: a chest, a
  node, a portal.

## The game rules

`src/sim/rules/` - pure, shared by both ends:

| File | What |
|---|---|
| `formula.ts` | Reads a formula tree, checks it, compiles it to a closure |
| `gameRules.ts` | `resolveGameRules(packs)`: reads `stats/`, `modifiers/`, `resources/`, `entities/` from every pack, later packs replacing by id as everywhere else; orders tables by id; dependency order of derived stats; flattens templates. Throws a `ContentError` with every problem, as `resolveContent` does |

```ts
interface GameRules {
  stats: StatDef[];            // in id order: a stat's index is its place here
  modifierKinds: ModifierKindDef[];   // in id order; `applyOrder` lists their indices by order
  resources: ResourceDef[];    // in id order
  templates: Map<string, TemplateDef>;   // flat, abstract ones left out
  hash: number;                // FNV-1a over the tables' ids and visibility - sent in Welcome
}
```

- **One per server**, not per dimension. The page resolves it from the pack sources it already
  fetched (`packSet`), Node from disk (`scripts/diskContent.mjs` gains `loadRulesFromDisk`). A
  broken stat stops the loading screen with its problems listed, as a broken biome does.
- `resolveContent` adds the four folders to those it passes over without complaint.

## Replication

What each client is told about the entities around its player. Only the player's own dimension,
and only within the **interest radius**: entities come into view within 150 m and leave it past
170 m, so one standing on the edge does not flicker. The client's own player is always in view.

The server keeps, per connection, the set of entities the client knows and the values it last
sent of each. After a step it sends:

```ts
// When an entity comes into view (or the client arrives somewhere): everything this client may see.
{ type: "entitySpawn", id, template, name, look: EntityAppearance, x, y, z, facing,
  stats: StatValue[], resources: ResourceValue[] }
// When values this client may see have changed since it was last told: only the changed ones.
{ type: "entityValues", id, stats: StatValue[], resources: ResourceValue[] }
// The client's own player only, whenever its modifier stack changes: the whole stack.
{ type: "entityModifiers", id, modifiers: ModifierState[] }
// When it leaves view, the client leaves its dimension, or it is gone.
{ type: "entityDespawn", id }

StatValue      { stat, value }                    // stat u16 index, value f64
ResourceValue  { resource, current, max }         // resource u16 index, f64s
ModifierState  { stat, kind, value, source }      // u16, u16, f64, short string
EntityAppearance { seed, race, outfit, sex }      // u32, short strings ("" for the template's)
```

- **Snapshot's `players` becomes `entities`**: one `EntityMotion { id, x, y, z, facing, grounded }`
  for every entity in view that moved this step, and always the client's own player. A dummy that
  stands still is sent once, in its spawn.
- **Visibility**: the owner gets every stat and resource, and its modifiers; everyone else only
  those marked `all`. Another player's stamina is not sent to you at all.
- **Order in a step**: despawns, spawns, values, modifiers, then the snapshot - so a snapshot never
  names an entity the client has not been told of.
- **Welcome gains `rules`** (u32): the game rules' hash. A client whose own differs logs it and
  shows it on the loading screen; it does not stop.
- **Continuous regen sends a value every step.** With the core pack's two-second intervals it is
  one message per tick instead. Sending less (quantised values, a value only when it moved by
  some amount) is the codec's business, later.
- `PROTOCOL_VERSION` goes to 4 (5 with looks, below).

### Looks

Every entity is drawn the same on every client (CHARACTERS.md, *Next steps* 1): the template's
`look` says what it is - a race and an outfit, or a capsule - and the entity's own `look`, sent
once in its spawn, says who: its **seed** (face, skin, hair, build) and, for a player, the race,
outfit and sex it chose, each "" for the template's.

- **The seed** of a placed entity is a hash of its key, so the dummy has the same face from run to
  run; of a debug-spawned one, of its id.
- **A player's look** comes in its Hello (`look`, optional) - from the page's address until
  character creation saves it. The server keeps it to plain names of at most 32 characters and a
  u32, and never reads them: races and outfits are the clients' business. Without one a player is
  the `player` template's look (a human scout) with a seed of its id.
- **Names, not indices, and outside the rules hash.** A race or outfit is sent by its id, as a
  template is, so a client with different packs draws a stand-in race or no outfit, never the
  wrong stat; nothing in the hash's tables moves.

### The client

- **An entity mirror** (`game/entityMirror.ts`, page-wide, cleared on a Transfer): every entity
  the client knows, with its template, motion, the values it was sent, and for its own player the
  modifier stack. The client's only source for anything about an entity.
- **Others are drawn** by `game/entityMeshes.ts` (per dimension view) from their template's
  `look` and their own: a body (`game/characterBody.ts`, as the own player's) when the look names
  a race, built in the background with the capsule standing in, then animated from the mirror's
  motion; else a capsule of its colour and size. The capsule stays, unseen, as what a click hits.
  Other players use the `player` template's look. The client's own player is drawn as now.

## Debug, the inspector and the server

**Debug commands** (client to server, like `teleport`; a real game would not accept them from a
client):

```ts
{ type: "debugModifier", entity, stat, kind, value, source }   // adds a modifier
{ type: "debugRemoveSource", entity, source }                  // removes every modifier from a source
{ type: "debugCombat", entity, inCombat }                      // in or out of combat
{ type: "debugResource", entity, resource, delta }             // spends (negative) or restores
{ type: "debugSpawn", template, x, z }                         // makes an entity there
{ type: "debugDespawn", entity }
```

`entity` 0 means the sender's own player.

**The inspector** (`debug/entityPanel.ts`, a panel toggled with `I`):

- The client's own player, from the mirror: every stat - final value, and the base and each
  modifier under it with kind, value and source - and every resource as a bar with its numbers.
- The entities in view, listed by name and distance; clicking one shows it the same way. For
  others the mirror only has what the client may see, so in single player the panel reads the
  server's own entity through `server.debug` - and says so - to show its full stack.
- Buttons: +10 stamina (`debug`), +20% max health (`debug`), remove `debug`, enter or leave
  combat, spend 40% health, spend all rage / fill rage, spawn a dummy in front of the player.
- `__aiworld.entities` - `mine()`, `list()`, `inspect(id)`, `modify(...)`, `removeSource(...)`,
  `combat(on)`, `spawn(template)` - for the console and probes.

**The movement speed stat**, so a modifier is seen to do something: a stat `speed` (default 1,
min 0.1) that the body's walk and run speeds are multiplied by. +50% speed and the player runs
visibly faster - the server's doing, as it should be.

**`npm run server`**:

- Loads the game rules beside the world content and prints the table sizes.
- `--bot` makes the bot an entity like any player; its client end logs the spawns, value changes
  and despawns it is sent (first 20, then a count a second).
- `--inspect` prints, every second, the bot's stats and resources and every entity within its
  interest radius - the dummy among them - with their modifier stacks.
- The bot's script spends some health at tick 60 and enters combat at tick 150, leaving at 300,
  so a headless run shows regen pausing in combat and coming back after.

**The test** is a probe, `scripts/probe/entities.mjs`, run with `npm run probe -- scripts/probe/entities.mjs`:

- Formulas: every operation, the checks (unknown name, wrong argument count, a cycle), and that
  `pow` and division by 0 behave as written.
- Stacking: core's three kinds give `(10 + 5) × 1.2 × 1.1` for a stat with one of each, `max`
  gathers, and a kind with a custom `order` lands between.
- Removal: two sources on three stats, remove one, every stat back to what it was.
- Resources: health regen out of combat by ticks, none in combat, rage decay to 0 and no lower,
  `keep` and `scale` when the maximum changes.
- Templates: inheritance merges objects and replaces lists; `abstract` refuses to spawn; a cycle
  is reported.
- Replication: a server with two clients over the in-memory channel - each sees the other's
  health but not its stamina, sees its own modifiers, gets the dummy's spawn once and a despawn
  when it walks out of range.

## Steps

Each leaves the game working: dev server, `npm run probe`, `npm run server`, `npm run build`.

1. **Formulas and game rules.** `rules/formula.ts`, `rules/gameRules.ts`; the world resolver skips
   the four folders; the core pack's stats, modifier kinds, resources and templates; loaded in
   the page and in Node (errors on the loading screen). The probe's formula and template parts.
   Nothing uses them yet.
2. **Stat and resource blocks.** `stats.ts`, `resources.ts`, pure, with the probe's stacking,
   removal and resource parts.
3. **Entities on the server.** `entity.ts`; players become entities (welcome's id is theirs);
   placed entities from dimensions; `stepResources` in the step; `speed` on the body. Snapshot
   unchanged. Headless `--inspect`.
4. **Replication.** Protocol 4: spawns, values, modifiers, despawns, snapshot `entities`, the
   rules hash; interest per connection; the page's entity mirror and others drawn as capsules;
   the dummy visible near the start. The probe's replication part; the bot logs what it is sent.
5. **The inspector.** Debug commands, `debug/entityPanel.ts`, `__aiworld.entities`.
6. **Wrap up.** `public/packs/README.md` (the four folders), SIMULATION.md's message list,
   DIMENSIONS.md's placed entities; GAMEPLAY.md's step 3 marked done.

## As built

- **Files**: `src/sim/rules/formula.ts`, `src/sim/rules/gameRules.ts` (with `checkPlacements`),
  `src/sim/stats.ts`, `src/sim/resources.ts`, `src/sim/entity.ts`, `src/sim/entityText.ts` (the text
  breakdown `--inspect` and the panel print), `src/sim/replication.ts`; `src/game/entityMirror.ts`,
  `src/game/entityMeshes.ts`, `src/debug/entityPanel.ts`. `resolveContent.ts` gained `orderPacks`
  and `GAME_FOLDERS`; `PackSet` gained `sources`; `scripts/diskContent.mjs` gained `loadRulesFromDisk`.
- **The debug commands came in step 4**, with the protocol bump, so the bot's scripted run (spend
  100 health at tick 60, combat from 150 to 300) could show regen pausing headless.
- **Clicking a capsule** in the world opens the inspector on it - a first step towards targeting.
  Since step 4 (ABILITIES.md) a click targets the entity instead, and the inspector, when open
  (`I`), follows the target. `debugCombat` now forces combat on rather than setting the flag, which
  the ability system works out each step.
- **Items** (ITEMS.md) added a template's `items` field - belongings, loot, a chest's or a strongbox's
  part, read by the item rules - the look's `shape: "box"`, and an entity's `belongings`, `loot` and
  `gear` parts.
- **Creatures** (CREATURES.md) are entities with a walking `body` and a `creature` part (kind, spawn
  point, brain). Their kinds are templates made by the creature rules, which add them to `templates`;
  `GameRules.rawTemplates` keeps every template as written (abstract ones too) for them to build on.
- **Bodies for everyone** came after (protocol 5, *Looks*): the template look's `race`, `outfit`
  and `sex`, the entity's `look`, Hello's `look`. `__aiworld.entities.addPlayer({ race, outfit,
  sex, seed })` puts a second player in the page's server, walking a slow circle, to see one.
- **The combat button** toggles what it last set: the client is not told who is in combat.
- **The probe** (`scripts/probe/entities.mjs`, 98 checks) runs a real server on the `small`
  config's mainland with two clients; it takes about 15 s, most of it generating the world.
- **Checked in the game** (`?config=small`): the dummy drawn near the start, modifiers stacking
  (255 × 1.2 = 306 max health), health kept and clamped as its maximum changes, the panel's server
  breakdown; and by the user.

## Not in this step

- Death at 0 health, respawn, damage and healing as events: step 4 and creatures.
- Collision against other entities: players walk through the dummy.
- Who is in combat and why: the ability system and threat decide it; here it is a flag.
- Class and race templates, levels from skills (step 8), gear as a source of modifiers (step 7).
- Party visibility (`visible: "party"`): with parties.
- Prediction: the client never works out a value, so there is nothing to predict yet.
- Saving characters' values: with character saves.
