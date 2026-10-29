import type { GameRules } from "../sim/rules/gameRules";
import type { ItemRules } from "../sim/rules/itemRules";
import { describeSkill } from "../sim/rules/skillText";
import type { EntityMirror } from "../game/entityMirror";
import type { BelongingsMirror } from "../game/belongingsMirror";
import { GOLD, SLOT, SLOT_CLASS } from "./theme";

/**
 * The action bar: twelve slots on keys 1-9, 0, - and =, each holding a spell, the attack toggle or
 * an item to use (bread). The player arranges it: drag from the spell book or the bag onto a slot,
 * drag a slot onto another to swap them, off the bar to clear it. Spells learned later go into the
 * first free slot. The layout is kept per character in this browser - a character save will hold it
 * later.
 */
export type BarAction = { kind: "skill"; skill: string } | { kind: "item"; item: string } | { kind: "attack" } | { kind: "teleport" };

export interface ActionBar {
  readonly element: HTMLElement;
  /** Uses slot n (0-based): the key handler's (`byKey`), or a click on the slot. */
  press: (slot: number, byKey?: boolean) => void;
  /** The key that uses slot n, as shown on it. */
  readonly keys: readonly string[];
  /** Fits the slots into a width (the HUD's layout pass). */
  fitWidth: (width: number) => void;
  /** Redraws cooldowns and counts - each frame. */
  update: () => void;
  dispose: () => void;
}

export interface ActionBarOptions {
  game: GameRules;
  items: ItemRules;
  mirror: EntityMirror;
  belongings: BelongingsMirror;
  ownId: () => number;
  /** Who the layout belongs to: one is kept per key. */
  character: string;
  cast: (skill: number) => void;
  setAttacking: (on: boolean) => void;
  /** Uses an item from a bag slot. */
  useItem: (bagSlot: number) => void;
  /** The debug teleport: to the pointer at once from a key, or aimed by the next click from the bar. */
  teleport: (byKey: boolean) => void;
}

/** What a drag carries onto the bar, as JSON under this type: a BarAction. */
export const ACTION_DRAG_TYPE = "application/x-aiworld-action";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="];

/** When the bar last took a drop: a drag that ends then was put on the bar, not let go of - the bag
 *  reads it so an item dragged onto the bar is not dropped on the ground. */
let lastTaken = -Infinity;
export const takenByBar = (): boolean => performance.now() - lastTaken < 1000;
const STORAGE = "aiworld.actionBar.";
/** Marks, in `seen`, that the bar was given the teleport. */
const TELEPORT_SEEN = "@teleport";
export const TELEPORT_TEXT = "Puts you where the pointer is: its key teleports at once, a click on the slot waits for a click on the world (Escape to cancel).";
const BAG = 0;

interface Saved {
  slots: (BarAction | null)[];
  /** Spells the bar has been given already: one taken off it is not put back. */
  seen: string[];
}

function el(tag: string, css: string, parent?: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  parent?.appendChild(e);
  return e;
}

