import type { Entity } from "../entity";
import type { GameRules } from "../rules/gameRules";
import type { ItemRules, ItemTypeDef } from "../rules/itemRules";
import { itemStats } from "../rules/itemRules";
import { addModifier, removeSource, statValues } from "../stats";
import { BAG, BANK, EQUIPMENT, type Belongings, type ItemInstance, type ItemStore, type Refusal, type SlotRef } from "./items";
import type { ItemHooks } from "./itemHooks";

/** What the belongings functions work with: the rules, the store and the ability system's hooks. */
export interface ItemContext {
  game: GameRules;
  items: ItemRules;
  store: ItemStore;
  hooks: ItemHooks;
}

/** Empty belongings of the sizes an entity template's `items` gives. */
export function createBelongings(items: ItemRules, bag: number, bank: number): Belongings {
  return {
    bag: new Array<number | null>(bag).fill(null),
    bank: new Array<number | null>(bank).fill(null),
    equipment: new Array<number | null>(items.slots.length).fill(null),
    active: new Array<boolean>(items.slots.length).fill(false),
    wallet: new Array<number>(items.currencies.length).fill(0),
    lootOpen: 0,
    bankOpen: false,
  };
}

/** The modifier and spell source of what is worn in a slot: `item:<slot id>`. */
export const slotSource = (items: ItemRules, slot: number): string => `item:${items.slots[slot].id}`;

const listOf = (b: Belongings, container: number): (number | null)[] | null =>
  container === BAG ? b.bag : container === BANK ? b.bank : container === EQUIPMENT ? b.equipment : null;

/** The item in a slot of the bag, the bank or the equipment, if any. */
export function itemAt(ctx: ItemContext, b: Belongings, ref: SlotRef): ItemInstance | undefined {
  const id = listOf(b, ref.container)?.[ref.slot];
  return id == null ? undefined : ctx.store.get(id);
}

const broken = (type: ItemTypeDef, item: ItemInstance): boolean => type.durability > 0 && item.durability <= 0;

/** Turns a slot's effects on: its item's stats as modifiers and its skill, unless it is broken. */
function activate(ctx: ItemContext, entity: Entity, slot: number): void {
  const b = entity.belongings!;
  const id = b.equipment[slot];
  if (b.active[slot] || id == null) return;
  const item = ctx.store.get(id)!;
  const type = ctx.items.types[item.type];
  if (broken(type, item)) return;
  const source = slotSource(ctx.items, slot);
  if (entity.stats) {
    const values = itemStats(type, item.roll);
    type.stats.forEach((s, i) => {
      if (values[i] !== 0) addModifier(entity.stats!, { stat: s.stat, kind: s.kind, value: values[i], source });
    });
  }
  if (type.equip) ctx.hooks.equip(entity, item, type.equip.skill, source);
  b.active[slot] = true;
}

/** Turns a slot's effects off. */
export function deactivate(ctx: ItemContext, entity: Entity, slot: number): void {
  const b = entity.belongings!;
  if (!b.active[slot]) return;
  const source = slotSource(ctx.items, slot);
  if (entity.stats) removeSource(entity.stats, source);
  ctx.hooks.unequip(entity, source);
  b.active[slot] = false;
}

/** After an item's durability changed: off if it broke, on again if it was mended. */
export function refreshSlot(ctx: ItemContext, entity: Entity, slot: number): void {
  deactivate(ctx, entity, slot);
  activate(ctx, entity, slot);
}

/**
 * The type ids an entity shows on its body: what it wears in visible slots, in slot order (see
 * ITEMS.md, *Equipment*). Broken gear still shows.
 */
export function wornGear(ctx: ItemContext, b: Belongings): string[] {
  const out: string[] = [];
  b.equipment.forEach((id, slot) => {
    if (id == null || !ctx.items.slots[slot].visible) return;
    out.push(ctx.items.types[ctx.store.get(id)!.type].id);
  });
  return out;
}

/** Why an item may not go in an equipment slot, or "" when it may. */
export function canWear(ctx: ItemContext, entity: Entity, item: ItemInstance, slot: number): Refusal {
  const type = ctx.items.types[item.type];
  if (!type.slots.includes(slot)) return "slot";
  if (entity.combat?.dead) return "dead";
  if (type.requires) {
    const values = new Float64Array(ctx.items.statCount + 1);
    if (entity.stats) values.set(statValues(entity.stats));
    values[ctx.items.statCount] = type.itemLevel;
    if (type.requires.run(values) === 0) return "requires";
  }
  return "";
}

