// Cave mouths (DUNGEONS.md, *Entrances*): where a natural cave opens in the world - found, not made,
// on a hillside steep enough that a slip cut into it at its foot has a high back wall: the ground
// taken out over the slip (a hole, as a mausoleum's - buildings/buildingCollision.ts), a flat rock
// floor at its foot and big round boulders round its sides and in a ring at its back framing the
// way in (the cave's entrance part draws those - dungeonParts/caveMouth.json5, whose `mouth` must
// be this size). Sited from the finished ground, after everything else, keeping clear of it; the
// ground's height is not changed, only its trees and grass kept off the slip and its boulders.
import type { BuildingModel } from "../buildings/buildingTypes";
import type { BuildingGroup, Placed } from "../buildings/buildingCollision";
import { ModelBuilder } from "../buildings/buildingGeometry";
import type { TerrainSample } from "../terrain/terrainSampler";
import { deriveSeed, mulberry32 } from "../rng";
import { SEA_LEVEL } from "../cells/areaField";
import { NO_TRACE, type CellTrace, type Trace } from "../features/placementWhy";

/** The slip and how a site is chosen. */
export const CAVE_MOUTH = {
  /** The slip: across the slope, and back into it from its foot (metres). */
  width: 22,
  length: 20,
  /** How far the ground at its back must stand over its floor (its back wall), and at most. */
  rise: [10, 30] as [number, number],
  /** The hill must still rise past the slip: this much more over this far on. */
  behind: 24,
  behindRise: 3,
  /** Across its foot the ground may be this far off level: its floor is laid at the highest, never
   *  under the ground it opens onto, at worst a step down out of it. */
  footLevel: 1,
  /** The hill over the way in and the cave's first rooms, past the slip: this high over the floor at
   *  each of these distances on (8 m of rock over a chamber 14-20 m tall that starts 14 m under the
   *  floor), and to either side of the way at the furthest. */
  deepAt: [40, 70, 100],
  deepRise: 18,
  deepSide: 30,
  /** One cave a cell of this size at most, this share of them; points tried in each. */
  cell: 640,
  odds: 0.6,
  tries: 400,
  /** How far from its cell's middle a mouth may be sited, metres. */
  cellReach: 400,
  /** Its floor this far over the sea at least. */
  aboveSea: 3,
  /** Kept this far from a settlement's middle, a feature, a road (its gap), water. */
  settlementClear: 320,
  featureClear: 60,
  roadClear: 40,
  waterClear: 40,
  /** Trees and grass kept off the slip and this far round it (the boulders stand on its edges). */
  clearing: 7,
};

export interface CaveMouthSite {
  id: number;
  /** The middle of the slip's foot, at its floor's level; which way the mouth faces (out of the
   *  hill, downhill), in degrees - a dungeon's site (layout.ts, DungeonSite). */
  x: number;
  y: number;
  z: number;
  facing: number;
  /** The dungeon style under it ("cave" when not said): a mine's adit says "mine". */
  style?: string;
  /** Uphill, along the slip. */
  ux: number;
  uz: number;
}

type Sampler = (x: number, z: number) => TerrainSample;

