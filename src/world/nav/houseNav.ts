// Ways through a house with rooms (NAVIGATION.md, *Houses*): its interior layout is already a
// graph - a node on each floored tile at its floor's height, joined to its room's other tiles, through
// open doors to the next room, up a stair's tiles to the tile it arrives on, and out of each door to
// a point on the ground before it. A tile a body cannot stand on (a table, a bed) is left out. Rays
// through the colliders pull a way taut where a body can walk straight. Pure and deterministic.
import type { CollisionWorld } from "../collision/collisionWorld";
import { Layers } from "../collision/shapes";
import type { Vec3 } from "../collision/vec";
import type { Enterable } from "../buildings/buildingCollision";
import { cellKey, STEP, type FaceDir } from "../buildings/interiorLayout";
import { WALL } from "../buildings/interiorGeometry";
import { createNodeHeap } from "./heap";

/** A body as a tile sees it: its capsule over the step, as the surface's cells have it. */
const RADIUS = 0.4;
const STEP_UP = 0.75;
const HEAD = 1.8;
/** Where on a tile a body is tried, in tiles from its middle: the middle first, then round it. */
const SPOTS: [number, number][] = [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]];
/** A point this far over or under a level's floor is not on it. */
const ON_FLOOR = 1.2;
const FLOOR_EVERY = 2;
const FLOOR_REACH = 2.2;
/** A finer node's neighbours, in finer steps (half of them, the rest are the same pairs the other way): the next, the diagonal, a knight's move, two along. */
const NET: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1], [2, 1], [1, 2], [2, -1], [1, -2]];
/** How many finer nodes a tile has along a side. */
const SUBS = 6;

export interface HouseGraph {
  enterable: Enterable;
  /** x, y, z per node, in the world. */
  points: Vec3[];
  links: { to: number; cost: number }[][];
  /** Which node each standable tile is, by "i,j,k" (stair tiles by "s,i,j,level"). */
  nodeOf: Map<string, number>;
  /** The nodes on the ground before each door out. */
  exits: number[];
  /** The nodes on a stair's lane, a way never pulled straight across: they are where it turns. */
  stairNodes: Set<number>;
  /** Whether the collision was in when it was made (else its tiles were not tested for furniture). */
  whole: boolean;
}

/** A model-space point of a house in the world, and back. */
function toWorld(e: Enterable, mx: number, my: number, mz: number): Vec3 {
  const { house } = e;
  return { x: house.x + house.frontZ * mx + house.frontX * mz, y: house.y + my, z: house.z - house.frontX * mx + house.frontZ * mz };
}
function toModel(e: Enterable, p: Vec3): Vec3 {
  const { house } = e;
  const dx = p.x - house.x, dz = p.z - house.z;
  return { x: house.frontZ * dx - house.frontX * dz, y: p.y - house.y, z: house.frontX * dx + house.frontZ * dz };
}

/**
 * Whether a body can walk straight from `a` to `b`: a floor all the way, and the body itself swept
 * along it - a chair's back or a table's edge too thin or too high for a ray to meet is met by a
 * capsule 0.7 m across (rays, as `walkableStraight` casts them, miss them).
 */
function walkable(world: CollisionWorld, a: Vec3, b: Vec3): boolean {
  // A floor under it all the way (no drop, no hole), looked for every couple of metres.
  const across = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(across / FLOOR_EVERY));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!world.raycastAny({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + 1, z: a.z + (b.z - a.z) * t }, { x: 0, y: -1, z: 0 }, 1 + FLOOR_REACH)) return false;
  }
  const r = RADIUS - 0.05;
  const at = (p: Vec3) => ({ kind: "capsule" as const, a: { x: p.x, y: p.y + STEP_UP + r, z: p.z }, b: { x: p.x, y: p.y + HEAD - r, z: p.z }, radius: r });
  const hit = world.sweep(at(a), { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, Layers.solid);
  return !hit || hit.shape.kind === "heightfield";
}

