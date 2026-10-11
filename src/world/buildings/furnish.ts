import { roll, rollInt } from "./buildingGeometry";
import { WALL, type Opening } from "./interiorGeometry";
import { cellKey, inStall, STEP, type FaceDir, type InteriorLayout, type Room, type ShellLevel } from "./interiorLayout";
import type { FurnishEntry } from "./buildingTypes";
import { measureProp } from "../props/propGenerator";
import { arrangeGroup, arrangeProp, type Arranged } from "../props/propGroups";
import type { PropDef } from "../props/propTypes";

/**
 * The placer (see FURNITURE.md): each room furnished from its type's `furnish` list, highest
 * priority first - each piece measured, tried on a grid of slots finer than the tile in each of the
 * four turns its mount allows, scored by where it asks to be, and set down where it scores best, or
 * left out. The way through stays clear: every door, stair foot and landing can still reach every
 * other through free slots, nothing stands in a doorway or on a stair, nothing tall before a window.
 */

/** A tile is split into this many slots each way: about 0.7 m at the houses' 2.6-3.4 m tiles. */
export const SLOTS = 4;
/** How deep before a door the floor is kept clear, and how far either side of it besides its own. */
const DOOR_CLEAR = 1.8;
const DOOR_MARGIN = 0.3;
/** An inner door's half width (see interiorGeometry.ts). */
const INNER_DOOR_HALF = 0.7;
/** How deep before a window only what stands below its sill may go. */
const WINDOW_CLEAR = 1.0;
/** A wall piece keeps this far off a door's or window's frame, and off another wall piece. */
const WALL_GAP = 0.25;
/** A piece stands this far off the wall it backs onto, and a wall piece this far out of its face -
 *  never in its plane. */
const OFF_WALL = 0.03;
/** A hung piece's top stops this far under the ceiling - and its foot is never lower than this over
 *  the floor, whatever the ceiling (its chain may run up through a low one). */
const CEILING_GAP = 0.05;
const MIN_HANG = 2.4;

/** A chimney on the house's wall, as the room behind it sees it: the cell inside it, the wall it is
 *  on (the way out through it), where along that wall its middle is, and its half width. */
export interface Chimney {
  i: number;
  j: number;
  k: number;
  dir: FaceDir;
  along: number;
  half: number;
}

export interface FurnishInput {
  layout: InteriorLayout;
  levels: ShellLevel[];
  X: (i: number) => number;
  Z: (j: number) => number;
  tile: number;
  exits: Opening[];
  windows: Opening[];
  chimneys: Chimney[];
  /** The roof's underside over the top of level k at a point, or null - a room open under the roof
   *  (RoomTypeDef.underRoof) has it for its ceiling (see InteriorInput.roofOver). */
  roofOver?: (k: number, x: number, z: number) => number | null;
  /** The building's seed - its pieces' variants are built from it. */
  seed: number;
  rng: () => number;
}

/** A piece set down: where its foot's middle stands (house space), which way its front faces. */
export interface Furnishing {
  prop: PropDef;
  variant: number;
  x: number;
  y: number;
  z: number;
  frontX: number;
  frontZ: number;
  room: number;
}

/** What a room was furnished with, and what was left out - for the workbench and the probe. */
export interface RoomFurnishing {
  room: number;
  placed: string[];
  left: string[];
}

export interface FurnishResult {
  /** The seed its pieces were measured and built from. */
  seed: number;
  pieces: Furnishing[];
  rooms: RoomFurnishing[];
  /** Each room's slot grid as it ended: its corner, slot size and counts, and each slot's state. */
  grids: { room: number; x0: number; z0: number; sx: number; sz: number; nx: number; nz: number; state: SlotState[] }[];
}

/** A slot's state: free; part of the way through that must stay free (before a door, a stair's
 *  foot); taken by a piece; or not floor at all (a stair, a hole, a stall). */
export type SlotState = "free" | "path" | "taken" | "blocked";

/** A wall side of a room - which way it faces out of the room - and the turn that backs a piece
 *  onto it (its front, +z, into the room): 0 faces +z, 1 +x, 2 -z, 3 -x. */
const FRONTS: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const BACK_ONTO: Record<FaceDir, number> = { nz: 0, nx: 1, pz: 2, px: 3 };
const OPPOSITE: Record<FaceDir, FaceDir> = { px: "nx", nx: "px", pz: "nz", nz: "pz" };

