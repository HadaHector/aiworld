# Shots: looking at a generated model without the game tab

Status: built 2026-11-13 (steps 1-3, the floating-parts part of 4). Steps 4's rest and 5 not built - see the end.

Checking a generated model by eye cost 30-60 s in the Browser pane (reload, wait for the bake, guess camera
numbers, screenshot, again), and proportion, colour, orientation and gaps were found by the user. Now one
command gives a picture and a text report, in headless Chrome, without touching the game tab or the pane.

## How to use it

```bash
npm run shot -- weapons/sword
```

Writes `shots/core_weapons_sword.png` (gitignored) and prints the report. The asset is the workbench's key,
`core/` may be left off. Options, all `key=value`:

| option | what |
|---|---|
| `view=3q,front,side,back,top,under,head` | which views (default `3q,front,side,back,top`). One view fills the image, for a close look. "front" looks at the way the (first) figure faces; `head` is the top fifth, close. |
| `t=0.5` | time since the preview was built, in seconds - animations are held still at it (stepped at 1/30 s). |
| `t=0:1.2:0.1` or `t=0:1.2/12` | a filmstrip: the first view, a frame per time (from:to:step, or from:to/count). |
| `play=<clip>` | the animation (the Play menu's value, e.g. `gait`, `attack`, `clip.swing`). |
| `mode=lit,backface,...` | looks, a row each: `lit` (the game's), `backface` (back faces red), `id` (a colour per material or building layer), `uv` (checker; magenta = no UVs), `normals`, `overdraw` (layers add up, depth ignored: z-fighting glows), `silhouette` (white shape, plus a 64 px icon in the corner), `unlit` (standard materials only). |
| `size=1600x1000` | the image size. |
| `tab=<view>` | the workbench's own view tab (`tiers`, `armoury`, `lineup`, `placed`, ...). |
| `seed=N`, `herd=3`, `tint=#c08040`, ... | anything else goes to the workbench URL as its option. |
| `out=path.png` | where to write. |
| `again` | build it a second time and compare the hashes (same seed, same mesh). |

Examples:

```bash
npm run shot -- beasts/scorpion herd=3 view=3q,side mode=lit,silhouette
```

```bash
npm run shot -- beasts/boar view=side t=0:1/12
```

```bash
npm run shot -- dungeonParts/cryptCorner view=3q,front mode=backface,overdraw
```

It reuses the dev server on 5173 if it is up, else starts its own Vite (~25-35 s a shot then; less on a
warm server). The same looks are in the workbench by hand: the **Mode** menu, or `&mode=backface` in its URL.
From a console on `workbench.html?asset=...&shot`: `await __workbench.shoot({ views: ["front"], modes: ["uv"] })`
returns a PNG data URL, `await __workbench.report()` the text. With `?shot` the page's render loop is
stopped and time stands still; leave it off for normal use.

### Reading the report

```
sword ornate: 1.12 x 1.45 x 1.07 m (w h d), 1812 triangles, 7 meshes
!     4 triangles wound against their normals
  race_dwarfGear1: 300 tris, 900 verts, 5 pieces
total: 4804 triangles in 16 distinct meshes, 16 materials; hash 2bc9bb13
  value (front, lit): 0.19 mean over 4632 px
```

Lines with `!` are worth a look. Per figure (each root mesh: a body with its gear, a beast, a building
mesh): its size, triangles, and **pieces floating clear** (more than 1 cm) of the rest, posed as drawn.
Per distinct mesh: degenerate triangles, duplicates (drawn twice), **coplanar overlaps** (same plane, same
facing, overlapping, not the same triangle - z-fighting), triangles wound against their normals (against
the mesh's own majority), non-manifold edges, and open edges (not flagged: cut walls and cards have them by
design). **value** is the lit front's mean brightness where the silhouette is; under 0.15 or over 0.85 is flagged.

## What is where

- `scripts/shot/cdp.mjs` - a ~70-line Chrome DevTools Protocol driver over Node's built-in `WebSocket`
  (Chrome, else Edge, `--use-angle=swiftshader`; `CHROME_PATH` to choose). No packages.
- `scripts/shot/shot.mjs` - the command: server, page, waits for `__workbench.shotReady()`, shoot, report.
- `src/workbench/shot.ts` - views, framing, labels, the 1.8 m reference figure (props, dungeon parts,
  buildings), held time, the contact sheet, the report.
- `src/workbench/debugMaterial.ts` - one debug shader (skinned too) swapped onto every mesh and back; keeps
  the original's winding so front and back agree with the game.
- `src/workbench/meshChecks.ts` - the checks, pure functions on buffers.
- `main.ts` has ~10 lines: the `?shot` hook, the Mode menu, names for weapon tiers and herd beasts.
  `buildingMesh.ts` keeps its CPU copy of vertices only under `?shot`, so the report can read buildings.

## Not built, and why

- **Gaps at joins, parts sunk into the body, foot slide, dungeon socket matching**: each needs knowledge of
  one asset kind (which parts should touch, which bone is a foot, sockets' partners); the filmstrip and
  overdraw show them by eye, and the dungeon probe already checks sockets. Floating pieces are checked.
- **Bounding box vs declared size**: only dungeon parts declare one; the size is printed for every figure.
- **Pixel diff against an accepted render, line-up of a whole kind**: optional; the workbench's own
  `armoury` and `lineup` tabs give line-ups already (`tab=armoury`).
- **Texel density, part axes, section plane**: not needed so far.
- A GPU path: software GL is enough for model checks and leaves the user's GPU alone.
