# Icons

Item types and skills have icons: in the inventory, bank, loot window, shop, equipment, quest rewards,
action bar, spell book, item tooltips and the rule book's ability pages. Icons are content: a pack
brings an icon set, a definition names an icon, and the game works with none.

## Decisions

- **An icon is a name.** `icon: "ore-iron"` on an item type or a skill (`items/`, `itemTemplates/` - on
  the template or on a part, a part's wins - and `skills/`). No icon, or a name no loaded pack has,
  means the placeholder; it is never an error, because the pack may be left out on purpose.
- **Core ships no art.** The core pack's items and skills name icons from `icons-craftpix`, which is
  optional (`public/packs/icons-craftpix/README.md`, including its licence note). Without it every
  screen draws placeholders and looks complete.
- **Placeholders are drawn, not loaded.** A coloured glyph per item *kind* (weapon, armour, clothing,
  food, material, key, book, trinket, quest, tool, misc), tinted by the item's rarity, and per skill
  *school* (the `school.<name>` tag: fire, frost, holy, shadow, nature, arcane; a swing for a physical
  skill; any other school gets a colour from its name). On the action bar a placeholder is drawn faint
  with the name over it; a real icon stands alone and the tooltip has the name.
- **One atlas per set, any size.** A set's cell size is only recorded in the build; the screens scale
  an icon to its box with CSS, so a different set (or size) needs no code change.

## Where the icons come from

- `icons-craftpix` (optional, `npm run icons`): the free Craftpix sets, used for skills and as a stopgap.
- `icons-generated` (`npm run icons:generated`): the item icons, made with an image model in ComfyUI. The
  tools live in `assets_work/comfyUI/` (git-ignored: `icons.json` is the list of icons with their prompts and
  the shared style rules, `icongen.py` generates variations in resumable batches, `review.py` is the
  page where you pick one of each). `buildGenerated.mjs` crops every picked cutout to its content and
  fits it into the cell, so all of them fill the icon alike. It is a later pack than craftpix, so its names win.

A quest item's icon is one of a list in the rules, chosen for each quest line (QUESTS.md, *Quest items*);
its tint over the placeholder is another.

## An icon set

`icons/<id>.json5` in any pack:

```json5
{
  atlas: "craftpix.png",   // next to this file
  size: 64,                // a cell's pixels (informational)
  columns: 16, rows: 14,   // the atlas in cells
  icons: { "ore-iron": [0, 5], /* name: [column, row] */ },
}
```

Packs load in priority order and a later pack's name replaces an earlier one's, so a pack can restyle
the set by redefining names. A config's `packs` list (CONFIG.md) leaves a pack out, and with it its icons.

## In the code

`src/ui/icons.ts` is the whole client side: `loadIconSets(sources)` (called when a session starts),
`itemIcon(type, rarityColour)` and `skillIcon(skill)` which say what to draw, and `iconFace`, `iconBox`
and `iconHtml` which draw it into an element or an HTML string. The rules just carry the `icon` string
(`ItemTypeDef.icon`, `SkillDef.icon`); the server never reads it. The world's resolver skips `icons/`.
`npm run probe -- scripts/probe/icons.mjs` checks every icon core names exists in the pack, that content
reads with the pack absent, and that every skill and item type has a placeholder.

## Building the Craftpix set

`npm run icons` (see the pack's README): `scripts/icons/build.mjs` reads the four zips in memory with
its own small zip and PNG readers (no dependencies), scales each set into a 64 px cell, and writes
the atlas and index. `scripts/icons/catalogue.mjs` is the list of names.

## Skill icons (2026-11-28)

A skill draws `skill-<its id>` once a loaded icon set has that name, else the `icon` its file names
(`skillIconName` in `src/ui/icons.ts`). So the generated skill icons (prompts in
`assets_work/comfyUI/skills.json`, 46 of them: the four classes' skills and the effects they put on
targets) take over as they are made, and a skill without one keeps its Craftpix picture. Skills that
share a Craftpix icon today (Poison and Poison Arrow, Smite and Heal, Charge and Dazed) each get one of
their own. Three kinds share instead (the owner's call):

- **The attack** draws the weapon in the main hand, in its rarity's colour (`attackIcon`), on the
  action bar and in the spell book; barehanded it keeps the attack skill's own icon.
- **An effect a skill file names `iconOf`** draws that skill's generated icon: Battle Shout's buff
  (`battleShouted`) is Battle Shout's.
- **An item's use** (a potion's drink, food, the bandage, the quest salve and charm, the tome's reading)
  draws the item's icon (`loadItemUseIcons`), so the potion's effect looks like the potion.
