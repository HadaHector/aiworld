// Ways over the surface (NAVIGATION.md, *The surface*): the ground in tiles of 1 m cells, made when
// a search first needs them from the collision world itself - a cell is shut where a body standing
// on it would be inside something solid (a trunk, a wall, a fence) above its step height - and kept
// in a cache. Cells hold their height (the ground's, or a bridge's deck over deep water) and whether
// deep water is there. A* over them in a window round the two ends, then pulled taut. Pure and
// deterministic: the same collision gives the same tiles, and ties go to the lower cell.
import type { CollisionWorld } from "../collision/collisionWorld";
import { separate, type QueryShape } from "../collision/narrowphase";
import { Layers } from "../collision/shapes";
import type { Vec3 } from "../collision/vec";
import { createNodeHeap } from "./heap";
import type { NavAgent } from "./navQuery";

/** What the surface's tiles are made from: the dimension's ground and water, and its collision. */
export interface SurfaceSource {
  world: CollisionWorld;
  /** The ground's height at a point (the terrain's: a building is shut by its walls anyway). */
  groundAt(x: number, z: number): number;
  waterAt(x: number, z: number): { surface: number; depth: number };
  /** Water deeper than this over the ground is deep: a land creature's wall. Infinity: none is. */
  deep: number;
  /** Whether the collision around a point is in yet: a tile made before it is not kept. */
  loaded(x: number, z: number): boolean;
}

export interface SurfaceNav {
  path(from: Vec3, to: Vec3, budget: number, agent?: NavAgent): Vec3[] | null;
  straight(from: Vec3, to: Vec3, agent?: NavAgent): boolean;
  /** A cell's state, for debug drawing: its height, and whether it is shut or deep. */
  cell(x: number, z: number): { height: number; shut: boolean; deep: boolean };
  readonly tileCount: number;
  /** Tiles made so far, and the milliseconds that took. */
  readonly made: { tiles: number; ms: number };
}

const TILE = 32;
/** The ground and water are sampled this far apart in a tile, and read between. */
const LATTICE = 2;
const CELLS = TILE * TILE;
const SHUT = 1;
const DEEP = 2;
/** Tiles kept, the most recently used. */
const KEEP = 256;
/** A body as a cell sees it: a capsule this wide, from its step height to its head. */
const RADIUS = 0.45;
const STEP = 0.75;
const HEAD = 2.0;
/** The steepest a body walks between cells: rise over run (52 degrees, the motor's). */
const CLIMB = Math.tan((52 * Math.PI) / 180);
/** A search looks this far round the box of its two ends, and no further than WINDOW_MAX across. */
const MARGIN = 24;
const WINDOW_MAX = 192;
/** An end in a shut cell may move this far to an open one. */
const NUDGE = 2;
/** An end this far over or under its cell's height is not on the ground there (a roof, a cellar). */
const OFF_GROUND = 2.5;
/** The straight test looks at the cells every this far along. */
const SAMPLE = 0.25;

interface Tile {
  height: Float32Array;
  flags: Uint8Array;
}

