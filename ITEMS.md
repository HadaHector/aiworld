# Items

The plan for step 7 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: items, owned by the server and
defined in packs. Afterwards a player has a bag of slots, a bank, a wallet and equipment; items come
from authored types and from templates that generate types per world seed, each instance rolling
its stats within its type's range; equipping one adds its stats to the wearer as modifiers (ENTITIES.md)
and puts its gear on the body (CHARACTERS.md); the training dummy and a chest drop loot from tables
in packs; items can be dropped on the ground and picked up by anyone. The ability system (step 4)
is built beside this, so items only define where an ability is triggered and leave the rest.

**Status: done** (steps 1-6 below). [As built](#as-built) notes where the build differs.

## Decisions

Asked and answered before this plan was written:

| Question | Decision |
|---|---|
| Inventory grid | One item (or one stack) per slot, as WoW or RuneScape. A fixed number of slots; bags may add slots later |
| Rarity | Per item type, as WoW Classic: a type has one rarity. Templates make rarer types with a bigger stat budget and more stats; instances of one type differ only by small rolls |
| Loot in co-op | Shared, first come: one set of loot per corpse or chest, and whoever takes an item has it |
| Durability | Weapons wear when they hit, armour when hit, everything on death; amounts are game config. At 0 an item gives no stats until repaired; it is never destroyed |
| Equipment slots | A trimmed set in the core pack (13, below). Slots are pack data, so a game can have WoW's 19 |
| Binding | None: every item can be traded, dropped and picked up by anyone (quest items aside) |
| Money | Configurable: a currency is one integer, shown either as a plain number or split into denominations whose names and rates are pack data (100 copper to the silver, or 12 pence to the shilling and 20 shillings to the pound) |

## Principles

- **The server owns every item.** An item exists as an instance in the server's item store, with a
  stable id; a bag, a bank, an equipment slot, a corpse's loot and a dropped item on the ground
  only hold ids. The client is told what is in the containers it may see and asks to move things;
  it never moves an item itself, not even in its own bag.
- **An instance is small:** its type, a roll seed, a count and a durability. Everything else - its
  name, its stats, its gear - is worked out from its type and its roll, by the same pure function on
  both ends (`itemStats`), as a world is worked out from its seed. Nothing about a type is sent.
- **Saved later, saveable now.** An instance is a flat record of numbers and a type id; a player's
  belongings are lists of them. Character saves (GAMEPLAY.md) can write them as they are.
- **The engine has mechanisms; packs have rules.** The engine knows containers of slots, stacks,
  equipment slots that hold one item, durability, currencies, loot tables and templates that make
  types. It knows no item, slot, rarity or currency by name.
- **Deterministic from seeds.** Generated types come from the packs and the world seed; a roll
  from a seed the server takes from the world seed, the source's key and a counter. The same seed
  and the same packs give the same catalogue on every server and every client.
- **Items are gameplay content, not world content.** Their folders are read into `ItemRules` beside
  `GameRules`, once per server; the world resolver skips them.
- **Stay out of abilities.** Items call the ability system through one hook (below) and never
  reach into casting or effects. Wear from hits is a function the ability system will call.

## Pack folders

All new, read by `src/sim/rules/itemRules.ts` (added to `GAME_FOLDERS`):

| Folder | What it holds |
|---|---|
| `items/` | Authored item types |
| `itemTemplates/` | Templates that generate item types |
| `rarities/` | Rarity tiers |
| `equipSlots/` | Equipment slots |
| `currencies/` | Currencies: one main, any number of minor |
| `lootTables/` | Loot tables |
| `rules/items.json5` | Game config for items (one file; later packs override it key by key) |

## Item types

`items/<id>.json5`:

```json5
// items/linenShirt.json5 - clothing: a slot, a little stat, and the gear piece it puts on the body
{
  name: "Linen Shirt",
  kind: "clothing",
  rarity: "common",
  slot: "chest",
  gear: ["mailShirt"],               // pieces in gear/ (CHARACTERS.md), drawn while it is worn
  tint: "#d8d0c0",                   // optional: over every gear piece's own tint
  stats: { stamina: [1, 2] },        // a flat modifier per stat, rolled per instance within the range
  durability: 30,
  value: 12,                         // in the main currency's smallest unit - for shops later
}

// items/bread.json5 - food: stacks, and is used
{ name: "Bread", kind: "food", rarity: "common", stack: 20, use: { ability: "eatBread", consume: true }, value: 1 }

// items/rustyKey.json5 - a quest item
{ name: "Rusty Key", kind: "key", rarity: "common", quest: true }
```

| Field | |
|---|---|
| `name` | Shown; a translatable template later (see *Names*) |
| `kind` | `tool`, `weapon`, `armour`, `clothing`, `food`, `material`, `key`, `book`, `trinket`, `quest` - a free string the screens group by; the engine reads only `quest` |
| `rarity` | A tier in `rarities/`. Default: the lowest |
| `slot` | An equipment slot it goes in; `slots: ["mainHand", "offHand"]` for one that fills both (a two-handed weapon) |
| `gear` | Gear pieces it shows on the body while equipped in a slot marked `visible` |
| `tint` | A colour over its gear pieces' tints, so one gear piece serves many items |
| `stats` | Stat id to a number or a `[min, max]` range: a flat modifier each. `modifiers: [{ stat, kind, value }]` for other kinds (a percent) |
| `requires` | A formula of the wearer's stats that must not be 0 to equip it: `{ ge: ["level", 5] }` |
| `durability` | Its maximum; left out, it does not wear |
| `stack` | How many make one stack. Default 1. A stacking type has no ranges and no durability (a content error otherwise), so every item in a stack is the same |
| `quest` | Cannot be dropped, nor more than one held |
| `use`, `equip` | Ability hooks (see *Abilities*) |
| `value` | Base price, in the main currency |

- **Rolls.** An instance's `roll` is a u32. Each ranged stat takes a value from it - its own
  sub-seed per stat, evenly between `min` and `max`, rounded to whole numbers unless the range has
  a fraction in it. So two Linen Shirts give 1 or 2 stamina, and the same roll always the same.
- **Quality** is shown, not stored: how far the roll fell between the low and the high ends, so the
  screen can mark a well-rolled item.

## Generated item types

`itemTemplates/<id>.json5` makes many types from parts, as buildings are made from parts:

```json5
// itemTemplates/sword.json5
{
  kind: "weapon",
  slot: "mainHand",
  gear: ["sword"],
  name: "{material} {form}",          // filled from the axes' names
  axes: {
    material: [
      { id: "bronze", name: "Bronze", tint: "#b07a3a", level: 1, budget: 1 },
      { id: "iron", name: "Iron", tint: "#8a8a90", level: 8, budget: 1.6 },
    ],
    form: [
      { id: "short", name: "Shortsword", stats: { agility: [1, 2] } },
      { id: "long", name: "Longsword", stats: { strength: [2, 3] } },
    ],
  },
  rarities: ["common", "uncommon", "rare"],
  stats: { strength: [1, 2] },        // the base every type of this template gets
  extra: { stamina: [1, 3], strength: [1, 2], agility: [1, 2], spirit: [1, 2] },  // pool for rarer tiers
  durability: 40,
  value: 30,
  requires: { ge: ["level", "itemLevel"] },
}
```

- **One type per combination** of one choice from every axis and one rarity: `sword` above makes
  2 × 2 × 3 = 12 types, with ids `sword.bronze.short.common` and so on. They are made when the item
  rules load, so they are in the catalogue like authored ones; a template that would make more than
  `rules/items.json5`'s `maxGenerated` (default 2000) is a content error.
- **Stats** are the template's `stats` and each chosen part's, merged (ranges add), times the
  material's `budget` and the rarity's. A rarity with `extraStats: n` adds `n` stats drawn from the
  `extra` pool - **which ones is picked from the world seed and the type's id**, so one seed's Iron
  Longsword of rare quality has stamina and another's spirit, and the same seed always the same.
- **Overrides by part**: a part may set any item field (`gear`, `tint`, `slot`, `durability`); later
  axes win. `level` from the parts (the highest) is the type's `itemLevel`, which formulas in it may
  read.
- **Whitelists and blacklists** (GAMEPLAY.md): `only` and `never` list combinations the template may
  not make (`never: [{ material: "bronze", rarity: "rare" }]`).
- **Names** come from the template's `name` with `{axis}` filled by each part's `name`. For
  localisation the name becomes a key and the parts' names keys too, so a translation can reorder
  them; nothing is joined in code outside that.

## Rarities, slots and currencies

```json5
// rarities/uncommon.json5
{ name: "Uncommon", order: 2, color: "#1eff00", budget: 1.25, extraStats: 1 }

// equipSlots/chest.json5
{ name: "Chest", order: 50, visible: true }
// equipSlots/ring.json5
{ name: "Ring", order: 110, visible: false }

// currencies/coin.json5 - the main one, shown in denominations
{
  name: "Money",
  main: true,
  denominations: [                   // smallest first; each a count of the one before
    { name: "Copper", short: "c", per: 1 },
    { name: "Silver", short: "s", per: 100 },
    { name: "Gold", short: "g", per: 100 },
  ],
}
// currencies/marks.json5 - a minor one, a plain number
{ name: "Hunter's Marks" }
```

- **Rarities**: the core pack's `poor`, `common`, `uncommon`, `rare`, `epic` (grey, white, green,
  blue, purple), `order` setting their rank. `budget` multiplies a generated type's stats; `color`
  is the name's colour on screen.
