# Hunting lodge: plan (concept-first experiment, see CONCEPTS.md)

Concepts: `assets_work/comfyUI/concepts*/` (not committed). Feature table row: FEATURES.md, "Hunting lodge" (S-M, wood edge,
snowy taiga / autumn wood / bluebell wood, cost 2).

## Shape (from the concepts)

One main log lodge, much bigger than the rest, with a smokehouse and an open lean-to shed beside it, round a small bare
yard; a rail fence with a gap where the path comes in. Not an equal ring like the camp: **a `ring` with one required big
building and two small ones**, yard radius ~10-14 m (polygon yard option fits: a rough clearing, not a circle).
No felled field: `clearing` small (~20-30 m), `stumps` low (~0.2), trees close behind the buildings. No skid trail.

## Concept element -> what we build

| Concept element | Existing | New |
|---|---|---|
| Long low log lodge, steep mossy shingle roof, stone footing, stone smoke stack, shuttered window, plank door | `cabin` plan, `logWall`, `shingleRoof`, `stoneChimney`, `timberWindow`, `timberDoor`, rubble plinth (as the bunkhouse) | **building `huntingLodge`**: 5-6 bays x 3, one storey + loft, a lean-to on the back, no porch roof; roof pitch steeper if the roof part allows; moss tint on the shingles |
| Small smokehouse (dark, hung meat) | `toolShed` | building `smokehouse` later; start with a toolShed in its place |
| Open lean-to shed | `stable` (open shed) | none |
| Antlers over the door | - | optional wall part `antlerMount` (needs code; ask first, organic) |
| Firewood against the walls | props `logStack`, group `woodCorner` | none |
| Chopping block | prop `choppingBlock` | none |
| Rail fence, gate | `railFence`, `fieldGate`, `wicketGate` | none |
| Tools on the wall | `toolRack` | none |
| Hide-drying frame | - | **prop `hideFrame`** (generator in `props/generators/woodwork.ts`) |
| Game gallows with a hung deer | - | **prop `gameGallows`** (same file; the deer is the organic piece: ask before modelling, start with a simple hung carcass of capsules) |
| Hound shelter, open front, straw, chain post | - | **prop `houndKennel`** |
| Fire ring | - | skip for now |

## Dimensions (concept scale checked against the man; values to build, at the ~2x detail rule where it applies)

- Gallows: posts ~3 m, crossbar ~2.8 m long at ~2.7 m, span ~2.8 m; deer hangs nose ~0.8 m off the ground.
- Hide frame: posts ~2.4-2.6 m (uneven by ~0.2), crossbar ~2 m wide, hide ~1.2 m laced with cords.
- Hound shelter: ~2.5 m wide, ~1.8 m front height, 1.6 m deep, open front, chain post 1 m.
- Lodge: eaves ~3.2 m, ridge ~5.5 m, door 2.1 m. Concepts overshoot sizes; trust the bunkhouse's tile grid.

## Build order (bottom to top)

1. The three props (workbench `props/` previews), one at a time.
2. Building `huntingLodge` (workbench buildings, interior: one room + loft, per the interiors requirements).
3. Feature `huntingLodge.json5` (compound), biome odds (snowy taiga, autumn wood, bluebell wood), probe, `npm run shot -- features/huntingLodge`.
4. Update FEATURES.md row, CONCEPTS.md.

## Must have / must not

Have: one big log lodge + 1-2 small outbuildings, stone footing, steep shingle roof, trophies by the door,
firewood at the walls, gallows, hide frame, kennel, chopping block, light fence with a path gap.
Not: brick chimney, glass panes, wagons, horses, stone or thatch walls, a large felled clearing.

## Status (built)

Props (src/world/props/generators/lodge.ts, one json5 each in props/, each headed by a description written from
its concept image): hideFrame, gameGallows, houndKennel, firewoodStack (split billets, not the long-log logStack),
campfire (stone ring, flame + light from `effects`), antlerMount and herbBundle (wall props: they furnish the
lodge's hall room, not its outside). Building `huntingLodge`, room `huntersHall`, feature `huntingLodge`
(odds 0.4 in autumn wood, bluebell wood, snowy taiga). Seen with `npm run shot -- props/<id>`,
`buildings/huntingLodge`, `features/huntingLodge`.

Not done / to judge: the hung deer is plain limbs; antlers are straight-segment beams; no exterior wall
decoration exists in the engine (trophies and herbs outside the wall need a new building part that hosts a
prop); the smokehouse is a tool shed and the open shed a stable; the camp's saw-dust/spill and sounds are not
used. Probe (`compounds.local.mjs`, seeds 1338, 7, 42): lodges placed in all three biomes, one "yard not level
by 0.70 m" on a steep site (seed 42, snowy taiga); the 1338 faults are a logging camp's, not the lodge's.

## Revived (after PROP_RENDERING.md steps 1-4)

Merged onto master. The six new materials are `propsOnly: true` (textures of their own, 512 px stone, hide
and antler, 256 px herbs) so they no longer count against the buildings' 32. New in the toolbox: `Shaper.tube`
(a tube along a smoothed path, a radius per point), used by the antlers and the hung deer; the campfire's
stones are smooth domes of the new `smoothStone` (rock, no mortar), not the brick-like rubble. Herbs are three
materials (lavender purple, sage grey-green, yarrow cream) read from the grass plants' colours.

Seen (`npm run shot`): antlers read as antlers, the deer as a hung deer, the herbs as three kinds, the campfire
as smooth stones round a fire. Probe (compounds, seeds 1338 and 42): lodges placed in all three biomes; one
"yard not level, 0.57 m off" on a steep site, the 1338 fault is a logging camp's. The feature shot's camera is
now framed very wide (the zones are half as wide): look at it in the workbench for a close view.
Still rough: the deer's head, the antlers' skull (a ribbed cylinder), the herbs' bunch shape.
