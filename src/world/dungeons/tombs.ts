// Tombs standing free in a room (DUNGEONS.md, *What fills it*): where a part's sarcophagi go,
// worked out from its own colliders and walk lines when it is read - on open floor, clear of the
// ways through it, of its walls and of what else stands at its spots - so they are part of its
// colliders like any wall, and the way through is measured past them.

import { quatFromEuler, rotate, vec3, type ShapeDesc, type Vec3 } from "../collision/index";
import type { Polyline } from "./kitShapes";

/** A tomb's size: long, wide, high (to the top of its lid). */
export const TOMB_SIZE: [number, number, number] = [3.4, 1.5, 1.4];

/** Kept this far from a walk line, from anything standing (a wall, a pillar), from a spot, and from each other. */
const CLEAR_OF_WAYS = 3;
const CLEAR_OF_WALLS = 2;
const CLEAR_OF_SPOTS = 2;
const CLEAR_OF_TOMBS = 2.5;

/** A tomb: its floor's middle, and which way its length runs (0: along z, 90: along x). */
export interface TombDef {
  at: Vec3;
  yaw: 0 | 90;
}

type Box = { min: [number, number, number]; max: [number, number, number] };

/**
 * Up to `count` tombs for a part: on a 0.5 m grid over its plan, wherever a tomb's footprint lies on
 * one floor with headroom over it, clear of all the rest - then, of those, the ones farthest from
 * the ways and from each other, so they stand out in the room rather than crowd its edges. Their
 * length along the part's longer side. Only its boxes count (a room is built of them).
 */
export function placeTombs(shapes: readonly ShapeDesc[], paths: readonly Polyline[], spots: Record<string, Vec3[]>, count: number): TombDef[] {
  if (count <= 0) return [];
  const boxes: Box[] = [];
  for (const s of shapes) {
    if (s.kind !== "box" || s.rotation) continue;
    boxes.push({ min: [s.center.x - s.half.x, s.center.y - s.half.y, s.center.z - s.half.z], max: [s.center.x + s.half.x, s.center.y + s.half.y, s.center.z + s.half.z] });
  }
  if (boxes.length === 0) return [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.min[0]); x1 = Math.max(x1, b.max[0]);
    z0 = Math.min(z0, b.min[2]); z1 = Math.max(z1, b.max[2]);
  }
  const yaw: 0 | 90 = x1 - x0 > z1 - z0 ? 90 : 0;
  const [len, wid, high] = TOMB_SIZE;
  const hx = (yaw === 90 ? len : wid) / 2, hz = (yaw === 90 ? wid : len) / 2;
  const inBox = (b: Box, x: number, y: number, z: number) => x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2];
  /** The floor under (x, z) with room over it to stand a tomb, the lowest such. */
  const floorAt = (x: number, z: number): number | null => {
    const tops = boxes.filter((b) => x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2]).map((b) => b.max[1]).sort((p, q) => p - q);
    for (const y of tops) if (!boxes.some((b) => inBox(b, x, y + 0.1, z) || inBox(b, x, y + high + 1, z))) return y;
    return null;
  };
  const ways: [Vec3, Vec3][] = paths.flatMap((line) => line.slice(1).map((q, i): [Vec3, Vec3] => [line[i], q]));
  const toWay = (p: Vec3): number => Math.min(Infinity, ...ways.map(([a, b]) => distanceToSegment(p, a, b)));
  const allSpots = Object.values(spots).flat();
  type Candidate = { at: Vec3; way: number };
  const candidates: Candidate[] = [];
  for (let x = x0 + hx; x <= x1 - hx; x += 0.5) {
    for (let z = z0 + hz; z <= z1 - hz; z += 0.5) {
      const y = floorAt(x, z);
      if (y === null) continue;
      // The whole footprint on that floor, its edges included.
      if (![[x - hx, z - hz], [x + hx, z - hz], [x + hx, z + hz], [x - hx, z + hz]].every(([cx, cz]) => floorAt(cx, cz) === y)) continue;
      // Nothing standing within reach of it, from the floor to over its lid.
      const g = CLEAR_OF_WALLS;
      if (boxes.some((b) => b.max[0] > x - hx - g && b.min[0] < x + hx + g && b.max[2] > z - hz - g && b.min[2] < z + hz + g && b.max[1] > y + 0.05 && b.min[1] < y + high + 0.5)) continue;
      const at = vec3(x, y, z);
      const way = toWay(at) - Math.hypot(hx, hz);
      if (way < CLEAR_OF_WAYS) continue;
      if (allSpots.some((s) => Math.abs(s.y - y) < 4 && Math.hypot(s.x - x, s.z - z) < Math.hypot(hx, hz) + CLEAR_OF_SPOTS)) continue;
      candidates.push({ at, way });
    }
  }
  // The farthest from the ways first, then each next the farthest from the ways and those chosen.
  const chosen: TombDef[] = [];
  while (chosen.length < count) {
    let best: Candidate | null = null, bestScore = -Infinity;
    for (const c of candidates) {
      const apart = Math.min(Infinity, ...chosen.map((t) => Math.hypot(t.at.x - c.at.x, t.at.z - c.at.z)));
      if (apart < 2 * Math.max(hx, hz) + CLEAR_OF_TOMBS) continue;
      const score = Math.min(c.way, apart / 2);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) break;
    chosen.push({ at: best.at, yaw });
  }
  return chosen;
}

