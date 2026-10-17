import type { ItemState, ServerMessage } from "../sim/protocol";

/** The loot the player has open, as the server last said. */
export interface OpenLoot {
  entity: number;
  items: (ItemState | null)[];
  money: number[];
}

/**
 * The own player's things as the server has told them (see ITEMS.md, *The client*): bag, bank and
 * equipment, the wallet, the open loot, whether the bank is in reach, and the last refusal. The
 * screens draw only from this; they never move an item themselves.
 */
export interface BelongingsMirror {
  /** By container: 0 bag, 1 bank, 2 equipment. */
  readonly containers: (ItemState | null)[][];
  readonly wallet: number[];
  readonly bankOpen: boolean;
  readonly loot: OpenLoot | null;
  /** The last thing the server refused, and when (performance.now()). */
  readonly refused: { reason: string; at: number } | null;
  /** Takes one message; returns whether it was one of the mirror's. */
  apply: (message: ServerMessage) => boolean;
  clear: () => void;
  /** Called after any change. */
  onChange: (listener: () => void) => () => void;
}

export function createBelongingsMirror(): BelongingsMirror {
  const containers: (ItemState | null)[][] = [[], [], []];
  let wallet: number[] = [];
  let bankOpen = false;
  let loot: OpenLoot | null = null;
  let refused: { reason: string; at: number } | null = null;
  const listeners = new Set<() => void>();
  const changed = (): true => {
    for (const listener of listeners) listener();
    return true;
  };
  return {
    containers,
    get wallet() {
      return wallet;
    },
    get bankOpen() {
      return bankOpen;
    },
    get loot() {
      return loot;
    },
    get refused() {
      return refused;
    },
    apply(message) {
      switch (message.type) {
        case "container":
          containers[message.container] = [...message.items];
          return changed();
        case "itemSlot":
          if (containers[message.container]) containers[message.container][message.slot] = message.item;
          return changed();
        case "wallet":
          wallet = message.amounts;
          return changed();
        case "bankReach":
          bankOpen = message.open;
          return changed();
        case "loot":
          loot = message.entity ? { entity: message.entity, items: message.items, money: message.money } : null;
          return changed();
        case "itemRefused":
          refused = { reason: message.reason, at: performance.now() };
          return changed();
        default:
          return false;
      }
    },
    clear() {
      containers.forEach((_, i) => (containers[i] = []));
      loot = null;
      bankOpen = false;
      changed();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
