# Probes

A throwaway script that imports real project source directly (no browser, no build step) to
check pure logic - noise formulas, spacing invariants, split math, whatever doesn't need a
rendered frame. Used throughout this project's history to measure before changing a constant and
to verify an invariant (tiling, density, distribution) instead of asserting it.

## Usage

Write a script anywhere convenient - `scripts/probe/scratch.mjs` is a fine default, and is
gitignored so it never needs cleaning up - importing project source the normal, extensionless way:

```js
import { createTreeScatter } from "../../src/world/foliage/treeScatter.ts";
```

Then run it:

```bash
npm run probe -- scripts/probe/scratch.mjs
```

`hook.mjs`/`tsResolve.mjs` are what make the extensionless import above resolve to the real `.ts`
file - Node's own resolver has no notion of it. Everything else here (bake pools, Babylon,
anything DOM/WebGL) is out of reach, same as any Node script; probes are for logic that runs the
same with or without a renderer.

## World content

Anything that generates world needs the content packs (`public/packs`). `loadContent.mjs` reads
and resolves them exactly as the game does:

```js
import { loadContent } from "./loadContent.mjs";
import { createTerrainSampler } from "../../src/world/terrain/terrainSampler.ts";

const world = createTerrainSampler(1337, loadContent());
```

## Running them: by category

The probes are grouped by the team's fields (WORKFLOW.md). A session runs its own field's; the main session
runs the merged branches' fields after a merge, or all of them.

```bash
npm run probes -- --list               # the categories and their probes
npm run probes -- dungeons rules       # those categories (a probe in both runs once)
npm run probes -- all                  # every probe, 3 at a time: about 3.5 minutes
npm run probes -- water quests         # single probes by name work too
npm run probes -- all --full           # full mode: the whole sweeps (many minutes)
npm run probes -- dungeons --worklists # also the worklists (probes that fail until their work is built)
npm run probes -- all --jobs=1         # one at a time (about 7 minutes; times are each probe alone)
```

The table of categories is at the top of `run.mjs`. A probe file in no category stops the run, so a new
probe gets one. The run takes a machine-wide lock (`aiworld-probe-quick.lock` in the system temp folder), so
two runs never share the CPU. It sets `PROBE_JOBS`, so a probe with a wall-clock check (navigation's search
times) can allow for the shared CPU.

| category | probes |
|---|---|
| features | abandonedCamp, yardShape, featureReach, vale |
| placement | vale, starts, abandonedCamp |
| dungeons | dungeons, navigation; worklists caves, caveMouths |
| terrain-water | water, riverLevels, mapTiles, swim, vale |
| gameplay | abilities, entities, collision, creatures, beast, chat, feedback, ambience |
| rules | balance, items, progression, quests, npcs, saves, starts |
| art | body, beast, icons, feedback |

Probes that sweep seeds or layouts have a quick default; `--full` (or `PROBE_FULL=1`) gives the whole sweep, e.g.
`npm run probe -- scripts/probe/dungeons.mjs --full`. `mode.mjs` holds the switch (`pick(quick, full)`).

## The probes, timed (2026-11-25)

Seconds: alone, then in `npm run probes -- all` (3 at a time, on a machine shared with other sessions).
All 26 pass; `all` takes 213 s, about as long as quests does beside the others.

