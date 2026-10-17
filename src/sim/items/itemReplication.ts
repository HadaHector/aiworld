import type { Entity } from "../entity";
import type { ItemRules } from "../rules/itemRules";
import type { ItemState, ServerMessage } from "../protocol";
import { BAG, BANK, EQUIPMENT, type ItemStore } from "./items";
import type { ItemSystem } from "./itemSystem";

/** An item as a client is told it - or null for an empty slot. */
export function itemState(items: ItemRules, store: ItemStore, id: number | null | undefined): ItemState | null {
  const item = id == null ? undefined : store.get(id);
  return item ? { id: item.id, type: items.types[item.type].id, roll: item.roll, count: item.count, durability: item.durability } : null;
}

const sig = (s: ItemState | null): string => (s ? `${s.id}/${s.count}/${s.durability}` : "");

/**
 * What one client is told of items (see ITEMS.md, *Messages*): its own containers, wallet, the
 * loot it has open and whether the bank is in reach - as they change - and, for every entity it
 * knows, the gear it shows and whether it has loot. Messages for a step go after the entity
 * messages and before the snapshot.
 */
export interface ItemReplicator {
  update(viewer: Entity | null, known: ReadonlySet<number>, entity: (id: number) => Entity | undefined): ServerMessage[];
  /** Forgets everything - on a Transfer, which clears the client's mirror of entities. Its own
   *  belongings are sent again whole. */
  reset(): void;
}

export function createItemReplicator(items: ItemRules, system: ItemSystem): ItemReplicator {
  const store = system.store;
  let containers: string[][] | null = null;
  let wallet = "";
  let bankOpen: boolean | null = null;
  let loot = "";
  const gear = new Map<number, string>();
  const lootable = new Map<number, boolean>();

  return {
    update(viewer, known, entityOf) {
      const out: ServerMessage[] = [];
      const b = viewer?.belongings;
      if (viewer && b) {
        const lists = [b.bag, b.bank, b.equipment];
        const now = lists.map((list) => list.map((id) => itemState(items, store, id)));
        if (!containers) {
          [BAG, BANK, EQUIPMENT].forEach((container, i) => out.push({ type: "container", container, items: now[i] }));
        } else {
          now.forEach((list, container) =>
            list.forEach((state, slot) => {
              if (sig(state) !== containers![container][slot]) out.push({ type: "itemSlot", container, slot, item: state });
            }),
          );
        }
        containers = now.map((list) => list.map(sig));
        const w = b.wallet.join();
        if (w !== wallet) out.push({ type: "wallet", amounts: [...b.wallet] });
        wallet = w;
        if (b.bankOpen !== bankOpen) out.push({ type: "bankReach", open: b.bankOpen });
        bankOpen = b.bankOpen;
        const source = b.lootOpen ? entityOf(b.lootOpen) : undefined;
        const states = source?.loot ? source.loot.items.map((id) => itemState(items, store, id)) : [];
        const l = source?.loot ? `${source.id}|${states.map(sig).join()}|${source.loot.money.join()}` : "";
        if (l !== loot) out.push({ type: "loot", entity: source?.loot ? source.id : 0, items: states, money: source?.loot ? [...source.loot.money] : [] });
        loot = l;
      }
      for (const id of gear.keys()) if (!known.has(id)) gear.delete(id);
      for (const id of lootable.keys()) if (!known.has(id)) lootable.delete(id);
      for (const id of known) {
        const entity = entityOf(id);
        if (!entity) continue;
        if (entity.gear) {
          const g = entity.gear.join();
          if (gear.get(id) !== g) out.push({ type: "entityGear", id, gear: [...entity.gear] });
          gear.set(id, g);
        }
        if (entity.loot) {
          const can = system.lootable(entity);
          if (lootable.get(id) !== can) out.push({ type: "entityLootable", id, lootable: can });
          lootable.set(id, can);
        }
      }
      return out;
    },
    reset() {
      containers = null;
      wallet = "";
      bankOpen = null;
      loot = "";
      gear.clear();
      lootable.clear();
    },
  };
}
