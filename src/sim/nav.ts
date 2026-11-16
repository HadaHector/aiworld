// How creatures find their way on the server (NAVIGATION.md): through a dungeon by its walk lines'
// graph, on the surface straight (until the surface's tiles, step 3). A way between a dungeon and
// anywhere outside it is none: each side's creatures stay on their side (the user's call, NAVIGATION.md *Decisions*).
import type { Vec3 } from "../world/collision/vec";
import type { NavQuery } from "../world/nav/navQuery";
import { buildDungeonGraph, dungeonPath, shortcut, type DungeonGraph } from "../world/nav/dungeonNav";
import type { Dimension } from "./dimension";
import type { PlacedDungeon } from "./dungeons";

export function createServerNav(dimension: (id: string) => Dimension | undefined): NavQuery {
  const graphs = new WeakMap<PlacedDungeon, DungeonGraph>();
  const graphOf = (d: PlacedDungeon): DungeonGraph => {
    let g = graphs.get(d);
    if (!g) graphs.set(d, (g = buildDungeonGraph(d.layout)));
    return g;
  };
  /** Where each end is: the dimension, and the dungeon it is in (null: the surface). */
  const where = (id: string, a: Vec3, b: Vec3) => {
    const dim = dimension(id);
    const dungeons = dim?.dungeons;
    return { dim, from: dungeons?.at(a.x, a.y, a.z) ?? null, to: dungeons?.at(b.x, b.y, b.z) ?? null };
  };
  return {
    path(id, from, to, budget) {
      const w = where(id, from, to);
      if (!w.dim || (!w.from && !w.to)) return [{ ...to }];
      if (w.from !== w.to || !w.from) return null;
      return dungeonPath(graphOf(w.from), w.dim.collision.world, from, to, budget);
    },
    straight(id, from, to) {
      const w = where(id, from, to);
      if (!w.dim || (!w.from && !w.to)) return true;
      if (w.from !== w.to) return false;
      return shortcut(graphOf(w.from!), w.dim.collision.world, from, to);
    },
    reachable(id, from, to) {
      const w = where(id, from, to);
      if (!w.dim || (!w.from && !w.to)) return true;
      if (w.from !== w.to || !w.from) return false;
      return dungeonPath(graphOf(w.from), w.dim.collision.world, from, to, 4000) !== null;
    },
  };
}
