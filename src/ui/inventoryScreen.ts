import { ACTION_DRAG_TYPE, takenByBar } from "./actionBar";
import { BUTTON_CLASS, DIM, GOLD, HEADING, PANEL, SLOT, SLOT_CLASS, windowHead } from "./theme";
import type { GameRules } from "../sim/rules/gameRules";
import { formatMoney, itemStats, rollQuality, type ItemRules } from "../sim/rules/itemRules";
import type { ClientMessage, ItemState } from "../sim/protocol";
import type { BelongingsMirror } from "../game/belongingsMirror";

/** Containers, as the messages number them. */
const BAG = 0;
const BANK = 1;
const EQUIPMENT = 2;
/** `lootTake`'s slot for everything. */
const TAKE_ALL = 0xffff;

export interface InventoryOptions {
  game: GameRules;
  items: ItemRules;
  mirror: BelongingsMirror;
  send: (message: ClientMessage) => void;
}

export interface InventoryScreen {
  /** Its element, for a HUD region to take (ui/hud.ts). */
  readonly element: HTMLElement;
  readonly visible: boolean;
  toggle: () => void;
  setVisible: (on: boolean) => void;
  dispose: () => void;
}

/** An empty cell: the slot's dark inset square, a little smaller. */
const CELL_STYLE = `${SLOT} border-color: #4d3f26;`;
const CELL = 38;

const REFUSAL_TEXT: Record<string, string> = {
  cannot: "That cannot be done.",
  empty: "There is nothing there.",
  slot: "That does not go there.",
  requires: "You cannot wear that yet.",
  bagFull: "Your bag is full.",
  range: "That is too far away.",
  quest: "Quest items cannot be dropped.",
  unique: "You already have one of those.",
  bank: "The bank is only reached at a strongbox.",
  dead: "Not while dead.",
  money: "You cannot afford that.",
  nothing: "Nothing needs doing.",
};

function el(tag: string, css: string, parent?: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  parent?.appendChild(e);
  return e;
}

/** An item's tooltip: its name in its rarity's colour, what it is, its rolled stats and how well
 *  they rolled, its durability and value - all worked out from its type and roll. */
export function itemTooltip(game: GameRules, items: ItemRules, state: ItemState): string {
  const index = items.typeIndex.get(state.type);
  if (index === undefined) return `<b>${state.type}</b><br><i>not in these packs</i>`;
  const type = items.types[index];
  const rarity = items.rarities[type.rarity];
  const lines = [`<b style="color:${rarity.color}">${type.name}</b>${state.count > 1 ? ` x${state.count}` : ""}`];
  lines.push(`<span style="color:#aaa">${rarity.name} ${type.kind}${type.slots.length ? ` · ${type.slots.map((s) => items.slots[s].name).join(" or ")}` : ""}${type.fills.length ? " · two-handed" : ""}</span>`);
  const values = itemStats(type, state.roll);
  type.stats.forEach((s, i) => {
    if (values[i] === 0) return;
    const kind = game.modifierKinds[s.kind].id;
    const amount = kind === "percent" ? `${values[i] > 0 ? "+" : ""}${values[i]}%` : `${values[i] > 0 ? "+" : ""}${values[i]}`;
    const range = s.min !== s.max ? ` <span style="color:#777">(${s.min}-${s.max})</span>` : "";
    lines.push(`${amount} ${game.stats[s.stat].name}${range}`);
  });
  const quality = rollQuality(type, state.roll);
  if (quality !== null) lines.push(`<span style="color:#9c9">Roll: ${Math.round(quality * 100)}%</span>`);
  if (type.durability > 0) lines.push(`<span style="color:${state.durability === 0 ? "#e55" : "#ccc"}">Durability ${state.durability} / ${type.durability}${state.durability === 0 ? " - broken" : ""}</span>`);
  if (type.itemLevel > 1) lines.push(`<span style="color:#aaa">Item level ${type.itemLevel}</span>`);
  if (type.use) lines.push(`<span style="color:#6c6">Use: ${type.use.skill}</span>`);
  if (type.equip) lines.push(`<span style="color:#6c6">Equip: ${type.equip.skill}</span>`);
  if (type.quest) lines.push(`<span style="color:#fd6">Quest item</span>`);
  if (type.value > 0) lines.push(`<span style="color:#cb8">${formatMoney(items.currencies[items.main], type.value)}</span>`);
  return lines.join("<br>");
}