| probe | alone s | in all s | checks | proves |
|---|---|---|---|---|
| quests | 108 | 185 | 429 | quest runtime, the generator over worlds (3 tiny, 2 small), weighting, the intro chain |
| dungeons | 45 | 66 | 12959 (full ~113000) | 20 crypt layouts quick (1000 full) on the real terrain, every rule, walked on the motor |
| creatures | 24 | 45 | 99 | creature rules, spawner, brain, the hunting bot |
| npcs | 25 | 42 | 433 | factions, standing, casts, NPCs in the world, services |
| navigation | 24 | 38 | 465 | crypt walk-line graph, motor walks, a wolf through rooms and up an inn's stairs |
| starts | 14 | 21 | 68 (full more) | start sites from the dimension rule, 2 seeds a config quick (8 full), saved characters |
| vale | 14 | 22 | "ok" | vale config, one zone, start village, levels by cell; the druid groves (3 seeds quick, 8 full) |
| water | 14 | 20 | 75902 | waterAt agrees with the ground; no road under water (2 seeds a config quick, 6 full) |
| progression | 10 | 21 | 155 | XP, talents, unlocks, saves |
| abandonedCamp | 10 | 14 | 175 | the rotted camp: 12 layouts quick (30 full), roofs, 3 vale worlds quick (8 full) |
| mapTiles | 10 | 16 | 26 | map tiles: size, determinism, water (writes a PNG when given a folder) |
| items | 8 | 17 | 129 | item rules, rolls, loot, equipment |
| abilities | 8 | 14 | 145 | skills, magic, casting, a fight |
| entities | 8 | 13 | 98 | formulas, stats, entities on the server |
| feedback | 9 | 13 | 1864 | sounds, particles, textures render |
| collision | 8 | 13 | "all good" | collision maths against slow answers |
| riverLevels | 8 | 11 | 1016 | river levels fall to the sea, fords, bridges |
| swim | 7 | 13 | 13 | swimming, diving, drowning on a server |
| beast | 7 | 9 | "all good" | beast plans: bodies, gaits bake, animator, atlas; feet do not slide or sink |
| chat | 5 | 10 | all pass | chat parser, commands, range, rate limit |
| saves | 5 | 9 | 55 | saves, stores, restart finds the character |
| yardShape | 5 | 8 | "no faults" | polygon-yard layouts |
| featureReach | 10 | - | 40 | every compound walked to from 2 of 4 directions (4 river worlds, 3 vale quick; 8 vale full) |
| body | 4 | 6 | - | race bodies: manifold, winding, weights |
| icons | 3 | 5 | - | icon names core uses exist in the pack (seven listed as waiting for generation) |
| balance | 3 | 5 | 431 | balance curves, role stats, prices |
| ambience | 0.3 | 0.5 | - | ambience levels, lair songs compose |
| *caves* (worklist) | 169 | - | 119 (fails) | lairs on a headless server, walked to every spot; fails until cave navigation (NAVIGATION.md step 6) |
| *caveMouths* (worklist) | 22 | - | fails 2 of 20 | the vale's cave mouths' lairs lay out whole (seed 6: two minimal lairs) |

Quests' time is servers, not worlds (a small world takes 2-3.5 s to make; the generator section starts 7
servers). The quick mode checks "the same quests twice" on one world per config (all in full). Taking just 1
small world fails the statistical "weapons and armour are both offered" check, so 2 is the floor.

Not probes: `hook.mjs`, `tsResolve.mjs`, `loadContent.mjs` (the loaders), `mode.mjs`, `run.mjs` (the runner).

## Tools (scripts/tools)

Scripts that print or write, checking nothing; run them with the probe hook (`npm run probe -- scripts/tools/<x>.mjs`).

- `cellwhy.mjs`: why cells are empty, per kind and condition (FEATURES.md, *Why a cell is empty*).
- `music.mjs`: a composed song as tracker text.
- `worldHash.mjs`: a hash of the world's layout and some chunks, to show a refactor changes nothing.

## The pruning of 2026-11-25

The quick set went (448 s one at a time), and probes are run by category instead. `roadWater` went into `water`,
`grove` into `vale`, `beastGaits` into `beast` (each pair built the same worlds or plans). `cellwhy` and `music`
moved to `scripts/tools`. `aboveWaterRewire` (a one-off rewrite of the packs, applied) was deleted, and so were
the 140 git-ignored scratch probes of the main checkout, which were mostly one-off printouts or old copies of
committed probes (a zip of them was kept outside the repo); `worldHash` became a tool. The scratch probes that
could one day become checks: compounds (every compound's layout holds), furnish, faceWinding, openEdges, zfight.
Scratch probes are for the moment: delete yours when the work is done, and make a probe of anything worth keeping.
