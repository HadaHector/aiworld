import type { Paint } from "./buildingTypes";
import type { ModelBuilder, Vec3 } from "./buildingGeometry";
import { wallBoxes, type ColliderBuilder } from "./buildingColliders";
import { cellKey, FACE_DIRS, opposite, STEP, type FaceDir, type InteriorLayout, type Room, type ShellLevel } from "./interiorLayout";

/**
 * Builds a house's interior (see interiorLayout.ts) inside its walls: each room's walls, standing in
 * from the tile lines, its floor and ceiling (beamed, where its type says), the doors between rooms
 * - open, or fake: shut, with nothing behind it - the insides of the doors out and of the windows, stairs, and the galleries
 * and stairwells they rise to, railed along their open edges.
 */

/** An opening in an outer wall, as the interior sees it: the tile inside it, the level, which way
 *  the wall faces, where along the wall its middle is (x for a wall facing z, z for one facing x) -
 *  and half its width, its foot and its head. */
export interface Opening {
  i: number;
  j: number;
  k: number;
  dir: FaceDir;
  along: number;
  half: number;
  bottom: number;
  top: number;
}

export interface InteriorInput {
  b: ModelBuilder;
  /** Where its walls, floors, stairs and railings go as collision shapes, if anywhere. */
  colliders?: ColliderBuilder;
  layout: InteriorLayout;
  levels: ShellLevel[];
  X: (i: number) => number;
  Z: (j: number) => number;
  tile: number;
  inside: (i: number, j: number, k: number) => boolean;
  exits: Opening[];
  windows: Opening[];
  /** The underside of a roof over the top of level k at a point in plan, or null where there is
   *  none - what a room open under the roof (RoomTypeDef.underRoof) has for its ceiling. */
  roofOver?: (k: number, x: number, z: number) => number | null;
}

/** How far a room's walls stand in from the tile lines - an inner wall twice this thick. */
export const WALL = 0.2;
/** Floors stand this far over their level's floor line, and ceilings hang this far under the
 *  level's top - so a ceiling and the floor over it, or a floor and the ceiling of an arcade under
 *  it, are never drawn in one plane. */
const FLOOR_LIFT = 0.02;
const CEILING_DROP = 0.04;
/** How far a doorway's threshold stands over the floor line. */
const THRESHOLD = 0.05;
/** A gallery's floor, and the floor round a stairwell, this thick. */
const SLAB = 0.3;
/** An inner door's opening, and the frames round it. */
const DOOR_HALF = 0.7;
const DOOR_HEIGHT = 2.9;
const FRAME = 0.12;
/** Railings: how high, how thick their posts and rail, and how far apart their posts. */
const RAIL_HEIGHT = 1.2;
const RAIL = 0.1;
const POST_GAP = 1.3;
/** A stall's partition boards and the post at its open end, how thick; a manger, how far out from
 *  the wall and how high. */
const STALL_BOARD = 0.14;
const STALL_POST = 0.32;
const MANGER_DEPTH = 1.0;
const MANGER_HEIGHT = 1.3;
/** How far a stair stands off the wall beside it. */
const STAIR_CLEAR = 0.02;
/** A stair's steps rise about this much each. */
const RISER = 0.4;

const UP: Vec3 = [0, 1, 0];
const DOWN: Vec3 = [0, -1, 0];