/** A slot's face: a square in the rarity's colour with the kind's first letter, and a count. */
export function drawItem(cell: HTMLElement, items: ItemRules, state: ItemState | null, label = ""): void {
  cell.innerHTML = "";
  if (!state) {
    if (label) el("div", `position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:${DIM}; opacity: 0.55; font-size:9px; text-align:center;`, cell).textContent = label;
    cell.style.borderColor = "#4d3f26";
    return;
  }
  const index = items.typeIndex.get(state.type);
  const type = index === undefined ? null : items.types[index];
  const color = type ? items.rarities[type.rarity].color : "#f0f";
  cell.style.borderColor = color;
  const face = el("div", `position:absolute; inset:3px; border-radius:3px; background:${color}22; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:16px; color:${color};`, cell);
  face.textContent = (type?.kind ?? "?").charAt(0).toUpperCase();
  if (type && type.durability > 0 && state.durability === 0) face.style.background = "#a0202066";
  if (state.count > 1) el("div", "position:absolute; right:3px; bottom:1px; font-size:11px; color:#fff; text-shadow:0 1px 1px #000;", cell).textContent = String(state.count);
}

/**
 * The inventory screen (see ITEMS.md, *The client*), toggled with B: the equipment slots, the bag,
 * the bank beside them at a strongbox, and the wallet. Drag an item onto a slot to move it there;
 * double-click to put it on, take it off or use it; drag it out of the screen to drop it.
 */