/** Equipment slots that must be emptied for an item to go in `slot`: those it fills, and any slot
 *  whose item fills `slot` (a two-handed weapon, when something goes in the off hand). */
function displacedBy(ctx: ItemContext, b: Belongings, item: ItemInstance, slot: number, except: number): number[] {
  const out = new Set<number>();
  for (const fill of ctx.items.types[item.type].fills) if (b.equipment[fill] != null && fill !== except) out.add(fill);
  b.equipment.forEach((id, s) => {
    if (id == null || s === slot || s === except) return;
    if (ctx.items.types[ctx.store.get(id)!.type].fills.includes(slot)) out.add(s);
  });
  return [...out];
}

const freeSlots = (list: (number | null)[]): number[] => list.flatMap((id, i) => (id == null ? [i] : []));

/**
 * Moves an item from one slot to another (see ITEMS.md, *Belongings*): into an empty slot it moves
 * (or splits off `count`), onto the same stacking type it merges, onto anything else the two swap.
 * Into equipment it is an equip, out of it an unequip; what a two-handed item displaces goes to the
 * bag. `count` 0 is the whole stack. Returns why not, or "".
 */
export function moveItem(ctx: ItemContext, entity: Entity, from: SlotRef, to: SlotRef, count = 0): Refusal {
  const b = entity.belongings;
  if (!b) return "cannot";
  const fromList = listOf(b, from.container);
  const toList = listOf(b, to.container);
  if (!fromList || !toList || !(from.slot >= 0 && from.slot < fromList.length) || !(to.slot >= 0 && to.slot < toList.length)) return "slot";
  if ((from.container === BANK || to.container === BANK) && !b.bankOpen) return "bank";
  if (from.container === to.container && from.slot === to.slot) return "";
  const aId = fromList[from.slot];
  if (aId == null) return "empty";
  const a = ctx.store.get(aId)!;
  const bId = toList[to.slot];
  const other = bId == null ? undefined : ctx.store.get(bId);
  const type = ctx.items.types[a.type];
  const wanted = count > 0 ? Math.min(count, a.count) : a.count;

  // Onto the same stacking type: merge what fits; a full stack swaps instead.
  if (other && other.type === a.type && type.stack > 1) {
    const n = Math.min(wanted, type.stack - other.count);
    if (n > 0) {
      other.count += n;
      a.count -= n;
      if (a.count === 0) {
        fromList[from.slot] = null;
        ctx.store.remove(a.id);
      }
      return "";
    }
  }
  // Part of a stack into an empty slot: a new stack.
  if (!other && wanted < a.count) {
    if (to.container === EQUIPMENT) return "slot";
    const part = ctx.store.make(a.type, wanted, a.roll, a.durability);
    a.count -= wanted;
    toList[to.slot] = part.id;
    return "";
  }
  // A swap, or a move into an empty slot.
  if (to.container === EQUIPMENT) {
    const why = canWear(ctx, entity, a, to.slot);
    if (why) return why;
  }
  if (from.container === EQUIPMENT && other) {
    const why = canWear(ctx, entity, other, from.slot);
    if (why) return why;
  }
  const off = new Set<number>();
  const except = from.container === EQUIPMENT ? from.slot : -1;
  if (to.container === EQUIPMENT) for (const s of displacedBy(ctx, b, a, to.slot, except)) off.add(s);
  if (from.container === EQUIPMENT && other) for (const s of displacedBy(ctx, b, other, from.slot, to.container === EQUIPMENT ? to.slot : -1)) off.add(s);
  const free = freeSlots(b.bag).filter((i) => !(to.container === BAG && i === to.slot));
  if (from.container === BAG && !other) free.push(from.slot);
  if (off.size > free.length) return "bagFull";

  if (from.container === EQUIPMENT) deactivate(ctx, entity, from.slot);
  if (to.container === EQUIPMENT) deactivate(ctx, entity, to.slot);
  fromList[from.slot] = other ? other.id : null;
  toList[to.slot] = a.id;
  let i = 0;
  for (const s of off) {
    deactivate(ctx, entity, s);
    // The bag slot `from` was in may be the free one: the swap has already emptied it.
    const into = free[i++];
    b.bag[into] = b.equipment[s];
    b.equipment[s] = null;
  }
  if (to.container === EQUIPMENT) activate(ctx, entity, to.slot);
  if (from.container === EQUIPMENT) activate(ctx, entity, from.slot);
  return "";
}

