/**
 * What each Craftpix icon shows, as the name it gets in the icon set. Four sets, each a list in the
 * order its files sort (numerically) - so a name's place in its list is its file's place. Names say
 * what the icon shows, in `kind-what` form, so an item or skill can ask for `ore-iron` or
 * `spell-frost-nova` without knowing which zip it came from; change one here and rebuild to rename.
 *
 * `suits` in `CATALOGUE.md` of the pack says which item kinds and skills each group is good for.
 */

/** 70 swords and blades, 32x32 pixel art: `icon_32_2_01..30`, then `Iicon_32_01..40`. */
export const WEAPONS = [
  "weapon-sword-ember", "weapon-sword-gold-cross", "weapon-sword-arming", "weapon-sword-jeweled", "weapon-sword-flame",
  "weapon-sword-jade", "weapon-cleaver", "weapon-sword-needle", "weapon-sword-wooden", "weapon-sword-amethyst",
  "weapon-sword-sunfire", "weapon-scimitar", "weapon-mace-jade", "weapon-sword-fire-wave", "weapon-sword-pale-ruby",
  "weapon-sword-broad", "weapon-sword-dark-cross", "weapon-sword-frost", "weapon-sword-slender", "weapon-sword-crimson-teal",
  "weapon-sword-ragged", "weapon-sword-void-shards", "weapon-sword-violet-guard", "weapon-sword-olive-leaf", "weapon-sword-cinder",
  "weapon-sword-teal-guard", "weapon-rapier-red", "weapon-sword-amber-leaf", "weapon-sword-gold-red", "weapon-scimitar-serpent",
  "weapon-sword-plain", "weapon-sword-iron-broad", "weapon-dagger-plain", "weapon-sword-wave-white", "weapon-sword-hooked",
  "weapon-sword-ring", "weapon-cleaver-wrapped", "weapon-sword-sun-gem", "weapon-sword-teal-ornate", "weapon-sword-blood",
  "weapon-sword-feather-red", "weapon-sword-blue-red", "weapon-banner-purple", "weapon-sword-winged-gold", "weapon-sword-bone",
  "weapon-sword-royal-red", "weapon-axe-crimson", "weapon-sword-teal", "weapon-sword-dark-thin", "weapon-sword-olive",
  "weapon-sword-star-red", "weapon-sword-ruby-edge", "weapon-sword-stone", "weapon-sword-teardrop", "weapon-rapier-teal",
  "weapon-sword-golden", "weapon-sword-diamond", "weapon-sword-gold-thin", "weapon-sabre-curved", "weapon-sword-teal-cross",
  "weapon-sword-long-plain", "weapon-sword-curved-guard", "weapon-sword-yellow", "weapon-sword-steel-guard", "weapon-rapier-dark",
  "weapon-sword-brown", "weapon-sword-violet", "weapon-sword-spiked-pommel", "weapon-sword-tan-thin", "weapon-sword-ornate-red",
];

/** 40 mining tools, ores and ingots, 32x32 pixel art: `Icon31_01..40`. From the eleventh on, five to
 *  a metal: ore, broken ore, a heap, bits, an ingot. */
export const MINING = [
  "tool-pickaxe", "tool-pickaxe-broken", "tool-drill-bit", "tool-power-drill", "tool-shovel",
  "tool-hand-drill", "tool-auger", "tool-furnace", "tool-saw-wheel", "tool-cutter",
  "ore-iron", "ore-iron-chunks", "material-stone-heap", "material-pebbles", "ingot-iron",
  "ore-copper", "ore-copper-chunks", "material-sand-pile", "material-wood-scraps", "ingot-bronze",
  "ore-crystal", "material-crystal-shards", "gem-sapphire-lump", "material-crystal-drops", "ingot-mithril",
  "ore-silver", "material-silver-flecks", "material-salt-pile", "material-silver-dust", "ingot-silver",
  "ore-lava", "ore-lava-chunks", "gem-fire-lump", "material-fire-orbs", "ingot-fire",
  "ore-emerald", "ore-emerald-chunks", "gem-emerald-lump", "material-emerald-bits", "ingot-emerald",
];

/** 50 spell icons, 512x512 with their own backdrops: `1..50.png`. Named `spell-<school>-<what>`,
 *  the schools being the ones the core skills are tagged with. */
