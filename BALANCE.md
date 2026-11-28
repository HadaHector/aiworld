# Balance: curves and the derive step

Built for the vertical slice (SLICE.md, 3a and task B6). **Status: the core is built (2026-11-20):** the
curves in `rules/balance.json5`, a resolver (`src/sim/rules/balanceRules.ts`), creatures that take
health, damage and armour from them, loot money and generated item prices from them. The duel and fit
tool (B7), the defence model (B8), the player's stats and gear landing on the curves, and the bot (B3)
come after.

Probe: `npm run probe -- scripts/probe/balance.mjs`.

## The idea

Every number in a fight is a **target**, written once as a curve by level in
`public/packs/core/rules/balance.json5`. Kinds and items say what they are (a **role**, a level, a slot,
a rarity) and carry **offsets**; the resolver derives the numbers. Nothing is a cage: a wolf may be
tougher (`scale: { health: 1.3 }`), an item may still have a typed `value`.

Agreed with the user, 2026-11-20: the real scale (a warrior has 175 health at level 1, not the guessed
60), 10 s to kill and 35 s to die for a same-level normal enemy, income that lets a potion cost 3
minutes and a level-band weapon 25, regeneration of 2% of health a second after 6 s.

## The curves

A curve is `{ value }`, `{ table: [level 1, 2, ...], growth? }`, `{ from, to, at?, shape? }` (the values at
level 1 and at `at` = 10, geometric or linear, carried on past it) or `{ poly: [a, b, c] }`, with an
optional `min` and `max`. Fractions of a level interpolate; levels under 1 read as 1.

| Curve | Level 1 → 10 | Meaning |
|---|---|---|
| `playerHealth` | 175 → 450 | A character's health on gear of the level. |
| `playerDps` | 15 → 40 | Raw damage a second, melee reference (`dpsRoles`: caster 1.15, hybrid 0.85). |
| `playerMitigation` | 20% → 35% | Share of a same-level attacker's weapon damage the player's armour stops. |
| `xpToNext` | 250 … 5,130 | `40*L^2 + 210*L`; level 10 costs 20,850 XP (kills 55%, quests 45%, `xpSplit`). |
| `income` | 270 → 2,000 copper an hour | Kills 40%, quests 35%, chests 25% (`incomeSplit`); 100 kills an hour (`killsPerHour`). |
| `itemBudget` | 4 → 24 | Stat points of a common weapon-slot item; slots weigh `slotWeights`, rarities their own budget. |
| `statPoints` | 3 at 2 → 5 at 10 | Level-up stat points (37 by ten), placed by class weights (SKILLBANK.md). |
| `skillsActive`, `skillsPassive` | 2 → 7; 0 → 2 | Class skills known by level, auto-attack not counted (SKILLBANK.md). |
| `tactics`, `questEffortMin/Max` | | Data for the tasks that use them (creature complexity, quests). |
| `cellLevel` | 1 … 9 over 14 cells | Creature level of a land cell by its place in order of distance from the start, where a dimension sets levels by cell (the vale; CREATURES.md, *Zones*). |

Beside the curves: `roles` (below), `priceMinutes` (potion 3, weapon 25), `sellRate` 0.25, `repairShare`
0.05, `regen` (6 s, 2%), `pace` (level 4 at minute 35, 7 at 65, 8 at 90, 10 at 120; read by the bot),
`armourFormula` (400 and 85 a level, as `combat.json5`).

## Roles

A role is `{ ttk, ttd, mitigation, money, xp, tacticShare }`: seconds a same-level player takes to kill
one and to die to one, the share of damage its armour stops, factors on money and XP per kill, and the
share of its damage its tactics deal.

- **health** = `ttk x playerDps(L) x (1 - mitigation)`: the player's dps does it in `ttk` seconds.
- **damage a second** = `playerHealth(L) / ttd / (1 - playerMitigation(L))`; the auto-attack is
  `(1 - tacticShare)` of it, per swing (`weaponSpeed`) less what strength adds, spread 80-120%. The
  tactics' share is what B7 will fit.
- **defence** (B8, ABILITIES.md *Defence*): the share asked is an effective-health target,
  `1 / (1 - mitigation)`, shared out among the defence parts that are on (armour, dodge, parry,
  control; resistance for spells at `spellBudget`), so a pack can turn a part off and the creature
  still takes the role's time to kill. With armour alone it is the old armour for the share.
- Roles: `normal`/`brute` (10 s, 35 s: a fight costs about 29% of health), `skirmisher`, `caster`,
  `swarm` (one of about three), `livestock` (no damage), `elite` (30 s, 12 s), `boss` (120 s, 25 s; no
  phases).

## In the packs

- **Creatures** (`creatures/*.json5`): `role` and `scale: { health, damage, armour, money, xp }` on a
  species, a variant may set its own (variants multiply). A kind with a role no longer has `stamina`,
  `armor`, `weaponMin`, `weaponMax` in `stats` or `perLevel`: the spawner (`creatures/system.ts`) applies
  `perLevel` growth for the rest, then `applyCreature`. A kind without a role works as before. Traits and
  other modifiers (thick-hided) stay on top of the derived base. A small health that stamina
  cannot reach (a swarm at level 10) is a flat modifier, source `balance`.
- **Loot money**: `{ money: [0.5, 1.5], scale: "brute" }` is that share of a brute kill's money at the
  source's level (`income x 40% / 100 kills`), at least 1.
- **Prices**: an item template or item with `value: "balance"` costs `income(level)/60 x 25 min x slot weight
  x rarity budget` (a bronze sword 113c, iron 534c, an iron rare 801c; a health potion 14c, `potionPrice`).
  Authored items with a number keep it.
- **Item budgets** and `armourFor(level, share)` are in the resolver for the item tasks (SLICE.md I-tasks);
  the existing templates' stat ranges are not yet derived from them.

## Not done (next)

- The player does not yet land on the curves: stat points per level (a level gives 15 health today, the
  curve wants about 30), gear, and class skill damage (`heroicStrike`'s formula) are fitted by B7.
- A level's XP per kill and the quest rewards are still progression's and `quests.json5`'s own numbers.
- Regeneration (I9, built): `resources/health.json5` regenerates 2% of maximum health a second out of combat
  (spirit no longer adds to it; mana keeps its spirit term) and `rules/combat.json5` `combatTimeout` is 6 s, so
  regeneration starts 6 s after the last blow. Those are `regen.share` and `regen.delay` written out in the
  files the sim reads; `scripts/probe/balance.mjs` fails if they drift apart. Repair is still data here only
  (`rules/items.json5` has its own formula: the item rules read `repairShare`).
- The bandit, undead and other new kinds of enemies (SLICE.md 3c) are made with roles from the start.