- **Equipment slots**: the core pack's trimmed set - head, neck, shoulders, back, chest, wrists,
  hands, waist, legs, feet, ring, mainHand, offHand. `order` places them on the screen; `visible`
  says whether what is worn there shows on the body. A game wanting two rings adds `ring2` and lets
  rings name both (`slot: ["ring", "ring2"]` picks the first free).
- **Currencies**: exactly one has `main: true` (a content error otherwise). An amount is an
  integer of the smallest unit; `denominations` only change how it is shown, so a pound of 240
  pence is `[{ per: 1 }, { per: 12 }, { per: 20 }]`. Without denominations it is a plain number.
  Money is not an item: it lives in the wallet, never in a slot.

## Belongings

Every player has a **belongings** part, from its template:

```json5
// entities/player.json5 - added
items: { bag: 20, bank: 40, start: [{ item: "tunic" }, { item: "linenTrousers" }, { item: "sandals" }, { item: "bread", count: 5 }] },
```

```ts
// src/sim/items/items.ts
interface ItemInstance {
  id: number;        // u32, unique in the server's store; the store's next id is saved with the world
  type: string;      // an item type's id
  roll: number;      // u32: its stat rolls
  count: number;     // u16, 1 unless its type stacks
  durability: number;// u16, its type's maximum when new
}

// src/sim/items/belongings.ts
interface Belongings {
  bag: (number | null)[];        // item ids by slot
  bank: (number | null)[];
  equipment: (number | null)[];  // by equipment slot index
  wallet: number[];              // by currency index
}
```