export function createInventoryScreen({ game, items, mirror, send }: InventoryOptions): InventoryScreen {
  const root = el("div", `position: fixed; right: 16px; bottom: 120px; z-index: 950; padding: 10px; display: none; ${PANEL} user-select: none;`, document.body);
  root.addEventListener("contextmenu", (e) => e.preventDefault());
  windowHead(root, "Inventory", () => setVisible(false));
  const columns = el("div", "display: flex; gap: 12px; align-items: flex-start;", root);
  const equipment = el("div", "display: grid; grid-template-columns: repeat(2, auto); gap: 4px;", columns);
  const right = el("div", "display:flex; flex-direction:column; gap:8px;", columns);
  const bag = el("div", `display: grid; grid-template-columns: repeat(5, ${CELL}px); gap: 4px;`, right);
  const bankBox = el("div", "display:none;", right);
  el("div", HEADING, bankBox).textContent = "Bank";
  const bank = el("div", `display: grid; grid-template-columns: repeat(8, ${CELL}px); gap: 4px;`, bankBox);
  const repair = el("button", "margin-top: 6px;", bankBox) as HTMLButtonElement;
  repair.className = BUTTON_CLASS;
  repair.textContent = "Repair all";
  repair.addEventListener("click", () => send({ type: "itemRepair" }));
  const money = el("div", `margin-top: 8px; padding-top: 6px; border-top: 1px solid #4d3f26; color: ${GOLD}; font-weight: 600;`, root);
  const message = el("div", "margin-top: 4px; min-height: 16px; color: #e88;", root);
  const tip = el("div", `position: fixed; z-index: 960; padding: 6px 8px; max-width: 240px; pointer-events: none; display: none; ${PANEL}`, document.body);

  let dragging: { container: number; slot: number } | null = null;
  let dropped = false;

  function cellFor(parent: HTMLElement, container: number, slot: number, label = ""): HTMLElement {
    const cell = el("div", `position: relative; width: ${CELL}px; height: ${CELL}px; ${CELL_STYLE} cursor: pointer;`, parent);
    cell.className = SLOT_CLASS;
    cell.draggable = true;
    cell.dataset.label = label;
    cell.addEventListener("dragstart", (e) => {
      if (!mirror.containers[container]?.[slot]) return e.preventDefault();
      dragging = { container, slot };
      dropped = false;
      e.dataTransfer?.setData("text/plain", "item");
      // An item that is used (food) can go on the action bar too.
      const state = mirror.containers[container]?.[slot];
      const type = state ? items.types[items.typeIndex.get(state.type) ?? -1] : undefined;
      if (state && type?.use) e.dataTransfer?.setData(ACTION_DRAG_TYPE, JSON.stringify({ kind: "item", item: state.type }));
    });
    cell.addEventListener("dragover", (e) => e.preventDefault());
    cell.addEventListener("drop", (e) => {
      e.preventDefault();
      dropped = true;
      if (dragging && (dragging.container !== container || dragging.slot !== slot)) {
        // Shift splits a stack in half.
        const from = mirror.containers[dragging.container]?.[dragging.slot];
        const count = e.shiftKey && from && from.count > 1 ? Math.floor(from.count / 2) : 0;
        send({ type: "itemMove", from: dragging, to: { container, slot }, count });
      }
      dragging = null;
    });
    cell.addEventListener("dragend", (e) => {
      // Let go outside the screen: dropped on the ground.
      const r = root.getBoundingClientRect();
      const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      // Not if something else took it - the action bar takes an item to use, and keeps it in the bag.
      const taken = takenByBar();
      if (!dropped && dragging && outside && !taken) send({ type: "itemDrop", from: dragging, count: 0 });
      dragging = null;
    });
    // Double-click or right-click: put it on, take it off, use it - or move it to and from the bank.
    const activate = (): void => {
      const state = mirror.containers[container]?.[slot];
      if (!state) return;
      const type = items.types[items.typeIndex.get(state.type) ?? -1];
      if (container === EQUIPMENT) send({ type: "itemUnequip", slot });
      else if (container === BANK) {
        const free = mirror.containers[BAG].indexOf(null);
        if (free >= 0) send({ type: "itemMove", from: { container, slot }, to: { container: BAG, slot: free }, count: 0 });
      } else if (type?.slots.length) send({ type: "itemEquip", from: { container, slot } });
      else if (type?.use) send({ type: "itemUse", from: { container, slot } });
      else if (mirror.bankOpen) {
        const free = mirror.containers[BANK].indexOf(null);
        if (free >= 0) send({ type: "itemMove", from: { container, slot }, to: { container: BANK, slot: free }, count: 0 });
      }
    };
    cell.addEventListener("dblclick", activate);
    cell.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      activate();
    });
    cell.addEventListener("mousemove", (e) => {
      const state = mirror.containers[container]?.[slot];
      if (!state) {
        tip.style.display = "none";
        return;
      }
      tip.innerHTML = itemTooltip(game, items, state);
      tip.style.display = "";
      tip.style.left = `${Math.min(window.innerWidth - 250, e.clientX + 14)}px`;
      tip.style.top = `${Math.max(8, e.clientY - tip.offsetHeight - 8)}px`;
    });
    cell.addEventListener("mouseleave", () => (tip.style.display = "none"));
    return cell;
  }

  const equipCells = items.slots.map((s) => {
    const wrap = el("div", "display:flex; align-items:center; gap:4px;", equipment);
    const cell = cellFor(wrap, EQUIPMENT, s.index, s.name);
    el("div", "width: 62px; color:#999; font-size: 11px;", wrap).textContent = s.name;
    return cell;
  });
  let bagCells: HTMLElement[] = [];
  let bankCells: HTMLElement[] = [];

  function refresh(): void {
    const bagItems = mirror.containers[BAG];
    if (bagCells.length !== bagItems.length) {
      bag.innerHTML = "";
      bagCells = bagItems.map((_, i) => cellFor(bag, BAG, i));
    }
    const bankItems = mirror.containers[BANK];
    if (bankCells.length !== bankItems.length) {
      bank.innerHTML = "";
      bankCells = bankItems.map((_, i) => cellFor(bank, BANK, i));
    }
    bagCells.forEach((cell, i) => drawItem(cell, items, bagItems[i]));
    bankCells.forEach((cell, i) => drawItem(cell, items, bankItems[i]));
    // A slot filled by what is worn in another - the off hand under a two-handed weapon - shows it, faded.
    const filledBy = new Map<number, ItemState>();
    for (const state of mirror.containers[EQUIPMENT]) {
      const type = state && items.types[items.typeIndex.get(state.type) ?? -1];
      for (const slot of type?.fills ?? []) filledBy.set(slot, state!);
    }
    equipCells.forEach((cell, i) => {
      const own = mirror.containers[EQUIPMENT][i] ?? null;
      drawItem(cell, items, own ?? filledBy.get(i) ?? null, items.slots[i].name);
      cell.style.opacity = !own && filledBy.has(i) ? "0.4" : "";
    });
    bankBox.style.display = mirror.bankOpen ? "" : "none";
    money.textContent = items.currencies.map((c) => `${c.name}: ${formatMoney(c, mirror.wallet[c.index] ?? 0)}`).join("   ");
    const refused = mirror.refused;
    message.textContent = refused && performance.now() - refused.at < 4000 ? (REFUSAL_TEXT[refused.reason] ?? refused.reason) : "";
  }
  const offChange = mirror.onChange(() => {
    if (root.style.display !== "none") refresh();
  });
  const timer = setInterval(() => {
    if (root.style.display !== "none") refresh();
  }, 500);

  function setVisible(on: boolean): void {
    root.style.display = on ? "" : "none";
    if (!on) tip.style.display = "none";
    else refresh();
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key.toLowerCase() === "b") setVisible(root.style.display === "none");
  };
  window.addEventListener("keydown", onKey);

  return {
    element: root,
    get visible() {
      return root.style.display !== "none";
    },
    toggle: () => setVisible(root.style.display === "none"),
    setVisible,
    dispose() {
      offChange();
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
      root.remove();
      tip.remove();
    },
  };
}

