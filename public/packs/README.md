# Content packs

Everything the world is generated from that is content rather than code lives here: biomes,
ground materials and their textures, grass, trees, name voices and border hills. Each folder in
`public/packs/` is one pack. The game loads every pack at startup, so adding a zone is a matter of
dropping files in and reloading the page - no code change, no rebuild. In dev, saving a pack file
reloads the page by itself.

Files are [JSON5](https://json5.org): JSON plus comments, trailing commas and unquoted keys.

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
`persistence`, `lacunarity`) and `worley` (`frequency`, `amplitude`, `mode: "f1" | "edge"`).
In a texture, give `tileCycles` (cycles per texture tile) instead of `frequency`.

**Steps** (`input`, `a`, `b` and a `mix`'s `t` name earlier steps):

| op | fields | |
|---|---|---|
| `sample` | `noise` | the named noise |
| `constant` | `value` | a number |
| `input` | `name` | a value of the ground at this point (below) |
| `color` | `value` | a colour |
| `colorRamp` | `input`, `stops: [{ at, color }]` | a number through a gradient |
| `scale` / `offset` / `power` | `input`, `factor` / `amount` / `exponent` | |
| `abs`, `invert` (1 - x), `luminance` | `input` | |
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
the nearest river / road centreline). A tree density graph reads `height`, `slope` (here 0 is
flat, 1 vertical), `riverGap`, `roadGap`, `lakeFactor` and `areaBorderGap`.

### Generators

Anywhere a value is expected, `{ generator: "<name>", ...params }` produces it instead:

| generator | makes | params |
|---|---|---|
| `detailHeight` | a height graph: one fbm noise plus an offset | `amplitude`, `frequency`, `offset`, `octaves?` (4), `persistence?` (0.4) |
| `standDensity` | a tree density for one species | `tree`, `frequency` (stand size), `openAt`, `fullAt` (noise values for none / full), `peak` |
| `twoSpecies` | a tree density split between two species | `lower`, `upper`, `noises`, `cover` (steps ending in `cover`), `share` (steps ending in `share`) |
| `twoTone` | a material texture: one mottle between two colours | `base`, `variation`, `roughness`, `bumpStrength` |

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
  treeRules: {                // optional, each range falls back to defaults.json5
    shore: [1.5, 6],          // ground height where trees fade in above the water
    line: [70, 95],           // ground height where they fade out: the treeline
    slope: [0.3, 0.72],       // steepness (0 flat, 1 vertical) where they fade out
  },
  ground: {
    base: "grass",            // material wherever no layer outweighs it
    road: "track",            // what roads through this biome are made of
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

## Materials

```json5
{
  name: "Peat",
  texture: { bumpStrength: 1, pipeline: { ..., outputs: { diffuse: "...", roughness: "...", height: "..." } } },
  grass: [{ kind: "meadow", density: 2, color: [0.4, 0.5, 0.3] }],   // tufts per m2 at full weight
  clearsGrass: 0,             // > 0 removes grass under it (roads use 2)
}
```

`diffuse` is required; `roughness` (0 shiny - 1 matte) and `height` (0-1, drives the bump map) are
optional. A texture is one 2 m tile, baked at load - every material costs about 11 MB of GPU memory,
and only materials something uses are baked.

## Universal layers

`layers/<id>.json5` is `{ material, weight }`, checked in every biome. Exactly one layer has
`roadSurface: true`: it paints each biome's own `ground.road`, and its `material` is the fallback.

## Grass and trees

See `core/grass/*.json5` and `core/trees/*.json5`. Grass: tuft `width`/`height` in metres,
`sway`, `fadeStart`/`fadeEnd` (camera distance where tufts shrink away - capped in practice by the
first level-of-detail ring), an optional `cluster: { scale, coverage }` for patches, and `blades`
describing the baked blade texture. A flowering kind gives `blades.flowerHeads: { count, radius,
colors: [...] }`, and each tuft's petals take one of its colours. At most 16 grass kinds in total.

Trees come in two models. `model: "branching"` (see `core/trees/broadleaf.json5`) is generated:
a trunk with a flared base and roots diving into the ground, main branches carrying twigs, and leaf
clumps - crossed cards cut out of a generated texture - at the branch and twig tips, along the outer
branches and on top. Its sections:

- `trunk`: `height`, `radius`/`topRadius`, `lean`, `wobble`, `flare`/`flareHeight`, `sides`, `rings`
- `roots`: `count`, `length`, `radius` (of the trunk's), `drop` (how deep the ends dive), `sides`, `rings`
- `branches`: `count`, `from` (fraction of the trunk's height), `length`, `radius`, `angle` (degrees
  from vertical), `arc` (how much they curve back up), `sides`, `rings`, and `twigs` likewise
- `leaves`: `size` of a card, `cards` per clump, clumps `alongBranch` and on `top`, `spread`
- `bark`: the `plates` bark texture - `dark`/`light` colours, `plates` across, `tile` (metres per
  repeat), `bumpStrength`
- `foliage`: the `broadleaf` clump texture - `dark`/`light`, `leaves` per clump, `leafLength`/`leafWidth`
- `variants`: how many different trees are generated from all this; each placed tree is one of them

Trees in distant chunks are drawn with fewer sides and no twigs - the same tree, and the same leaves.

`model: "primitive"` (the default; see `core/trees/pine.json5`) is a `trunk` cylinder and a `crown`
built by one of `sphereCrown`, `tieredCones` or `frondCrown`.

Both take `tint: [dark, light]` - each tree's foliage is multiplied by a random mix of the two - and
an optional `scale: [min, max]` (else `treeScale` from defaults.json5) each tree is sized by at random.

Whatever a biome's tree graph asks for, nothing grows in a lake or a road cut.

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
