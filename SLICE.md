# The vertical slice

The plan for the next goal: **one starting zone, the autumn wood, finished like a small game.** A
single-player session of about two hours, for the user only (no onboarding, no public demo polish).
**Status: plan, waiting for the user's approval. Nothing here is built.**

Sizes: **S** under a day for one session, **M** about a day, **L** several days or several
sessions. "Parallel" means it can run as its own session without touching another task's files.
The state of the code was checked on 2026-11-19; where a doc and the code disagree, the code is
what is written here.

## 1. What "done" means

You make a new character in the menu, drop onto the square of a wood village, and play for two
hours without hitting a wall, a bug you have to work round, or a stretch with nothing to do. At the
end you stand somewhere worth standing, a few levels up, with gear you earned.

### The two hours

| When | What happens | Level |
|---|---|---|
| 0:00-0:10 | **Arrival.** The square of the start village, the inn, the class trainer, the dummy and the chest. First fight with the dummy, first skills learned. | 1 |
| 0:10-0:35 | **The intro chain** (`welcome`, `affliction`, `roadOn`, already built): the sickness in the village, herbs and wolf pelts from the wood around it, the salve; then a letter carried down the road to the second settlement. First real fights (wolves, boars), first loot, first gear from a quest. | 1-4 |
| 0:35-1:05 | **The wood opens.** The second settlement is the hub: shops, a trainer, a board of quests. The coaching inn on the road (rest, vendor, rumours), the logging camp (wolves are killing loggers), the hunting lodge (pelts, a bear). Three or four side quests run side by side; the player picks. | 4-7 |
| 1:05-1:30 | **The old camp.** The abandoned logging camp is the wood's mystery: a chain of four quests that ends in the crypt-kit mine or the crypt. Spiders, grave robbers, the dead. | 7-8 |
| 1:30-1:50 | **The big fights.** The churchyard crypt (a real dungeon: stair down, loops, a locked door, a boss hall). The motte and bailey: the bandit chief, in the open with adds. One of the two is the quest chain's end, the other optional. | 8-10 |
| 1:50-2:00 | **The grove.** The druid grove on a rise: a vista over the whole wood, a quiet reward (a skill book or a trinket), music changes. The end of the slice. | 10 |

At the end the player owns: level 10 (about 21,000 XP: see section 3f), a full set of green or blue
gear for their class from quests and the two bosses, about 6-8 learned skills and 3-4 talent
points spent, a bag of consumables, some money, and a log of about 14 finished quests.

### The quality bar, per category

| Category | The bar |
|---|---|
| Graphics tech | 60 fps at the default draw distance on the user's GPU in the village, the deepest wood, the crypt and the motte. The page does not grow past the budget in a two-hour soak (no crash, no stutter spikes). Nothing visibly wrong when looked at from the places the player actually stands: no ocean in a crypt, no rain in the inn, no flat grey props. |
| World generation | The zone is one piece of land with all eight features on it, roads between them, readable as an autumn wood from any hill (colour, falling leaves, smoke from the places people live in). The same seed always gives the same zone. |
| Gameplay elements | Every window the slice needs works and is not annoying: trainer, vendor, inventory, quest log, map. Death sends you home with a small cost. Saving and loading in the middle of a quest, or in a dungeon, brings you back where you were. Sound is never silent. |
| Enemies and quests | The wood has its own enemies, each with a body and one thing that makes it different to fight. At least 12 quests (intro 3 included), no two the same shape back to back, two bosses with their own tactics. |
| Items and skills | Every level band brings a visible upgrade; every class has something new to press every one or two levels; no useless drops that look broken (no icon, no stats). |
| Balance | A bot playing the route reaches the end in about two hours of play time, level 10 plus or minus one, dying no more than a few times. The user's own run agrees. |

## 2. The eight features

### What can roll in the autumn wood today

`autumnWood.json5` lists, as **weights** (not chances), per cell: settlement 0.8, coaching inn 0.5,
logging camp 0.6, hunting lodge 0.4, churchyard 0.3, nothing 0.8. A zone is 10 cells
(`CELLS_PER_AREA`), about 2.5 km2 at `CELL_SPACING` 500, and **each cell rolls one feature on its
own**. So nothing is guaranteed: a seed may give three villages and no crypt. Placement can also
fail (a camp wants gentle ground deep in a wood) and leave its cell empty.

| Feature | Built? | State |
|---|---|---|
| Settlement (farm village, market town) | yes | Many houses, inn, chapel, smithy, NPC cast and generated quests. The start is chosen among them. |
| Coaching inn (roadside compound) | yes, first pass | On a road, stables. What is left is in designers/coaching-inn.md. |
| Logging camp | yes | Bunkhouse, saw shed, cookhouse, stable, tool shed, skid trail, stumps. |
| Hunting lodge | yes, revived | Props-only materials, tube-built antlers and deer, smokehouse. Its "not done / to judge" list is in LODGE.md. |
| Churchyard with crypt | yes | Chapel, graves, wall; mausoleums whose way down opens a generated crypt (seamless, creatures, lit). |
| Sheepfold | built, but in **no biome list** | A moor and fell kind; leave it out of the wood. |
| Abandoned camp, motte, grove, charcoal burners, sawmill, alchemist, shrine, tower | **no** | See below. There is no condition (decay) system in the code at all. |

### The proposed ten (first eight, then two added with the user)

Chosen by fun per cost from FEATURES.md and by what makes the wood read as itself. Five exist; three
are new, and the last two (the roadside bandit camp, the watermill) were added in the world generation talk. The zone has ten cells and **none is left empty** (see "The cells problem" below).

