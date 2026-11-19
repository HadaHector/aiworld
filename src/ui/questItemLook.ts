import { renderText, type TextTable } from "../sim/text";
import { bindOf, type QuestDef } from "../sim/quests/quest";
import type { IconSpec } from "./icons";

/**
 * What a quest item is called and drawn as (QUESTS.md, *Quest items*). An item is of a type, and a quest
 * item's roll is its quest line's (`bindOf`), so the quest line the client was told of says its name -
 * "Letter for Thilsell" - and which icon and tint it has, in place of its type's. An item with no
 * quest line known to the client is shown as its type.
 */
export interface QuestItemLook {
  name: string;
  /** An icon name, or "" for the type's own. */
  icon: string;
  /** A placeholder tint, or "". */
  tint: string;
  /** The title of the quest it is for. */
  quest: string;
}

export interface QuestItemLooks {
  of(item: { type: string; roll: number }): QuestItemLook | null;
}

/** Looks for quest items from the quests a client has been sent whole; the text is translated and filled as the log's is. */
export function createQuestItemLooks(defs: () => ReadonlyMap<string, QuestDef>, text: () => TextTable | null): QuestItemLooks {
  let known = -1;
  let index = new Map<string, QuestDef>();
  return {
    of(item) {
      const all = defs();
      if (all.size !== known) {
        known = all.size;
        index = new Map();
        for (const def of all.values()) for (const type of Object.keys(def.itemLooks ?? {})) index.set(`${type}/${bindOf(def)}`, def);
      }
      const def = index.get(`${item.type}/${item.roll}`);
      const look = def?.itemLooks?.[item.type];
      if (!def || !look) return null;
      return { name: renderText(look.name, text()), icon: look.icon, tint: look.tint, quest: renderText(def.text.title, text()) };
    },
  };
}

let current: QuestItemLooks | null = null;

/** The session sets where looks come from (the quest mirror); screens ask `questItemLook`. */
export function setQuestItemLooks(looks: QuestItemLooks | null): void {
  current = looks;
}

export const questItemLook = (item: { type: string; roll: number }): QuestItemLook | null => current?.of(item) ?? null;

/** An icon with a quest item's look on it: its own icon where it has one, its tint over the placeholder. */
export function lookedIcon(icon: IconSpec, look: QuestItemLook | null): IconSpec {
  return look ? { ...icon, name: look.icon || icon.name, color: look.tint || icon.color } : icon;
}
