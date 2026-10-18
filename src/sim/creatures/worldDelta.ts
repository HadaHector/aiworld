/**
 * The world delta (GAMEPLAY.md, *World delta*): how the world differs from a fresh generation, as
 * stable generated keys to the world time each thing comes back - a killed creature, an emptied
 * chest. Kept by the server for every dimension at once, so it outlives a dimension being unloaded;
 * saved with the world later. Entries that have passed are dropped, so it stays small however long
 * a world is played.
 */
export interface WorldDelta {
  /** The world time a key comes back, if it has not yet. */
  get(key: string): number | undefined;
  set(key: string, until: number): void;
  delete(key: string): void;
  /** Drops every entry whose time has passed. */
  prune(now: number): void;
  /** Every entry, in key order - for saving later, and the inspector. */
  entries(): [string, number][];
  readonly size: number;
}

export function createWorldDelta(time: () => number): WorldDelta {
  const map = new Map<string, number>();
  return {
    get(key) {
      const until = map.get(key);
      if (until === undefined) return undefined;
      if (until <= time()) {
        map.delete(key);
        return undefined;
      }
      return until;
    },
    set: (key, until) => void map.set(key, until),
    delete: (key) => void map.delete(key),
    prune(now) {
      for (const [key, until] of map) if (until <= now) map.delete(key);
    },
    entries: () => [...map].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    get size() {
      return map.size;
    },
  };
}
