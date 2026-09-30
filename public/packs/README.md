# Content packs

Everything the world is generated from that is content rather than code lives here: biomes,
ground materials and their textures, grass, trees, bushes, name voices and border hills. Each folder in
`public/packs/` is one pack. The game loads every pack at startup, so adding a zone is a matter of
dropping files in and reloading the page - no code change, no rebuild. In dev, saving a pack file
reloads the page by itself.

Files are [JSON5](https://json5.org): JSON plus comments, trailing commas and unquoted keys.

To look at one asset on its own, open the **workbench** (`/workbench.html` on the dev server): pick
a material, tree, bush or grass, edit its JSON and preview it - on a patch of ground under the
game's own sun and sky, or as its baked textures. Edits there are not saved; copy them into the
file to keep them. Every other file's JSON is still checked when previewed.

## Layout

```
packs/<pack>/
  pack.json5              { name, description?, priority? }
  defaults.json5          fallbacks for anything a biome leaves out
  biomes/<id>.json5       a kind of zone
  materials/<id>.json5    a ground surface: texture, and the grass that grows on it
  layers/<id>.json5       a material rule applied in every biome (rock on steep slopes, the road)
  grass/<id>.json5        a kind of grass tuft
  trees/<id>.json5        a kind of tree
  bushes/<id>.json5       a kind of bush (trees, bushes and rocks share one set of ids)
  rocks/<id>.json5        a kind of boulder
  voices/<id>.json5       the sounds a zone's names are built from
  borderHills/<id>.json5  the shape of the hills raised along a zone border
  settlements/<id>.json5  a settlement style: how big places grow, their houses and colours
  patches/<any>.json5     additions to another pack's lists
```

A definition's **id is its file name**: `materials/peat.json5` defines the material `peat`, and
anything refers to it as `"peat"`. Packs load in `priority` order (lowest first, then by folder
name), and a later pack's file **replaces** an earlier one with the same folder and name - that is
how one pack overrides another's biome or material.

Everything is checked at load. A mistake - a typo'd field, a missing material, a reference to a
step that does not exist - stops loading and the loading screen lists every problem with its file
and field.

Lists are kept in id order, and generation depends on that order (which biome an area rolls,
which species a tree becomes), so **adding or removing a biome, tree or grass kind reshuffles the
whole world**. Changing values inside a definition only changes what that definition touches.

## Colours

Either `"#rrggbb"` (what a colour picker gives you) or `[r, g, b]` with 0-1 channels.

## Graphs

Heights, tree densities, material weights and textures are all **graphs**: a few noises, then
steps that each compute one named value from earlier ones.

```json5
{
  noises: [{ name: "detail", type: "fbm", octaves: 4, frequency: 0.002, amplitude: 12, persistence: 0.4, lacunarity: 2 }],
  steps: [
    { output: "raw", op: "sample", noise: "detail" },
    { output: "result", op: "offset", input: "raw", amount: 7.5 },
  ],
}
```

Without `outputs`, the result is the last step. A graph with several results names them:
`outputs: { diffuse: "someStep", roughness: "otherStep" }`.

**Noises**: `fbm`, `ridged`, `billow` (each with `octaves`, `frequency`, `amplitude`,
`persistence`, `lacunarity`) and `worley` (`frequency`, `amplitude`, `mode`: `"f1"` the distance to the nearest point - round
stones, cells; `"edge"` the distance to a cell border - cracks; `"cell"` a random 0-1 value of the
nearest point's own, the same across its cell).
A worley noise is a ruled diagram unless shaped, all in cells: `warp` (0.2) bends each side, `sizeJitter` (0-0.5) makes neighbours differ in size, `round` (0.12) rounds the corners where edges meet - see `core/materials/cobblestone.json5`.
A `ridged` noise's crests are knife edges; `crest` (0-1: 0.2 softens them, 0.5 rounds them well over, even on the coarse far-away ground) rounds them at the same height.
In a texture, give `tileCycles` (cycles per texture tile) instead of `frequency`. Any noise can take
`stretch: [x, y]` to elongate its features - `[1, 5]` makes them five times taller than wide (bark
fissures, grain, streaks); a stretched texture still tiles.

Each graph's noises are its own, seeded by the graph and the noise's name. Give a noise
`shared: "someName"` and it is the same noise in every graph that shares that name - two material
rules can fray along one edge (see the biomes' forest floor and leafy grass).

`wave` is parallel bands rather than noise: `{ name: "ripple", type: "wave", frequency: [0, 0.05],
amplitude: 1, shape: "saw" }`. `frequency` is cycles per unit along x and along y, so `[0, f]` gives
horizontal stripes and `[f, f]` diagonal ones; in a texture it is `tileCycles: [x, y]`, which must be
whole numbers so the bands meet at the tile's edge. `shape` is `"sine"` (the default), `"triangle"`
(sharp crests, straight flanks) or `"saw"` (a slow climb and a sudden drop - a sand ripple's lee
side). It runs -1..1 times `amplitude`. Straight, it is a ruler; sampled with an `offset` warp it
becomes wood grain, sand ripples or marble.

**Steps** (`input`, `a`, `b` and a `mix`'s `t` name earlier steps):

| op | fields | |
|---|---|---|
| `sample` | `noise`, `offset?`, `mode?` | the named noise; with `offset: [stepX, stepY]`, sampled at this point moved by those two steps' values (domain warping - bends straight features into wandering ones). `mode` reads a worley noise as another mode, from the same points - outline stones with `"f1"` and give each its own shade with `"cell"` |
| `constant` | `value` | a number |
| `input` | `name` | a value of the ground at this point (below) |
| `color` | `value` | a colour |
| `colorRamp` | `input`, `stops: [{ at, color }]` | a number through a gradient |
| `scale` / `offset` / `power` | `input`, `factor` / `amount` / `exponent` | |
| `abs`, `invert` (1 - x), `luminance` | `input` | |
| `sin` | `input`, `cycles` | sin(2π · input · cycles), -1..1: any signal into repeating bands. On a noise the bands follow its contours (agate, marble); on `height`, strata |
| `clamp` | `input`, `min`, `max` | |
| `remap` | `input`, `inMin`, `inMax`, `outMin`, `outMax` | linear, not clamped |
| `mask` | `input`, `at`, `off` | 1 at `at`, 0 at `off`, clamped - `at` may be either side |
| `add`, `subtract`, `multiply`, `max`, `min` | `a`, `b` | |
| `lerp` | `a`, `b`, `t` (a number) | |
| `mix` | `a`, `b`, `t` (a step) | |

Mixing a colour and a number works channel by channel.

**Inputs** a material layer can read: `height`, `slope` (the ground normal's up component: 1 is
flat, 0 vertical), `slopeFacing` (positive facing north), `reliefCurvature` (positive in hollows
and valleys, negative on ridges), `landmass`, `lakeFactor`, `riverGap` and `roadGap` (distance to
the nearest river / road centreline - a river's waterline is ~22 out at its source, ~62 at its
mouth), and `treeCover` (0-1, how wooded the ground is: the trees' own density graphs and rules,
as smooth as they are, so a forest floor can follow a wood and leave its clearings to meadow). A
tree density graph reads `height`, `slope` (here 0 is
flat, 1 vertical), `riverGap`, `roadGap`, `lakeFactor` and `areaBorderGap`.

### Generators

Anywhere a value is expected, `{ generator: "<name>", ...params }` produces it instead:

| generator | makes | params |
|---|---|---|
| `detailHeight` | a height graph: one fbm noise plus an offset | `amplitude`, `frequency`, `offset`, `octaves?` (4), `persistence?` (0.4) |
| `standDensity` | a tree or bush density for one species | `kind` (or `tree`), `frequency` (stand size), `openAt`, `fullAt` (noise values for none / full), `peak` |
| `rockDensity` | a boulder density: a thin scatter as `standDensity`, plus more where stone collects, in clusters | the same, and optional `footOfSlope` (flattish ground with 16 m of ground rising above it within 30 m), `riverShore` and `lakeShore` (the waterline, ground -0.1 to 0.3, half in the water) - each its density at its fullest |
| `twoSpecies` | a tree density split between two species | `lower`, `upper`, `noises`, `cover` (steps ending in `cover`), `share` (steps ending in `share`) |
| `twoTone` | a material texture: one mottle between two colours | `base`, `variation`, `roughness`, `bumpStrength` |
| `grassland` | a grassy ground texture: clumps, curling blade strokes, ragged bare patches | `dark`, `light`, `soil`, `soilAmount` (0-1), `roughness`, `bumpStrength`, and optionally fallen `leaves` (0-1) in `leafColors: [dark, light]` |
| `snowCover` | a ground layer of snow: ragged patches over a share of the ground, lying longest in hollows and on north faces, plus an optional snow line | `id`, `amount` (0-1 of the ground), and optionally `frequency` (patch size, 0.008), `material` ("snow"), `drifts` (pull into hollows, 0.6), `north` (pull onto north faces, 1.5), `line: [start, full]` (heights), `strength` (2), `chance` |

Generators are code (`src/world/content/generators.ts`); anything they make can also be written
out in full.

## Biomes

```json5
{
  name: "Plains",
  voice: "verdant",           // a voices/ id
  spawnWeight: 2,             // relative chance an area rolls this biome
  lakeChance: 0.05,           // chance a cell becomes a lake (optional, 0)
  borderType: "mountain",     // "mountain" raises border hills (optional, "mountain")
  settlement: "timber",       // a settlements/ style (optional: without one, nobody settles here)
  height: { ... },            // graph: the ground's height
  trees: { ... },             // graph (optional): one output per tree kind, each a 0-1 density
  bushes: { ... },            // graph (optional): the same per bush kind, on a denser lattice of its own
  rocks: { ... },             // graph (optional): the same per rock kind, on the trees' own lattice
  treeTints: [                // optional: recolour this biome's trees, bushes and boulders, rule by rule
    { kinds: ["boulder"], stone: { hue: 10, spread: { value: 0.15 } } },
    { kinds: ["pine"], leaves: { hue: 20 } },   // a tree takes the first rule for its kind...
    {                                           // ...or the first naming no kinds
      leaves: { hue: -40, saturation: 1.2, spread: { hue: 25, saturation: 0.2, value: 0.1 } },
      bark: { value: 0.8 },
    },
  ],
  treeRules: {                // optional, each range falls back to defaults.json5
    shore: [1.5, 6],          // ground height where trees fade in above the water
    line: [70, 95],           // ground height where they fade out: the treeline
    slope: [0.3, 0.72],       // steepness (0 flat, 1 vertical) where they fade out
  },
  ground: {
    base: "grass",            // material wherever no layer outweighs it
    road: "track",            // what roads through this biome are made of
    adjust: { hue, saturation, value, tint },   // optional: recolours all of this biome's ground (see Materials)
    tints: [                  // optional: recolour one family of materials only, after adjust
      { family: "grassland", hue: -30, saturation: 1.2 },   // the meadows turn; roads and rock do not
    ],
    grass: [                  // optional: grass grown on one family of materials, on top of their own -
      { family: "grassland", kind: "clover", density: 0.8, color: [0.36, 0.56, 0.24], chance: 0.35 },
    ],                        // with a chance on each, every area its own flowers (see core/biomes/meadow.json5)
    layers: [                 // material rules for this biome only, on top of layers/
      { id: "plains-dry", material: "grassDry", weight: { ... } },  // id is optional; it seeds the graph's noise
    ],
  },
  sky: { horizon, zenith, cloud, fogStart? },   // horizon is also the fog colour
  light: {
    sunPeak: 65, moonPeak: 45,                   // degrees above the horizon at noon / midnight
    // optional, else defaults.json5: ambientDay, ambientDayIntensity, sunHorizon, sunZenith, sunIntensity
    // optional, else derived from the day: ambientNight, ambientNightIntensity, moonColor, moonIntensity
  },
}
```

Layer weights are shares: they are summed with the universal layers and scaled to fit, and the
base material fills whatever is left. A weight above 1 wins more of a point than the others.

A `treeTints` part (`leaves`, `bark`, or a boulder's `stone`) is a colour adjustment like a material's `adjust` (see
Materials), applied to the finished colour - it can turn a green crown red or blue. Its `spread`
lets each tree stray from it: up to `hue` degrees either way, and `saturation` and `value` as a
fraction either way, so a wood is many shades of its colour rather than one. Each area draws its
trees in 8 shades of each rule.

A rule's `snow` (0-1) lays snow on what it covers: on a boulder's top, and further down its sides the
more there is; on a tree's upper faces - a conifer's tiers, a crown's top - and along its limbs. E.g. `{ kinds: ["boulder"], snow: { range: [0.2, 0.6] } }`.

### Rolls: every area its own

Each area of the world rolls its biome afresh, so no two forests are quite the same forest. Every
area's noises are seeded by the area itself - its hills, stands and ground patterns are its own
without asking - and a biome can leave any value to the dice:

```json5
height: { generator: "detailHeight", amplitude: { range: [32, 50] }, frequency: 0.0014, offset: 27 },
bushes: { chance: 0.8, generator: "standDensity", kind: "hazel", ... },   // 1 in 5 forests has no hazel
ground: {
  base: { oneOf: ["grass", "grassDry"] },
  adjust: { hue: { range: [-8, 8] }, saturation: { range: [0.85, 1.15] } },
},
sky: { horizon: { between: ["#a4baac", "#b4c0a0"] }, ... },
settlement: { oneOf: ["timber", null] },                // null: this area is not settled
```

- `{ range: [min, max] }` - a number between the two; `integer: true` for a whole one.
- `{ between: [colour, colour] }` - a colour on the way from one to the other.
- `{ oneOf: [...] }` - one of the options, each as likely; `null` leaves the field out.
- `chance: p` on any object - kept with probability p, otherwise taken out of its list or its field.

They work anywhere in a biome file, generator parameters and weight graphs included, and nest (an
option can hold ranges). Only `name` and `spawnWeight` cannot roll: they pick the biome for an area
before the area rolls it. When the packs load, each biome is also read at its extremes - every
range at both ends, every option, every chance kept and dropped - so a roll that would break it is
reported then, not in some far-off area. On its own (the workbench, the biome list) a biome is its
middle roll: ranges at their middle, the first option, everything with a chance kept.

Rolls on their own are independent, so two values that ought to agree - snow on the ground and
snow on the trees - can land far apart. A biome's `params` are rolled first, once per area, and
anything in the file can follow one:

```json5
params: { snow: { range: [0, 1] } },
...
{ generator: "snowCover", id: "snow", amount: { param: "snow", to: [0.7, 1] } },
treeTints: [{ snow: { param: "snow", to: [0.3, 0.85] }, ... }],
```

- `{ param: name, to: [a, b] }` - the param mapped from 0-1 onto a to b (two numbers or two
  colours); without `to`, the param itself.

A param is any number, rolled like anything else (a range, a oneOf); `params` itself is not part of
the biome.

A biome's `ground.adjust` gives each area its own variant of every material it draws - one more
entry in the material table, never another texture.

## Materials

```json5
{
  name: "Peat",
  texture: { bumpStrength: 1, pipeline: { ..., outputs: { diffuse: "...", roughness: "...", height: "..." } } },
  grass: [{ kind: "meadow", density: 2, color: [0.4, 0.5, 0.3] }],   // tufts per m2 at full weight
  clearsGrass: 0,             // > 0 removes grass under it (roads use 2)
  detail: { scale: 7.3, strength: 0.55 },   // optional, else defaults.json5's materialDetail
  uvScale: 1,                // laid this many times smaller: 2 puts the 50 m tile on 25 m - author
                             // everything twice the size (and bumpStrength twice) for twice the texels
}
```

`diffuse` is required; `roughness` (0 shiny - 1 matte) and `height` (0-1, drives the bump map) are
optional. A texture is one 50 m tile, baked at load - every texture costs about 11 MB of GPU
memory, and only textures something uses are baked.

A material can instead draw another material's texture, recoloured - a paler meadow, a redder sand -
for no bake and no memory of its own:

```json5
{
  name: "Faded Grass",
  textureFrom: "grass",                 // the material whose texture this one draws (one with its own)
  adjust: { hue: -10, saturation: 0.5, value: 1.4, tint: [1, 0.96, 0.9] },
  grass: [ ... ],                       // its own grass, detail and clearsGrass as usual
}
```

`adjust` works on any material, with its own texture or a borrowed one, and every key is optional:
`hue` turns the colours around the grey axis (degrees, -180 to 180), `saturation` scales how far
they stand from grey (0 grey, 1 unchanged), `value` scales brightness, and `tint` multiplies each
channel. Applied in that order, in the terrain shader; the workbench's texture view shows the
result. Only colour changes - the relief, roughness and height blend are the texture's own.

`family: "grassland"` puts a material in a family, for a biome's `ground.tints`: a tint recolours
every material of its family in an area at once - the meadow, the weeds and the dry grass shift
together - and leaves everything else alone. The grass a recoloured material grows is recoloured
with it (its flowers keep their own colours).

On the ground each texture is drawn three times over: as baked; again `detail.scale` times smaller,
its light and dark and its bumps deepening the baked ones by `detail.strength` (so a 1 m feature
turns up again as 14 cm grain up close - `strength: 0` turns it off); and hugely enlarged and
blurred, for slow patches of lighter and darker ground that do not repeat with the tile. Where
materials meet, `height` decides the edge: the one standing higher wins its high points first -
pebbles come through the sand, leaves lie on the grass, snow fills the rock's hollows - so give a
material with pieces on it (stones, leaves, clumps) a height that rises over them.

Stones, leaves and cobbles are best made from a worley noise: domes around its points (`f1`, masked
and raised to a power under 1 for a rounded top), sized and coloured each its own by the same
noise read as `cell` - see `core/materials/pebbles.json5`. Faceted, angular stones come from the
`edge` mode, which peaks at each point and falls to nothing at the cell's border - see
`core/materials/gravel.json5`.

## Universal layers

`layers/<id>.json5` is `{ material, weight }`, checked in every biome. Exactly one layer has
`roadSurface: true`: it paints each biome's own `ground.road`, and its `material` is the fallback.

## Grass, trees and bushes

See `core/grass/*.json5` and `core/trees/*.json5`. Grass: tuft `width`/`height` in metres,
`sway`, `fadeStart`/`fadeEnd` (camera distance where tufts shrink away - capped in practice by the
first level-of-detail ring), an optional `cluster: { scale, coverage }` for patches, and `blades`
describing the baked blade texture. A flowering kind gives `blades.flowerHeads: { count, radius,
colors: [...] }`, and each tuft's petals take one of its colours. `shape` is how a head is drawn -
`flower` (round petals, the default), `daisy` (rays round an eye), `cup` (a tulip in profile),
`bell` (hanging bells), `raceme` (a spire of florets, lupin), `umbel` (a flat dome of tiny florets,
yarrow), `globe` (a ball, clover or thistle) or `spike` (a cattail); `petals` is its count of petals,
bells, florets or rays, and `eye: [r, g, b]` colours a flower's centre. At most 32 grass kinds in total.

Trees come in two models. `model: "branching"` (see `core/trees/broadleaf.json5`) is generated:
a trunk with a flared base and roots diving into the ground, main branches carrying twigs, and leaf
clumps - crossed cards cut out of a generated texture - at the branch and twig tips, along the outer
branches and on top. Its sections:

- `trunk`: `height`, `radius`/`topRadius`, `lean`, `wobble`, `flare`/`flareHeight`, `sides`, `rings`,
  and optionally `bulge` - the trunk swells to 1 + `bulge` times its girth around `bulgeAt` of the
  way up (default 0.35), a baobab's bottle
- `roots`: `count`, `length`, `radius` (of the trunk's), `drop` (how deep the ends dive), `sides`, `rings`,
  and optionally `buttress: { height, thickness }` - a jungle giant's plank roots instead of round
  ones: wedges on edge, thick at the foot, leaving the trunk `height` metres up and sweeping down to
  dive into the ground at their ends (see `core/trees/kapok.json5`)
- `branches`: `count`, `from` (fraction of the trunk's height), `length`, `radius`, `angle` (degrees
  from vertical), `arc` (how much they curve back up; below 0, over and outwards), `sides`, `rings`,
  `twigs` likewise, and optionally `broken` - the share of branches and twigs snapped off short
- `leaves`: `size` of a card, `cards` per clump, clumps `alongBranch` and on `top`, `spread`, and
  optionally `squash` (a clump's height for its width: below 1, flattened) and `level` (0-1, how far
  every clump is pulled up to the crown's top layer - with a low `squash`, an acacia's umbrella)
- `bark`: `tile` (metres of trunk per texture repeat) and `texture`, a texture graph exactly like a
  material's - u runs around a limb, v along it
- `foliage`: the `broadleaf` clump texture - `dark`/`light`, `leaves` per clump, `leafLength`/`leafWidth`
- `variants`: how many different trees are generated from all this; each placed tree is one of them

Leave out both `leaves` and `foliage` for a bare tree - all wood, no leaves (see
`core/trees/deadTree.json5`).

A `crown` puts a fern's fronds on top of the trunk - a tree fern's, and later a palm's (see
`core/trees/treeFern.json5`): the same settings as a bush's `fronds` (below), its fronds growing out
of the trunk's tapering tip. With a crown, `leaves` may be left out and `foliage` is a bush atlas
(`builder: "fern"`, or one of the broad-leaf builders). A frond bends in the wind from its root.

Trees in distant chunks are drawn with fewer sides and no twigs - the same tree, and the same leaves.

`model: "conifer"` (see `core/trees/pine.json5`) is generated too, differently: a tall tapering
trunk and a crown of stacked open cones - no base to a cone - each a ring of branches from the
trunk out to a drooping rim, every branch a square card showing one of four generated fir-branch
sprays drawn along its diagonal, mirrored at random, its sides arching down. Its sections:

- `trunk`: `height`, `radius`/`topRadius`, `lean`, `bend` (how far the foot sweeps out before the
  trunk straightens up, metres), `wobble` (a slow sway), `flare`/`flareHeight`, `sides`, `rings`
- `roots`: as a branching tree's, shallower
- `tiers`: `count`, `from` (the lowest rim, as a fraction of the trunk's height), `radius` and
  `height` as `[lowest, topmost]`, `droop` (how far each branch bends over - its height falls as
  along^(1 + droop), so 0 is straight and 0.6 leaves the middle a third of the way down), `panels` (branches round a cone, each a
  square card along its diagonal), `breadth` (a branch's width for its length, 1 = the spray's own
  proportions), `arch` (how far its sides fold down from the stem), `tilt` (how far a tier tips),
  `variety` (how much each branch differs: its length by up to this fraction either way, its bend
  by twice that, its drop and width by less)
- `bark`: as a branching tree's
- `foliage`: the `firSpray` atlas - `dark`/`light` needles (old growth to fresh tips), `twig`
  colour, `twigs` down each side, `needleLength`/`needleWidth`/`needleGap` as fractions of a spray

`model: "primitive"` (the default; see `core/trees/palm.json5`) is a `trunk` cylinder and a `crown`
built by one of `sphereCrown`, `tieredCones` or `frondCrown`.

Both take `tint: [dark, light]` - each tree's foliage is multiplied by a random mix of the two - and
an optional `scale: [min, max]` (else `treeScale` from defaults.json5) each tree is sized by at random.

A kind with `growsOld: true` has old trees among its young: defaults.json5's `oldTrees: { share,
size }` makes that share of the tree lattice old, `size` times as big (on top of `scale`). Two trees
stand at least 20 m times the average of their sizes apart, so an old tree clears the young ones
from under its crown. Whether a spot holds an old tree is decided before its species is, so a kind
that does not grow old leaves a small clearing there around a young tree.

Whatever a biome's tree graph asks for, nothing grows in a lake or a road cut.

Bushes (`bushes/<id>.json5`, see `core/bushes/hazel.json5`) have no wood at all: `cards` large cards
crossed through the middle each show a whole bush from the side - stems rising from one root and
forking, leaves over their upper part - and `clumps` smaller crossed cards of `clumpSize` sit over
its top for volume. `width` and `height` are ranges in metres, and `variants`, `tint` and `scale`
work as for trees. `foliage` is the generated `leafyBush` atlas: `dark`/`light` leaves, `stem`
colour, `stems` (a range) rising from the ground, `leaves` per side view, `leafLength`/`leafWidth`,
and `bare`, the bottom fraction where only the stems show.

A bush with `fronds` (see `core/bushes/fern.json5`) is built of fronds instead of cards: `count` of
them round one root, each a strip of `segments` quads `length` long and `width` wide, setting off
`angle` degrees from vertical and curling `curl` degrees further over by its tip, its midrib `fold`
of its width above its edges. Its `foliage` is the `fern` atlas - four single fronds, `leaves`
pairs of leaflets `leafLength`/`leafWidth` in size - and `width`/`height` are only its bounds.

A frond can stand on a bare stalk: `stalk: { length, width }` (metres, before the frond's own
`length`) - a banana's or an elephant ear's leaf on its stem (see `core/bushes/banana.json5`,
`core/bushes/elephantEar.json5`). Such a leaf wants a broad-leaf atlas, one leaf per cell with its
stalk painted in: `paddleLeaf` (a long paddle, torn in `leaves` slits from its edges) or `heartLeaf`
(a heart, `leaves` veins fanning from the stalk), `leafWidth` the blade's half-width as a share of
the cell. A frond's underside is shaded as seen through the leaf, half as bright as its top, and its
top catches a gloss.

Any bush can grow in beds: `bed: { plants, spread }` places `plants` (a range) of it together, the
others up to `spread` metres (times its scale) round the first, each its own size and turn and
standing on its own ground - the bush lattice alone keeps bushes some 6 m apart.

Boulders (`rocks/<id>.json5`, see `core/rocks/boulder.json5`) are generated lumps of stone: a
sphere of `radius` metres swollen and dented by `lumps` (a fraction of the radius), narrowed towards
its top by `taper` (0-1, optional: near 1 a spire - see `core/rocks/termiteMound.json5`), squashed to
`squash` of its width and stretched to `stretch` times it (ranges, each variant somewhere in them),
with `facets` (a range) flat faces sheared off it up to `facetDepth` deep, tipped up to `tilt`
degrees and sunk `sink` of its height into the ground (a range - each variant somewhere in it - so
some sit on the ground and some are half buried). `stone` is its texture, laid on from three
sides: `{ tile, material }` borrows a material's texture and colour (the very bake the ground uses),
`{ tile, texture }` is a graph of its own, and either can take an `adjust`. `variants`, `tint`,
`scale` and `growsOld` work as for trees - an old boulder is the size of a house.

A biome places boulders with its `rocks` graph, one output per rock kind (usually a `rockDensity`),
on a 9 m lattice of their own - dense enough to pile up - keeping clear of tree trunks, with bushes
keeping clear of them. Besides the usual inputs a rock graph can read `uphill`: how far the ground
within 30 m rises above the point, high at the foot of a slope. Boulders keep out of road cuts and
deep water (below -1.2; the water is at 0), but not the `treeRules` - they lie above the treeline,
on the shore and on steep ground as readily as anywhere, each tipped to lie along the slope under it
(up to about 40 degrees). They are not a wood, so they leave the ground under them as it is, and
are placed out to about 800 m. A `treeTints` rule's `stone` recolours them: without a rule naming them, they take the
first rule naming no kinds, whose `stone` is usually unset and leaves them as they are.

Bushes scatter on a 6 m lattice of their own, so they never take a tree's place. They keep clear of
the trees' trunks and gather in their shade: a bush density is met in full under a crown and only in
part out in the open, both sized by each tree's own scale. The biome's `treeRules` apply to them
too, though they come closer to roads. They are only placed within about 400 m of the camera.

## Settlement styles

See `core/settlements/timber.json5`. A style gives each tier (`hamlet`, `village`, `town`) its
radius, street pattern and how full its plots are; its houses' size variants, roof pitch (degrees),
overhang, setback and gaps; and its `look` - the wall texture (built by a code builder, today only
`weatherboard`) and the tints walls, roofs, doors and windows are coloured with. Which tier a place
becomes, and the rules for gates, streets and levelling plots, are the same for every style.

## Example

`examples/packs/moor/` is a complete zone in JSON alone - a biome, two materials, a flowering grass
kind, a tree, a name voice and a patch. Copy it into `public/packs/` to add it to the world.

## Patches

To add to another pack's lists without replacing the whole definition:

```json5
{
  target: "materials/grass",
  append: { grass: [{ kind: "heather", density: 0.5, color: "#8a5a8a" }] },
}
```

A dotted key reaches into nested objects: `append: { "ground.layers": [ ... ] }` on a biome.
