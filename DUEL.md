# The duel and fit tool

Built for the vertical slice (SLICE.md 3a, task B7), 2026-11-28. A class's rotation on a **timeline**
against a training dummy or a creature, measured against the curves in `rules/balance.json5`: dps, time
to kill, time to die, the share of health a fight costs, resource use, time out of range, and where the
class sits on the tank / glass-cannon axis. It suggests one damage and one health factor per class and
level band; it never writes them into the packs.

```bash
npm run duel -- all                      # the summary table: every class at levels 1, 5 and 10
npm run duel -- all --scales=out.json    # and the suggested scales (printed with a bare --scales)
npm run duel -- warrior 5                # one class and level: the dummy, and a creature of each role
npm run duel -- warrior 5 vs wolf        # one duel written out (a kind id or a species)
npm run duel -- mage 10 vs dummy         # the dummy alone
#   options: config=<name> seed=<n> foeLevel=<n> start=<metres>
```

Probe: `npm run probe -- scripts/probe/duel.mjs` (category `rules`): every class at 1, 5 and 10 against
the dummy and a creature of each role runs, and the numbers are sane. It checks the tool, not the
balance.

## What is real and what stands in

`src/sim/duel/`: `arena.ts` (the world), `duel.ts` (one duel), `policies.ts` (how each class plays),
`report.ts` (the curves, the axis, the table, the suggestion). Script: `scripts/tools/duel.mjs`; the rules
come from `loadDuelRulesFromDisk` in `scripts/diskContent.mjs`.

**Real, the game's own code:** the skill system (`createSkillSystem`: casting, GCD, cooldowns, costs,
magics, damage, healing, absorbs, threat, the defence model of B8), the item system (the origins' start
kit, worn), the progression system (a character made from its origins and raised to the level with
`debugLevel`: the skill bank's skills and ranks, the stat points), creature kinds and the balance curves
(`applyCreature`, as the spawner does), resources and their regeneration.

**Stand-ins:**
- **Space is one number.** Both fighters stand on a line; the only distance is the gap between their
  bodies (`gap`, as range checks use). Sight is always clear. A push (Charge, Disengage) runs over its
  time as a body's would.
- **Movement:** a character runs at `RUN_SPEED` x its `speed` stat, a creature at its kind's `speed.run`
  share of it. A unit that moves in a step starts only skills that can be cast on the move.
- **The creature's side** follows the brain's combat rules (creatures/brain.ts), rewritten here because the
  brain needs a world: it closes to melee or to its `keepRange`, its tactics go by their `every`, `after`
  and `when`, crowd control waits as the brain's does (not on a held foe, not twice in a row, an immunity
  after a hold), and it flees once at its `flee` share. No wandering, leash or groups: one foe.
- **The character's side** plays a **policy** (`policies.ts`): a priority list of its class's skills,
  each with when it is worth casting, and a way to move - close (warrior), kite between 10 and 28 m
  (ranger), hold at 28 m (mage, priest). Skills not known at the level are passed over. These are the
  tool's guesses at a sensible player; a class played badly shows as a weak class.
- **The dummy** is the training dummy with a role's defence and health that does not run out, standing
  still. Its fight lasts 60 s.

## The measures

- **Dummy dps** against `playerDps(L) x dpsRoles[role] x (1 - normal mitigation)`: damage that lands
  through a normal enemy's armour, which is what kills a normal enemy in its `ttk`. The combat role is
  melee (warrior), ranged (ranger), caster (mage), hybrid (priest).
- **Against creatures**, one of each species with a role (the first variant), at the character's level:
  **ttk** (seconds to kill, fights won), **ttd** (seconds the foe's damage, at the rate it dealt it, would
  take to kill the character), **lost** (share of health the fight cost); the role's `ttk`, `ttd` and
  `ttk / ttd` are the targets.
- **Effective health:** health x the defence's physical multiplier (`defenceMultiplier`) against a
  same-level blow, over the curve's `playerHealth / (1 - playerMitigation)`.
- **Power** = dps ratio x effective-health ratio (1 is the budget). **Axis** = 0.5 + ln(dps ratio / EH
  ratio) / (2 ln 4), clamped: 0 tank, 1 glass cannon, compared with the class template's `axis`.
- **The suggestion:** per class and level band (1-4 measured at 1, 5-8 at 5, 9-10 at 10), the factor on
  its damage that puts its dummy dps on the curve, and on its health that puts its effective health on it.

## First results (2026-11-28, master 1fbafe9)

| class | lvl | hp/curve | dummy dps/curve | dps | EH | power | axis (want) |
|---|---|---|---|---|---|---|---|
| warrior | 1 | 225/175 | 8.6/12.0 | 71% | 117% | 83% | 0.32 (0.3) |
| warrior | 5 | 335/266 | 10.9/18.6 | 59% | 101% | 59% | 0.31 (0.3) |
| warrior | 10 | 510/450 | 15.7/32.0 | 49% | 79% | 39% | 0.33 (0.3) |
| ranger | 1 | 205/175 | 9.4/12.0 | 79% | 102% | 80% | 0.41 (0.6) |
| ranger | 5 | 305/266 | 10.0/18.6 | 54% | 89% | 48% | 0.32 (0.6) |
| ranger | 10 | 450/450 | 12.5/32.0 | 39% | 68% | 27% | 0.30 (0.6) |
| mage | 1 | 185/175 | 15.8/13.8 | 115% | 86% | 99% | 0.60 (0.85) |
| mage | 5 | 285/266 | 34.3/21.3 | 161% | 80% | 128% | 0.75 (0.85) |
| mage | 10 | 430/450 | 62.0/36.8 | 169% | 66% | 111% | 0.84 (0.85) |
| priest | 1 | 205/175 | 7.1/10.2 | 70% | 96% | 67% | 0.38 (0.4) |
| priest | 5 | 305/266 | 14.6/15.8 | 93% | 85% | 79% | 0.53 (0.4) |
| priest | 10 | 478/450 | 24.3/27.2 | 89% | 70% | 63% | 0.59 (0.4) |

What is off (for the rules and gameplay sessions; the tool changes no rules):
- **Gear does not grow.** Every level fights in the level-1 start kit (there is no gear of the level until
  item generation, I8), so effective health falls behind the curve by 10 (66-79%) and weapon damage stays
  flat.
- **Warrior and ranger fall off the dps curve** (71% → 49%, 79% → 39%). The warrior is short of rage (about
  3 a second), and at 5 and 10 loses to the bear and the crocodile (brutes scaled x1.3 health, x1.2 damage).
- **The ranger's mana does not grow**: 150 at every level, about 3.5 a second spent, so it runs dry.
- **The mage is well over the curve** (115-169%): fireball and frostbolt at ranks 2-3 on intellect.
- **Kiting is free**: a character runs at 12 m/s, a brute chases at 4-6 m/s (`speed.run` 0.34-0.5), so a
  ranger, mage or priest at range takes almost no damage from melee creatures (ranger "lost" 0%).
- **The hexer (caster role) deals little**: one Hex Bolt every 4-6 s (2 s cast) gives a ttd of 80-230 s
  against the role's 45.

## Not done

- The odd builds of B9 (tank, glass cannon, kiter, solo healer) run through it as data.
- Potions and food in a fight; groups (two foes at once, a swarm of three).
- Applying the suggested scales: the owner's call, through the skill bank's power shares or the classes.