/**
 * The loot window: what the open corpse, chest or ground item holds, shown while the server says
 * it is open. Click an item to take it, or take everything.
 */
export function createLootWindow({ game, items, mirror, send }: InventoryOptions): { element: HTMLElement; dispose: () => void } {
  const root = el("div", `position: fixed; left: 16px; top: 330px; width: 230px; z-index: 950; padding: 8px; display: none; ${PANEL}`, document.body);
  const { title } = windowHead(root, "Loot", () => send({ type: "lootClose" }));
  const list = el("div", "display:flex; flex-direction:column; gap:4px;", root);
  const all = el("button", "margin-top:6px; width:100%;", root) as HTMLButtonElement;
  all.className = BUTTON_CLASS;
  all.textContent = "Take all";
  all.addEventListener("click", () => send({ type: "lootTake", slot: TAKE_ALL }));
  const tip = el("div", `position: fixed; z-index: 960; padding: 6px 8px; max-width: 240px; pointer-events: none; display: none; ${PANEL}`, document.body);

  function refresh(): void {
    const loot = mirror.loot;
    root.style.display = loot ? "" : "none";
    if (!loot) {
      tip.style.display = "none";
      return;
    }
    title.textContent = "Loot";
    list.innerHTML = "";
    const coins = loot.money.map((n, c) => (n > 0 ? formatMoney(items.currencies[c], n) + (c === items.main ? "" : ` ${items.currencies[c].name}`) : "")).filter(Boolean);
    if (coins.length > 0) el("div", `color:${GOLD}; font-weight: 600; padding: 2px 0;`, list).textContent = coins.join(", ");
    loot.items.forEach((state, slot) => {
      if (!state) return;
      const row = el("div", "display:flex; align-items:center; gap:6px; cursor:pointer;", list);
      const cell = el("div", `position: relative; width: ${CELL - 6}px; height: ${CELL - 6}px; ${CELL_STYLE} flex: none;`, row);
      drawItem(cell, items, state);
      const type = items.types[items.typeIndex.get(state.type) ?? -1];
      const name = el("div", `color:${type ? items.rarities[type.rarity].color : "#f0f"};`, row);
      name.textContent = `${type?.name ?? state.type}${state.count > 1 ? ` x${state.count}` : ""}`;
      row.addEventListener("click", () => send({ type: "lootTake", slot }));
      row.addEventListener("mousemove", (e) => {
        tip.innerHTML = itemTooltip(game, items, state);
        tip.style.display = "";
        tip.style.left = `${e.clientX + 14}px`;
        tip.style.top = `${e.clientY + 10}px`;
      });
      row.addEventListener("mouseleave", () => (tip.style.display = "none"));
    });
    if (coins.length === 0 && !loot.items.some(Boolean)) el("div", "color:#888;", list).textContent = "Empty.";
  }
  const off = mirror.onChange(refresh);
  return {
    element: root,
    dispose() {
      off();
      root.remove();
      tip.remove();
    },
  };
}
