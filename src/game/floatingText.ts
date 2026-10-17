import { Matrix, Vector3, type Scene } from "@babylonjs/core";
import type { EntityMirror } from "./entityMirror";
import type { GameRules } from "../sim/rules/gameRules";
import type { CombatEvent } from "../sim/protocol";
import { EVENT_FLAG, EVENT_KIND } from "../sim/skills/events";

/**
 * Floating combat text (see ABILITIES.md, *The test*): numbers rising over the unit a hit or a heal
 * lands on, from the combat events the client is sent - only the own player's fights, what it deals
 * and what it takes. WoW Classic's look: white for what the player deals, red for what it takes,
 * green for healing, crits bigger, misses and the like as words.
 */
export interface FloatingText {
  add: (events: readonly CombatEvent[]) => void;
  /** Moves and fades every number - each frame. */
  update: () => void;
  dispose: () => void;
}

/** Seconds a number lives; a crit lingers longer. */
const LIFE = 1.4;
const CRIT_LIFE = 1.9;
/** How far it rises, CSS pixels. */
const RISE = 56;
const FONT = "font: 700 18px/1 system-ui, sans-serif;";

interface Floater {
  el: HTMLElement;
  entity: number;
  born: number;
  life: number;
  /** Sideways, so numbers landing together do not sit on each other. */
  dx: number;
  crit: boolean;
}

export function createFloatingText(scene: Scene, mirror: EntityMirror, rules: GameRules, ownId: () => number): FloatingText {
  const root = document.createElement("div");
  root.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 940; pointer-events: none;";
  document.body.appendChild(root);
  const floaters: Floater[] = [];
  const at = new Vector3();
  const onScreen = new Vector3();
  let stagger = 0;

  function spawn(entity: number, label: string, colour: string, crit: boolean, small: boolean): void {
    const el = document.createElement("div");
    const size = crit ? 1.6 : small ? 0.8 : 1;
    el.style.cssText = `position: absolute; left: 0; top: 0; ${FONT} font-size: ${Math.round(18 * size)}px; color: ${colour};
      white-space: nowrap; text-shadow: 0 0 3px #000, 0 1px 2px #000; will-change: transform, opacity;`;
    el.textContent = label;
    root.appendChild(el);
    // Alternate left and right of the unit, a little further each time, wrapping round.
    stagger = (stagger + 1) % 5;
    const dx = (stagger - 2) * 18;
    floaters.push({ el, entity, born: performance.now() / 1000, life: crit ? CRIT_LIFE : LIFE, dx, crit });
  }

  function add(events: readonly CombatEvent[]): void {
    const own = ownId();
    for (const e of events) {
      // Only the own player's fights: what it deals, and what it takes.
      const dealt = e.source === own && e.target !== own;
      const taken = e.target === own;
      if (!dealt && !taken) continue;
      const crit = (e.flags & EVENT_FLAG.crit) !== 0;
      const periodic = (e.flags & EVENT_FLAG.periodic) !== 0;
      const n = Math.round(e.amount);
      const absorbed = Math.round(e.absorbed);
      const spell = rules.skills[e.skill]?.type === "spell";
      const hitColour = taken ? "#ff4a3a" : spell ? "#ffe25a" : "#ffffff";
      switch (e.kind) {
        case EVENT_KIND.hit: {
          if (n > 0) spawn(e.target, `${taken ? "-" : ""}${n}${crit ? "!" : ""}`, hitColour, crit, periodic);
          if (absorbed > 0) spawn(e.target, n > 0 ? `(${absorbed} absorbed)` : "Absorb", "#c8c8c8", false, true);
          break;
        }
        case EVENT_KIND.miss:
          spawn(e.target, e.flags & EVENT_FLAG.immune ? "Immune" : "Miss", "#e0e0e0", false, false);
          break;
        case EVENT_KIND.heal:
          // Healing that only overheals says nothing.
          if (n > 0) spawn(e.target, `+${n}${crit ? "!" : ""}`, "#4ee45e", crit, periodic);
          break;
        case EVENT_KIND.resisted:
          spawn(e.target, "Resist", "#e0e0e0", false, false);
          break;
        case EVENT_KIND.interrupted:
          if (dealt) spawn(e.target, "Interrupted", "#ffb030", false, true);
          break;
      }
    }
  }

  function update(): void {
    const camera = scene.activeCamera;
    const engine = scene.getEngine();
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    const rect = engine.getRenderingCanvasClientRect();
    const scaleX = rect ? rect.width / width : 1;
    const scaleY = rect ? rect.height / height : 1;
    const now = performance.now() / 1000;
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const age = now - f.born;
      const unit = mirror.entities.get(f.entity);
      if (age >= f.life || !unit || !camera) {
        f.el.remove();
        floaters.splice(i, 1);
        continue;
      }
      // Over the unit's head.
      const tall = unit.template?.look.height ?? 1.8;
      at.set(unit.x, unit.y + tall + 0.3, unit.z);
      Vector3.ProjectToRef(at, Matrix.IdentityReadOnly, scene.getTransformMatrix(), camera.viewport.toGlobal(width, height), onScreen);
      if (onScreen.z < 0 || onScreen.z > 1) {
        f.el.style.opacity = "0";
        continue;
      }
      const t = age / f.life;
      // A crit pops in large and settles; everything rises, easing out, and fades at the end.
      const pop = f.crit ? 1 + 0.5 * Math.max(0, 1 - age / 0.15) : 1;
      const x = (rect?.left ?? 0) + onScreen.x * scaleX + f.dx;
      const y = (rect?.top ?? 0) + onScreen.y * scaleY - RISE * (1 - (1 - t) * (1 - t));
      f.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${pop})`;
      f.el.style.opacity = String(Math.min(1, (1 - t) / 0.35));
    }
  }

  return {
    add,
    update,
    dispose() {
      for (const f of floaters) f.el.remove();
      floaters.length = 0;
      root.remove();
    },
  };
}
