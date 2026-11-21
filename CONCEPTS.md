# Concept images: experiment record

Question: does making concept images with the user's ComfyUI (`assets_work/comfyUI/concept.py`) before writing
geometry help build a feature? Feature tried: the **hunting lodge** (FEATURES.md; chosen because it reuses the
logging camp's log buildings, ring layout, props and fence, so the concepts judge the look, not new engine work).
Images are in `assets_work/comfyUI/concepts/<prompt slug>/` (git-ignored; not committed).

## Runs (1344x768, prompt upsampler on, about 1 min per image on this GPU)

| Prompt | Images | Result |
|---|---|---|
| lodge at dusk (antlers, lit window, smoke, outbuilding, wood stacks) | 3 | Best mood image. Reads as a hunting lodge at once. |
| lodge at midday from a path (turf+shingle roof, hide rack, kennel, rail fence) | 3 | Good "way in" and "how it sits in birches". Turf roof is a new look for us. |
| aerial 3/4 (lodge, smokehouse, lean-to, yard, fence, path in) | 3 | Best for layout: lodge + small smokehouse + open lean-to round a bare yard, fence with a gap where the path comes in. |
| yard detail (game on frame, hides, chopping block, kennel, firewood) | 3 | Best prop list. Dimensions not reliable. Drifted to a stone-and-thatch house (wrong). |
| 4-view prop sheets: hide frame, game gallows, kennel (2 each) | 6 | Not usable, see below. |

## What the feature concepts told us

Essential to the feel:
- **Silhouette**: one long, low log lodge with a big steep shingle roof, plus one or two *much smaller* outbuildings
  (smokehouse with hanging meat, open lean-to). Clearly one main building, unlike the camp's equal ring.
- **Materials**: dark weathered logs on a rubble stone footing, grey split shingles gone green with moss; one lit window at dusk.
- **Trophies on the walls** (antlers over the door, game and herb bundles hung on the front) are what says "hunter"
  rather than "logger".
- **Yard**: small, bare earth, firewood stacked against the walls, a chopping block, a hide-drying frame, a game
  gallows (two forks and a crossbar), a kennel/dog corner, a fire ring. Fence is a light rail fence with a gate or
  gap where the path enters.
- **In the trees**: a small clearing right at the wood's edge, trees close behind, a narrow trodden path in. No felled field.

Wrong for our engine:
- Brick/stone chimney (first image, aerial): log cabins of ~1550 had a smoke hole or clay/stone stack; keep it stone or none.
- Glazed multi-pane windows, spoked cartwheels and barrels, horses with proper tack: too late/too detailed. Shuttered holes.
- Midday image's turf roof: fine for a variant, needs a new roof material.
- Painted-in detail (individual shingles, straw, fur) will not survive; per GEOMETRY.md build it at ~2x life size.

Must have: one main log lodge + 1-2 small outbuildings, steep shingle roof, stone footing, trophies by the door,
firewood against walls, gallows, hide frame, chopping block, fence with path gap, dusk window glow/smoke.
Must not: brick chimney, glass, wagons, horses, stone/thatch walls, a big felled clearing.

## Props test (4-view sheets): failed

The model draws four panels with the right captions but does not understand the views: the "top view" is the front
view again, every panel is nearly identical, and the human-for-scale figure is inconsistent between panels (the
kennel is as tall as the man, the gallows posts ~2.5x him). It is a good *look* sheet (the gallows' forks and iron
bands, the kennel's log corners and shingles are usable references) and no source of dimensions. Real dimensions
must come from knowledge (a deer hangs ~1.5 m; gallows crossbar at ~2.2 m, ~2.4 m span; kennel ~1 m) not the picture.

### Retry with bounding boxes (hide frame, 2 images)

Four boxes in a 2x2 grid, each with its own view description (`concept.py --boxes boxes_rack.json`, in
`assets_work/comfyUI/`; output in `concepts_box/`). Better, still not good enough:
- Panels now really are separate and the layout is exact; front view and perspective agree with each other (a
  frame of two posts and a crossbar, a hide laced in with cords): a good look reference.
- The "top view" is now a top-down plan, but a flat empty rectangle (it drew a whole frame, not the thin edge-on
  one asked for), and the side view is the hide again, or an A-frame in one image: orthographic views are still not reliable.
- Words from the box descriptions leak into the picture as labels ("two round pole ends"); no scale is kept.
Verdict: bounding boxes fix the layout, not the geometry. Still no source of dimensions.

## Tool notes

- Works on the first real run: concept.py reached ComfyUI, saved images and the upsampled prompt text.
- Fixed: the folder name was the first 48 letters of the prompt, so the three prop prompts (same start) landed in one
  folder with prompt.txt overwritten. Now a 4-letter hash of the whole prompt is appended. The prop images are in the
  old name `prop-design-sheet-on-plain-light-grey-background/`; seeds ...180 = hide frame, ...181 = gallows, ...182 = kennel.
- Added `--boxes file.json` (boxes as [{bbox: [ymin,xmin,ymax,xmax] on 0-1000, desc}], fed to the node's `bboxes` input).
- Time: 12 feature images 12 min, 6 prop images about 6 min.

## Recommendation (so far)

- Use concepts for **whole-feature mood and composition**: 3-4 prompts (dusk, midday-from-path, aerial, yard detail)
  gave in ~12 minutes what a written brief would not: the small-outbuildings-round-a-big-lodge shape, the trophies, the
  stone footing. Do it *before* the plan, and write "must have / must not" from it, especially the "must not" for
  period (the model likes brick, glass, wagons).
- Use the aerial image as a layout reference; use the detail image as a prop checklist.
- Do not use concepts for dimensions or orthographic views of props.
- Always read the images with period and tech level in mind; the model drifts modern/fantasy-cosy.

## Single image, no grid (hide frame, with a man for scale)

Prompt: one frame, 3/4 view, plain grey background, "a 1.8 m man beside it", no text. Images in
`assets_work/comfyUI/concepts_rack/`. Clean, readable, no stray labels, and the man gives a plausible scale: posts
~2.4-2.6 m, crossbar ~2 m wide, hide ~1.2 m laced with cords at the sides and top. Posts differ in height and
lean a little (hand-made look, good). This is a better prop reference than any grid sheet; use it as step 1 of the
"rotate the image" idea (needs an image-edit workflow, not built yet).

## Final verdict on props (user's own test of the rotate idea)

The user tried to get an orthographic top view out of the single image and could not. So: **concepts are for
look, not blueprints**. For a prop use one clean single image (3/4 view, plain background, a man for scale) for
materials, shape language and rough proportions; take real dimensions from knowledge of the object and GEOMETRY.md's
~2x exaggeration rule, and check them in the workbench preview.

## User's additions (usage guidance)

- For props with a complex shape, prompt for **several views** (front and back, say) on one sheet; they are still
  concept, not blueprint. Do it when the shape needs it, not by default.
- Use the reference images to **pull colors and gradients** for the materials we author (sample the wood, hide, shingle
  and moss tones from the picture instead of guessing).

## Props concepts for the lodge (single image each, n=1, man for scale)

`assets_work/comfyUI/concepts_lodge_props/`: game gallows (crisp; posts ~3 m, bar ~2.7 m, deer nose ~0.8 m off the
ground; uses forked posts), hound kennel (reads as a big open shelter ~2.5 m wide: too big for one dog, fine for a
pack; the chain post is a good detail) and lodge front (best "building elevation" so far: long logs, round-log corner
ends, moss on the ridge, antlers above the plank door, shuttered window, stone stack, firewood). Plan: LODGE.md.
Each image ~1 min at n=1. The three are Flux "man + plain background" prompts; the human figure stays roughly to scale.

## What the build showed (hunting lodge, concept-first)

- The concepts decided the feature's shape before any code: one big lodge with small outbuildings, a polygon
  yard, little felling, and the seven props (the user caught that I had dropped campfire, trophies, herbs and
  firewood: the concept's props list should be walked through item by item before the plan is written).
- Writing a long description per prop from its concept (look, size read against the man, colours) before coding
  was the user's idea and worked: the first-pass props were wrong exactly where I had coded from the name alone
  (gallows deer, firewood, herbs as wicker baskets, antlers too thin). Put the description in the prop's json5 header.
- Mistake to avoid: I coded four props before their concept images had finished. Wait for the images first.
- Plain props (frame, gallows, kennel, ring, rick) came out right in 1-2 passes from the concept; organic ones
  (deer, antlers, herbs) are first approximations and need the user's eye.
- Concept sizes read against the man were used as the starting numbers and held up (kennel 2.4 m, gallows 3 m).
- Time: about 40 min of GPU in total (12 + 6 + 2 + 2 + 3 + 4 images), most of it in the feature concepts.

## Revival notes

- Materials from the concept's colours, made for the props (smooth stone, hide, antler, three herbs), changed the
  look more than any geometry fix did. The tube tool made organic props (antlers, deer) possible in one pass.
- A mask op's direction is not obvious: a floret mask I gated by a noise never showed (no purple); using the cell
  mask directly worked. Test a material's colours alone first.

## Slice concepts (SLICE.md section 8)

12 subjects, 3 images each at 1344x768, in `assets_work/comfyUI/concepts_slice/<slug>/` (git-ignored). Prompts:
`assets_work/comfyUI/prompts_slice.txt`, in the feature lane's order: abandoned camp, motte and bailey, grove,
watermill, cave mouth yard, roadside camp, sheepfold, giant, sheep, bats, cave bear, undead variants. Run with
`python concept.py --file prompts_slice.txt --n 3 --batch 3 --size 1344x768 --out concepts_slice`.
Icons: 18 new slice icons added to `icons.json` (106 in all), 4 variations each in `v2/icons`; pick in
`python review.py --out v2`. The tier is a border or tint drawn by the game, so icons are per type and slot.
