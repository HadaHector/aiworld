import type { ClientMessage } from "../sim/protocol";
import type { GameRules } from "../sim/rules/gameRules";
import type { ProgressionRules } from "../sim/rules/progressionRules";
import type { LevelGains } from "../sim/progression/levelUp";
import type { ProgressMirror } from "../game/progressMirror";
import { iconBox, skillIcon } from "./icons";
import { BUTTON_CLASS, DIM, GOLD, HEADING, PANEL, TEXT, TITLE_FONT, windowHead } from "./theme";

/**
 * The level-up screen (SLICE.md P9; SKILLBANK.md): shown when the character's level rises - what went
 * up (the automatic stat points, by the class's weights, and what follows from them), the skills the
 * level teaches, those a trainer or a book may now teach, and the ranks gained. With `manual` stat
 * points (rules/progression.json5) it also lets the player spend them, a point at a time; the slice
 * runs `auto`, so that part stays hidden. It does not stop play: it closes by itself, or with ×.
 */
export interface LevelUpScreen {
  readonly element: HTMLElement;
  readonly visible: boolean;
  show(level: number, gains: LevelGains): void;
  hide(): void;
  dispose(): void;
}

export interface LevelUpScreenOptions {
  game: GameRules;
  rules: ProgressionRules;
  progress: ProgressMirror;
  send: (message: ClientMessage) => void;
  /** The own character's current value of a stat (by index), null before it is known. */
  ownStat: (stat: number) => number | null;
  /** Seconds it stays when nothing is left to spend. */
  seconds?: number;
}

function el(tag: string, css: string, parent?: HTMLElement, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (tag === "button") e.className = BUTTON_CLASS;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export function createLevelUpScreen(options: LevelUpScreenOptions): LevelUpScreen {
  const { game, rules, progress, send } = options;
  const element = el("div", `${PANEL} position: fixed; left: 50%; top: 16%; transform: translateX(-50%); width: 320px; padding: 10px 14px 12px; z-index: 30; display: none; pointer-events: auto;`);
  element.dataset.levelUp = "";
  document.body.appendChild(element);
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: { level: number; gains: LevelGains } | null = null;

  const skillName = (skill: number): string => game.skills[skill]?.name ?? "a skill";
  const healthStat = game.statIndex.get("maxHealth");

  function hide(): void {
    visible = false;
    element.style.display = "none";
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function left(): number {
    return progress.progress?.stats?.mode === "manual" ? progress.progress.stats.left : 0;
  }

  function draw(): void {
    if (!last) return;
    const { level, gains } = last;
    element.replaceChildren();
    const head = windowHead(element, `Level ${level}`, hide);
    head.title.style.cssText += `font: 600 20px/1.2 ${TITLE_FONT}; color: ${GOLD};`;

    // What went up: stats, and the health they make.
    if (gains.stats.length > 0) {
      el("div", HEADING, element, gains.statMode === "auto" ? "Stats went up" : "Went up");
      const list = el("div", "display: grid; grid-template-columns: 1fr auto; gap: 1px 12px;", element);
      for (const g of gains.stats) {
        el("div", `color: ${TEXT};`, list, g.stat);
        el("div", "color: #8fe08f; text-align: right;", list, `${g.amount > 0 ? "+" : ""}${g.amount}`);
      }
      const health = healthStat === undefined ? null : options.ownStat(healthStat);
      if (health !== null) el("div", `color: ${DIM}; margin-top: 3px;`, element, `Max health now ${Math.round(health)}`);
    }

    // Skills: learned now, ranks, and those waiting for a trainer or a book.
    const learned = gains.skills.filter((s) => s.how === "auto" && s.rank <= 1);
    const ranks = gains.skills.filter((s) => s.how === "auto" && s.rank > 1);
    const waiting = gains.skills.filter((s) => s.how === "trainer" || s.how === "item");
    if (learned.length + ranks.length + waiting.length > 0) {
      el("div", HEADING, element, "Skills");
      const row = (skill: number, text: string): void => {
        const line = el("div", "display: flex; align-items: center; gap: 7px; margin: 2px 0;", element);
        iconBox(line, skillIcon(game.skills[skill]), 26);
        el("div", `color: ${TEXT};`, line, text);
      };
      for (const s of learned) row(s.skill, `New: ${skillName(s.skill)}${game.skills[s.skill]?.passive ? " (passive)" : ""}`);
      for (const s of ranks) row(s.skill, `${skillName(s.skill)}: rank ${s.rank}`);
      for (const s of waiting) row(s.skill, `${skillName(s.skill)}: ${s.how === "trainer" ? "a trainer can teach it now" : "can be learned from a book now"}`);
    }

    // Manual stat points: spend them here (off in the slice: `auto`).
    const spend = left();
    const config = rules.config.statPoints;
    if (config?.mode === "manual" && (spend > 0 || gains.statPoints > 0)) {
      el("div", HEADING, element, spend > 0 ? `${spend} stat point${spend === 1 ? "" : "s"} to spend` : "Stat points spent");
      const grid = el("div", "display: grid; grid-template-columns: 1fr auto auto; gap: 3px 10px; align-items: center;", element);
      for (const stat of config.stats) {
        el("div", `color: ${TEXT};`, grid, game.stats[stat]?.name ?? "?");
        const value = options.ownStat(stat);
        el("div", `color: ${DIM}; text-align: right;`, grid, value === null ? "" : String(Math.round(value)));
        const plus = el("button", "padding: 1px 8px; font-size: 12px;", grid, "+") as HTMLButtonElement;
        plus.disabled = spend <= 0;
        plus.addEventListener("click", () => send({ type: "statSpend", stat }));
      }
    }

    if (timer) clearTimeout(timer);
    timer = left() > 0 ? null : setTimeout(hide, (options.seconds ?? 12) * 1000);
  }

  progress.onChange(() => {
    if (visible) draw();
  });
  element.addEventListener("mouseenter", () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
  element.addEventListener("mouseleave", () => {
    if (visible && left() <= 0) timer = setTimeout(hide, 4000);
  });

  return {
    element,
    get visible() {
      return visible;
    },
    show(level, gains) {
      last = { level, gains };
      visible = true;
      element.style.display = "block";
      draw();
    },
    hide,
    dispose() {
      hide();
      element.remove();
    },
  };
}
