# Abilities

The plan for step 4 of [GAMEPLAY.md](GAMEPLAY.md)'s build order: the ability system. When it is
done, the player can target the training dummy with Tab, auto-attack it with a swing the body plays,
cast a fireball that leaves a burn, shield and heal itself, charge in and kick the dummy's own cast.
The server rolls every hit from the seed, keeps the dummy's threat table, and tells the client what
happened as combat events. A target frame, a cast bar and a combat log show it, and a headless probe
fights the same fight twice and gets the same log both times.

It follows a model the user has worked with: three objects, **skill**, **spell** and **magic**. A
skill's behaviour is a set of **states**, each with **actions**, plus **areas** and **target groups**
that the actions aim at. Buffs and debuffs are magics as well, and so are passive skills and the
auto-attack. One mechanism carries all of it.

**Status: done** (steps 1-7 below; the death animation itself was built by the characters
session). [As built](#as-built) notes where the build differs from this plan.

## Decisions

| Question | Decision |
|---|---|
| Model | **Skill** (the description, in packs) / **spell** (a skill given to a unit: its level, its cooldown, where it came from) / **magic** (one running instance: its state, targets, stacks) |
| Behaviour | A skill is a small state machine. Each state has a length, ticks and transitions to other states on events. Actions are tied to a state: they run when it is entered, on each tick, or on exit, or they are *held* for as long as it lasts |
| Auras | A buff or debuff is a magic hosted on its target. Its duration, ticks, modifiers and tags are states and actions. Stacking, refresh and dispel type are fields of the skill |
| Passive skills | A magic that starts when the spell is given and lives as long as the spell does. Procs are transitions on combat events |
| Auto-attack | A passive skill that loops a swing state at weapon speed while its unit is attacking. No engine code for it |
| Stun, silence and other states | Two kinds (see [States on a unit](#states-on-a-unit)). **Control flags** change what a unit can do (stunned, silenced, rooted...): a fixed set defined in the engine, held on the entity, set by the `flag` action. **Gameplay elements** (a DoT, a sunder, a shield) are skills of their own, applied by any number of other skills, with a [stacking model](#stacking) that says how they combine. Free **tags** only describe skills (school, `bleed`) so others can match on them |
| Attributes | Every number in a skill is an expression, and expressions read **attributes** (step 3's stats) of the caster, the target and the host. A talent is a modifier on an attribute (`stunDuration`, `fireCastTime`) that skills read. See [Attributes in expressions](#attributes-in-expressions) |
| Rolls | **Separate rolls**: hit, then crit, then mitigation, each a formula in `rules/combat.json5` that a skill can override |
| Moving | The Classic rule: moving or jumping breaks a state marked `breakOnMove` (casts and channels). Instants and melee work on the move. A skill opts out by leaving the flag off |
| Projectiles | Travel time only: a state whose length is distance ÷ speed, following the target. No projectile entity |
| Who may be attacked | A template's `hostility` toward players (`hostile`, `neutral`, `friendly`) until factions come. A summon takes its owner's side |
| Input | A 400 ms queue window: a cast asked for near the end of the GCD or a cast fires as soon as that ends |
| Names | The user's names are kept: skill, spell, magic. GAMEPLAY.md's progression "skills" (step 8) need another word: proposed **disciplines** |

## Principles

- **The engine has mechanisms; packs have rules.** The engine knows states, actions, areas,
  groups, events, and the control flags, because those change how a unit is driven. It knows no
  school, no damage over time and no fireball. Core's skills and `rules/combat.json5` are content
  like any other pack's.
- **The server rolls, the client shows.** Every cast, roll, tick and hit happens in `src/sim`. The
  client sends what the player asks for (target this, cast that) and draws what it is told.
- **Deterministic.** A magic's random numbers come from a stream seeded by the world seed, the tick
  it started on, its caster and the caster's cast counter. The same inputs give the same fight on
  any machine. Formulas stay pure (ENTITIES.md): randomness reaches them only as a name, `random`,
  that an action draws from its magic's stream before it runs them.
- **Actions are a registry.** Each action kind is `{ check, run }` (and `undo` for held ones),
  registered by name. Core's kinds use the same `registerAction` that scripts will use later (see
  GAMEPLAY.md, *Modding*), so a new kind of action needs no change to the engine.
- **Everything numeric is an expression** (*Attributes in expressions*) of caster, target and host attributes, the spell's level, the
  magic's stacks and variables. Formulas use step 3's trees and compiler.
- **Messages stay flat records** (SIMULATION.md, *Encoding*). A combat event is one fixed record.
  An aura list is an array of records.

## Skills

`skills/<id>.json5`. Two examples cover most of the format:

```json5
// skills/fireball.json5 - cast, travel, hit, and leave a burn on the target
{
  name: "Fireball",
  tags: ["school.fire", "spell"],
  target: "enemy", range: 35, los: true, facing: true,
  cost: { mana: { add: [30, { mul: ["level", 5] }] } },
  gcd: true, cooldown: 0,
  groups: { main: { from: "target" } },
  start: "cast",
  states: {
    cast: { length: { mul: [2.5, "caster.fireCastTime"] }, bar: "cast", breakOnMove: true, interruptible: true, next: "travel" },
    travel: { commit: true, length: { travel: 24 }, next: "impact" },   // distance ÷ 24 m/s
    impact: {
      enter: [
        { do: "damage", group: "main", amount: { add: [{ mul: ["random", 10] }, 40, { mul: ["caster.intellect", 0.8] }] } },
        // A gameplay element: the burn is its own skill, hosted on the target. Fireball says how hard
        // it burns; the burn says how burns stack. Other skills (a fire trap, a talent) apply it too.
        { do: "cast", skill: "burn", group: "main", vars: { perTick: { mul: ["caster.intellect", 0.25] } } },
      ],
      next: "end",
    },
  },
}

// skills/burn.json5 - a damage over time: a magic on its host, ticking
{
  name: "Burn",
  tags: ["school.fire", "dot"],
  display: "debuff", dispel: "magic",
  vars: { perTick: 5 },                       // defaults; a caller's `vars` replace them
  stacking: { group: "burn", per: "caster", max: 3, add: "stack", duration: "restart", value: "stronger" },
  states: {
    burning: {
      length: { mul: [8, "caster.dotDuration"] }, period: 2,   // a talent raises dotDuration
      tick: [{ do: "damage", group: "host", amount: { mul: ["var.perTick", "stacks"] }, roll: "noCrit" }],
      next: "end",
    },
  },
}
```

| Field | |
|---|---|
| `name`, `tags` | Free tags describe the skill: its school, `bleed`, `poison`. Rolls, filters, `remove` and triggers match on them |
| `type` | `spell`, `physical` or `none` (default): the one engine-level kind, which control flags act on (silence stops `spell`, pacify stops `physical`) |
| `weapon` | `true` for skills that need a weapon: disarm stops them |
| `passive` | `true`: no casting. Its magic starts when the spell is given, hosted on its unit, and ends when the spell is taken away |
| `target` | What casting asks for: `enemy`, `ally`, `self`, `point`, `none`. A missing or wrong target fails the cast |
| `range`, `minRange`, `los`, `facing` | Checked when the cast starts and again at `commit`. `facing`: the target must be in front of the caster, within 180° |
| `cost` | Resource → formula. Paid at `commit`. A skill that cannot pay does not start |
| `cooldown`, `category` | Seconds, a formula. Starts at `commit`. A `category` shares one cooldown between skills (potions) |
| `gcd` | `true` triggers the global cooldown (`rules/combat.json5`'s length, cut by a stat if the rules say so), a number triggers that long a one, `false` none. A skill on the GCD cannot start during it |
| `requires`, `blockedBy` | Skills or skill tags whose magics the caster must have, or must not have, hosted on it. `targetRequires` and `targetBlockedBy` do the same for the target (`weakenedSoul` on the target blocks a second shield) |
| `display` | `buff`, `debuff` or `hidden` (default): whether a magic of this skill is shown on its host's frame |
| `dispel` | A dispel type, a free string (`magic`, `poison`, `curse`) that a dispel action matches |
| `stacking` | How a magic of this skill combines with one already on the host. See [Stacking](#stacking) |
| `areas`, `groups` | Named shapes and named target groups, below |
| `vars` | Numbers a magic keeps, read as `var.<name>` and changed by `set` |
| `start`, `states` | The state machine. `start` defaults to the first state |

**Validated at load**, like stats: an unknown action, a group or area that is not defined, a state
that is not defined, a tag rule that names an unknown kind, a skill that casts a skill that does
not exist, and every skill id that items name (ITEMS.md, *Abilities*). Each is a content error that
names the file and the path in it.

## States

A state is where a magic is and what holds while it is there:

| Field | |
|---|---|
| `length` | Seconds (a formula), `{ travel: speed }` (distance to the target ÷ speed, worked out on entering), or left out: forever, until an event moves it on |
| `period` | Runs `tick` every this many seconds. The first tick comes one period after entering, as WoW's do |
| `enter`, `tick`, `exit` | Actions run once on entering, on each tick, and on leaving |
| `hold` | Actions applied on entering and undone on leaving: `modifier`, `flag`, `absorb` |
| `next` | Where it goes when `length` runs out. `end` ends the magic |
| `on` | Event → state: `{ moved: "end", interrupted: "end", hitTaken: { to: "proc", filter: { tags: ["melee"] } } }` |
| `bar` | `cast` or `channel`: shown as its caster's cast bar while it is in this state |
| `breakOnMove` | Moving or jumping sends the magic to `on.moved`, or ends it |
| `interruptible` | An interrupt action sends it to `on.interrupted`, or ends it |
| `commit` | Entering it pays the cost and starts the cooldown. Without one, the start state commits |

**Events a state can move on**:

- From the magic itself: `moved`, `interrupted`, `targetLost` (the target died, or went out of
  range or sight while channelled), `hostDied`, `absorbedOut` (its absorb is used up), `stacksGone`.
- Any combat event involving its host, from the host's point of view: `hitDealt`, `hitTaken`,
  `critDealt`, `healDealt`, `healTaken`, `castDone`, `killed`, `died`, each with an optional
  `filter` on the other side's skill tags, school and kind.

Procs are written this way: a passive waits in `ready`; `on.hitDealt` goes to `proc`; `proc`'s
`enter` rolls a `chance` and casts the proc; `proc` lasts the internal cooldown and goes back to
`ready`.

## Actions

Every action is `{ do: "<kind>", ...fields }`. Most take a `group` to act on, and default to the
magic's host.

| Kind | What it does |
|---|---|
| `damage` | `amount`, a formula run once per target. Rolled and mitigated (*Rolls*), absorbed, then taken off health. `threat` scales its threat (default 1). `roll` names another roll set from the combat rules, or `none` |
| `heal` | `amount`. Rolled for crit, never misses. Adds threat for the healer (*Threat*) |
| `resource` | `resource`, `amount` (negative spends): rage from a hit, mana back from a potion |
| `modifier` | Held. `stat`, `kind`, `value` (× stacks when `perStack`), under the source `magic:<id>` (ENTITIES.md, *Modifiers*) |
| `flag` | Held. Control `flags` set on each target while the state lasts (*States on a unit*). Counted, so two stuns and one ending still leave one. A target immune to a flag does not get it, and the event says so |
| `absorb` | Held. `amount` of damage (matching `tags`, any if left out) it takes first. When it is used up, its magic gets `absorbedOut` |
| `cast` | Starts another skill's magic. `skill`, `group`, `level`, and `vars`: expressions run now, with this magic's caster and target, that set the new magic's variables. `mode: "apply"` (default) hosts the new magic on each group member - how auras and gameplay elements are applied; `mode: "cast"` has the unit cast it at each member as a real cast (checks, cost, cast bar). `by: "host"` makes the magic's host the caster instead of its caster - how a passive makes its unit cast |
| `stacks` | `amount` added to (or, negative, taken from) the group's magics of a `skill` or stacking `group`: a finisher that consumes stacks, a hit that adds a sunder |
| `remove` | Ends magics on the group by `skill`, by tag or by `dispel` type, up to `count` |
| `interrupt` | Interrupts the group's casts. `lockout`: for this many seconds the target cannot start skills that share a school tag (`school.*`) with the skill it was casting. The engine keeps lockouts on the unit beside its flags |
| `move` | `dash` (along the facing or to the target, at a speed, stopping at melee range), `leap` (an arc to a point), `knockback`/`pull` (an impulse away from or toward the caster), `teleport` |
| `summon` | `template`, `count`, `at` (an area), `duration`. The summon belongs to the caster, takes its side, and ends with a magic hosted on it |
| `threat` | `amount` added to the group's tables against the caster. `taunt: true` puts the caster on top and flags `taunted` |
| `animation` | `name` (`swing` now; `cast`, `shoot` later): played by the clients that see the unit (CHARACTERS.md, *Next steps* 5) |
| `effect` | `name`: a visual or a sound at the group. Sent as an event; drawn later |
| `goto` | Moves this magic to another state now |
| `set` | `var`, `value`: changes one of the magic's variables |
| `if`, `chance` | `when` (a formula) or `p` (a probability, a formula), then `then` and `else` lists of actions |
| `end` | Ends this magic |

```ts
// src/sim/skills/actions.ts
interface ActionKind<T> {
  /** Reads and checks an action's fields at load; formulas are compiled here. */
  check(reader: Reader, path: string, scope: FormulaScope): T;
  /** Runs it once per target. */
  run(ctx: ActionContext, action: T, target: Entity): void;
  /** Held kinds: undoes what run did, when the state is left. */
  undo?(ctx: ActionContext, action: T, target: Entity): void;
}
registerAction("damage", damageAction);
```

## States on a unit

The two kinds are kept apart, because only one of them changes how the engine drives a unit.

### Control flags: changes to play, in the engine

A flag changes what a unit can do, so the engine has to obey it: the body's motor, the casting
checks and auto-attack read it. The flags are a fixed table in code (`src/sim/skills/flags.ts`).
Each is a count on the entity, so overlapping sources work, and each is replicated to everyone who
sees the unit, for the frames and for a stunned pose later.

| Flag | What the engine does |
|---|---|
| `stunned` | No moving, turning, casting or attacking. A cast in progress is interrupted |
| `rooted` | No moving. Turning, casting and attacking still work |
| `silenced` | No starting `type: "spell"` skills. A spell being cast is interrupted |
| `pacified` | No starting `type: "physical"` skills, and no auto-attack |
| `disarmed` | No `weapon: true` skills, and no auto-attack |
| `immune` | Takes no damage and gets no hostile magics (a bubble) |
| `stealthed` | Not seen by hostile units: not in their groups and not targetable; the client draws it faded. Detection rules come later |
| `dead` | Set by death: everything above, and not a valid target for most skills |

- **Immunities are flags too**: `immune.stunned`, `immune.rooted` and so on. While a unit holds one,
  a `flag` action that would set that flag does nothing, and the event says it was resisted. Trinkets
  that break a stun and stun immunity after a stun ends are both built from this.
- **How long a flag lasts** is the length of the state that holds it, so it is an expression like
  any other. A target's attribute can scale it: `length: { mul: [4, "target.stunTaken"] }`.
  Diminishing returns can be built the same way later, from a debuff that lowers `stunTaken`.
- **New flags come from code**, since each needs engine behaviour. Scripts will register them as they
  register actions.

### Gameplay elements: skills, with a stacking model

A damage over time, a sunder, a slow or an absorb has no meaning to the engine. Each is a skill of
its own, hosted on its target, and any number of other skills apply it with a `cast` action, passing
their own numbers in `vars`. Fireball, a fire trap and a talent proc can all apply the same `burn`,
and the burn's `stacking` alone decides what happens when they meet.

## Stacking

`stacking` says what happens when a magic is started on a host that already has a magic of the
same **stacking group**:

```json5
stacking: {
  group: "burn",          // what counts as "the same": skills sharing a group meet; default the skill's id
  per: "caster",          // "host": one per host, whoever applied it; "caster": one per caster on the host
  max: 3,                 // most stacks, an expression of caster attributes (a talent raises it)
  add: "stack",           // what a new application does to the one there (below)
  duration: "restart",    // what it does to the length of the current state (below)
  value: "stronger",      // which vars to keep (below)
  strength: "var.perTick" // what "stronger" compares; default the sum of the vars
}
```

| `add` | |
|---|---|
| `stack` (default) | Adds a stack, up to `max`. At `max` only the duration and value rules apply |
| `replace` | Ends the old magic and starts the new one in its place |
| `keep` | Leaves the old magic alone and drops the new one ("already affected") |
| `separate` | Both run side by side, up to `max` magics, the oldest ending first. Each has its own timer, as several stacks with their own timers do |

| `duration` | |
|---|---|
| `restart` (default) | The current state's length starts again |
| `extend` | The new length is added to what is left, capped by `extendCap` (an expression, e.g. 1.3 × length) |
| `keep` | The length is left as it was |
| `longer` | Whichever is left longer: what was left, or the new length |

| `value` | |
|---|---|
| `newest` (default) | The new application's vars replace the old |
| `stronger` | The vars of whichever has the greater `strength` stay |
| `keep` | The first application's vars stay |

- **Under `per: "host"`, the caster becomes the newest one** unless `value` keeps the old: a
  shared debuff such as a sunder belongs to whoever applied it last.
- **Stacks are read as `stacks`** in every expression of the magic, so a value per stack is
  `{ mul: ["var.perTick", "stacks"] }`. Held modifiers can be set `perStack` and are updated when
  the count changes. The `stacks` action and the event `stacksGone` handle stacks that are used up.
- **Values are fixed when applied, attributes are read live.** `vars` are worked out by the `cast`
  action with the caster's attributes at that moment (WoW's snapshotting). `caster.<attr>` inside
  the element's own expressions is read when they run. A skill chooses per number which it wants.
- **Ranks meet**: a stronger rank of the same group replaces a weaker one with `value: "stronger"`,
  and does not stack beside it, because they share the group.

## Attributes in expressions

Attributes are step 3's stats: defined in `stats/`, given by templates, changed by modifiers from
gear, magics and later talents. Skills read them **everywhere a number goes**. A field that takes
a number takes an expression, without exception:

- **Casting**: `range`, `minRange`, `cost`, `cooldown`, `gcd`, the length of a cast state.
- **States**: `length`, `period`, `extendCap`, travel speed.
- **Actions**: amounts, `chance` probabilities, `vars`, `move` distances and speeds, `summon`
  counts and durations, threat.
- **Areas and groups**: radius, angle, length, width, `max`, chain jumps and radius.
- **Stacking**: `max`, `strength`.

An expression can read:

| Name | |
|---|---|
| `caster.<attr>`, `target.<attr>`, `host.<attr>` | That unit's final attribute value. A missing unit reads the attribute's `default` |
| `level` | The spell's level |
| `stacks` | The magic's stack count |
| `var.<name>` | One of the magic's vars |
| `random` | A number from 0 to 1 from the magic's stream, drawn fresh for each action and target |
| `distance` | From the caster to the target the action is running on |
| `amount` | In a roll's `mitigate`, and in triggers on a hit: the amount so far |

**Talents become attributes.** "Your stuns last 1 s longer", "Fireball casts 0.5 s faster" and "your
damage over time lasts 20% longer" are modifiers on attributes such as `stunDuration`,
`fireCastTime` and `dotDuration`, which the skills read. Talents do not need to reach into skills,
and a pack adds a new talent hook by adding a stat and reading it. Attributes that only skills read
are ordinary stats with `visible: "owner"`, so the inspector already shows where each one comes
from.

**Checked at load.** Every name in every expression is checked against the stat table and the
skill's vars, and every expression is compiled once (ENTITIES.md, *Formulas*). Reading an attribute
while the game runs is an index into a `Float64Array`.

## Areas and target groups

**Areas** are named shapes a skill can place:

```json5
areas: {
  around: { shape: "circle", radius: 8, at: "caster" },
  front:  { shape: "cone", radius: 10, angle: 90, at: "caster" },        // along its facing
  line:   { shape: "rect", length: 20, width: 4, at: "caster" },
  ring:   { shape: "ring", radius: 12, inner: 6, at: "point" },
}
```

`at` is `caster`, `host`, `target` or `point` (the point the cast was aimed at). Sizes are formulas.
A ground effect, such as a burning patch, is a magic hosted at a point: its states tick on an area
`at: "host"`.

**Target groups** are named sets of entities that actions use. Each is filled the first time an
action uses it in a state, and again when a state lists it in `refill`:

```json5
groups: {
  main:    { from: "target" },
  burned:  { from: "area:around", filter: { relation: "enemy", alive: true }, max: 10, sort: "nearest" },
  bounce:  { from: "target", chain: { jumps: 3, radius: 10, filter: { relation: "enemy" } } },
  weakest: { from: "area:around", filter: { relation: "ally" }, sort: "lowestHealth", max: 1 },
  top:     { from: "threat", max: 1 },                    // the host's threat table, highest first
}
```

| Field | |
|---|---|
| `from` | `target`, `caster`, `host`, `area:<name>`, `group:<name>` (another group), `threat` (the host's table), `owner`, `summons` |
| `filter` | `relation` (`enemy`, `ally`, `any`), `alive`, `tags`/`notTags`, `self` (include the caster or not), `los` |
| `sort`, `max` | `nearest`, `farthest`, `lowestHealth`, `random` (from the magic's stream); how many to keep |
| `chain` | Jumps from each picked target to the next nearest that passes the filter, never the same one twice |

`host` and `caster` exist without being defined.

## Spells

A spell is a skill on a unit. It is a new part of the entity (ENTITIES.md, *The entity model*):

```ts
interface Spell {
  skill: number;        // index into the skill table
  level: number;        // read as `level` in its formulas
  source: string;       // "template", "item:mainHand", "debug" - removed together, as modifiers are
  ready: number;        // server time its cooldown ends
  passive?: number;     // the id of its magic, for a passive
}
interface SpellBook { spells: Spell[]; gcdUntil: number; categories: Map<string, number>; queued?: CastRequest }
```

- **Templates give spells**: `spells: [{ skill: "autoAttack" }, { skill: "fireball", level: 1 }]`.
  Classes and talents will add theirs the same way later.
- **Items give spells** under their slot's source (ITEMS.md, *Abilities*): `equip` gives the item's
  skill as a spell from `item:<slot>` (a passive starts at once), `unequip` takes away every spell
  from that source and ends their magics, and `use` casts the item's skill once, as a spell of
  level 1 that is not kept.

## Magics

```ts
interface Magic {
  id: number;            // u32, unique for the server's run
  skill: number;
  caster: number;        // entity id; it may be gone
  host: number;          // the entity it lives on, or 0 for one at a point
  x: number; y: number; z: number;   // its point, for `at: "point"` and a host of 0
  target: number;        // the target it was cast at
  level: number;
  state: number; stateStart: number; nextTick: number; ends: number;
  stacks: number;
  vars: Float64Array;
  groups: (number[] | null)[];
  rng: Rng;              // its own stream (Principles)
  held: HeldRecord[];    // what `hold` did, to undo it
}
```

- **They live with their host**, in a `magics` list on the entity (or on the dimension, for ones at
  a point), so they leave with the host when it is despawned or changes dimension.
- **Stepped by the server** after bodies move and before resources (ticks and lengths by the
  server's time). Each step a magic can pass through several states if their lengths are 0.
- **Ending one** runs the current state's `exit`, undoes its holds, tells the client if it was
  displayed, and drops it.
- **A unit has one cast in progress at most**: the magic of its own spell in a state with a `bar`.
  That is what moving breaks, what an interrupt hits, and what the cast bar shows.

## Casting

New intents:

```ts
{ type: "target", id }                          // 0 clears
{ type: "cast", seq, skill, target, x, z }      // skill: index; target 0 for the current; x, z for a point
{ type: "stopCast" }                            // Escape, or moving the cast bar away
{ type: "attack", on }                          // auto-attack on or off: the unit's `attacking` state, which the passive checks
{ type: "respawn" }                             // dead: back to the dimension's spawn, full health
```

Checks happen in order, and the first one that fails is answered with a `castFailed` event to the
caster only, with its reason:

1. The unit knows the spell and is not blocked: its control flags (*States on a unit*), its
   lockouts, and the skill's `blockedBy` and `requires`.
2. **Busy?** If the unit is in a GCD, a cast, or the spell's cooldown and it ends within the queue
   window (0.4 s), the request is queued (one at most; a new one replaces it) and fires when that
   ends. Otherwise it fails.
3. The target is valid: alive (unless the skill says otherwise), the right relation, its own
   `targetRequires` and `targetBlockedBy`, and not `immune` or `stealthed` against a hostile skill.
4. Range (centre to centre minus both radii, with 1 m of leeway when checked again at commit),
   facing, line of sight, and the cost.

Then the magic starts in its start state. Instants pass through to `commit` and their effects in
the same step.

- **Line of sight** is a ray from 1.6 m above the caster's feet to the same height on the target,
  through the server's collision world (`raycastAny`) against terrain and buildings. Trees do not
  block it; a mask leaves them out.
- **Moving** is a body that moved more than 2 cm this step, or jumped, by its own input. Being
  knocked back is not moving.
- **The GCD** is `rules/combat.json5`'s `gcd`, 1.5 s. A skill can give its own length, or be off it.

## Rolls

```json5
// rules/combat.json5
{
  gcd: 1.5, queueWindow: 0.4, rangeLeeway: 1,
  rolls: {
    default: {
      hit:  { sub: [0.95, { mul: [{ sub: ["target.level", "caster.level"] }, 0.01] }] },   // chance, 0-1
      crit: { add: [0.05, { div: ["caster.agility", 2000] }] },
      critMultiplier: 1.5,
      mitigate: { div: ["amount", { add: [1, { div: ["target.armor", { add: [400, { mul: ["caster.level", 85] }] }] }] }] },
    },
    spell: { hit: 0.96, crit: { div: ["caster.intellect", 6000] }, critMultiplier: 1.5, mitigate: "amount" },
    noCrit: { hit: 1, crit: 0, mitigate: "amount" },
  },
  threat: { damage: 1, heal: 0.5, forgetAfter: 6 },
  combatTimeout: 5,
}
```

- **Three separate rolls**, in order: `hit` (a miss ends it there), then `crit`, then `mitigate`, a
  formula of `amount`. Then absorbs, then health. A skill's damage picks a roll set by `roll`;
  without one, `spell` if the skill is tagged `spell`, else `default`.
- **Every outcome is an event.** A miss, a crit, how much was mitigated and absorbed, and overkill
  all go in the combat event, so the log, floating text and quests need nothing more.

## Death

- **At 0 health** an entity dies: a `death` event, the `dead` flag, which stops movement and casting, and its magics end except those whose skill says `keepOnDeath`.
- **A template can opt out**: `mortal: false` keeps it alive at 0 health, still regenerating. That
  is the training dummy, and matches what ITEMS.md expects of it (loot rolled at 0).
- **A dead player** sends `respawn` and comes back at its dimension's spawn with full health.
  Death penalties are later, game config (GAMEPLAY.md).

### The death animation (step 7)

When a unit dies its body falls and stays down until it despawns or comes back. Client only: the
server already says everything needed.

- **Driven by the `dead` flag, not the event.** The mirror has each unit's flags (`entityFlags`).
  When a unit's `dead` bit goes on while it is in view, its body plays the fall. A unit that comes
  into view already dead (its spawn is followed by its flags in the same step) is put down lying,
  with no fall replayed. The `death` event stays for the log and, later, sounds.
- **The animation** (`src/character/animation.ts`, CHARACTERS.md's procedural poses) gains a `dead`
  input. The fall takes about a second: the knees buckle, the body tips backward or sideways (picked
  from the unit's seed, so every client shows the same fall), the arms go slack, and it settles
  flat on the ground with a small bounce. Then it lies still: no breathing, no head turns, the
  idle and the gait blended out. A swing in progress is dropped. The body lies on the ground's
  height under it, as the feet stand on it now; no ragdoll, no foot IK.
- **Coming back.** When the flag goes off: revived where it lies (`debugKill` with `revive`, a
  resurrection later), it gets up over about a second; moved as well (a respawn is a teleport, as
  CHARACTERS.md's 3 m rule already detects), it simply stands at the new place.
- **A dead player.** The own body falls like anyone's; the camera stays on it; the HUD's "You have
  died" box offers Respawn. Respawning puts the player at its dimension's spawn, standing, with full
  health - the "home" of GAMEPLAY.md until homes, death penalties and corpse runs come with game
  config. Others see the same: the body down where it died, then the player standing at the spawn.
- **A dead creature** (a mortal template) lies until it is despawned. Corpses lasting a while and
  being looted (ITEMS.md's loot from entities) come with creatures (step 6) and items; the training
  dummy is not mortal and never falls.
- **Picking.** A dead unit's capsule stays clickable where it lies, so a corpse can be targeted
  (and later looted); Tab skips the dead, as now.
- **The workbench** (`?asset=core/races/human`) gains *Die* and *Get up* in its *Play* menu, so the
  fall can be judged and tuned on every race and outfit.
- **Checked**: in the game, `__aiworld.entities.kill()` on the own player (it falls, the box shows,
  Respawn stands it at the spawn), on a second player from `addPlayer` (it falls, `kill(id, true)`
  gets it up where it lies), and a unit coming into view already dead lies without falling; on the
  workbench, every race in each outfit.

## Threat

A `threat` part on entities whose template says so (`threat: true`, creatures). It is a table of
unit id → amount:

- **Damage** adds `amount × combat.threat.damage × the action's threat` to the damaged unit's table
  for the dealer. **Healing** adds `amount × heal`, split evenly over every table that has the
  healed unit on it. `threat` actions add or taunt.
- **Summons have their own row.** A summon's damage puts the summon on the table, not its owner;
  its owner's healing of it counts as healing. When it dies or ends, its row goes.
- **In combat** now means: on a table, or having a table that is not empty. That replaces step 3's
  debug flag (the debug command stays and forces it). A player hit by something without a table
  stays in combat for `combatTimeout` seconds.
- **A table forgets** a unit that is dead, in another dimension, or has done nothing to it for
  `forgetAfter` seconds while it has no AI to chase (until creatures, step 6, which add leashing).
- `group: { from: "threat" }` reads the table, highest first. The dummy uses it to pick whom to
  cast at.

## Messages

Server to client, all within the interest radius (ENTITIES.md, *Replication*):

```ts
{ type: "combatEvents", events: CombatEvent[] }     // once per step, every event the client may see
CombatEvent {
  kind,                 // u8: hit, miss, heal, absorbed, castStart, castDone, castFailed, castStopped,
                        //     interrupted, auraOn, auraOff, auraStacks, dispelled, death, summon,
                        //     animation, effect
  source, target,       // u32 entity ids (0 for none)
  skill,                // u16
  amount, extra,        // f64: the amount; overkill, or mitigated
  absorbed,             // f64
  flags,                // u8: crit, periodic, ...
  reason,               // u8: why a cast failed, or why an aura went
}
{ type: "entityCast", id, skill, start, length, channel }   // a cast bar starts; skill -1 when it stops
{ type: "entityAuras", id, auras: AuraState[] }             // displayed magics on a unit, whole list on change
{ type: "entityFlags", id, flags }                          // u32 bit set of the control flags held, on change
AuraState { magic, skill, caster, stacks, start, ends }     // u32, u16, u32, u8, f64, f64 (ends 0: forever)
{ type: "entitySpells", spells: SpellState[] }              // own player only, on change
SpellState { skill, level, ready }                          // u16, u16, f64 server time
{ type: "entityTarget", id, target }                        // whom a unit targets, for target-of-target
```

- **Snapshots gain the server's time** (`time`, f64), so cooldowns and bars count down on the client
  without being sent again.
- **Visibility**: events go to clients that see the source or the target. `castFailed` goes to the
  caster's own client only. Auras are seen by everyone who sees their host.
- `PROTOCOL_VERSION` goes up by one: whichever of this and ITEMS.md lands second takes the next.

## Code

| File | What |
|---|---|
| `src/sim/rules/formula.ts` | Gains **scopes**: a formula compiled against a list of names (`caster.<stat>`, `target.<stat>`, `host.<stat>`, `level`, `stacks`, `random`, `amount`, `distance`, `var.<name>`) read from one `Float64Array` the action fills |
| `src/sim/rules/skillRules.ts` | Reads `skills/` and `rules/combat.json5`, checks every action through the registry, and resolves states, groups and areas to indices. Joins `GameRules` and its hash |
| `src/sim/skills/actions.ts` | The registry and core's action kinds |
| `src/sim/skills/magic.ts` | Starting, stepping and ending magics: states, ticks, holds, events, stacking |
| `src/sim/skills/casting.ts` | Requests, checks, the queue, GCD, cooldowns, costs, moving and interrupts |
| `src/sim/skills/targeting.ts` | Areas, groups, relation, range, facing, line of sight |
| `src/sim/skills/flags.ts` | The control flags and their immunities: counts on the entity, and what each blocks |
| `src/sim/skills/stacking.ts` | Meeting magics of one stacking group: add, duration and value rules |
| `src/sim/skills/combat.ts` | Damage and healing: rolls, mitigation, absorbs, death, threat, events |
| `src/sim/skills/random.ts` | The magic's stream: a seed from (world seed, tick, caster, cast counter) |
| `src/sim/playerBody.ts` | Gains forced motion for `move`: a velocity for a time, or an impulse, ignoring input |
| `src/game/combatHud.ts` | Target frame, own frame, cast bars, the combat log, the keys for spells |
| `src/game/targeting.ts` | Tab, clicking a unit, Escape |

## The test

**Core content**:

- **Player spells**: `autoAttack` (passive, a `swing` state every `weaponSpeed` seconds while
  `attacking` and the target is within melee range and in front, with the swing animation),
  `heroicStrike` (instant melee, rage), `fireball` + `fireballBurn`, `renew` (a heal over time on an
  ally or self), `shield` (an absorb, with `weakenedSoul` blocking a second one), `charge` (a dash to
  the target, rage, a 1 s stun), `thunderClap` (a circle around the caster, damage and −30% speed),
  `kick` (an interrupt with a 4 s lockout of the interrupted school), `sunder` (applied by
  `heroicStrike`: up to 5 stacks per host of −armor, the newest caster owning it), `searingTotem` (summons a totem that casts at the
  nearest enemy every 2 s, for a summon's threat row).
- **Talent-style attributes**: `fireCastTime`, `dotDuration`, `stunDuration` and `stunTaken`,
  factors with a default of 1, so the probe and the inspector's debug modifiers can move them.
- **Stats**: `weaponSpeed`, `weaponMin`, `weaponMax` with defaults for bare hands. Items' weapons
  set them through modifiers (ITEMS.md, *Equipment*).
- **The dummy**: `hostility: "hostile"`, `threat: true`, `mortal: false`, and a passive
  `dummyBolt`: every 8 s it casts a 3 s interruptible bolt at the top of its threat table, so
  there is a cast to kick and damage for the shield to soak up. It does not move or fight back
  otherwise.

**In the game** (`?config=tiny`): Tab targets the dummy; the target frame shows its name, level,
health, cast bar and debuffs; keys 1-9 cast the spells in the order the player knows them, R
toggles auto-attack; the own frame shows health, mana, rage, buffs and the GCD; the combat log
lists events as lines ("Fireball hits Training Dummy for 52 (crit)"). The body swings when the
server says so, not on a key.

**Headless**:

- `scripts/probe/abilities.mjs` (`npm run probe -- scripts/probe/abilities.mjs`):
  - Rules: every core skill loads, and broken ones (unknown action, state, group, attribute, skill,
    var, flag, event, roll set, template, a typo) give the expected errors.
  - Magics: states and lengths, ticks at the right times, holds undone on every way out, absorb
    used up then `absorbedOut`.
  - Stacking: every `add`, `duration` and `value` rule, `per` host and caster, two skills sharing a
    group, a stronger rank replacing a weaker one, `vars` fixed at application while `caster.<attr>`
    is read live, `perStack` modifiers following the count.
  - Flags: what each blocks, counting overlapping sources, an immunity resisting a stun, a stun
    interrupting a cast.
  - Attributes: a modifier on `dotDuration` or `stunDuration` lengthening the burn and charge's
    stun, and on `fireCastTime` shortening the fireball.
  - Casting: GCD, queue window, cooldowns and categories, costs at commit, range and facing, line of
    sight through a wall in the collision sandbox, moving breaking a cast, an interrupt and its
    lockout.
  - Rolls: the hit and crit rates of 10 000 rolls within their expected bounds, and the same seed
    giving the same rolls.
  - Threat: damage, split healing, taunt, a summon's row, forgetting.
  - **A fight**: a server on `tiny`, one client playing a fixed rotation on the dummy for 60 s of
    server time, then the same again. The two combat logs must be identical, and the dummy's
    threat table and auras must be as expected at the end.
- `npm run server -- --bot --fight`: the bot targets the dummy and runs the rotation, printing the
  combat log.

## Steps

Each leaves the game working: dev server, `npm run probe`, `npm run server`, `npm run build`.

1. **Rules.** Formula scopes; `skills/` and `rules/combat.json5` loaded, checked and hashed; the
   action registry with checks only; core's test skills and stats. The probe's rules part. Nothing
   runs them yet.
2. **Magics, headless.** Spell books, magics stepping through states, the instant and held actions
   that need no movement (`damage` and `heal` without rolls, `resource`, `modifier`, `flag`,
   `absorb`, `cast`, `stacks`, `remove`, `goto`, `set`, `if`, `chance`, `end`), stacking, control
   flags, random streams, the event bus. Started by debug commands. The probe's magic, stacking,
   flags and attributes parts.
3. **Casting and combat.** Intents (`target`, `cast`, `stopCast`, `attack`, `respawn`), the checks,
   GCD, queue, cooldowns, costs, moving, interrupts, line of sight; rolls, death, threat and combat
   state; the dummy's bolt. `--fight` headless. The probe's casting, rolls, threat and fight parts.
4. **The client.** Protocol bump: combat events, cast bars, auras, spells, targets, time in
   snapshots. Tab targeting, the frames, the cast bar, the combat log, spell keys, the swing from
   `animation`. Checked in `?config=tiny`.
5. **Movement and summons.** Forced motion on the body; `move` (charge, a knockback for the test),
   `summon` and the totem; group chains and the area shapes the test does not yet use.
6. **Items and wrap-up.** ITEMS.md's hooks wired in `server.ts` if items have landed (else left for
   items to call). `public/packs/README.md` (`skills/`, `rules/combat.json5`), SIMULATION.md's
   message list, ENTITIES.md's combat flag, CHARACTERS.md's *Next steps* 5; GAMEPLAY.md's step 4
   marked done (and step 8's skills renamed if the user agrees).
7. **The death animation.** The `dead` input in `animation.ts` - fall, lie, get up - driven by
   each body's mirrored `dead` flag (`characterBody.ts`, `entityMeshes.ts`, the own player's
   controller); lying at once for a unit seen already dead; *Die* and *Get up* on the workbench.
   Checked in the game and on the workbench as above; then GAMEPLAY.md's step 4 marked done.

## As built

- **Files.** `src/sim/rules/skillRules.ts` (skills, `rules/combat.json5`, scopes, `checkSkillRefs`);
  `src/sim/skills/`: `actions.ts` (the registry and core's checks), `runs.ts` (core's effects),
  `magic.ts`, `targeting.ts`, `combat.ts` (damage, healing, rolls, absorbs, threat, death),
  `casting.ts`, `flags.ts`, `events.ts`, `random.ts`, `unit.ts` (the combat part, relations),
  `types.ts`, `system.ts` (what the server calls), `combatLog.ts` (events as text). Client:
  `src/game/combatHud.ts`, `src/game/targeting.ts`; the mirror, the meshes (a target ring, swings)
  and `main.ts` grew. `scripts/server/fightBot.mjs` is the fighting client both `--fight` and the
  probe use. `formula.ts` needed no change: a scope is just a longer name table.
- **The combat part.** Every entity with stats has `combat` (`CombatPart`): spells, magics hosted on
  it, flags, lockouts, absorbs, its threat table, target, auto-attack, owner and summons.
- **A state left without a `length` lasts 0 s**, unless it waits for something (`on`), holds
  something or ticks - then until an event. An instant skill's magic is over within the step it
  started.
- **Stacking is opt-in.** A skill without `stacking` runs its magics side by side (two fireballs in
  flight); with one, the defaults are one stack, `per: "caster"`, `restart`, `newest`. A cast whose
  magic meets one already there still commits: it pays and cools down.
- **Groups.** `host`, `caster` and `target` exist without being defined. Filters also take `range`
  and `facing`; the source `attacking` is the host's target while it auto-attacks (what
  `autoAttack` swings at). `if` takes `has: <group>`, true when the group is not empty.
- **`hostOn: "target"`** puts a cast's magic on its target from the start (Renew, Shield), so a buff
  cast on an ally is one skill, not a cast and an aura.
- **Auto-attack and the dummy** are passives, as planned: `autoAttack` ticks every 0.1 s for a foe
  and swings at `weaponSpeed`; `dummyCaster` casts `dummyBolt` at the top of its threat table with
  `cast` `mode: "cast"`, `by: "host"`.
- **Trees do not block sight.** Their colliders stop bodies and shots only (`Layers.solid |
  Layers.shot` in `treeColliders.ts`); every query that existed uses masks that still hit them.
- **Moving** is a body that moved over 2 cm by its own input; a forced motion (`body.pushed`) is
  not. Stunned, rooted and dead bodies are given no input.
- **Messages**: protocol 6 (ITEMS.md takes the next). Snapshots carry the server's `time`; cast
  bars, auras, flags, targets and the own spells are replicated as signatures change. Debug:
  `debugApply` (start a skill's magic on an entity) and `debugKill` (or revive).
- **Items** (ITEMS.md, *Abilities*): `server.debug.skills.items` is `ItemHooks` by skill id - `use`
  casts once, `equip` grants under the source, `unequip` takes every spell from it away. Items had
  not landed, so wiring it into `createServer`'s `itemHooks`, `checkSkillRefs` for
  `ItemRules.abilityRefs`, and calling the wear functions on hits are left to whichever lands
  second. Items did all three when they landed (ITEMS.md, *As built*).
- **In the game** (`?config=tiny`): Tab (or a click) targets; 1-9 cast the spells the player knows,
  in its template's order (Heroic Strike, Fireball, Renew, Shield, Charge, Thunder Clap, Kick,
  Searing Totem); R toggles auto-attack; Escape stops a cast or clears the target. The frames sit
  below the debug panels. `__aiworld.entities` gained `target(id)`, `cast(skill)`,
  `apply(skill, entity)` and `kill(entity, revive)`.
- **The probe** (`scripts/probe/abilities.mjs`, 137 checks, about 10 s) runs the system on a
  stand-in world for everything but the fight, with a probe-only pack of test skills, and fights
  on a real `tiny` server twice. Checked in the game: targeting, the frames, cast bars, shield and
  weakened soul, sunder stacks, charge, the dummy's bolt, the totem, and the swing on the body.

- **The death animation** (step 7): `animation.ts`'s `dead` input (the characters session's fall
  and lie) is fed each body's mirrored `dead` flag - `entityMeshes.ts` for others, the own player's
  controller from `main.ts`. The animator gained `snap`: a body first shown already dead lies at
  once, and one that comes back more than 3 m away (a respawn) stands at once; dying and getting up
  in view play out (getting up eases in about a third of a second, not the second planned). The dead
  no longer regenerate (`stepResources` skips them). Checked in the game: the own player falling,
  the box, Respawn standing it at the spawn with full health; a second player falling, lying when
  seen again after leaving view, and getting up where it lay when revived.

## Not in this step

- Creature AI (aggro, chasing, leashing): step 6. The dummy's bolt is a passive, not a brain.
- Talents, ranks from trainers, and spells from classes: steps 8 and 9.
- An action bar to drag spells onto, spell tooltips and icons: step 10. Keys go by spellbook order.
- Visual effects for `effect` actions, floating combat text, sounds: only the event exists.
- Projectiles as entities, dodging them, and client-side prediction of casts.
- PvP and factions: a template's hostility stands in.
- Scripts that register actions: the registry is ready for them; loading script packs comes with
  modding.

## Settled after the plan

1. **Progression's name**: GAMEPLAY.md's progression "skills" become **disciplines** (renamed in
   the wrap-up).
2. **Facing**: a per-skill flag, on for core's hostile skills.
3. **Death for players**: a `respawn` button until death rules and homes come.
4. **The control flags**: the list in *States on a unit*. Fear, charm and sleep need AI to move a
   unit, so they come with creatures (step 6).
