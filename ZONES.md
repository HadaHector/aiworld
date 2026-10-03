# Zones

The plan for growing the world's zones beyond the first eight biomes. Worked through top to bottom,
family by family, adding engine features as a zone first needs them.

## Principles

- **No changing seasons, no realistic distribution.** Zones sit wherever the world puts them; a
  jungle can border a snowfield.
- **The player cannot feel temperature, so it is faked.** A zone's climate is only what can be seen:
  ground and foliage colour, which trees grow, how much snow lies, how much water stands. Wetness
  likewise is lushness, pools and density.
- **Families, not biomes.** Each family below is one biome; its area roll makes many zones of it. The
  three variants listed per family are directions the roll (or a close sibling biome) should reach,
  not a closed list.
- **Retire, don't delete.** A biome a new family replaces moves to `legacy/` at the repo root
  (keeping its pack path, e.g. `legacy/core/biomes/plains.json5`) rather than being deleted. Not
  under `public/packs/`: every folder there is loaded as a pack, so it would still spawn.
- **Trees are the defining feature of a land.** Be generous with new tree kinds - a zone is
  recognised by its trees before anything else.

## Cross-cutting parameters

Any family should be able to roll these per area; together they do most of the climate work.

| Parameter | What it does |
|---|---|
| Snow cover | Amount, and a snow line by height; snow on trees; pools frozen over |
| Tree kinds and density | Which kinds grow, how thick |
| Grass mix | Which grass kinds and flowers, how dense |
| Boulders | Density, which rock kind |
| Water pools | Fraction of standing water on flat ground |
| Mist | Per-area fog density and colour |
| Palette | Ground, foliage and stone tints (exists) |
| Relief | Which lie of the land an area is: `height: { oneOf: [...] }` over flat, rolling, and hills with valleys (the hills' basin graph) - see the bluebell wood; every woodland variant gets it |

## Tree roster

Existing: **broadleaf**, **pine**, **palm**.

| Tree | Look | Used in |
|---|---|---|
| Acacia | flat umbrella crown on a thin forked trunk | golden savanna |
| Baobab | swollen bottle trunk, sparse stubby crown | golden savanna (rare) |
| Dead tree | bare, bleached, broken branches - dried out | savanna, salt flat, frozen bog, badlands, polar desert |
| Birch | white trunk, light airy crown | frost steppe edges, flower meadow, taiga edges |
| Oak | wide, gnarled, low heavy limbs | bluebell wood, autumn wood, flower meadow |
| Maple | round dense crown - red and gold in the autumn tint | autumn wood |
| Spruce | narrow dark cone, dense; a snow-laden variant | snowy taiga, alpine meadow, green alps |
| Stunted spruce | spindly, sparse, leaning | frozen bog, windswept fell |
| Jungle giant | buttress roots, tall bare trunk, high flat canopy | rainforest |
| Tree fern | fibrous trunk, crown of big fronds | rainforest, cloud forest |
| Mangrove | stilt roots standing in water | palm grove (at the water) |
| Bald cypress | flared trunk, feathery crown, hanging moss | cypress bayou |
| Willow | weeping curtain of thin branches | cypress bayou, reed marsh, green gorge |
| Italian cypress | tall narrow dark column | maquis |
| Olive | grey-green crown on a twisted trunk | maquis |
| Juniper | low, twisted, wind-shaped | sage hills, windswept fell, desert range |
| Cactus | columnar, arms | red bush, red canyon |

## Families

★ = new asset.

### 1. Open grassland (flat to rolling) - today: plains, tundra

- **Flower meadow: done** - `biomes/meadow.json5` (plains retired to `legacy/`). Oak and birch
  (lone oaks, birch groves, or both), nine swards, and each area's own flowers rolled over them
  (`ground.grass` with chances); eight flower head shapes.
- **Golden savanna: done** - `biomes/savanna.json5`. Acacia (a flat crown: `leaves.squash` and
  `level`), dead tree (bare: no leaves, `branches.broken`), baobab (`trunk.bulge`), each area its own
  share of each; acacias and thorn bushes (`bushes/thornBush`) gathered in copses with open grass
  between; big stands of head-high elephant grass (`savannaTall`); long gold grass (`savannaGrass`,
  `savannaShort`, `grass/savanna`), red earth
  patches (`redEarth`, new) and a red-earth road (`trackRedEarth`), silt pans in the hollows;
  termite mounds (a boulder with `taper`).
- **Frost steppe: done** - `biomes/frostSteppe.json5` (tundra retired to `legacy/`). Silver feather
  grass (`grass/featherGrass`) and tussocks (`steppeGrass`, `steppeTussock`), gravel on the rises,
  frost in the hollows, boulders, birch groves only along the area's edges. Snow patches from the
  new `snowCover` generator - the first piece of snow cover: an amount per area, drifting into
  hollows and onto north faces, with an optional snow line; snow now clears grass.

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Flower meadow | meadow, wildflowers | long grass, poppies, buttercups, daisies | lone oak ★, birch ★ | - |
| Golden savanna | grassDry, desertSilt patches | dry and tall grass, gold tint | acacia ★, the odd baobab ★ and dead tree ★ | termite mounds ★ |
| Frost steppe | tundraGround, frostPatch | tufts, grey-green | none, birch at the edges | snow patches, boulders |

### 2. Woodland (rolling to hilly) - today: forest

- **Bluebell wood: done** - `biomes/bluebellWood.json5` (forest retired to `legacy/`). A closed
  broadleaf wood, oaks where it thins and in its clearings, hazel, mossy boulders; drifts of a new
  `bluebellCarpet` over the forest floor (`bluebellFloor`), from a few patches to a carpet per area. Each area rolls its relief: a flat lowland wood, rolling
  wooded hills, or hill country cut by wide valleys.
- **Autumn wood: done** - `biomes/autumnWood.json5`. Maples (new) where the wood is thick, oaks
  where it thins, turned crimson to gold; green ferns (a new `fern` bush builder) under them; fallen
  leaves drifting out over golden clearings; a low, warm sun. The same three reliefs.
- **Snowy taiga: done** - `biomes/snowyTaiga.json5`. Spruce (new): a big, narrow, dark cone -
  few large trees rather than many small ones, their crowns closing overhead; snow on the trees (a
  tint rule's `snow` now reaches leaves and bark), each area its own weight of it; snow over nearly
  all the ground, the needle floor showing only under the thickest wood; snowy boulders, the odd
  dead tree in a clearing. The same three reliefs. One `snow` param per area (biome `params`, new)
  drives the ground's snow, the trees' and the stones' together - the frost steppe uses it too.
- **Later:** ferns as a waterside plant too, beside the cattails.

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Bluebell wood | forestFloor, leafLitter | bluebells, hazel | broadleaf, oak ★, dense | mossy boulders |
| Autumn wood | leafLitter | sparse ferns ★, grass | maple ★, oak ★, gold and red tint | fallen leaves |
| Snowy taiga | snow over forestFloor | none | spruce ★ (snow-laden), dense and dark | full snow cover |

### 3. Jungle (rolling to hilly) - new

- **Rainforest: done** - `biomes/rainforest.json5`. A broadleaf canopy with kapoks (new: buttress
  roots, `roots.buttress`) towering over it; tree ferns tall and young (new: a frond `crown` on a
  trunk) in the damp stretches; on a new wet, dark `jungleFloor`, giant ferns and elephant ears
  (new: fronds on a `stalk`, the `heartLeaf` atlas) in beds with open ground between, wild bananas
  (the `paddleLeaf` atlas) by the water; mud banks; a close green haze. Hills or valleys, never flat.
- **Palm grove: done** - `biomes/palmGrove.json5`. Low, gentle ground thick with palms (rebuilt on
  the frond crown, a new `palmFrond` atlas) over leafy grass and pale `beachSand` (new) - a beach
  at the water, sandy patches inland; mangroves (new: stilt roots, `roots.stilt`; `wetFeet`, which
  lets a kind stand in the shallows) in stands along the waterline; the odd banana and elephant ear;
  bright light and a sea haze.
- **Cloud forest: done** - `biomes/cloudForest.json5`. Steep, set low so pools stand in the valleys;
  very tall, crooked cloud giants (new: `vines` - lianas hung and looped from the limbs; `crook` -
  crooked limbs, now on every branching tree) green with moss; tree ferns; giant ferns, ferns and
  elephant ears almost everywhere; half the floor bare red `jungleClay` (new); the thickest mist.

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Rainforest | leafyGrass, mud | tall grass, ferns ★ | jungle giant ★, tree fern ★, palm | mist ★ |
| Palm grove | sand, leafyGrass | tufts | palm, dense; mangrove ★ at the water | - |
| Cloud forest | mossyRock, forestFloor | ferns ★ | tree fern ★, twisted mossy broadleaf | heavy mist ★, mossy boulders |

### 4. Wetland (flat) - today: swamp

- **Reed marsh: done** - `biomes/reedMarsh.json5` (swamp retired to `legacy/`). A marsh at the water,
  half of it pools and channels, and out of it low dry islands (the hills' basins turned round);
  common reed (new `grass/reed`, a `plume` head) in stands (`reedStand`) round every pool,
  `marshGrass` on the islands, a drier sward on their tops and mud on their flanks; willows (new:
  leafy `vines` - twisting ribbons of the new `willowWhip` atlas - arching off the limbs and falling)
  on the low ground, groves of pine, oak or birch on the island tops; a warm haze.
- **Cypress bayou: done** - `biomes/cypressBayou.json5`. Shallow still water over half the land, low
  mud banks and hummocks between; bald cypresses (new: a swollen, fluted foot, level crooked limbs,
  a crown of the new `featherSpray` clumps) wading in it, hung with moss - leafy vines barely
  arching and tapering to a point (`arch`, `taper`), the clump atlas's other half moss, each tree
  grey Spanish moss or an olive beard (`moss: { oneOf }`); knees (`rocks/cypressKnee`) in the
  shallows; willows and dead trees on the banks, ferns on the hummocks. The water's murk is
  duckweed (new: a material that `floats`, drawn on a sheet at the water's surface) in mats against
  the banks with open lanes between, stranded duckweed on the banks; bulrush in patches; shed
  needles; a close green-grey haze. The water no longer rises and falls.
- **Frozen bog: done** - `biomes/frozenBog.json5`. Flat peatland at the waterline, pitted with small
  pools under knee-high hummocks; each area its own depth of snow and its own share of its pools
  frozen over (new `pondIce`, a floating material: milky and clear ice, cracks, bubbles, frost),
  the rest open dark water; red, ochre and green sphagnum (new `sphagnum`), cotton grass in drifts
  (new `grass/cottonGrass`), straw tufts on the rises, snow in the hollows ringed with hoar frost
  (snow no longer lies under water); stunted spruces (new `stuntedSpruce`: scrawny, ragged, leaning
  hard) and grey snags in loose groups on the rises; a cold, low, white haze.

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Reed marsh | reedbed, mud | bulrush, tall grass | willow ★ here and there | many open pools |
| Cypress bayou | mud, dark water | bulrush | bald cypress ★, willow ★ | hanging moss ★, murky green water |
| Frozen bog | snow, frostPatch, reedbed | dry tufts | stunted spruce ★, dead trees ★ | pools frozen over ★ |

### 5. Scrubland (rolling to hilly) - new

- **Maquis: done** - `biomes/maquis.json5`. Limestone hills (new `relief`: steep ground stepped
  into ledges - the new `terrace` - with crags off a ridged noise, real ground) broken by flat
  valley floors (new `smoothMax`, a rolled floor level); new `limestone` on the faces, new
  `terraRossa` patches, dry grass with new `grass/lavender`; thick new `maquisScrub` on the
  hillsides with paths through, olives (new `olive`) and new `oleander` (pink or white, the new
  bush `flowers`) on the valley floors, Italian cypresses (new `italianCypress`, its tiers swept up
  below and drooping above) of every age; bright, warm light.
- **Red bush: done** - `biomes/redBush.json5`. Red earth plains (`smoothMax` again) with low hills
  and buttes rising out of them, their steep sides broken into sandstone ledges and rounded knobs
  (`relief`, a billowed noise) in new `redSandstone`; patches of short gold grass; saguaros (new
  `cactus`: a tree with new `ribs` - pleated limbs with domed ends - and arms that run out level
  and turn up at an elbow, new `branches.bend`/`to`/`taper`) in loose stands, the odd acacia on the
  plains, sparse hazel and thorn; new `redBoulder` at the foot of the rocks; hot, hard light.
- **Sage hills: done** - `biomes/sageHills.json5`. Broad, rounded hills close together; silver
  new `sagebrush` everywhere a step or two apart, pale grass with tufts, gravel on the rises and
  dusty patches; twisted, wind-leaning new `juniper` (shaggy bark, scaly blue-green sprays) few
  over the hills and in open woods up the high ground and ridges; new `fieldStone` lying about.

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Maquis | limestone ★, gravel | hazel, dense, dark green | Italian cypress ★, olive ★ | white rock outcrops |
| Red bush | red earth ★ | dry grass, sparse hazel | cactus ★, the odd acacia ★ | red boulders |
| Sage hills | desertGravel, grassPale | tufts, silver-grey | juniper ★ | scattered stones |

### 6. Barrens (flat to rolling) - today: desert

- **Salt flat: done** - `biomes/saltFlat.json5`. A basin's floor: low stony hills filled up to one
  dead-level floor (height graphs can now read the `bedrock`, so the floor is level in the world),
  new `saltCrust` on it - plates with raised rims - mud pans in it and a dried-mud rim round its
  edge, desert gravel on the hills; a lone dead tree now and then; glaring light. Mirage haze put
  off: screen effects like it wait until the zones are done.
- **Polar desert: done** - `biomes/polarDesert.json5`. Flat to gently rolling grey gravel; new
  `frostPolygons` (patterned ground: silt polygons ringed with frost-sorted stones) in fields on the
  flats, scree on the rises, a thin snow; new `shatteredBoulder` (all broken faces) everywhere, snow
  on their tops; a dead tree very rarely; a low grey sky.
- **Sand sea: done** - `biomes/sandSea.json5`. Dunes from the `wave` noise, which gains a leaning
  triangle (`rise`), rounded corners (`crest`, `trough`) and a rolled `direction`: long windward
  slopes, shorter lee sides, crests swaying and forking, riding on draa; each area its own wind,
  dune size and sand supply. One bare sand (new `duneSand`), a touch darker low down (new
  `duneSandShade`, by height); a broad green belt with palms along rivers, on the low ground only.
  The terrain is now lit with plain Lambert (no half-Lambert wrap), which the dunes needed to show.
- **Rocky desert: done, a detour** - not in the plan: the old `biomes/desert.json5`, upgraded in
  place rather than retired (its feel was worth keeping), after a photo of Nevada's Valley of Fire.
  A flat floor of new `orangeSand` with masses of red sandstone rising steeply out of it - broad
  domes and cliffs, ledges and knobs (`relief`, built up only, faded out at the floor) - new
  `redGravel` round their feet and in patches, red boulders heaped there; new `desertBush` (pale,
  silver) over the floor, the odd cactus. Rivers without a lawn: new `bankSand` with green clumps,
  palms, short tree ferns, a little oleander and thorn.

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Sand sea | sand, duneShadow | none | palm oasis at water | big dunes |
| Salt flat | salt crust ★ | none | a lone dead tree ★ | mirage haze ★ (optional) |
| Rocky desert (detour) | orange sand, red sandstone | pale desert bushes | the odd cactus | red rock masses, boulder rubble |
| Polar desert | desertGravel and scree, grey | none | the odd dead tree ★ | thin snow, frost-shattered boulders |

### 7. Broken land (hilly, rugged) - today: canyon

- **Skipped for now.** All three need a branching valley network - valleys that join, drain
  somewhere and grow downstream, not a noise maze - which is a real engine piece (a drainage tree
  per area, carved by distance, tied to the rivers where one runs through). Too much to get right
  now; worth coming back to. The old `canyon` was retired to `legacy/` and is not to be a base for
  any of it.

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Red canyon | striped rock, red and ochre | dry tufts on the floors | cactus ★ | tall walls |
| Badlands | grey and purple striped silt ★ | none | dead trees ★ | tight gullies |
| Green gorge | rock, mossyRock | meadow on the floors | broadleaf, willow ★ in the bottoms | river at the bottom |

### 8. Highlands (rolling to hilly, open) - today: hills

- **Heather moor: done** - `biomes/heatherMoor.json5`. Each area one of three moors (a `oneOf` of
  whole height graphs): low and rolling, a high plateau with flat tops, bigger rounded hills; bog
  pools in the lowest hollows, filled flat just under the water (heights set in the world, the
  `bedrock` taken off). New `heather` (with new `grass/heather`) and `heatherGrass` (half heather,
  half grass) - a `heath` family, its hue rolled per area - tawny moor grass, new `peat` round and
  under the pools; granite tors on the high ground (new `granite`, `graniteBoulder`); rolled moor
  flowers; very rarely a little birch copse with hazel.
- **Alpine meadow: done** - `biomes/alpineMeadow.json5`. Each area one of three (`oneOf`): broad
  high-pasture swells, a valley between high shoulders (the slopes eased off the floor), or a
  capped high shelf with knolls. Short meadow, new `alpineFlowers` (with new `grass/gentians`) in
  wide drifts on the open, sunny ground, faded grass on the wind-scoured crests, stones in the
  tighter folds and along the streams; spruce in stands below the area's rolled tree line; old
  snow in the high hollows and on the north sides above its rolled snow line; one rolled extra flower.
- **Windswept fell: done** - `biomes/windsweptFell.json5`. Each area one of three (`oneOf`): big
  rounded fells, sharp ridges (a ridged noise) with hollows between, or a capped stony plateau;
  crags (relief ledges and knobs, built up only) on the steep ground, as many as its `crags` roll.
  New `fellGrass` (wind-bitten, hardly a flower), grey tussock patches, scree on the steep sides,
  bare rock on the sheer faces, a thin rolled snow; low junipers in loose groups, a few stunted
  spruce in the sheltered folds; boulders everywhere; a grey sky. Family 8 done (`hills` remains).

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Heather moor | heather ★, mud | tufts | none | bog pools, boulders |
| Alpine meadow | meadowShort, wildflowers | flowers, lawn | spruce ★ at the edges | snow patches up high |
| Windswept fell | scree, grassPale | tufts | juniper ★, stunted spruce ★ | many boulders, thin snow |

### 9. Mountains - today: mountains

- **Green alps: done** - `biomes/greenAlps.json5`. Each area one of three (`oneOf`): high ranges
  with valleys opening between them, sharp ridged peaks floored (`smoothMax`) into valleys, or wide
  green valleys under lower mountains. Meadow and alpine flowers below; spruce in stands to a rolled
  tree line, ferns and hazel under them (the stand noise `shared` with the bushes); pale high
  pasture over it, then rock by height and on steep ground, scree down the upper gullies; snow
  growing with height over a rolled snow line, first in the hollows and on the north faces.

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Green alps | rock, meadowShort low | meadow low down | spruce ★ to a tree line | snow above a high line |
| Ice peaks | snow, rock | none | none | snow down low, glacier ice ★ |
| Desert range | rockAlt red-brown, scree | none | juniper ★ low down | no snow |

## New assets, collected

- **Materials:** limestone, red earth, salt crust, heather, striped silt, glacier ice.
- **Trees:** acacia, baobab, dead tree, birch, oak, maple, spruce (+ snow-laden), stunted spruce,
  jungle giant, tree fern, mangrove, bald cypress, willow, Italian cypress, olive, juniper, cactus.
- **Plants:** fern.
- **Effects:** snow cover and snow line, snow on trees, frozen pools, per-area mist, hanging moss,
  termite mounds, mirage haze.
