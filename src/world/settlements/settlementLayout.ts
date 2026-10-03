import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSample, TerrainSampler } from "../terrain/terrainSampler";
import type { RoadLine } from "../roads/roadField";
import type { RoadLink } from "../roads/roadNetwork";
import { ROAD_HALF_WIDTH, ROAD_MAX_LAKE_FACTOR, ROAD_MIN_HEIGHT } from "../roads/roadConfig";
import { chaikin } from "../polyline";
import { deriveSeed, mulberry32 } from "../rng";
import type { SettlementSite } from "./settlementSites";
import { chooseGate, type SettlementGate } from "./gates";
import type { BuildingDef } from "../buildings/buildingTypes";
import { generateBuilding } from "../buildings/buildingGenerator";

/** A house's variant of its building is drawn from this many - enough that no two in a town share
 *  one by more than chance. */
const BUILDING_VARIANT_SPACE = 1 << 20;
import {
  HOUSE_FLOOR_ABOVE_STREET,
  HOUSE_MAX_CUT_FILL,
  LAYOUT_SAMPLE_GRID,
  MAIN_STREET_WIDTH,
  SETTLEMENT_LAYOUT_SALT,
  SIDE_STREET_CLEARANCE,
  SIDE_STREET_SPACING,
  SIDE_STREET_WIDTH,
  STREET_EASY_GRADE,
  STREET_GATE_STRAIGHT,
  STREET_GRADE_WEIGHT,
  STREET_GRID,
  STREET_JOIN_BLEND,
  STREET_JOIN_MAX_GRADE,
  STREET_MAX_GRADE,
  STREET_PROFILE_MAX_GRADE,
  STREET_PROFILE_SMOOTH_REACH,
  STREET_STRAIGHT_MAX_GRADE,
} from "./settlementConfig";

/** A settlement street: a road line (graded and painted like any road, narrower) plus what it is. */
export interface Street extends RoadLine {
  kind: "main" | "side";
  widthScale: number;
  taperEnds: false;
}

/** A house plot with the house on it: one variant of a building (buildings/), its footprint width
 *  (along the street) x depth. */
export interface House {
  x: number;
  z: number;
  /** Floor level - the ground under the footprint is brought to this. */
  y: number;
  /** Unit vector from the house's centre toward its street: the front, where the door is. */
  frontX: number;
  frontZ: number;
  width: number;
  depth: number;
  building: BuildingDef;
  variant: number;
}

export interface SettlementSquare {
  x: number;
  z: number;
  radius: number;
  y: number;
}

export interface SettlementLayout {
  siteId: number;
  /** The SettlementStyle its buildings are drawn in. */
  styleId: string;
  x: number;
  z: number;
  radius: number;
  gates: SettlementGate[];
  square: SettlementSquare;
  streets: Street[];
  houses: House[];
}

// ------------------------------------------------------------------------------------------------
// Ground

interface Ground {
  sample: (x: number, z: number) => TerrainSample;
  height: (x: number, z: number) => number;
}

/** Terrain samples on a LAYOUT_SAMPLE_GRID lattice, cached: street routing, side streets and house plots
 *  all probe the same few thousand spots around one settlement over and over. Heights between
 *  lattice points are interpolated. */
function createGround(sampleTerrain: TerrainSampler): Ground {
  const cache = new Map<number, TerrainSample>();
  const at = (gx: number, gz: number): TerrainSample => {
    const key = (gx + 32768) * 65536 + (gz + 32768);
    let sample = cache.get(key);
    if (!sample) {
      sample = sampleTerrain(gx * LAYOUT_SAMPLE_GRID, gz * LAYOUT_SAMPLE_GRID);
      cache.set(key, sample);
    }
    return sample;
  };
  return {
    sample: (x, z) => at(Math.round(x / LAYOUT_SAMPLE_GRID), Math.round(z / LAYOUT_SAMPLE_GRID)),
    height(x, z) {
      const fx = x / LAYOUT_SAMPLE_GRID;
      const fz = z / LAYOUT_SAMPLE_GRID;
      const gx = Math.floor(fx);
      const gz = Math.floor(fz);
      const u = fx - gx;
      const v = fz - gz;
      const h00 = at(gx, gz).height;
      const h10 = at(gx + 1, gz).height;
      const h01 = at(gx, gz + 1).height;
      const h11 = at(gx + 1, gz + 1).height;
      return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
    },
  };
}

