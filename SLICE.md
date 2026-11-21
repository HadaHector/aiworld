# The vertical slice

The plan for the next goal: **one starting zone, the autumn wood, finished like a small game.** A
single-player session of about two hours, for the user only (no onboarding, no public demo polish), made
to show the framework off.

**Status: the plan is ready (the user, 2026-11-20). Built so far: W1, W9 and B2 (the vale: `dimensions/autumnVale.json5`, `public/configs/vale.json5`, `cellsPerArea`, levels by cell; see DIMENSIONS.md, *Cells per zone, and the vale*, and CREATURES.md, *Zones*).** Section 8 divides it into
sessions. Last tidied 2026-11-20.

Sizes: **S** under a day for one session, **M** about a day, **L** several days or several
sessions. "Par." means the task can run as its own session without touching another task's files.
The state of the code was checked on 2026-11-19 and 2026-11-20; where a doc and the code disagree, the
code is what is written here.

**How to read it.** Section 1 says what "done" is. Section 2 lists the places. Section 3 is the
*method*: the game is described with curves, ratios and tags, and that is how balance, skills, items,
enemies and quests are built. Section 4 is the task list by category. Sections 5-7 are the known
gaps, the order with milestones and cuts, and the open questions. Section 8 is the division into sessions.

## 0. Decided with the user (2026-11-20)

| Area | Decision |
|---|---|
| Method | Describe everything with **tweakable constants, curves, ratios and tags**; it is a customisable game *system*, not one game. |
| Balance | Target curves in `rules/balance.json5` (dps, time to kill, hp, gold, price...). **Derive** a baseline from them; things may keep their own offsets. **Fit** (measure) mainly combat: player stats, items, passives, active skills. |
| Classes | A **tank / glass-cannon axis** per class. **Full defence model** (armour, block, dodge, parry, resistance...) as switchable parts. **Ranger added** and the odd builds used as a stress test. |
| Duel tool | A **timeline**, not a world simulation: no geometry, no entities drawn; tracks the distance between two fighters and movement speeds. |
| Skills | A **skill count curve**; a bank of **tagged skill templates**; a class is **ratios of tags at key levels**. **Talents are out** of the slice. |
| Level-up | Stat points per level; **manual or automatic is a game config**. Out-of-combat **regeneration**, small. |
| Items | Simple: **6 per item type and slot** (1 start, 1 shop, 1 quest, 3 loot), generated from templates and curves. Creature loot: 1-2 trash, 1-2 valuable (one maybe rare), a slim chance of rare gear; item level near the creature's. |
| Enemies | **Levels by cell** (distance from the start). **No packs** in the starting area. Roles and tactics from templates; tactic opening delay and crowd-control rules. **No boss phases anywhere**; a boss is a strong elite. **Lairs are small caves or crypts** with a boss. Rare named enemies **tied to features**. **New kinds of enemies and animals**, many dictated by the features (3c). |
| Quests | Constant density. **Min-max effort curves by level** (kill 4 early, kill 12 later). Kind mix by ratio. **Item rewards on plain quests** too (modest). No escort quests. |
| Graphics | **Texture compression wanted** (not conditional). An options menu of **sliders** for the slow constants (no presets). **Dynamic lights on terrain**: a spell can light it. |
| World | **Water at its own level** (lakes, rivers, cave pools). **Twelve features, all in** (the sheepfold with sheep joins the eleven). **14 cells**, no empty ones, an authored cell plan. **Shore hills** (mountains along the coast with a bay or two). |

## 1. What "done" means

You make a new character in the menu, drop onto the square of a wood village, and play for two
hours without hitting a wall, a bug you have to work round, or a stretch with nothing to do. At the
end you stand somewhere worth standing, a few levels up, with gear you earned.

### The two hours

| When | What happens | Level |
|---|---|---|
| 0:00-0:10 | **Arrival.** The square of the start village, the inn, the class trainer, the dummy and the chest. First fight with the dummy, first skills learned. | 1 |
| 0:10-0:35 | **The intro chain** (`welcome`, `affliction`, `roadOn`, already built): the sickness in the village, herbs and wolf pelts from the wood around it, the salve; then a letter carried down the road to the second settlement. First real fights (wolves, boars), first loot, first gear from a quest. | 1-4 |
| 0:35-1:05 | **The wood opens.** The second settlement is the hub: shops, a trainer, quests. The roadside bandit camp, the coaching inn, the logging camp (wolves are killing loggers), the hunting lodge (pelts, a bear), the watermill. Several side quests side by side; the player picks. | 4-7 |
| 1:05-1:30 | **The old camp and the cave.** The abandoned logging camp is the wood's mystery (a chain of four quests); the cave mouth with its small camp and the cave lair under it. Spiders, grave robbers, the dead. | 7-8 |
| 1:30-1:50 | **The big fights.** The churchyard crypt (a small lair: stair down, a locked door, a boss). The motte and bailey: the bandit chief, in the open with adds. | 8-10 |
| 1:50-2:00 | **The grove.** The druid grove on a rise: a vista over the whole wood, a quiet reward, music changes. The end. | 10 |

At the end the player owns: level 10 (about 21,000 XP: see B1), a full set of green or blue gear for
their class from quests and bosses, the skills the class ladder gives by level 10, a bag of
consumables, some money, and a log of about 14 finished quests. (Talents are not part of the slice.)

### The quality bar, per category

| Category | The bar |
|---|---|
| Graphics tech | 60 fps at the default settings on the user's GPU in the village, the deepest wood, the lairs and the motte. The page does not grow past the budget in a two-hour soak. Nothing visibly wrong from where the player stands: no ocean in a lair, no rain in the inn, no flat grey props. An options menu whose sliders really move frame time. |
| World generation | One zone of 14 cells, an island-valley with mountains along its shore, all twelve features on it, a river with bridges, roads between them, readable as an autumn wood from any hill. The same seed always gives the same zone. |
| Gameplay elements | Every window the slice needs works and is not annoying: trainer, vendor, inventory, quest log, map. Death sends you home with a small cost. Saving and loading in the middle of a quest, or in a lair, brings you back where you were. Sound is never silent. |
| Enemies and quests | The wood has its own enemies, each with a body and a role; none does something annoying (no instant web). At least 14 quests (intro 3 included), varied in size and kind, a boss in each lair and at the motte. |
| Items and skills | Every level band brings a visible upgrade; every class has something new to press every level or two; no useless drops that look broken (no icon, no stats). |
| Balance | The curves hold: the duel tool reports every class within its targets; a bot playing the route reaches the end in about two hours of play time, level 10 plus or minus one, dying no more than a few times. The user's own run agrees. |

## 2. The twelve features

### What rolls in the autumn wood today

`autumnWood.json5` lists, as **weights** (not chances), per cell: settlement 0.8, coaching inn 0.5,
logging camp 0.6, hunting lodge 0.4, churchyard 0.3, nothing 0.8. A zone is 10 cells today
(`CELLS_PER_AREA`), **each cell rolls one feature on its own**, so nothing is guaranteed and a failed
placement leaves its cell empty. The slice does not roll: see W14 (an authored cell plan).

| Feature | Built? | State |
|---|---|---|
| Settlement (farm village, market town) | yes | Many houses, inn, chapel, smithy, NPC cast and generated quests. The start is chosen among them. |
| Coaching inn (roadside compound) | yes, first pass | On a road, stables. What is left is in designers/coaching-inn.md. |
| Logging camp | yes | Bunkhouse, saw shed, cookhouse, stable, tool shed, skid trail, stumps. |
| Hunting lodge | yes, revived | Props-only materials, tube-built antlers and deer, smokehouse. Its "not done" list is in LODGE.md. |
| Churchyard with crypt | yes | Chapel, graves, wall; mausoleums whose way down opens a generated crypt (seamless, creatures, lit). |
| Sheepfold | built, in **no biome list**, and **no sheep exist** | A moor and fell kind; **in the slice** (decided), with sheep as a new kind (E11) and its own entry in the cell plan. |
| Abandoned camp, motte, grove, watermill, cave mouth feature, roadside bandit camp | **no** | See below. There is no condition (decay) system in the code at all. |

### The twelve

Chosen by fun per cost from FEATURES.md and by what makes the wood read as itself. **All twelve are in
the slice** (the user: "we need to show off a little", and no empty cells). Six exist; six are new.