/** A tomb's collider: a box from its floor to the top of its lid. */
/** An altar's room (the style's altar prop drawn in it): across it, high, and deep from the wall. */
export const ALTAR_SIZE: [number, number, number] = [3.8, 2.2, 2.0];

/** An altar against a wall: `at` on the wall's face at the floor, facing out of it (0, 90, 180 or 270 degrees). */
export interface AltarDef {
  at: Vec3;
  facing: number;
}

/** The box an altar collides as: its back on the wall, its middle on `at`. */
export function altarBox(a: AltarDef): { min: [number, number, number]; max: [number, number, number] } {
  const [wid, high, deep] = ALTAR_SIZE;
  const r = (a.facing * Math.PI) / 180, fx = Math.round(Math.sin(r)), fz = Math.round(Math.cos(r));
  const cx = a.at.x + (fx * deep) / 2, cz = a.at.z + (fz * deep) / 2;
  const hx = fx !== 0 ? deep / 2 : wid / 2, hz = fx !== 0 ? wid / 2 : deep / 2;
  return { min: [cx - hx, a.at.y, cz - hz], max: [cx + hx, a.at.y + high, cz + hz] };
}

export function altarShape(a: AltarDef): ShapeDesc {
  const { min, max } = altarBox(a);
  return { kind: "box", center: vec3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2), half: vec3((max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2) };
}

export function tombShape(t: TombDef): ShapeDesc {
  const [len, wid, high] = TOMB_SIZE;
  const hx = (t.yaw === 90 ? len : wid) / 2, hz = (t.yaw === 90 ? wid : len) / 2;
  return { kind: "box", center: vec3(t.at.x, t.at.y + high / 2, t.at.z), half: vec3(hx, high / 2, hz) };
}

function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  const l = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
  const k = Math.max(0, Math.min(1, ((p.x - a.x) * d[0] + (p.y - a.y) * d[1] + (p.z - a.z) * d[2]) / l));
  return Math.hypot(p.x - a.x - d[0] * k, p.y - a.y - d[1] * k, p.z - a.z - d[2] * k);
}

/** A ledger stone's size before each is made a little different: long, wide, high (a stair's step). */
export const LEDGER_SIZE: [number, number, number] = [2.8, 1.4, 0.2];

/** Between ledger stones end to end and side by side; kept this far from anything standing on the
 *  floor (a wall, a pillar, a tomb) and from a spot. */
