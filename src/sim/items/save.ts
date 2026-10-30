import type { Entity } from "../entity";
import { deactivate, refreshSlot, receiveItem, wornGear, type ItemContext } from "./belongings";

/** One item as it is saved: its type by id, so a save outlives packs being reordered. */
export interface SavedItem {
  type: string;
  /** u32: its stat rolls. */
  roll: number;
  count: number;
  durability: number;
}

/**
 * A character's things as they are saved (GAMEPLAY.md, *Saved state*; FRONTEND.md, *Saves*): its bag
 * and bank slot by slot, what it wears by slot id, its wallet by currency id. Ids and numbers only,
 * as progress is (progression/save.ts).
 */
export interface SavedBelongings {
  bag: (SavedItem | null)[];
  bank: (SavedItem | null)[];
  equipment: Record<string, SavedItem>;
  wallet: Record<string, number>;
}

export function exportBelongings(ctx: ItemContext, entity: Entity): SavedBelongings | null {
  const b = entity.belongings;
  if (!b) return null;
  const saved = (id: number | null): SavedItem | null => {
    const item = id == null ? undefined : ctx.store.get(id);
    return item ? { type: ctx.items.types[item.type].id, roll: item.roll, count: item.count, durability: item.durability } : null;
  };
  const equipment: Record<string, SavedItem> = {};
  b.equipment.forEach((id, slot) => {
    const item = saved(id);
    if (item) equipment[ctx.items.slots[slot].id] = item;
  });
  const wallet: Record<string, number> = {};
  b.wallet.forEach((amount, currency) => {
    if (amount > 0) wallet[ctx.items.currencies[currency].id] = amount;
  });
  return { bag: b.bag.map(saved), bank: b.bank.map(saved), equipment, wallet };
}

/**
 * Loads saved belongings into a character whose belongings were just made (with its template's
 * start items, which go): every item made again in the store, worn ones put on with their effects.
 * A type, slot or currency the packs no longer have is skipped and returned, never an error that
 * stops a load. An item whose bag slot is gone (a smaller bag) goes into the first free one.
 */
export function importBelongings(ctx: ItemContext, entity: Entity, saved: SavedBelongings): string[] {
  const b = entity.belongings;
  if (!b) return ["no belongings"];
  const skipped: string[] = [];
  // What it was made with goes.
  b.equipment.forEach((_, slot) => deactivate(ctx, entity, slot));
  for (const list of [b.bag, b.bank, b.equipment]) {
    list.forEach((id, i) => {
      if (id != null) ctx.store.remove(id);
      list[i] = null;
    });
  }
  b.wallet.fill(0);

  const make = (item: SavedItem | null | undefined): number | null => {
    if (!item) return null;
    const type = ctx.items.typeIndex.get(item.type);
    if (type === undefined) {
      skipped.push(`item ${item.type}`);
      return null;
    }
    const def = ctx.items.types[type];
    const count = Math.max(1, Math.min(def.stack, Math.floor(item.count) || 1));
    const durability = Math.max(0, Math.min(def.durability, Number(item.durability) || 0));
    return ctx.store.make(type, count, Number(item.roll) >>> 0, durability).id;
  };
  /** Into the bag after all, where its own slot is gone. */
  const stray: number[] = [];
  const fill = (list: (number | null)[], items: readonly (SavedItem | null)[] | undefined): void => {
    (items ?? []).forEach((item, i) => {
      const id = make(item);
      if (id === null) return;
      if (i < list.length) list[i] = id;
      else stray.push(id);
    });
  };
  fill(b.bag, saved.bag);
  fill(b.bank, saved.bank);
  for (const [slotId, item] of Object.entries(saved.equipment ?? {})) {
    const slot = ctx.items.slotIndex.get(slotId);
    const id = make(item);
    if (id === null) continue;
    if (slot === undefined || !ctx.items.types[ctx.store.get(id)!.type].slots.includes(slot)) {
      if (slot === undefined) skipped.push(`slot ${slotId}`);
      stray.push(id);
      continue;
    }
    b.equipment[slot] = id;
    refreshSlot(ctx, entity, slot);
  }
  for (const id of stray) {
    const { left } = receiveItem(ctx, entity, ctx.store.get(id)!);
    if (left > 0) {
      skipped.push(`no room for ${ctx.items.types[ctx.store.get(id)!.type].id}`);
      ctx.store.remove(id);
    }
  }
  for (const [currencyId, amount] of Object.entries(saved.wallet ?? {})) {
    const currency = ctx.items.currencyIndex.get(currencyId);
    if (currency === undefined) skipped.push(`currency ${currencyId}`);
    else b.wallet[currency] = Math.max(0, Math.floor(amount) || 0);
  }
  entity.gear = wornGear(ctx, b);
  return skipped;
}