- **Containers** are numbered so messages can name a slot as two small numbers: `0` bag, `1` bank,
  `2` equipment, `3` the loot window the player has open. A game's bags would add containers.
- **Moving** is one operation for everything: from a slot to a slot, all or part of a stack.
  Into an empty slot it moves (or splits); onto the same stacking type it merges up to the stack
  size; onto anything else the two swap. Into equipment it is an equip, out of it an unequip, and
  each checks the slot fits and `requires` holds.
- **The bank** is reached only within `bankRange` (4 m) of an entity whose template has `bank:
  true` - the core pack places a strongbox by the start. Its contents are the player's alone.
- **A full bag** refuses what would not fit, and the server says why (*Messages*).

## Equipment

- **Equipping adds modifiers.** Each stat of the item's type, at its roll's value, is a modifier on
  the wearer under the source `item:<slot>` (flat unless the type says another kind). Unequipping
  calls `removeSource`. So the inspector shows a sword's strength as `+2 flat, item:mainHand`.
- **A broken item** (durability 0) stays equipped and gives nothing: its source is removed when it
  breaks and added again when it is repaired.
- **The look follows equipment.** An entity's appearance gains `gear: string[]` - the type ids of
  what it wears in visible slots. It is sent in its spawn and in `entityGear` when it changes, to
  everyone who sees it. The client turns each type into its gear pieces and tint from its own item
  rules and rebuilds the body (CHARACTERS.md's *Next steps* 3). An entity whose template has an
  outfit and no belongings - the dummy - keeps its outfit. A player with nothing on a slot wears
  its smallclothes there.

## Durability and repair

`rules/items.json5`:

```json5
{
  wear: { onDeath: 0.1, onHit: 1, onHitTaken: 1, hitChance: 0.2 },  // death: a share of max; hits: points, sometimes
  repair: { cost: { mul: ["missing", "value", 0.02] } },             // a formula of the item: per item, in the main currency
  bankRange: 4, pickUpRange: 3, lootRange: 4,
  groundLifetime: 300,              // seconds a dropped item lies before it is gone
  maxGenerated: 2000,
}
```

- **Wear functions** in `src/sim/items/durability.ts`: `wearOnDeath(entity)`, `wearWeapon(entity)`
  (the item in mainHand), `wearArmour(entity)` (one piece at random from what is worn). The ability
  system calls the second and third when hits land; death calls the first. Until step 4 lands only
  debug calls them.
- **Repair** costs money by the formula, for every damaged item worn or in the bag. Repairers are
  NPCs (step 9); until then the strongbox repairs, and the debug panel does.

## Loot

`lootTables/<id>.json5`:

```json5
// lootTables/trainingDummy.json5
{
  rolls: [1, 2],                       // how many picks from `pick`: a number or a range
  pick: [
    { weight: 40, item: "bread", count: [1, 3] },
    { weight: 30, table: "starterGear" },                     // nested: rolls that table once
    { weight: 20, template: "sword", rarity: ["common", "uncommon"], where: { material: "bronze" } },
    { weight: 10 },                                           // nothing
  ],
  always: [
    { money: [20, 80] },                                      // the main currency; `currency: "marks"` for another
    { item: "rustyKey", when: { lt: ["source.level", 5] } },  // conditional
  ],
}
```

- **Entries** are an `item`, a `table` (nested; a cycle is a content error), a `template` with the
  rarities and axis choices to pick among (one of the generated types that matches, evenly), `money`,
  or nothing. `count` is a number or a range.
- **Conditions** (`when`) are formulas (ENTITIES.md) over the loot's context: `source.<stat>` (the
  dying entity's or the chest's level...), `looter.<stat>` (whoever killed or opened it). An entry
  whose `when` is 0 is left out before the weights are counted.
