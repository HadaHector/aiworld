import type { GameRules } from "../sim/rules/gameRules";
import { describeSkill } from "../sim/rules/skillText";
import type { EntityMirror } from "../game/entityMirror";
import type { ProgressMirror } from "../game/progressMirror";
import { ACTION_DRAG_TYPE, TELEPORT_TEXT, type BarAction } from "./actionBar";
import { DIM, GOLD, HEADING, PANEL, SLOT, SLOT_CLASS, windowHead } from "./theme";

/**
 * The spell book (L): everything the character knows - the attack, then its spells, then its passive
 * abilities - each with what it does. Drag one onto the action bar, or click it to use it now.
 */
export interface SpellBook {
  readonly element: HTMLElement;
  readonly visible: boolean;
  toggle: () => void;
  dispose: () => void;
}

export interface SpellBookOptions {
  game: GameRules;
  mirror: EntityMirror;
  progress: ProgressMirror;
  cast: (skill: number) => void;
  setAttacking: (on: boolean) => void;
  teleport: () => void;
}

const HOW: Record<string, string> = { auto: "learned at a level", trainer: "taught by a trainer", item: "learned from a book", talent: "a talent", quest: "a quest's reward" };

function el(tag: string, css: string, parent?: HTMLElement, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export function createSpellBook(options: SpellBookOptions): SpellBook {
  const { game, mirror, progress } = options;
  const root = el("div", `position: fixed; right: 16px; top: 60px; width: 330px; padding: 8px 10px; display: none; box-sizing: border-box; ${PANEL}`, document.body);
  windowHead(root, "Spell Book", () => toggle());
  el("div", `color: ${DIM}; font-size: 11px; margin-bottom: 4px;`, root, "Drag onto the action bar, or click to use now.");
  const body = el("div", "", root);
  let lastSignature = "";

  /** One entry: a slot-like square with the name, then what it does. */
  function entry(parent: HTMLElement, name: string, note: string, lines: string[], action: BarAction | null, use: (() => void) | null): void {
    const row = el("div", "display: flex; gap: 8px; align-items: flex-start; margin: 6px 0;", parent);
    const icon = el("div", `flex: none; width: 40px; height: 40px; ${SLOT} display: flex; align-items: center; justify-content: center; font: 700 15px/1 system-ui, sans-serif; color: ${GOLD}; cursor: ${action ? "grab" : "default"}; ${action ? "" : "opacity: 0.6;"}`, row, name.charAt(0));
    if (action) {
      icon.className = SLOT_CLASS;
      icon.draggable = true;
      icon.title = "Drag onto the action bar";
      icon.addEventListener("dragstart", (e) => e.dataTransfer?.setData(ACTION_DRAG_TYPE, JSON.stringify(action)));
    }
    if (use) icon.addEventListener("click", use);
    const text = el("div", "flex: 1; min-width: 0;", row);
    const head = el("div", "display: flex; justify-content: space-between; gap: 6px;", text);
    el("span", `font-weight: 600; color: ${GOLD};`, head, name);
    el("span", `color: ${DIM}; font-size: 10px; white-space: nowrap;`, head, note);
    for (const line of lines) el("div", "font-size: 11px; color: #d8ceb6;", text, line);
  }

  function draw(): void {
    drawSpells();
    el("div", HEADING, body, "Debug");
    entry(body, "Teleport", "debug", [TELEPORT_TEXT], { kind: "teleport" }, () => options.teleport());
  }

  function drawSpells(): void {
    body.innerHTML = "";
    const learned = new Map((progress.progress?.learned ?? []).map((l) => [l.skill, l.how]));
    const spells = mirror.own.spells.filter((s) => game.skills[s.skill]);
    const active = spells.filter((s) => !game.skills[s.skill].passive && game.skills[s.skill].id !== "autoAttack");
    const passive = spells.filter((s) => game.skills[s.skill].passive && game.skills[s.skill].id !== "autoAttack");
    el("div", HEADING, body, "Abilities");
    entry(body, "Attack", "always", ["Swing at your target with your weapon until you stop or it dies. Use it again to stop."], { kind: "attack" }, () => options.setAttacking(!mirror.own.attacking));
    for (const s of active) {
      const def = game.skills[s.skill];
      const how = learned.get(s.skill);
      entry(body, def.name, `rank ${s.level} · ${how ? HOW[how] ?? how : "from the start"}`, describeSkill(game, def), { kind: "skill", skill: def.id }, () => options.cast(s.skill));
    }
    if (passive.length) {
      el("div", HEADING, body, "Passive");
      for (const s of passive) {
        const def = game.skills[s.skill];
        const how = learned.get(s.skill);
        entry(body, def.name, how ? HOW[how] ?? how : "always on", describeSkill(game, def), null, null);
      }
    }
  }

  // Redrawn when what it knows changes, while open.
  const timer = setInterval(() => {
    if (root.style.display === "none") return;
    const signature = mirror.own.spells.map((s) => `${s.skill}:${s.level}`).join(",");
    if (signature !== lastSignature) {
      lastSignature = signature;
      draw();
    }
  }, 300);

  function toggle(): void {
    const show = root.style.display === "none";
    root.style.display = show ? "block" : "none";
    if (show) {
      lastSignature = "";
      draw();
    }
  }

  return {
    element: root,
    get visible() {
      return root.style.display !== "none";
    },
    toggle,
    dispose() {
      clearInterval(timer);
      root.remove();
    },
  };
}
