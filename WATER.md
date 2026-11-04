# Water

Swimming, drowning and water you can see, hear and feel: the water items of the first playthrough
(GAMEPLAY.md: "swim" and "drowning" are wanted dangers). Today the world draws water but the
simulation does not know it is there: a character walks along the bottom, takes no harm, makes no
splash, and nothing sounds or looks different underwater. This document is the plan, agreed with
the user before the feature is built.

**Status: roads and spawn done (see *Done first*); the water feature is planned, not built.**

## Decisions

| Question | Decision |
|---|---|
| Drowning | **A `breath` resource.** Drains while the head is under water, refills fast in air, and hurts at zero (a share of max health each second). A normal resource defined in the packs (ENTITIES.md), so any game config can drop or change it |
| Swimming | **Slower than walking, free vertical movement.** About 60 % of walking pace in any direction; you float at the surface when idle, jump swims up, a dive key swims down. **Combat is not limited**: abilities, auto-attacks and casting work in water exactly as on land |
| Armour | **No weight in water.** Swimming is the same for everyone. A pack stat can add it later without code |
| Creatures | **Stay out of deep water** unless their kind is marked `swims`. Land creatures treat deep water as a wall (no path, no leash point, no spawn in it) and stop chasing at the shore |
| Everything else | Pack data wherever possible: the breath resource, the cues, the particles, the surfaces and the underwater look are all in the packs |

## The water query

One function the simulation, the client and the probes all call, headless and deterministic:

```ts
waterAt(x, z): { surface: number; depth: number }   // depth 0 on dry ground
```

- `src/world/water.ts`, built from the dimension's terrain: **the surface is the dimension's sea
  level** (`SEA_LEVEL` for the mainland; a dimension definition may give its own, or `null` for
  no water), and `depth = max(0, surface - groundHeight)`. Today every sea, lake, pond and river
  in the world is a hollow of the ground filled to that one level (the terrain shader and the ocean
  plane draw it so), so one level and the terrain sample are the whole answer: no mesh, no
  per-water-body data, the same on the server, in a worker and on the page.
- Under a bridge the query says water (the ground is under it); the bridge's deck is a floor, so a
  body standing on it is above the surface and not swimming. Building floors and cellars count as
  dry (the query is for outdoor ground; a body inside a building is never in water).
- `world.waterAt` joins `heightAt` on the world data; the dimension's server side wraps it with the
  building floors (`groundAt`).

## Pieces

| Piece | What |
|---|---|
| **Water state** (sim) | Each step, from the body's feet and head heights against the surface: `wading` (feet wet, knee deep: footsteps and splash only), `swimming` (the chest under: swim movement), `submerged` (the head under: breath drains). Kept on the entity next to its combat flags, replicated, and readable by packs as a condition (`when: "submerged"`) |
| **Swim movement** (`playerBody`) | Swimming replaces gravity with buoyancy: it floats to the surface, `jump` swims up, the new `dive` input swims down, pace is `swimSpeed` times walking (a `rules/` number, default 0.6). Forced motions (knockback) still work. Leaving the water over a bank climbs out as a step up |
| **Breath** (`resources/breath.json5`) | Max from a `maxBreath` stat (30 s base), `drain` while submerged, fast `regen` in air. At zero, `damage` of a share of max health per second (rules, default 8 %). The resource system gains the two small things this needs: rates that depend on a state, and an effect at empty. Shown as a bar under the health bar only while it is not full |
| **Creatures** | The water query joins the walkability test in the creature brain, spawn points (already skip water) and leash points. Kind field `swims: true` (traits or kind data) lets a kind in. Nothing else about their brains changes |
| **Body animation** | The client's `characterBody` already has a swim animation (CHARACTERS.md); it plays on the replicated `swimming` flag for every body, and the body lies horizontal at the surface |
| **Splash** | Cues `splash.enter` and `splash.leave` on crossing the surface (loudness and size by speed of entry), with particles (spray, rings on the surface) and a sound each. Pack cue files, so a game can change them |
| **Footsteps** | `footstep` reads the water depth under the foot: shallow is `water` (exists in the surface table); wading deeper adds a `water.deep` surface (a slosh). Fixes the "water footsteps are missing" note in FEEDBACK.md, which waited for this query |
| **Underwater look** | While the camera is under the surface: a blue-green tint and short fog (a post effect pass or the scene fog switched, set by `rules/water.json5`), a darker sky, caustic-like light is left for later. The surface seen from below is the water plane's underside, tinted |
| **Underwater sound** | Cue `underwater.on` / `.off` as the camera crosses the surface: the ambient and music buses get a low-pass and a lower volume (`feedback` rules `underwater` mix), a muffled bubble loop while submerged, and a gasp cue when breath runs low and on surfacing |
| **Debug** | `__aiworld.water(x, z)`, the map marks nothing new; the probe for the query |