- **Rolling is deterministic**: from a seed made of the world seed, the source's key (or id) and a
  counter of how many times that source has been looted. New instances are made in the store, each
  with a roll from the same stream.
- **Who can loot: anyone, first come.** A corpse or chest holds its loot as item ids; whoever is in
  `lootRange` can open it and take what is there; taking is first come, and everyone who has it open
  sees an item go. Money taken is the taker's.
- **From entities**: a template's `loot: "<table>"`. When such an entity's health reaches 0 its
  table is rolled once and it becomes lootable. Death itself is step 4's and step 6's (ENTITIES.md):
  the items side only watches for health at 0. The training dummy does not die: it is rolled at 0,
  regenerates as now, and is rolled again the next time it reaches 0 after its loot is gone.
- **From chests**: a template with `container: true` and `loot`, no stats - the core pack's `chest`,
  placed near the start. Its loot is rolled when it is first opened, and it stays empty for its
  template's `respawn` seconds of world time after it is emptied (kept in the world delta later).
- **On the ground**: dropping an item makes a `groundItem` entity holding it, where the player
  stands; anyone within `pickUpRange` can pick it up. It is gone after `groundLifetime`. Quest items
  cannot be dropped.
- **Shapes**: chests and ground items are drawn as boxes: the template look gains `shape: "box"`.

## Abilities

The connection point, nothing more:

```json5
use:   { skill: "eatBread", consume: true },     // when used from the bag
equip: { skill: "thornsAura" },                  // while equipped
```

```ts
// src/sim/items/itemHooks.ts
interface ItemHooks {
  /** An item was used: cast its ability from the user. True if it went off (the item is then consumed if `consume`). */
  use(user: Entity, item: ItemInstance, ability: string): boolean;
  /** An item went on: start its ability (an aura) under this source... */
  equip(wearer: Entity, item: ItemInstance, ability: string, source: string): void;
  /** ...and it came off or broke: end whatever that source started. */
  unequip(wearer: Entity, source: string): void;
}
```