export function createSurfaceNav(src: SurfaceSource): SurfaceNav {
  const tiles = new Map<string, Tile>();
  const made = { tiles: 0, ms: 0 };

  function makeTile(tx: number, tz: number): { tile: Tile; whole: boolean } {
    const x0 = tx * TILE, z0 = tz * TILE;
    const whole = [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]].every(([u, v]) => src.loaded(x0 + u * TILE, z0 + v * TILE));
    const height = new Float32Array(CELLS);
    const flags = new Uint8Array(CELLS);
    let low = Infinity, high = -Infinity;
    // The ground and the water sampled every LATTICE metres and read between: a sample costs
    // microseconds, and a tile's thousand cells of them were most of its making.
    const n = TILE / LATTICE + 1;
    const ground = new Float32Array(n * n), surface = new Float32Array(n * n), depth = new Float32Array(n * n);
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        const x = x0 + a * LATTICE, z = z0 + b * LATTICE, k = b * n + a;
        ground[k] = src.groundAt(x, z);
        const w = src.waterAt(x, z);
        surface[k] = w.surface;
        depth[k] = w.depth;
      }
    }
    const between = (grid: Float32Array, x: number, z: number): number => {
      const fx = x / LATTICE, fz = z / LATTICE;
      const a = Math.min(n - 2, Math.floor(fx)), b = Math.min(n - 2, Math.floor(fz));
      const u = fx - a, v = fz - b, k = b * n + a;
      return (grid[k] * (1 - u) + grid[k + 1] * u) * (1 - v) + (grid[k + n] * (1 - u) + grid[k + n + 1] * u) * v;
    };
    for (let j = 0; j < TILE; j++) {
      for (let i = 0; i < TILE; i++) {
        const x = x0 + i + 0.5, z = z0 + j + 0.5, k = j * TILE + i;
        let h = between(ground, i + 0.5, j + 0.5);
        const water = { surface: between(surface, i + 0.5, j + 0.5), depth: between(depth, i + 0.5, j + 0.5) };
        if (water.surface - h > src.deep && water.depth > src.deep) {
          // A bridge's deck over it, if anything is there over the water.
          const hit = whole ? src.world.raycast({ x, y: water.surface + 8, z }, { x: 0, y: -1, z: 0 }, 8, Layers.solid) : null;
          if (hit && hit.shape.kind !== "heightfield" && hit.point.y > water.surface) h = hit.point.y;
          else {
            // A swimmer is at the surface, not on the bed.
            flags[k] |= DEEP;
            h = water.surface;
          }
        }
        height[k] = h;
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
    }
    if (whole) {
      // Everything solid standing in the tile, cell by cell under each.
      const box = { min: { x: x0 - RADIUS, y: low + STEP, z: z0 - RADIUS }, max: { x: x0 + TILE + RADIUS, y: high + HEAD + RADIUS, z: z0 + TILE + RADIUS } };
      const query: QueryShape = { kind: "capsule", a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 }, radius: RADIUS };
      src.world.forEachShapeInBounds(box, Layers.solid, (shape) => {
        if (shape.kind === "heightfield" || shape.kind === "mesh") return;
        const b = shape.bounds;
        const i0 = Math.max(0, Math.floor(b.min.x - RADIUS - x0)), i1 = Math.min(TILE - 1, Math.floor(b.max.x + RADIUS - x0));
        const j0 = Math.max(0, Math.floor(b.min.z - RADIUS - z0)), j1 = Math.min(TILE - 1, Math.floor(b.max.z + RADIUS - z0));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const k = j * TILE + i;
            if (flags[k] & SHUT) continue;
            const h = height[k];
            if (b.max.y < h + STEP || b.min.y > h + HEAD + RADIUS) continue;
            const x = x0 + i + 0.5, z = z0 + j + 0.5;
            query.a = { x, y: h + STEP + RADIUS, z };
            query.b = { x, y: h + HEAD, z };
            if (separate(query, shape).distance < 0) flags[k] |= SHUT;
          }
        }
      });
    }
    return { tile: { height, flags }, whole };
  }

  function tileAt(tx: number, tz: number): Tile {
    const key = `${tx},${tz}`;
    const kept = tiles.get(key);
    if (kept) {
      tiles.delete(key);
      tiles.set(key, kept);
      return kept;
    }
    const started = performance.now();
    const { tile, whole } = makeTile(tx, tz);
    made.tiles++;
    made.ms += performance.now() - started;
    if (whole) {
      tiles.set(key, tile);
      if (tiles.size > KEEP) tiles.delete(tiles.keys().next().value!);
    }
    return tile;
  }

  /** A cell's height and flags by its whole-metre coordinates. */
  let lastTx = NaN, lastTz = NaN, lastTile: Tile | null = null;
  function cellOf(gx: number, gz: number): { h: number; f: number } {
    const tx = Math.floor(gx / TILE), tz = Math.floor(gz / TILE);
    if (tx !== lastTx || tz !== lastTz || !lastTile) {
      lastTile = tileAt(tx, tz);
      lastTx = tx;
      lastTz = tz;
    }
    const k = (gz - tz * TILE) * TILE + (gx - tx * TILE);
    return { h: lastTile.height[k], f: lastTile.flags[k] };
  }
  const open = (f: number, agent?: NavAgent): boolean => !(f & SHUT) && (!!agent?.swims || !(f & DEEP));

  function straight(from: Vec3, to: Vec3, agent?: NavAgent): boolean {
    const dx = to.x - from.x, dz = to.z - from.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / SAMPLE));
    // Cell to cell as the search steps: no more of a climb than it allows.
    let px = NaN, pz = NaN, ph = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const gx = Math.floor(from.x + dx * t), gz = Math.floor(from.z + dz * t);
      if (gx === px && gz === pz) continue;
      const c = cellOf(gx, gz);
      if (!open(c.f, agent)) return false;
      if (!Number.isNaN(px) && Math.abs(c.h - ph) > CLIMB * Math.hypot(gx - px, gz - pz) + 0.05) return false;
      [px, pz, ph] = [gx, gz, c.h];
    }
    return true;
  }

  /** The open cell nearest a point within NUDGE, on the ground there, or null. */
  function endCell(p: Vec3, agent?: NavAgent): { gx: number; gz: number } | null {
    const cx = Math.floor(p.x), cz = Math.floor(p.z);
    let best: { gx: number; gz: number } | null = null, bestD = Infinity;
    for (let dz = -NUDGE; dz <= NUDGE; dz++) {
      for (let dx = -NUDGE; dx <= NUDGE; dx++) {
        const c = cellOf(cx + dx, cz + dz);
        const d = Math.hypot(cx + dx + 0.5 - p.x, cz + dz + 0.5 - p.z);
        if (d > NUDGE || !open(c.f, agent) || Math.abs(c.h - p.y) > OFF_GROUND) continue;
        if (d < bestD) [best, bestD] = [{ gx: cx + dx, gz: cz + dz }, d];
      }
    }
    return best;
  }

  const NEIGHBOURS: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

  function path(from: Vec3, to: Vec3, budget: number, agent?: NavAgent): Vec3[] | null {
    if (straight(from, to, agent)) return [{ ...to }];
    const a = endCell(from, agent), b = endCell(to, agent);
    // Off the ground where it stands (a roof, the water for a walker): nowhere to walk to.
    if (!b) return null;
    // A body wedged where no cell is open: let it walk straight and the motor sort it out.
    if (!a) return [{ ...to }];
    const minX = Math.max(Math.min(a.gx, b.gx) - MARGIN, Math.max(a.gx, b.gx) - WINDOW_MAX + MARGIN);
    const minZ = Math.max(Math.min(a.gz, b.gz) - MARGIN, Math.max(a.gz, b.gz) - WINDOW_MAX + MARGIN);
    const w = Math.min(WINDOW_MAX, Math.max(a.gx, b.gx) + MARGIN - minX + 1);
    const d = Math.min(WINDOW_MAX, Math.max(a.gz, b.gz) + MARGIN - minZ + 1);
    if (a.gx - minX >= w || a.gz - minZ >= d || b.gx - minX >= w || b.gz - minZ >= d) return [{ ...to }];
    const n = w * d;
    const cost = new Float32Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heights = new Float32Array(n).fill(NaN);
    const flagsOf = new Int16Array(n).fill(-1);
    const look = (k: number): number => {
      if (flagsOf[k] < 0) {
        const c = cellOf(minX + (k % w), minZ + Math.floor(k / w));
        heights[k] = c.h;
        flagsOf[k] = c.f;
      }
      return flagsOf[k];
    };
    const start = (a.gz - minZ) * w + (a.gx - minX), goal = (b.gz - minZ) * w + (b.gx - minX);
    const hOf = (k: number): number => Math.hypot(k % w - (goal % w), Math.floor(k / w) - Math.floor(goal / w));
    const heap = createNodeHeap();
    cost[start] = 0;
    heap.push(hOf(start), start);
    let expanded = 0, found = false;
    while (heap.size > 0 && expanded < budget) {
      const k = heap.pop();
      if (closed[k]) continue;
      closed[k] = 1;
      expanded++;
      if (k === goal) {
        found = true;
        break;
      }
      const i = k % w, j = Math.floor(k / w);
      look(k);
      for (const [di, dj, step] of NEIGHBOURS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= d) continue;
        const m = nj * w + ni;
        if (closed[m] || !open(look(m), agent)) continue;
        // No cutting a corner past a shut cell.
        if (di !== 0 && dj !== 0 && (!open(look(j * w + ni), agent) || !open(look(nj * w + i), agent))) continue;
        if (Math.abs(heights[m] - heights[k]) > CLIMB * step + 0.05) continue;
        const next = cost[k] + step;
        if (next >= cost[m]) continue;
        cost[m] = next;
        prev[m] = k;
        heap.push(next + hOf(m), m);
      }
    }
    if (!found) return null;
    const cells: Vec3[] = [];
    for (let k = goal; k >= 0; k = prev[k]) cells.push({ x: minX + (k % w) + 0.5, y: heights[k], z: minZ + Math.floor(k / w) + 0.5 });
    cells.reverse();
    cells.push({ ...to });
    // Pulled taut: from each kept point, on along the cells while it can walk straight to them.
    const out: Vec3[] = [];
    let at = from;
    for (let k = 0; k < cells.length; ) {
      let reach = k;
      for (let j = k + 1; j < cells.length; j++) {
        if (!straight(at, cells[j], agent)) break;
        reach = j;
      }
      out.push(cells[reach]);
      at = cells[reach];
      k = reach + 1;
    }
    return out;
  }

  return {
    path,
    straight,
    cell(x, z) {
      const c = cellOf(Math.floor(x), Math.floor(z));
      return { height: c.h, shut: !!(c.f & SHUT), deep: !!(c.f & DEEP) };
    },
    get tileCount() {
      return tiles.size;
    },
    made,
  };
}
