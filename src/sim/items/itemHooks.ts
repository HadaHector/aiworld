import type { Entity } from "../entity";
import type { ItemInstance } from "./items";

/**
 * Where items meet the ability system (see ITEMS.md, *Abilities*; ABILITIES.md's `items`): the one
 * connection point. Items never reach into casting or effects; the server hands the item system
 * the skill system's own hooks.
 */
export interface ItemHooks {
  /** An item was used: cast its skill from the user. True if it went off - the item is then used
   *  up if its type says `consume`. */
  use(user: Entity, item: ItemInstance, skill: string): boolean;
  /** An item went on: give its skill under this source (a passive starts)... */
  equip(wearer: Entity, item: ItemInstance, skill: string, source: string): void;
  /** ...and it came off or broke: take back whatever that source gave. */
  unequip(wearer: Entity, source: string): void;
}

/** Items without an ability system: nothing happens when one is used, and equipping gives no skill. */
export const NO_ITEM_HOOKS: ItemHooks = {
  use: () => false,
  equip: () => {},
  unequip: () => {},
};
