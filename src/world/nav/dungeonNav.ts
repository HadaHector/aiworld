// Ways through a dungeon (NAVIGATION.md, *Dungeons*): its parts' walk lines, laid out in the world,
// are one graph - each line's ends joined to whatever line they meet, within a part (a stair's
// flight to its landings) and across a join (the two parts' lines meet at their socket, a doorway's
// short line overlapping both). Off the lines, a creature walks straight where rays through the
// dungeon's colliders say it can. Pure and deterministic: the same layout gives the same graph, and
// ties in the search go to the lower node.
import type { CollisionWorld } from "../collision/collisionWorld";
import type { Aabb, Vec3 } from "../collision/vec";
import { placedPaths, type DungeonLayout, type PlacedPart } from "../dungeons/layout";
import { createNodeHeap } from "./heap";

/** A line's end within this of another line (and this near in height) is joined to it. */
const JOIN_REACH = 1.2;
const JOIN_HEIGHT = 0.7;
/** Nodes of different lines nearer than this are one place. */
const SAME = 0.3;
/** Long straights are cut into pieces this long, so a creature anywhere in a room has a node near. */
const PIECE = 3;
/** How far off the graph a creature may stand and still walk straight onto it, and how many of the
 *  nearest nodes are tried. */
const ATTACH_REACH = 40;
const ATTACH_TRIES = 24;
/** Height counts this many times over horizontal distance when looking for the nearest node: the
 *  floor above or below is far off, however near it lies across. */
const HEIGHT_WEIGHT = 4;
/** Nodes this near one that failed are not tried. */
const SPREAD = 3;
/** A straight from one end to the other is tried first only when they are this near. */
const DIRECT = 30;
/** A node whose way on turns by less than this (radians) is passed over when pulling taut. */
const BEND = 0.05;
/** How many points into either end a way is pulled taut over. */
const PULL = 4;

export interface DungeonGraph {
  /** x, y, z per node. */
  points: Float64Array;
  /** Per node, its neighbours and the distances to them. */
  links: { to: number; cost: number }[][];
  /** The doorways: a shortcut never cuts across one (its sill, crossed on the slant, can wedge a
   *  body), only the walk lines go through, square to it. */
  doorways: PlacedPart[];
}

/** Whether the segment a-b passes through a box - unless one of `free` (where a body stands, not a
 *  node of the graph) is already in it. */
function crosses(box: Aabb, a: Vec3, b: Vec3, free: readonly Vec3[]): boolean {
  const inside = (p: Vec3): boolean => p.x >= box.min.x && p.x <= box.max.x && p.y >= box.min.y && p.y <= box.max.y && p.z >= box.min.z && p.z <= box.max.z;
  if (free.some(inside)) return false;
  let t0 = 0, t1 = 1;
  for (const k of ["x", "y", "z"] as const) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) {
      if (a[k] < box.min[k] || a[k] > box.max[k]) return false;
      continue;
    }
    let u = (box.min[k] - a[k]) / d, v = (box.max[k] - a[k]) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u);
    t1 = Math.min(t1, v);
    if (t0 > t1) return false;
  }
  return true;
}

/** A world point in a placed part's own frame - where its box is exact. */
function local(p: PlacedPart, q: Vec3): Vec3 {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw), dx = q.x - p.x, dz = q.z - p.z;
  return { x: dx * c - dz * s, y: q.y - p.y, z: dx * s + dz * c };
}

/** A shortcut a body can take in a dungeon: walkable straight, and through no doorway (but one it,
 *  or the end it is going to, already stands in: `free`) - what `straight` answers there. */
export function shortcut(g: DungeonGraph, world: CollisionWorld, a: Vec3, b: Vec3, free: readonly Vec3[] = [a, b]): boolean {
  return !g.doorways.some((d) => crosses(d.part.bounds, local(d, a), local(d, b), free.map((p) => local(d, p)))) && walkableStraight(world, a, b);
}

const pointOf = (g: DungeonGraph, i: number): Vec3 => ({ x: g.points[i * 3], y: g.points[i * 3 + 1], z: g.points[i * 3 + 2] });