const LEDGER_GAP = 0.6;
const LEDGER_CLEAR = 1;
/** The share of a begun row's places that hold a stone. */
const LEDGER_TAKEN = 0.8;
/** Kept this far from a socket (the floor in a doorway stays the floor). */
const CLEAR_OF_DOORS = 2.5;

/** How much each ledger stone differs from the next: its length and width up or down by this share,
 *  its height by this, its middle off its place by up to this far, and turned by up to this many degrees. */
const LEDGER_SIZE_SPREAD = 0.15;
const LEDGER_HEIGHT_SPREAD = 0.5;
const LEDGER_SHIFT = 0.25;
const LEDGER_TURN = 3;

/** A ledger stone: its floor's middle, its half length and width along x and z before it is turned,
 *  how far it is turned about the upright (radians), and how high it stands. */
export interface LedgerDef {
  at: Vec3;
  half: [number, number];
  turn: number;
  high: number;
}

/** A ledger stone's corners in plan, `inset` in from its edges, round it. */
export function ledgerCorners(t: LedgerDef, inset = 0): [number, number][] {
  const q = quatFromEuler(t.turn);
  const [hx, hz] = [t.half[0] - inset, t.half[1] - inset];
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]): [number, number] => {
    const r = rotate(q, vec3(x, 0, z));
    return [t.at.x + r.x, t.at.z + r.z];
  });
}

/**
 * Ledger stones for a part: places on a grid centred on its plan, each stone's length along the
 * part's longer side; rows of graves side by side across it, a `share` of the rows begun and most of
 * a begun row's places taken - each stone a little longer or shorter, wider or narrower, off its
 * place and turned a hair, as laid by hand - where the whole stone lies on one floor with headroom
 * over it, clear of whatever stands on it (its tombs among them), of its spots and of its doorways
 * (`doors`, its sockets). The same every time it is read.
 */
