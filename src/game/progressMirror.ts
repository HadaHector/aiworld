import type { Progress, ProgressEventState, ServerMessage } from "../sim/protocol";

/**
 * What the server last said of the own player's progress (PROGRESSION.md, *The client*): its
 * disciplines, points, talents and what it has learned - the panel and the frame's XP bar draw
 * from it - and the events of each step, handed to whoever listens (floating XP, sounds).
 */
export interface ProgressMirror {
  /** Null until the server has said. */
  readonly progress: Progress | null;
  /** The latest events, newest last (the last 40). */
  readonly recent: readonly ProgressEventState[];
  /** Takes a message if it is about progress; true if it was. */
  apply: (message: ServerMessage) => boolean;
  onChange: (listener: () => void) => void;
  onEvents: (listener: (events: readonly ProgressEventState[]) => void) => void;
}

export function createProgressMirror(): ProgressMirror {
  let progress: Progress | null = null;
  const recent: ProgressEventState[] = [];
  const changed: (() => void)[] = [];
  const evented: ((events: readonly ProgressEventState[]) => void)[] = [];
  return {
    get progress() {
      return progress;
    },
    recent,
    apply(message) {
      if (message.type === "progress") {
        progress = message;
        for (const listener of changed) listener();
        return true;
      }
      if (message.type === "progressEvents") {
        recent.push(...message.events);
        if (recent.length > 40) recent.splice(0, recent.length - 40);
        for (const listener of evented) listener(message.events);
        return true;
      }
      return false;
    },
    onChange: (listener) => void changed.push(listener),
    onEvents: (listener) => void evented.push(listener),
  };
}