function buildable(sample: TerrainSample, riverClearance: number): boolean {
  return sample.isLand && sample.height >= ROAD_MIN_HEIGHT && sample.lakeFactor <= ROAD_MAX_LAKE_FACTOR && sample.riverGap > riverClearance;
}

// ------------------------------------------------------------------------------------------------
// Geometry helpers

function distanceToPolyline(x: number, z: number, points: CellPoint[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const u = lengthSq > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0;
    best = Math.min(best, Math.hypot(a.x + u * dx - x, a.z + u * dz - z));
  }
  return best;
}

/** Points every `step` along a polyline, both ends kept. */
function resample(points: CellPoint[], step: number): CellPoint[] {
  const out: CellPoint[] = [points[0]];
  let carried = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    let at = step - carried;
    while (at < length) {
      out.push({ x: a.x + ((b.x - a.x) * at) / length, z: a.z + ((b.z - a.z) * at) / length });
      at += step;
    }
    carried = length - (at - step);
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) < step * 0.4 && out.length > 1) out[out.length - 1] = last;
  else out.push(last);
  return out;
}

function arcLengths(points: CellPoint[]): number[] {
  const arcs = [0];
  for (let i = 1; i < points.length; i++) {
    arcs.push(arcs[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  return arcs;
}

/** The point, unit tangent and height at arc length `s` along a street. */
function pointAt(street: Street, arcs: number[], s: number): { x: number; z: number; tx: number; tz: number; y: number } {
  const points = street.points;
  let i = 0;
  while (i < arcs.length - 2 && arcs[i + 1] < s) i++;
  const a = points[i];
  const b = points[i + 1];
  const span = arcs[i + 1] - arcs[i] || 1;
  const u = Math.min(1, Math.max(0, (s - arcs[i]) / span));
  const tx = (b.x - a.x) / span;
  const tz = (b.z - a.z) / span;
  return {
    x: a.x + (b.x - a.x) * u,
    z: a.z + (b.z - a.z) * u,
    tx,
    tz,
    y: street.heights[i] + (street.heights[i + 1] - street.heights[i]) * u,
  };
}

/** Whether two rectangles (centre, unit width axis, half extents) overlap - separating axis test. */
function rectanglesOverlap(
  a: { x: number; z: number; ux: number; uz: number; hw: number; hd: number },
  b: { x: number; z: number; ux: number; uz: number; hw: number; hd: number },
): boolean {
  const axes = [
    [a.ux, a.uz],
    [-a.uz, a.ux],
    [b.ux, b.uz],
    [-b.uz, b.ux],
  ];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [ax, az] of axes) {
    const project = (r: typeof a): number =>
      r.hw * Math.abs(r.ux * ax + r.uz * az) + r.hd * Math.abs(-r.uz * ax + r.ux * az);
    if (Math.abs(dx * ax + dz * az) > project(a) + project(b)) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------------------
// Streets

/** Minimal binary heap keyed by cost. */
class Heap {
  private keys: number[] = [];
  private costs: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, cost: number): void {
    this.keys.push(key);
    this.costs.push(cost);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.costs[p] <= this.costs[i]) break;
      [this.keys[p], this.keys[i]] = [this.keys[i], this.keys[p]];
      [this.costs[p], this.costs[i]] = [this.costs[i], this.costs[p]];
      i = p;
    }
  }
  pop(): number {
    const top = this.keys[0];
    const lastKey = this.keys.pop()!;
    const lastCost = this.costs.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.costs[0] = lastCost;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.costs[l] < this.costs[m]) m = l;
        if (r < this.keys.length && this.costs[r] < this.costs[m]) m = r;
        if (m === i) break;
        [this.keys[m], this.keys[i]] = [this.keys[i], this.keys[m]];
        [this.costs[m], this.costs[i]] = [this.costs[i], this.costs[m]];
        i = m;
      }
    }
    return top;
  }
}