| # | Feature | Cost | Why | What it gives the two hours |
|---|---|---|---|---|
| 1 | **Start village + a second settlement** | exists | The home and the hub. The roadOn letter needs a second settlement. | Arrival, the intro chain, trainer, shops, bank. |
| 2 | **Logging camp** | exists | The wood's own industry; stumps and log piles say "wood". | A quest hub (loggers, wolves, a missing foreman), a fight, a vendor of tools and bread. |
| 3 | **Hunting lodge** | exists | Needs a hunter and a reason: the wood's game. | Pelt and hunting quests, the bear, a vendor of leather, a forester. |
| 4 | **Coaching inn** | exists | The road made real. | Rest, set home, rumours (the start of the old camp's chain), a vendor of food and potions. |
| 5 | **Churchyard and crypt** | exists | The one dungeon already built; at the small "lair" size. | Lair 1: the stair, a locked door, the boss, chests. |
| 6 | **Abandoned logging camp** | 3 (fun 5) | The same camp given up: roofs sagging, the yard greening, no fire. The wood's signature story place. | The mystery chain, a hostile place, a reward. |
| 7 | **Motte and bailey** | 2 (fun 4) | A bandit stronghold on a mound with a ditch and a palisade: the open-air fight, seen from afar. | The bandit chief with adds, a recovery quest, good loot. |
| 8 | **Druid grove** | 2 (fun 4) | A ring of huge old trees round a stone: autumn's quiet. | The vista, a rare herb or a book, the end of the slice. Needs a new "ancient" tree kind. |
| 12 | **Sheepfold, with sheep** | exists (sheep S-M) | A pastoral place beside the hub, built already; a fold without sheep is odd. A shepherd, a flock, wolves at the edge. | A gentle early quest (a lost lamb, wolves at the fold), wool, a vendor of mutton. Needs the sheep (E11) and a biome entry. |
| 9 | **Roadside bandit camp** | S | The first human fight before the motte: tents, a fire, a chest, a lookout, on the road. The `banditCamp` creature camp exists with no place. | A combat quest, bandit loot, the road made dangerous (E7). |
| 10 | **Watermill with a mill pond** | S-M | On the autumn wood's FEATURES.md list; earns the new water (W10) and is the **animated-part test**: a turning wheel (FEATURES.md piece 9), built for nothing yet. | A miller, "the lost shipment", a pool to swim in, a vendor of flour and bread. |
| 11 | **Cave mouth with its surroundings** | M | A lair's entrance as a feature: outside it, small buildings (a hut, a lean-to, a shed), props (crates, a cart, a fire, bones, a drying rack, a signpost) and the enemies who live there; the way in is a small fight and a story before the dark. DUNGEONS.md step 7 ("Around it") does not cover an entrance yard, so it is new work (W16). Works for any lair entrance. | The approach fight, a quest giver or vendor outside, a reason to go in. |

**Cells.** Twelve features are **two settlements and eleven other sites: thirteen places**. The slice zone
has **14 cells** (W9), so each place gets its own and one cell stays plain wood (W14).

**Cheap fillers, not counted:** wayside shrines (cost 1: a cairn with a small heal or a set-home); a
ruined watchtower on a hill; a **toll bridge or ford with a hut** (free where a road meets the river); a
**cave pool** (comes with the cave lair and W10). **Never in the slice:** charcoal burners, sawmill,
alchemist (the sawmill needs waterside placement and a wheel, the alchemist coloured smoke).

## 3. The method: curves, ratios and tags

The user's rule: **describe things with tweakable constants, curves, ratios and tags.** Everything
below is data in `rules/` or the packs, so another game config can change it.

### 3a. The balance step

**What is wrong today** (checked). Level 1 plays fine. What is missing is a well-built skill set over
levels 1-10, balanced between classes (ranged against melee, and defence), and above all **the
fights**: enemies' stats, skills and how they use them (the spider webs the moment it targets you),
their AI and where they stand. Levelling is "not that bad". Loot, gold, sell and shop prices need
attention too.
- Every number is typed by hand in many files: a wolf's stats and growth in `creatures/`, damage
  formulas inside each skill (`heroicStrike`: weapon max + 12 + strength/5), item `value`s in `items/`
  and `itemTemplates/`, money in `lootTables/` (a wolf drops 1-6 coins). Nothing relates them.
- Defence is armour only: `rules/combat.json5` has Classic's `armor / (armor + 400 + 85*level)`;
  spells ignore armour; no block, dodge, parry or resistances. Hit chance falls 1% per level of gap.
- Creature tactics are `{ skill, every: [min, max], when }` and the **first use is immediate** (the timer
  starts at zero in `brain.ts`), so a spider's web (`every 16-20, when distance > 4`) fires as soon as it
  aggros. No opening delay, no limit on crowd control.
- Classes: warrior (melee, rage), mage (ranged caster), priest (healer, smite); a bow exists but no
  ranged physical class.

**Two layers:**
1. **Derive** (cheap, exact). Kinds and items carry a **role** and offsets instead of raw numbers; the
   resolver computes the baseline from the curves, the way `resolveCreatureRules` already adds
   generated kinds. A creature, item or skill may still carry its own multiplier or offset (a tough wolf,
   a fast sword): the baseline is where it starts, not a cage. Covers creature health, damage and armour
   by level and role (*health(L) = ttk x player dps(L)*, *damage per hit = player health(L) / hits to
   die*), money per kill, quest and chest, an item's stat budget by level, slot and rarity, its price,
   vendor buy and sell rates, repair, potions priced in minutes of income.
2. **Fit and check** (measured, since skills are formulas). The **timeline duel tool** runs each
   class's rotation against a dummy of known armour and level and reports dps, time to kill and health
   lost per fight against the curves; skills are authored as relative *power shares* and the tool can set
   one scale per class and level band. Fitting matters most for player stats, items, passives and active
   skills.

**The duel tool is a timeline, not a world.** No geometry, no graphics, no real entities. Time runs in
small steps (or an event queue); the only space it tracks is the **distance between the two fighters**
plus movement speeds, so a ranged attack, a cast time, a kite or an approaching melee enemy come out of
the numbers. It uses the *real* skill, tactic and stat definitions (the brain's decision code made
callable without a creature). Checked: combat lives in `src/sim/skills` (`dealDamage`, `heal`, casting,
magic) and works on `Entity` plus a `Sys` with no renderer, so the cheapest route is the real skill system
on bare entities with a fake clock and a one-number distance, not a second copy of the rules. Movement
and range checks are the part that needs a stand-in (B7).

**A tank / glass-cannon axis.** Every class and build is placed on one axis. At equal level and gear the
product *damage x effective health* is the same (the **power budget**, from the curves); the class's
position (0 = tank, 1 = glass cannon) says how it splits. The fit tool checks both halves. Healers and
supporters share the axis plus a "throughput" term (healing counts as effective health for the group).

**Full defence.** Switchable parts in `rules/combat.json5`: armour, block (shields), dodge, parry,
per-school spell resistance, absorbs, crowd-control avoidance. Each is an *effective health multiplier*
in the curves, so a pack can turn any off and the balance still holds (B8).

**The ranger and the stress test.** The slice adds a **ranger** (bow, range, kiting) and checks the duel
tool against deliberately odd builds: a pure tank, a glass cannon, a kiter, a solo healer, a summoner, a
stealth burst class. If the curves cannot place them all, the system is wrong, not the build (B9).

**The curves** (each a table by level 1-10, a formula beyond, editable by hand; the values are first
guesses to be tuned):

| Curve | Meaning | Starting guess |
|---|---|---|
| Player health | a character's health at level L | 60 at 1, about +25 a level |
| Player dps | by role: melee, ranged physical, caster, healer-hybrid | melee and ranged equal at same gear; caster a bit more burst, less sustain |
| Time to kill | a same-level normal enemy; an elite; a boss | 10 s; 30 s; 120 s |
| Time to die | an undamaged player against a same-level normal enemy's full output | 35 s normal, 12 s elite, 25 s boss with adds |
| Fight cost | share of health a same-level normal fight takes | about a third |
| XP | kills to the next level, and the quest share | from PROGRESSION; kills about 55%, quests 45% |
| Gold | money per hour at level L, split kills / quests / chests | tied to the price curves |
| Price | a potion = minutes of income; a level-band weapon = hours of income | potion about 4 min, a good weapon about 40 min |
| Sell rate | share of the buy price a vendor pays | 25% |
| Item power | stat budget by level, slot and rarity | green +15% over common, blue +35% |
| Drops | items an hour by rarity; one upgrade expected per level | |
| Skill count | skills a character knows by level | from the class templates (3b) |
| Stat points | points per level | a curve |
| Regeneration | out-of-combat health and resource regen | small, delayed after combat; several minutes to refill, so food and potions stay the fast route |
| Quest effort | min and max effort per level | kill 4 at the start, kill 12 later |
| Creature complexity | tactics a creature has by level | a level 1 wolf bites; later ones have a second trick |

### 3b. Skills, classes, level-up, items

**Skills from templates, classes from ratios.**
- A bank of **skill templates**, each tagged: *kind* (damage, heal, shield, crowd control, buff, debuff,
  mobility, resource, summon), *level range*, *cooldown category* (spammer, short, long, ultimate),
  *active or passive*, distance (melee, ranged, self) and school. The 48 skills in the pack (many are
  creatures') become the first members, tagged by hand.
- A **class template** is **ratios of tags at key levels** (every 10 levels in the engine, so levels 1
  and 10 for the slice): at level 10 a warrior might be 40% damage, 20% crowd control, 20% mobility, 20%
  defence, with two long cooldowns and one passive. The generator picks matching templates and scales
  each by its power share. Warrior, mage, priest and ranger are hand-picked results of the same
  description, which keeps the system customisable.
- Today: three classes with 3 starting skills and 2 unlocked by level 4 (Thunder Clap 2, Kick 3 for the
  warrior; Searing Totem 2, Frost Nova 3 by scroll for the mage; Shield 2, Kick 4 for the priest). That
  is thin; the skill count curve fixes it.
- **Talents are out of the slice** (the trees and points stay in the engine, unused).

**Level-up stats.** Each level gives stat points; a **game config** chooses whether the player spends them
or they are **distributed automatically** by the class's weights. The amount per level is a curve.

**Items, simple.** For every **item type and slot** (each armour type and slot, each weapon type):
**6 items** over levels 1-10: 1 starting, 1 shop upgrade, 1 quest upgrade, 3 from loot (drop or chest).
Stat bonuses on rare items are expected; nothing more (no sets, procs, crafting). By a rough count
(about 10 slots x 3 armour types plus about 8 weapon types) that is about 230 items, so they are
**generated from item templates and the curves** (budget by level, slot, rarity), not typed. The existing
12 templates and 77 items are the start.

**Loot from creatures.** Each kind has **1-2 trash items** (sell value only, a wolf's fang) and **1-2
valuable ones**, one of which can be rare, plus a global **slim chance** of rare equipment. The item's
level is **close to the creature's**. Trash and valuable shares, rare chance and level spread are ratios.
Rare named enemies add unique loot.

### 3c. Enemies

- **Levels by cell.** A zone is made of cells; each cell takes its level from its distance to the start
  by a curve, and a creature's level is its cell's plus a small spread (replaces the rings; B2).
- **No packs** in the starting area (the `groups` rule stays single-only).
- **Roles and tactics from templates and ratios**: a **brute** (wolf, boar: melee, one trick), a
  **skirmisher** (stays at range, kites), a **caster** (bandit mage, the dead), a **swarm**, an **elite**,
  a **boss**. A role bundles distance behaviour (closes, holds, kites), an opening delay, a crowd-control
  allowance, a flee threshold. Every tactic has an **opening delay** (`after`); crowd control is never the
  first thing, not twice in a row, with a short immunity after it ends.
- **Encounter curves** (density by distance, elite share, aggro radius, leash) rather than hand
  placement. No elite on the first road.
- **No boss phases, anywhere.** A boss is a stronger elite with a tactic set. The slice has **2-3 lairs**:
  small caves or crypts with few rooms, each with a boss and its loot. The DUNGEONS.md `lair` size (a few
  rooms, seamless entry) is the model, not the 15-30 room dungeon.
- **Rare named enemies are tied to features**, placed where the feature says (the cave's boss, the
  roadside camp's captain, the motte's chief). Their count is the number of such features.
- **New kinds, and features that dictate who lives there** (decided with the user: the plan had nothing
  on new kinds; enemies are partly dictated by the features). Today there are 13 species (ant, bandit,
  bear, beetle, crocodile, lynx, rat, scorpion, spider, stag, undead, wolf, boar; several are not
  woodland) and **no livestock**: a sheepfold has no sheep. A feature declares the creatures of its place
  (its residents, as a camp or as spawn points) beside the terrain's habitat lists, so a place comes
  with its own life. CREATURES.md has camps (one group, members, a leader at the centre) but no link from
  a feature to its creatures, and a camp is only its members until a compound places props round it:
  to be built (E12).

  | Place | Residents (existing, **new**) | Role |
  |---|---|---|
  | Sheepfold | **sheep** (a flock, neutral, flees, wool and mutton), a shepherd NPC; wolves at the edges | livestock, brute |
  | Logging camp | loggers (NPC), wolves, **timber beetles** (a swarm, if the beetle body fits) | brute, swarm |
  | Hunting lodge | stag, boar, the bear; a hunter NPC | brute |
  | Roadside bandit camp | bandit thugs and hexers (exist), a **bandit archer** (ranged, kites) | brute, caster, skirmisher |
  | Abandoned camp | spiders, rats, the **hollow logger** (an **undead variant** of the logger) | skirmisher, swarm, brute |
  | Churchyard crypt (lair) | restless dead (**more undead variants**: a wight, a bone-pale warden), grave robbers, spiders | brute, caster |
  | Cave mouth and cave (lair) | **bats** (swarm), a **cave spider** (a variant), bandits at the mouth, a **cave bear** as the boss | swarm, skirmisher, elite |
  | Motte and bailey | bandit thugs, hexers, archers, **war dogs**, the chief (named elite) | all roles |
  | Druid grove | a **giant** (a huge humanoid, the rare named elite: a moss giant guarding the ring) | elite |
  | The open wood | wolf, boar, bear, lynx, stag | brute, skirmisher |

  **Decided with the user:** the sheep (with the sheepfold), **undead variants**, the **cave bear**, and a
  **giant humanoid** as the elite. **No ambient critters** (chickens, dogs, fox, hare, fish, frogs): not
  needed in this slice.

  Every **role** gets at least two kinds, so the AI pass (E8) and the duel tool have cases of each. New
  bodies are the cost: sheep (a beast body, the quadruped base of BEASTS.md), the cave bear (a variant
  of the bear), bats (new, small), the war dog (a wolf variant). The **giant** and the **undead** are
  humanoids: the character body scaled up and tinted, with a club or no gear (to check that the body
  can be scaled, and what a giant's collider and animation do at twice the height). The rest are
  variants of bodies that exist.

### 3d. Quests

- Constant **density**. **Min-max effort curves** by level: a drawn quest's effort lands between them.
  XP and money follow effort as in QUESTS.md (*Rewards*), the total set by the balance curves.
- **Kind mix** by ratio (about 35% kill, 20% gather, 20% talk and deliver, 15% reach, 10% use), kept near
  by the generator.
- **Quest items on plain quests too**: a modest common item at about the quest's level, from the "quest"
  role of the 6-per-type layout, one to three pieces for slots the character lacks.
- **Plot templates come after the places**: each feature task ends with its plot templates, then E4 draws
  on them. No escort quests.

### 3e. Graphics, world

- **Options** are **sliders, no presets**, for the slow things that are constants today (see G9).
- **Terrain lights are dynamic**: spells and effects light the ground (G10).
- **Water** has its own level per body (lake, pond, river ribbon, ocean, cave pool) (W10).
- **Shore hills**: boundary-hill style keyed on distance to the coast, with a bay or two (W15).

## 4. Tasks by category

IDs are used in the dependencies. Where two tasks touch the same files they are not run at once (section
6).

### (a) Graphics tech

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| G1 | **World / dungeon drawing switch.** Stopgap first (S): turn the ocean plane off while `sunLighting.underground` is on (ocean.ts and world.ts have no underground handling; the sky and fog fade, the ocean does not). Then the real switch (M): underground, skip the terrain chunks, trees, grass, buildings and the sun shadow pass; restore them on the way out. Also a frame-time and memory win in lairs. | S + M | - | yes |
| G2 | **Performance and memory budget.** Targets (60 fps, a page heap ceiling, GPU memory); a soak: a bot or camera path through the village, the deep wood, the lairs and the motte for 30 / 60 / 120 minutes, logging heap and frame time. Fix what it shows (page-memory traps, shadow casters past the shadow's reach, the tree buffer rebuild: BACKLOG.md). One biome, one zone, so far lighter than the 25-biome world. | M | W1 | yes |
| G3 | **Texture compression** (TEXTURES.md, a plan: nothing is compressed today; the buildings' array alone is ~280 MB of GPU memory). **Wanted by the user, not conditional.** Also the scalability story for weaker GPUs (G9 offers lower texture sizes). Phased as TEXTURES.md does, biggest first: the buildings' array, then the ground's. | L | G2 (to measure the gain) | yes |
| G4 | **Autumn look.** Falling leaves as an air particle layer (`src/particles` exists), smoke from lived-in chimneys and the camps' fires (PROP_EFFECTS has flames; smoke is `smoke.torch` only), the weather set for the zone (all exist), golden-hour tuning. Wind in trees exists. | M | - | yes |
| G5 | **Prop look pass per feature.** Props-only materials exist (PROP_RENDERING steps 1-4 and 6; step 5 parked). Each new or revived feature gets a look pass in the workbench, as the lodge did (LODGE.md's open list). Part of each feature's own task. | S each | the feature | with the feature |
| G6 | **Ambient occlusion decision.** SSAO2 is in the game (toggle, sliders, default on); its frame cost was never measured on the real GPU. Measure, pick the default. Baked vertex AO for dungeon parts and buildings stays a stretch. | S | - | yes |
| G7 | **Rain and snow inside buildings** (BACKLOG.md): it rains through the inn's ceiling. Cheapest fix: fade the fall out while the camera is in an enterable house. | S | - | yes |
| G8 | **Lights, one check.** Windows' daylight and lamps exist in the baker; check that the village at dusk and the camp's fire read in the game, not only the workbench. Night is "decoration", one pass. | S | - | yes |
| G9 | **A real options menu of sliders.** Today the options window holds a debug-style panel (`debug/settingsPanel.ts`, wired in `game/dimensionView.ts`): draw distance, trees, grass, shadows, ambient occlusion with two sliders, flame distance, field of view, plus developer switches. Make it a player's menu of **sliders, no presets**, for **the things that make the game slow and are constants today**: draw distance, entity and creature distance (how far they are simulated and drawn), terrain LOD distances and detail, other LODs (trees, grass, buildings, props), shadow resolution, distance and cascades, ambient occlusion, texture quality (G3), render scale (Babylon's `engine.setHardwareScalingLevel` only resizes the canvas, so it works with a forward renderer and the HTML interface stays sharp), particle amount, dynamic light count (G10), flame distance, field of view, frame-rate cap. It starts with a **hunt for those constants** (the hard-coded distances, counts and sizes in world, entity and render code); each found one becomes a setting with its default unchanged. Saved in the browser, applied live where possible. Developer switches move to a separate panel. | M | G3, G10 for their settings | yes |
| G10 | **Dynamic lights on terrain** (LIGHTS.md, *Outdoors*, phase 6, a plan so far). Fires, torches and lanterns light the ground, grass and trees, and **a spell can light the terrain** (a fireball in flight, a flame on the ground, a carried torch). A runtime list of the few nearest lights (position, colour, strength, radius, flicker, expiry), fed each frame by props with a `light` and by skill effects (a `light` field, as props have), goes into the shared lighting block `LIT_SHADING_GLSL`, unshadowed; the count is a slider. A house's bake still takes in the static outdoor lights near it. Uses: the camps' fires, the lodge, lanterns in the village and inn, torches at a lair's mouth, the motte's braziers, fire and frost spells. Measure frame cost at night in the village and in a fight with many casts. | M | G2 | yes |

### (b) World generation

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| W1 | **The slice world.** A new dimension (`dimensions/autumnVale.json5`) or config with only `autumnWood`, one zone, a start rule that picks the farm village. Menu entry that goes to it (P5). Confirm one zone is one walkable piece of land (the BACKLOG "cells cut off by cliffs" artefact would be fatal inside one zone). | S-M | - | yes |
| W2 | **The seed, for the look.** With the cell plan (W14) placing the features, the seed only decides the land's shape. Scan a few seeds with a probe (relief for the grove and the motte, roads without holes, the river's course, the bays) and pin the best. | S | W14, W15 | after them |
| W3 | **Abandoned logging camp** (built 2026-11-21, see FEATURES.md, *The abandoned camp*). A first condition system, scoped small: a compound option `condition: abandoned` that swaps its buildings for worn versions (a missing roof section, a fallen wall, no fire or lamp), greens the yard, grows birch and rowan back over the felling, rots the logs. Condition is a general piece (FEATURES.md piece 2); the estimate there is for the camp's own kind only. | M | - | yes |
| W4 | **Motte and bailey.** The terrain stamp "mound" (and a ditch) is new; a palisade (line prop: a relative of the rail fence), a wooden keep with an interior and a stair (the house generator does this), the bailey yard (polygon yards exist, 01b3535), a gate toward the road, a camp of tents. | L | - | yes |
| W5 | **Druid grove.** A new ancient tree kind (huge, gnarled), a ring layout (placing N trees on a circle is only data), a standing stone prop, a clearing and a little ground paint. | M | - | yes |
| | **W5 as built (2026-11-21, branch `claude/slice-grove-1e9499`).** `features/druidGrove.json5` (a `ring` compound with no buildings, in the autumn wood's list at odds 0.3), a new `ancientOak` tree kind, `menhir` / `offeringSlab` / `treeMarker` prop generators, and **planted trees**: a tree-marker prop plants a ring of 5-6 oaks round the compound's middle through a wrapper on the tree scatter (`foliage/featureTrees.ts`; every caller of `createTreeScatter` that draws or collides passes the planted trees). Checked by `scripts/probe/grove.mjs`, in the workbench and in the game. Details and what is missing (ferns, mushrooms, a road in, the map marker): FEATURES.md, *Druid grove, as built*; concept notes: CONCEPTS.md. | | | |
| W6 | **Roads and wayside shrines.** The road network exists with bridges. Check the sites are linked by roads (BACKLOG: some sites unreachable), add shrines as a cheap line of props. Fingerposts exist. | S | W14 | no |
| W7 | **Settlement variety.** The wood only rolls `farmVillage` and `marketTown`: enough for a start village and a hub; look pass only (orchards, a drystone wall?). The settlement probe should show two distinguishable places. | S | W14 | yes |
| W8 | **Biome odds and the sheepfold.** Leave the biome's odds as they are (the full world still has this biome); the slice's list is in the dimension or config, and the sheepfold, in no biome list today, is placed there by the cell plan. | S | W1 | no |
| W9 | **More cells, same cell size.** `CELL_SPACING` stays 500 (commit 42c36a8 halved it from 1000). `CELLS_PER_AREA` is a global constant (10, `cells/config.ts`, used by `worldLayout.ts`): make it a **per-zone setting** (dimension or world config, default 10 so the full world does not change) and give the slice **14**. A zone is then about 3.5 km2, 1.9 km across. Check that world size and area count still derive correctly (`worldLayout.ts` multiplies area count by it). | S-M | W1 | yes |
| W10 | **Water at its own level.** Today every sea, lake, pond and river is a hollow of the ground filled to one sea level (`water.ts`, `WATER_SURFACE`, one ocean plane, the terrain shader tints against it), so a river can only run at sea level and a mountain lake cannot exist. Make **water bodies with their own surface**: *lakes and ponds* (a flat plane at their height), *rivers* (a surface ribbon that follows the centreline and steps down with the bed), the *ocean* as it is, and *a pool in a cave* (a flat plane inside a cave part). `waterAt(x, z)` returns the surface of the body at that point, so swimming, breath, creature avoidance and sound keep working (WATER.md already names a lake above the sea as left for later). Drawing: reflection and glint per body; the shore tint moves from the global sea level to the body's. To check: `terrain/rivers` and `cells/river*.ts` already know each river's depth, the likely source of the surface. | L | - | yes |
| W11 | **Rivers in the slice zone.** The world draws 3-5 rivers a continent and BACKLOG.md wants them per zone. The slice needs a river through the zone, at least one bridge on a road, a ford or two, ideally a tributary, so most walks meet water. Shares the river code with W10. | M | W10 | with W10 |
| W12 | **Tweaks list (the user's, to grow).** Small world fixes the user gives while looking at the wood: one task with a checklist, sorted into sessions as it fills. | S each | - | yes |
| W13 | **Watermill, and its turning wheel.** The building (a mill house over a race, a pond behind a small weir) is a compound and props. **The new piece is the animated part**: a prop part that turns about an axis (FEATURES.md piece 9; today props only have flames and smoke), driven by a speed, stopped when the wheel is stopped, culled at distance. Built as a general "moving part" so a windmill's sails or a well's winch can reuse it. | M-L | W10, W11 | yes |
| W14 | **A cell plan: thirteen places in 14 cells.** Weights and one roll per cell cannot be trusted to hold all thirteen places. The slice dimension carries an **authored plan**, a list of which feature goes in which cell (ordered by distance from the start, which is also the level gradient of B2); features still choose their own ground inside the cell. One cell stays plain wood. The inn and the mill can also use the road and the river rather than a cell, and the roadside camp is on a road anyway. | M | W1, W9, W3-W5, W10, W13, W16 | after them |
| W15 | **Shore hills (new).** One zone alone is an island: the biome's `borderType: "mountain"` is a boundary hill and it only rises **between two areas** (`areaBorderGap` is the distance to the nearest *other* area, `areaField.ts`; `terrainSampler.ts` adds the bump), so with one area nothing rises. A **shore hill style**, the same kind of bump (the existing pipeline and `BoundaryHillStyle`: width, peak, edge noise) but keyed on the **distance to the coast**, in a biome's data (`shoreHillStyle`, default none, so the full world does not change). The slice gets a **ring of mountains along its shore with a bay or two** (a beach where the hills part to the sea, the sea reaching in); gap count and width are constants of the style. To handle: the coast blend (roads cut through coastal hills were already a trap, WATER.md, *Roads*), sites keep off the steep ground (their `grade` rules), the river fades the hill (`riverHillFade`), the cell plan keeps the villages inland. | M | W1 | yes |
| | **W15 as built (2026-11-20, branch `claude/slice-shore-hills-92e208`).** A biome's `shoreHills` (`style` - a borderHills id, `grow`, `inset`, `width`, `peak`, `bays`, `bayWidth`, `bayDepth`) rises only in a world whose shape says `shoreHills: true` (off by default: the full world is unchanged). The land **grows out over the open sea** by `grow` (300 m for autumnWood) and the ridge stands on that band, so the cells keep all their land (the hills take about 0.3 km2 of it, the island goes from about 3.2 to 6.2-6.8 km2). Keyed on a true distance to the open sea (a distance field over the zone, `areaField.ts`), not the coast blend's edge gap. No growth near a river's line or past its mouth (an estuary through the hills), round water the land encloses, or where it would close a strait. No hills on thin land (a peninsula). Bays are discs on the main island's coast, spread apart: the ring parts and the coast falls back up to `bayDepth`. Sites keep off the hills through `areaBorderGap` (the distance to the crest there). Also **`coastWobble`** in the world shape (default 4, the continent's): at 4 a one-zone island breaks into an archipelago, so **the vale wants `coastWobble: 1, shoreHills: true`** in `dimensions/autumnVale.json5` (slice-world's file, set at the merge). The vale's river *source* still ends against high ground as a sea-level channel: that is the old water model, fixed by W10's `riverLevels`. | | | |
| W16 | **Cave mouth yard (feature 11).** A feature of its own on a hillside: the cave entrance (the `caveMouth` part exists, see section 5) with small buildings, props and a camp of enemies round it; declares the entrance for the cave lair. Built with the features system (compounds, camps). Also the churchyard is the crypt's yard (exists). | M | cave check (E6) | yes |

### (c) Gameplay elements

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| P1 | **Camera and controls.** Both mouse buttons turn the camera, no inertia (done). Fix the **inn camera clipping**: reported, not reproduced, so first a repro spot from the user, then the camera's collision against house walls. Nothing else new. | S | repro | yes |
| P2 | **Trainer window.** Today *Train* opens the general progression panel at that trainer (`npcWindow.ts`, `train`). A trainer's own list: skills available now, cost, which are locked by level, one click to learn. | M | I2 | yes |
| P3 | **Vendors.** Buying, selling and repairing exist. A stock per place (lodge: leather and arrows, camp: tools, inn: food and potions, mill: flour, hub: gear of the level band), the "shop" role of the item layout (I8), prices from the curves. | S | I8, B2 | yes |
| P4 | **Death.** Respawn at home exists (set at the inn). Check that death in a lair returns the player outside, that durability loss reads clearly, that nothing is lost for good. | S | - | yes |
| P5 | **Front end.** New-game flow into the slice: menu, character creation, a saved slot (the menu world exists). A "Finish" summary window at the end (optional, S). | S | W1 | yes |
| P6 | **Saving.** The save works (world delta, quests, belongings). Check the cases of two hours: log out in a lair, in the middle of a quest, with a cleared boss, reload at the one-hour point. | S | - | yes |
| P7 | **Sound.** Cues (76), sounds (104) and music per zone exist (the autumn wood plays the generic `forest` style). Missing: **ambience** (wind, birds, leaf rustle, rain on leaves, cave drips, water); the ambient bus exists, the system does not. A music pass for the lairs and the boss. | M | - | yes |
| P8 | **Map.** Done (minimap, world map, markers). A marker for each feature if one is missing. | S | features | no |
| P9 | **Level-up screen.** Stat points to spend (or the automatic result), shown on level-up; part of I7. | S | I7 | with I7 |

### (d) Enemies and quests

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| E1 | **The wood's roster.** Wolf, boar, bear, spider, lynx, stag and bandit all list `autumnWood` (new kinds: E11); the first six have beast bodies (BEASTS.md steps 1-6). Packs stay off. Undead in the lairs are humanoids tinted bone-pale (a skeleton body is a cut candidate). | S | - | yes |
| E11 | **New kinds.** Sheep, bandit archer and war dog, the undead variants (hollow logger, wight, bone-pale warden), bats and cave spider, the cave bear, the giant, as in 3c. Each: species file with traits and variants, a role, a body (variant or new), a loot table, its icons and sounds. Livestock is neutral and flees. No ambient critters. In sessions by group: sheep and the fold's flock; bandit variants; the dead, the cave and the giant. | L (3 sessions of M) | B6, E8, bodies | yes |
| E12 | **Features declare their creatures.** A `creatures` entry in a feature (a camp or spawn points with kinds, counts, levels, a leader) placed with the feature's own ground and props, beside the terrain's habitat; cleared camps stay cleared (the world delta). Needed for the sheepfold's flock, the cave mouth's residents, the roadside and motte camps, the grove's giant. To confirm in code how camps are placed today and what a feature may carry. | M | E1 | yes |
| E2 | **One trick per kind, and bosses.** Wolves flee when hurt, boars charge, the bear hits hard and slow, spiders web (after a delay), bandits have a caster and a bruiser. A boss per lair and at the motte: a strong elite with a tactic set, **no phases**. | M | E8 | yes |
| E3 | **The intro chain.** Built and probed (`quests.mjs`): `welcome`, `affliction`, `roadOn`. Check that it fits the first 35 minutes (time it with B3) and ends with the letter delivered in the hub. | S | B3 | after B3 |
| E4 | **New quests.** Today: 3 plots, 23 segments, 15 parts. The slice needs about 11 more quests tied to its places, not all "kill 8 X". Plots: *the missing foreman*, *wolves at the sawpit* (camp), *a bear for the lodge*, *the grey pilgrim* (churchyard, a key), *what happened at the old camp* (a chain of four), *the chief's tithe* (motte), *herbs for the grove*, *a message for the inn*, *the lost shipment* (mill, pickup and use), *the roadside toll* (bandit camp), *the hermit under the hill* (cave mouth). Existing part kinds as far as possible; new parts only for the shapes needed. Plots come after their place (each feature task ends with its plot templates). | L (3 sessions of M: camp and lodge, old camp chain, lairs/motte/grove/mill) | places | yes, after its place |
| E5 | **NPC life.** Roles exist (15). Place them at the features: logger and foreman, hunter, a druid, miller, bandit captains, a hermit. A guard that patrols; idle poses by role if the animation set has them. | M | places | yes |
| E6 | **Lairs.** The crypt is built and walked (stair, loops, creatures, lights, boss spawn, chests); DUNGEONS.md step 7 ("Around it": quest blocks, map floors, music, the player's light, daylight through the mouth) is not. The **cave** style was built by a parallel session after the first draft of this plan (section 5): to be checked and walked: a small cave lair with boss and chests. A **third lair** (the old camp's mine from the crypt's kit, or the motte's cellar) only if time allows. Each lair: a boss, loot (E9), spawn points, the map floor, music. | M (step 7) + M (cave check) | W3 for a mine | step 7 yes |
| E7 | **Roadside bandit camp (feature 9) and the motte's garrison.** The camp kind exists (`camps/banditCamp.json5`) with no place. A small camp on the road (tents, a fire, a chest, a lookout) and the motte's garrison. | S | W4 (garrison) | with W4 |
| E8 | **Creature AI pass.** Roles (brute, skirmisher, caster, swarm, elite, boss), tactic opening delay and crowd-control rules (never first, not twice in a row, immunity after), a skirmisher that kites, a caster that keeps range, placement rules for elites. Fixes the spider's instant web. | M | B6 | yes |
| E9 | **Encounter curves and rare spawns.** Density, elite share, aggro and leash as curves in `rules/`; rare named spawns placed by features with their loot. | M | B2, B6, places | yes |
| E10 | **Quest effort curves and item rewards.** Min and max effort by level, kill counts that vary, the kind-mix ratio, an item reward on plain quests from the quest pool. | M | B6, I8 | yes |

### (e) Items and skills

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| I1 | **Loot, gold and prices.** Item budgets, drop tables per creature and boss (tables exist for each beast, bandit and chest; the lairs, the bosses and the motte need their own), the gold curve, vendor buy/sell and repair, all from the curves. The item layout itself is I8. | M | B6, I8 | yes |
| I2 | **Skills per class.** A class template per class (tag ratios at levels 1 and 10) for warrior, mage, priest and the **ranger**, on the skill bank (I6); each skill a power share. Each class states its axis position and how it deals with distance (closes, holds, kites). One session per class. | M per class | I6, B8 | per class |
| I3 | **Crafting.** Nothing new: cooking at a fire (roast meat, bread), herb gathering (the sickness quest), bandages. No smithing, no alchemy. | - | - | - |
| I4 | **Icons.** Four items have no icon: torch, bandage, iron ingot, spell scroll (generated, waiting for the user's pick in `assets_work/comfyUI/review.py`). New items (boss gear, the grove's reward, generated gear) also need icons. **Generation uses ComfyUI and the GPU: never started without asking.** | S + user | user | yes |
| I5 | **Consumables.** Health and mana potions, bread, roast meat, bandage, salve exist. Check that a potion is a real answer to a hard fight at levels 6-10 and that the tooltip says it; food as the regeneration complement (I9). | S | B6 | yes |
| I6 | **Skill template bank.** Tags (kind, level range, cooldown category, active or passive, distance, school), tag the existing skills, a class template format and the generator that picks and scales, the skill-count curve. | L | B6 | yes |
| I7 | **Level-up stats.** Stat points per level (curve), config `manual` or `auto` (class weights), the UI for manual (P9). | M | B6 | yes |
| I8 | **Item generation.** The 6-per-type layout; templates and curves make the items; a pack file only marks the roles (start, shop, quest, loot); the creature loot ratios and the level-matched drop. | L | B6 | yes |
| I9 | **Regeneration.** Out-of-combat health and resource regen as constants in `rules/`, with the delay. | S | - | yes |

### (f) Balance

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| B1 | **Levels over the two hours.** XP to next level is `40*own^2 + 210*own` (250 for level 2, 5,130 for level 10); **level 10 costs about 20,850 XP in all.** A kill at your level is about 100 XP, so kills alone would be about 200; quests carry about 45%. Targets: level 4 at 0:35, 7 at 1:05, 8 at 1:30, 10 at 2:00 (open question 1). | S | - | yes |
| B2 | **Level bands by cell.** Creature levels come from a zone's ring (ring 0 = levels 1-4, `levels: { start: [1, 4], step: 3, width: 3 }` in `rules/creatures.json5`); one zone would make every wolf level 1-4. Use the cells: each cell's level from its distance to the start by a curve, a creature's level = its cell's plus a small spread; dungeons keep +1 per 8 parts. To confirm in code: where the ring becomes a level in `resolveCreatureRules`, and that a creature knows its cell. | M | W1, W9 | yes |
| B3 | **A slice bot and a tuning loop.** The server runs headless (`npm run server -- --bot`); `quests.mjs` plays the intro; `creatures.mjs` has a hunting bot. Extend into a route bot: the intro, the quests in a fixed order, fight, loot, buy the right gear, enter the lairs. Reports per 10 minutes: level, XP, money, kills, deaths, gear. The server steps without a renderer, so a run should not need real time (to be confirmed by the first run). | L | E3, W1 | yes |
| B4 | **Money.** One currency. The first 30 minutes buy a potion stock and a weapon; the end buys one armour piece of the best tier. Vendor prices, quest rewards and loot values all from the curves. | S | B6, B3 | after |
| B5 | **Difficulty.** A same-level fight costs about a third of health, an elite half the potions, a boss a real fight but not a wall; deaths per run no more than a few. | M | B7, B3 | after |
| B6 | **Core built 2026-11-20, see BALANCE.md** (curves agreed with the user; creatures, loot money and generated prices go through the resolver; the player landing on the curves is B7). **`rules/balance.json5` and the derive step** (the critical path). The curve format, a resolver that reads it, creatures and items moved from raw numbers to roles and offsets, loot money from the curve, prices from the budget. | L | curve list agreed | yes |
| B7 | **Timeline duel and fit tool.** See 3a. A pure function: two sides, a clock, the distance, movement speeds, the real skill, stat and tactic definitions, a rotation policy per class (priority list, kite or stand). Reports dps, time to kill, health lost, resource use, time out of range against the curves and the axis; optional auto-scale per class and level band. | L | B6 | yes |
| B8 | **Defence.** The full model as switchable parts in `rules/combat.json5`, each with its effective-health multiplier. | M | B6 | yes |
| B9 | **Stress-test characters.** The ranger plus the odd builds (tank, glass cannon, kiter, solo healer, summoner, stealth burst) as data, run through B7. | M | B7 | with I2 |

## 5. Known gaps, checked

| Gap | What was found | Where it sits |
|---|---|---|
| **Ocean plane inside lairs** | Confirmed. `ocean.ts` has no mention of the underground; `world.ts` fades the sky, fog and rain underground but the plane follows the camera at sea level and is drawn. A crypt goes down up to 45 m, the wood's lowland is 9-15 m high, so a crypt in a flat wood reaches below the water plane. | G1 |
| **Creatures probe, 3 failures** | `npm run probe -- scripts/probe/creatures.mjs` on master: **90 of 93 pass**. Failing: the bot kills no creature in 90 s (it does not reach a wolf and a boar 124 and 140 m away), the loot check that depends on it, and "no one further off than `social`". **New**: 93 of 93 at 6a588bb, 2f0da06 and a741e7b; the break came with 08a3ce6 (creatures follow into houses), e432ac4 (crypts peopled), 55b6b54 (ranged creatures close in) or a later merge. Not narrowed further. | E1, B3 |
| **Trainer window** | *Train* opens the progression panel; no trainer's own window. | P2 |
| **Quest variety** | 3 plots and 23 segments. Playable chain, thin variety. | E4 |
| **Ambient sound** | **Built (P7, see MUSIC.md *Ambience*):** wind, leaves, rain, water, birds, owl, cave drips, crypt drone; lair and boss music. Levels checked by probe and offline render, not yet listened to. | P7 |
| **Inn camera clipping** | Not reproduced; needs a spot from the user. | P1 |
| **Icons for four items** | Generated, waiting for the pick in `assets_work/comfyUI/review.py`. | I4 |
| **Cave dungeon** | **Corrected 2026-11-20.** The first draft said not started. A parallel session has since built a `cave` style and about 22 cave parts (`public/packs/core/dungeonParts/cave*.json5`, `dungeonStyles/cave.json5`; commits 97e5697 natural cave from field parts, 80a48ce cave mouths on steep hillsides, 6ec8d43 rougher caves). DUNGEONS.md's *as built* does not say so yet, and the packs have no cave-mouth *feature* (no `features/` entry) and no biome places one. Not checked by me: walking it, its boss, chests, spawns, the seamless entry. | E6, W16 |
| **Abandoned camp condition** | No condition or decay system anywhere in `src/world`. | W3 |
| **Sheepfold not in a biome list, and no sheep** | `features/sheepfold.json5` is in no biome, and no livestock species exists (the 13 species are ant, bandit, bear, beetle, crocodile, lynx, rat, scorpion, spider, stag, undead, wolf, boar). | W8, E11 |
| **One sea level** | Every water body is a hollow filled to sea level; no river or lake above the sea. | W10 |
| **Boundary hills need a second area** | One area has no border to a neighbour, so none of its hills rise. **Built 2026-11-20 (W15):** shore hills, see W15. | W15 |
| **`CELLS_PER_AREA` is global** | One constant, used by the world layout for every zone. | W9 |

Also found: the **full world takes about 4.8 GB of JS heap** when travelling (DIMENSIONS.md note). The
slice (one biome, one zone) is the answer, but G2 must measure it.

## 6. Order and cut list

### What first, what together

**The critical path is B6** (the curves and the derive step): I1, I5, I6, I7, I8, E8, E9, E10, B4, B7 and
B8 all wait for it, so it and its curve list (agreed with the user) start first, with W1.

1. **W1** (the world loads), **W9** (14 cells), **G1 stopgap** (no ocean underground), **B6** (the derive
   step): the first stretch. Everything else wants a place to stand or a number to use.
2. In parallel, none needing the others: **W3, W4, W5, W10 then W11 and W13, W15, W16** (features and
   terrain, one session each), **G4**, **P7**, **I9**, **G6, G7, G8**, **E6** (the cave check, step 7).
3. After B6: **B7** (duel tool) and **B8** (defence), then **I6** (skill bank), **I7**, **I8**, **E8**.
   After them: **I2** (a session per class, the ranger included), **B9**, **E9**, **E10**, **I1**.
4. **W14** (the cell plan) as the features land; **W2** (the seed) after it; **B2** right after W1/W9.
5. **E4** (quests) one session per place as it appears, with **E5**.
6. **B3** (the bot) as soon as W1 and the intro exist; it then runs every few days to tune.
7. **G9, G10** (options and dynamic lights) mid-way; **G2** (soak) and **P6** (saving) last, when the
   world is as heavy as it will be. **G3** (texture compression) when G2 shows where memory goes.

Tasks touching shared files, so not two at once: W3, W4, W16 edit `compound.ts` and the feature pack; E4
plots all add to `questSegments/` and `questPlots/`; I1, I2, I8 touch `items/` and `skills/`; B6, E8, I6
and I7 all touch `rules/` and the resolver.

### Milestones, each with a thing you can see

| # | Milestone | You can see |
|---|---|---|
| M1 | **The vale** (W1, W9, W15, G1 stopgap, B2 first cut, P5) | Menu, New game, the character drops on the village square of a wood with only autumnWood on the map, 14 cells, mountains along the shore with a bay; wolves are low level near the start and higher at the far side. Teleport into a lair: no ocean. |
| M2 | **The curves** (B6, B7 first cut, B8, I9) | One `rules/balance.json5`; the duel tool prints dps, time to kill and health lost per class and level against the curves; the wolf, boar and spider come out of the curves; out-of-combat regeneration. |
| M3 | **The first half hour** (G4, P7 first cut, E1, E8, E3, P2, I7, I6 first cut) | A new character plays the intro chain to the end: falling leaves, wind and birds, a spider that webs after a few seconds, a trainer window that teaches, level-up points, the letter delivered at about level 4. |
| M4 | **The wood has places** (W3, W5, W10, W11, W13, W14, W16, E4 first sessions, E5, P3, W6) | The map shows all twelve features. A river with a bridge and the turning mill wheel; the camp, lodge, inn, mill and old camp each give a quest or two; the vendors sell different things. |
| M5 | **Down into the lairs** (E6, I1, I8, E9) | The churchyard's and the cave's lairs each with a boss and chests; a cave mouth with a small camp outside; rare named enemies with unique loot; gear from a generated layout. |
| M6 | **The motte, the grove and the classes** (W4, E7, I2 for all four classes, B9, E4 rest, G10) | The bandit chief with adds on the mound; the grove's vista; four classes with ladders, the ranger among them; a spell lights the ground at night. |
| M7 | **Two hours** (B3, B4, B5, G2, G3, G9, P6, I4, P4) | A bot run ends at about level 10 in about two hours of game time; a soak shows a flat page heap; the options sliders move frame time; a saved game from an hour in continues right; your own run, start to end. |

### If time runs short, cut in this order

1. A skeleton body for the undead (the tinted humanoid stays).
2. The third lair (the mine or the motte's cellar); the crypt and the cave stay.
3. The end-of-slice summary window (P5), dedicated autumn music (the forest style stays).
4. Baked vertex AO, the world drawing switch's second half (G1 M: the stopgap stays).
5. The odd stress-test builds (B9) beyond the ranger.
6. The watermill's moving wheel (a still wheel stays), then the grove's guardian.
7. The grove, then the inn, then the lodge (the user wants them all; last resort).
8. Texture compression (G3), unless the soak shows memory is the problem.

Never cut: the intro chain, a boss in each lair, the curves and the duel tool, saving, the soak.

## 7. Open questions for the user

Decided questions (seed, second dungeon, the new features, level gradient, cells, lairs, the sheepfold,
the new kinds) are in section 0 and 3c.

1. **What level at the end?** The plan says 10 (about 21,000 XP). Lower (8) makes the curve gentler and
   needs less content; higher needs more quests and more skills.
2. **Which class to tune first?** Warrior first (simplest numbers), then the rest checked by the duel
   tool; or all four at once, with the ranger as the stress test from the start?
3. **The third lair.** The old camp's mine (from the crypt's kit), the motte's cellar, or only two lairs?
4. **Level-up points.** Which is the slice's default, spent by the player or automatic?
5. **Undead bodies.** Tinted humanoids are fine for the slice, or a real skeleton?
6. **Icons.** When may the generator run for the new items, and when do you want to pick the four waiting
   icons in `review.py`?
7. **Terrain lights.** Do torches and campfires flicker on the terrain, or stay steady?
8. **The inn camera clipping.** A spot where it reproduces, please.
9. **The curve values.** The table in 3a is a set of guesses; the numbers (time to kill, time to die,
   prices, sell rate) are yours to overwrite.
10. **The giant.** A scaled-up humanoid as the grove's rare elite: does it also appear elsewhere (the motte, a cave)? How tall, and with what weapon?
11. **Icons per type or per item?** About 230 generated items cannot each have a picked icon: an icon per item type and slot (about 40) with the tier shown by a border or tint, or something else? (Section 8, GPU windows.)

## 8. Sessions: how the work is divided

The plan is ready (the user, 2026-11-20). This section says how to cut it into sessions, what runs at
the same time, and what waits for the user or the GPU. **No session is started by this document**; each
wave is started when the user says so.

### Rules for every session

- **One session, one lane.** A session owns a set of files; two sessions never own the same file (the
  conflict list is at the end of this section). Sessions that write code each get **their own worktree
  and branch**, rebased on master before they are merged.
- **The brief** names: the task IDs here, the docs to read first (the ones the task cites), the files it
  owns, what "done" is (a probe or bot run that passes, and the "you can see this" of its milestone), and
  that it commits only its own files and updates the doc of the feature as built.
- **Cap at about six sessions at a time**, so the user can follow and merges stay easy. Start the
  critical path first (B6), then fill free slots from the next list.
- **Nothing starts on the GPU without the user.** See "GPU windows".

### GPU windows (the slow things that wait for the user)

ComfyUI and the real GPU are used by concept images, icons and the measurements, and the user may be
gaming, so these run in **windows the user opens**. Sessions do the preparation with no GPU, so a window
is one command and a review.

| Work | Prepared without GPU | In the window | Then |
|---|---|---|---|
| **Concept images** (CONCEPTS.md: about a minute an image, three per subject) for the new features and kinds: abandoned camp, motte, grove, watermill, cave mouth yard, roadside camp, sheepfold; the giant, sheep, bats, cave bear, undead variants | A prompt file per subject (the lodge's concepts are the model); **done before the feature's geometry starts**, so W3, W4, W5, W13, W16 wait for their images | One batch run of about 12 subjects (about 40 images, about 40 minutes) | The user glances at the sheets; the feature session reads the notes |
| **Icons**: the four waiting (torch, bandage, iron ingot, spell scroll) and the new items | A list of what needs an icon, from the item layout (I8); the review sheet (`review.py`) | One run per batch; the four waiting icons can be picked **now** with no generation | The user picks in `review.py` |
| **Measurements**: G6 ambient occlusion cost, the G2 soak, the G3 texture gain, G9/G10 frame costs | The probe or bot, written | The run itself, on the real GPU | Numbers into the doc |

**A decision to make before the icon batch:** about 230 generated items cannot each have a picked icon.
Proposal: an icon per item *type and slot* (about 40), with the tier shown by a border or tint colour from
the curve, so the batch is about 40 images, not 230. (Open question 11.)

### The waves

A wave starts when its predecessors' sessions are merged, or earlier where the "needs" in section 4 say a
task does not depend on it.

**Wave 1: start at once (nothing needs anything else).** The first six are the priority; the others fill
slots as they free.

| # | Session | Tasks | Owns (files) | Notes |
|---|---|---|---|---|
| 1 | **Balance core** (critical path) | B6 (with B1's targets) | `rules/balance.json5`, the resolver, creature and item resolve | Needs the curve list agreed with the user at the start: the table in 3a is the start. Everything numeric waits for it. |
| 2 | **The slice world** | W1, W9, then B2 | `dimensions/`, `cells/config.ts`, `worldLayout.ts`, the level resolve (B2 touches `resolveCreatureRules`, so after session 1's resolver lands) | Menu entry and the first look at the vale. |
| 3 | **Shore hills** | W15 | `terrain/boundaryHills/`, `areaField.ts`, the biome's data | Touches `areaField.ts`; session 2 does not. |
| 4 | **Water** | G1 stopgap first, then W10, then W11 | `water.ts`, `terrain/ocean.ts`, `terrain/rivers/`, `cells/river*.ts`, the water shader | The stopgap (ocean off underground) is its first hour; the real G1 switch waits. |
| 5 | **Creature brain rules** | E8's first half: tactic opening delay, crowd-control rules, immunity; the spider fix | `sim/creatures/brain.ts`, `rules/creatures.json5` | Needs no curves. The roles half waits for B6 (Wave 2). |
| 6 | **Abandoned camp** | W3 (needs its concept images) | `compound.ts`, the features pack, condition code | First of the **feature lane** (W3, then W16, then W4: they share `compound.ts`). |
| 7 | **Ambience and sound** | P7 | `src/audio`, `sounds/`, `music/` | Wind, birds, rain, drips, water; lair music. |
| 8 | **Autumn look** | G4 | `src/particles`, `weather/`, the biome's look | Leaves, smoke from chimneys, golden hour. |
| 9 | **Grove** | W5 (needs concepts) | `foliage/`, trees kinds, the grove feature | Own lane; later the watermill (W13) joins it. |
| 10 | **Cave check** | E6: walk the cave style built by the parallel session; the lairs' boss, chests, spawns; step 7 for both lairs | `dungeons/`, `dungeonParts`, `dungeonStyles/` | Reports what is missing for the cave lair. |
| 11 | **Regeneration** | I9 | `rules/`, resources | A small one, early. |
| 12 | **Small visual checks** | G7 (rain in the inn), G8 (lights check) | `weather/`, `lighting/` | G6 waits for a GPU window. |
| 13 | **Concept and icon preparation** | The prompt files and the review sheet (no GPU) | `assets_work/comfyUI/` | So the first GPU window can run. |

**Wave 2: after the curves (B6) lands.**

| # | Session | Tasks | Owns | Notes |
|---|---|---|---|---|
| 14 | **Defence** | B8 | `rules/combat.json5`, `sim/skills/combat.ts` | Parts first (armour stays the default). |
| 15 | **Duel tool** | B7 | `scripts/`, a new `sim/duel` | Starts when B8's parts are in, or beside it reading them. |
| 16 | **Skill bank** | I6, then I7 (level-up stats) and P9 | `skills/`, `rules/`, the progression UI | The generator and the tags. |
| 17 | **Item generation** | I8, then I1 (loot, gold, prices) | `items/`, `itemTemplates/`, `lootTables/`, `vendorStocks/` | One session: the layout and the loot are the same files. |
| 18 | **Creature roles** | E8's second half, E9 (encounter curves), E12 (features declare creatures) | `creatures/`, `camps/`, the spawn code | After session 5. |
| 19 | **Quest curves** | E10 | `rules/quests.json5`, quest generation | After 17 for the reward pool. |
| 20 | **Lights on terrain** | G10 | `lighting/`, `litShading`, skill effects (a `light` field) | Parallel with all of the above; touches shaders only. |
| 21 | **The real drawing switch** | G1 (M) | `world.ts`, the draw loops | After the water session (it edits `world.ts` and the ocean). |

**Wave 3: places, kinds, classes, quests.**

| # | Session | Tasks | Owns | Notes |
|---|---|---|---|---|
| 22 | **Cave mouth yard** | W16 | `compound.ts`, features pack | After W3 in the feature lane. |
| 23 | **Motte and bailey** | W4, E7 (the garrison) | `compound.ts`, terrain stamp "mound" | After W16; the largest feature. |
| 24 | **Watermill** | W13 | props, a new moving part | After the water session and W11. |
| 25 | **Roadside camp and sheepfold** | E7 (roadside), W8, the sheepfold's entry | `camps/`, `features/sheepfold.json5` | With E12 from session 18. |
| 26-28 | **New kinds**, three sessions | E11: (a) sheep and the flock; (b) bandit archer, war dog, the undead variants; (c) bats, cave spider, cave bear, the giant | `creatures/`, bodies | One at a time per `creatures/` unless on worktrees; bodies need their concept images. |
| 29-32 | **Classes**, one session each | I2: warrior, mage, priest, ranger (+ B9's stress builds) | `origins/`, `skills/<class>` | After 14, 15, 16; the ranger last and used as the stress test. |
| 33-35 | **Quests**, three sessions | E4: (a) camp and lodge; (b) the old camp chain; (c) the lairs, motte, grove and mill | `questPlots/`, `questSegments/`, text | One at a time (shared files), each right after its place. |
| 36 | **NPC life** | E5 | `npcs/`, roles | With the quests. |
| 37 | **The cell plan** | W14, then W2 (the seed), W6 (roads, shrines), W7 | the slice dimension, roads | After every place exists. |

**Wave 4: finish.**

| # | Session | Tasks | Notes |
|---|---|---|---|
| 38 | **Options menu** | G9 | Its constants hunt touches many files, so it runs when few others are open. |
| 39 | **Texture compression** | G3 | Touches the materials and baking; runs alone in the render lane, after the feature looks settle. |
| 40 | **Trainer, vendors, front end** | P2, P3, P5 | After the skills, items and world are in. |
| 41 | **Bot and tuning** | B3, E3, B4, B5 | The route bot, then rounds of tuning with the duel tool. |
| 42 | **Soak, saving, death** | G2, P6, P4, I5, P1 (with a repro spot from the user) | Last, when the world is as heavy as it will be; GPU window for G2. |
| 43 | **The final run** | The user's own run, fixes from it | The milestone M7. |

### What can run at once, in short

- **Day one:** sessions 1-6 (and 7-13 as slots free). The world, the curves, the water, the shore hills,
  the spider fix and the first feature are all independent.
- **Always parallel with anything:** sound (7), autumn look (8), lights on terrain (20), regeneration
  (11), concept and icon preparation (13), the cave check (10).
- **One lane, in order:** the three features sharing `compound.ts` (W3, then W16, then W4); the quests
  (E4 a, b, c); the new kinds if on one tree.
- **Waiting on the user, not on code:** the curve list (before 1), concept batches (before the features),
  icon picks, the GPU measurements, the inn clipping spot, the open questions in section 7.

### Where two sessions would touch the same file (do not overlap)

| Files | Sessions |
|---|---|
| `compound.ts` and the features pack | W3, W16, W4 (and the roadside camp, sheepfold) |
| `rules/` and the resolver | B6, E8, I6, I7, E10 (after B6 lands they work on separate files in it) |
| `items/`, `skills/`, `lootTables/` | I8/I1, I6, I2 (four classes), E11's loot |
| `questPlots/`, `questSegments/` | E4 a, b, c |
| `world.ts`, `terrain/ocean.ts` | the water stopgap and W10, then G1 |
| `creatures/` and bodies | E11 a, b, c, E12 |
| materials and baking | G3, G5 looks, G10's shader edits |

## 9. Progress log

### Wave 1, sessions 1-5 (merged to master, 2026-11-21)

| # | Session | Result | Where it is documented |
|---|---|---|---|
| 1 | Balance core (B6) | `rules/balance.json5` (the agreed curves), the resolver `src/sim/rules/balanceRules.ts`, all 13 creature species on roles, loot money and generated item prices from the curves. `npm run probe -- scripts/probe/balance.mjs`: 428/428. | BALANCE.md |
| 2 | The slice world (W1, W9) | The autumn vale: `dimensions/autumnVale.json5` (one zone, 14 cells), `cellsPerArea` per world shape, `public/configs/vale.json5`, a "The Autumn Vale" menu entry, `scripts/probe/vale.mjs`. Then (2026-11-21) **B2**: levels by cell (curve `cellLevel`, 1-2 by the village to 9-10 at the far side), and the vale turned on shore hills, `coastWobble: 1`, two rivers at their own level with a tributary. | DIMENSIONS.md, CONFIG.md, CREATURES.md |
| 3 | Shore hills (W15) | Mountains along a one-zone island's coast, on land grown out over the sea, parting for bays. Off by default; a world turns them on with `coastWobble: 1, shoreHills: true` (now in the vale's dimension file; looked at over 8 seeds with `vale.mjs map=`). | CONFIG.md |
| 4 | Water (G1 stopgap, W10, W11) | Ocean plane off while underground (the stopgap). Rivers at their own level (opt-in `riverLevels`), tributaries, fords, springs, water drawn above the sea, the ocean cut away under rivers; every biome's waterline rules read `aboveWater`. The real G1 drawing switch is still to do. Known gap: the river-sea seam (WATER.md). | WATER.md |
| 5 | Creature brain rules (E8, first half) | Tactics' opening delay, crowd-control rules (never first, not twice in a row, immunity after), the spider's web after 4 s. | CREATURES.md |

Merge notes: the merge needed three hand resolutions where sessions touched the same lines
(`creatureRules.ts` took both the balance and the config parameters; `worldConfig.ts` and `areaField.ts`
took the vale's `cellsPerArea`, the shore hills' `coastWobble`/`shoreHills` and the water's
`riverLevels`/`riverTributaries`/`riverField`).

Checks after the merge: balance 428/428, quests 448/448, items 129/129, vale ok, creatures 97/99 (the
hunting bot's two checks fail on master too), navigation 1506/1507 (one failure: "houses: the wolf goes in
and up the stairs to the player" - not yet traced, may be from the balance or brain changes).

Next from this wave: B2 (slice world session), add the shore hills settings to the vale and look at it, the
real G1 switch, then the wave 2 sessions (section 8) now that the curves exist.

### G4 as built (autumn look, 2026-11-21, branch `claude/slice-autumn-9c8327`)

- **Falling leaves**: a third air layer in `src/world/weather/precipitation.ts`, beside rain and snow (the same trick: a box
  about the camera, places worked out in the vertex shader from seed and clock, one draw call). 2600 leaves, each a
  tumbling pointed oval (turns, flips edge-on, sways wide), coloured crimson / orange / gold / russet from its seed, lit by
  the day's light, blown by the wind. A biome says how thick with `fallingLeaves` (0-1, default 0; autumnWood 0.75); the
  world blends it by the areas' weights, rain and snow put it out, wind stirs it (`world.ts` `updateWeather`).
  (Not `src/particles`: the CPU pool is for effects with owners; an ambient layer round the camera is the weather's job.)
  **Only under trees**: each leaf reads the tree cover of the ground beneath it from a 32 x 32 grid (1.5 m cells) laid about
  the player, two rows a frame, re-laid when the player strays 4 m (`coverAt` in `createPrecipitation`; world.ts passes
  `createTreeCover`). Cover 0 in the village squares, 0.5-1 in the wood (checked headless, `scripts/probe/leafCover.local.mjs`);
  the mask is `smoothstep(0.25, 0.65, cover)`. Cover is a density, not the trees themselves, so a leaf may fall between two trunks.
- **Chimney smoke**: `smoke` on a chimney part (`stoneChimney`, `bigChimney`) names a looping effect, laid as a model
  effect on the stack top by `houseGenerator.ts` in near models only, and only where a hearth room is behind the chimney
  (a house with no interior: always). It runs through the existing flame manager, so it shares its distance slider and cap.
  New effects `particles/smoke.chimney.json5` (thin pale plume) and `smoke.camp.json5` (the campfire prop's `extra`).
- **Golden hour and weather**: autumnWood's `light` gets a lower sun (peak 34), honey `sunZenith`, amber `sunHorizon`, a warm
  fill; and its own weather odds (mostly fair and clear, some cloud, mist, drizzle, a gale). Data only, no shader touched.
- **Cost**: leaves are 5200 triangles in one vertex-shader draw; the CPU side is five uniform sets a frame. In the vale in the
  Browser pane (software-rendered, about 35 ms a frame) leaves on versus off was inside the noise (+-3 ms over 120 frames);
  no GPU measurement was made. Chimney smoke is about 12 live sprites per chimney within the flame distance.
- Not done: smoke from the logging camp's and the lodge's smokehouse (no chimney part there), wood smoke leaning with the wind.

### Wave 1, slot 7: ambience and sound (P7)

Ambience on its own bus in `src/audio/ambience.ts` (levels in `ambienceMix.ts`, fed from `feedback.ts`):
wind and dry leaves, rain, a river or pond within 38 m, birds by day and an owl by night, a cave's drips
and room tone, a crypt's drone; indoors dulls it. New music styles `crypt` and `lair` (boss room), picked
from `dungeon.where`. Touched outside `src/audio` and `src/music`, minimally: `world.ts` (two getters),
`dungeonPresence.ts` (`where`), `session.ts` and `feedback.ts` (the wiring). Checked:
`npm run probe -- scripts/probe/ambience.mjs` 0 failed, and an offline render in `?play`. Not done: rain
was not heard on speakers, no sound for snow or mist. Documented in MUSIC.md.

### Answers to section 7 (the user, 2026-11-21)

- **Q2, class order:** warrior, then ranger, mage, priest.
- **Q4, level-up points:** automatic, for the slice.
- **Q11, icons:** one icon per item type for the slice (no per-tier or per-item variety); more icon variety belongs to vertical slice 2.
- Wave 1 is to be finished before wave 2 starts.
- **Q3, the third lair (the user, 2026-11-21):** a **mine**, as a variant of the cave style: it needs
  timber supports, mining props (picks, carts, rails, ore) and lanterns. Not yet planned into a session;
  it belongs to the dungeon lane after the cave check (E6).