/** A place a floor piece may stand: its slots' corner and span, its turn - and, backed onto a wall,
 *  which, and whether at that wall's start (-1) or end (1), into a corner. */
interface Candidate {
  a: number;
  b: number;
  fa: number;
  fb: number;
  turn: number;
  score: number;
  wall?: FaceDir;
  end?: number;
}

/** Something on a wall: a door or a window, `a0` to `a1` along it, `y0` to `y1` over the floor. */
interface WallSpan {
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

export function furnishInterior(input: FurnishInput): FurnishResult {
  const { layout, levels, X, Z, tile, rng, seed } = input;
  const result: FurnishResult = { seed, pieces: [], rooms: [], grids: [] };
  for (const room of layout.rooms) {
    if (room.type.furnish.length === 0) continue;
    const level = levels.find((l) => l.index === room.base);
    const topLevel = levels.find((l) => l.index === room.base + room.height - 1) ?? level;
    if (!level || !topLevel) continue;
    furnishRoom(room, level.floor, topLevel.top);
  }
  return result;

  function furnishRoom(room: Room, floor: number, ceiling: number): void {
    const { rect } = room;
    const k = room.base;
    // The floor inside the walls, and its slots.
    const x0 = X(rect.i0) + WALL;
    const x1 = X(rect.i1) - WALL;
    const z0 = Z(rect.j0) + WALL;
    const z1 = Z(rect.j1) - WALL;
    const nx = Math.max(1, Math.round(((x1 - x0) / tile) * SLOTS));
    const nz = Math.max(1, Math.round(((z1 - z0) / tile) * SLOTS));
    const sx = (x1 - x0) / nx;
    const sz = (z1 - z0) / nz;
    const state: SlotState[] = new Array(nx * nz).fill("free");
    /** The slots pieces hung from the ceiling hang over, to keep the next apart from them. */
    const hungOver: [number, number][] = [];
    /** The most a piece standing on a slot may reach up (before a window: its sill). */
    const maxHeight: number[] = new Array(nx * nz).fill(Infinity);
    /** How tall what stands on a slot is - what a wall piece over it must clear. */
    const standing: number[] = new Array(nx * nz).fill(0);
    const centreX = (a: number): number => x0 + (a + 0.5) * sx;
    const centreZ = (b: number): number => z0 + (b + 0.5) * sz;
    const slotAt = (x: number, z: number): [number, number] => [Math.floor((x - x0) / sx), Math.floor((z - z0) / sz)];
    const inGrid = (a: number, b: number): boolean => a >= 0 && a < nx && b >= 0 && b < nz;
    // Each wall: its line, which way it runs, its length - and what is on it.
    const wallLine: Record<FaceDir, number> = { nx: x0, px: x1, nz: z0, pz: z1 };
    const alongX = (dir: FaceDir): boolean => dir === "nz" || dir === "pz";
    const spans: Record<FaceDir, WallSpan[]> = { nx: [], px: [], nz: [], pz: [] };
    const hung: Record<FaceDir, [number, number][]> = { nx: [], px: [], nz: [], pz: [] };

    /** Every slot within `depth` of a wall and `a0`-`a1` along it. */
    const slotsBefore = (dir: FaceDir, a0: number, a1: number, depth: number): number[] => {
      const out: number[] = [];
      for (let b = 0; b < nz; b++) {
        for (let a = 0; a < nx; a++) {
          const cx = centreX(a);
          const cz = centreZ(b);
          const along = alongX(dir) ? cx : cz;
          const off = alongX(dir) ? Math.abs(cz - wallLine[dir]) : Math.abs(cx - wallLine[dir]);
          if (along >= a0 && along <= a1 && off <= depth) out.push(b * nx + a);
        }
      }
      return out;
    };
    /** Which wall of this room a face of cell (i, j) toward `dir` is, if it is one. */
    const wallOf = (i: number, j: number, dir: FaceDir): FaceDir | null => {
      if (i < rect.i0 || i >= rect.i1 || j < rect.j0 || j >= rect.j1) return null;
      const [di, dj] = STEP[dir];
      const ni = i + di;
      const nj = j + dj;
      return ni < rect.i0 || ni >= rect.i1 || nj < rect.j0 || nj >= rect.j1 ? dir : null;
    };
    const tileMiddle = (i: number, j: number, dir: FaceDir): number => (alongX(dir) ? (X(i) + X(i + 1)) / 2 : (Z(j) + Z(j + 1)) / 2);
    /** The slots the way through runs to: before each door, and at each stair's foot and landing. */
    const targets: number[] = [];

    // A door: kept clear before it, its span on its wall.
    const door = (dir: FaceDir, along: number, half: number, top: number): void => {
      const a0 = along - half - DOOR_MARGIN;
      const a1 = along + half + DOOR_MARGIN;
      spans[dir].push({ a0: along - half, a1: along + half, y0: 0, y1: top });
      for (const s of slotsBefore(dir, a0, a1, DOOR_CLEAR)) if (state[s] === "free") state[s] = "path";
      const first = slotsBefore(dir, along - half, along + half, Math.max(sx, sz) * 0.75);
      if (first.length > 0) targets.push(first[0]);
    };
    for (const d of layout.doors) {
      if (d.k !== k) continue;
      const mine = wallOf(d.i, d.j, d.dir);
      if (mine) door(mine, tileMiddle(d.i, d.j, d.dir), INNER_DOOR_HALF, 2.9);
      // Seen from the room on its other side.
      const [di, dj] = STEP[d.dir];
      const theirs = wallOf(d.i + di, d.j + dj, OPPOSITE[d.dir]);
      if (theirs) door(theirs, tileMiddle(d.i + di, d.j + dj, OPPOSITE[d.dir]), INNER_DOOR_HALF, 2.9);
    }
    for (const e of input.exits) {
      if (e.k !== k) continue;
      const mine = wallOf(e.i, e.j, e.dir);
      if (mine) door(mine, e.along, e.half, e.top - floor);
    }
    // A window: only what stands below its sill before it, its span on its wall.
    for (const w of input.windows) {
      if (w.k !== k) continue;
      const mine = wallOf(w.i, w.j, w.dir);
      if (!mine) continue;
      spans[mine].push({ a0: w.along - w.half, a1: w.along + w.half, y0: w.bottom - floor, y1: w.top - floor });
      for (const s of slotsBefore(mine, w.along - w.half - 0.15, w.along + w.half + 0.15, WINDOW_CLEAR)) maxHeight[s] = Math.min(maxHeight[s], w.bottom - floor - 0.05);
    }
    // Stairs, holes and stalls are no floor; a stair's foot and landing are on the way through.
    const block = (i: number, j: number): void => {
      for (let b = 0; b < nz; b++) {
        for (let a = 0; a < nx; a++) {
          const cx = centreX(a);
          const cz = centreZ(b);
          if (cx >= X(i) && cx < X(i + 1) && cz >= Z(j) && cz < Z(j + 1)) state[b * nx + a] = "blocked";
        }
      }
    };
    const onPath = (i: number, j: number): void => {
      if (i < rect.i0 || i >= rect.i1 || j < rect.j0 || j >= rect.j1) return;
      const [a, b] = slotAt((X(i) + X(i + 1)) / 2, (Z(j) + Z(j + 1)) / 2);
      if (!inGrid(a, b)) return;
      for (let db = -1; db <= 0; db++) {
        for (let da = -1; da <= 0; da++) {
          const s = (b + db) * nx + (a + da);
          if (inGrid(a + da, b + db) && state[s] === "free") state[s] = "path";
        }
      }
      if (state[b * nx + a] !== "blocked") targets.push(b * nx + a);
    };
    for (const stair of layout.stairs) {
      if (stair.room === room.id && stair.level === k) {
        for (const [i, j] of stair.tiles) block(i, j);
        const [di, dj] = STEP[stair.dir];
        onPath(stair.tiles[0][0] - di, stair.tiles[0][1] - dj);
      }
      if (stair.to === room.id && stair.level + 1 === k) onPath(stair.arrival[0], stair.arrival[1]);
    }
    for (let i = rect.i0; i < rect.i1; i++) {
      for (let j = rect.j0; j < rect.j1; j++) {
        if (layout.holes.has(cellKey(i, j, k)) || inStall(room, i, j, k)) block(i, j);
      }
    }
    // A stair against a wall: nothing hangs on the wall over it.
    for (const stair of layout.stairs) {
      if (stair.room !== room.id || stair.level !== k) continue;
      for (const [i, j] of stair.tiles) {
        const wall = wallOf(i, j, stair.wallSide);
        if (wall) spans[wall].push({ a0: alongX(wall) ? X(i) : Z(j), a1: alongX(wall) ? X(i + 1) : Z(j + 1), y0: 0, y1: ceiling - floor });
      }
    }
    const chimneys = input.chimneys.filter((c) => c.k === k && wallOf(c.i, c.j, c.dir) !== null);

    /** Whether every target can still reach every other through slots not taken or blocked. */
    const connected = (): boolean => {
      const reachable = targets.filter((t) => state[t] !== "taken" && state[t] !== "blocked");
      if (reachable.length < targets.length) return false;
      if (targets.length < 2) return true;
      const seen = new Uint8Array(nx * nz);
      const queue = [targets[0]];
      seen[targets[0]] = 1;
      while (queue.length > 0) {
        const s = queue.pop()!;
        const a = s % nx;
        const b = (s - a) / nx;
        for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (!inGrid(a + da, b + db)) continue;
          const n = (b + db) * nx + a + da;
          if (seen[n] || state[n] === "taken" || state[n] === "blocked") continue;
          seen[n] = 1;
          queue.push(n);
        }
      }
      return targets.every((t) => seen[t]);
    };

    const report: RoomFurnishing = { room: room.id, placed: [], left: [] };
    const entries = room.type.furnish.map((entry, order) => ({ entry, order })).sort((p, q) => q.entry.priority - p.entry.priority || p.order - q.order);
    for (const { entry } of entries) {
      // So many - or, with `per`, so many for each `per` tiles of the room's floor.
      const area = (rect.i1 - rect.i0) * (rect.j1 - rect.j0);
      const count = entry.per === null ? rollInt(entry.count, rng) : Math.round((roll(entry.count, rng) * area) / entry.per);
      for (let n = 0; n < count; n++) {
        if (rng() >= entry.chance) continue;
        const name = entry.prop?.id ?? entry.group!.id;
        const arranged = entry.prop ? arrangeProp(entry.prop, seed, rng, true) : arrangeGroup(entry.group!, seed, rng);
        if (arranged.members.length === 0) continue;
        const ok = place(entry, arranged);
        (ok ? report.placed : report.left).push(name);
      }
    }
    result.rooms.push(report);
    result.grids.push({ room: room.id, x0, z0, sx, sz, nx, nz, state });

    /** Sets an arrangement down where it scores best, if anywhere - true if it was. */
    function place(entry: FurnishEntry, arranged: Arranged): boolean {
      const mount = arranged.members[0].prop.mount;
      const heights = arranged.members.map((m) => measureProp(m.prop, seed, m.variant).height);
      const tall = Math.max(...heights);
      // A wall piece no higher than the room lets it hang, clear of the ceiling.
      if (mount.kind === "wall") return placeOnWall(arranged, tall, Math.max(0, Math.min(roll(mount.height, rng), ceiling - floor - tall - 0.2)));
      if (mount.kind === "ceiling") return placeHung(arranged, tall);
      const { box } = arranged;
      const candidates: Candidate[] = [];
      const tryAt = (a: number, b: number, turn: number, score: number, wall?: FaceDir, end?: number): void => {
        const odd = turn % 2 === 1;
        const fa = Math.ceil(((odd ? box.hd : box.hw) * 2) / sx - 1e-6);
        const fb = Math.ceil(((odd ? box.hw : box.hd) * 2) / sz - 1e-6);
        if (a < 0 || b < 0 || a + fa > nx || b + fb > nz) return;
        for (let db = 0; db < fb; db++) {
          for (let da = 0; da < fa; da++) {
            const s = (b + db) * nx + a + da;
            if (state[s] !== "free" || maxHeight[s] < tall) return;
          }
        }
        candidates.push({ a, b, fa, fb, turn, score: score + rng() * 0.5, wall, end });
      };
      const wallBacked = entry.at === "wall" || entry.at === "corner" || entry.at === "hearth" || entry.at === "window" || entry.at === "door";
      if (wallBacked) {
        for (const dir of ["nx", "px", "nz", "pz"] as FaceDir[]) {
          const turn = BACK_ONTO[dir];
          const odd = turn % 2 === 1;
          const fa = Math.ceil(((odd ? box.hd : box.hw) * 2) / sx - 1e-6);
          const fb = Math.ceil(((odd ? box.hw : box.hd) * 2) / sz - 1e-6);
          // Every place along the wall, backed onto it.
          const run = alongX(dir) ? nx - fa : nz - fb;
          for (let t = 0; t <= run; t++) {
            const a = alongX(dir) ? t : dir === "nx" ? 0 : nx - fa;
            const b = alongX(dir) ? (dir === "nz" ? 0 : nz - fb) : t;
            const mid = alongX(dir) ? x0 + (a + fa / 2) * sx : z0 + (b + fb / 2) * sz;
            const halfAlong = ((alongX(dir) ? fa * sx : fb * sz) / 2);
            let score = 0;
            if (entry.at === "corner") score = t === 0 || t === run ? 3 : -3;
            if (entry.at === "hearth") {
              const chimney = chimneys.find((c) => wallOf(c.i, c.j, c.dir) === dir);
              if (!chimney) continue;
              score = 5 - Math.abs(mid - chimney.along);
            }
            if (entry.at === "window") {
              const over = spans[dir].filter((s) => s.y0 > 0.3).reduce((sum, s) => sum + Math.max(0, Math.min(s.a1, mid + halfAlong) - Math.max(s.a0, mid - halfAlong)), 0);
              if (over <= 0) continue;
              score = over * 3;
            }
            if (entry.at === "door") {
              const doors = spans[dir].filter((s) => s.y0 <= 0.1);
              if (doors.length === 0) continue;
              score = 4 - Math.min(...doors.map((s) => Math.abs(mid - (s.a0 + s.a1) / 2)));
            }
            tryAt(a, b, turn, score, dir, t === 0 ? -1 : t === run ? 1 : 0);
          }
        }
      } else {
        // Anywhere, any turn; in the open, the nearer the middle the better.
        for (let turn = 0; turn < 4; turn++) {
          for (let b = 0; b < nz; b++) {
            for (let a = 0; a < nx; a++) {
              let score = 0;
              if (entry.at === "centre") {
                const odd = turn % 2 === 1;
                const fa = Math.ceil(((odd ? box.hd : box.hw) * 2) / sx - 1e-6);
                const fb = Math.ceil(((odd ? box.hw : box.hd) * 2) / sz - 1e-6);
                const cx = a + fa / 2;
                const cz = b + fb / 2;
                // Off the walls by a slot, nearest the middle best.
                if (a < 1 || b < 1 || a + fa > nx - 1 || b + fb > nz - 1) score -= 4;
                score -= Math.hypot(cx - nx / 2, cz - nz / 2) * 0.5;
              }
              tryAt(a, b, turn, score);
            }
          }
        }
      }
      // The best that leaves the way through clear.
      candidates.sort((p, q) => q.score - p.score);
      for (const c of candidates) {
        const slots: number[] = [];
        for (let db = 0; db < c.fb; db++) for (let da = 0; da < c.fa; da++) slots.push((c.b + db) * nx + c.a + da);
        if (slots.some((slot) => state[slot] !== "free")) continue;
        for (const slot of slots) state[slot] = "taken";
        if (connected()) {
          for (const slot of slots) standing[slot] = Math.max(standing[slot], tall);
          const [cx, cz] = standAt(c, arranged);
          setDown(arranged, cx, cz, floor, c.turn);
          return true;
        }
        for (const slot of slots) state[slot] = "free";
      }
      return false;
    }

    /**
     * Where a place's piece stands: the middle of its slots - or, backed onto a wall, its back against
     * the wall's face (a hair off it) and, into a corner, its side against the other wall too, rather
     * than wherever its slots, rounded up to whole ones, would leave it.
     */
    function standAt(c: Candidate, arranged: Arranged): [number, number] {
      let cx = x0 + (c.a + c.fa / 2) * sx;
      let cz = z0 + (c.b + c.fb / 2) * sz;
      if (!c.wall) return [cx, cz];
      const { hw, hd } = arranged.box;
      const inward = c.wall === "nx" || c.wall === "nz" ? 1 : -1;
      const across = wallLine[c.wall] + inward * (hd + OFF_WALL);
      if (alongX(c.wall)) cz = across;
      else cx = across;
      if (c.end === -1 || c.end === 1) {
        const from = alongX(c.wall) ? x0 : z0;
        const to = alongX(c.wall) ? x1 : z1;
        const along = c.end === -1 ? from + hw + OFF_WALL : to - hw - OFF_WALL;
        if (alongX(c.wall)) cx = along;
        else cz = along;
      }
      return [cx, cz];
    }

    /** Sets an arrangement down with its box's middle at (cx, cz), turned `turn`. */
    function setDown(arranged: Arranged, cx: number, cz: number, y: number, turn: number): void {
      const [fx, fz] = FRONTS[turn];
      for (const m of arranged.members) {
        // Its place in the group, from the box's middle, turned as the group is.
        const u = m.x - arranged.box.cx;
        const w = m.z - arranged.box.cz;
        const lift = m.on ? m.lift : 0;
        result.pieces.push({
          prop: m.prop,
          variant: m.variant,
          x: cx + fz * u + fx * w,
          y: y + lift,
          z: cz - fx * u + fz * w,
          frontX: fz * m.frontX + fx * m.frontZ,
          frontZ: -fx * m.frontX + fz * m.frontZ,
          room: room.id,
        });
      }
    }

    /** A wall piece: on a stretch of wall with nothing on it at its height, nothing tall in front. */
    function placeOnWall(arranged: Arranged, tall: number, height: number): boolean {
      const half = arranged.box.hw;
      const depth = arranged.box.hd;
      type Spot = { dir: FaceDir; along: number; score: number };
      let best: Spot | null = null;
      for (const dir of ["nx", "px", "nz", "pz"] as FaceDir[]) {
        const from = alongX(dir) ? x0 : z0;
        const to = alongX(dir) ? x1 : z1;
        for (let along = from + half + WALL_GAP; along <= to - half - WALL_GAP; along += 0.25) {
          const a0 = along - half - WALL_GAP;
          const a1 = along + half + WALL_GAP;
          if (spans[dir].some((s) => s.a1 > a0 && s.a0 < a1 && s.y1 > height - 0.1 && s.y0 < height + tall + 0.1)) continue;
          if (hung[dir].some(([h0, h1]) => h1 > a0 && h0 < a1)) continue;
          // Nothing standing before it tall enough to hide it.
          if (slotsBefore(dir, a0, a1, Math.max(sx, sz)).some((s) => standing[s] > height || state[s] === "blocked")) continue;
          const score = rng();
          if (!best || score > best.score) best = { dir, along, score };
        }
      }
      if (!best) return false;
      const spot: Spot = best;
      hung[spot.dir].push([spot.along - half - WALL_GAP, spot.along + half + WALL_GAP]);
      // Its back on the wall's face, a hair out of it.
      const out = depth + OFF_WALL;
      const line = wallLine[spot.dir];
      const inward = spot.dir === "nx" || spot.dir === "nz" ? 1 : -1;
      const cx = alongX(spot.dir) ? spot.along : line + inward * out;
      const cz = alongX(spot.dir) ? line + inward * out : spot.along;
      setDown(arranged, cx, cz, floor + height, BACK_ONTO[spot.dir]);
      return true;
    }

    /** A hung piece: from the ceiling over open floor - not over a stair or a hole - nearest the
     *  middle of the room, its top just under the ceiling; a tile or more from any hung before it. */
    function placeHung(arranged: Arranged, tall: number): boolean {
      let best: { a: number; b: number; score: number } | null = null;
      for (let b = 0; b < nz; b++) {
        for (let a = 0; a < nx; a++) {
          if (state[b * nx + a] === "blocked") continue;
          if (hungOver.some(([ha, hb]) => Math.hypot(a - ha, b - hb) < SLOTS)) continue;
          const score = -Math.hypot(a + 0.5 - nx / 2, b + 0.5 - nz / 2) + rng() * 1.5;
          if (!best || score > best.score) best = { a, b, score };
        }
      }
      if (!best) return false;
      // The ceiling over it: the roof, in a room open under it.
      const x = centreX(best.a);
      const z = centreZ(best.b);
      const roof = room.type.underRoof ? input.roofOver?.(room.base + room.height - 1, x, z) : null;
      const over = roof ?? ceiling;
      setDown(arranged, x, z, Math.max(floor + MIN_HANG, over - tall - CEILING_GAP), Math.floor(rng() * 4));
      hungOver.push([best.a, best.b]);
      return true;
    }
  }
}