export function buildHouseGraph(e: Enterable, world: CollisionWorld, groundAt: (x: number, z: number) => number, whole: boolean): HouseGraph {
  const { layout, levels, X0, Z0, tile, exits } = e.interior;
  const floorOf = new Map(levels.map((l) => [l.index, l.floor]));
  const points: Vec3[] = [];
  const links: { to: number; cost: number }[][] = [];
  const nodeOf = new Map<string, number>();
  const centre = (i: number, j: number, y: number): Vec3 => toWorld(e, X0 + (i + 0.5) * tile, y, Z0 + (j + 0.5) * tile);
  const standable = (p: Vec3): boolean => {
    if (!whole) return true;
    const capsule = { kind: "capsule" as const, a: { x: p.x, y: p.y + STEP_UP + RADIUS, z: p.z }, b: { x: p.x, y: p.y + HEAD - RADIUS, z: p.z }, radius: RADIUS };
    return world.overlap(capsule, Layers.solid).every((c) => c.shape.kind === "heightfield");
  };
  const spotOn = (i: number, j: number, y: number): Vec3 | null => {
    for (const [u, v] of SPOTS) {
      const p = centre(i + u, j + v, y);
      if (standable(p)) return p;
    }
    return null;
  };
  // Whether a body can walk straight between two nodes: a table's top or a chair's back between the
  // spots chosen on two tiles is in the way, though each spot is clear. (Before the collision is in, all can.)
  const walks = (a: number, b: number): boolean => !whole || walkable(world, points[a], points[b]);
  const add = (key: string, p: Vec3): number => {
    points.push(p);
    links.push([]);
    nodeOf.set(key, points.length - 1);
    return points.length - 1;
  };
  const link = (a: number | undefined, b: number | undefined): void => {
    if (a === undefined || b === undefined || a === b || links[a].some((l) => l.to === b)) return;
    const cost = Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y, points[a].z - points[b].z);
    links[a].push({ to: b, cost });
    links[b].push({ to: a, cost });
  };
  const onStair = (i: number, j: number, k: number): boolean => layout.stairs.some((s) => s.level === k && s.tiles.some(([a, b]) => a === i && b === j));

  const floored: [number, number, number, number][] = [];
  // Each floored tile of each room, not a stair's and not open to the level under it.
  for (const [key, id] of layout.cells) {
    const [i, j, k] = key.split(",").map(Number);
    const room = layout.rooms.find((r) => r.id === id);
    if (!room || !((k === room.base || layout.gallery.has(key)) && !layout.holes.has(key)) || onStair(i, j, k)) continue;
    floored.push([i, j, k, id]);
    // Its middle, or where a body fits on it beside the furniture.
    const p = spotOn(i, j, floorOf.get(k)!);
    if (p) add(key, p);
  }
  // Within a room: its tiles side by side.
  for (const [key, a] of nodeOf) {
    const [i, j, k] = key.split(",").map(Number);
    const id = layout.cells.get(key);
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      const other = cellKey(i + di, j + dj, k);
      const b = nodeOf.get(other);
      if (layout.cells.get(other) === id && b !== undefined && walks(a, b)) link(a, b);
    }
  }
  // A tile is 3 m, and furniture on it leaves no straight way from one tile's spot to the next's: a
  // finer net, a node every 0.75 m where a body fits, each joined to its neighbours and to
  // the tile's own node by what it can walk straight to - so a way goes round a table, not through it.
  if (whole) {
    const sub = new Map<string, number>();
    const roomOfSub = new Map<number, number>();
    for (const [i, j, k, id] of floored) {
      const y = floorOf.get(k)!;
      for (let u = 0; u < SUBS; u++) {
        for (let v = 0; v < SUBS; v++) {
          const p = centre(i + (u + 0.5) / SUBS - 0.5, j + (v + 0.5) / SUBS - 0.5, y);
          if (!standable(p)) continue;
          const n = add(`g,${SUBS * i + u},${SUBS * j + v},${k}`, p);
          sub.set(`${SUBS * i + u},${SUBS * j + v},${k}`, n);
          roomOfSub.set(n, id);
        }
      }
    }
    for (const [key, a] of sub) {
      const [gi, gj, k] = key.split(",").map(Number);
      for (const [di, dj] of NET) {
        const b = sub.get(`${gi + di},${gj + dj},${k}`);
        if (b !== undefined && roomOfSub.get(a) === roomOfSub.get(b) && walks(a, b)) link(a, b);
      }
    }
    // A tile the furniture leaves no middle spot on stands for its finer node nearest the middle - a stair's foot, a door.
    for (const [i, j, k] of floored) {
      const key = cellKey(i, j, k);
      if (nodeOf.has(key)) continue;
      const mid = centre(i, j, 0);
      let best = -1, bestD = Infinity;
      for (let u = 0; u < SUBS; u++) {
        for (let v = 0; v < SUBS; v++) {
          const b = sub.get(`${SUBS * i + u},${SUBS * j + v},${k}`);
          if (b === undefined) continue;
          const d = Math.hypot(points[b].x - mid.x, points[b].z - mid.z);
          if (d < bestD) [best, bestD] = [b, d];
        }
      }
      if (best >= 0) nodeOf.set(key, best);
    }
    // Each tile's node, to the finer nodes round it.
    for (const [key, node] of [...nodeOf]) {
      if (key.startsWith("g,")) continue;
      const [i, j, k] = key.split(",").map(Number);
      for (let u = -1; u <= SUBS; u++) {
        for (let v = -1; v <= SUBS; v++) {
          const b = sub.get(`${SUBS * i + u},${SUBS * j + v},${k}`);
          if (b !== undefined && Math.hypot(points[node].x - points[b].x, points[node].z - points[b].z) < 1.3 && roomOfSub.get(b) === layout.cells.get(key) && walks(node, b)) link(node, b);
        }
      }
    }
  }
  // Through the open doors.
  for (const door of layout.doors) {
    if (door.state !== "open") continue;
    const [di, dj] = STEP[door.dir];
    link(nodeOf.get(cellKey(door.i, door.j, door.k)), nodeOf.get(cellKey(door.i + di, door.j + dj, door.k)));
  }
  // Up the stairs: from the tile before its foot, tile by tile, to the tile it arrives on.
  for (const stair of layout.stairs) {
    const floor = floorOf.get(stair.level)!, rise = floorOf.get(stair.level + 1)! - floor;
    const [di, dj] = STEP[stair.dir];
    let prev = nodeOf.get(cellKey(stair.tiles[0][0] - di, stair.tiles[0][1] - dj, stair.level));
    stair.tiles.forEach(([i, j], n) => {
      // Along its lane, against the wall it stands on - not down the tile's middle, off its edge.
      const side = stair.wallSide as FaceDir;
      const sign = side === "px" || side === "pz" ? 1 : -1;
      const lane = WALL + 0.02 + Math.min(1.9, tile - 2 * WALL) / 2;
      const across = (side === "px" || side === "nx" ? X0 + (side === "px" ? i + 1 : i) * tile : Z0 + (side === "pz" ? j + 1 : j) * tile) - sign * lane;
      const y = floor + (rise * (n + 0.5)) / stair.tiles.length;
      const node = add(`s,${i},${j},${stair.level}`, side === "px" || side === "nx" ? toWorld(e, across, y, Z0 + (j + 0.5) * tile) : toWorld(e, X0 + (i + 0.5) * tile, y, across));
      link(prev, node);
      prev = node;
    });
    // The stair's head, on its lane at the upper floor's height: where it ends, before the way turns off it.
    const last = stair.tiles[stair.tiles.length - 1];
    const side = stair.wallSide as FaceDir;
    const sign = side === "px" || side === "pz" ? 1 : -1;
    const lane = WALL + 0.02 + Math.min(1.9, tile - 2 * WALL) / 2;
    const across = (side === "px" || side === "nx" ? X0 + (side === "px" ? last[0] + 1 : last[0]) * tile : Z0 + (side === "pz" ? last[1] + 1 : last[1]) * tile) - sign * lane;
    const runSign = stair.dir === "px" || stair.dir === "pz" ? 1 : -1;
    const runEdge = stair.dir === "px" || stair.dir === "nx" ? X0 + (stair.dir === "px" ? last[0] + 1 : last[0]) * tile : Z0 + (stair.dir === "pz" ? last[1] + 1 : last[1]) * tile;
    const along = runEdge - runSign * 0.6;
    const head = add(`s,head,${stair.level}`, side === "px" || side === "nx" ? toWorld(e, across, floor + rise, along) : toWorld(e, along, floor + rise, across));
    link(prev, head);
    link(head, nodeOf.get(cellKey(stair.arrival[0], stair.arrival[1], stair.level + 1)));
  }
  // Out of each door: to the ground a tile and a half before it.
  const exitNodes: number[] = [];
  for (const exit of exits) {
    const inside = nodeOf.get(cellKey(exit.i, exit.j, exit.k));
    if (inside === undefined) continue;
    const [di, dj] = STEP[exit.dir as FaceDir];
    const out = centre(exit.i + di * 1.5, exit.j + dj * 1.5, 0);
    out.y = groundAt(out.x, out.z);
    const node = add(`x,${exitNodes.length}`, out);
    link(inside, node);
    exitNodes.push(node);
  }
  const stairNodes = new Set<number>();
  for (const [key, node] of nodeOf) if (key.startsWith("s,")) stairNodes.add(node);
  return { enterable: e, points, links, nodeOf, exits: exitNodes, stairNodes, whole };
}