export function buildInterior(input: InteriorInput): void {
  const { b, layout, X, Z, tile, colliders } = input;
  const levelOf = (k: number): ShellLevel => input.levels.find((level) => level.index === k)!;
  const roomOf = (id: number): Room => layout.rooms.find((room) => room.id === id)!;
  const alongX = (dir: FaceDir): boolean => dir === "pz" || dir === "nz";
  const signOf = (dir: FaceDir): number => (dir === "px" || dir === "pz" ? 1 : -1);
  /** The tile line a cell's face toward `dir` lies on. */
  const lineOf = (i: number, j: number, dir: FaceDir): number => (dir === "pz" ? Z(j + 1) : dir === "nz" ? Z(j) : dir === "px" ? X(i + 1) : X(i));
  /** Where along a face of a cell it runs, and its middle. */
  const spanOf = (i: number, j: number, dir: FaceDir): [number, number] => (alongX(dir) ? [X(i), X(i + 1)] : [Z(j), Z(j + 1)]);
  /** The inner surfaces' rectangle of a room. */
  const insetOf = (room: Room) => ({ x0: X(room.rect.i0) + WALL, x1: X(room.rect.i1) - WALL, z0: Z(room.rect.j0) + WALL, z1: Z(room.rect.j1) - WALL });
  /** A box given across a face (c, the axis the face faces along) and along it. */
  const faceBox = (dir: FaceDir, c0: number, c1: number, a0: number, a1: number, y0: number, y1: number, paint: Paint): void => {
    const [cl, ch] = c0 < c1 ? [c0, c1] : [c1, c0];
    const [al, ah] = a0 < a1 ? [a0, a1] : [a1, a0];
    if (alongX(dir)) b.box(al, y0, cl, ah, y1, ch, paint, paint, "both");
    else b.box(cl, y0, al, ch, y1, ah, paint, paint, "both");
  };
  /** An upright rectangle on the plane `c` of a face, facing `normal`. */
  const upright = (dir: FaceDir, c: number, a0: number, a1: number, y0: number, y1: number, normal: Vec3, paint: Paint): void => {
    if (a1 - a0 < 1e-4 || y1 - y0 < 1e-4) return;
    const at = (a: number, y: number): Vec3 => (alongX(dir) ? [a, y, c] : [c, y, a]);
    b.face([at(a0, y0), at(a1, y0), at(a1, y1), at(a0, y1)], normal, paint);
  };
  const inward = (dir: FaceDir): Vec3 => {
    const s = -signOf(dir);
    return alongX(dir) ? [0, 0, s] : [s, 0, 0];
  };
  const doorTop = (k: number): number => {
    const level = levelOf(k);
    return level.floor + Math.min(DOOR_HEIGHT, level.top - level.floor - 0.4);
  };
  /** The inner door on a cell's face, whichever side it was put on. */
  const doorAt = (i: number, j: number, k: number, dir: FaceDir) => {
    const [di, dj] = STEP[dir];
    return layout.doors.find((door) => door.k === k && ((door.i === i && door.j === j && door.dir === dir) || (door.i === i + di && door.j === j + dj && door.dir === opposite(dir))));
  };

  for (const room of layout.rooms) {
    const inset = insetOf(room);
    const { rect } = room;
    const top = room.base + room.height - 1;
    /** Whether a cell of its top level is open up to the roof: its type asks for it, nothing of the
     *  house is over it, and a roof is. */
    const roofOver = input.roofOver;
    const underRoof = (i: number, j: number): boolean =>
      room.type.underRoof && !!roofOver && !input.inside(i, j, top + 1) && roofOver(top, (X(i) + X(i + 1)) / 2, (Z(j) + Z(j + 1)) / 2) !== null;
    /** Its ceiling there: just under the roof - never under the top of its walls, nor, past the
     *  roof's edge, over it. */
    const roofCeiling = (x: number, z: number): number => Math.max(levelOf(top).top, roofOver?.(top, x, z) ?? levelOf(top).top) - CEILING_DROP;

    // The walls: every face of the room's cells onto anything that is not the room, level by level,
    // cut round the doors through it.
    for (let k = room.base; k <= top; k++) {
      const level = levelOf(k);
      for (let i = rect.i0; i < rect.i1; i++) {
        for (let j = rect.j0; j < rect.j1; j++) {
          for (const dir of FACE_DIRS) {
            const [di, dj] = STEP[dir];
            const ni = i + di;
            const nj = j + dj;
            if (ni >= rect.i0 && ni < rect.i1 && nj >= rect.j0 && nj < rect.j1) continue;
            const c = lineOf(i, j, dir) - signOf(dir) * WALL;
            const [s0, s1] = spanOf(i, j, dir);
            const a0 = Math.max(s0, alongX(dir) ? inset.x0 : inset.z0);
            const a1 = Math.min(s1, alongX(dir) ? inset.x1 : inset.z1);
            const holes: { a0: number; a1: number; y0: number; y1: number }[] = [];
            const door = doorAt(i, j, k, dir);
            if (door && door.state !== "fake") {
              const mid = (s0 + s1) / 2;
              holes.push({ a0: mid - DOOR_HALF, a1: mid + DOOR_HALF, y0: level.floor, y1: doorTop(k) });
            }
            // A door out cut wherever it crosses this face - a wide one spans two tiles' faces.
            for (const exit of input.exits) {
              if (exit.k !== k || exit.dir !== dir || lineOf(exit.i, exit.j, exit.dir) !== lineOf(i, j, dir)) continue;
              if (exit.along + exit.half <= s0 || exit.along - exit.half >= s1) continue;
              holes.push({ a0: exit.along - exit.half, a1: exit.along + exit.half, y0: exit.bottom, y1: exit.top });
            }
            const normal = inward(dir);
            // As collision: the wall's half from its face back to the tile line - the room on the
            // other side, or the house's outer wall, stands the rest.
            if (colliders) wallBoxes(colliders, alongX(dir), c, lineOf(i, j, dir), a0, a1, level.floor, level.top, holes);
            let from = a0;
            for (const hole of holes.sort((p, q) => p.a0 - q.a0)) {
              upright(dir, c, from, hole.a0, level.floor, level.top, normal, room.paints.walls);
              upright(dir, c, hole.a0, hole.a1, level.floor, hole.y0, normal, room.paints.walls);
              upright(dir, c, hole.a0, hole.a1, hole.y1, level.top, normal, room.paints.walls);
              from = hole.a1;
            }
            upright(dir, c, from, a1, level.floor, level.top, normal, room.paints.walls);
            // Open up to the roof: the wall goes on up to it - along the roof's line, peaked where a
            // ridge passes over (a ridge lies on a tile's line or its middle).
            if (k === top && underRoof(i, j)) {
              const mid = (s0 + s1) / 2;
              const along = [a0, ...(mid > a0 && mid < a1 ? [mid] : []), a1];
              const at = (a: number, y: number): Vec3 => (alongX(dir) ? [a, y, c] : [c, y, a]);
              const heights = along.map((a) => (alongX(dir) ? roofCeiling(a, c) : roofCeiling(c, a)));
              if (heights.some((h) => h > level.top + 1e-3)) {
                const corners = [at(a0, level.top), at(a1, level.top), ...along.map((a, n) => at(a, Math.max(level.top, heights[n]))).reverse()];
                b.face(corners, normal, room.paints.walls);
                // As collision, back to the tile line, as the wall under it is.
                const line = lineOf(i, j, dir);
                if (colliders) colliders.hull([...corners, ...corners.map(([x, y, z]): Vec3 => (alongX(dir) ? [x, y, line] : [line, y, z]))]);
              }
            }
          }
        }
      }
    }

    // The floor, but where a stair rises through it from below.
    const floorY = levelOf(room.base).floor + FLOOR_LIFT;
    for (let i = rect.i0; i < rect.i1; i++) {
      for (let j = rect.j0; j < rect.j1; j++) {
        if (layout.holes.has(cellKey(i, j, room.base))) continue;
        const [x0, x1, z0, z1] = clampCell(i, j, inset);
        b.faceToward([[x0, floorY, z0], [x1, floorY, z0], [x1, floorY, z1], [x0, floorY, z1]], UP, room.paints.floor);
        // As collision, out to the tile lines, under the walls.
        colliders?.box(X(i), floorY - SLAB, Z(j), X(i + 1), floorY, Z(j + 1));
      }
    }
    // The ceiling, but where a stair rises through it to the room over it - and its beams.
    const ceilingY = levelOf(top).top - CEILING_DROP;
    for (let i = rect.i0; i < rect.i1; i++) {
      for (let j = rect.j0; j < rect.j1; j++) {
        if (layout.holes.has(cellKey(i, j, top + 1))) continue;
        const [x0, x1, z0, z1] = clampCell(i, j, inset);
        // Open up to the roof: the roof's underside, in quarters - a ridge over it lies on the
        // cell's edge or its middle - its slab the roof's own (houseGenerator.ts).
        if (underRoof(i, j)) {
          const xs = [x0, Math.min(x1, Math.max(x0, (X(i) + X(i + 1)) / 2)), x1];
          const zs = [z0, Math.min(z1, Math.max(z0, (Z(j) + Z(j + 1)) / 2)), z1];
          for (let p = 0; p < 2; p++) {
            for (let q = 0; q < 2; q++) {
              const [xa, xb, za, zb] = [xs[p], xs[p + 1], zs[q], zs[q + 1]];
              if (xb - xa < 1e-4 || zb - za < 1e-4) continue;
              const corners: Vec3[] = [[xa, roofCeiling(xa, za), za], [xb, roofCeiling(xb, za), za], [xb, roofCeiling(xb, zb), zb], [xa, roofCeiling(xa, zb), zb]];
              b.faceToward(corners, DOWN, room.paints.ceiling);
            }
          }
          continue;
        }
        b.faceToward([[x0, ceilingY, z0], [x1, ceilingY, z0], [x1, ceilingY, z1], [x0, ceilingY, z1]], DOWN, room.paints.ceiling);
        // Nothing of the house over it - the roof's own piece, or the open air over a terrace's
        // floor - so a slab of its own.
        if (!input.inside(i, j, top + 1)) colliders?.box(X(i), ceilingY, Z(j), X(i + 1), ceilingY + SLAB, Z(j + 1));
      }
    }
    if (room.paints.beams) {
      const across = rect.i1 - rect.i0 <= rect.j1 - rect.j0;
      const lines = across ? range(rect.j0 + 1, rect.j1).map(Z) : range(rect.i0 + 1, rect.i1).map(X);
      const beams = room.paints.beams;
      const lineTiles = across ? range(rect.j0 + 1, rect.j1) : range(rect.i0 + 1, rect.i1);
      lineTiles.forEach((t, n) => {
        const line = lines[n];
        // Along the beam, tile by tile - but not across a stairwell: where the floor over it is open
        // on both sides of the beam, the beam stops at its edge.
        const runs: [number, number][] = [];
        const [c0, c1] = across ? [rect.i0, rect.i1] : [rect.j0, rect.j1];
        for (let c = c0; c < c1; c++) {
          const [p, q] = across ? [cellKey(c, t - 1, top + 1), cellKey(c, t, top + 1)] : [cellKey(t - 1, c, top + 1), cellKey(t, c, top + 1)];
          if (layout.holes.has(p) && layout.holes.has(q)) continue;
          const last = runs[runs.length - 1];
          if (last && last[1] === c) last[1] = c + 1;
          else runs.push([c, c + 1]);
        }
        for (const [s, e] of runs) {
          // Hung under the ceiling: sides and a bottom, no top against it.
          if (across) {
            const x0 = s === rect.i0 ? inset.x0 : X(s);
            const x1 = e === rect.i1 ? inset.x1 : X(e);
            b.box(x0, ceilingY - 0.3, line - 0.14, x1, ceilingY, line + 0.14, beams, beams, "bottom");
          } else {
            const z0 = s === rect.j0 ? inset.z0 : Z(s);
            const z1 = e === rect.j1 ? inset.z1 : Z(e);
            b.box(line - 0.14, ceilingY - 0.3, z0, line + 0.14, ceilingY, z1, beams, beams, "bottom");
          }
        }
      });
    }

    // Stalls along its back wall, a bay each: board partitions between them, a post at each one's
    // open end, and a manger - a trough - along the wall in each.
    const stalls = room.type.stalls;
    if (stalls && rect.j1 - rect.j0 > stalls.depth) {
      const paint = room.paints.timber;
      const y0 = floorY;
      const y1 = floorY + stalls.height;
      const back = inset.z0;
      const front = Z(rect.j0 + stalls.depth);
      const solid = (x0: number, ya: number, z0: number, x1: number, yb: number, z1: number): void => {
        b.box(x0, ya, z0, x1, yb, z1, paint);
        colliders?.box(x0, ya, z0, x1, yb, z1);
      };
      for (let i = rect.i0 + 1; i < rect.i1; i++) {
        const x = X(i);
        solid(x - STALL_BOARD / 2, y0, back, x + STALL_BOARD / 2, y1, front - STALL_POST);
        solid(x - STALL_POST / 2, y0, front - STALL_POST, x + STALL_POST / 2, y1 + 0.3, front);
      }
      for (let i = rect.i0; i < rect.i1; i++) {
        const x0 = (i === rect.i0 ? inset.x0 : X(i) + STALL_BOARD / 2) + 0.1;
        const x1 = (i === rect.i1 - 1 ? inset.x1 : X(i + 1) - STALL_BOARD / 2) - 0.1;
        // A trough: a base, and a lip along its front and at its ends standing up round its hollow.
        const rim = y0 + MANGER_HEIGHT;
        const hollow = rim - 0.35;
        const out = back + MANGER_DEPTH;
        b.box(x0, y0, back, x1, hollow, out, paint);
        b.box(x0, hollow, out - 0.1, x1, rim, out, paint);
        b.box(x0, hollow, back, x0 + 0.1, rim, out - 0.1, paint);
        b.box(x1 - 0.1, hollow, back, x1, rim, out - 0.1, paint);
        colliders?.box(x0, y0, back, x1, rim, out);
      }
    }

    // Galleries over a tall room's floor: a slab, its open edges railed - but where its stair arrives.
    for (let k = room.base + 1; k <= top; k++) {
      const y = levelOf(k).floor + FLOOR_LIFT;
      for (let i = rect.i0; i < rect.i1; i++) {
        for (let j = rect.j0; j < rect.j1; j++) {
          if (!layout.gallery.has(cellKey(i, j, k))) continue;
          const [x0, x1, z0, z1] = clampCell(i, j, inset);
          b.faceToward([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], UP, room.paints.floor);
          b.faceToward([[x0, y - SLAB, z0], [x1, y - SLAB, z0], [x1, y - SLAB, z1], [x0, y - SLAB, z1]], DOWN, room.paints.timber);
          colliders?.box(x0, y - SLAB, z0, x1, y, z1);
          for (const dir of FACE_DIRS) {
            const [di, dj] = STEP[dir];
            const ni = i + di;
            const nj = j + dj;
            if (ni < rect.i0 || ni >= rect.i1 || nj < rect.j0 || nj >= rect.j1 || layout.gallery.has(cellKey(ni, nj, k))) continue;
            const line = lineOf(i, j, dir);
            const [s0, s1] = spanOf(i, j, dir);
            const a0 = Math.max(s0, alongX(dir) ? inset.x0 : inset.z0);
            const a1 = Math.min(s1, alongX(dir) ? inset.x1 : inset.z1);
            const out: Vec3 = alongX(dir) ? [0, 0, signOf(dir)] : [signOf(dir), 0, 0];
            upright(dir, line, a0, a1, y - SLAB, y, out, room.paints.timber);
            const arrival = layout.stairs.some((stair) => stair.to === room.id && stair.room === room.id && stair.level === k - 1 && stair.arrival[0] === i && stair.arrival[1] === j && stair.tiles[stair.tiles.length - 1][0] === ni && stair.tiles[stair.tiles.length - 1][1] === nj);
            if (!arrival) railing(dir, line, a0, a1, y, room.paints.timber);
          }
        }
      }
    }
  }

  // Stairwells: the floor round a stair rising through it, railed but where the stair arrives.
  for (const stair of layout.stairs) {
    if (stair.to === stair.room) continue;
    const upper = roomOf(stair.to);
    const k = stair.level + 1;
    const y = levelOf(k).floor + FLOOR_LIFT;
    const inset = insetOf(upper);
    for (const [i, j] of stair.tiles) {
      for (const dir of FACE_DIRS) {
        const [di, dj] = STEP[dir];
        const ni = i + di;
        const nj = j + dj;
        if (layout.holes.has(cellKey(ni, nj, k)) || layout.cells.get(cellKey(ni, nj, k)) !== upper.id) continue;
        const line = lineOf(i, j, dir);
        const [s0, s1] = spanOf(i, j, dir);
        const a0 = Math.max(s0, alongX(dir) ? inset.x0 : inset.z0);
        const a1 = Math.min(s1, alongX(dir) ? inset.x1 : inset.z1);
        const back: Vec3 = alongX(dir) ? [0, 0, -signOf(dir)] : [-signOf(dir), 0, 0];
        upright(dir, line, a0, a1, y - SLAB, y, back, upper.paints.timber);
        const last = stair.tiles[stair.tiles.length - 1];
        const arrives = i === last[0] && j === last[1] && ni === stair.arrival[0] && nj === stair.arrival[1];
        if (!arrives) railing(dir, line, a0, a1, y, upper.paints.timber);
      }
    }
  }

  // The stairs: steps from one floor to the next, along a wall.
  for (const stair of layout.stairs) {
    const host = roomOf(stair.room);
    const floor = levelOf(stair.level).floor;
    const rise = levelOf(stair.level + 1).floor - floor;
    const [t0] = stair.tiles;
    const s = signOf(stair.dir);
    const runX = !alongX(stair.dir);
    // Along the run: from the back of its first tile to the front of its last.
    const start = runX ? (s > 0 ? X(t0[0]) : X(t0[0] + 1)) : s > 0 ? Z(t0[1]) : Z(t0[1] + 1);
    // To the front of its last tile - or, where a wall stands across its top (the room it rises
    // into lies over a wall of this one), just short of the wall's face.
    const [ai, aj] = stair.arrival;
    const walled = layout.cells.get(cellKey(ai, aj, stair.level)) !== stair.room;
    const end = start + s * (stair.tiles.length * tile - (walled ? WALL + STAIR_CLEAR : 0));
    // Across it: from the wall it stands against, as wide as fits.
    const width = Math.min(1.9, tile - 2 * WALL);
    // Just clear of the wall it stands against, so its side and the wall's face are never one plane.
    const wallLine = lineOf(t0[0], t0[1], stair.wallSide) - signOf(stair.wallSide) * (WALL + STAIR_CLEAR);
    const across: [number, number] = [wallLine, wallLine - signOf(stair.wallSide) * width];
    const steps = Math.max(4, Math.round(rise / RISER));
    // As collision, a smooth slope - its steps' noses - rather than the steps themselves.
    if (colliders) {
      const at = (a: number, y: number, c: number): Vec3 => (runX ? [a, y, c] : [c, y, a]);
      const [c0, c1] = across;
      colliders.hull([at(start, floor, c0), at(start, floor, c1), at(end, floor, c0), at(end, floor, c1), at(end, floor + rise, c0), at(end, floor + rise, c1)]);
    }
    const box = (a0: number, a1: number, y0: number, y1: number, paint: Paint): void => {
      const [al, ah] = a0 < a1 ? [a0, a1] : [a1, a0];
      const [cl, ch] = across[0] < across[1] ? across : [across[1], across[0]];
      if (runX) b.box(al, y0, cl, ah, y1, ch, paint, paint, host.type.stair === "solid" ? "top" : "both");
      else b.box(cl, y0, al, ch, y1, ah, paint, paint, host.type.stair === "solid" ? "top" : "both");
    };
    for (let n = 0; n < steps; n++) {
      const a0 = start + ((end - start) * n) / steps;
      const a1 = start + ((end - start) * (n + 1)) / steps;
      const y = floor + (rise * (n + 1)) / steps;
      if (host.type.stair === "solid") box(a0, a1, floor, y, host.paints.floor);
      else box(a0, a1, y - 0.1, y, host.paints.timber);
    }
    if (host.type.stair === "open") {
      // A stringer under the treads, on the open side.
      const c = across[1];
      const at = (a: number, y: number): Vec3 => (runX ? [a, y, c] : [c, y, a]);
      const lift = 0.45;
      const foot = start + ((end - start) * lift) / rise;
      const sideways: Vec3 = runX ? [0, 0, -signOf(stair.wallSide)] : [-signOf(stair.wallSide), 0, 0];
      b.face([at(start, floor), at(end, floor + rise), at(end, floor + rise - lift), at(foot, floor)], sideways, host.paints.timber);
    }
  }

  // The doors between rooms - open, shut, or fake against a wall with nothing behind it.
  for (const door of layout.doors) {
    const { i, j, k, dir } = door;
    const room = roomOf(door.rooms[0]);
    const paint = room.paints.timber;
    const line = lineOf(i, j, dir);
    const s = signOf(dir);
    const [s0, s1] = spanOf(i, j, dir);
    const mid = (s0 + s1) / 2;
    const y0 = levelOf(k).floor;
    const y1 = doorTop(k);
    if (door.state === "fake") {
      const face = line - s * WALL;
      frame(dir, face, face - s * 0.06, mid, DOOR_HALF, y0, y1, paint);
      faceBox(dir, face, face - s * 0.04, mid - DOOR_HALF, mid + DOOR_HALF, y0, y1, paint);
      continue;
    }
    frame(dir, line - s * (WALL + 0.04), line + s * (WALL + 0.04), mid, DOOR_HALF, y0, y1, paint);
    threshold(dir, line - s * WALL, line + s * WALL, mid, DOOR_HALF, y0, paint);
  }

  // The doors out, from inside: a frame through the wall. No door stands open with its leaf in the
  // way - nothing opens or shuts - so an open doorway is just its frame.
  for (const exit of input.exits) {
    const id = layout.cells.get(cellKey(exit.i, exit.j, exit.k));
    if (id === undefined) continue;
    const room = roomOf(id);
    const line = lineOf(exit.i, exit.j, exit.dir);
    const s = signOf(exit.dir);
    frame(exit.dir, line - s * (WALL + 0.04), line, exit.along, exit.half, exit.bottom, exit.top, room.paints.timber);
    threshold(exit.dir, line - s * WALL, line, exit.along, exit.half, exit.bottom, room.paints.timber);
  }

  // The windows from inside: where a room keeps its shutters shut over them, the shutters in a
  // frame - otherwise the house builds each window again on the inner face (houseGenerator.ts).
  for (const window of input.windows) {
    const id = layout.cells.get(cellKey(window.i, window.j, window.k));
    if (id === undefined) continue;
    const room = roomOf(id);
    if (room.type.windows !== "shutters") continue;
    const line = lineOf(window.i, window.j, window.dir);
    const s = signOf(window.dir);
    const face = line - s * WALL;
    const { along, half, bottom, top } = window;
    frame(window.dir, face, face - s * 0.1, along, half, bottom, top, room.paints.timber);
    faceBox(window.dir, face, face - s * 0.14, along - half - FRAME - 0.08, along + half + FRAME + 0.08, bottom - FRAME, bottom, room.paints.timber);
    faceBox(window.dir, face, face - s * 0.06, along - half, along - 0.01, bottom, top, room.paints.timber);
    faceBox(window.dir, face, face - s * 0.06, along + 0.01, along + half, bottom, top, room.paints.timber);
  }

  /** A door or window frame: jambs and a head, from `c0` to `c1` across the wall. */
  function frame(dir: FaceDir, c0: number, c1: number, mid: number, half: number, y0: number, y1: number, paint: Paint): void {
    faceBox(dir, c0, c1, mid - half - FRAME, mid - half, y0, y1 + FRAME, paint);
    faceBox(dir, c0, c1, mid + half, mid + half + FRAME, y0, y1 + FRAME, paint);
    faceBox(dir, c0, c1, mid - half - FRAME, mid + half + FRAME, y1, y1 + FRAME, paint);
  }
  /** A threshold across a doorway, through the wall from `c0` to `c1`: the floor carried over it, a
   *  little proud of the floors either side. */
  function threshold(dir: FaceDir, c0: number, c1: number, mid: number, half: number, y: number, paint: Paint): void {
    const [cl, ch] = c0 < c1 ? [c0, c1] : [c1, c0];
    const [al, ah] = [mid - half, mid + half];
    if (alongX(dir)) b.box(al, y - 0.1, cl, ah, y + THRESHOLD, ch, paint);
    else b.box(cl, y - 0.1, al, ch, y + THRESHOLD, ah, paint);
  }
  /** A railing along a line across a face's plane: posts and a rail on top. */
  function railing(dir: FaceDir, line: number, a0: number, a1: number, y: number, paint: Paint): void {
    const length = a1 - a0;
    if (length < 0.2) return;
    const count = Math.max(1, Math.round(length / POST_GAP));
    for (let n = 0; n <= count; n++) {
      const a = Math.min(a1 - RAIL / 2, Math.max(a0 + RAIL / 2, a0 + (length * n) / count));
      faceBox(dir, line - RAIL / 2, line + RAIL / 2, a - RAIL / 2, a + RAIL / 2, y, y + RAIL_HEIGHT - RAIL, paint);
    }
    faceBox(dir, line - RAIL / 2, line + RAIL / 2, a0, a1, y + RAIL_HEIGHT - RAIL, y + RAIL_HEIGHT, paint);
    // As collision, one solid rail from the floor up.
    if (colliders) {
      if (alongX(dir)) colliders.box(a0, y, line - RAIL / 2, a1, y + RAIL_HEIGHT, line + RAIL / 2);
      else colliders.box(line - RAIL / 2, y, a0, line + RAIL / 2, y + RAIL_HEIGHT, a1);
    }
  }
  /** A cell's square, held inside its room's walls. */
  function clampCell(i: number, j: number, inset: { x0: number; x1: number; z0: number; z1: number }): [number, number, number, number] {
    return [Math.max(X(i), inset.x0), Math.min(X(i + 1), inset.x1), Math.max(Z(j), inset.z0), Math.min(Z(j + 1), inset.z1)];
  }
}

const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from) }, (_, n) => from + n);
