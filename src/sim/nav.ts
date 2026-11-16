// How creatures find their way on the server (NAVIGATION.md): through a dungeon by its walk lines'
// graph, over the surface by its tiles, through a house with rooms by its tiles' graph - in at one
// of its doors, over the surface between. A way between a dungeon and anywhere outside it is none:
// each side's creatures stay on their side (the user's call, NAVIGATION.md *Decisions*).
import type { Vec3 } from "../world/collision/vec";
import type { NavQuery } from "../world/nav/navQuery";
import { buildDungeonGraph, dungeonPath, shortcut, type DungeonGraph } from "../world/nav/dungeonNav";
import { createSurfaceNav, type SurfaceNav } from "../world/nav/surfaceNav";
import { buildHouseGraph, houseNodeAt, housePath, type HouseGraph } from "../world/nav/houseNav";
import { walkableStraight } from "../world/nav/dungeonNav";
import type { Enterable } from "../world/buildings/buildingCollision";
import type { NavAgent } from "../world/nav/navQuery";
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
  // Houses with rooms, bucketed by where they stand, and each one's graph once made.
  const HOUSE_CELL = 32;
  const houseBuckets = new WeakMap<Dimension, Map<string, Enterable[]>>();
  const houseGraphs = new WeakMap<Enterable, HouseGraph>();
  const bucketsOf = (dim: Dimension): Map<string, Enterable[]> => {
    let b = houseBuckets.get(dim);
    if (!b) {
      b = new Map();
      for (const e of dim.buildings.enterable) {
        for (let cx = Math.floor((e.house.x - e.reach) / HOUSE_CELL); cx <= Math.floor((e.house.x + e.reach) / HOUSE_CELL); cx++) {
          for (let cz = Math.floor((e.house.z - e.reach) / HOUSE_CELL); cz <= Math.floor((e.house.z + e.reach) / HOUSE_CELL); cz++) {
            const key = `${cx},${cz}`;
            const list = b.get(key);
            if (list) list.push(e);
            else b.set(key, [e]);
          }
        }
      }
      houseBuckets.set(dim, b);
    }
    return b;
  };
  const houseGraphOf = (dim: Dimension, e: Enterable): HouseGraph => {
    let g = houseGraphs.get(e);
    if (!g || !g.whole) {
      // Made before the collision round it was in: its furniture was not looked at - made again.
      g = buildHouseGraph(e, dim.collision.world, dim.world.heightAt, dim.collision.hasGroundAt(e.house.x, e.house.z));
      houseGraphs.set(e, g);
    }
    return g;
  };
  /** The house with rooms a point is in, and the node it stands on, or null outside every one. */
  const houseAt = (dim: Dimension, p: Vec3): { g: HouseGraph; node: number } | null => {
    for (const e of bucketsOf(dim).get(`${Math.floor(p.x / HOUSE_CELL)},${Math.floor(p.z / HOUSE_CELL)}`) ?? []) {
      if (Math.hypot(p.x - e.house.x, p.z - e.house.z) > e.reach) continue;
      const g = houseGraphOf(dim, e);
      const node = houseNodeAt(g, p);
      if (node !== null) return { g, node };
    }
    return null;
  };
  /**
   * A way over the surface that may begin or end in a house: out of the one `from` is in by the door
   * that makes the way shortest as the crow flies, over the tiles, and in at the one `to` is in.
   */
  const surfaceWay = (dim: Dimension, from: Vec3, to: Vec3, budget: number, agent?: NavAgent): Vec3[] | null => {
    const a = houseAt(dim, from), b = houseAt(dim, to);
    const surface = surfaceOf(dim);
    if (!a && !b) return surface.path(from, to, budget, agent);
    const world = dim.collision.world;
    if (a && b && a.g === b.g) return housePath(a.g, world, from, a.node, to, b.node);
    const doorOf = (h: { g: HouseGraph }, toward: Vec3): number | null => {
      let best: number | null = null, bestD = Infinity;
      for (const x of h.g.exits) {
        const d = Math.hypot(h.g.points[x].x - toward.x, h.g.points[x].z - toward.z);
        if (d < bestD) [best, bestD] = [x, d];
      }
      return best;
    };
    const way: Vec3[] = [];
    let at = from;
    let outB: number | null = null;
    if (b) {
      outB = doorOf(b, from);
      if (outB === null) return null;
    }
    if (a) {
      const out = doorOf(a, outB !== null ? b!.g.points[outB] : to);
      if (out === null) return null;
      const leg = housePath(a.g, world, from, a.node, a.g.points[out], out);
      if (!leg) return null;
      way.push(...leg);
      at = a.g.points[out];
    }
    const outside = outB !== null ? b!.g.points[outB] : to;
    const leg = surface.path(at, outside, budget, agent);
    if (!leg) return null;
    way.push(...leg);
    if (b && outB !== null) {
      const last = housePath(b.g, world, outside, outB, to, b.node);
      if (!last) return null;
      way.push(...last);
    }
    return way;
  };
  /** Straight on the surface: within one level of one house by rays, between a house and anywhere
   *  else never (a way goes by a door), else over the tiles. */
  const surfaceStraight = (dim: Dimension, from: Vec3, to: Vec3, agent?: NavAgent): boolean => {
    const a = houseAt(dim, from), b = houseAt(dim, to);
    if (!a && !b) return surfaceOf(dim).straight(from, to, agent);
    if (!a || !b || a.g !== b.g) return false;
    return Math.abs(from.y - to.y) < 1 && walkableStraight(dim.collision.world, from, to);
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
      return w.from ? dungeonPath(graphOf(w.from), w.dim.collision.world, from, to, budget) : surfaceWay(w.dim, from, to, budget, agent);
    },
    straight(id, from, to, agent) {
      const w = where(id, from, to);
      if (!w.dim) return true;
      if (w.from !== w.to) return false;
      return w.from ? shortcut(graphOf(w.from), w.dim.collision.world, from, to) : surfaceStraight(w.dim, from, to, agent);
    },
    reachable(id, from, to, agent) {
      const w = where(id, from, to);
      if (!w.dim) return true;
      if (w.from !== w.to) return false;
      if (w.from) return dungeonPath(graphOf(w.from), w.dim.collision.world, from, to, REACHABLE_NODES) !== null;
      return surfaceStraight(w.dim, from, to, agent) || surfaceWay(w.dim, from, to, REACHABLE_NODES, agent) !== null;
    },
    surface(id) {
      const dim = dimension(id);
      return dim && surfaceOf(dim);
    },
  };
}