| # | Feature | Cost (FEATURES.md) | Why | What it gives the two hours |
|---|---|---|---|---|
| 1 | **Start village + a second settlement** (farm village, market town) | exists | The home and the hub. The roadOn letter needs a second settlement to go to. | Arrival, the intro chain, the first hub, trainer, shops, bank. |
| 2 | **Logging camp** | exists | The wood's own industry; stumps and log piles say "wood" at once. | A quest hub (loggers, wolves, a missing foreman), a fight, a vendor of tools and bread. |
| 3 | **Hunting lodge** | exists | Needs a hunter and a reason: the wood's game. | Pelt and hunting quests, the bear, a vendor of leather, a forester NPC. |
| 4 | **Coaching inn** | exists | The road made real; a stop between hubs. | Rest, set home, rumours (a quest start for the old camp), a vendor of food and potions. |
| 5 | **Churchyard and crypt** | exists | A real dungeon is the slice's biggest set piece, and it is the one already built. | Dungeon 1: the stair, loops, a locked door, the boss. Chests. The best loot of the middle. |
| 6 | **Abandoned logging camp** | 3 (fun 5) | The same camp given up: roofs sagging, the yard greening, no fire. It is the wood's signature story place, and reuses the camp's buildings and props. | The mystery chain, a hostile place (spiders, bandits or the dead), a small dungeon mouth or a mini-boss, a reward. |
| 7 | **Motte and bailey** | 2 (fun 4) | A bandit stronghold on a mound with a ditch and a palisade: the open-air boss fight, and a place you see from afar. | Boss 2 (the bandit chief) with adds, a bandit camp quest, a rescue or recovery quest, good loot. Shares the mound stamp with charcoal burners. |
| 8 | **Druid grove** | 2 (fun 4) | A ring of huge old trees round a stone: autumn's quiet, a counterpoint to the fights. Trees are the thing the zone is known by. | The vista, a rare herb or a book, the end of the slice, optional guardian. Needs a new "ancient" tree kind. |
| 9 | **Roadside bandit camp** | S | The first human fight, before the motte's garrison: tents, a fire, a chest, a lookout, on the road. The `banditCamp` creature camp already exists with no place. | A combat quest, bandit loot, the road made dangerous. Task E7. |
| 10 | **Watermill with a mill pond** | S-M | The autumn wood is on its FEATURES.md list. Needs the new river and pond water (W10). **The animated-part test**: a turning wheel is FEATURES.md piece 9 ("turning wheels and sails"), built for nothing yet, so the mill shows whether a prop can move (a part that rotates on an axis, driven by the water's flow, still when the wheel is stopped by a quest). | A miller NPC, "the lost shipment" place, a pool to swim in, a vendor of flour and bread. |
| 11 | **Cave mouth with its surroundings** (a lair's entrance as a feature of its own) | M | The cave is not only a hole: outside it, a place. Small buildings (a hut, a lean-to, a shed or two), props (crates, a cart, a fire, bones, a drying rack, a signpost), and the enemies who live there, so the way in is a small fight and a story before the dark. DUNGEONS.md step 7 ("Around it") covers quest blocks, floors on the map, music, the player's light and daylight through the mouth, but not an entrance yard, so it is new work; the features system (`features/*.json5`, compounds, camps) is the way to build it. Works for any lair entrance, the crypt's churchyard included; the cave version is the new one. | The approach fight, a vendor or a quest giver outside, a reason to go in. |

**All eleven are in the slice** (decided with the user: "we need to show off a little", and no empty
cells). Not all of the *current* features had to be; these are the ones chosen. The tiers stay only as
the order of cutting if time runs short (section 5): the grove goes first, then the inn, the lodge and
the watermill; the core stays: the villages, the logging camp, the churchyard and crypt, the cave mouth,
the roadside bandit camp and the motte, with the abandoned camp's mystery chain beside them.

**The cells problem.** The zone had **10 cells** and each cell rolls one feature. The eleven features are **two
settlements and ten other sites: twelve places**. Decided with the user: **more cells** (task W9, 14
for the slice zone), so each place can have its own and few cells are empty. Task W14 lays them out.

**Cheap fillers, not counted:** wayside shrines (cost 1, no new piece: a cairn with a small heal or a
set-home) along the roads; a watchtower on a hill (cost 1) if the zone feels short of vistas. **First
cuts if time runs short:** charcoal burners, sawmill, alchemist, watchtower. The sawmill needs
waterside placement and a turning wheel; the alchemist needs coloured smoke: neither is cheap
enough for what it adds.

**An open decision, in section 6:** the **second dungeon**. See task E6.

**Feature candidates raised in the world generation talk (2026-11-20; the user asked for help choosing):**

| Candidate | Cost | Why for the slice |
|---|---|---|
| **Roadside bandit camp** (the `banditCamp` creature camp already exists, with no place) | S | The user wants bandits: a small camp on the road is the first human fight, before the motte's garrison. Tents, a fire, a chest, a lookout. Task E7. |
| **Watermill with a mill pond** | S-M | FEATURES.md lists it for the autumn wood. Needs the new river and pond water (W10), and shows it off: a wheel, a race, a pool. A quest place ("the lost shipment"). |
| **Toll bridge or ford with a hut** | S | A road crossing a river is a natural meeting and ambush place, and the river is the new work. |
| **Cave pool** | S | The cave lair with its own still pool underground (W10's third kind of water). |
| **Wayside shrines, a ruined watchtower** | 1 | Already cheap fillers. |

My recommendation: the eight stay, **add the roadside bandit camp and the watermill** (the first
because the user asked for bandits, the second because it earns the water work); the toll bridge is
free if a road meets a river; the cave pool comes with the cave lair.

## 3. Tasks by category

IDs are used in the dependencies. "Par." is whether the task can run as its own session in parallel.

### (a) Graphics tech

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| G1 | **World / dungeon drawing switch.** Stopgap first (S): turn the ocean plane off while `sunLighting.underground` is on (ocean.ts and world.ts have no underground handling at all; the sky and fog fade, the ocean does not). Then the real switch (M): underground, skip drawing the terrain chunks, trees, grass, buildings, and the sun shadow pass; restore them on the way out. It is also a frame-time and memory win in the dungeons. | S + M | - | yes |
| G2 | **Performance and memory budget.** Set targets (60 fps, a page heap ceiling, GPU memory), build a soak: a bot or camera path through the village, the deep wood, the crypt and the motte for 30 / 60 / 120 minutes, logging heap and frame time. Fix what it shows (page-memory traps, shadow casters past the shadow's reach, the tree buffer rebuild: see BACKLOG.md). The slice world is one biome, so it loads far less than the full 25-biome world. | M | W1 | yes |
| G3 | **Texture compression** (TEXTURES.md, a plan only: nothing compressed today; the buildings' array alone is ~280 MB of GPU memory). **Wanted by the user, not conditional** (decided): it is the scalability story for weaker GPUs too (the options menu, G9, offers lower texture sizes). Phase it as TEXTURES.md does, the biggest first (the buildings' array, then the ground's). | L | G2 (to measure the gain) | yes |
| G4 | **Autumn look.** Falling leaves as an air particle layer (the particle system in `src/particles` exists), smoke from the chimneys of lived-in houses and the camps' fires (PROP_EFFECTS has flames; smoke is `smoke.torch` only), the weather set for the zone (fair, cloudy, drizzle, mist, rain: all exist), golden-hour tuning. Wind in trees exists. | M | - | yes |
| G5 | **Prop look pass per feature.** Props-only materials exist (PROP_RENDERING steps 1-4 and 6 built; step 5 parked). Each new or revived feature gets a look pass in the workbench, the way the lodge did (LODGE.md's open list). Part of each feature's own task (W3-W5), listed here so it is not forgotten. | S each | the feature | with the feature |
| G6 | **Ambient occlusion decision.** SSAO2 is in the game with a toggle and sliders (default on); its frame cost has never been measured on the real GPU. Measure, pick the default. Baked vertex AO for dungeon parts and buildings stays a stretch. | S | - | yes |
| G7 | **Rain and snow inside buildings** (BACKLOG.md): it rains through the inn's ceiling. Cheapest fix: fade the fall out while the camera is in an enterable house. | S | - | yes |
| G8 | **Lights.** Windows' daylight and lamps exist in the baker; check that the village at dusk and the camp's fire read in the game (not only the workbench). Night is "decoration", so one pass, no more. | S | - | yes |
| G9 | **A real options menu with scalability.** Today the options window holds a debug-style panel (`debug/settingsPanel.ts`, wired in `game/dimensionView.ts`): draw distance, trees, grass, shadows, ambient occlusion with two sliders, flame distance, field of view, plus developer switches (wireframe, spectator, dimension, time, weather). Make it a player's menu of **sliders, no presets** (decided: presets are not needed). The sliders are for **the things that make the game slow and are constants today**: draw distance, entity and creature distance (how far they are simulated and drawn), terrain LOD distances and detail, other LOD settings (trees, grass, buildings, props), shadow resolution, distance and cascades, ambient occlusion, texture quality (through G3), render scale (Babylon's `engine.setHardwareScalingLevel`, which only resizes the canvas, so it works with our forward renderer; the HTML interface stays sharp), particle amount, how many dynamic lights (G10), flame distance, field of view, frame-rate cap. The task starts with a **hunt for those constants** (grep for the hard-coded distances, counts and sizes in the world, entity and render code) and each found one becomes a setting with its default unchanged. Saved in the browser, applied live where possible. The developer switches move to a separate panel. | M | G3, G10 for their settings | yes |
| G10 | **Lights on terrain** (LIGHTS.md, *Outdoors*, phase 6, a plan so far): fires, torches and lanterns light the ground, grass and trees round them, not only the player and the inside of houses. **Dynamic, decided with the user**: the lights are not baked, so **a spell can light the terrain** (a fireball in flight, a flame on the ground, a torch carried by a creature or a player). The plan: a runtime list of the few nearest lights (position, colour, strength, radius, flicker, an expiry), fed each frame by props with a `light` and by the skill system's effects, goes into the shared lighting block `LIT_SHADING_GLSL`, unshadowed (outdoors there is little to shine through); the count is a slider (G9). A spell or effect gets a `light` field the same way a prop does. A house's own bake still takes in the static outdoor lights near it. Slice use: the logging camp's fires, the lodge's fire, lanterns in the village and at the inn, torches at a lair's mouth, the motte's braziers, fire and frost spells. Measure the frame cost at night in the village and in a fight with many casts. | M | G2 | yes |

### (b) World generation

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| W1 | **The slice world.** A new dimension (`dimensions/autumnVale.json5`) or config with only `autumnWood`, one zone, a start rule that picks the farm village, mountains round it (`borderType: "mountain"` already). Menu entry that goes to it (see P5). Confirm one zone is one walkable piece of land (the BACKLOG "cells cut off by cliffs" artefact would be fatal inside the one zone). | S-M | - | yes |
| W2 | **The seed.** Because the odds are weights, no seed promises the eight features. The cheap answer for a single-player slice: **scan seeds** with a probe that scores each one (all eight present, village and hamlet within reach by road, the crypt not far from the start, enough relief for the grove and the motte, no hole in the roads), then **pin the best**. A guaranteed-features rule in the biome (a "once" flag per entry) only if no seed scores. | S (scan) / M (rule) | W3-W5 | yes |
| W3 | **Abandoned logging camp.** A first condition system, scoped small: a compound option `condition: abandoned` that swaps its buildings for worn versions (a missing roof section, a fallen wall, no fire or lamp), greens the yard, grows birch and rowan back over the felling, rots the logs. Condition is a general piece (FEATURES.md piece 2) but the cost estimate there is for the camp's own kind only. | M | - | yes |
| W4 | **Motte and bailey.** The terrain stamp "mound" (and a ditch) is new and shared with the charcoal burners; a palisade (line prop: exists as the rail fence's relative), a wooden keep with an interior and a stair (the house generator does this), the bailey yard (polygon yards exist for compound rings, commit 01b3535), a gate toward the road, a camp of tents. | L | - | yes |
| W5 | **Druid grove.** A new ancient tree kind (huge, gnarled, the zone's trees generator has a wide range), a ring layout of them (needs "round and tall shapes" in a small form: placing N trees on a circle is only data), a standing stone prop, a clearing and a little ground paint. | M | - | yes |
| W6 | **Roads and wayside shrines.** The road network exists with bridges. Check the eight sites are linked by roads (BACKLOG: some sites unreachable), add the shrines as a cheap line of props. Fingerposts exist. | S | W2 | no |
| W7 | **Settlement variety.** The wood only rolls `farmVillage` and `marketTown`. Enough for a start village and a hub; look pass only (orchards, a drystone wall?). The settlement probe should show two distinguishable places. | S | W2 | yes |
| W8 | **Biome odds.** After the seed is pinned: leave the biome odds as they are (the game still has this biome in the full world), and put the slice's list in the dimension or config. The sheepfold stays out of the wood. | S | W1 | no |
| W9 | **Zone size: more cells, same cell size** (decided with the user). `CELL_SPACING` stays 500 (commit 42c36a8 halved it from 1000). The slice zone gets **more cells**: `CELLS_PER_AREA` is a global constant (10, `cells/config.ts`, used by `worldLayout.ts`), so make it a **per-zone setting** (the dimension or world config, default 10, so the full world does not change) and give the slice **14** (decided). At 14 cells a zone is about 3.5 km2, 1.9 km across: a few more minutes' walk, room for twelve places and two stretches of plain wood. Check that world size and the area count derive correctly from the setting (`worldLayout.ts` multiplies area count by it). | S-M | W1 | yes |
| W10 | **Water at its own level.** Today every sea, lake, pond and river is a hollow of the ground filled to the one sea level (`water.ts`, `WATER_SURFACE`, one ocean plane, the terrain shader tints by depth against it), so a river can only run at sea level and a mountain lake cannot exist. Make **water bodies with their own surface**: *lakes and ponds* (a flat plane at their own height), *rivers* (a surface ribbon that follows the river's centreline and steps down with the bed, so a river runs down a valley and meets the sea), the *ocean* as it is, and *a pool in a cave* (a flat plane inside a cave part). `waterAt(x, z)` returns the surface of the body at that point, so swimming, breath, creature avoidance and sound keep working (WATER.md, "left for later" already names a lake above the sea). Drawing: the water shader's reflection and glint on each body; the shore tint moves from the global sea level to the body's. To check: the river carving in `terrain/rivers` and `cells/river*.ts` already knows each river's depth, which is the likely source of the surface. | L | - | yes |
| W11 | **Rivers in the slice zone.** The world draws 3-5 rivers a continent and BACKLOG.md wants them per zone, by biome. The slice needs a river through the zone, at least one bridge on a road, a ford or two, and ideally a branching tributary, so most walks meet water. Shares the river code with W10. | M | W10 | with W10 |
| W12 | **Wood-specific tweaks (the user's list, to grow).** A running list of small world fixes the user will give while looking at the wood: kept here as one task with a checklist, to be sorted into sessions. | S each | - | yes |
| W13 | **Watermill with a mill pond, and its turning wheel.** The building (a mill house over a race, a pond behind a small weir) is a compound and props. **The new piece is the animated part**: a prop part that turns about an axis (FEATURES.md piece 9, "turning wheels and sails"; today props only have flames and smoke as effects), driven by a speed, stopped when the wheel is stopped, culled at distance. Built as a general "moving part" so a windmill's sails or a well's winch can use it later. Needs the pond and the river from W10 and W11. | M-L | W10, W11 | yes |
| W14 | **A cell plan: twelve places in 14 cells.** The odds are weights, and one cell rolls one feature, so even a scanned seed (W2) cannot be trusted to hold all twelve places. Proposal: the slice dimension carries an **authored plan**, a list of which feature goes in which cell (by distance from the start, which is also the level gradient of B2), so the world is arranged, not rolled; features still choose their own ground inside the cell. Each place gets one cell and two stay plain wood. The inn and the mill can also use the road and the river instead of a cell of their own, and the roadside bandit camp is on a road anyway. Replaces most of W2's seed scan (the seed is then only the look of the land). | M | W1, W3-W5, W10, W13 | after them |
| W15 | **Shore hills (a new generation feature).** One zone alone is an island: the mountains the biome asks for (`borderType: "mountain"`) are boundary hills, and they only rise **between two areas** (`areaBorderGap` is the distance to the nearest *other* area, `areaField.ts`; `terrainSampler.ts` adds the bump), so with one area there is nothing to rise. New: a **shore hill style**, the same kind of bump (the existing pipeline and `BoundaryHillStyle`: width, peak height, edge noise) but keyed on the **distance to the coast** (the landmass edge) instead of to another area, in a biome's data (`shoreHillStyle`, default none, so the full world does not change). The slice's autumn wood gets a **ring of mountains along its shore** with a noise mask that leaves a few **gaps** (a beach, a bay, a pass) so it is a valley with a sea view, not a sealed bowl. To handle: the coast blend (`landmass` blend to the seabed, roads cut through coastal hills were already a trap, WATER.md, *Roads*), settlement and feature sites keep off the steep ground (the sites' `grade` rules), the river and its valley fade the hill (`riverHillFade`), the cell plan keeps the villages inland, and the world's edge reads as mountains and sea from the middle. | M | W1 | yes |

### (c) Gameplay elements

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| P1 | **Camera and controls.** Both mouse buttons turn the camera, no inertia (done). Fix the **inn camera clipping**: reported, not reproduced in this check, so first a repro spot from the user, then the camera's collision against house walls. Nothing else new (no gamepad). | S | repro | yes |
| P2 | **Trainer window.** Today *Train* opens the general progression panel at that trainer (npcWindow.ts, `train`). A trainer's own list: skills available now, their cost, which are locked by level, one click to learn. | M | I2 | yes |
| P3 | **Vendors.** Buying, selling and repairing exist (vendorStocks: smith, general, inn). Slice work: a stock per place (lodge: leather and arrows, camp: tools, inn: food and potions, hub: gear of the level band) and prices that fit B2. | S | B2 | yes |
| P4 | **Death.** Respawn at home exists (set at the inn). Check that death in a crypt returns the player outside, that durability loss reads clearly, that nothing is lost for good. | S | - | yes |
| P5 | **Front end.** New-game flow into the slice: the menu, character creation, a saved slot. Menu world already exists. A "Finish" summary window at the end (optional, S). | S | W1 | yes |
| P6 | **Saving.** The save works (world delta, quests, belongings?). Check the cases that will happen in two hours: log out in the crypt, in the middle of a quest, with a cleared boss, reload at the one-hour point. | S | - | yes |
| P7 | **Sound.** There are cues (76) and sounds (104), and music per zone (the autumn wood plays the generic `forest` style). Missing: any **ambience** (wind, birds, leaf rustle, rain on leaves, crypt drips, the lodge's fire is there); the ambient bus exists, the ambience system does not. Also a music pass for the crypt and the boss. | M | - | yes |
| P8 | **Map.** Done (minimap, world map, markers for dungeon, inn, shop, trainer, quests). Slice work: a marker for each feature if one is missing. | S | W3-W5 | no |

### (d) Enemies and quests

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| E1 | **The wood's roster.** Wolf, boar, bear, spider, lynx, stag, bandit all list `autumnWood` as habitat, and wolf, boar, bear, spider, lynx, stag have beast bodies (BEASTS.md steps 1-6). The `groups` rule says single-only ("no packs for now"); **it stays that way in the slice (decided): no packs in the starting area.** Undead in the crypt are humanoids tinted bone-pale, no body of their own (a skeleton body is a cut candidate). | S | - | yes |
| E2 | **Behaviour and bosses.** Each kind one trick: wolves flee when hurt, boars charge, the bear hits hard and slow, spiders web (after a delay), bandits have a caster and a bruiser. Rare named elites tied to features (see the decisions below). **No boss phases** (decided): a boss is a stronger elite with a tactic set. The slice has 2-3 lairs: small caves or crypts with few rooms, each with a strong boss enemy. | M | - | yes |
| E3 | **The intro chain.** Built and probed (`quests.mjs`): `welcome`, `affliction`, `roadOn`. Check that it fits the first 35 minutes (time it with B3) and ends with the letter delivered in the hub. | S | B3 | after B3 |
| E4 | **Quest variety.** Today: 3 plots, 23 segments, 15 parts. The slice needs about 9 more quests tied to its places, not all "kill 8 X". Plots: *the missing foreman* (camp), *wolves at the sawpit* (camp), *a bear for the lodge*, *the grey pilgrim* (churchyard, reach and a key), *what happened at the old camp* (a chain of four, ends in dungeon or boss), *the chief's tithe* (motte), *herbs for the grove*, *a message for the inn*, *the lost shipment* (pickup and use). Each uses existing part kinds as far as possible; new parts only for the shapes the list needs. | L (split in 3 sessions of M: camp and lodge, the old camp chain, crypt, motte and grove) | W3-W5 | yes, after its place exists |
| E5 | **NPC life.** Roles exist (15: forester, quarryman, guard, hermit, innkeeper...). Place them at the features: logger and foreman at the camp, hunter at the lodge, a druid, a bandit chief. A guard that patrols; idle poses by role (chopping, sitting, sweeping) if the animation set has them. | M | W3-W5 | yes |
| E6 | **Dungeons.** The crypt is built and walked (stair, loops, creatures, lights, boss spawn, chests); DUNGEONS.md step 7 is not: quest blocks, map floors, music, the player's own light, daylight through the mouth. For **dungeon 2** there are three options: (i) the **cave** (DUNGEONS.md step 4: not started, there is no cave style in the packs, only `crypt.json5`; the L option, needs an approach decided with the user); (ii) a **second style from the crypt's own kit**, an old mine under the abandoned camp (timbers, rubble, a shaft: M, reuses the parts system); (iii) **only the crypt** plus the motte's keep as an interior fight. Recommended: (ii). | M (step 7) + L (cave) or M (mine) | W3 for (ii) | step 7 yes |
| E7 | **Bandit camp.** The camp kind exists (`camps/banditCamp.json5`, a creature camp with no place). It becomes the motte's garrison and a small camp on the road. | S | W4 | with W4 |

### (e) Items and skills

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| I1 | **Gear tiers.** 77 items; weapons in three tiers per family; armour in cloth, leather, bronze and plate pieces. Lay out four steps over the 10 levels: starter, common (levels 2-5, quest and creature loot), good (5-8, the crypt's chests and the old camp), best (8-10, the two bosses). Loot tables per creature and per boss (tables exist for each beast, bandit, chest; the crypt, the bosses and the motte need their own). | M | B2 | yes |
| I2 | **Skills per class.** *Superseded, see I6 and the later I2 row below.* Talents are out of the slice. | - | - | - |
| I3 | **Crafting.** Nothing new. The disciplines that exist are cooking, herbalism, mining; the slice uses cooking at a fire (roast meat, bread), herb gathering (the sickness quest), and bandages. No smithing, no alchemy. | - | - | - |
| I4 | **Icons.** Four items have no icon: torch, bandage, iron ingot, spell scroll (generated, waiting for the user's pick in `assets_work/comfyUI/review.py`). New items made for the slice (boss gear, the grove's reward, crypt trinkets) also need icons. **Generation uses ComfyUI and the GPU: never started without asking.** | S + user | user | yes |
| I5 | **Consumables and use items.** Health and mana potions, bread, roast meat, bandage, salve exist. Check that a potion is a real answer to a hard fight at levels 6-10 and that the tooltip says it. | S | B2 | yes |

#### Items and skills: decided with the user (2026-11-20)

Rule of thumb from the user: **describe things with tweakable constants, curves, ratios and tags.**
Talents stay **out of the slice** (the trees and points stay in the engine, unused).

**Skills from templates, classes from ratios.**
- A **skill count curve** by level says how many skills a character should know (the skill
  complexity); it is a curve like any other, in `rules/balance.json5`.
- A bank of **skill templates**, each tagged: *kind* (damage, heal, shield, crowd control, buff,
  debuff, mobility, resource, summon), *level range* it fits, *cooldown category* (spammer, short,
  long, ultimate), *active or passive*, plus distance (melee, ranged, self) and the school.
- A **class template** is a set of **ratios of tags at key levels** (every 10 levels in the engine,
  so levels 1 and 10 for the slice; later 20, 30...): for example at level 10 a warrior is 40% damage,
  20% crowd control, 20% mobility, 20% defence, with two long cooldowns, one passive. The generator
  picks templates matching the ratios, scales each by its power share (see balance), and so a class
  falls out of numbers. Authored classes (warrior, mage, priest, ranger) are just hand-picked results of
  the same description, which is what keeps the system customisable.
- Needs templates for skills where today each skill is a file; the existing 48 skills become the first
  members of the bank, tagged by hand.

**Level-up stats.** Each level gives stat points. A **game config** chooses whether the points are
**spent by the player** or **distributed automatically** by the class's weights (the slice can default to
one, the system supports both). The amount per level is a curve.

**Items, kept simple.** For every **item type and slot** (each armour type and slot, each weapon type):
**6 items** over levels 1-10:
1. 1 starting item
2. 1 upgrade sold in a shop
3. 1 upgrade from a quest
4. 3 from loot (a drop or a chest)

Stat bonuses on rare items are expected and nothing more complex (no sets, procs or crafting).
Because that is a lot of items (about 10 slots x 3 armour types plus about 8 weapon types, so
about 230 items by a rough count), they are **generated from item templates and the curves** (budget by
level, slot, rarity), not typed. The existing 12 templates and 77 items are the start.

**Loot from creatures.** Each creature kind has **1-2 trash items** (sell value only, a wolf's fang) and
**1-2 valuable ones**, one of which can be rare; plus a global **slim chance** of a piece of rare
equipment. The dropped item's level is **close to the creature's level**. All of it ratios and curves:
the trash and valuable shares, the rare chance, the level spread.

**Healing.** **Out-of-combat regeneration exists but is small**, as a constant (a share of maximum health
per second, delayed after combat) so food, potions, bandages and healer skills stay worth using. The
tuning target: regen alone takes several minutes to refill, food and potions are the fast route.

#### Enemies and quests: decided with the user (2026-11-20)

- **Levels by cell**, from distance to the start (task B2).
- **No packs** in the starting area (the `groups` rule stays single-only).
- **Creature roles and tactics from templates and ratios**, with a creature complexity curve by level
  (a level 1 wolf bites, a later one has a second trick), tactic opening delay and crowd-control rules
  (see the combat step). Encounter curves (density by distance, elite share, aggro radius, leash)
  rather than hand placement.
- **No boss phases, anywhere in the slice.** A boss is a stronger elite with a tactic set, like any
  other creature. The slice has **2-3 lairs**: **small caves or crypts with few rooms**, each with a strong
  boss enemy and its loot. They are the slice's dungeons, and small is the point: the `lair` size in
  DUNGEONS.md (a few rooms, seamless entry) is the model, not the 15-30 room dungeon.
- **Rare named enemies are tied to features**, placed where the feature says: the cave or crypt boss,
  the bandit camp's chief, the motte's captain. Their count is the number of such features. Each has the
  unique loot (1-2 trash, 1-2 valuable, one possibly rare).
- **Quest density is a constant** (quests available near you), not a curve.
- **Quest effort varies by level with a min-max pair of curves**: simple, small quests at the start
  (kill 4), bigger ones later (kill 12). A drawn quest's effort lands between the two curves. XP and
  money follow effort as they do now (QUESTS.md, *Rewards*), their total set by the balance curves.
- **Quest kind mix** by ratio, as in the proposal (about 35% kill, 20% gather, 20% talk and deliver,
  15% reach, 10% use), kept near by the generator.
- **Quest items on ordinary quests too**, not only chain ends: a plain quest can pay an item, a modest
  one (common, level about the quest's), so a level 8 piece is still an upgrade over a level 3 one
  without needing rarity. The pool is the "quest" role of the 6-per-type layout (I8); the choice is
  one to three pieces for slots the character lacks.
- **Quest plot templates come after the places.** New plots need the new features (abandoned camp,
  motte, grove, lodge) to exist, so each feature task (W3-W5) ends with its plot templates, then E4
  draws on them.
- **No escort quests.**

**Changed tasks (enemies, quests, items and skills):**

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| E9 | **Encounter curves and rare spawns**: density, elite share, aggro and leash as curves in `rules/`; rare named spawns placed by features with their loot. | M | B2, B6, W3-W5 | yes |
| E10 | **Quest effort curves and item rewards**: min and max effort by level, kill counts that vary, the kind-mix ratio, an item reward on plain quests from the quest pool. | M | B6, I8 | yes |
| I6 | **Skill template bank**: tags, level range, cooldown category, active or passive; tag the existing skills; a class template format (tag ratios at key levels) and the generator that picks and scales; the skill-count curve. | L | B6 | yes |
| I7 | **Level-up stats**: stat points per level (curve), config `manual` or `auto` (class weights), the UI for manual. | M | B6 | yes |
| I8 | **Item generation**: the 6-per-type layout, templates and curves make the items, a pack file only marks the roles (start, shop, quest, loot); also the creature loot ratios and the level-matched drop. | L | B6 | yes |
| I9 | **Regeneration**: out-of-combat health and resource regen as constants in `rules/`, with the delay. | S | - | yes |

### (f) Balance

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| B1 | **Levels over the two hours.** Today XP to next level is `40*own^2 + 210*own` (250 for level 2, 5,130 for level 10). **Level 10 costs about 20,850 XP in all.** A kill at your level is about 100 XP, so kills alone would be about 200 of them; quests have to carry about half. Targets: level 4 at 0:35, 7 at 1:05, 8 at 1:30, 10 at 2:00 (see open question 2). | S | - | yes |
| B2 | **Level bands inside one zone.** Creature levels come from a zone's ring: ring 0 is levels 1-4 (`levels: { start: [1, 4], step: 3, width: 3 }` in rules/creatures.json5) and the whole slice is *one* zone, so every wolf would be level 1-4 and the boss too. Needs: levels by **distance from the start** (a gradient across the zone) and the dungeons' own +1 per 8 parts, set per dimension. **Decided with the user: use the world's cells**: a zone is about 10 cells, each cell takes its level from its distance to the start by a curve (a creature's level = its cell's level plus a small spread), the same way rings do today. To confirm in code: where the ring becomes a level in `resolveCreatureRules`, and that a creature knows its cell. | M | W1 | yes |
| B3 | **A slice bot and a tuning loop.** The server runs headless (`npm run server -- --bot`); `quests.mjs` plays the intro chain; `creatures.mjs` has a hunting bot. Extend into a route bot: do the intro, then the quests in a fixed order, fight, loot, buy the right gear, enter the crypt. Reports per 10 minutes: level, XP, money, kills, deaths, gear. The server steps without a renderer, so a run should not need real time (to be confirmed by the first bot run). | L | E3, W1 | yes |
| B4 | **Money.** One currency. Targets: the first 30 minutes buy a potion stock and a weapon; the end of the slice buys one armour piece of the best tier, not all. Vendor prices, quest rewards and loot values set from one table. | S | B3 | after B3 |
| B5 | **Difficulty.** Aggro range clamp and the "level difference" shape are Classic's. Set: a same-level fight costs about a third of health, an elite one half the potions, a boss is a real fight but not a wall. Deaths per run no more than a few. | M | B3 | after B3 |

### The combat and balance step (being detailed with the user, 2026-11-20)

**What the user says is wrong.** Level 1 plays fine. What is missing is a well-built skill set over
levels 1-10, balanced between classes (ranged against melee, and defence), and above all **the
fights**: enemies' stats, skills and how they use them (the spider webs the moment it targets you),
their AI and where they stand. Levelling is "not that bad" next to the fights. Loot, raw gold, sell
prices and shop prices need attention too.

**What the code does today** (checked):
- Every number is typed by hand in many files: a wolf's stats and per-level growth in `creatures/`,
  damage formulas inside each skill (`heroicStrike`: weapon max + 12 + strength/5), item `value`s in
  `items/` and `itemTemplates/`, money drops in `lootTables/` (a wolf drops 1-6 coins). Nothing
  relates them, so nothing can be tuned as a whole.
- Defence is armour only: `rules/combat.json5` has Classic's `armor / (armor + 400 + 85*level)`;
  spells ignore armour; no block, dodge, parry or resistances. Hit chance falls 1% per level of gap.
- Creature "tactics" are `{ skill, every: [min, max], when }`. The first use is **immediate**
  (the timer starts at zero in `brain.ts`), so a spider's web (`every 16-20, when distance > 4`)
  fires as soon as it aggros. Tactics have no opening delay, no "only after X seconds in combat",
  and no limit on crowd control.
- Classes: warrior (melee, rage), mage (ranged caster), priest (healer, smite); a bow weapon exists
  but no ranged physical class. One talent tree each.

**The proposal: a balancing step.** The user sets **target curves** in one JSON file
(`rules/balance.json5`) and the pack is made to match them. Two layers:

1. **Derive** (cheap, exact): kinds and items stop carrying raw numbers and carry a **role** and a
   few multipliers instead; the resolver computes the numbers from the curves, the way
   `resolveCreatureRules` already adds generated kinds. Covers:
   - creature health, damage, armour at each level, from `ttk` (time to kill) and `ttd` (time to die)
     for a role (normal, elite, boss, glass caster, brute, swarm): *health(L) = ttk x player dps(L)*,
     *damage per hit = player health(L) / (hits to die) *;
   - money per kill, per quest and per chest as a curve of level and role;
   - an item's stat budget per level, slot and rarity, and its price from the budget;
   - vendor buy price (multiple of the budget), sell rate (a share of it), repair, potions priced
     in "minutes of income".
2. **Fit and check** (measured, since skills are formulas): a headless duel tool runs each class's
   rotation against a dummy of known armour and level in the server (no renderer), and reports the
   real dps, time to kill and health lost per fight against the curves. Class skills are authored
   as relative *power shares*, and the tool writes the one scale per class and level band that makes
   the real dps meet the curve (or only reports, as the user prefers).

**Decided with the user (2026-11-20):**
- **Derive, but keep differences.** The curves give a *baseline* for a role and level. A creature, item
  or skill can still carry its own offsets and multipliers on top (a tough wolf, a fast sword), so the
  baseline is where it starts, not a cage. Raw stats stay allowed where a thing is meant to differ.
- **Fitting matters most for combat**: player stats, items, passives and active skills. Creatures,
  loot and prices are mostly derived; skills and gear are derived *and then measured*.
- **A tank / glass-cannon axis per class.** Every class and build is placed on one axis. The idea:
  at equal level and gear the product *damage x effective health* is the same (the "power budget"), and
  the axis says how it splits: a tank has high effective health and low damage, a glass cannon the
  reverse. The curves set the budget, each class sets its position (a number, say 0 = tank, 1 = glass
  cannon), and the fit tool checks both halves. Healers and supporters get the same axis plus a
  "throughput" term, so a priest's healing counts as effective health for the group.
- **Full defence complexity.** This is a customisable system, not one game, so the defence model is
  made of switchable parts in `rules/combat.json5`: armour, block (shields), dodge, parry, per-school
  spell resistance, damage absorption, plus avoidance against crowd control. Each part is expressed
  as an *effective health multiplier* in the curves, so a pack can turn any of them off and the
  balance still holds.
- **Add the ranger, and use it as the stress test.** Beyond warrior, mage and priest the slice
  builds a ranger (bow, range, kiting), and the duel tool is checked against deliberately odd builds:
  a pure tank, a glass cannon, a kiter, a healer alone, a pet or summon class, a stealth burst class.
  If the curves cannot place them all, the system is wrong, not the build.
- **The duel tool is a timeline, not a simulation of the world.** No geometry, no graphics, no real
  entities. Time runs in small steps (or an event queue); the only space it tracks is the **distance
  between the two fighters**, plus movement speeds, so a ranged attack, a cast time, a kite or an
  approaching melee enemy comes out of the numbers. It reads the *real* skill, tactic and stat
  definitions (the same decision code as the creature brain, shared, not copied), so what it measures is
  what the game does. See task B7.

The user's example curves: **dps, time to kill, hp scale, gold scale**; more as needed. Proposed
set for the slice, each a table by level 1-10 (a formula beyond), editable by hand:

| Curve | Meaning | Starting guess (to be tuned) |
|---|---|---|
| Player health | a character's health at level L | 60 at 1, about +25 a level |
| Player dps | by role: melee, ranged physical, caster, healer-hybrid | melee and ranged equal at same gear; caster a bit more burst, less sustain |
| Time to kill | a same-level normal enemy; an elite; a boss | 10 s; 30 s; 120 s alone, longer than the elite as adds join |
| Time to die | an undamaged player, taking a same-level normal enemy's full output | 35 s normal, 12 s elite, 25 s boss with adds |
| Fight cost | the share of health a same-level normal fight takes | about a third, so two fights then rest or a potion |
| XP | kills to the next level, and the quest share | from PROGRESSION; kills about 55%, quests 45% |
| Gold | money per hour at level L, split kills / quests / chests | tied to the price curves below |
| Price | a potion = minutes of income; a level-band weapon = hours of income | potion about 4 min, a good weapon about 40 min |
| Sell rate | share of the buy price a vendor pays | 25% |
| Item power | stat budget by level, slot and rarity | green +15% over common, blue +35% |
| Drops | items an hour by rarity; one upgrade expected per level | |

**Enemy design rules** (to fix the web problem and its kin):
- Every tactic gets an **opening delay** (`after`: seconds in combat before its first use) and a
  rule that crowd control (root, stun, slow) is never the first thing and not twice in a row, with a
  short immunity after it ends.
- Roles say what a creature does: a **brute** (wolf, boar: melee, one trick), a **skirmisher**
  (stays at range, kites), a **caster** (bandit mage, undead), a **swarm** (many weak), an
  **elite** and a **boss** (a script of phases). Placement says where: packs on roads' edges are a
  safe place, elites near a landmark, a boss in its room.
- Spawn placement respects levels: the gradient across the zone (task B2) and no elite on the
  first road.

**The class design pass** (task I2 grows): each class gets a role, a resource, a ten-level skill
ladder (one new thing on most levels), and defence tools. Classes today: warrior, mage, priest;
the slice adds **one ranged physical class** (a ranger with the bow), decided with the user, so ranged
and melee are both covered without the mage. Each class states its position on the tank / glass-cannon
axis and how it deals with distance (closes, holds, kites).

**New and changed tasks** (these join the tables above):

| ID | Task | Size | Needs | Par. |
|---|---|---|---|---|
| B6 | **`rules/balance.json5` and the derive step**: the curve format, a resolver that reads it, creatures and items moved from raw numbers to roles and multipliers, loot money from the curve, prices from the budget. | L | curve list agreed | yes |
| B7 | **Timeline duel and fit tool**: a pure function, no world, no entities: two sides, a clock, the distance between them, movement speeds. Uses the real skill, stat and tactic definitions (the brain's decision code made callable without a creature). A rotation policy per class (priority list, kite or stand), reports dps, time to kill, health lost, resource use, time out of range, against the curves and the tank / glass-cannon position; optional auto-scale per class and level band. Checked: combat lives in `src/sim/skills` (`dealDamage`, `heal`, casting, magic) and works on `Entity` plus a `Sys`, with no renderer, so the cheapest route is to run the real skill system on bare entities with a fake clock and a one-number distance, rather than a second copy of the rules. Movement and range checks are the part that needs a stand-in. Replaces much of B3's tuning. | L | B6 | yes |
| B8 | **Defence**: the full model, as switchable parts (armour, block, dodge, parry, spell resistance, absorbs, crowd-control avoidance) in `rules/combat.json5`, each with its effective-health multiplier for the curves. | M | B6 | yes |
| B9 | **Stress-test characters**: the ranger plus odd builds (tank, glass cannon, kiter, solo healer, summoner, stealth burst) as data, run through B7 to prove the curves place them. | M | B7 | with I2 |
| E8 | **Creature AI pass**: tactic opening delay and CC rules, roles, a skirmisher that kites, a caster that keeps range, placement rules for elites and packs. Fixes the spider's instant web. | M | B6 | yes |
| I2 | **Skills per class** (replaces the earlier I2): a class template per class (tag ratios at level 1 and 10) and the ranger, built on the skill bank (I6); each skill a power share. | M per class | I6, B8 | per class |
| I1 | **Loot, gold and prices** (grows): item budgets, drop tables per creature and boss, gold curve, vendor buy/sell and repair, from the curves; the item layout itself is I8. | M | B6, I8 | yes |

## 4. Known gaps, checked

| Gap | What was found | Where it sits |
|---|---|---|
| **Ocean plane inside crypts** | Confirmed. `ocean.ts` has no mention of the underground; `world.ts` fades the sky, fog and rain underground but the plane follows the camera at sea level and is drawn. A crypt goes down up to 45 m, the wood's lowland is 9-15 m high, so a crypt in a flat wood reaches below the water plane. | G1 (stopgap first) |
| **Creatures probe, 3 failures** | `npm run probe -- scripts/probe/creatures.mjs` on today's master: **90 of 93 pass**. Failing: the bot kills no creature in 90 s (the bot is "hunting" a wolf and a boar 124 and 140 m away; it does not reach them), the loot check that depends on it, and "no one further off than `social`" (a group pull reaches creatures from further than 12 m). **They are new**: the same probe passes 93 of 93 at 6a588bb, 2f0da06 (surface navigation) and a741e7b (packs stand apart). So the break came with one of the later commits: 08a3ce6 (creatures follow into houses), e432ac4 (crypts peopled) or 55b6b54 (ranged creatures close in), or a merge since. Not narrowed further. | E1, B3 |
| **Trainer window** | *Train* opens the progression panel; there is no trainer's own window. | P2 |
| **Quest variety** | 3 plots and 23 segments. Playable chain, thin variety. | E4 |
| **Ambient sound in rain** | Confirmed missing: no ambience sounds or system, the `ambient` bus exists unused. No rain sound at all. | P7 |
| **Inn camera clipping** | Not reproduced here; needs a spot from the user. | P1 |
| **Icons for four items** | The items exist (torch, bandage, iron ingot, spell scroll); the icons are generated and waiting for the pick in `assets_work/comfyUI/review.py`. | I4 |
| **Cave dungeon** | Confirmed not started: DUNGEONS.md steps 4-5 for the cave; the pack has only the `crypt` style and 36 crypt parts. GEOMETRY.md does not mention caves; the approach has to be asked (the prior brief said so). | E6 |
| **Abandoned camp condition** | Confirmed: no condition or decay system anywhere in `src/world`. | W3 |
| **Sheepfold not in a biome list** | Confirmed: `features/sheepfold.json5` is in no biome. It is a moor and fell kind and is not part of the slice. | W8 (nothing to do) |

Also found while checking: the **full world takes about 4.8 GB of JS heap** when travelling
(DIMENSIONS.md note). The slice world is one biome and one zone, which is the answer, but G2 must
measure it.

## 5. Order and cut list

### What first, what together

1. **W1** (the world exists and loads) and **G1 stopgap** (ocean off): the first morning. Everything
   else wants a place to stand.
2. In parallel at once, none needing anything else: **W3, W4, W5** (the three new features, one
   session each), **G4** (autumn look), **P7** (ambience), **E2** (behaviour and bosses), **I2**
   (skills), **E6 step 7** (dungeon surroundings), **G6**, **G7**, **G8**.
3. **W2** (the seed scan) after the three features land; **B2** right after W1.
4. **E4** (quests) one session per place as it appears, and **E5** with it.
5. **B3** (the bot) as soon as W1 and the intro exist; it then runs every few days to tune.
6. **I1, I5, P3, B4, B5** follow the bot's numbers.
7. **G2** (soak) and **P6** (saving) in the last stretch, when the world is as heavy as it will be.

Tasks touching shared files, so not two at once: W3 and W4 both edit `compound.ts` and the feature
pack; E4 plots all add to `questSegments/` and `questPlots/`; I1 and I2 both edit `items/` and
`skills/`.

### Milestones, each with a thing you can see

| # | Milestone | You can see |
|---|---|---|
| M1 | **The vale** (W1, G1 stopgap, B2 first cut, P5) | Menu, New game, the character drops on the village square of a wood with nothing but autumnWood on the map (M), mountains round; wolves are low level near the start and higher at the far side. Teleport to a crypt: no ocean. |
| M2 | **The first half hour** (G4, P7 first cut, E1, E2 first cut, E3, P2) | A new character plays the intro chain to the end: falling leaves, wolves in packs with bodies, wind and birds, a trainer window that teaches, and the letter delivered in the hub at about level 4. |
| M3 | **The wood has places** (W3, W5, W2 seed pinned, E4 first two sessions, E5, P3, W6) | The map shows all eight features. The camp, lodge, inn and the old camp each give a quest or two; the quest log has six open; the vendors sell different things. |
| M4 | **Down into the crypt** (E6 step 7, I1, quest for it) | The churchyard's quest leads down; a locked door and a key; the boss with its own tactics; a chest with good gear. |
| M5 | **The motte and the grove** (W4, E7, E2 bosses, dungeon 2 per the decision, E4 rest) | The bandit chief with adds on the mound; the grove's vista and its reward; the log shows about 14 finished quests. |
| M6 | **Two hours** (B3, B4, B5, G2, P6, I4, P4, I5) | A bot run ends at about level 10 in about two hours of game time; a soak shows a flat page heap; a saved game from an hour in continues right; your own run, start to end. |

### If time runs short, cut in this order

1. The cave dungeon (E6 option i); take the mine or the crypt alone.
2. Texture compression (G3), unless the soak shows memory is the problem.
3. Charcoal burners, sawmill, alchemist, watchtower (never in the eight).
4. A skeleton body for the undead (the tinted humanoid stays).
5. The grove's guardian boss (the grove stays, it is the end).
6. Dedicated autumn music (the forest style stays), the crypt's own music last.
7. The end-of-slice summary window (P5).
8. Baked vertex AO, the world drawing switch's second half (G1 M: the stopgap stays).

Never cut: the intro chain, the two bosses, the crypt, saving, the soak.

## 6. Open questions for the user

1. **A pinned seed or a guaranteed layout?** Scan seeds and pin the best one (cheap; the slice is for
   you only), or make the biome promise its features on every seed (a real rule, but more work and
   not needed for one player). Recommended: pin.
2. **What level at the end?** The plan says 10 (about 21,000 XP). Lower (8) makes the curve gentler
   and needs less content; higher needs more quests and bosses.
3. **The second dungeon.** The cave (large, and the approach is yours to decide), a mine made from the
   crypt's kit under the abandoned camp (medium, recommended), or only the crypt?
4. **The three new features.** Abandoned camp, motte and bailey, druid grove: right three? Charcoal
   burners or a watchtower could swap in for cheap.
5. **Which class to tune first.** Warrior first (arms tree, shields, simplest numbers), then mage and
   priest checked by the bot; or all three at once?
6. **Level gradient.** Levels from the start outward across the one zone (my proposal), or the
   three-ring idea (three adjacent autumn wood zones, rings 0-2, which the code already does, but
   it is three zones, not one)?
7. **Undead bodies.** Tinted humanoids are fine for the slice, or a real skeleton?
8. **Icons.** When may the generator run for the new items, and when do you want to pick the four
   waiting icons in review.py?
9. **Which places are the 2-3 lairs?** Decided: small caves or crypts, few rooms, a strong boss, no
   phases. Open: which ones. My guess: the churchyard crypt at the small size, a cave, and the old
   camp's mine or the motte's cellar. This also answers question 3 (the second dungeon): small.
10. **Which features are in?** Decided: all eleven, no empty cells. The tiers in section 2 are only the
    cut order.
11. **How many cells?** Decided: 14, cell size unchanged.
