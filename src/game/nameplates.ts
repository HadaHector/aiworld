import { Matrix, Vector3, type Scene } from "@babylonjs/core";
import type { EntityMirror, MirroredEntity } from "./entityMirror";
import { PLAYER_TEMPLATE } from "../sim/rules/gameRules";
import { FLAG } from "../sim/skills/flags";
import { GOLD, TEXT, TITLE_FONT } from "../ui/theme";

/**
 * Names over the heads of the people of the world (NPCS.md, *NPCs in the world*): an NPC's name with
 * its title under it, WoW style, for those near enough; and what they say (barks) in a bubble over
 * them for a few seconds. Drawn as DOM over the canvas, as the health bars are. Later the quest
 * markers sit above the name (QUESTS.md, *Markers*).
 */
export interface Nameplates {
  /** Places every plate over its unit - each frame. */
  update: (targetId: number) => void;
  /** Something an entity says, shown over it for a while. */
  bark: (entity: number, text: string) => void;
  /** What stands over an entity's name (a quest marker), or "" for nothing. */
  setMark: (entity: number, mark: string, colour: string) => void;
  dispose: () => void;
}

/** Plates farther off than this are hidden. */
const RANGE = 28;
const OVER_HEAD = 0.35;
/** How long a bark stays up, in seconds. */
const BARK_TIME = 6;

interface Plate {
  root: HTMLElement;
  mark: HTMLElement;
  bubble: HTMLElement;
  name: HTMLElement;
  title: HTMLElement;
  barkUntil: number;
}

/** A settlement's person: friendly, and not of the players' side - not a player, a creature or a chest. */
export const isNpc = (entity: MirroredEntity): boolean =>
  entity.templateId !== PLAYER_TEMPLATE && entity.template?.hostility === "friendly" && entity.template?.faction !== "players";

/** Who gets a plate: a living NPC. */
const shows = (entity: MirroredEntity): boolean => isNpc(entity) && (entity.flags & (1 << FLAG.dead)) === 0;

export function createNameplates(scene: Scene, mirror: EntityMirror, ownId: () => number): Nameplates {
  const layer = document.createElement("div");
  // With the health bars: under the floating numbers (940), over the world.
  layer.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 931; pointer-events: none;";
  document.body.appendChild(layer);
  const plates = new Map<number, Plate>();
  const marks = new Map<number, { mark: string; colour: string }>();
  const at = new Vector3();
  const onScreen = new Vector3();

  function plateFor(id: number): Plate {
    let plate = plates.get(id);
    if (plate) return plate;
    const root = document.createElement("div");
    root.style.cssText = "position: absolute; left: 0; top: 0; display: flex; flex-direction: column; align-items: center; will-change: transform; white-space: nowrap;";
    const bubble = document.createElement("div");
    bubble.style.cssText = `display: none; max-width: 240px; white-space: normal; margin-bottom: 6px; padding: 5px 9px; border-radius: 9px;
      background: rgba(250, 244, 228, 0.94); color: #2a2318; font: 13px/1.3 ${TITLE_FONT}; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,0.5);`;
    const mark = document.createElement("div");
    mark.style.cssText = `display: none; font: 700 26px/1 ${TITLE_FONT}; text-shadow: 0 0 3px #000, 0 1px 2px #000; margin-bottom: 1px;`;
    const name = document.createElement("div");
    name.style.cssText = `font: 600 13px/1.15 ${TITLE_FONT}; color: ${GOLD}; text-shadow: 0 1px 2px #000, 0 0 3px #000;`;
    const title = document.createElement("div");
    title.style.cssText = `font: 11px/1.15 ${TITLE_FONT}; color: ${TEXT}; opacity: 0.85; text-shadow: 0 1px 2px #000, 0 0 3px #000;`;
    root.append(bubble, mark, name, title);
    layer.appendChild(root);
    plate = { root, mark, bubble, name, title, barkUntil: 0 };
    plates.set(id, plate);
    return plate;
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
      const now = performance.now() / 1000;
      const seen = new Set<number>();
      for (const entity of mirror.entities.values()) {
        if (!camera || !shows(entity)) continue;
        if (own && Math.hypot(entity.x - own.x, entity.z - own.z) > RANGE) continue;
        at.set(entity.x, entity.y + (entity.template?.look.height ?? 1.8) + OVER_HEAD, entity.z);
        Vector3.ProjectToRef(at, Matrix.IdentityReadOnly, scene.getTransformMatrix(), camera.viewport.toGlobal(width, height), onScreen);
        if (onScreen.z < 0 || onScreen.z > 1) continue;
        seen.add(entity.id);
        const plate = plateFor(entity.id);
        if (plate.name.textContent !== entity.name) plate.name.textContent = entity.name;
        if (plate.title.textContent !== entity.title) plate.title.textContent = entity.title ? `<${entity.title}>` : "";
        plate.name.style.textDecoration = entity.id === targetId ? "underline" : "none";
        const mark = marks.get(entity.id);
        plate.mark.style.display = mark ? "" : "none";
        if (mark && plate.mark.textContent !== mark.mark) plate.mark.textContent = mark.mark;
        if (mark) plate.mark.style.color = mark.colour;
        plate.bubble.style.display = now < plate.barkUntil ? "" : "none";
        const x = (rect?.left ?? 0) + onScreen.x * scaleX;
        const y = (rect?.top ?? 0) + onScreen.y * scaleY;
        plate.root.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        plate.root.style.display = "";
      }
      for (const [id, plate] of plates) {
        if (seen.has(id)) continue;
        if (!mirror.entities.has(id)) {
          plate.root.remove();
          plates.delete(id);
        } else plate.root.style.display = "none";
      }
    },
    bark(entity, text) {
      const plate = plateFor(entity);
      plate.bubble.textContent = text;
      plate.barkUntil = performance.now() / 1000 + BARK_TIME;
    },
    setMark(entity, mark, colour) {
      if (mark) marks.set(entity, { mark, colour });
      else marks.delete(entity);
    },
    dispose() {
      layer.remove();
      plates.clear();
    },
  };
}
