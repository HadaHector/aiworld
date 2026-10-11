# Designers' brief

What every designer on the panel reads before pitching. The panel's prompts are in
`.claude/agents/designer-*.md`; this file is what they share.

## The game

**aiworld** is an explorable, procedurally generated world in the browser (Babylon.js, WebGL2). A
seed makes a continent of zones: each zone is one biome (25 of them, from flower meadow and heather
moor to sand sea, cypress bayou and ice peaks), and is made of cells about 1 km across. A cell
holds its land, its trees and grass, and at most one major feature. Today the player is a figure
who walks the world in third person. There are no NPCs, quests, combat, inventory or dialogue yet.
What the game currently offers is the walk itself: the land, the weather, the day and night, and
what people built in it.

What exists now:

- **Land**: 25 biomes with their own ground, rocks, grass, bushes and tree kinds. Rivers, lakes,
  coasts, cliffs.
- **Sky**: a day and night cycle, and weathers (clear, overcast, mist, drizzle, rain, storm, gale,
  snow, blizzard) that change the light, the fog and the wind.
- **Settlements**: hamlets, villages and market towns, joined by roads. Their buildings come from
  a house generator in each biome's style: cottages, barns, an inn, a chapel, a smithy, a town hall
  and others.
- **Interiors**: a few buildings can be entered (the inn first). They have rooms, furniture and
  props, fires, lanterns and window light baked in with shadows.
- **Features**: a quarry and a logging camp so far. Many more are planned in FEATURES.md.
- **Names**: places get names from "voices", per climate.
- **Content is data**: biomes, buildings, props and features are JSON5 files in a pack, read by
  generators. New content is mostly new data, plus a generator when something new has to be made.

## Limits

- **Technology up to the first muskets**, around 1550. Water and wind mills, blast furnaces,
  printing, bastion forts and powder mills are in. Steam, rails and rifling are out.
- **Mostly made by people.** Magic is a flavour on top: towers, circles, shrines, odd stones. It is
  not a second world.
- **Everything is generated.** Nothing is hand-placed. An idea has to be a rule that a generator
  can apply anywhere it fits, again and again, and still look right. "One special cave" is not an
  idea here; "a kind of cave, and where it appears" is.
- **No changing seasons, no realistic climate.** A jungle can border a snowfield. The player cannot
  feel temperature: a climate is only what can be seen.
- **Exaggerated scale.** Details (tiles, stones, shingles) are built about twice life size, so they
  read from afar.
- **Small team, browser game.** Performance matters: low polygon counts, few draw calls. A cheap
  idea that changes a walk a lot beats an expensive one that changes it a little.

## Where to look

Read these when a question needs more than this brief. Do not read the source code unless you
are asked to.

- `FEATURES.md`: the brainstorm of what a cell can hold, with Fun and Cost per kind, the engine
  pieces they need, and what suits each biome.
- `ZONES.md`: the plan for the biome families.
- `INTERIORS.md`, `FURNITURE.md`, `LIGHTS.md`: going inside buildings.
- `BACKLOG.md`: known problems and deferred work.
- `public/packs/core/`: the content itself, as JSON5 (biomes, buildings, props, features...).

## How to pitch

Answer in your own voice. Whatever the task's own format, always describe how a thing looks, as
concretely as you can: it is what gets built. Say where an idea comes from in your life when it
does. Disagree with the brief, or with an idea you were given, when you think it is wrong, and say
why. Fewer, better ideas beat a long list.

For each idea:

```
### <Name>
**The pitch**: two or three sentences, the way you'd say it across a table.
**Why it matters to me**: the memory, game or habit it comes from.
**What the player gets**: what changes in a walk through the world.
**How it looks**: what the eye sees, close up and from afar: shapes and proportions, sizes in
metres, materials and colours, wear, how it sits on the ground, how it reads at dusk and at night.
Concrete enough to build from.
**How it is generated**: the rule: where it appears, what varies, how two are told apart.
**Fun** 1-5 · **Cost** 1-5 · **Needs**: the engine pieces from FEATURES.md, or "new: ..."
**The risk**: what could make it fall flat.
```

Finish with **What I'd cut**: one thing already planned (in FEATURES.md or ZONES.md) that you
would drop or change, and why.
