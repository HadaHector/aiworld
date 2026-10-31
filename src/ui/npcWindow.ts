import type { ClientMessage, NpcWindow as NpcWindowMessage } from "../sim/protocol";
import { formatMoney, type ItemRules } from "../sim/rules/itemRules";
import type { BelongingsMirror } from "../game/belongingsMirror";
import { renderText, type TextTable } from "../sim/text";
import type { QuestMirror } from "../game/questMirror";
import type { QuestRules } from "../sim/quests/quest";
import { renderQuest } from "./questLog";
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
  /** A quest was just handed in: when the window next opens on an NPC offering the one after it,
   *  that one's page shows at once (QUESTS.md, *Talking*). */
  handedIn: (quest: string) => void;
  close: () => void;
  dispose: () => void;
}

export interface NpcWindowOptions {
  items: ItemRules;
  /** The character's quests, and how to write one out (QUESTS.md, *Talking*). */
  quests: QuestMirror;
  questRules: QuestRules;
  level: () => number;
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
  /** A quest page open in the window, and the reward chosen on it. */
  let page = "";
  let chosen = -1;
  let after = "";
  let unsubscribe: (() => void) | null = null;

  const typeOf = (id: string) => items.types[items.typeIndex.get(id) ?? -1];

  /** How many things an NPC offers: its quests and its services. */
  const offersOf = (m: NpcWindowMessage): number => m.quests.length + [m.trainer, m.banker, m.repair, m.innkeeper, m.stock.length > 0].filter(Boolean).length;

  /** One quest: offered (Accept), in progress, or ready (choose a reward, Complete). */
  function renderPage(npc: number, id: string, state: "offer" | "active" | "ready"): void {
    const def = options.quests.defs.get(id);
    back();
    if (!def) return;
    const active = options.quests.active.get(id);
    const choose = state === "ready" && def.rewards.choice.length > 0 ? (i: number) => ((chosen = i), render()) : undefined;
    renderQuest(body, def, active, { items, text: options.text, rules: options.questRules, level: options.level(), page: state === "offer" ? "offer" : state === "ready" ? "done" : "progress", choose, chosen });
    const row = el("div", "display: flex; gap: 6px; margin-top: 8px;", body);
    if (state === "offer") el("button", "padding: 3px 10px;", row, "Accept").addEventListener("click", () => send({ type: "questAccept", npc, quest: id }));
    if (state === "ready") {
      const done = el("button", "padding: 3px 10px;", row, "Complete") as HTMLButtonElement;
      done.disabled = def.rewards.choice.length > 0 && chosen < 0;
      done.addEventListener("click", () => send({ type: "questComplete", npc, quest: id, choice: Math.max(0, chosen) }));
    }
  }

  /** The page that is the shop (`page` is a quest's id, this, or "" for the list). */
  const SHOP = "@shop";

  /** A Back button to the list - when there is one: an NPC with only this to offer has nothing else. */
  function back(): void {
    if (!current || offersOf(current) <= 1) return;
    el("button", "padding: 1px 8px; margin-bottom: 6px;", body, "‹ Back").addEventListener("click", () => {
      page = "";
      render();
    });
  }

