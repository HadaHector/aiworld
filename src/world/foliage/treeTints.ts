import type { BiomeDefinition, TreeTintPart } from "../biomes/biomeTypes";
import { adjustMatrix, type ColorAdjust, type ColorMatrix } from "../materials/colorAdjust";
import { TREE_SHADE_SALT } from "../cells/config";
import { deriveSeed, mulberry32 } from "../rng";
/** How many shades of its rule's colour an area's trees are drawn in - each tree picks one. Enough
 *  that a wood does not read as a handful of colours, few enough that the table stays tiny. */
export const TREE_SHADES = 8;

/** One shade: the leaves', the bark's and a boulder's stone's colour matrices. */
export interface TreeShade {
  leaves: ColorMatrix;
  bark: ColorMatrix;
  stone: ColorMatrix;
}

/** An area's rule, ready to draw: which kinds it is for (null for all) and its shades. */
export interface TreeTintRule {
  kinds: readonly string[] | null;
  shades: TreeShade[];
}

/** `part`'s adjustment, moved by up to its spread: `r` in -1..1 per channel of the move. */
function strayed({ adjust, spread }: TreeTintPart, hue: number, saturation: number, value: number): ColorAdjust {
  return {
    hue: adjust.hue + hue * spread.hue,
    saturation: adjust.saturation * (1 + saturation * spread.saturation),
    value: adjust.value * (1 + value * spread.value),
    tint: adjust.tint,
  };
}

/**
 * Area `areaId`'s tree colours, from its biome's `treeTints`: each rule's rolled adjustment, and
 * TREE_SHADES shades of it strayed by up to its spread - one shade, the adjustment itself, for a
 * rule without one. Deterministic per (seed, area, rule), so a tree keeps its shade whenever its
 * chunk is built.
 */
export function treeTintRules(seed: number, areaId: number, biome: BiomeDefinition): TreeTintRule[] {
  return biome.treeTints.map((rule, index) => {
    const spreads = [rule.leaves.spread, rule.bark.spread, rule.stone.spread].some((s) => s.hue > 0 || s.saturation > 0 || s.value > 0);
    if (!spreads) {
      return { kinds: rule.kinds, shades: [{ leaves: adjustMatrix(rule.leaves.adjust), bark: adjustMatrix(rule.bark.adjust), stone: adjustMatrix(rule.stone.adjust) }] };
    }
    const random = mulberry32(deriveSeed(deriveSeed(seed, TREE_SHADE_SALT), areaId * 64 + index));
    const signed = (): number => random() * 2 - 1;
    const woods = Array.from({ length: TREE_SHADES }, (_, shade) => {
      // The hue stratified across the spread, so every area gets its whole range, not whatever
      // eight random draws happened to cover; saturation and value drawn freely around it.
      const hue = ((shade + random()) / TREE_SHADES) * 2 - 1;
      return {
        leaves: adjustMatrix(strayed(rule.leaves, hue, signed(), signed())),
        bark: adjustMatrix(strayed(rule.bark, signed(), signed(), signed())),
      };
    });
    // Stone drawn after the rest, so adding it left every tree's shade as it was - and freely in all
    // three: a scatter of boulders is not sorted by colour.
    const shades: TreeShade[] = woods.map((wood) => ({ ...wood, stone: adjustMatrix(strayed(rule.stone, signed(), signed(), signed())) }));
    return { kinds: rule.kinds, shades };
  });
}