/** Puts a bag item on, in the first of its slots that is free (else the first of them). */
export function equipItem(ctx: ItemContext, entity: Entity, from: SlotRef): Refusal {
  const b = entity.belongings;
  if (!b) return "cannot";
  const item = itemAt(ctx, b, from);
  if (!item) return "empty";
  if (from.container === EQUIPMENT) return "";
  const slots = ctx.items.types[item.type].slots;
  if (slots.length === 0) return "slot";
  const slot = slots.find((s) => b.equipment[s] == null) ?? slots[0];
  return moveItem(ctx, entity, from, { container: EQUIPMENT, slot }, 0);
}

/** Takes off what is worn in a slot, into the first free bag slot. */
export function unequipItem(ctx: ItemContext, entity: Entity, slot: number): Refusal {
  const b = entity.belongings;
  if (!b || b.equipment[slot] == null) return "empty";
  const free = b.bag.indexOf(null);
  if (free < 0) return "bagFull";
  return moveItem(ctx, entity, { container: EQUIPMENT, slot }, { container: BAG, slot: free }, 0);
}

/** Whether an entity holds an item of a type anywhere: its bag, bank or equipment. */
export function holds(ctx: ItemContext, b: Belongings, type: number): boolean {
  return [...b.bag, ...b.bank, ...b.equipment].some((id) => id != null && ctx.store.get(id)!.type === type);
}

/**
 * Puts an item into an entity's bag: onto stacks of its type first, then into the first empty slot.
 * Returns how many of it are left over (it keeps them): 0 when all went in. An instance merged
 * away entirely is removed from the store; one placed whole lives on in the bag.
 */
export function receiveItem(ctx: ItemContext, entity: Entity, item: ItemInstance): { left: number; why: Refusal } {
  const b = entity.belongings;
  if (!b) return { left: item.count, why: "cannot" };
  const type = ctx.items.types[item.type];
  if (type.quest && holds(ctx, b, item.type)) return { left: item.count, why: "unique" };
  if (type.stack > 1) {
    for (const id of b.bag) {
      if (id == null || item.count === 0) continue;
      const stack = ctx.store.get(id)!;
      if (stack.type !== item.type || stack.id === item.id) continue;
      const n = Math.min(item.count, type.stack - stack.count);
      stack.count += n;
      item.count -= n;
    }
    if (item.count === 0) {
      ctx.store.remove(item.id);
      return { left: 0, why: "" };
    }
  }
  const free = b.bag.indexOf(null);
  if (free < 0) return { left: item.count, why: "bagFull" };
  b.bag[free] = item.id;
  return { left: 0, why: "" };
}

/** Makes `count` of a type and puts them in an entity's bag, stack by stack - start items, debug.
 *  Returns how many did not fit (those are not made). */
export function giveItem(ctx: ItemContext, entity: Entity, type: number, count: number, roll: () => number): number {
  const def = ctx.items.types[type];
  let left = count;
  while (left > 0) {
    const item = ctx.store.make(type, Math.min(left, def.stack), roll(), def.durability);
    const n = item.count;
    const { left: over } = receiveItem(ctx, entity, item);
    if (over > 0) {
      ctx.store.remove(item.id);
      return left - (n - over);
    }
    left -= n;
  }
  return 0;
}

/** Uses an item from the bag: its skill goes off through the hooks, and it is used up if it says so. */
export function useItem(ctx: ItemContext, entity: Entity, from: SlotRef): Refusal {
  const b = entity.belongings;
  if (!b || from.container !== BAG) return "cannot";
  const item = itemAt(ctx, b, from);
  if (!item) return "empty";
  const type = ctx.items.types[item.type];
  if (!type.use) return "cannot";
  if (entity.combat?.dead) return "dead";
  if (!ctx.hooks.use(entity, item, type.use.skill)) return "cannot";
  if (type.use.consume) {
    item.count--;
    if (item.count <= 0) {
      b.bag[from.slot] = null;
      ctx.store.remove(item.id);
    }
  }
  return "";
}