  /** The shop (NPCS.md, *The vendor's shop*): its stock to buy, the bag to sell from, the purse. */
  function renderShop(npc: number): void {
    back();
    if (current!.stock.length > 0) {
      el("div", HEADING, body, "For sale");
      for (const [index, entry] of current!.stock.entries()) {
        const type = typeOf(entry.type);
        const row = el("div", "display: flex; align-items: center; gap: 6px; margin: 2px 0;", body);
        el("span", "flex: 1;", row, `${type?.name ?? entry.type}${entry.count > 1 ? ` ×${entry.count}` : ""}`);
        el("span", `color: ${DIM}; font-size: 11px;`, row, money(entry.price));
        el("button", "padding: 1px 6px; font-size: 11px;", row, "Buy").addEventListener("click", () => send({ type: "shopBuy", npc, index }));
      }
    }
    if (current!.sellRate > 0) {
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

  function render(): void {
    body.textContent = "";
    if (!current) return;
    const npc = current.npc;
    if (page === SHOP && current.stock.length > 0) return renderShop(npc);
    const onPage = current.quests.find((q) => q.id === page);
    if (onPage) return renderPage(npc, onPage.id, onPage.state);
    if (current.greeting) el("div", `font-style: italic; color: ${TEXT}; margin-bottom: 6px;`, body, `"${renderText({ text: current.greeting, args: current.greetingArgs }, options.text)}"`);
    // One row for each thing it offers: its quests ("!" to take, "?" to hand in, grey while in
    // progress), then its services, each with its sign.
    const row = (mark: string, markColour: string, label: string, colour: string, act: () => void): void => {
      const r = el("div", `cursor: pointer; padding: 2px 0; color: ${colour};`, body);
      el("span", `display: inline-block; width: 16px; text-align: center; font-weight: 700; color: ${markColour}; margin-right: 4px;`, r, mark);
      el("span", "", r, label);
      r.addEventListener("click", act);
    };
    for (const q of current.quests) {
      const def = options.quests.defs.get(q.id);
      if (!def) continue;
      const grey = q.state === "active";
      row(q.state === "offer" ? "!" : "?", grey ? DIM : "#f2d64b", renderText(def.text.title, options.text), grey ? DIM : TEXT, () => {
        page = q.id;
        chosen = -1;
        render();
      });
    }
    if (current.stock.length > 0) {
      row("$", "#e8c34a", "Shop", TEXT, () => {
        page = SHOP;
        render();
      });
    }
    if (current.trainer) row("✦", "#9ad0ff", "Train", TEXT, () => options.train(npc));
    if (current.banker) row("▣", "#c9b48a", "Bank", TEXT, () => options.openBag());
    if (current.repair) row("⚒", "#c9b48a", "Repair all", TEXT, () => send({ type: "npcRepair", npc }));
    if (current.innkeeper) {
      if (current.home) el("div", `color: ${DIM}; font-size: 11px; padding: 2px 0 2px 20px;`, body, "This inn is your home.");
      else row("⌂", "#c9b48a", "Make this inn your home", TEXT, () => send({ type: "setHome", npc }));
    }
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
      // Newly talked to (not the window asked for again after an action), with one thing only to
      // offer: straight to it - a trainer's lessons, the bank, a quest's page.
      const fresh = root.style.display === "none" || current?.npc !== message.npc;
      const offers = offersOf(message);
      if (fresh && offers === 1 && !after) {
        if (message.trainer || message.banker) {
          hide();
          if (message.trainer) options.train(message.npc);
          else options.openBag();
          return;
        }
        if (message.quests.length === 1) {
          current = null;
          page = message.quests[0].id;
          chosen = -1;
        }
        if (message.stock.length > 0) page = SHOP;
      }
      // The page stays while its quest is as it was; taken, handed in, or another NPC: back to the list.
      const was = current?.npc === message.npc ? current.quests.find((q) => q.id === page)?.state : fresh && offers === 1 && message.quests.length === 1 ? message.quests[0].state : undefined;
      // The shop stays open across buying and selling, or opens for an NPC that only sells.
      const keepShop = page === SHOP && (!fresh || (offers === 1 && message.stock.length > 0));
      if (!keepShop && (!was || message.quests.find((q) => q.id === page)?.state !== was)) page = "";
      // Straight on to what follows the quest just handed in, where this NPC offers it.
      const next = after ? message.quests.find((q) => q.state === "offer" && options.quests.defs.get(q.id)?.requires.quests.includes(after)) : undefined;
      if (next) {
        page = next.id;
        chosen = -1;
      }
      after = "";
      current = message;
      heading.textContent = title ? `${name} - ${title}` : name;
      note.textContent = "";
      root.style.display = "";
      unsubscribe ??= belongings.onChange(render);
      render();
    },
    handedIn(quest) {
      after = quest;
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