/** The graph of a laid-out dungeon's walk lines. */
export function buildDungeonGraph(layout: DungeonLayout): DungeonGraph {
  const pts: number[] = [];
  const links: { to: number; cost: number }[][] = [];
  const add = (p: Vec3): number => {
    pts.push(p.x, p.y, p.z);
    links.push([]);
    return links.length - 1;
  };
  const link = (a: number, b: number): void => {
    if (a === b || links[a].some((l) => l.to === b)) return;
    const cost = Math.hypot(pts[a * 3] - pts[b * 3], pts[a * 3 + 1] - pts[b * 3 + 1], pts[a * 3 + 2] - pts[b * 3 + 2]);
    links[a].push({ to: b, cost });
    links[b].push({ to: a, cost });
  };
  /** Each line as its nodes, in order, with long straights cut into pieces. */
  const lines: number[][] = [];
  for (const part of layout.parts) {
    for (const line of placedPaths(part)) {
      const nodes: number[] = [];
      for (let i = 0; i < line.length; i++) {
        if (i > 0) {
          const a = line[i - 1], b = line[i];
          const pieces = Math.floor(Math.hypot(b.x - a.x, b.z - a.z) / PIECE);
          for (let k = 1; k < pieces; k++) {
            const t = k / pieces;
            nodes.push(add({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }));
          }
        }
        nodes.push(add(line[i]));
      }
      for (let i = 1; i < nodes.length; i++) link(nodes[i - 1], nodes[i]);
      lines.push(nodes);
    }
  }
  // Lines crossing at a shared point (a hall's middle, where its two lines meet) are joined there.
  const cells = new Map<string, number[]>();
  const cell = (x: number, z: number): string => `${Math.floor(x / SAME)},${Math.floor(z / SAME)}`;
  for (let i = 0; i < links.length; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
      for (const j of cells.get(cell(x + cx * SAME, z + cz * SAME)) ?? []) {
        if (Math.hypot(pts[j * 3] - x, pts[j * 3 + 2] - z) < SAME && Math.abs(pts[j * 3 + 1] - y) < JOIN_HEIGHT) link(i, j);
      }
    }
    const k = cell(x, z);
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  }
  // Each line's ends to the nearest point of every other line within reach: onto a node there, or
  // onto a new one cut into the segment.
  const ends = lines.flatMap((nodes, line) => (nodes.length > 0 ? [{ node: nodes[0], line }, { node: nodes[nodes.length - 1], line }] : []));
  for (const { node, line } of ends) {
    const ex = pts[node * 3], ey = pts[node * 3 + 1], ez = pts[node * 3 + 2];
    for (let other = 0; other < lines.length; other++) {
      if (other === line) continue;
      const nodes = lines[other];
      let best = -1, bestT = 0, bestD = JOIN_REACH;
      for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1], b = nodes[i];
        const ax = pts[a * 3], ay = pts[a * 3 + 1], az = pts[a * 3 + 2];
        const dx = pts[b * 3] - ax, dy = pts[b * 3 + 1] - ay, dz = pts[b * 3 + 2] - az;
        const len2 = dx * dx + dz * dz;
        const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((ex - ax) * dx + (ez - az) * dz) / len2)) : 0;
        const d = Math.hypot(ax + dx * t - ex, az + dz * t - ez);
        if (d < bestD && Math.abs(ay + dy * t - ey) < JOIN_HEIGHT) [best, bestT, bestD] = [i, t, d];
      }
      if (best < 0) continue;
      const a = nodes[best - 1], b = nodes[best];
      if (bestT < 0.05 || bestT > 0.95) {
        link(node, bestT < 0.5 ? a : b);
        continue;
      }
      const ax = pts[a * 3], ay = pts[a * 3 + 1], az = pts[a * 3 + 2];
      const mid = add({ x: ax + (pts[b * 3] - ax) * bestT, y: ay + (pts[b * 3 + 1] - ay) * bestT, z: az + (pts[b * 3 + 2] - az) * bestT });
      links[a].splice(links[a].findIndex((l) => l.to === b), 1);
      links[b].splice(links[b].findIndex((l) => l.to === a), 1);
      link(a, mid);
      link(mid, b);
      nodes.splice(best, 0, mid);
      link(node, mid);
    }
  }
  return { points: new Float64Array(pts), links, doorways: layout.parts.filter((p) => p.role === "doorway") };
}

/** Feet over the floor a body's way is looked along, and how far either side of its middle. */
const KNEE = 0.6;
const CHEST = 1.5;
const SIDE = 0.45;
/** Along a straight, the floor is looked for this often, this far under the line. */
const FLOOR_EVERY = 2;
const FLOOR_REACH = 2.2;

/**
 * Whether a body could walk straight from `a` to `b` (feet): nothing in the way at its knees on
 * either side and at its chest, and a floor under it all the way (no drop, no hole). By rays through
 * `world`'s colliders.
 */
export function walkableStraight(world: CollisionWorld, a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const across = Math.hypot(dx, dz);
  if (across < 0.05) return Math.abs(dy) < 0.6;
  const length = Math.hypot(dx, dy, dz);
  const dir = { x: dx, y: dy, z: dz };
  const sx = (-dz / across) * SIDE, sz = (dx / across) * SIDE;
  if (world.raycastAny({ x: a.x, y: a.y + CHEST, z: a.z }, dir, length)) return false;
  if (world.raycastAny({ x: a.x + sx, y: a.y + KNEE, z: a.z + sz }, dir, length)) return false;
  if (world.raycastAny({ x: a.x - sx, y: a.y + KNEE, z: a.z - sz }, dir, length)) return false;
  const steps = Math.max(1, Math.ceil(across / FLOOR_EVERY));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!world.raycastAny({ x: a.x + dx * t, y: a.y + dy * t + 1, z: a.z + dz * t }, { x: 0, y: -1, z: 0 }, 1 + FLOOR_REACH)) return false;
  }
  return true;
}

