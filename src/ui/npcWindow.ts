import type { ClientMessage, NpcWindow as NpcWindowMessage } from "../sim/protocol";
import { formatMoney, type ItemRules } from "../sim/rules/itemRules";
import type { BelongingsMirror } from "../game/belongingsMirror";
import { renderText, type TextTable } from "../core/text";
import { BUTTON_CLASS, CLOSE_CLASS, DIM, HEADING, PANEL, TEXT, WINDOW_HEAD } from "./theme";

/**
 * Talking to an NPC (NPCS.md, *Services*): its name and title, its greeting, and a button for each
 * thing it offers - training, the shop (its stock to buy, the bag to sell from), mending, the bank,
 * making its inn home. Quests join it with QUESTS.md. Everything goes to the server as messages; the
 * window only shows what the server said.
 */
export interface NpcWindow {
  readonly element: HTMLElement;
  readonly visible: boolean;
  /** The NPC the window is open for, 0 for none. */
  readonly npc: number;
  open: (message: NpcWindowMessage, name: string, title: string) => void;
  /** Why the server would not, said in the window. */
  refused: (reason: string) => void;
  close: () => void;
  dispose: () => void;
}

export interface NpcWindowOptions {
  items: ItemRules;
  /** Translations (QUESTS.md, *Text*). */
  text: TextTable;
  belongings: BelongingsMirror;
  send: (message: ClientMessage) => void;
  /** Opens the progression panel at this trainer. */
  train: (npc: number) => void;
  /** Opens the bag (with the bank beside it). */
  openBag: () => void;
}

const REFUSALS: Record<string, string> = {
  range: "You are too far away.",
  dead: "They cannot answer you now.",
  unfriendly: "They will not deal with you.",
  money: "You cannot afford that.",
  bagFull: "Your bag is full.",
  quest: "You cannot sell that.",
  empty: "There is nothing there.",
  nothing: "Nothing needs mending.",
  notVendor: "They have nothing to sell.",
};

function el(tag: string, css: string, parent?: HTMLElement, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (tag === "button") e.className = BUTTON_CLASS;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export function createNpcWindow(options: NpcWindowOptions): NpcWindow {
  const { items, belongings, send } = options;
  const money = (n: number): string => formatMoney(items.currencies[items.main], n);
  const root = el("div", `width: 320px; padding: 8px 10px; display: none; ${PANEL}`);
  const head = el("div", WINDOW_HEAD, root);
  const heading = el("span", "", head);
  const close = el("button", "", head, "×");
  close.className = CLOSE_CLASS;
  const body = el("div", "", root);
  const note = el("div", `min-height: 15px; margin-top: 6px; color: ${DIM}; font-size: 11px;`, root);
  let current: NpcWindowMessage | null = null;
  let unsubscribe: (() => void) | null = null;

  const typeOf = (id: string) => items.types[items.typeIndex.get(id) ?? -1];

  function render(): void {
    body.textContent = "";
    if (!current) return;
    const npc = current.npc;
    if (current.greeting) el("div", `font-style: italic; color: ${TEXT}; margin-bottom: 6px;`, body, `"${renderText({ text: current.greeting, args: current.greetingArgs }, options.text)}"`);
    const buttons = el("div", "display: flex; flex-wrap: wrap; gap: 4px;", body);
    const button = (label: string, act: () => void): void => {
      el("button", "padding: 3px 8px;", buttons, label).addEventListener("click", act);
    };
    if (current.trainer) button("Train", () => options.train(npc));
    if (current.banker) button("Bank", () => options.openBag());
    if (current.repair) button("Repair all", () => send({ type: "npcRepair", npc }));
    if (current.innkeeper) {
      if (current.home) el("span", `color: ${DIM}; font-size: 11px; align-self: center;`, buttons, "This inn is your home.");
      else button("Make this inn your home", () => send({ type: "setHome", npc }));
    }
    if (current.stock.length > 0) {
      el("div", HEADING, body, "For sale");
      for (const [index, entry] of current.stock.entries()) {
        const type = typeOf(entry.type);
        const row = el("div", "display: flex; align-items: center; gap: 6px; margin: 2px 0;", body);
        el("span", "flex: 1;", row, `${type?.name ?? entry.type}${entry.count > 1 ? ` ×${entry.count}` : ""}`);
        el("span", `color: ${DIM}; font-size: 11px;`, row, money(entry.price));
        el("button", "padding: 1px 6px; font-size: 11px;", row, "Buy").addEventListener("click", () => send({ type: "shopBuy", npc, index }));
      }
    }
    if (current.sellRate > 0) {
      el("div", HEADING, body, "Sell from your bag");
      const bag = belongings.containers[0] ?? [];
      let any = false;
      bag.forEach((item, slot) => {
        const type = item && typeOf(item.type);
        if (!item || !type || type.quest) return;
        any = true;
        const worn = type.durability > 0 ? Math.max(0.2, item.durability / type.durability) : 1;
        const row = el("div", "display: flex; align-items: center; gap: 6px; margin: 2px 0;", body);
        el("span", "flex: 1;", row, `${type.name}${item.count > 1 ? ` ×${item.count}` : ""}`);
        el("span", `color: ${DIM}; font-size: 11px;`, row, money(Math.floor(type.value * current!.sellRate * item.count * worn)));
        el("button", "padding: 1px 6px; font-size: 11px;", row, "Sell").addEventListener("click", () => send({ type: "shopSell", npc, from: { container: 0, slot } }));
      });
      if (!any) el("div", `color: ${DIM}; font-size: 11px;`, body, "Nothing to sell.");
    }
    el("div", `margin-top: 6px; color: ${DIM}; font-size: 11px;`, body, `Your purse: ${money(belongings.wallet[items.main] ?? 0)}`);
  }

  function hide(): void {
    root.style.display = "none";
    current = null;
    unsubscribe?.();
    unsubscribe = null;
  }
  close.addEventListener("click", hide);

  return {
    element: root,
    get visible() {
      return root.style.display !== "none";
    },
    get npc() {
      return current?.npc ?? 0;
    },
    open(message, name, title) {
      current = message;
      heading.textContent = title ? `${name} - ${title}` : name;
      note.textContent = "";
      root.style.display = "";
      unsubscribe ??= belongings.onChange(render);
      render();
    },
    refused(reason) {
      note.textContent = REFUSALS[reason] ?? reason;
    },
    close: hide,
    dispose() {
      hide();
      root.remove();
    },
  };
}
