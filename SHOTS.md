# Shots: looking at a generated model without the game tab

Status: approved 2026-11-13; step 1 (driver + contact sheet + filmstrip) built.

## Why

Checking a generated model by eye costs 30-60 s in the Browser pane (reload, wait for the bake, guess camera
numbers, screenshot, again). Proportion, colour, orientation (upside-down staffs, a stinger the wrong way) and
gaps or z-fighting are judged from pictures, so the user finds them. This makes a picture, and a text report,
one command, without touching the user's game tab or the Browser pane.

## Spike result (done)

Headless Chrome (installed one, Edge as fallback) with `--use-angle=swiftshader` renders the workbench's
WebGL: the sword tier set came up, lit, with shadows, in 13 s cold (Vite start included). No packages: a
~70-line Chrome DevTools Protocol driver over Node 22's built-in `WebSocket` (`scripts/shot/cdp.mjs`).
Node-only Babylon (NullEngine) was rejected: it cannot rasterise, so there would be no pictures.

## What gets built, in order

1. **Driver + contact sheet** - `npm run shot -- <asset> [view=front,side,back,top,head] [t=<s>] [mode=...] [seed=N] [out=file.png]`.
   Reuses the dev server on 5173 if it is up (a separate headless tab, so the user's tab is untouched), else
   starts its own Vite on a spare port. Opens `workbench.html?asset=...&shot`, waits for `__workbench.ready`,
   stops the render loop, then for each view sets `stage.camera` to a fixed angle framed on the model's
   bounds, renders once and reads the stage canvas (`preserveDrawingBuffer` is already on - no UI in the
   picture, fixed size). The views are composed in the page on a 2D canvas, labelled per view, with each
   tier/variant named under it (its bounds projected to the screen), and written to `shots/<asset>.png` -
   one file per command. A single view (`view=side`) fills the whole image instead of a grid cell, for a
   close look; `size=WxH` sets the image size (default 1600x1000) either way.
   The workbench already lays tiers and herds out side by side and holds weapons in a body's hand, so that is
   the scale reference there; for props and dungeon parts a plain 1.8 m figure is added beside the model.
   `t=` freezes animation: the figure and beast previews advance by the engine's frame delta, so the driver
   fixes that delta (1/30 s) and steps to `t` - no change to their code. A range, `t=0:1.2:0.1`
   (from:to:step) or `t=0:1.2/12` (12 frames), gives a filmstrip instead: one view, a grid of frames each
   labelled with its time, for judging a gait or a swing (foot slide, a blade through the body) at a glance.
   `play=<clip>` picks the animation, as the workbench's Play menu does. `main.ts` gets only the `?shot` flag
   and a few lines on the `__workbench` handle; the rest lives in `src/workbench/shot.ts`.
2. **Debug modes** as `mode=` in the workbench URL (works by hand too, a Mode select): a single
   `debugMaterial.ts` swaps every mesh's material and restores it. Order: **backface** (front one colour,
   back red), **part/material ID** (flat colour per material), **UV checker**, **overdraw** (additive
   translucent, coincident faces glow), **silhouette** (flat colour at game distance and icon size), **unlit
   vs lit**. Free with the switch: normals, wireframe (exists already).
3. **Report** (`npm run shot` prints it, also `__workbench.report()`): degenerate triangles, duplicate /
   coincident faces, open edges, flipped winding (face normal vs vertex normal), bounding box vs declared
   size, triangle and material counts, value check (mean luminance of the lit render not near black), same
   seed twice gives the same mesh hash. Pure functions on vertex/index buffers in `src/workbench/meshChecks.ts`.
4. **Placement checks** where the asset has the data: parts floating off / sunk into the body (bounds
   overlap/gap between part meshes), gaps at joins, foot slide in gaits (foot bone speed while planted),
   dungeon sockets matching their partner's position and facing.
5. Optional, last: pixel diff against the last accepted render (`npm run shot -- ... accept`), and a line-up of
   every model of a kind (`<folder>/*`).

## Skipped on purpose (too much for what it gives)

- Texel density, part axes, section plane: only if a mode turns out to be 5 lines once the switch is there.
- A GPU path: software GL is plenty for model checks and leaves the user's GPU alone (they may be gaming).
- Pixel-exact diffs across machines: software GL is deterministic enough on this one; diff is a hint, not a gate.
- Checks on terrain, trees or whole features: the same checks run on any mesh, but nothing is tuned for them.

## Collision with the dungeon session

`src/workbench/main.ts` and `stage.ts` are being edited by the caves and dungeons session (dirty or recent
commits). I will keep `main.ts` changes to a few lines (URL flag, the `__workbench` handle, a Mode select)
and put everything else in new files (`shot.ts`, `debugMaterial.ts`, `meshChecks.ts`, `scripts/shot/*`), staging only my
own hunks.

## Done when

One command gives a labelled contact sheet and a text report for an existing weapon tier set and a beast,
checked by looking at them; a short How-to is added here.
