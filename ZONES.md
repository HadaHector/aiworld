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

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Bluebell wood | forestFloor, leafLitter | bluebells, hazel | broadleaf, oak ★, dense | mossy boulders |
| Autumn wood | leafLitter | sparse ferns ★, grass | maple ★, oak ★, gold and red tint | fallen leaves |
| Snowy taiga | snow over forestFloor | none | spruce ★ (snow-laden), dense and dark | full snow cover |

### 3. Jungle (rolling to hilly) - new

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Rainforest | leafyGrass, mud | tall grass, ferns ★ | jungle giant ★, tree fern ★, palm | mist ★ |
| Palm grove | sand, leafyGrass | tufts | palm, dense; mangrove ★ at the water | - |
| Cloud forest | mossyRock, forestFloor | ferns ★ | tree fern ★, twisted mossy broadleaf | heavy mist ★, mossy boulders |

### 4. Wetland (flat) - today: swamp

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Reed marsh | reedbed, mud | bulrush, tall grass | willow ★ here and there | many open pools |
| Cypress bayou | mud, dark water | bulrush | bald cypress ★, willow ★ | hanging moss ★, murky green water |
| Frozen bog | snow, frostPatch, reedbed | dry tufts | stunted spruce ★, dead trees ★ | pools frozen over ★ |

### 5. Scrubland (rolling to hilly) - new

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Maquis | limestone ★, gravel | hazel, dense, dark green | Italian cypress ★, olive ★ | white rock outcrops |
| Red bush | red earth ★ | dry grass, sparse hazel | cactus ★, the odd acacia ★ | red boulders |
| Sage hills | desertGravel, grassPale | tufts, silver-grey | juniper ★ | scattered stones |

### 6. Barrens (flat to rolling) - today: desert

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Sand sea | sand, duneShadow | none | palm oasis at water | big dunes |
| Salt flat | salt crust ★ | none | a lone dead tree ★ | mirage haze ★ (optional) |
| Polar desert | desertGravel and scree, grey | none | the odd dead tree ★ | thin snow, frost-shattered boulders |

### 7. Broken land (hilly, rugged) - today: canyon

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Red canyon | striped rock, red and ochre | dry tufts on the floors | cactus ★ | tall walls |
| Badlands | grey and purple striped silt ★ | none | dead trees ★ | tight gullies |
| Green gorge | rock, mossyRock | meadow on the floors | broadleaf, willow ★ in the bottoms | river at the bottom |

### 8. Highlands (rolling to hilly, open) - today: hills

| Variant | Ground | Plants | Trees | Extras |
|---|---|---|---|---|
| Heather moor | heather ★, mud | tufts | none | bog pools, boulders |
| Alpine meadow | meadowShort, wildflowers | flowers, lawn | spruce ★ at the edges | snow patches up high |
| Windswept fell | scree, grassPale | tufts | juniper ★, stunted spruce ★ | many boulders, thin snow |

### 9. Mountains - today: mountains

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