const STEPS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * A street's route from `from` to `to` on the STREET_GRID lattice, inside the settlement: free up
 * to STREET_EASY_GRADE, steeply dearer above it, impassable over STREET_MAX_GRADE or water - so on
 * a hillside it bends along the slope instead of climbing straight up it. Ground already carrying a
 * street is cheaper, so streets heading the same way merge rather than running side by side.
 */
function routeStreet(
  from: CellPoint,
  to: CellPoint,
  site: SettlementSite,
  ground: Ground,
  streetNodes: Set<number>,
): CellPoint[] | null {
  const key = (gx: number, gz: number): number => (gx + 32768) * 65536 + (gz + 32768);
  const sx = Math.round(from.x / STREET_GRID);
  const sz = Math.round(from.z / STREET_GRID);
  const ex = Math.round(to.x / STREET_GRID);
  const ez = Math.round(to.z / STREET_GRID);
  const startKey = key(sx, sz);
  const goalKey = key(ex, ez);
  const limitSq = (site.radius + STREET_GRID * 2) ** 2;

  const best = new Map<number, number>([[startKey, 0]]);
  const cameFrom = new Map<number, number>();
  const heap = new Heap();
  heap.push(startKey, 0);
  let expansions = 0;

  while (heap.size > 0 && expansions < 20000) {
    const current = heap.pop();
    if (current === goalKey) {
      const path: CellPoint[] = [];
      let k: number | undefined = current;
      while (k !== undefined) {
        path.push({ x: (Math.floor(k / 65536) - 32768) * STREET_GRID, z: ((k % 65536) - 32768) * STREET_GRID });
        k = cameFrom.get(k);
      }
      path.reverse();
      path[0] = from;
      path[path.length - 1] = to;
      return path;
    }
    expansions++;
    const gx = Math.floor(current / 65536) - 32768;
    const gz = (current % 65536) - 32768;
    const here = ground.sample(gx * STREET_GRID, gz * STREET_GRID);
    const cost = best.get(current)!;
    for (const [dx, dz] of STEPS) {
      const nx = gx + dx;
      const nz = gz + dz;
      const nextKey = key(nx, nz);
      const px = nx * STREET_GRID;
      const pz = nz * STREET_GRID;
      if ((px - site.x) ** 2 + (pz - site.z) ** 2 > limitSq) continue;
      const next = ground.sample(px, pz);
      if (nextKey !== goalKey && !buildable(next, 6)) continue;
      const distance = dx !== 0 && dz !== 0 ? STREET_GRID * Math.SQRT2 : STREET_GRID;
      const grade = Math.abs(next.height - here.height) / distance;
      if (grade > STREET_MAX_GRADE) continue;
      const excess = Math.max(0, grade - STREET_EASY_GRADE) / STREET_EASY_GRADE;
      const reuse = streetNodes.has(current) && streetNodes.has(nextKey) ? 0.5 : 1;
      const candidate = cost + distance * (1 + STREET_GRADE_WEIGHT * excess * excess) * reuse;
      if (candidate >= (best.get(nextKey) ?? Infinity)) continue;
      best.set(nextKey, candidate);
      cameFrom.set(nextKey, current);
      heap.push(nextKey, candidate + Math.hypot(ex - nx, ez - nz) * STREET_GRID);
    }
  }
  return null;
}

/** The steepest step along a straight run, or Infinity if it crosses unbuildable ground. */
function worstGradeAlong(a: CellPoint, b: CellPoint, ground: Ground): number {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(length / 2));
  let previous = ground.height(a.x, a.z);
  let worst = 0;
  for (let i = 1; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const z = a.z + ((b.z - a.z) * i) / steps;
    if (!buildable(ground.sample(x, z), 6)) return Infinity;
    const h = ground.height(x, z);
    worst = Math.max(worst, Math.abs(h - previous) / (length / steps));
    previous = h;
  }
  return worst;
}