## Rules and data

| File | Holds |
|---|---|
| `rules/water.json5` (new) | `swimSpeed`, depths for wading / swimming / submerged, the buoyancy, the underwater look (tint, fog distance), the drowning damage share, how fast `dive` goes |
| `resources/breath.json5` (new) | The breath resource: max, drain, regen, what happens at empty |
| `stats/maxBreath.json5` (new) | The stat it reads |
| `cues/splash*.json5`, `underwater*.json5`, `particles/splash*.json5`, `sounds/` | The feedback |
| `dimensions/*.json5` | Optional `water: { level }` (or `null`) |
| creature kinds | `swims` |

## Done first

1. **Starts on dry ground.** `chooseStarts` (`src/world/settlements/starts.ts`) checks the start
   point and the home against the ground (above the water, off a river, outside a building) and
   moves them to the nearest standable point in rings out to 60 m. `scripts/probe/starts.mjs`
   asserts it for 8 seeds each of `tiny` and `small`. The playthrough's ocean spawn (world seed
   475982993, a medium world, elf priest) could not be reproduced: the server, a quick game and
   two worlds in one page all put the character on the square of Vysael Steps at (-128, 198), 20 m
   up. Left open.
2. **Roads under water.** The cause: a road is graded into the ground *before* the coast blend,
   so a road cut through a hill near the coast was pulled down toward the seabed afterwards, below
   the water, and was not bridged because bridges are planned on the ground without roads. Roads
   are now graded after the blend, from the ground as it then lies (`terrainSampler.ts`), so the
   level the roads were routed and bridged against is the level they get. At (8..75, 304..313) in
   world 475982993 the road is now 7-10 m up instead of -1 m. `scripts/probe/roadWater.mjs`
   samples every road point against the waterline over 14 worlds (tiny and small, 7 seeds): none
   under water, bridged ones excepted. Terrain near coasts with roads changed for every seed.

## Build order

Each step leaves the game working; each ends with a probe or a look in the running game.

1. **The query.** `waterAt` on the world data and the dimension, `rules/water.json5`, a probe that
   checks it against the terrain at known points (ocean, a lake, a river, a bridge, dry land) over
   several seeds and configs.
2. **Water state and swimming.** The state on entities, swim movement and the `dive` input (key in
   the HUD key list), the replicated flag and the swim animation. Probe: a body walked into the sea
   swims, floats, dives and climbs out.
3. **Breath and drowning.** The resource rule extension, `breath.json5`, the bar, the damage at
   empty; creatures kept out of deep water and the `swims` field. Probe: held under, it drains and
   hurts; surfaced, it refills.
4. **Feedback.** Splash cues and particles, water footsteps by depth, the underwater look and
   sound, gasp and bubbles.
5. **Docs.** GAMEPLAY.md, FEEDBACK.md (footsteps, cues), CHARACTERS.md (swim now live), ENTITIES.md
   (resource rates by state) and this file's *As built*.

## Left for later

Currents in rivers, fishing, boats, wet clothes and drying, swim and breath as discipline skills,
rain and snow on the surface, underwater light shafts and caustics, creature breath and drowning,
armour weight, water that is not at one level (a mountain lake above the sea).