/** A site's slip, judged at a foot point: its floor, its facing and how good it is - or null. */
function judge(sample: Sampler, x: number, z: number, t: Trace = NO_TRACE): { y: number; ux: number; uz: number; score: number } | null {
  const c = CAVE_MOUTH;
  const s = sample(x, z);
  if (!t.test("height", s.height, SEA_LEVEL + c.aboveSea, Infinity)) return null;
  if (!t.test("land", s.isLand ? 1 : 0, 1, 1)) return null;
  if (!t.test("lake", s.lakeFactor, -Infinity, 0.01)) return null;
  if (!t.test("riverGap", s.riverGap, c.waterClear, Infinity)) return null;
  if (!t.test("roadGap", s.roadGap, c.roadClear, Infinity)) return null;
  if (!t.test("featureGap", s.featureGap, c.featureClear, Infinity)) return null;
  if (!t.test("padClear", Number.isFinite(s.padGap) ? 0 : 1, 1, 1)) return null;
  const h = (px: number, pz: number): number => sample(px, pz).height;
  const gx = h(x + 8, z) - h(x - 8, z), gz = h(x, z + 8) - h(x, z - 8);
  const g = Math.hypot(gx, gz);
  if (!t.test("grade", g / 16, 0.15, Infinity)) return null;
  const ux = gx / g, uz = gz / g;
  const sx = -uz, sz = ux;
  const hw = c.width / 2;
  // Its foot, across: level enough, its floor at the highest of it.
  const foot = [-1, -0.5, 0, 0.5, 1].map((k) => (k === 0 ? s.height : h(x + sx * hw * k, z + sz * hw * k)));
  if (!t.test("footLevel", Math.max(...foot) - Math.min(...foot), -Infinity, c.footLevel)) return null;
  const floor = Math.max(...foot) + 0.05;
  if (!t.test("floorHeight", floor, SEA_LEVEL + c.aboveSea, Infinity)) return null;
  const bx = x + ux * c.length, bz = z + uz * c.length;
  const back = h(bx, bz);
  const rise = back - floor;
  if (!t.test("backRise", rise, c.rise[0], c.rise[1])) return null;
  // Its back corners about as high: the slope runs up the slip, not across it.
  const corner = Math.min(h(bx - sx * hw, bz - sz * hw), h(bx + sx * hw, bz + sz * hw)) - floor;
  if (!t.test("backCorners", corner, c.rise[0] * 0.7, Infinity)) return null;
  // Still rising behind: rock over the way in, and over where the cave goes on from it.
  if (!t.test("risingBehind", h(x + ux * (c.length + c.behind), z + uz * (c.length + c.behind)) - back, c.behindRise, Infinity)) return null;
  let deep = Infinity;
  for (const d of c.deepAt) deep = Math.min(deep, h(x + ux * (c.length + d), z + uz * (c.length + d)) - floor);
  if (!t.test("rockOver", deep, c.deepRise, Infinity)) return null;
  const far = c.length + c.deepAt[c.deepAt.length - 1];
  let side = Infinity;
  for (const k of [-1, 1]) side = Math.min(side, h(x + ux * far + sx * k * c.deepSide, z + uz * far + sz * k * c.deepSide) - floor);
  if (!t.test("rockBeside", side, c.deepRise, Infinity)) return null;
  // Its ground and the boulders' dry and clear.
  let wet = 0, nearRoad = Infinity, padded = 0;
  for (const [px, pz] of [[bx, bz], [x - sx * hw, z - sz * hw], [x + sx * hw, z + sz * hw]]) {
    const q = sample(px, pz);
    if (!q.isLand || q.lakeFactor > 0.01) wet = 1;
    nearRoad = Math.min(nearRoad, q.roadGap);
    if (Number.isFinite(q.padGap)) padded = 1;
  }
  if (!t.test("edgesDry", wet, -Infinity, 0)) return null;
  if (!t.test("edgesRoadGap", nearRoad, c.roadClear, Infinity)) return null;
  if (!t.test("edgesPadClear", padded, -Infinity, 0)) return null;
  // Best where the back wall is high for its length but not a cliff: about 0.8 of a rise to a run.
  const score = -Math.abs(rise / c.length - 0.8);
  return { y: floor, ux, uz, score };
}

/**
 * Whether a walker could reach a mouth from the open ground (E6, the round-about for bad sites): from
 * a point in front of its slip's foot, over land (no water) by steps of `APPROACH_STEP` no steeper
 * than `APPROACH_SLOPE`, the walk reaches `APPROACH_OUT` from the mouth - not shut in by cliffs, a
 * gully or water. Judged on the finished ground.
 */
const APPROACH_STEP = 4;
const APPROACH_SLOPE = 0.75;
const APPROACH_OUT = 70;
function approachable(sample: Sampler, x: number, z: number, ux: number, uz: number): boolean {
  const key = (i: number, j: number): string => `${i},${j}`;
  const sx = x - ux * 9, sz = z - uz * 9;
  const start = sample(sx, sz);
  if (!start.isLand || start.lakeFactor > 0.01) return false;
  const seen = new Set([key(0, 0)]);
  const queue: [number, number, number][] = [[0, 0, start.height]];
  for (let q = 0; q < queue.length && q < 2500; q++) {
    const [i, j, h] = queue[q];
    if (Math.hypot(sx + i * APPROACH_STEP - x, sz + j * APPROACH_STEP - z) >= APPROACH_OUT) return true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(i + di, j + dj);
      if (seen.has(k)) continue;
      seen.add(k);
      const t = sample(sx + (i + di) * APPROACH_STEP, sz + (j + dj) * APPROACH_STEP);
      if (!t.isLand || t.lakeFactor > 0.01 || Math.abs(t.height - h) / APPROACH_STEP > APPROACH_SLOPE) continue;
      queue.push([i + di, j + dj, t.height]);
    }
  }
  return false;
}

/** A mouth judged at a foot point for a feature that carries one (a mine's adit, features/mine.json5):
 *  the same ground a cave mouth needs, or null. */
export function mouthAt(sample: Sampler, x: number, z: number, trace: Trace = NO_TRACE): (CaveMouthSite & { score: number }) | null {
  const j = judge(sample, x, z, trace);
  if (!j) return null;
  return { id: 0, x, y: j.y, z, facing: (Math.atan2(-j.ux, -j.uz) * 180) / Math.PI, ux: j.ux, uz: j.uz, score: j.score };
}

/** Whether a walker can reach a mouth from open ground. */
export function mouthApproachable(sample: Sampler, m: CaveMouthSite): boolean {
  return approachable(sample, m.x, m.z, m.ux, m.uz);
}

/**
 * The cave mouths of the cells that rolled a `cave` feature (features/caveMouth.json5): one in each, on the
 * best ground in the cell that suits (`judge`) and that a walker can reach (`approachable`) - a cell with
 * no such ground gets none, as any feature. A mouth is valid by construction: level foot, a high back wall,
 * rock behind, dry, off the roads, a way in from open ground.
 */