/**
 * Replaces the lattice staircase with the longest straight runs the ground allows: from each kept
 * point, the farthest later point whose straight line is no steeper than the stretch of route it
 * replaces (or than STREET_STRAIGHT_MAX_GRADE, whichever is more). On flat ground a street becomes
 * one straight line; on a slope it keeps the bends that were there to ease the climb.
 */
function straightenStreet(path: CellPoint[], ground: Ground): CellPoint[] {
  const out: CellPoint[] = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let pathWorst = 0;
    let chosen = i + 1;
    for (let j = i + 1; j < path.length; j++) {
      pathWorst = Math.max(pathWorst, worstGradeAlong(path[j - 1], path[j], ground));
      if (worstGradeAlong(path[i], path[j], ground) <= Math.max(STREET_STRAIGHT_MAX_GRADE, pathWorst)) chosen = j;
    }
    out.push(path[chosen]);
    i = chosen;
  }
  return out;
}

/** Street surface heights along `points`: the ground, smoothed along the street, then blended over
 *  its first and last STREET_JOIN_BLEND to the levels it joins (a gate's road, a main street, the
 *  square), so junctions meet without a step. */
function streetProfile(points: CellPoint[], ground: Ground, startHeight: number | null, endHeight: number | null): number[] {
  const arcs = arcLengths(points);
  const raw = points.map((p) => ground.height(p.x, p.z));
  let heights = raw;
  for (let pass = 0; pass < 2; pass++) {
    heights = heights.map((_, i) => {
      let sum = 0;
      let weight = 0;
      for (let j = 0; j < heights.length; j++) {
        if (Math.abs(arcs[j] - arcs[i]) <= STREET_PROFILE_SMOOTH_REACH / 2) {
          sum += heights[j];
          weight++;
        }
      }
      return sum / weight;
    });
  }
  const total = arcs[arcs.length - 1];
  // Long enough that the join climbs no steeper than STREET_JOIN_MAX_GRADE (the smoothstep's
  // steepest point is 1.5x its average), but never more than half the street each.
  const joinLength = (target: number | null, own: number): number =>
    target === null ? 0 : Math.min(total / 2, Math.max(STREET_JOIN_BLEND, (1.5 * Math.abs(target - own)) / STREET_JOIN_MAX_GRADE));
  const startBlend = joinLength(startHeight, heights[0]);
  const endBlend = joinLength(endHeight, heights[heights.length - 1]);
  const joined = heights.map((h, i) => {
    let out = h;
    if (startHeight !== null && arcs[i] < startBlend) {
      const t = arcs[i] / startBlend;
      out = startHeight + (out - startHeight) * t * t * (3 - 2 * t);
    }
    if (endHeight !== null && total - arcs[i] < endBlend) {
      const t = (total - arcs[i]) / endBlend;
      out = endHeight + (out - endHeight) * t * t * (3 - 2 * t);
    }
    return out;
  });

  // Held to STREET_PROFILE_MAX_GRADE both ways, climbing and falling - a street starting in a road's
  // cutting at a gate would otherwise follow the cutting's bank straight up. Unlike a road's
  // profile this may fill as well as cut, and never moves a joined end.
  const last = joined.length - 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i <= last; i++) {
      if (i === last && endHeight !== null) continue;
      const step = (arcs[i] - arcs[i - 1]) * STREET_PROFILE_MAX_GRADE;
      joined[i] = Math.min(joined[i - 1] + step, Math.max(joined[i - 1] - step, joined[i]));
    }
    for (let i = last - 1; i >= 0; i--) {
      if (i === 0 && startHeight !== null) continue;
      const step = (arcs[i + 1] - arcs[i]) * STREET_PROFILE_MAX_GRADE;
      joined[i] = Math.min(joined[i + 1] + step, Math.max(joined[i + 1] - step, joined[i]));
    }
  }
  return joined;
}

