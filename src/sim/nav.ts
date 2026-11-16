// How creatures find their way on the server (NAVIGATION.md): through a dungeon by its walk lines'
// graph, over the surface by its tiles. A way between a dungeon and anywhere outside it is none:
// each side's creatures stay on their side (the user's call, NAVIGATION.md *Decisions*).
import type { Vec3 } from "../world/collision/vec";
import type { NavQuery } from "../world/nav/navQuery";
import { buildDungeonGraph, dungeonPath, shortcut, type DungeonGraph } from "../world/nav/dungeonNav";
import { createSurfaceNav, type SurfaceNav } from "../world/nav/surfaceNav";
import type { Dimension } from "./dimension";
import type { PlacedDungeon } from "./dungeons";

/** Search nodes a `reachable` may take. */
const REACHABLE_NODES = 4000;

export interface ServerNav extends NavQuery {
  /** A dimension's surface tiles, for debug drawing. */
  surface(dimension: string): SurfaceNav | undefined;
}

export function createServerNav(dimension: (id: string) => Dimension | undefined): ServerNav {
  const graphs = new WeakMap<PlacedDungeon, DungeonGraph>();
  const graphOf = (d: PlacedDungeon): DungeonGraph => {
    let g = graphs.get(d);
    if (!g) graphs.set(d, (g = buildDungeonGraph(d.layout)));
    return g;
  };
  const surfaces = new WeakMap<Dimension, SurfaceNav>();
  const surfaceOf = (dim: Dimension): SurfaceNav => {
    let s = surfaces.get(dim);
    if (!s) {
      s = createSurfaceNav({
        world: dim.collision.world,
        groundAt: dim.world.heightAt,
        waterAt: dim.world.waterAt,
        // Deep as the creatures' shore test has it (creatures/system.ts).
        get deep() {
          return dim.water ? dim.water.swimDepth - 0.3 : Infinity;
        },
        loaded: dim.collision.hasGroundAt,
      });
      surfaces.set(dim, s);
    }
    return s;
  };
  /** Where each end is: the dimension, and the dungeon it is in (null: the surface). */
  const where = (id: string, a: Vec3, b: Vec3) => {
    const dim = dimension(id);
    const dungeons = dim?.dungeons;
    return { dim, from: dungeons?.at(a.x, a.y, a.z) ?? null, to: dungeons?.at(b.x, b.y, b.z) ?? null };
  };
  return {
    path(id, from, to, budget, agent) {
      const w = where(id, from, to);
      if (!w.dim) return [{ ...to }];
      if (w.from !== w.to) return null;
      return w.from ? dungeonPath(graphOf(w.from), w.dim.collision.world, from, to, budget) : surfaceOf(w.dim).path(from, to, budget, agent);
    },
    straight(id, from, to, agent) {
      const w = where(id, from, to);
      if (!w.dim) return true;
      if (w.from !== w.to) return false;
      return w.from ? shortcut(graphOf(w.from), w.dim.collision.world, from, to) : surfaceOf(w.dim).straight(from, to, agent);
    },
    reachable(id, from, to, agent) {
      const w = where(id, from, to);
      if (!w.dim) return true;
      if (w.from !== w.to) return false;
      if (w.from) return dungeonPath(graphOf(w.from), w.dim.collision.world, from, to, REACHABLE_NODES) !== null;
      const surface = surfaceOf(w.dim);
      return surface.straight(from, to, agent) || surface.path(from, to, REACHABLE_NODES, agent) !== null;
    },
    surface(id) {
      const dim = dimension(id);
      return dim && surfaceOf(dim);
    },
  };
}
