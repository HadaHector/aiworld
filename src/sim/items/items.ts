/**
 * Item instances and the server's store of them (see ITEMS.md). An instance is a small flat record -
 * its type, its roll, a count and a durability - and everything else about it is worked out from
 * its type and roll (`itemStats`). Containers hold ids, never instances.
 */
export interface ItemInstance {
  /** u32, unique in the store; never reused. The store's next id is saved with the world later. */
  readonly id: number;
  /** Its type's index in the item rules. */
  readonly type: number;
  /** u32: its stat rolls. */
  readonly roll: number;
  /** 1 unless its type stacks. */
  count: number;
  /** Its type's maximum when new; 0 for a type that does not wear. */
  durability: number;
}

/** Where every item on the server is. */
export interface ItemStore {
  get(id: number): ItemInstance | undefined;
  /** Makes a new instance. */
  make(type: number, count: number, roll: number, durability: number): ItemInstance;
  /** An item is gone for good: used up, merged into another stack, expired on the ground. */
  remove(id: number): void;
  readonly size: number;
  /** The next id it will give: saved with the world, so ids stay unique from run to run. */
  readonly nextId: number;
}

export function createItemStore(firstId = 1): ItemStore {
  const items = new Map<number, ItemInstance>();
  let nextId = firstId;
  return {
    get: (id) => items.get(id),
    make(type, count, roll, durability) {
      const item: ItemInstance = { id: nextId++, type, roll: roll >>> 0, count, durability };
      items.set(item.id, item);
      return item;
    },
    remove: (id) => void items.delete(id),
    get size() {
      return items.size;
    },
    get nextId() {
      return nextId;
    },
  };
}

/** Containers, as messages name them (see ITEMS.md, *Belongings*). */
export const BAG = 0;
export const BANK = 1;
export const EQUIPMENT = 2;
/** The loot the player has open: a corpse's, a chest's, an item on the ground. */
export const LOOT = 3;

/** A player's things: its bag, bank and equipment as item ids by slot, and its wallet. */
export interface Belongings {
  bag: (number | null)[];
  bank: (number | null)[];
  /** By equipment slot index. */
  equipment: (number | null)[];
  /** Whether each slot's item is giving its modifiers and skill now - not when broken. */
  active: boolean[];
  /** By currency index. */
  wallet: number[];
  /** The entity whose loot is open, 0 for none. */
  lootOpen: number;
  /** Whether a strongbox is in reach this step: the bank can only be used then. */
  bankOpen: boolean;
}

/** What a corpse, a chest or an item on the ground holds (see ITEMS.md, *Loot*). */
export interface LootPart {
  /** Item ids; a taken one leaves a null so the others keep their places on screen. */
  items: (number | null)[];
  /** By currency index. */
  money: number[];
  /** Whether its table has been rolled into it since it was last emptied. */
  rolled: boolean;
  /** For an entity that drops loot at 0 health: whether it has been above 0 since its last roll. */
  armed: boolean;
  /** How many times it has been rolled: part of the next roll's seed. */
  rolls: number;
  /** World time an emptied container can be rolled again. */
  respawnAt: number;
  /** World time it is gone - an item on the ground; Infinity for the rest. */
  expires: number;
}

/** Why something an item message asked for did not happen - what `itemRefused` says. */
export const REFUSALS = [
  "", "cannot", "empty", "slot", "requires", "bagFull", "range", "quest", "unique", "bank", "dead", "money", "nothing",
] as const;
export type Refusal = (typeof REFUSALS)[number];

/** One slot in a container. */
export interface SlotRef {
  container: number; // u8
  slot: number; // u16
}