/** The tile node a point inside a house stands on (or the nearest standable one of its room), or
 *  null when the point is not in any of its rooms. */
export function houseNodeAt(g: HouseGraph, p: Vec3): number | null {
  const { layout, levels, X0, Z0, tile } = g.enterable.interior;
  const m = toModel(g.enterable, p);
  const i = Math.floor((m.x - X0) / tile), j = Math.floor((m.z - Z0) / tile);
  // The level whose floor it stands nearest over.
  let best: number | null = null, bestGap = ON_FLOOR;
  for (const level of levels) {
    const gap = Math.abs(m.y - level.floor);
    if (gap < bestGap && layout.cells.has(cellKey(i, j, level.index))) [best, bestGap] = [level.index, gap];
  }
  // On a stair: its tile, whatever the height.
  for (const stair of layout.stairs) {
    if (!stair.tiles.some(([a, b]) => a === i && b === j)) continue;
    const top = levels.find((l) => l.index === stair.level + 1)!.floor, bottom = levels.find((l) => l.index === stair.level)!.floor;
    if (m.y > bottom - ON_FLOOR && m.y < top + ON_FLOOR) return g.nodeOf.get(`s,${i},${j},${stair.level}`) ?? null;
  }
  if (best === null) return null;
  const own = g.nodeOf.get(cellKey(i, j, best));
  if (own !== undefined) return own;
  // Its tile has furniture on it: the nearest standable tile of the same room.
  const room = layout.cells.get(cellKey(i, j, best));
  let near: number | null = null, nearD = Infinity;
  for (const [key, node] of g.nodeOf) {
    if (key.startsWith("s,") || key.startsWith("x,") || key.startsWith("g,") || layout.cells.get(key) !== room || !key.endsWith(`,${best}`)) continue;
    const d = Math.hypot(g.points[node].x - p.x, g.points[node].z - p.z);
    if (d < nearD) [near, nearD] = [node, d];
  }
  return near;
}

