import { renderText, type TextTable } from "../core/text";
import type { ClientMessage } from "../sim/protocol";
import { needed, questColour, type ActiveQuest, type QuestDef, type QuestRules } from "../sim/quests/quest";
import { formatMoney, type ItemRules } from "../sim/rules/itemRules";
import type { QuestMirror } from "../game/questMirror";
import { BUTTON_CLASS, CLOSE_CLASS, DIM, GOLD, HEADING, PANEL, QUIET_PANEL, TEXT, TITLE_FONT, WINDOW_HEAD } from "./theme";

/**
 * The quest log (L) and the tracker (QUESTS.md, *The quest log and tracker*): the quests taken, by
 * level colour, the chosen one's text, objectives with counts, rewards, *Abandon* and *Track*; and
 * the tracked quests' objectives at the screen's right edge, updated as they move.
 */
export interface QuestLog {
  readonly element: HTMLElement;
  /** The tracker, for the HUD's info region. */
  readonly tracker: HTMLElement;
  readonly visible: boolean;
  toggle: () => void;
  dispose: () => void;
}

export interface QuestLogOptions {
  mirror: QuestMirror;
  rules: QuestRules;
  items: ItemRules;
  text: TextTable;
  send: (message: ClientMessage) => void;
  /** The character's level, for colours. */
  level: () => number;
}

/** A level colour's CSS. */
export const COLOURS: Record<ReturnType<typeof questColour>, string> = { red: "#ff5a4a", orange: "#ff9a3a", yellow: "#f2d64b", green: "#5fd35f", grey: "#9a9a9a" };