/** Takes an item out of a bag or bank slot whole - to drop it. Quest items cannot be. */
export function takeOut(ctx: ItemContext, entity: Entity, from: SlotRef, count: number): ItemInstance | Refusal {
  const b = entity.belongings;
  if (!b) return "cannot";
  const list = listOf(b, from.container);
  if (!list || !(from.slot >= 0 && from.slot < list.length)) return "slot";
  if (from.container === BANK && !b.bankOpen) return "bank";
  const item = itemAt(ctx, b, from);
  if (!item) return "empty";
  if (ctx.items.types[item.type].quest) return "quest";
  if (count > 0 && count < item.count) {
    item.count -= count;
    return ctx.store.make(item.type, count, item.roll, item.durability);
  }
  if (from.container === EQUIPMENT) deactivate(ctx, entity, from.slot);
  list[from.slot] = null;
  return item;
}

// --- Durability (see ITEMS.md, *Durability and repair*) ---------------------------------------

/** Wears an equipped item down by `amount`; at 0 its effects go until it is repaired. */
export function wearSlot(ctx: ItemContext, entity: Entity, slot: number, amount: number): void {
  const b = entity.belongings;
  const id = b?.equipment[slot];
  if (id == null || amount <= 0) return;
  const item = ctx.store.get(id)!;
  if (ctx.items.types[item.type].durability === 0 || item.durability === 0) return;
  item.durability = Math.max(0, item.durability - amount);
  if (item.durability === 0) refreshSlot(ctx, entity, slot);
}

/** Death: every worn item loses `wear.onDeath` of its maximum. */
export function wearOnDeath(ctx: ItemContext, entity: Entity): void {
  const b = entity.belongings;
  if (!b) return;
  b.equipment.forEach((id, slot) => {
    if (id == null) return;
    const max = ctx.items.types[ctx.store.get(id)!.type].durability;
    wearSlot(ctx, entity, slot, Math.ceil(max * ctx.items.config.wear.onDeath));
  });
}

/** A hit landed: the weapon wears, sometimes. */
export function wearWeapon(ctx: ItemContext, entity: Entity, random: () => number): void {
  const main = ctx.items.slotIndex.get("mainHand");
  const { onHit, hitChance } = ctx.items.config.wear;
  if (main !== undefined && random() < hitChance) wearSlot(ctx, entity, main, onHit);
}

/** A hit was taken: one worn piece that wears - not the weapon - wears, sometimes. */
export function wearArmour(ctx: ItemContext, entity: Entity, random: () => number): void {
  const b = entity.belongings;
  if (!b) return;
  const { onHitTaken, hitChance } = ctx.items.config.wear;
  if (random() >= hitChance) return;
  const main = ctx.items.slotIndex.get("mainHand");
  const worn = b.equipment.flatMap((id, slot) => (id != null && slot !== main && ctx.items.types[ctx.store.get(id)!.type].durability > 0 ? [slot] : []));
  if (worn.length > 0) wearSlot(ctx, entity, worn[Math.floor(random() * worn.length)], onHitTaken);
}

/** What mending everything worn and in the bag would cost, in the main currency. */
export function repairCost(ctx: ItemContext, b: Belongings): number {
  let cost = 0;
  const values = new Float64Array(4);
  for (const id of [...b.equipment, ...b.bag]) {
    if (id == null) continue;
    const item = ctx.store.get(id)!;
    const type = ctx.items.types[item.type];
    if (type.durability === 0 || item.durability >= type.durability) continue;
    values[0] = type.durability - item.durability;
    values[1] = type.durability;
    values[2] = type.value;
    values[3] = type.itemLevel;
    cost += Math.max(0, Math.ceil(ctx.items.config.repairCost.run(values)));
  }
  return cost;
}

/** Mends everything worn and in the bag, paying from the wallet's main currency. */
export function repairAll(ctx: ItemContext, entity: Entity, free = false): Refusal {
  const b = entity.belongings;
  if (!b) return "cannot";
  const cost = repairCost(ctx, b);
  if (cost === 0) return "nothing";
  if (!free && b.wallet[ctx.items.main] < cost) return "money";
  if (!free) b.wallet[ctx.items.main] -= cost;
  for (const id of b.bag) if (id != null) mend(ctx, ctx.store.get(id)!);
  b.equipment.forEach((id, slot) => {
    if (id == null) return;
    mend(ctx, ctx.store.get(id)!);
    refreshSlot(ctx, entity, slot);
  });
  return "";
}

const mend = (ctx: ItemContext, item: ItemInstance): void => {
  item.durability = ctx.items.types[item.type].durability;
};