export const SPELLS = [
  "spell-arcane-slash", "spell-lightning-orb", "spell-fire-burst", "spell-nature-wild-flame", "spell-fire-wall",
  "spell-lightning-storm-bolt", "spell-fire-serpent", "spell-holy-nova", "spell-frost-spike", "spell-holy-sunburst",
  "spell-nature-wind-slash", "spell-arcane-blades", "spell-lightning-chain", "spell-fire-comet", "spell-frost-wall",
  "spell-nature-poison-vortex", "spell-arcane-crystal-wall", "spell-holy-spiral", "spell-frost-nova", "spell-fire-sun-flare",
  "spell-shadow-wisps", "spell-fire-ball", "spell-fire-vortex", "spell-nature-light-beam", "spell-fire-beams",
  "spell-frost-claws", "spell-nature-arrow", "spell-shadow-black-hole", "spell-blood-arc", "spell-frost-comet",
  "spell-shadow-venom-cloud", "spell-frost-tidal-wave", "spell-earth-crack", "spell-arcane-void-burst", "spell-lightning-arc",
  "spell-fire-slash", "spell-lightning-strike", "spell-earth-quake", "spell-earth-ground-crack", "spell-nature-serpent",
  "spell-fire-star", "spell-frost-cloud", "spell-arcane-orb", "spell-nature-haste-arrow", "spell-shadow-vortex",
  "spell-frost-spout", "spell-fire-inferno", "spell-lightning-orb-storm", "spell-holy-star-burst", "spell-nature-burst",
];

/** 50 alchemical ingredients, painted at 512x512 on transparency (the `without background` set):
 *  `1..50.png`. */
export const INGREDIENTS = [
  "fruit-swirl-blue", "root-ginseng", "fruit-red-berries", "coral-red", "egg-pink",
  "creature-skull", "creature-skull-horned", "ooze-green", "ooze-blue", "spores-green",
  "creature-roe-red", "potion-bowl-blood", "potion-bowl-violet", "creature-beetle-gold", "creature-amber-insect",
  "creature-ladybug", "creature-caterpillar", "powder-orange", "powder-green", "powder-violet",
  "potion-dewdrop-green", "mushroom-violet", "mushroom-green", "mushroom-shelf-red", "mushroom-brown",
  "mushroom-red-cluster", "mushroom-fly-agaric", "mushroom-crimson", "mushroom-porcini", "mushroom-yellow",
  "flower-blue", "flower-ember", "herb-lilac", "root-mandrake", "material-gem-cone",
  "fruit-skull-berry", "flower-blue-lotus", "flower-red-lotus", "herb-red-berries", "herb-clover",
  "leaf-lotus-orange", "charm-jewel-red", "leaf-red-brown", "mushroom-blue-glow", "coral-blue",
  "herb-seed-pods-gold", "herb-bulb-red", "creature-eyeball", "creature-fang-wrapped", "creature-frog",
];

/** The sets, in the order they go into the atlas: how to find a set's files in its zip, how to turn
 *  a file name into its place in the list, and how it is scaled (`pixel`: whole-number nearest
 *  neighbour; `tile`: a whole square picture, filtered down; `painted`: cropped to its content,
 *  filtered down and centred with padding). */
export const SETS = [
  { id: "weapons", zip: /weapons/i, find: /(^|\/)Icons\/((?:I?icon_32(?:_2)?_)(\d+))\.png$/, order: (m) => (m[2].startsWith("Iicon") ? 30 : 0) + Number(m[3]) - 1, names: WEAPONS, mode: "pixel" },
  { id: "mining", zip: /mining/i, find: /(^|\/)1 Icons\/Icon31_(\d+)\.png$/, order: (m) => Number(m[2]) - 1, names: MINING, mode: "pixel" },
  { id: "spells", zip: /splash/i, find: /(^|\/)PNG\/(\d+)\.png$/, order: (m) => Number(m[2]) - 1, names: SPELLS, mode: "tile" },
  { id: "ingredients", zip: /alchemical/i, find: /(^|\/)PNG\/without background\/(\d+)\.png$/, order: (m) => Number(m[2]) - 1, names: INGREDIENTS, mode: "painted" },
];