function el(tag: string, css: string, parent?: HTMLElement, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (tag === "button") e.className = BUTTON_CLASS;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** An objective's line with its count: "Beasts slain: 1/2", struck through when done. */
export function objectiveLines(def: QuestDef, active: ActiveQuest | undefined, table: TextTable): { text: string; done: boolean }[] {
  return def.objectives.map((o, i) => {
    const have = active?.counts[i] ?? 0;
    const need = needed(o);
    const line = renderText(o.line, table);
    return { text: need > 1 ? `${line}: ${Math.min(have, need)}/${need}` : line, done: have >= need };
  });
}

/**
 * A quest written out: title, its text for the moment (offer, progress or done), objectives, and
 * rewards - with the item choice as buttons when `choose` is given. What the NPC window and the log
 * both show.
 */
export function renderQuest(parent: HTMLElement, def: QuestDef, active: ActiveQuest | undefined, options: { items: ItemRules; text: TextTable; rules: QuestRules; level: number; page: "offer" | "progress" | "done"; choose?: (index: number) => void; chosen?: number }): void {
  const colour = COLOURS[questColour(options.rules, def.level, options.level)];
  el("div", `font: 600 14px/1.3 ${TITLE_FONT}; color: ${colour}; margin-bottom: 4px;`, parent, `${renderText(def.text.title, options.text)}  [${def.level}]`);
  const words = options.page === "offer" ? def.text.offer : options.page === "done" ? def.text.done : def.text.progress;
  el("div", `color: ${TEXT}; margin-bottom: 6px; white-space: pre-wrap;`, parent, renderText(words, options.text));
  if (active?.state === "failed") el("div", "color: #ff6a5a; margin-bottom: 4px;", parent, "Failed");
  el("div", HEADING, parent, "Objectives");
  for (const line of objectiveLines(def, active, options.text)) el("div", `color: ${line.done ? DIM : TEXT}; ${line.done ? "text-decoration: line-through;" : ""}`, parent, `- ${line.text}`);
  el("div", HEADING, parent, "Rewards");
  const r = def.rewards;
  const money = formatMoney(options.items.currencies[options.items.main], r.money);
  el("div", `color: ${TEXT};`, parent, `${r.xp} experience${r.money > 0 ? `, ${money}` : ""}`);
  for (const id of r.items) el("div", `color: ${TEXT};`, parent, options.items.types[options.items.typeIndex.get(id) ?? -1]?.name ?? id);
  if (r.choice.length > 0) {
    el("div", `color: ${DIM}; font-size: 11px; margin-top: 3px;`, parent, "Choose one of:");
    const row = el("div", "display: flex; flex-direction: column; gap: 3px;", parent);
    r.choice.forEach((id, i) => {
      const type = options.items.types[options.items.typeIndex.get(id) ?? -1];
      const rarity = type ? options.items.rarities[type.rarity] : undefined;
      const b = el(options.choose ? "button" : "div", `text-align: left; padding: 2px 6px; color: ${rarity?.color ?? TEXT}; ${options.chosen === i ? `outline: 1px solid ${GOLD};` : ""}`, row, type?.name ?? id);
      if (options.choose) b.addEventListener("click", () => options.choose!(i));
    });
  }
}

export function createQuestLog(options: QuestLogOptions): QuestLog {
  const { mirror, send } = options;
  const root = el("div", `width: 360px; padding: 8px 10px; display: none; ${PANEL}`);
  const head = el("div", WINDOW_HEAD, root);
  el("span", "", head, "Quest Log");
  const close = el("button", "", head, "×");
  close.className = CLOSE_CLASS;
  const list = el("div", "", root);
  const details = el("div", "margin-top: 8px; border-top: 1px solid #444; padding-top: 6px;", root);
  const tracker = el("div", `display: none; flex-direction: column; gap: 4px; max-width: 260px; padding: 6px 8px; margin-top: 6px; ${QUIET_PANEL}`);
  let selected = "";
  const untracked = new Set<string>();
  let visible = false;

  function drawLog(): void {
    list.textContent = "";
    details.textContent = "";
    if (mirror.active.size === 0) el("div", `color: ${DIM};`, list, "You have no quests.");
    for (const [id, active] of mirror.active) {
      const def = mirror.defs.get(id);
      if (!def) continue;
      const colour = COLOURS[questColour(options.rules, def.level, options.level())];
      const state = active.state === "ready" ? " (ready)" : active.state === "failed" ? " (failed)" : "";
      const row = el("div", `cursor: pointer; padding: 2px 4px; color: ${colour}; ${id === selected ? "background: rgba(255, 220, 150, 0.08);" : ""}`, list, `[${def.level}] ${renderText(def.text.title, options.text)}${state}`);
      row.addEventListener("click", () => {
        selected = id;
        drawLog();
      });
    }
    const def = mirror.defs.get(selected);
    const active = mirror.active.get(selected);
    if (!def || !active) return;
    renderQuest(details, def, active, { items: options.items, text: options.text, rules: options.rules, level: options.level(), page: active.state === "ready" ? "done" : "offer" });
    const buttons = el("div", "display: flex; gap: 6px; margin-top: 8px;", details);
    el("button", "padding: 3px 8px;", buttons, untracked.has(selected) ? "Track" : "Untrack").addEventListener("click", () => {
      if (untracked.has(selected)) untracked.delete(selected);
      else untracked.add(selected);
      draw();
    });
    el("button", "padding: 3px 8px;", buttons, "Abandon").addEventListener("click", () => send({ type: "questAbandon", quest: selected }));
  }

  function drawTracker(): void {
    tracker.textContent = "";
    let shown = 0;
    for (const [id, active] of mirror.active) {
      const def = mirror.defs.get(id);
      if (!def || untracked.has(id) || shown >= 5) continue;
      shown++;
      const colour = COLOURS[questColour(options.rules, def.level, options.level())];
      el("div", `font: 600 12px/1.2 ${TITLE_FONT}; color: ${colour};`, tracker, renderText(def.text.title, options.text));
      if (active.state === "ready") el("div", `color: ${GOLD}; font-size: 11px;`, tracker, "- Ready to hand in");
      else if (active.state === "failed") el("div", "color: #ff6a5a; font-size: 11px;", tracker, "- Failed");
      else for (const line of objectiveLines(def, active, options.text)) el("div", `font-size: 11px; color: ${line.done ? DIM : TEXT}; ${line.done ? "text-decoration: line-through;" : ""}`, tracker, `- ${line.text}`);
    }
    tracker.style.display = shown > 0 ? "flex" : "none";
  }

  function draw(): void {
    if (!mirror.active.has(selected)) selected = mirror.active.keys().next().value ?? "";
    if (visible) drawLog();
    drawTracker();
  }
  const unsubscribe = mirror.onChange(draw);
  close.addEventListener("click", () => toggle());
  function toggle(): void {
    visible = !visible;
    root.style.display = visible ? "" : "none";
    draw();
  }

  return {
    element: root,
    tracker,
    get visible() {
      return visible;
    },
    toggle,
    dispose() {
      unsubscribe();
      root.remove();
      tracker.remove();
    },
  };
}
