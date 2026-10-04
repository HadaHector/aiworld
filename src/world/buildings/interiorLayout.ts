import type { Paint, RoomRequest, RoomTypeDef, RoomsInterior } from "./buildingTypes";
import { pick, rollInt } from "./buildingGeometry";
import type { Block } from "./housePlans";

/**
 * Lays out a house's interior from its room program (see INTERIORS.md): rooms as boxes of cells -
 * a cell is one tile on one level - placed in priority order inside the house's shell, then joined
 * up from the entrance by doors, stairs (with a gallery round a tall room, or a stairwell through a
 * floor) and nothing else. A room that cannot be placed or reached is left out, and whatever no room
 * takes is unbuilt space, sealed off.
 *
 * Pure data: interiorGeometry.ts builds it.
 */

/** A level of the house, as the interior sees it: its index (cellars below 0) and heights. */
export interface ShellLevel {
  kind: "cellar" | "ground" | "upper";
  index: number;
  floor: number;
  top: number;
}

/** The house the interior is laid in. */
export interface InteriorShell {
  levels: ShellLevel[];
  /** Whether a tile is inside the house on a level - walls round it there. */
  inside: (i: number, j: number, k: number) => boolean;
  /** Every tile the house stands on, for the search. */
  bounds: Block;
  /** A tile's side, in metres - a stair's run is whole tiles. */
  tile: number;
  /** The tile behind the front door, on the ground level - or none. */
  entrance: { i: number; j: number } | null;
}

export type FaceDir = "px" | "nx" | "pz" | "nz";
export const STEP: Record<FaceDir, [number, number]> = { px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] };
export const FACE_DIRS: FaceDir[] = ["px", "nx", "pz", "nz"];

export interface Room {
  id: number;
  /** The request's room type id - what `next`, `under` and `over` name. */
  name: string;
  type: RoomTypeDef;
  rect: Block;
  /** Its lowest level, and how many levels tall it is - open through all of them. */
  base: number;
  height: number;
  /** The most tiles of floor it may grow to: its largest size times its growth multiplier - and
   *  the longest either side may grow (Infinity: no limit). */
  maxTiles: number;
  maxSide: number;
  paints: { floor: Paint; walls: Paint; ceiling: Paint; beams: Paint | null; timber: Paint };
}

/** A stair in `room`, rising from level `level` to the one over it along `dir`: its tiles - one for
 *  a shallow rise (a cellar's), two for a storey - the tile it arrives on, and which side of it the
 *  wall it stands against is. */
export interface Stair {
  room: number;
  level: number;
  dir: FaceDir;
  tiles: [number, number][];
  arrival: [number, number];
  /** The room it arrives in - its own, onto a gallery, or the one over it, through a hole. */
  to: number;
  wallSide: FaceDir;
}

/** A door between rooms is always open; a shut one is fake - nothing is behind it. */
export type DoorState = "open" | "fake";

/** A door on the face of cell (i, j) on level k toward `dir`: into another room, or - fake - into
 *  unbuilt space. */
export interface InnerDoor {
  i: number;
  j: number;
  k: number;
  dir: FaceDir;
  state: DoorState;
  rooms: [number, number | null];
}

export interface InteriorLayout {
  rooms: Room[];
  stairs: Stair[];
  doors: InnerDoor[];
  /** Cells over a tall room's floor that are floored - its galleries - as "i,j,k". */
  gallery: Set<string>;
  /** Cells whose floor is open, a stair rising through it, as "i,j,k". */
  holes: Set<string>;
  /** The room behind the front door, or null. */
  entranceRoom: number | null;
  /** Which room each built cell is in, by "i,j,k". */
  cells: Map<string, number>;
}

export const cellKey = (i: number, j: number, k: number): string => `${i},${j},${k}`;

/** Growing into the space left over never draws a room out longer than this many times its width. */
const GROW_ASPECT = 3;

