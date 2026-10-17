import type { ItemRules } from "../sim/rules/itemRules";
import type { BodyGear } from "./characterBody";

/**
 * The gear pieces a body wears for the item types an entity shows (ITEMS.md, *Equipment*): each
 * type's pieces, with its tint, in the order the server sent them (slot order). A type these packs
 * lack shows nothing.
 */
export function gearOfItems(items: ItemRules, types: readonly string[]): BodyGear[] {
  return types.flatMap((id) => {
    const index = items.typeIndex.get(id);
    if (index === undefined) return [];
    const type = items.types[index];
    return type.gear.map((piece) => ({ piece, tint: type.tint }));
  });
}
