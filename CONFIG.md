# World configs

A world config says how big the world is and which content goes into it. The default is the full
game. Smaller configs make worlds that load in seconds, for working on systems (the server,
gameplay, the HUD) rather than on places.

**Status: done.** `small` and `tiny` are in `public/configs/`.

| Config | World | Content | Shaping the world | `npm run server` start |
|---|---|---|---|---|
| default | 29 zones, 70 settlements | 25 biomes, 74 materials, 40 plant kinds | 10-11 s | 22 s |
| `small` | 4 zones, 18 settlements | meadow, bluebell wood: 27 materials, 7 plant kinds | 2 s | 5.6 s |
| `tiny` | 1 zone, 3 settlements | meadow: 23 materials, 5 plant kinds | 0.5 s | 2.3 s |
| `menu` | 1 zone, no rivers | bluebell wood: the world behind the main menu (FRONTEND.md) | | |

In the page, with the texture cache warm, `?config=small` was ready in 14-20 s and the full world
in 53 s (measured in a hidden browser pane, which runs slower than a visible tab).

## Principles

- **A config filters what the packs already provide.** It never defines content of its own. Every
  pack folder is still a pack; a config only picks among them.
- **Whitelist the roots; keep what they use.** A config names the top-level things it wants (biomes,
  say). Everything those refer to - materials, trees, grass, weathers, settlements, buildings and
  their parts, props, rooms - is kept automatically, and everything nothing kept refers to is
  dropped before it is read. Nobody has to list a biome's forty materials by hand, and a biome that
  gains a reference keeps working.
- **Dropped content costs nothing.** It is never parsed, checked, baked or modelled.
- **A test config is its own world.** Fewer areas and fewer biomes change every roll (see
  `public/packs/README.md`), so a spot in the real world is not in a small one. That is fine for
  testing systems; a place is checked in the full world.
- **One config, every half.** The game, the workbench, `npm run server` and the probes all load
  content through the same config, by name.

## Files

`public/configs/<name>.json5`:

```json5
{
  // How big the world is - over every dimension's own size (see DIMENSIONS.md). Anything left out
  // is the dimension's.
  world: {
    areas: [4, 4],               // how many zones, a range rolled per seed
    rivers: [1, 1],
    riverLength: [6, 8],         // cells
  },
  content: {
    packs: ["core"],             // which pack folders load; all of them if left out
    only: {                      // whitelists of root kinds; a kind left out is kept whole
      biomes: ["meadow", "savanna"],
      dimensions: ["mainland"],  // which dimensions run; all of them if left out
    },
  },
}
```

- **Root kinds** - used for their own sake, so a whitelist may name them: `dimensions`, `biomes`,
  `borderHills`, `voices`. `layers` and `defaults.json5` are always kept: they apply everywhere. Whitelisting
  nothing prunes nothing, so a config that only changes the world's size keeps every definition.
- **Kinds kept only when used**: `materials`, `grass`, `trees`, `bushes`, `rocks`, `weathers`,
  `features`, `settlements`, `buildings`, `buildingParts`, `buildingMaterials`, `rooms`, `props`,
  `propGroups`. A definition is used when its id appears - as a value or a key, anywhere - in
  something kept. Matching any string is generous (an id that happens to equal some other word
  keeps its definition), never mean: nothing a kept definition needs is dropped.
- **Ids the code supplies.** A few ids come from code rather than any file - a biome's road fence
  (`railFence`) and bridge (`bridge`) when it names none, snow cover's `snow` material. They are
  listed in `resolveContent.ts`'s `CODE_DEFAULT_IDS` and always kept; a new default id belongs
  there. If one is missed, nothing breaks quietly: resolving reports the missing reference, as it
  did for the bridge.
- `default` is the full game and needs no file. A world's size is `DEFAULT_WORLD_SHAPE` in
  `content/worldConfig.ts`, then its dimension's `world`, then the config's `world` over both.
- **Dimensions** (DIMENSIONS.md): each resolves its own content - its biome list, filtered by the
  config's `only.biomes` (all of the config's if that leaves none). A link to a dimension the config
  leaves out is dropped.
- A whitelisted id or a pack that does not exist, or a config that does not, is a content error,
  shown on the loading screen like any other.

## Choosing one

| Where | How |
|---|---|
| The game, the workbench, the collision sandbox | `?config=small` in the URL; `default` without |
| `npm run server` | `--config small` |
| Probes | `loadContent({ config: "small", dimension: "isles" })` in `scripts/probe/loadContent.mjs` |

Node reads configs and packs through `scripts/diskContent.mjs`. The server's welcome message
carries the config's name next to its packs, so a client can tell a player what differs. Each
config, and each dimension in it, keeps its own last view in the page (`debug/lastView.ts`): a spot
in the full world is open sea in a small one.

## Layers

```
configs/<name>.json5 → readWorldConfig → { world, packs, only }
packs                → selectPacks(config)        which pack folders to read
                     → resolveContent(packs, config, dimension): prune by the whitelist, the
                       dimension's biomes and what kept content uses, then read and check as always
WorldContent.world   → the world's size, read by planWorld and the river walk (was cells/config.ts)
```

## Steps

1. **World size into the config: done.** `WorldContent.world`, read by `planWorld` and the river
   walk. The default world hashes the same before and after (layout and chunks).
2. **The config reader and pruning: done** - `content/worldConfig.ts`, `pruneEntries` in
   `resolveContent.ts`.
3. **Choosing a config: done** - `?config=` in the game, workbench and collision sandbox,
   `--config` in the server, an option in the probe loader. The workbench's menus still list every pack
   file; what it previews is resolved under the config, so a definition the config drops cannot be
   previewed there.
4. **`small` and `tiny`: done**, timed above.