function makeStreet(kind: Street["kind"], points: CellPoint[], ground: Ground, startHeight: number | null, endHeight: number | null): Street {
  const shaped = resample(chaikin(points, 3), 3);
  return {
    kind,
    points: shaped,
    heights: streetProfile(shaped, ground, startHeight, endHeight),
    widthScale: kind === "main" ? MAIN_STREET_WIDTH : SIDE_STREET_WIDTH,
    taperEnds: false,
  };
}

// ------------------------------------------------------------------------------------------------
// The layout

/**
 * Lays out one settlement: main streets from each gate in to the square, side streets branching off
 * them along the easiest ground, and houses on plots lining every street.
 *
 * Every placement is checked against the terrain rather than assumed to fit: a street only goes
 * where its grade is walkable and the ground is dry, a side street stops where the slope or another
 * street says so, and a house only stands where its footprint is dry and level enough to be
 * flattened into a plot - which on a hillside naturally gives a looser, terraced village instead of
 * a grid.
 */
function layoutSettlement(
  seed: number,
  site: SettlementSite,
  siteGates: SettlementGate[],
  nearbyRoads: RoadLink[],
  sampleTerrain: TerrainSampler,
): SettlementLayout {
  const rng = mulberry32(deriveSeed(seed, SETTLEMENT_LAYOUT_SALT + site.id));
  const between = ([lo, hi]: [number, number]): number => lo + rng() * (hi - lo);
  const tier = site.style.tiers[site.tier];
  const houseStyle = site.style.houses;
  const ground = createGround(sampleTerrain);

  // The square: a level patch at the centre, at the average height of the ground it covers.
  let squareSum = 0;
  for (let i = 0; i < 9; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = i === 8 ? 0 : tier.squareRadius * 0.7;
    squareSum += ground.height(site.x + Math.cos(a) * r, site.z + Math.sin(a) * r);
  }
  const square: SettlementSquare = { x: site.x, z: site.z, radius: tier.squareRadius, y: squareSum / 9 };

  // A settlement no road reached still gets a way in; one reached from a single direction also gets
  // a street out the far side, so a hamlet at the end of a road is a street, not a cul-de-sac.
  const gates = [...siteGates];
  if (gates.length === 0) {
    const gate = chooseGate(site, site.x + 1, site.z, gates, sampleTerrain, Math.PI);
    if (gate) gates.push(gate);
  }
  const streetEnds: SettlementGate[] = [...gates];
  if (gates.length === 1) {
    const back = chooseGate(site, site.x - Math.cos(gates[0].angle), site.z - Math.sin(gates[0].angle), gates, sampleTerrain);
    if (back) streetEnds.push(back);
  }

  const streets: Street[] = [];
  const streetNodes = new Set<number>();
  for (const gate of streetEnds) {
    // Straight in from the gate first, continuing the line the road arrived on, then routed.
    const inward = {
      x: gate.x - Math.cos(gate.angle) * STREET_GATE_STRAIGHT,
      z: gate.z - Math.sin(gate.angle) * STREET_GATE_STRAIGHT,
    };
    const route = routeStreet(inward, { x: site.x, z: site.z }, site, ground, streetNodes);
    if (!route) continue;
    for (const p of route) streetNodes.add((Math.round(p.x / STREET_GRID) + 32768) * 65536 + (Math.round(p.z / STREET_GRID) + 32768));
    streets.push(makeStreet("main", [{ x: gate.x, z: gate.z }, ...straightenStreet(route, ground)], ground, gate.roadHeight, square.y));
  }

  // Side streets: at intervals along each main street, the easiest straight line off to one side.
  const mainStreets = [...streets];
  for (const main of mainStreets) {
    const arcs = arcLengths(main.points);
    const total = arcs[arcs.length - 1];
    for (let s = 18 + between(SIDE_STREET_SPACING) * 0.5; s < total - square.radius - 8; s += between(SIDE_STREET_SPACING)) {
      if (rng() >= tier.sideStreetChance) continue;
      const at = pointAt(main, arcs, s);
      const side = rng() < 0.5 ? 1 : -1;
      const length = between(tier.sideStreetLength);
      let bestPoints: CellPoint[] | null = null;
      let bestScore = -Infinity;
      // Straight out to this side (the street's normal), or angled up to 40 degrees either way.
      const normalAngle = Math.atan2(at.tx * side, -at.tz * side);
      for (const offset of [0, 0.35, -0.35, 0.7, -0.7]) {
        const dirX = Math.cos(normalAngle + offset);
        const dirZ = Math.sin(normalAngle + offset);
        let reached = 0;
        let previous = at.y;
        let climb = 0;
        for (let d = 3; d <= length; d += 3) {
          const x = at.x + dirX * d;
          const z = at.z + dirZ * d;
          if ((x - site.x) ** 2 + (z - site.z) ** 2 > (site.radius - 6) ** 2) break;
          if (!buildable(ground.sample(x, z), 6)) break;
          const h = ground.height(x, z);
          if (Math.abs(h - previous) / 3 > STREET_STRAIGHT_MAX_GRADE) break;
          if (d > 10 && streets.some((other) => other !== main && distanceToPolyline(x, z, other.points) < SIDE_STREET_CLEARANCE)) break;
          if (d > 10 && distanceToPolyline(x, z, main.points) < SIDE_STREET_CLEARANCE * 0.8) break;
          if (d > 6 && nearbyRoads.some((road) => distanceToPolyline(x, z, road.points) < SIDE_STREET_CLEARANCE)) break;
          climb += Math.abs(h - previous);
          previous = h;
          reached = d;
        }
        if (reached < tier.sideStreetLength[0]) continue;
        const score = reached - climb * 4 - Math.abs(offset) * 6;
        if (score > bestScore) {
          bestScore = score;
          bestPoints = [
            { x: at.x, z: at.z },
            { x: at.x + dirX * reached, z: at.z + dirZ * reached },
          ];
        }
      }
      if (bestPoints) streets.push(makeStreet("side", bestPoints, ground, at.y, null));
    }
  }

  // Houses: plots along both sides of every street, main streets first so they fill up best.
  const houses: House[] = [];
  const footprints: { x: number; z: number; ux: number; uz: number; hw: number; hd: number }[] = [];
  // Every street and road near the settlement as points every few metres, each with how far a house
  // footprint has to keep from it: clear of the line's level ground by enough that the plot's
  // levelling, which fades out toward a road (see terrainSampler.ts), is at full strength across the
  // whole footprint. In road-width units (see RoadQuery.distance), so it holds for a main street as
  // wide as a road just as for a narrow side street.
  //
  // Points along the lines, tested against the footprint rectangle - not the footprint's corners
  // tested against the lines: a narrow street can pass straight between the corners of a big house.
  const obstaclePoints: { x: number; z: number; clearance: number }[] = [];
  const addObstacle = (points: CellPoint[], clearance: number): void => {
    for (const p of resample(points, 3)) {
      if ((p.x - site.x) ** 2 + (p.z - site.z) ** 2 < (site.radius + 30) ** 2) obstaclePoints.push({ x: p.x, z: p.z, clearance });
    }
  };
  for (const street of streets) addObstacle(street.points, (ROAD_HALF_WIDTH + 3.2) * street.widthScale);
  for (const road of nearbyRoads) addObstacle(road.points, ROAD_HALF_WIDTH + 3.5);
  /** Distance from a point to a rectangle (0 inside). */
  const gapToRectangle = (px: number, pz: number, x: number, z: number, ux: number, uz: number, hw: number, hd: number): number => {
    const dx = px - x;
    const dz = pz - z;
    const along = Math.abs(dx * ux + dz * uz) - hw;
    const across = Math.abs(-dx * uz + dz * ux) - hd;
    return Math.hypot(Math.max(0, along), Math.max(0, across));
  };
  const totalWeight = houseStyle.buildings.reduce((sum, entry) => sum + entry.weight, 0);

  for (const street of streets) {
    const arcs = arcLengths(street.points);
    const total = arcs[arcs.length - 1];
    const streetHalf = ROAD_HALF_WIDTH * street.widthScale;
    for (const side of [1, -1]) {
      let s = street.kind === "main" ? 4 : 6;
      while (s < total - 3) {
        // A building, and its own variant of it: the model says how much ground it takes.
        let pick = rng() * totalWeight;
        const { building } = houseStyle.buildings.find((entry) => (pick -= entry.weight) < 0) ?? houseStyle.buildings[0];
        const variant = Math.floor(rng() * BUILDING_VARIANT_SPACE);
        const model = generateBuilding(building, seed, variant);
        const width = model.halfWidth * 2;
        const depth = model.halfDepth * 2;
        if (rng() >= tier.plotFill) {
          s += width * 0.8;
          continue;
        }
        const at = pointAt(street, arcs, Math.min(total, s + width / 2));
        // Normal pointing away from the street on this side; the house faces back along it.
        const nx = -at.tz * side;
        const nz = at.tx * side;
        const offset = streetHalf + between(houseStyle.setback) + depth / 2;
        const x = at.x + nx * offset;
        const z = at.z + nz * offset;
        const ux = at.tx;
        const uz = at.tz;
        const hw = width / 2;
        const hd = depth / 2;

        const placed = ((): boolean => {
          const fromCentre = Math.hypot(x - site.x, z - site.z);
          if (fromCentre + Math.max(hw, hd) > site.radius) return false;
          if (fromCentre - Math.max(hw, hd) < square.radius + 2) return false;
          // The floor is at street level (see HOUSE_FLOOR_ABOVE_STREET). Footprint - corners, edge
          // midpoints and centre - has to be dry, and near enough that level to be flattened to it.
          const floor = at.y + HOUSE_FLOOR_ABOVE_STREET;
          for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]]) {
            const px = x + ux * hw * a - uz * hd * b;
            const pz = z + uz * hw * a + ux * hd * b;
            if (!buildable(ground.sample(px, pz), 4)) return false;
            if (Math.abs(ground.height(px, pz) - floor) > HOUSE_MAX_CUT_FILL) return false;
          }
          if (obstaclePoints.some((o) => gapToRectangle(o.x, o.z, x, z, ux, uz, hw, hd) < o.clearance)) return false;
          const footprint = { x, z, ux, uz, hw: hw + 0.8, hd: hd + 0.8 };
          if (footprints.some((other) => rectanglesOverlap(footprint, other))) return false;
          footprints.push(footprint);
          houses.push({
            x,
            z,
            y: floor,
            frontX: -nx,
            frontZ: -nz,
            width,
            depth,
            building,
            variant,
          });
          return true;
        })();
        s += placed ? width + between(houseStyle.gap) : 2.5;
      }
    }
  }

  return { siteId: site.id, styleId: site.style.id, x: site.x, z: site.z, radius: site.radius, gates: streetEnds, square, streets, houses };
}

/** Every settlement's layout. Deterministic from the seed, sites, gates and terrain. */
export function generateSettlementLayouts(
  seed: number,
  sites: SettlementSite[],
  gates: SettlementGate[][],
  roads: RoadLink[],
  sampleTerrain: TerrainSampler,
): SettlementLayout[] {
  return sites.map((site) => {
    // Only the roads that come near enough to matter for house plots - measured to the line, not its
    // vertices, which on a simplified road can be hundreds of metres apart either side of a village.
    const reach = site.radius + 20;
    const nearbyRoads = roads.filter((road) => distanceToPolyline(site.x, site.z, road.points) < reach);
    return layoutSettlement(seed, site, gates[site.id] ?? [], nearbyRoads, sampleTerrain);
  });
}
