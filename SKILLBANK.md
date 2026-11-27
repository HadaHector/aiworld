# The skill bank, class templates and level-up

Built for the vertical slice (SLICE.md 3b; tasks I6, I7, P9), agreed with the owner 2026-11-27. Every
skill is tagged; a class is a **template** (ratios of purposes at key levels) from which a generator picks
its skills, level by level, to the counts of two balance curves. Skills rank up as the character levels;
each level gives stat points, placed by the class's weights. All of it is data.

Probes: `npm run probe -- scripts/probe/skillBank.mjs` (add `--report` for the bank and each class's
progression, `--report --unlocks` for a class's unlock lines written out), and the *ranks and stat points*
section of `scripts/probe/progression.mjs`.

## What the owner decided

- At level 10 a class has **7 active skills and 2 passives** (auto-attack not counted). Actives come at
  1 (two), 2, 4, 6, 8 and 10; passives at 5 and 9.
- Level 2 brings a **long buff** (30 minutes, no cooldown) for every class.
- Starting skills are never replaced: they **rank up**. A skill gains a rank 4 levels after it is learned
  and every 4 after, so rank 3 is the most by level 10.
- **Combinations**: an attack that carries a debuff (Poison Arrow), and a set-up with its pay-off
  (Heroic Strike's sunder, then Mortal Strike).
- Stat points are **automatic** in the slice, by the class's weights; the manual screen exists, off by config.
- Buffs may go on allies (Renew's way). Resurrect is a category, with no skill in the slice. Talents stay out.

## Tags

`rules/skillBank.json5` has an entry for every skill in `skills/` (the probe fails otherwise).

**Read from the skill file** (`deriveTags` in `src/sim/rules/skillBank.ts`), so they cannot drift:

| Tag | Values | Read from |
|---|---|---|
| effects | attack, debuff.dot, debuff.flag, debuff.stat, debuff.special, buff.long, buff.short, buff.aura, buff.passive, heal, heal.hot, mobility, summon, resource, taunt, resurrect | every action, and the actions of the skills it applies, judged by who they land on (an enemy, an ally, the caster). A damage tick is a DoT, a negative speed modifier on an enemy a flag, an absorb an aura, a buff of 5 minutes or more a long one |
| timing | instant, cast, channel, passive | its states' bars |
| shape | single, around, point, cone, chain, self | its areas (at the caster: around; at the target or a point: point) |
| reach | melee, ranged, self | its range (6 m or less is melee) |
| cooldown class | spammer (to 3 s), short (12), long (60), ultimate, none (a long buff), passive | the cooldown; the limits are data |
| school, resources, stats, applies | | its tags, its cost and what it gives, the stats it raises, the effect skills it applies |

**Hand tags** (only what a file cannot say): `pool` (class, creature, item, effect, test; the only one
required), `levels` (when it may be learned; defaults by cooldown class), `power` (its split between the
purposes, when the even split of its effects is wrong), `combo` (the effect it pays off), `weapon` ("bow").
`school`, `stats`, `cooldown` may override a reading. The purposes (damage, control, defence, healing,
mobility, support) and which effect or stat serves which are data too (`effectPurpose`, `statPurpose`;
Defence's dodge, parry, block, ward and resistances serve defence).

A **draft** is a planned skill with no file: it carries the tags a file would give, so a progression can
be seen before skills are written. Once the file exists the bank refuses the draft's tags.

## Class templates

`classTemplates/<id>.json5`: `ratios` of purposes at key levels (1 and 10 in the slice, straight lines
between), `resources`, `schools`, `stats` (a buff or passive raising none of them is not for the class),
`weapon`, liked `reach`, `limits` (at most so many long cooldowns and ultimates) and `combos` (at least so
many set-up and pay-off pairs). Optional `picks` pin a skill to a level by hand.

**The generator** (`generateClass` in `src/sim/rules/classGen.ts`) walks levels 1-10. The curves
`skillsActive` and `skillsPassive` (`rules/balance.json5`) say how many slots each level adds; a slot
takes a pinned skill, else the candidate that fits the template (pool, resources, school, weapon, reach,
stats, its level window, the limits) and brings the class's purpose shares closest to the template's at
that level. A liked reach, a closing level window and a combination weigh in; a second skill of the same
shape (timing, shape and first effect) is avoided. It then gives each skill its **power share** (each
purpose's share split over the skills that serve it) and the rank schedule (`ranks` in the bank).

**The four classes are the generator's own picks**, with nothing pinned; their `origins/*.json5`
`unlocks.adventure` are written out from it (`--report --unlocks`), and the probe fails if an origin and
its template disagree. Skills come by **character level** (the Adventure discipline), no longer by class
level. Kick stays a trainer's skill, Frost Nova a book's.

| Level | Warrior (closes) | Ranger (kites) | Mage (holds) | Priest (holds) |
|---|---|---|---|---|
| 1 | Heroic Strike, Charge | Steady Shot, Poison Arrow | Fireball, Fire Blast | Smite, Renew |
| 2 | Battle Shout | Hawk Eye | Arcane Intellect | Fortitude |
| 4 | Thunder Clap | Disengage | Frost Nova (book) | Heal |
| 5 | *Toughness* | *Keen Eye* | *Arcane Mind* | *Meditation* |
| 6 | Shield Wall | Concussive Shot | Frostbolt | Shield |
| 8 | Kick (trainer) | Entangling Shot | Searing Totem | Holy Fire |
| 9 | *Deep Wounds* | *Swift Feet* | *Frost Ward* | *Devotion* |
| 10 | Mortal Strike | Rapid Fire | Blizzard | Holy Nova |

Passives in italics. Ranks: a level-1 skill is rank 2 at 5 and 3 at 9, a level-2 buff 2 at 6 and 3 at 10,
and so on. Combinations: sunder → Mortal Strike; poison → Steady Shot; burn → Fire Blast, frozen →
Frostbolt; Renew → Heal.

## Ranks

A rank is an `auto` unlock of a skill already known, at a spell `level` (`{ at: 5, skill: "heroicStrike",
level: 2 }`): it raises the spell's level, which its formulas read as `level`. Core's skills scale their
effect by `1 + 0.35 × (rank - 1)` and their cost by `1 + 0.2 × (rank - 1)` (B7 fits the numbers). A rank
of a skill not yet learned (a book unread) waits, and a skill learned late comes at the rank its levels
reached. A rank is a progress event (`rank`) the panel and the level-up line show. Passives do not rank.

## Stat points (I7)

`rules/progression.json5` `statPoints: { mode, discipline, curve, stats }`: each level of the discipline
gives the balance curve's points (`statPoints`: 3 at 2 to 5 at 10, 37 by ten). `auto` places them by the
origins' `statWeights` (warrior strength 0.4, stamina 0.4, agility 0.2; ranger agility 0.5, stamina 0.3,
strength 0.2; mage intellect 0.5, stamina 0.3, spirit 0.2; priest spirit 0.4, intellect 0.3, stamina
0.3), a point at a time to the stat furthest behind its share, so no stat ever loses a point. They are flat
modifiers under the source `points`, worked out again on every level change. `manual` leaves them to spend
with `statSpend { stat }` (refused when automatic, off the list, or none left) and saves them
(`SavedProgress.stats`). A warrior at 10 has strength +15, stamina +15, agility +7: 460 health before gear.

## The level-up screen (P9)

`src/ui/levelUpScreen.ts`: on a level of the config's `level` discipline, a panel under the top of the
screen with the stats that went up (`levelGains`, from the rules alone), the max health now, the skills
the level teaches, those a trainer or a book may now teach, and the ranks. With manual points it lists the
stats with a + each. It does not stop play: it closes by itself after 12 s (not while hovered) or with ×.

## Engine changes for this

- `attackRange` stat (5); auto-attack's reach reads it and needs sight; bows add 25, so the ranger's
  auto-attack is a shot.
- A `move` with a negative distance goes backwards (Disengage).
- Origins have an `order` (character creation lists warrior, ranger, mage, priest) and `statWeights`.
- Protocol 16: `progress.stats`, `statSpend`, the `rank` event.

## Not done

- Icons for the new skills reuse the icon set's; new art is planned (SLICE.md).
- The numbers are first guesses: the duel tool (B7) fits damage and costs per class and level band.
- A class nobody planned (the probe's made-up "spellsword") finds too little in the bank: more general
  skills would be needed before generated classes use it.