- `createServer` takes `itemHooks` in its options. The default refuses every use ("nothing
  happens") and ignores equips, so items work before abilities exist.
- **Ability ids are not checked** by the item rules: the ability system checks every id items name
  when it loads (`ItemRules.abilityRefs` lists them with file and path), so the error is still a
  content error naming the item's file.
- The ability system wires it in `server.ts` when it lands; nothing in `src/sim/items` imports it.

## Messages

Client to server - containers and slots are `u8` and `u16`:

```ts
{ type: "itemMove", from: SlotRef, to: SlotRef, count }   // count 0: all. Covers equip and unequip
{ type: "itemEquip", from: SlotRef }                      // to whichever slot fits, first free
{ type: "itemUse", from: SlotRef }
{ type: "itemDrop", from: SlotRef, count }                // onto the ground
{ type: "itemPickUp", entity }                            // a ground item
{ type: "lootOpen", entity }                              // a corpse or chest in range
{ type: "lootTake", slot }                                // one item from the open loot, 0xffff: all and the money
{ type: "lootClose" }
{ type: "debugItem", item, count }                        // debug: gives the sender an item
{ type: "debugWear", what }                               // debug: "death", "weapon", "armour", "repair"

SlotRef { container, slot }
```

Server to client:

```ts
{ type: "container", container, items: (ItemState | null)[] }   // all of one: on arrival, opening
{ type: "slot", container, slot, item: ItemState | null }       // one changed
{ type: "wallet", amounts: number[] }                           // by currency index, when it changes
{ type: "itemRefused", reason }                                 // "bagFull", "range", "requires", "quest"...
{ type: "lootable", entity, lootable }                          // to everyone who sees it: show a sparkle
{ type: "entityGear", id, gear: string[] }                      // to everyone who sees it

ItemState { id, type, roll, count, durability }                 // u32, string, u32, u16, u16
```

- **Only the owner** is told its containers and wallet. Everyone in view is told an entity's gear
  and whether it is lootable. Loot contents go only to those who have that loot open.
- **Order in a step**: after the entity messages and before the snapshot.
- **Welcome gains** `items` (u32, a hash of the item rules' tables, as `rules`) and `seed` (the
  world seed, so a remote client can generate the same catalogue).
- `PROTOCOL_VERSION` goes up by one - whichever of this and step 4 lands second takes the next.

## The client

- **`game/belongingsMirror.ts`**: what the server last said of the own containers, wallet and open
  loot. The screens draw only from it.
- **The inventory screen** (`ui/inventoryScreen.ts`, `B`): the equipment slots in a column with the
  body's slots named, the bag grid, the wallet in its denominations. An item's tooltip: name in its
  rarity's colour, kind, slot, stats with the roll's quality, durability. Drag to move, double-click
  to equip or use, drag out of the screen to drop. The bank opens beside it near the strongbox.
- **The loot window**: `E` opens the nearest lootable thing or ground item in range (a click on one
  too); click an item to take it, or *Take all*.
- **Lootable things sparkle**, so the dummy at 0 health and an unopened chest show from afar.
- Plain DOM, as the debug panels; HUD and screens proper are step 10.

## Debug, the server and the test

- **The inspector** gains: give item (a list of every type, generated ones included), wear on death,
  wear weapon, repair, and the dummy's *spend all health*. `__aiworld.items` - `bag()`, `give(type,
  n)`, `move(...)`, `equip(slot)`, `loot(entity)`, `catalogue()` - for the console and probes.
- **`npm run server -- --bot --loot`**: the bot spends the dummy's health, loots it, equips what it
  can and prints its stats before and after, and its bag.
- **The probe**, `scripts/probe/items.mjs`, with `?config=tiny`:
  - Rules: every core type reads; generated types: the count, the ids, the same catalogue for one
    seed twice and different extra stats for another; a stacking type with a range is refused.
  - Rolls: every stat in its range, the same roll the same values, both ends of a range reached.
  - Loot: weights hold over 10,000 rolls, nesting, conditions, a cycle refused, the same seed and
    counter the same drop.
  - Belongings: move, split, merge, swap, a full bag refused, quest items not dropped.
  - Equipment: stats on as `item:<slot>` modifiers, off on unequip, off when broken and on after
    repair, `requires` refused, a two-handed item filling both hands.
  - Over the boundary, a server and two clients: the dummy at 0 health is lootable to both; one takes
    an item and the other's loot window loses it; a drop is a ground item the other picks up;
    equipping changes the wearer's `gear` for the other client.
- **In the game** (`?config=tiny`): spend the dummy's health, loot it with `E`, equip a sword and a
  shirt from `B`, see strength rise in the inspector and the sword and shirt on the body; drop one
  and pick it up again; open the chest.

## Steps

Each leaves the game working: dev server, `npm run probe`, `npm run server`, `npm run build`.

1. **Item rules.** `rules/itemRules.ts`: the seven folders, authored and generated types, rolls
   (`itemStats`), rarities, slots, currencies, loot tables checked; the core pack's content (a
   dozen types, a sword and an armour template, the dummy's and the chest's tables); loaded in the
   page and in Node, errors on the loading screen. The probe's rules, rolls and loot parts. Nothing
   uses them yet.
2. **Belongings on the server.** `src/sim/items/`: the store, belongings, moves, equipment as
   modifiers, durability and repair, the hooks with their default; players get start items. Pure,
   with the probe's belongings and equipment parts.
3. **Loot and the world.** Loot from entities at 0 health, the chest, the strongbox, ground items,
   the box shape; the dummy's and the chest's tables.
4. **Messages.** The protocol bump, the messages above, the item handling in its own module that
   `server.ts` calls; `gear` in the appearance; the bot's `--loot`. The probe's boundary part.
5. **The client.** The mirror, the inventory screen, the loot window, the sparkle, the body rebuilt
   from equipment; `__aiworld.items`, the inspector's buttons. Checked in the game.
6. **Wrap up.** `public/packs/README.md` (the new folders), SIMULATION.md's message list,
   ENTITIES.md's template fields, CHARACTERS.md's next step 3; GAMEPLAY.md's step 7 marked done.

## Not in this step

- Shops, selling and area prices; trading between players; mail.
- Bags as items that add slots; a bank of more than one tab.
- Enchanting, upgrading, set items.
- Crafting and gathering tools' bonuses (they are items with stats here; using them is step 8 and
  gathering).
- Death and corpses (step 4, step 6): items only read health at 0.
- Item icons: the screens show a coloured square with the kind's letter until icons are made.
- Saving belongings and the item store: with character saves.
- Party loot rules (round robin, need and greed): with parties, if ever.

## As built

- **Files**: `src/sim/rules/itemRules.ts` (the rules, generation, `itemStats`, `rollQuality`,
  `rollLoot`, `formatMoney`); `src/sim/items/`: `items.ts` (instances, the store, belongings and
  loot parts, refusals), `belongings.ts` (moves, equipment as modifiers, receiving, using, wear and
  repair), `itemSystem.ts` (what the server calls: adopting, loot at 0 health, chests, the ground,
  reach), `itemReplication.ts`, `itemMessages.ts`, `itemHooks.ts`. Client: `game/belongingsMirror.ts`,
  `game/itemGear.ts`, `ui/inventoryScreen.ts` (the screen and the loot window); `entityMirror.ts`,
  `entityMeshes.ts`, `characterBody.ts`, `dimensionView.ts` and `main.ts` grew.
  `scripts/diskContent.mjs` gained `loadItemRulesFromDisk`.
- **A template's item fields are one `items` object** (`bag`, `bank`, `start`, `loot`, `container`,
  `respawn`, `banker`), merged along `extends` like `look`, and checked by the item rules. Start items
  that can be worn are put on.
- **Hooks name a `skill`**, the ability system's word. The ability system had landed first, so the
  server hands the item system `skills.items` (`itemHooks` overrides it), `checkSkillRefs` checks
  `abilityRefs` in the page and in Node, and wear comes from the step's combat events: a `death`
  wears what the dead wear, a `hit` the attacker's weapon and one of the target's pieces, by chance.
  Bread casts `eatBread`, a heal over time on the eater.
- **Messages** as planned, with these names: `itemSlot` (not `slot`), `entityLootable`, `bankReach`;
  `itemUnequip` and `itemRepair` were added. Open loot travels in its own `loot` message, money
  included, rather than as container 3. An emptied loot window closes.
- **Generated types**: a template's `unscaled` lists stats the budgets leave alone (a weapon's
  speed); a zero roll adds no modifier. The core pack makes 33 types from two templates beside 17
  authored ones.
- **The looter** a corpse's conditions read is the top of its threat table; with none, its stats are
  0 - so the dummy's rusty key drops to a player under level 5 who has not fought it.
- **`rules/items.json5` is replaced whole** by a later pack, like other files, not key by key.
- **Loot is opened with E only**; a click on a corpse still targets it.
- **The probe** (`scripts/probe/items.mjs`, 123 checks, about 10 s) covers rules, rolls, loot,
  belongings, equipment and durability on the item system alone, and the boundary on a real
  `tiny` server with two clients. `npm run server -- --config tiny --bot --loot` prints the bot's
  stats and belongings before and after looting the dummy.
- **Checked in the game** (`?config=tiny`): the dummy and the chest glint; E opens their loot; Take
  all fills the bag and the wallet; B shows equipment, bag and wallet, and the bank at the
  strongbox; equipping bracers, a helm and swords changes the stats and the body (a greatsword
  fades the off hand); bread eats; a dropped item lies as a box and E picks it up; tooltips show
  the rolled stats and the roll's quality.