export function siteCaveMouths(seed: number, worldExtent: number, sample: Sampler, settlements: readonly { x: number; z: number }[], cells: readonly { x: number; z: number }[], traces?: readonly CellTrace[]): CaveMouthSite[] {
  const c = CAVE_MOUTH;
  const out: CaveMouthSite[] = [];
  cells.forEach((cell, n) => {
    const random = mulberry32(deriveSeed(seed, 0x6ca7e + n * 8191));
    const found: (CaveMouthSite & { score: number })[] = [];
    const trace = traces?.[n] ?? NO_TRACE;
    for (let t = 0; t < c.tries; t++) {
      // Inside the cell, off its edges so a mouth never stands close to another cell's feature.
      const a = random() * Math.PI * 2, r = Math.sqrt(random()) * c.cellReach;
      const x = cell.x + Math.cos(a) * r, z = cell.z + Math.sin(a) * r;
      traces?.[n].begin();
      if (!trace.test("worldEdge", Math.max(Math.abs(x), Math.abs(z)), -Infinity, worldExtent * 0.95)) continue;
      let settlementGap = Infinity;
      for (const s of settlements) settlementGap = Math.min(settlementGap, Math.hypot(s.x - x, s.z - z));
      if (!trace.test("settlementGap", settlementGap, c.settlementClear, Infinity)) continue;
      const j = judge(sample, x, z, trace);
      if (!j) continue;
      found.push({ id: 0, x, y: j.y, z, facing: (Math.atan2(-j.ux, -j.uz) * 180) / Math.PI, ux: j.ux, uz: j.uz, score: j.score });
    }
    // The best that a walker can reach; the next best when it cannot, and none if none can.
    const best = found.sort((p, q) => q.score - p.score).find((m) => trace.test("approach", approachable(sample, m.x, m.z, m.ux, m.uz) ? 1 : 0, 1, 1)) ?? null;
    if (best) {
      if (traces) traces[n].placed = true;
      const { score: _score, ...site } = best;
      out.push({ ...site, id: out.length });
    }
  });
  return out;
}

/** How far a point is outside a mouth's slip, along it and across it (0 inside). */
function slipGap(m: CaveMouthSite, x: number, z: number): number {
  const c = CAVE_MOUTH;
  const dx = x - m.x, dz = z - m.z;
  const along = dx * m.ux + dz * m.uz;
  const across = Math.abs(-dx * m.uz + dz * m.ux);
  const a = Math.max(0, -along, along - c.length);
  const b = Math.max(0, across - c.width / 2);
  return Math.hypot(a, b);
}

/** How far a point is from the nearest mouth's slip less its clearing - negative on it, for the
 *  ground's pad gap (trees and grass keep off) - or Infinity with none near. */
export function caveMouthClearance(mouths: readonly CaveMouthSite[]): (x: number, z: number) => number {
  const CELL = 64;
  const grid = new Map<string, CaveMouthSite[]>();
  const reach = Math.hypot(CAVE_MOUTH.width, CAVE_MOUTH.length) + CAVE_MOUTH.clearing + 4;
  for (const m of mouths) {
    const cx = m.x + m.ux * (CAVE_MOUTH.length / 2), cz = m.z + m.uz * (CAVE_MOUTH.length / 2);
    for (let gx = Math.floor((cx - reach) / CELL); gx <= Math.floor((cx + reach) / CELL); gx++) {
      for (let gz = Math.floor((cz - reach) / CELL); gz <= Math.floor((cz + reach) / CELL); gz++) {
        const key = `${gx},${gz}`;
        const list = grid.get(key);
        if (list) list.push(m);
        else grid.set(key, [m]);
      }
    }
  }
  return (x, z) => {
    const near = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!near) return Infinity;
    let best = Infinity;
    for (const m of near) best = Math.min(best, slipGap(m, x, z) - CAVE_MOUTH.clearing);
    return best;
  };
}

/** The ground taken out over a mouth's slip: a "house" with nothing to draw and nothing in the way,
 *  only a hole, set over the slip's middle, its front out of the hill. */
function holeModel(): BuildingModel {
  const c = CAVE_MOUTH;
  const model = new ModelBuilder().finish({ x: 0, z: c.length / 2 });
  model.halfWidth = c.width / 2;
  model.halfDepth = c.length / 2;
  model.height = 0;
  model.holes = [[-c.width / 2, -c.length / 2, c.width / 2, c.length / 2]];
  return model;
}

/** The mouths' holes in the ground, a group each (so their cuts come and go with them). */
export function caveMouthGroups(mouths: readonly CaveMouthSite[]): BuildingGroup[] {
  const model = holeModel();
  return mouths.map((m) => {
    const x = m.x + m.ux * (CAVE_MOUTH.length / 2), z = m.z + m.uz * (CAVE_MOUTH.length / 2);
    const house: Placed = { x, y: m.y, z, frontX: -m.ux, frontZ: -m.uz, model: () => model };
    return { key: `caveMouth:${m.id}`, x, z, houses: [house] };
  });
}