const inRect = (r: Block, i: number, j: number): boolean => i >= r.i0 && i < r.i1 && j >= r.j0 && j < r.j1;
const area = (r: Block): number => (r.i1 - r.i0) * (r.j1 - r.j0);
const overlap = (a: Block, b: Block): number =>
  Math.max(0, Math.min(a.i1, b.i1) - Math.max(a.i0, b.i0)) * Math.max(0, Math.min(a.j1, b.j1) - Math.max(a.j0, b.j0));
/** Whether two rects share at least one tile edge (side by side, not overlapping). */
const touching = (a: Block, b: Block): boolean => {
  const alongI = Math.min(a.i1, b.i1) - Math.max(a.i0, b.i0);
  const alongJ = Math.min(a.j1, b.j1) - Math.max(a.j0, b.j0);
  return ((a.i1 === b.i0 || b.i1 === a.i0) && alongJ > 0) || ((a.j1 === b.j0 || b.j1 === a.j0) && alongI > 0);
};

/** Lays out the rooms of a `rooms` interior in a shell. */
export function planInterior(program: RoomsInterior, shell: InteriorShell, rng: () => number, paintOf: (surface: RoomTypeDef["floor"]) => Paint): InteriorLayout {
  const levelIndices = shell.levels.map((level) => level.index);
  const hasLevel = (k: number): boolean => levelIndices.includes(k);
  const cells = new Map<string, number>();
  const rooms: Room[] = [];
  const { bounds } = shell;

  // The requests, highest priority first (in list order where level), each repeated `count` times.
  const requests = program.rooms
    .map((request, order) => ({ request, order }))
    .sort((p, q) => q.request.priority - p.request.priority || p.order - q.order)
    .flatMap(({ request }) => Array.from({ length: rollInt(request.count, rng) }, () => request));

  for (const request of requests) {
    if (rng() >= request.chance) continue;
    const rolled = rollInt(request.levels, rng);
    const target = rollInt(request.tiles, rng);
    // As tall as rolled - or, where that cannot stand anywhere (a two-storey room in a one-storey
    // wing), the tallest that can.
    let best: { rect: Block; base: number; score: number } | null = null;
    let height = rolled;
    for (; height >= request.levels[0] && !best; height--) best = bestPlace(request, height, target);
    height++;
    if (!best) continue;
    const room: Room = {
      id: rooms.length,
      name: request.room.id,
      type: request.room,
      rect: best.rect,
      base: best.base,
      height,
      maxTiles: Math.floor(request.tiles[1] * (request.grow ?? program.grow)),
      maxSide: request.maxSide ?? Infinity,
      paints: {
        floor: paintOf(request.room.floor),
        walls: paintOf(request.room.walls),
        ceiling: paintOf(request.room.ceiling),
        beams: request.room.beams ? paintOf(request.room.beams) : null,
        timber: paintOf(request.room.timber),
      },
    };
    stake(room);
    rooms.push(room);
  }

  /** Where a request's room `height` levels tall fits best - or null where it fits nowhere. */
  function bestPlace(request: RoomRequest, height: number, target: number): { rect: Block; base: number; score: number } | null {
    let best: { rect: Block; base: number; score: number } | null = null;
    for (const base of baseLevels(request, height, levelIndices)) {
      if (!Array.from({ length: height }, (_, n) => hasLevel(base + n)).every(Boolean)) continue;
      for (let i0 = bounds.i0; i0 < bounds.i1; i0++) {
        for (let i1 = i0 + 1; i1 <= bounds.i1; i1++) {
          for (let j0 = bounds.j0; j0 < bounds.j1; j0++) {
            for (let j1 = j0 + 1; j1 <= bounds.j1; j1++) {
              const rect = { i0, i1, j0, j1 };
              const size = area(rect);
              if (size < request.tiles[0] || size > request.tiles[1]) continue;
              if (i1 - i0 < request.minSide || j1 - j0 < request.minSide) continue;
              if (request.maxSide !== null && (i1 - i0 > request.maxSide || j1 - j0 > request.maxSide)) continue;
              if (!fits(rect, base, height)) continue;
              const score = scoreOf(request, rect, base, height, size, target);
              if (score === null) continue;
              const jittered = score + rng() * 0.01;
              if (!best || jittered > best.score) best = { rect, base, score: jittered };
            }
          }
        }
      }
    }
    return best;
  }

  /** Whether a rect, `height` levels from `base`, is inside the house and free on every level. */
  function fits(rect: Block, base: number, height: number): boolean {
    for (let k = base; k < base + height; k++) {
      for (let i = rect.i0; i < rect.i1; i++) {
        for (let j = rect.j0; j < rect.j1; j++) if (!shell.inside(i, j, k) || cells.has(cellKey(i, j, k))) return false;
      }
    }
    return true;
  }
  function stake(room: Room): void {
    for (let k = room.base; k < room.base + room.height; k++) {
      for (let i = room.rect.i0; i < room.rect.i1; i++) for (let j = room.rect.j0; j < room.rect.j1; j++) cells.set(cellKey(i, j, k), room.id);
    }
  }
  function unstake(room: Room): void {
    for (const [key, id] of [...cells]) if (id === room.id) cells.delete(key);
  }
  /** A placement's score, or null where it breaks a requirement: nearest the target area, then the
   *  squarest, then the most overlap with what it sits under or over. */
  function scoreOf(request: RoomRequest, rect: Block, base: number, height: number, size: number, target: number): number | null {
    const named = (name: string): Room[] => rooms.filter((room) => room.name === name);
    if (request.at === "entrance") {
      if (!shell.entrance || base !== 0 || !inRect(rect, shell.entrance.i, shell.entrance.j)) return null;
    }
    let bonus = 0;
    if (request.near === "entrance" && shell.entrance && base === 0 && inRect(rect, shell.entrance.i, shell.entrance.j)) bonus += 8;
    // Its sides along the house's own walls, where it can: a room fills a block of the plan rather
    // than cutting across two.
    const sideOut = (cells: [number, number][]): boolean => cells.every(([i, j]) => !shell.inside(i, j, base));
    const span = (a: number, z: number): number[] => Array.from({ length: z - a }, (_, n) => a + n);
    for (const side of [
      span(rect.j0, rect.j1).map((j): [number, number] => [rect.i0 - 1, j]),
      span(rect.j0, rect.j1).map((j): [number, number] => [rect.i1, j]),
      span(rect.i0, rect.i1).map((i): [number, number] => [i, rect.j0 - 1]),
      span(rect.i0, rect.i1).map((i): [number, number] => [i, rect.j1]),
    ]) {
      if (sideOut(side)) bonus += 3;
    }
    if (request.next) {
      const top = base + height;
      const beside = named(request.next).some((room) => room.base < top && base < room.base + room.height && touching(rect, room.rect));
      if (!beside) return null;
    }
    if (request.under) {
      const most = Math.max(0, ...named(request.under).filter((room) => room.base === base + height).map((room) => overlap(rect, room.rect)));
      if (most === 0) return null;
      bonus += most;
    }
    if (request.over) {
      const most = Math.max(0, ...named(request.over).filter((room) => room.base + room.height === base).map((room) => overlap(rect, room.rect)));
      if (most === 0) return null;
      bonus += most;
    }
    if (request.windows) {
      let outer = false;
      for (let i = rect.i0; i < rect.i1 && !outer; i++) {
        for (let j = rect.j0; j < rect.j1 && !outer; j++) {
          for (const dir of FACE_DIRS) {
            const [di, dj] = STEP[dir];
            if (!inRect(rect, i + di, j + dj) && !shell.inside(i + di, j + dj, base)) outer = true;
          }
        }
      }
      if (!outer) return null;
    }
    // Close to what is already laid out - beside a room on its own level, or over one - so it can be
    // reached; and as low as it may go, nearer the way in.
    const besideRoom = rooms.some((room) => room.base <= base && base < room.base + room.height && touching(rect, room.rect));
    const overRoom = rooms.some((room) => room.base + room.height === base && overlap(rect, room.rect) > 0);
    if (besideRoom || overRoom) bonus += 6;
    const w = rect.i1 - rect.i0;
    const d = rect.j1 - rect.j0;
    // A room with the stairs in it wants a side long enough for one: its foot, two treads' tiles
    // and the tile it arrives on.
    if (request.stair && Math.max(w, d) >= 4) bonus += 40;
    return -Math.abs(size - target) * 4 - Math.abs(w - d) + bonus * 0.5 - Math.abs(base) * 2;
  }

  // Then the rooms grow into the space left over, a tile's row at a time, each in turn - the one
  // furthest under its most first, its sides tried in a random order - until none can: a side moved
  // out wherever the row beyond it is free inside the house on every level the room stands through,
  // up to its largest size times its growth multiplier.
  let grew = true;
  while (grew) {
    grew = false;
    const order = [...rooms].sort((p, q) => area(p.rect) / p.maxTiles - area(q.rect) / q.maxTiles || p.id - q.id);
    for (const room of order) {
      const options: Block[] = [
        { ...room.rect, i0: room.rect.i0 - 1 },
        { ...room.rect, i1: room.rect.i1 + 1 },
        { ...room.rect, j0: room.rect.j0 - 1 },
        { ...room.rect, j1: room.rect.j1 + 1 },
      ].filter((rect) => {
        // Within its size, and never drawn out into a corridor: no side over its longest, nor over
        // GROW_ASPECT times the other - unless it was placed longer than that.
        const w = rect.i1 - rect.i0;
        const d = rect.j1 - rect.j0;
        const was = Math.max(room.rect.i1 - room.rect.i0, room.rect.j1 - room.rect.j0) / Math.min(room.rect.i1 - room.rect.i0, room.rect.j1 - room.rect.j0);
        return area(rect) <= room.maxTiles && Math.max(w, d) <= room.maxSide && Math.max(w, d) / Math.min(w, d) <= Math.max(GROW_ASPECT, was);
      });
      for (let n = options.length - 1; n > 0; n--) {
        const m = Math.floor(rng() * (n + 1));
        [options[n], options[m]] = [options[m], options[n]];
      }
      const grown = options.find((rect) => {
        for (let k = room.base; k < room.base + room.height; k++) {
          for (let i = rect.i0; i < rect.i1; i++) {
            for (let j = rect.j0; j < rect.j1; j++) {
              if (inRect(room.rect, i, j)) continue;
              if (!shell.inside(i, j, k) || cells.has(cellKey(i, j, k))) return false;
            }
          }
        }
        return true;
      });
      if (!grown) continue;
      room.rect = grown;
      stake(room);
      grew = true;
    }
  }

  // Joining them up, from the room behind the front door.
  const layout: InteriorLayout = { rooms, stairs: [], doors: [], gallery: new Set(), holes: new Set(), entranceRoom: null, cells };
  const entranceRoom = shell.entrance ? cells.get(cellKey(shell.entrance.i, shell.entrance.j, 0)) : undefined;
  const reached = new Set<number>();
  /** The tile at each stair's foot, kept clear - no other stair on it, nor a stair rising through
   *  its floor. */
  const stairFeet = new Set<string>();
  if (entranceRoom !== undefined) reached.add(entranceRoom);
  else {
    // No room at the door: the first room on the ground with an outer wall takes an exit instead.
    const first = rooms.find((room) => room.base === 0 && outerFaces(room).length > 0);
    if (first) reached.add(first.id);
  }
  layout.entranceRoom = entranceRoom ?? null;
  const roomAt = (i: number, j: number, k: number): Room | undefined => {
    const id = cells.get(cellKey(i, j, k));
    return id === undefined ? undefined : rooms[id];
  };
  /** Whether a room has a floor in cell (i, j, k) one can stand on: its lowest level but where a
   *  stair or a hole is, and its galleries over that. */
  const floored = (room: Room, i: number, j: number, k: number): boolean => {
    if (!inRect(room.rect, i, j) || k < room.base || k >= room.base + room.height) return false;
    const key = cellKey(i, j, k);
    if (layout.holes.has(key) || stairCell(i, j, k)) return false;
    return k === room.base || layout.gallery.has(key);
  };
  const stairCell = (i: number, j: number, k: number): boolean =>
    layout.stairs.some((stair) => stair.level === k && stair.tiles.some(([si, sj]) => si === i && sj === j));
  const doorOn = (i: number, j: number, k: number, dir: FaceDir): boolean => {
    const [di, dj] = STEP[dir];
    return layout.doors.some(
      (door) => door.k === k && ((door.i === i && door.j === j && door.dir === dir) || (door.i === i + di && door.j === j + dj && door.dir === opposite(dir))),
    );
  };
  /** Each room's faces onto the outside on its lowest level - where an exit could go. */
  function outerFaces(room: Room): { i: number; j: number; dir: FaceDir }[] {
    const out: { i: number; j: number; dir: FaceDir }[] = [];
    for (let i = room.rect.i0; i < room.rect.i1; i++) {
      for (let j = room.rect.j0; j < room.rect.j1; j++) {
        for (const dir of FACE_DIRS) {
          const [di, dj] = STEP[dir];
          if (!shell.inside(i + di, j + dj, room.base)) out.push({ i, j, dir });
        }
      }
    }
    return out;
  }
  /** Rooms a stair may go in, in order. Only a room whose request asks for the stairs holds them -
   *  and a cellar, its own way up. */
  const hosts = (list: Room[]): Room[] => [...list].sort((p, q) => Number(stairWanted(q)) - Number(stairWanted(p)) || p.id - q.id);
  const stairWanted = (room: Room): boolean => requests.some((request) => request.room.id === room.name && request.stair);

  let changed = true;
  while (changed) {
    changed = false;
    for (const room of rooms) {
      if (reached.has(room.id)) continue;
      if (connect(room)) {
        reached.add(room.id);
        changed = true;
      }
    }
  }
  // Whatever could not be reached is left out, its cells unbuilt.
  const kept = rooms.filter((room) => reached.has(room.id));
  for (const room of rooms) if (!reached.has(room.id)) unstake(room);
  layout.doors = layout.doors.filter((door) => reached.has(door.rooms[0]) && (door.rooms[1] === null || reached.has(door.rooms[1])));
  layout.stairs = layout.stairs.filter((stair) => reached.has(stair.room) && reached.has(stair.to));
  layout.rooms = kept;

  // Now and then a fake door out of a room into the unbuilt space beside it.
  for (const room of kept) {
    if (rng() >= program.fakeDoors) continue;
    const faces: InnerDoor[] = [];
    for (let i = room.rect.i0; i < room.rect.i1; i++) {
      for (let j = room.rect.j0; j < room.rect.j1; j++) {
        if (!floored(room, i, j, room.base)) continue;
        for (const dir of FACE_DIRS) {
          const [di, dj] = STEP[dir];
          if (shell.inside(i + di, j + dj, room.base) && !cells.has(cellKey(i + di, j + dj, room.base)) && !doorOn(i, j, room.base, dir)) {
            faces.push({ i, j, k: room.base, dir, state: "fake", rooms: [room.id, null] });
          }
        }
      }
    }
    if (faces.length > 0) layout.doors.push(pick(faces, rng));
  }
  return layout;

  /** Joins an unreached room to a reached one: a door between floors that meet, a gallery round a
   *  tall room with a stair up to it, or a stair through a floor - into a room over a reached one, or
   *  up out of a cellar under one. */
  function connect(room: Room): boolean {
    const reachedRooms = rooms.filter((other) => reached.has(other.id));
    // A door: a floored cell of this room beside a floored cell of a reached one, on one level.
    const doors: InnerDoor[] = [];
    for (let k = room.base; k < room.base + room.height; k++) {
      for (let i = room.rect.i0; i < room.rect.i1; i++) {
        for (let j = room.rect.j0; j < room.rect.j1; j++) {
          if (!floored(room, i, j, k)) continue;
          for (const dir of FACE_DIRS) {
            const [di, dj] = STEP[dir];
            const other = roomAt(i + di, j + dj, k);
            if (!other || other === room || !reached.has(other.id) || !floored(other, i + di, j + dj, k)) continue;
            doors.push({ i, j, k, dir, state: "open", rooms: [room.id, other.id] });
          }
        }
      }
    }
    if (doors.length > 0) {
      addDoor(pick(doors, rng));
      return true;
    }
    // A gallery: this room's floor beside the level over a reached tall room's floor.
    for (const tall of hosts(reachedRooms.filter((other) => other.height > 1 && stairWanted(other)))) {
      const k = tall.base + 1;
      if (room.base > k || room.base + room.height <= k) continue;
      const meets: { cell: [number, number]; door: InnerDoor }[] = [];
      for (let i = room.rect.i0; i < room.rect.i1; i++) {
        for (let j = room.rect.j0; j < room.rect.j1; j++) {
          if (!floored(room, i, j, k)) continue;
          for (const dir of FACE_DIRS) {
            const [di, dj] = STEP[dir];
            if (roomAt(i + di, j + dj, k) !== tall) continue;
            meets.push({ cell: [i + di, j + dj], door: { i, j, k, dir, state: "open", rooms: [room.id, tall.id] } });
          }
        }
      }
      if (meets.length === 0) continue;
      const stair = layout.stairs.find((s) => s.room === tall.id && s.to === tall.id) ?? placeStair(tall, tall.base, tall);
      if (!stair) continue;
      for (const meet of meets) {
        const path = galleryPath(tall, stair, meet.cell);
        if (!path) continue;
        for (const [i, j] of path) layout.gallery.add(cellKey(i, j, k));
        addDoor(meet.door);
        return true;
      }
    }
    // A stair up from a reached room under this one - one that asks for the stairs - or up from this
    // one, a cellar, into a reached room over it.
    for (const below of hosts(reachedRooms.filter((other) => stairWanted(other) && other.base + other.height === room.base && overlap(other.rect, room.rect) > 0))) {
      if (placeStair(below, room.base - 1, room)) return true;
    }
    if (room.base >= 0 && !stairWanted(room)) return false;
    for (const above of reachedRooms.filter((other) => other.base === room.base + room.height && overlap(other.rect, room.rect) > 0)) {
      if (placeStair(room, room.base + room.height - 1, above)) return true;
    }
    return false;
  }

  function addDoor(door: InnerDoor): void {
    layout.doors.push(door);
  }

  /**
   * A stair in `host`, rising from level `k` against one of its walls, two tiles long, to the tile
   * beyond them on the level over it - in `to` (the host itself where it is tall, onto its gallery;
   * otherwise the room over it, whose floor opens over the stair). Null where none fits.
   */
  function placeStair(host: Room, k: number, to: Room): Stair | null {
    const options: { stair: Stair; score: number }[] = [];
    const rise = shell.levels.find((level) => level.index === k + 1)!.floor - shell.levels.find((level) => level.index === k)!.floor;
    const length = rise <= shell.tile * 1.15 ? 1 : 2;
    for (const dir of FACE_DIRS) {
      const [di, dj] = STEP[dir];
      for (let i = host.rect.i0; i < host.rect.i1; i++) {
        for (let j = host.rect.j0; j < host.rect.j1; j++) {
          const run: [number, number][] = Array.from({ length }, (_, n) => [i + n * di, j + n * dj]);
          const t2: [number, number] = [i + length * di, j + length * dj];
          // A clear tile at its foot to step onto it from, on the host's own floor - and no stair
          // over another's foot.
          const foot: [number, number] = [i - di, j - dj];
          if (!floored(host, ...foot, k) || stairFeet.has(cellKey(...foot, k))) continue;
          if (!run.every(([a, b]) => floored(host, a, b, k) && !stairFeet.has(cellKey(a, b, k)))) continue;
          // Over the stair: open - the host's own level over it, or the room it rises into.
          const overOk = run.every(([a, b]) =>
            to === host ? roomAt(a, b, k + 1) === to && !layout.gallery.has(cellKey(a, b, k + 1)) : floored(to, a, b, k + 1),
          );
          if (!overOk || run.some(([a, b]) => stairFeet.has(cellKey(a, b, k + 1)))) continue;
          if (roomAt(...t2, k + 1) !== to || layout.holes.has(cellKey(...t2, k + 1))) continue;
          if (to !== host && !floored(to, ...t2, k + 1)) continue;
          // Against a wall: one side of both tiles out of the host.
          const sides: FaceDir[] = di !== 0 ? ["pz", "nz"] : ["px", "nx"];
          const wallSide = sides.find((side) => run.every(([a, b]) => !inRect(host.rect, a + STEP[side][0], b + STEP[side][1])));
          if (!wallSide) continue;
          // Not over a door, and with room to step onto it.
          const doorHere = layout.doors.some((door) => door.k === k && run.some(([a, b]) => (door.i === a && door.j === b) || (door.i + STEP[door.dir][0] === a && door.j + STEP[door.dir][1] === b)));
          if (doorHere) continue;
          options.push({ stair: { room: host.id, level: k, dir, tiles: run, arrival: t2, to: to.id, wallSide }, score: rng() });
        }
      }
    }
    if (options.length === 0) return null;
    options.sort((p, q) => q.score - p.score);
    const stair = options[0].stair;
    layout.stairs.push(stair);
    const [di, dj] = STEP[stair.dir];
    stairFeet.add(cellKey(stair.tiles[0][0] - di, stair.tiles[0][1] - dj, k));
    // Where it rises into another room, that room's floor opens over it.
    if (to !== host) for (const [a, b] of stair.tiles) layout.holes.add(cellKey(a, b, k + 1));
    // Onto a gallery: its arrival tile is the gallery's first.
    else layout.gallery.add(cellKey(...stair.arrival, k + 1));
    return stair;
  }

  /** The gallery from a stair's top to a cell of a tall room's upper level: the shortest way round,
   *  hugging its walls, never over the stair. */
  function galleryPath(tall: Room, stair: Stair, goal: [number, number]): [number, number][] | null {
    const blocked = new Set(stair.tiles.map(([a, b]) => `${a},${b}`));
    const wallCost = (i: number, j: number): number =>
      FACE_DIRS.some((dir) => !inRect(tall.rect, i + STEP[dir][0], j + STEP[dir][1])) ? 1 : 3;
    const start = stair.arrival;
    const dist = new Map<string, number>([[`${start[0]},${start[1]}`, 0]]);
    const prev = new Map<string, string>();
    const open: [number, number][] = [start];
    while (open.length > 0) {
      open.sort((p, q) => dist.get(`${p[0]},${p[1]}`)! - dist.get(`${q[0]},${q[1]}`)!);
      const [i, j] = open.shift()!;
      const key = `${i},${j}`;
      if (i === goal[0] && j === goal[1]) {
        const path: [number, number][] = [];
        let at: string | undefined = key;
        while (at) {
          const [a, b] = at.split(",").map(Number);
          path.push([a, b]);
          at = prev.get(at);
        }
        return path;
      }
      for (const dir of FACE_DIRS) {
        const n: [number, number] = [i + STEP[dir][0], j + STEP[dir][1]];
        const nKey = `${n[0]},${n[1]}`;
        if (!inRect(tall.rect, ...n) || blocked.has(nKey)) continue;
        const d = dist.get(key)! + wallCost(...n);
        if (d < (dist.get(nKey) ?? Infinity)) {
          dist.set(nKey, d);
          prev.set(nKey, key);
          open.push(n);
        }
      }
    }
    return null;
  }
}

export const opposite = (dir: FaceDir): FaceDir => (dir === "px" ? "nx" : dir === "nx" ? "px" : dir === "pz" ? "nz" : "pz");

/** The levels a request's room may start on. */
function baseLevels(request: RoomRequest, height: number, levels: number[]): number[] {
  switch (request.level) {
    case "cellar":
      return levels.filter((k) => k < 0 && k + height - 1 < 0);
    case "ground":
      return [0];
    case "upper":
      return levels.filter((k) => k >= 1);
  }
}
