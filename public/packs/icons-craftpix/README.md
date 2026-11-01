# icons-craftpix

A starting set of 210 icons for items and skills, made from four **free Craftpix.net icon sets** by
`npm run icons`. The pack is optional: without it the game draws a generated placeholder for every
item kind and skill school (see `ICONS.md` at the repository root). To leave it out of a world, list the
packs you want in the config (`packs: ["core"]`, see `CONFIG.md`), or delete this folder.

## What is here

| File | |
|---|---|
| `pack.json5` | the pack's name and priority (10, after core) |
| `icons/craftpix.png` | the atlas: 16 columns of 64 x 64 cells |
| `icons/craftpix.json5` | the index: each icon's name and `[column, row]` - generated, do not edit |

An item type or skill asks for an icon by name: `icon: "ore-iron"`.

## Rebuilding it

The four zips go in `assets_work/` (git-ignored, at the repository root), then:

```bash
npm run icons
npm run icons -- --sheet assets_work/icons-contact-sheet.png   # also a picture of the atlas
```

The zips are read in memory, nothing is unpacked or run. Options: `--src <folder>`, `--out <pack folder>`,
`--size <cell px>` (a multiple of 32; the default is 64). The catalogue - which file is which name - is
`scripts/icons/catalogue.mjs`: to rename an icon or fix a guess, change it there and rebuild.

How each set is scaled to the 64 px cell:

| Set | Source | Treatment |
|---|---|---|
| weapons, mining | 32 x 32 pixel art, transparent | exactly 2x, nearest neighbour - the pixels stay square |
| ingredients | 512 x 512 painted, transparent | cropped to the picture, area-averaged to fit with a 4 px margin, centred |
| spells | 512 x 512 painted, with a backdrop | the whole square, area-averaged |

## Catalogue

| Names | Count | What | Suits |
|---|---|---|---|
| `weapon-sword-*`, `-dagger-`, `-rapier-`, `-scimitar`, `-sabre-`, `-cleaver*`, `-axe-crimson`, `-mace-jade`, `-banner-purple` | 70 | pixel-art blades, mostly swords, in many colours and hilts (flame, frost, jade, bone, gilded...) | weapons of any tier; melee skills (strikes, bashes, cleaves) |
| `tool-*` | 10 | pickaxe, broken pickaxe, shovel, drills, auger, furnace, saw wheel | tools, mining/crafting skills |
| `ore-*`, `ingot-*`, `gem-*`, `material-*` | 31 | six metals (iron, copper/bronze, crystal/mithril, silver, lava, emerald), each as ore, broken ore, a heap, bits and an ingot | ores, ingots, gems, crafting materials, loot |
| `spell-<school>-*` | 50 | glossy 512 px spell art on a coloured backdrop: fire, frost, lightning, arcane, holy, shadow, nature, earth, blood | spells and abilities of that school, buffs and debuffs |
| `herb-*`, `flower-*`, `mushroom-*`, `fruit-*`, `root-*`, `leaf-*`, `coral-*` | 28 | painted plants and fungi | herbs, reagents, food, potion ingredients |
| `creature-*`, `ooze-*`, `egg-*`, `powder-*`, `potion-*`, `charm-*` | 21 (+ `spores-`, `egg-`) | skulls, insects, a frog, an eyeball, a fang, slimes and powders, bowls of potion, a jewelled charm | monster drops, alchemy reagents, potions, trinkets |

There is **no armour, no food, no key or scroll art** in these sets: those item kinds keep their
placeholders (the placeholder is drawn by `src/ui/icons.ts`). Names describe what an icon
looks like to the person who made the catalogue, and some are guesses (a few "swords" may be maces or
flails) - rename freely.

## Licence

These are Craftpix.net **free** assets (https://craftpix.net/file-licenses/). The licence terms as the
project's owner read them (section 2.1) allow using and modifying them in game projects and
distributing games that contain them, with no attribution required (a credit is appreciated:
*icons by Craftpix.net*). The licence page also has terms (section 2.2) about redistributing the
art files themselves, original or lightly modified; the atlas here is modified art. **If you fork this
repository publicly, read the licence yourself** and, if in doubt, remove this folder (the game works
without it) and keep only the `scripts/icons/` build script, which contains no art.

The owner chose to commit the generated atlas. To stop doing so, add this to `.gitignore`:

```
public/packs/icons-craftpix/icons/craftpix.png
public/packs/icons-craftpix/icons/craftpix.json5
```