/**
 * A way between two nodes of a house's graph, as waypoints from `from` to `to` (the points they
 * stand for), pulled taut a few points at a time where rays say a body can walk straight - or null.
 */
export function housePath(g: HouseGraph, world: CollisionWorld, from: Vec3, a: number, to: Vec3, b: number): Vec3[] | null {
  const n = g.points.length;
  const cost = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = createNodeHeap();
  const h = (i: number): number => Math.hypot(g.points[i].x - to.x, g.points[i].y - to.y, g.points[i].z - to.z);
  cost[a] = 0;
  heap.push(h(a), a);
  while (heap.size > 0) {
    const i = heap.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === b) break;
    for (const { to: j, cost: c } of g.links[i]) {
      if (closed[j] || cost[i] + c >= cost[j]) continue;
      cost[j] = cost[i] + c;
      prev[j] = i;
      heap.push(cost[j] + h(j), j);
    }
  }
  if (!closed[b]) return null;
  const nodes: Vec3[] = [];
  const keep: boolean[] = [];
  for (let i = b; i >= 0; i = prev[i]) {
    nodes.push(g.points[i]);
    keep.push(g.stairNodes.has(i));
  }
  nodes.reverse();
  keep.reverse();
  nodes.push({ ...to });
  keep.push(false);
  // Pulled taut: on from each kept point to the furthest of the next few it can walk straight to.
  const out: Vec3[] = [];
  let at = from;
  for (let k = 0; k < nodes.length; ) {
    let reach = k;
    for (let j = k + 1; j < nodes.length && j <= k + 6; j++) {
      if (!walkable(world, at, nodes[j])) break;
      reach = j;
      // Not past a stair's lane: its nodes are where the way turns, not corners to cut.
      if (keep[j]) break;
    }
    out.push(nodes[reach]);
    at = nodes[reach];
    k = reach + 1;
  }
  return out;
}