/** The nodes nearest a point a body there could walk straight onto, with the distance to each. */
function attach(g: DungeonGraph, world: CollisionWorld, p: Vec3): { node: number; cost: number }[] {
  const near: { node: number; key: number; cost: number }[] = [];
  const n = g.links.length;
  for (let i = 0; i < n; i++) {
    const x = g.points[i * 3], y = g.points[i * 3 + 1], z = g.points[i * 3 + 2];
    const across = Math.hypot(x - p.x, z - p.z);
    if (across > ATTACH_REACH) continue;
    near.push({ node: i, key: across + Math.abs(y - p.y) * HEIGHT_WEIGHT, cost: Math.hypot(across, y - p.y) });
  }
  near.sort((a, b) => a.key - b.key || a.node - b.node);
  // A node by one that could not be walked to most likely cannot either (the same flight behind the
  // same wall): passed over, so the tries spread to other lines.
  const out: { node: number; cost: number }[] = [];
  const failed: Vec3[] = [];
  let tries = 0;
  for (const c of near) {
    if (tries >= ATTACH_TRIES || out.length >= 2) break;
    const q = pointOf(g, c.node);
    if (failed.some((f) => Math.hypot(f.x - q.x, f.z - q.z) < SPREAD && Math.abs(f.y - q.y) < 2)) continue;
    tries++;
    if (shortcut(g, world, p, q, [p])) out.push({ node: c.node, cost: c.cost });
    else failed.push(q);
  }
  return out;
}

/**
 * A way from `from` to `to` through a dungeon: waypoints along its graph, pulled taut where a body
 * can walk straight, the last one `to` - or null if either end cannot get onto the graph or no way
 * joins them within `budget` nodes.
 */
export function dungeonPath(g: DungeonGraph, world: CollisionWorld, from: Vec3, to: Vec3, budget: number): Vec3[] | null {
  if (Math.hypot(to.x - from.x, to.z - from.z) < DIRECT && shortcut(g, world, from, to)) return [{ ...to }];
  const starts = attach(g, world, from);
  const goals = attach(g, world, to);
  if (starts.length === 0 || goals.length === 0) return null;
  const n = g.links.length;
  const cost = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const finish = new Map(goals.map((goal) => [goal.node, goal.cost]));
  const h = (i: number): number => Math.hypot(g.points[i * 3] - to.x, g.points[i * 3 + 1] - to.y, g.points[i * 3 + 2] - to.z);
  const heap = createNodeHeap();
  for (const s of starts) {
    if (s.cost < cost[s.node]) {
      cost[s.node] = s.cost;
      heap.push(s.cost + h(s.node), s.node);
    }
  }
  let best = -1, bestTotal = Infinity, expanded = 0;
  while (heap.size > 0 && expanded < budget) {
    const f = heap.peek();
    if (f >= bestTotal) break;
    const i = heap.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    expanded++;
    const end = finish.get(i);
    if (end !== undefined && cost[i] + end < bestTotal) [best, bestTotal] = [i, cost[i] + end];
    for (const { to: j, cost: c } of g.links[i]) {
      const next = cost[i] + c;
      if (closed[j] || next >= cost[j]) continue;
      cost[j] = next;
      prev[j] = i;
      heap.push(next + h(j), j);
    }
  }
  if (best < 0) return null;
  const all: Vec3[] = [];
  for (let i = best; i >= 0; i = prev[i]) all.push(pointOf(g, i));
  all.reverse();
  all.push({ ...to });
  // Points on a straight run of the lines are dropped (the line is walkable by its making): only
  // where the way bends is it worth rays to pull it taut.
  // The node the far end was joined to stays: that leg is the one the rays checked.
  const nodes: Vec3[] = [all[0]];
  for (let i = 1; i < all.length - 2; i++) {
    const a = nodes[nodes.length - 1], b = all[i], c = all[i + 1];
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const lu = Math.hypot(u.x, u.y, u.z), lv = Math.hypot(v.x, v.y, v.z);
    if (lu < 1e-6 || lv < 1e-6) continue;
    const cos = (u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv);
    if (cos < Math.cos(BEND)) nodes.push(b);
  }
  if (all.length > 2) nodes.push(all[all.length - 2]);
  nodes.push(all[all.length - 1]);
  // Pulled taut at its ends only, where it leaves and meets the lines (between, it keeps to them,
  // round their bends: rays cost, and a corridor's middle is a fine way to walk it). From `from`, on
  // to the furthest of the next few it can walk straight to; into `to`, from the earliest of the
  // last few that can.
  let first = 0;
  for (let j = 1; j < nodes.length - 1 && j <= PULL; j++) {
    if (!shortcut(g, world, from, nodes[j], [from])) break;
    first = j;
  }
  let last = nodes.length - 2;
  for (let j = Math.max(first, nodes.length - 2 - PULL); j < nodes.length - 2; j++) {
    if (shortcut(g, world, nodes[j], to, [to])) {
      last = j;
      break;
    }
  }
  return [...nodes.slice(first, last + 1), nodes[nodes.length - 1]];
}
