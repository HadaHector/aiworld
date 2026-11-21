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

## The probes, timed (audit of 2026-11-21)

Run `npm run probe:quick` for the fast set (about 7 minutes, one probe at a time, a line each). Probes that
sweep seeds or layouts have a quick default; `--full` (or `PROBE_FULL=1`) gives the whole sweep, e.g.
`npm run probe -- scripts/probe/dungeons.mjs --full`. `mode.mjs` holds the switch (`pick(quick, full)`).

Why they were slow: every server probe pumped its ticks with `await setTimeout(0)`, and on Windows that
sleeps about 15 ms a tick - swim, creatures and quests spent most of their time asleep. Now `setImmediate`
(same ordering, no sleep). The rest of the time is world generation (about 5-10 s per `small`/default
world) and `generateLayout` for dungeons (about 0.5 s a layout, game code).

Seconds are wall time on a machine shared with other sessions; "before" is the original, "after" is quick mode.
Checks are as the probe counts them (quick mode, where it differs from full, in brackets).

| probe | before s | after s | checks (fails) | covers | verdict |
|---|---|---|---|---|---|
| abandonedCamp | 7.4 | 6.9 | 62 | rotted-roof camp feature over 30 layouts | keep |
| ambience | 0.4 | 0.4 | - | ambience levels, lair songs compose | keep |
| balance | 3.5 | 1.4 | 431 | balance curves, role stats, prices | keep |
| beast | 5.6 | 4.8 | "all good" | beast plans: bodies, gaits bake, animator, atlas | keep |
| beastGaits | 2.3 | 1.9 | "all good" | feet do not slide or sink | keep |
| body | 3.9 | 3.5 | - | race bodies: manifold, winding, weights | keep |
| grove | 9.6 | 9.1 | "ok" | druid grove odds and ring of oaks, 8 seeds | keep |
| icons | 2.9 | 1.6 | 25 failures | icon names core uses exist in the pack | keep; **fails** (items name icons the pack lacks, e.g. item-bandage, item-iron-ingot) |
| roadWater | 23.5 | 8.6 | 4179 road points (full: 11169) | no road under water | speed-up: 2 seeds/config quick, 6 full |
| water | 7.2 | 6.0 | 37948 | waterAt agrees with ground, deterministic | keep |
| yardShape | 5.3 | 4.7 | "no faults" | polygon-yard layouts | keep |
| swim | 66.7 | 6.6 | 13 | swimming, diving, drowning on a server | speed-up (setImmediate) |
| vale | 25.2 | 9.3 | "ok" | vale config: one zone, start village | speed-up: 2 seeds quick, 6 full |
| starts | 34.2 | 10.7 | 96 (full 236) | start site choice, saved characters | speed-up: 3 seeds/config quick, 8 full |
| riverLevels | 6.9 | 5.5 | 954 | river levels fall to the sea, fords, bridges | keep |
| mapTiles | 12.2 | 9.8 | 26 | map tiles: size, determinism, water | keep (also writes a PNG when given a folder) |
| chat | 9.1 | 4.6 | all pass | chat parser, commands, range, rate limit | speed-up |
| saves | 9.2 | 4.2 | 53/55 (2) | saves, stores, restart finds the character | speed-up; **fails 2** ("nothing went wrong saving", "where it was left") |
| npcs | 35.4 | 24.6 | 424 | factions, standing, casts, services | speed-up (setImmediate); still slow - world builds per section |
| entities | 10.6 | 9.8 | 98 | formulas, stats, entities on the server | keep |
| items | 12.6 | 12.2 | 129 | item rules, rolls, loot, equipment | keep |
| progression | 26.3 | 14.2 | 155 | XP, talents, unlocks, saves | speed-up |
| abilities | 8.7 | 9.5 | 137 | skills, magic, casting, a fight | keep |
| feedback | 9.8 | 9.3 | 1860/1861 (1) | sounds, particles, textures render | keep; **fails 1** (animation cues for shield, renew, fireball, kick missing) |
| collision | 9.8 | 8.9 | "all good" | collision maths against slow answers | keep |
| navigation | 57.7 | 26.4 | 486/487 (1) (full 1507) | crypt walk-line graph, motor walks, houses | speed-up: 60 layouts quick, 200 full; known fail: wolf up the stairs |
| creatures | 118 | 28.7 | 97/99 (2) | creature rules, spawner, brain, hunting bot | speed-up (setImmediate; the 90 s bot is simulated time, not wall); known fails: the bot |
| quests | 223 | 67 | 432 (full 448) | quest runtime, generator over worlds, intro chains | speed-up: fewer seeds quick (see note), setImmediate |
| dungeons | >900 (timed out) | 63 | 22239 (full ~113000) | 1000 crypt layouts on the real terrain, rules, walked on the motor | speed-up: 40 layouts quick, 1000 full; quick misses the known failures (layouts 126, 729...) |
| caves | 176 | 169 | 119 (55 fail) | lairs on a headless server, walked to every spot | not in quick set: a diagnostic that fails until the cave navigation step; drop candidate if that is not coming soon |
| music | 0.3 | 0.3 | none | prints a tracker text of a song | drop candidate as a probe (a tool; no checks, cannot fail) |
| aboveWaterRewire | - | - | none | one-off rewrite of the packs' waterline rules (`--write`) | drop candidate: already applied to the packs |

Quests quick mode: the generator uses the 3 tiny worlds and 2 of the 3 small ones; the weighting section 2 of 5
worlds. Taking just 1 small world failed the statistical "weapons and armour are both offered" check (11 of 39),
so 2 is the floor.

Not run, and not probes: `hook.mjs`, `tsResolve.mjs`, `loadContent.mjs` (the loaders), `mode.mjs`, `quick.mjs`.

### Overlap and candidates to drop (not deleted - for the owner to decide)

- `music.mjs`: no checks, prints a song; belongs under `scripts/` as a tool (or is covered by ambience.mjs, which composes songs and checks them).
- `aboveWaterRewire.mjs`: a migration, done; keep only if the rewrite may be needed again for a new pack.
- `caves.mjs`: always exits 1 today (55 of 119 checks), so it cannot guard anything; it overlaps navigation.mjs (the dungeon graph) and dungeons.mjs (layouts). Worth keeping as a worklist for NAVIGATION.md step 6, otherwise drop.
- `vale.mjs` and `starts.mjs` both check that a start village is chosen and is the same twice (vale for its one-zone config, starts for the dimension rule): partial overlap, different configs; fine to keep.
- Several probes (creatures, navigation, npcs, quests, saves, starts) each build their own tiny world and server; sharing one across probes is not possible (separate processes), but inside npcs, quests and navigation a world is rebuilt per section - the next speed-up if wanted, needs only probe edits.
- Needing game code, not done: `generateLayout` (0.5 s a layout) and `resolveDungeons` (5 s per run) set the floor for dungeons.