const same = (a: BarAction | null, b: BarAction | null): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createActionBar(parent: HTMLElement, options: ActionBarOptions): ActionBar {
  const { game, items, mirror, belongings } = options;
  const key = STORAGE + options.character;
  let saved: Saved = { slots: [{ kind: "attack" }, ...new Array(KEYS.length - 1).fill(null)], seen: [] };
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Saved;
      if (Array.isArray(parsed.slots) && Array.isArray(parsed.seen)) saved = { slots: KEYS.map((_, i) => parsed.slots[i] ?? null), seen: parsed.seen };
    }
  } catch {
    // Nothing kept, or storage closed: the default bar.
  }
  const save = (): void => {
    try {
      localStorage.setItem(key, JSON.stringify(saved));
    } catch {
      // Kept for this visit only.
    }
  };

  const root = el("div", "display: flex; gap: 4px;", parent);
  let slotWidth = 56;
  const cells = KEYS.map((label, i) => {
    const cell = el("div", `position: relative; width: ${slotWidth}px; height: 48px; ${SLOT} cursor: pointer; overflow: hidden; text-align: center; font: 11px/1.2 system-ui, sans-serif; user-select: none;`, root);
    cell.className = SLOT_CLASS;
    cell.draggable = true;
    el("div", `position: absolute; left: 4px; top: 2px; font: 700 10px/1 system-ui, sans-serif; color: ${GOLD}; text-shadow: 0 1px 1px #000; z-index: 2;`, cell).textContent = label;
    const name = el("div", "position: absolute; left: 3px; right: 3px; top: 15px; font-size: 10px; line-height: 1.15; text-shadow: 0 1px 2px #000;", cell);
    const count = el("div", "position: absolute; right: 3px; bottom: 2px; font: 700 10px/1 system-ui, sans-serif; color: #fff; text-shadow: 0 1px 1px #000; z-index: 2;", cell);
    const cool = el("div", `position: absolute; left: 0; right: 0; bottom: 0; height: 0; background: rgba(0, 0, 0, 0.66); font: 700 15px/48px system-ui, sans-serif; color: ${GOLD}; text-shadow: 0 1px 2px #000;`, cell);
    cell.addEventListener("click", () => press(i, false));
    // Dragging: a slot onto another swaps them; off the bar clears it.
    cell.addEventListener("dragstart", (e) => {
      const action = saved.slots[i];
      if (!action) return e.preventDefault();
      e.dataTransfer?.setData(ACTION_DRAG_TYPE, JSON.stringify(action));
      e.dataTransfer?.setData("text/x-aiworld-bar-slot", String(i));
      dragFrom = i;
      dropped = false;
    });
    cell.addEventListener("dragend", () => {
      if (dragFrom === i && !dropped) set(i, null);
      dragFrom = -1;
    });
    cell.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(ACTION_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    cell.addEventListener("drop", (e) => {
      const raw = e.dataTransfer?.getData(ACTION_DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      lastTaken = performance.now();
      const action = JSON.parse(raw) as BarAction;
      if (dragFrom >= 0) {
        // From another slot of the bar: swap.
        dropped = true;
        const other = saved.slots[i];
        saved.slots[dragFrom] = other;
        saved.slots[i] = action;
        save();
        draw();
      } else set(i, action);
    });
    return { cell, name, count, cool };
  });
  let dragFrom = -1;
  let dropped = false;

  function set(i: number, action: BarAction | null): void {
    // An action is on the bar once: dropping it elsewhere moves it.
    if (action) saved.slots = saved.slots.map((a, k) => (k !== i && same(a, action) ? null : a));
    saved.slots[i] = action;
    if (action?.kind === "skill" && !saved.seen.includes(action.skill)) saved.seen.push(action.skill);
    save();
    draw();
  }

  /** The bag slot holding an item type, or -1. */
  const bagSlotOf = (type: string): number => belongings.containers[BAG]?.findIndex((s) => s?.type === type) ?? -1;
  const bagCount = (type: string): number => (belongings.containers[BAG] ?? []).reduce((n, s) => n + (s?.type === type ? s.count : 0), 0);

  function press(i: number, byKey = false): void {
    const action = saved.slots[i];
    if (!action) return;
    if (action.kind === "teleport") options.teleport(byKey);
    else if (action.kind === "attack") options.setAttacking(!mirror.own.attacking);
    else if (action.kind === "skill") {
      const skill = game.skillIndex.get(action.skill);
      if (skill !== undefined && mirror.own.spells.some((s) => s.skill === skill)) options.cast(skill);
    } else {
      const slot = bagSlotOf(action.item);
      if (slot >= 0) options.useItem(slot);
    }
  }

  /** What a slot says about its action, on hover. */
  function tooltip(action: BarAction): string {
    if (action.kind === "attack") return "Attack\nSwing at your target with your weapon until you stop or it dies. Press again to stop.";
    if (action.kind === "teleport") return `Teleport (debug)\n${TELEPORT_TEXT}`;
    if (action.kind === "skill") {
      const skill = game.skills[game.skillIndex.get(action.skill) ?? -1];
      return skill ? [skill.name, ...describeSkill(game, skill)].join("\n") : action.skill;
    }
    const type = items.types[items.typeIndex.get(action.item) ?? -1];
    return type ? `${type.name}\nUse it from your bag.` : action.item;
  }

  function draw(): void {
    saved.slots.forEach((action, i) => {
      const c = cells[i];
      c.cell.title = action ? `${tooltip(action)}\n\nDrag to move it, or off the bar to clear the slot.` : "Empty: drag a spell from the spell book (L) or an item from your bag here.";
      if (!action) c.name.textContent = "";
      else if (action.kind === "attack") c.name.textContent = "Attack";
      else if (action.kind === "teleport") c.name.textContent = "Teleport";
      else if (action.kind === "skill") c.name.textContent = game.skills[game.skillIndex.get(action.skill) ?? -1]?.name ?? "?";
      else {
        const type = items.types[items.typeIndex.get(action.item) ?? -1];
        c.name.textContent = type?.name ?? "?";
        c.name.style.color = type ? items.rarities[type.rarity].color : "";
      }
      if (action?.kind !== "item") c.name.style.color = "";
      c.cell.style.opacity = action ? "1" : "0.55";
    });
  }

  /** Spells learned since the bar last looked go into the first free slots. */
  let lastSpells = "";
  function placeNew(): void {
    // The debug teleport is given once, in the last free slot.
    if (!saved.seen.includes(TELEPORT_SEEN)) {
      saved.seen.push(TELEPORT_SEEN);
      const free = saved.slots.lastIndexOf(null);
      if (free >= 0 && !saved.slots.some((a) => a?.kind === "teleport")) saved.slots[free] = { kind: "teleport" };
      save();
      draw();
    }
    const known = mirror.own.spells.filter((s) => !game.skills[s.skill]?.passive).map((s) => game.skills[s.skill].id);
    const signature = known.join(",");
    if (signature === lastSpells) return;
    lastSpells = signature;
    let changed = false;
    for (const id of known) {
      if (saved.seen.includes(id)) continue;
      saved.seen.push(id);
      changed = true;
      if (saved.slots.some((a) => a?.kind === "skill" && a.skill === id)) continue;
      const free = saved.slots.indexOf(null);
      if (free >= 0) saved.slots[free] = { kind: "skill", skill: id };
    }
    if (changed) {
      save();
      draw();
    }
  }

  function update(): void {
    placeNew();
    const now = mirror.serverTime();
    const own = mirror.own;
    const ownEntity = mirror.entities.get(options.ownId());
    saved.slots.forEach((action, i) => {
      const c = cells[i];
      let left = 0;
      let usable = true;
      let lit = false;
      let count = "";
      if (action?.kind === "skill") {
        const skill = game.skillIndex.get(action.skill) ?? -1;
        const def = game.skills[skill];
        const spell = own.spells.find((s) => s.skill === skill);
        if (!spell || !def) usable = false;
        else {
          const gcd = def.gcd !== "none" ? own.gcdUntil : 0;
          left = Math.max(spell.ready, gcd) - now;
          // Greyed when the cost cannot be paid - from what the mirror has of the own resources.
          usable = !def.cost.some((cost) => cost.amount.constant !== null && (ownEntity?.resources.get(cost.resource)?.current ?? 0) < cost.amount.constant);
        }
      } else if (action?.kind === "attack") lit = own.attacking;
      else if (action?.kind === "item") {
        const n = bagCount(action.item);
        usable = n > 0;
        count = String(n);
      }
      if (action) c.cell.style.opacity = usable ? "1" : "0.5";
      c.cell.style.boxShadow = lit ? "0 0 0 1px #000, 0 0 10px rgba(240, 201, 121, 0.7), inset 0 0 12px rgba(240, 201, 121, 0.35)" : "";
      c.cell.style.borderColor = lit ? GOLD : "";
      if (c.count.textContent !== count) c.count.textContent = count;
      if (left > 0.05) {
        c.cool.style.height = "100%";
        const label = left > 1.6 ? left.toFixed(0) : "";
        if (c.cool.textContent !== label) c.cool.textContent = label;
      } else if (c.cool.style.height !== "0px") {
        c.cool.style.height = "0";
        c.cool.textContent = "";
      }
    });
  }

  draw();
  return {
    element: root,
    keys: KEYS,
    press,
    fitWidth(width) {
      // Twelve slots and their gaps within the width, from 56 px down to 34.
      const fit = Math.max(34, Math.min(56, Math.floor((width - (KEYS.length - 1) * 4) / KEYS.length)));
      if (fit === slotWidth) return;
      slotWidth = fit;
      for (const c of cells) c.cell.style.width = `${fit}px`;
    },
    update,
    dispose: () => root.remove(),
  };
}
