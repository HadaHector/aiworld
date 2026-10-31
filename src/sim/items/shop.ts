import type { Entity } from "../entity";
import type { VendorStock } from "../rules/itemRules";
import { giveItem, takeOut, type ItemContext } from "./belongings";
import type { Refusal, SlotRef } from "./items";

/**
 * A vendor's shop (NPCS.md, *The vendor's shop*): buying from its stock at an item's value (less a
 * discount for standing), and selling anything that is not a quest item for `sellRate` of its value,
 * by how worn it is. Prices are fixed: no area prices, no buyback, endless stock.
 */

/** What one of a stock's entries costs, a `count` at a time. */
export function buyPrice(ctx: ItemContext, entry: VendorStock["items"][number], discount: number): number {
  return Math.max(1, Math.ceil(ctx.items.types[entry.type].value * entry.count * (1 - discount)));
}

/** What an item fetches, by its count and how worn it is. */
export function sellPrice(ctx: ItemContext, item: { type: number; count: number; durability: number }): number {
  const type = ctx.items.types[item.type];
  const worn = type.durability > 0 ? Math.max(0.2, item.durability / type.durability) : 1;
  return Math.floor(type.value * ctx.items.config.sellRate * item.count * worn);
}

/** Buys a stock entry: paid only for what fits in the bag. */
export function buy(ctx: ItemContext, entity: Entity, stock: VendorStock, index: number, discount: number, roll: () => number): Refusal {
  const b = entity.belongings;
  const entry = stock.items[index];
  if (!b) return "cannot";
  if (!entry) return "slot";
  const price = buyPrice(ctx, entry, discount);
  if (b.wallet[ctx.items.main] < price) return "money";
  const left = giveItem(ctx, entity, entry.type, entry.count, roll);
  if (left === entry.count) return "bagFull";
  b.wallet[ctx.items.main] -= Math.ceil((price * (entry.count - left)) / entry.count);
  return "";
}

/** Sells what is in a bag slot, all of it. */
export function sell(ctx: ItemContext, entity: Entity, from: SlotRef): Refusal {
  const b = entity.belongings;
  if (!b) return "cannot";
  const item = takeOut(ctx, entity, from, 0);
  if (typeof item === "string") return item;
  b.wallet[ctx.items.main] += sellPrice(ctx, item);
  ctx.store.remove(item.id);
  return "";
}
