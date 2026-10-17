import type { Entity } from "../entity";
import type { ClientMessage } from "../protocol";
import type { Refusal, SlotRef } from "./items";
import type { ItemSystem } from "./itemSystem";

const ref = (r: SlotRef): SlotRef => ({ container: r?.container >>> 0, slot: r?.slot >>> 0 });
const count = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * A client's item message, done by the item system for its player (see ITEMS.md, *Messages*).
 * Returns why it was refused, "" when it was done, or null when the message is not an item one.
 */
export function handleItemMessage(system: ItemSystem, player: Entity, message: ClientMessage): Refusal | null {
  switch (message.type) {
    case "itemMove":
      return system.move(player, ref(message.from), ref(message.to), count(message.count));
    case "itemEquip":
      return system.equip(player, ref(message.from));
    case "itemUnequip":
      return system.unequip(player, message.slot >>> 0);
    case "itemUse":
      return system.use(player, ref(message.from));
    case "itemDrop":
      return system.drop(player, ref(message.from), count(message.count));
    case "itemPickUp":
      return system.pickUp(player, message.entity >>> 0);
    case "lootOpen":
      return system.openLoot(player, message.entity >>> 0);
    case "lootTake":
      return system.takeLoot(player, message.slot >>> 0);
    case "lootClose":
      system.closeLoot(player);
      return "";
    case "itemRepair":
      return player.belongings?.bankOpen ? system.repair(player) : "range";
    case "debugItem": {
      const type = system.ctx.items.typeIndex.get(message.item);
      if (type === undefined) return "nothing";
      return system.give(player, type, Math.max(1, count(message.count))) > 0 ? "bagFull" : "";
    }
    case "debugWear":
      if (message.what === "repair") return system.repair(player, true);
      if (message.what === "death" || message.what === "weapon" || message.what === "armour") system.wear(player, message.what);
      return "";
    default:
      return null;
  }
}
