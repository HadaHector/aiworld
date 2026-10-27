import { Matrix, Vector3, type Scene } from "@babylonjs/core";
import type { EntityMirror, MirroredEntity } from "./entityMirror";
import { PLAYER_TEMPLATE, type GameRules } from "../sim/rules/gameRules";
import { FLAG } from "../sim/skills/flags";

/**
 * Health bars floating over the units a player fights (CREATURES.md): every living hostile or
 * neutral unit in view near enough to matter, red for hostile and yellow for neutral as their names
 * on the target frame are, the selected one outlined, and a red glow round the bar of every unit
 * attacking the player (the one it targets is the player). Drawn as DOM over the canvas, as the floating
 * combat numbers are, from the health the mirror has.
 */
export interface HealthBars {
  /** Places every bar over its unit - each frame. */
  update: (targetId: number) => void;
  dispose: () => void;
}

/** Units farther than this have no bar. */
const RANGE = 50;
/** The bar's size in CSS pixels, and how far over a unit's head it floats. */
const WIDTH = 64;
const HEIGHT = 7;
const OVER_HEAD = 0.25;

interface Bar {
  root: HTMLElement;
  fill: HTMLElement;
}

export function createHealthBars(scene: Scene, mirror: EntityMirror, rules: GameRules, ownId: () => number): HealthBars {
  const layer = document.createElement("div");
  // Under the floating numbers (940), over the world.
  layer.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 930; pointer-events: none;";
  document.body.appendChild(layer);
  const bars = new Map<number, Bar>();
  const at = new Vector3();
  const onScreen = new Vector3();

  function barFor(id: number): Bar {
    let bar = bars.get(id);
    if (bar) return bar;
    const root = document.createElement("div");
    root.style.cssText = `position: absolute; left: 0; top: 0; width: ${WIDTH}px; height: ${HEIGHT}px; box-sizing: border-box;
      background: rgba(0, 0, 0, 0.6); border: 1px solid rgba(0, 0, 0, 0.9); will-change: transform;`;
    const fill = document.createElement("div");
    fill.style.cssText = "height: 100%; width: 100%;";
    root.appendChild(fill);
    layer.appendChild(root);
    bar = { root, fill };
    bars.set(id, bar);
    return bar;
  }

  /** Whether a unit gets a bar: an enemy's - not a player's, a chest's or the dead's. */
  function shows(entity: MirroredEntity, own: MirroredEntity | undefined): boolean {
    if (entity.id === ownId() || entity.templateId === PLAYER_TEMPLATE) return false;
    const hostility = entity.template?.hostility;
    if (hostility !== "hostile" && hostility !== "neutral") return false;
    if ((entity.flags & (1 << FLAG.dead)) !== 0 || !entity.resources.has(rules.health)) return false;
    return !own || Math.hypot(entity.x - own.x, entity.z - own.z) <= RANGE;
  }

  return {
    update(targetId) {
      const camera = scene.activeCamera;
      const engine = scene.getEngine();
      const width = engine.getRenderWidth();
      const height = engine.getRenderHeight();
      const rect = engine.getRenderingCanvasClientRect();
      const scaleX = rect ? rect.width / width : 1;
      const scaleY = rect ? rect.height / height : 1;
      const own = mirror.entities.get(ownId());
      const seen = new Set<number>();
      for (const entity of mirror.entities.values()) {
        if (!camera || !shows(entity, own)) continue;
        at.set(entity.x, entity.y + (entity.template?.look.height ?? 1.8) + OVER_HEAD, entity.z);
        Vector3.ProjectToRef(at, Matrix.IdentityReadOnly, scene.getTransformMatrix(), camera.viewport.toGlobal(width, height), onScreen);
        if (onScreen.z < 0 || onScreen.z > 1) continue;
        seen.add(entity.id);
        const bar = barFor(entity.id);
        const health = entity.resources.get(rules.health)!;
        const share = health.max > 0 ? Math.max(0, Math.min(1, health.current / health.max)) : 0;
        bar.fill.style.width = `${(share * 100).toFixed(1)}%`;
        bar.fill.style.background = entity.template?.hostility === "hostile" ? "#d8352a" : "#e0c234";
        bar.root.style.borderColor = entity.id === targetId ? "#ffffff" : "rgba(0, 0, 0, 0.9)";
        bar.root.style.boxShadow = entity.target === ownId() ? "0 0 4px 2px rgba(255, 40, 30, 0.9)" : "none";
        const x = (rect?.left ?? 0) + onScreen.x * scaleX;
        const y = (rect?.top ?? 0) + onScreen.y * scaleY;
        bar.root.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        bar.root.style.display = "";
      }
      for (const [id, bar] of bars) {
        if (seen.has(id)) continue;
        // Gone for good: dropped; only out of sight or range for now: hidden.
        if (!mirror.entities.has(id)) {
          bar.root.remove();
          bars.delete(id);
        } else bar.root.style.display = "none";
      }
    },
    dispose() {
      bars.clear();
      layer.remove();
    },
  };
}
