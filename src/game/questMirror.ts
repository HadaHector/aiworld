import type { ServerMessage } from "../sim/protocol";
import type { ActiveQuest, QuestDef } from "../sim/quests/quest";

/**
 * The character's quests as the server has told them (QUESTS.md, *In the game*): every quest it was
 * sent whole, what it has taken with counts and states, and what it has done. The quest log, the
 * tracker and the NPC window draw from this; they never change a quest themselves.
 */
export interface QuestMirror {
  readonly defs: ReadonlyMap<string, QuestDef>;
  readonly active: ReadonlyMap<string, ActiveQuest>;
  readonly done: ReadonlySet<string>;
  /** The last refusal, with the quest it was about. */
  readonly refused: { quest: string; reason: string } | null;
  /** Takes one message; what changed (for sounds), or null when it was not a quest message. */
  apply: (message: ServerMessage) => QuestChange[] | null;
  onChange: (listener: () => void) => () => void;
}

/** What one message changed, for the feedback (FEEDBACK.md's client events). */
export type QuestChange = { quest: string; what: "accepted" | "progress" | "objectiveDone" | "ready" | "failed" | "done" | "removed" | "refused" };

export function createQuestMirror(): QuestMirror {
  const defs = new Map<string, QuestDef>();
  const active = new Map<string, ActiveQuest>();
  const done = new Set<string>();
  const listeners = new Set<() => void>();
  let refused: QuestMirror["refused"] = null;
  const changed = (): void => listeners.forEach((l) => l());

  return {
    defs,
    active,
    done,
    get refused() {
      return refused;
    },
    apply(message) {
      const out: QuestChange[] = [];
      switch (message.type) {
        case "questDefs":
          for (const def of message.defs) defs.set(def.id, def);
          break;
        case "questLog":
          active.clear();
          done.clear();
          for (const a of message.active) active.set(a.id, { ...a, counts: [...a.counts] });
          for (const id of message.done) done.add(id);
          break;
        case "questUpdate": {
          const quest = message.quest;
          const before = active.get(quest);
          if (message.state === "done" || message.state === "removed") {
            active.delete(quest);
            if (message.state === "done") done.add(quest);
            out.push({ quest, what: message.state });
            break;
          }
          const now: ActiveQuest = { id: quest, counts: [...message.counts], state: message.state, accepted: before?.accepted ?? 0 };
          active.set(quest, now);
          if (!before) out.push({ quest, what: "accepted" });
          else if (now.state === "ready" && before.state !== "ready") out.push({ quest, what: "ready" });
          else if (now.state === "failed" && before.state !== "failed") out.push({ quest, what: "failed" });
          else {
            const def = defs.get(quest);
            const finished = def?.objectives.findIndex((o, i) => now.counts[i] > before.counts[i] && now.counts[i] >= neededOf(o)) ?? -1;
            out.push({ quest, what: finished >= 0 ? "objectiveDone" : "progress" });
          }
          break;
        }
        case "questRefused":
          refused = { quest: message.quest, reason: message.reason };
          out.push({ quest: message.quest, what: "refused" });
          break;
        default:
          return null;
      }
      changed();
      return out;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const neededOf = (o: QuestDef["objectives"][number]): number => ("count" in o ? o.count : 1);