export function placeLedgers(shapes: readonly ShapeDesc[], spots: Record<string, Vec3[]>, doors: readonly Vec3[], share: number): LedgerDef[] {
  if (share <= 0) return [];
  const boxes: Box[] = [];
  for (const s of shapes) {
    if (s.kind !== "box" || s.rotation) continue;
    boxes.push({ min: [s.center.x - s.half.x, s.center.y - s.half.y, s.center.z - s.half.z], max: [s.center.x + s.half.x, s.center.y + s.half.y, s.center.z + s.half.z] });
  }
  if (boxes.length === 0) return [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.min[0]); x1 = Math.max(x1, b.max[0]);
    z0 = Math.min(z0, b.min[2]); z1 = Math.max(z1, b.max[2]);
  }
  const alongX = x1 - x0 > z1 - z0;
  const [len, wid] = LEDGER_SIZE;
  const hx = (alongX ? len : wid) / 2, hz = (alongX ? wid : len) / 2;
  const px = 2 * hx + LEDGER_GAP, pz = 2 * hz + LEDGER_GAP;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const nx = Math.floor((x1 - x0) / 2 / px), nz = Math.floor((z1 - z0) / 2 / pz);
  const inBox = (b: Box, x: number, y: number, z: number) => x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2];
  /** The floor under (x, z) with headroom over it, the lowest such. */
  const floorAt = (x: number, z: number): number | null => {
    const tops = boxes.filter((b) => x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2]).map((b) => b.max[1]).sort((p, q) => p - q);
    for (const y of tops) if (!boxes.some((b) => inBox(b, x, y + 0.1, z) || inBox(b, x, y + 2.5, z))) return y;
    return null;
  };
  const allSpots = Object.values(spots).flat();
  /** Between -1 and 1 for a place, the same every time. */
  const spread = (x: number, z: number, salt: number) => 2 * hash(x, z, salt) - 1;
  const chosen: LedgerDef[] = [];
  for (let i = -nx; i <= nx; i++) {
    for (let k = -nz; k <= nz; k++) {
      const gx = mx + i * px, gz = mz + k * pz;
      // Rows of graves side by side: across the length.
      if (hash(alongX ? gx : mx, alongX ? mz : gz, 0) >= share || hash(gx, gz, 1) >= LEDGER_TAKEN) continue;
      // This stone as laid: its size, its middle, its turn.
      const l = 1 + LEDGER_SIZE_SPREAD * spread(gx, gz, 2), w = 1 + LEDGER_SIZE_SPREAD * spread(gx, gz, 3);
      const half: [number, number] = alongX ? [hx * l, hz * w] : [hx * w, hz * l];
      const x = gx + LEDGER_SHIFT * spread(gx, gz, 4), z = gz + LEDGER_SHIFT * spread(gx, gz, 5);
      const turn = ((LEDGER_TURN * Math.PI) / 180) * spread(gx, gz, 6);
      const y = floorAt(x, z);
      if (y === null) continue;
      const high = LEDGER_SIZE[2] * (1 + LEDGER_HEIGHT_SPREAD * spread(gx, gz, 7));
      const stone: LedgerDef = { at: vec3(x, y, z), half, turn, high };
      // The whole stone on that floor (each corner a hair inside).
      const corners = ledgerCorners(stone, 0.02);
      if (!corners.every(([cx, cz]) => floorAt(cx, cz) === y)) continue;
      // Its plan's reach, turned.
      const ex = Math.max(...corners.map(([cx]) => Math.abs(cx - x))), ez = Math.max(...corners.map(([, cz]) => Math.abs(cz - z)));
      const g = LEDGER_CLEAR;
      if (boxes.some((b) => b.max[0] > x - ex - g && b.min[0] < x + ex + g && b.max[2] > z - ez - g && b.min[2] < z + ez + g && b.max[1] > y + 0.05 && b.min[1] < y + 2)) continue;
      if (allSpots.some((s) => Math.abs(s.y - y) < 2 && Math.abs(s.x - x) < ex + g && Math.abs(s.z - z) < ez + g)) continue;
      // Off the doorways: the opening is measured from the floor, its height to the lintel.
      if (doors.some((s) => Math.abs(s.y - y) < 2 && Math.abs(s.x - x) < ex + CLEAR_OF_DOORS && Math.abs(s.z - z) < ez + CLEAR_OF_DOORS)) continue;
      chosen.push(stone);
    }
  }
  return chosen;
}

/** A ledger stone's collider: a box from its floor to its top, turned as it lies. */
/**
 * What a ledger stone collides as: the stone with its top's edges sloped off at 45 degrees, as wide
 * as it is high - so a body walks up onto it at any slant, never stalling against a square edge a
 * step high (it is drawn square, with its own small bevel).
 */
export function ledgerShape(t: LedgerDef): ShapeDesc {
  const ring = (y: number, inset: number): Vec3[] => ledgerCorners(t, inset).map(([x, z]) => vec3(x, t.at.y + y, z));
  return { kind: "convex", points: [...ring(-0.02, 0), ...ring(t.high, Math.min(t.high, Math.min(...t.half) - 0.05))] };
}

/** A number in [0, 1) for a place, the same every time. */
function hash(x: number, z: number, salt: number): number {
  const h = Math.sin(x * 12.9898 + z * 37.719 + salt * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/** A stone bench's size: long, deep (out of the wall), high (its seat's top, a plinth's height). */
export const BENCH_SIZE: [number, number, number] = [4, 0.9, 0.75];
/** Kept this far from anything else standing on the floor, past its ends and in front of it; this far
 *  from a walk line; and this far past a doorway's opening. */
const BENCH_CLEAR = 1.5;
const BENCH_CLEAR_OF_WAYS = 1.5;
const BENCH_CLEAR_OF_DOORS = 2;

/** A stone bench against a wall: its floor's middle, and which way it faces out of the wall (along x or z). */
export interface BenchDef {
  at: Vec3;
  out: [number, number];
}

/** A bench's plan in the room's frame: its middle, and its half reach along x and z. */
function benchPlan(b: BenchDef): { x: number; z: number; hx: number; hz: number } {
  const [len, deep] = BENCH_SIZE;
  const alongZ = b.out[0] !== 0;
  return { x: b.at.x, z: b.at.z, hx: (alongZ ? deep : len) / 2, hz: (alongZ ? len : deep) / 2 };
}

/**
 * Up to `count` stone benches for a part, each with its back to a wall: along every stretch of wall
 * that rises from a floor and runs on long enough, the free stretches of it - floor under the whole
 * bench, the wall behind all of it, nothing else standing near it (a corner, a pillar, a tomb), clear
 * of the ways through, of the doorways (`doors`, its sockets) and of the spots on its floor - each
 * holding a bench in its middle, the longest stretches first. Only its boxes count.
 */
export function placeBenches(shapes: readonly ShapeDesc[], paths: readonly Polyline[], spots: Record<string, Vec3[]>, doors: readonly { at: Vec3; size: [number, number] }[], count: number): BenchDef[] {
  if (count <= 0) return [];
  const boxes: Box[] = [];
  for (const s of shapes) {
    if (s.kind !== "box" || s.rotation) continue;
    boxes.push({ min: [s.center.x - s.half.x, s.center.y - s.half.y, s.center.z - s.half.z], max: [s.center.x + s.half.x, s.center.y + s.half.y, s.center.z + s.half.z] });
  }
  if (boxes.length === 0) return [];
  const [len, deep] = BENCH_SIZE;
  const inBox = (b: Box, x: number, y: number, z: number) => x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2];
  const solid = (x: number, y: number, z: number) => boxes.some((b) => inBox(b, x, y, z));
  /** The floor under (x, z) with headroom over it, the lowest such. */
  const floorAt = (x: number, z: number): number | null => {
    const tops = boxes.filter((b) => x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2]).map((b) => b.max[1]).sort((p, q) => p - q);
    for (const y of tops) if (!solid(x, y + 0.1, z) && !solid(x, y + 2.5, z)) return y;
    return null;
  };
  const ways: [Vec3, Vec3][] = paths.flatMap((line) => line.slice(1).map((q, i): [Vec3, Vec3] => [line[i], q]));
  const toWay = (p: Vec3): number => Math.min(Infinity, ...ways.map(([a, b]) => distanceToSegment(p, a, b)));
  const floorSpots = Object.entries(spots).filter(([key]) => key !== "light").flatMap(([, list]) => list);
  // The walls' planes: every upright side of every box, those in one plane together.
  const planes = new Map<string, { axis: 0 | 2; at: number; sign: number; lo: number; hi: number }>();
  for (const b of boxes) {
    for (const axis of [0, 2] as const) {
      const other = axis === 0 ? 2 : 0;
      for (const sign of [-1, 1]) {
        const at = sign < 0 ? b.min[axis] : b.max[axis];
        const key = `${axis}:${sign}:${at.toFixed(3)}`;
        const known = planes.get(key);
        if (known) { known.lo = Math.min(known.lo, b.min[other]); known.hi = Math.max(known.hi, b.max[other]); }
        else planes.set(key, { axis, at, sign, lo: b.min[other], hi: b.max[other] });
      }
    }
  }
  type Candidate = { bench: BenchDef; free: number };
  const candidates: Candidate[] = [];
  const STEP = 0.25;
  for (const plane of planes.values()) {
    if (plane.hi - plane.lo < len) continue;
    /** A point `u` along the wall, `v` out of it. */
    const at = (u: number, v: number): [number, number] => (plane.axis === 0 ? [plane.at + plane.sign * v, u] : [u, plane.at + plane.sign * v]);
    const out: [number, number] = plane.axis === 0 ? [plane.sign, 0] : [0, plane.sign];
    // Each free stretch: where its bench may stand from first to last; the bench in its very middle
    // (so a pair either side of a room's middle stands even), or the nearest that fits.
    let run: { u: number; bench: BenchDef }[] = [];
    const close = () => {
      if (run.length > 0) candidates.push({ bench: fits((run[0].u + run[run.length - 1].u) / 2) ?? run[Math.floor(run.length / 2)].bench, free: run.length * STEP });
      run = [];
    };
    for (let u = plane.lo + len / 2; u <= plane.hi - len / 2 + 1e-6; u += STEP) {
      const bench = fits(u);
      if (bench) run.push({ u, bench });
      else close();
    }
    close();

    function fits(u: number): BenchDef | null {
      const [x, z] = at(u, deep / 2);
      const y = floorAt(x, z);
      if (y === null) return null;
      // The whole bench on that floor, and the wall behind all of it, from the floor up.
      for (const [du, dv] of [[-1, 0.02], [1, 0.02], [-1, deep - 0.02], [1, deep - 0.02]]) {
        const [cx, cz] = at(u + du * (len / 2 - 0.02), dv);
        if (floorAt(cx, cz) !== y) return null;
      }
      for (let k = 0; k <= 8; k++) {
        const [wx, wz] = at(u - len / 2 + 0.05 + (k * (len - 0.1)) / 8, -0.05);
        if (!solid(wx, y + 0.4, wz) || !solid(wx, y + 2.5, wz)) return null;
      }
      // Nothing standing beside it or in front of it.
      const g = BENCH_CLEAR;
      const [ax, az] = at(u - len / 2 - g, 0.01), [bx, bz] = at(u + len / 2 + g, deep + g);
      const lo = [Math.min(ax, bx), Math.min(az, bz)], hi = [Math.max(ax, bx), Math.max(az, bz)];
      if (boxes.some((b) => b.max[0] > lo[0] && b.min[0] < hi[0] && b.max[2] > lo[1] && b.min[2] < hi[1] && b.max[1] > y + 0.05 && b.min[1] < y + 2)) return null;
      // Off the ways, the doorways and the spots.
      const edge: Vec3[] = [];
      for (let k = 0; k <= 8; k++) for (const v of [0, deep]) { const [ex, ez] = at(u - len / 2 + (k * len) / 8, v); edge.push(vec3(ex, y, ez)); }
      if (edge.some((q) => toWay(q) < BENCH_CLEAR_OF_WAYS)) return null;
      if (doors.some((d) => Math.abs(d.at.y - y) < 2 && edge.some((q) => Math.hypot(q.x - d.at.x, q.z - d.at.z) < d.size[0] / 2 + BENCH_CLEAR_OF_DOORS))) return null;
      if (floorSpots.some((sp) => Math.abs(sp.y - y) < 2 && sp.x > lo[0] && sp.x < hi[0] && sp.z > lo[1] && sp.z < hi[1])) return null;
      return { at: vec3(x, y, z), out };
    }
  }
  // The longest free stretches first, each bench clear of those chosen.
  candidates.sort((a, b) => b.free - a.free);
  const chosen: BenchDef[] = [];
  for (const { bench } of candidates) {
    if (chosen.length >= count) break;
    const p = benchPlan(bench);
    const g = BENCH_CLEAR;
    if (chosen.some((c) => { const q = benchPlan(c); return Math.abs(c.at.y - bench.at.y) < 2 && Math.abs(q.x - p.x) < q.hx + p.hx + g && Math.abs(q.z - p.z) < q.hz + p.hz + g; })) continue;
    chosen.push(bench);
  }
  return chosen;
}

/** A bench's collider: a box from its floor to its seat's top, its back against the wall. */
export function benchShape(b: BenchDef): ShapeDesc {
  const p = benchPlan(b);
  const high = BENCH_SIZE[2];
  return { kind: "box", center: vec3(p.x, b.at.y + high / 2, p.z), half: vec3(p.hx, high / 2, p.hz) };
}
