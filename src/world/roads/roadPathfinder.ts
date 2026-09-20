import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import {
  ROAD_GRID,
  ROAD_EASY_GRADE,
  ROAD_MAX_GRADE,
  ROAD_GRADE_WEIGHT,
  ROAD_MIN_HEIGHT,
  ROAD_MAX_LAKE_FACTOR,
  ROAD_RIVER_CORRIDOR,
  ROAD_RIVER_CROSSING_WEIGHT,
  ROAD_OFF_ZONE_PENALTY,
  ROAD_REUSE_DISCOUNT,
  ROAD_MAX_DETOUR_FACTOR,
  ROAD_MAX_EXPANSIONS,
  ROAD_HEURISTIC_WEIGHT,
} from "./roadConfig";

/** Grid coordinates packed into one number, so the open set and the caches can be plain Maps keyed
 *  by a primitive. The world is ~70 km across, so a 25-unit grid needs about 2800 either way. */
const KEY_OFFSET = 1 << 15;
const KEY_STRIDE = 1 << 16;

export function nodeKey(gx: number, gz: number): number {
  return (gx + KEY_OFFSET) * KEY_STRIDE + (gz + KEY_OFFSET);
}

function keyToGx(key: number): number {
  return Math.floor(key / KEY_STRIDE) - KEY_OFFSET;
}

function keyToGz(key: number): number {
  return (key % KEY_STRIDE) - KEY_OFFSET;
}

export function nodePoint(key: number): CellPoint {
  return { x: keyToGx(key) * ROAD_GRID, z: keyToGz(key) * ROAD_GRID };
}

/** What the cost function needs to know about one grid node. Cached across every link in the
 *  world: corridors overlap heavily near settlements and along shared trunks, and a terrain sample
 *  is by far the most expensive thing here. */
interface GroundNode {
  height: number;
  areaId: number;
  /** True where nothing can be built: open water, a lake, or ground below road level that is not
   *  a river channel (a river channel is below road level by construction and must stay passable,
   *  or no road could ever cross one). */
  blocked: boolean;
  inRiver: boolean;
}

/** Minimal binary heap over (key, priority). A sorted array would be O(n) per insert, and the open
 *  set routinely holds thousands of nodes. */
class Frontier {
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
      const parent = (i - 1) >> 1;
      if (this.costs[parent] <= this.costs[i]) break;
      this.swap(i, parent);
      i = parent;
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
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.costs.length && this.costs[left] < this.costs[smallest]) smallest = left;
        if (right < this.costs.length && this.costs[right] < this.costs[smallest]) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.costs[a], this.costs[b]] = [this.costs[b], this.costs[a]];
  }
}

const NEIGHBOUR_OFFSETS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export interface PathRequest {
  from: CellPoint;
  to: CellPoint;
  /** The zones the link runs between. Anywhere else costs ROAD_OFF_ZONE_PENALTY. */
  zones: Set<number>;
  /** Grid nodes already carrying road - the discount that produces junctions and shared trunks. */
  roadNodes: Set<number>;
  /** Overrides ROAD_MAX_DETOUR_FACTOR, for the rescue pass. */
  detourFactor?: number;
}

export interface PathResult {
  /** Grid node keys from start to goal, or null when no route exists inside the search bounds. */
  nodes: number[] | null;
  expansions: number;
  /** A failure that ran out of budget rather than out of reachable ground. The two mean opposite
   *  things - one is a link that needs a bigger search, the other a link that has no route - so
   *  they are counted apart rather than both being "failed". */
  capped: boolean;
}

export interface RoadPathfinder {
  findPath(request: PathRequest): PathResult;
  /** How many distinct grid nodes have been sampled so far - the real cost of the whole pass. */
  sampleCount(): number;
}

/**
 * A* over a fixed world-aligned grid.
 *
 * Every link searches the same lattice, which is what lets two links that run the same way share
 * nodes exactly rather than nearly - the reuse discount is a set membership test, not a distance
 * threshold, and a shared trunk is literally the same nodes.
 */
export function createRoadPathfinder(sampleTerrain: TerrainSampler): RoadPathfinder {
  const ground = new Map<number, GroundNode>();

  function groundAt(key: number): GroundNode {
    const cached = ground.get(key);
    if (cached) return cached;
    const { x, z } = nodePoint(key);
    const sample = sampleTerrain(x, z);
    const inRiver = sample.riverGap < ROAD_RIVER_CORRIDOR;
    const node: GroundNode = {
      height: sample.height,
      areaId: sample.primaryAreaId,
      inRiver,
      blocked:
        !sample.isLand ||
        sample.lakeFactor > ROAD_MAX_LAKE_FACTOR ||
        (sample.height < ROAD_MIN_HEIGHT && !inRiver),
    };
    ground.set(key, node);
    return node;
  }

  /**
   * Cost of one step, as a multiple of the distance travelled.
   *
   * Below ROAD_EASY_GRADE the climb is free - a road genuinely does not care between level and a
   * gentle rise - and past it the square is what makes going over a hill lose to going around it.
   * Inside a river channel the grade limit is suspended entirely: banks are cut at exactly
   * ROAD_MAX_GRADE, so enforcing it would make every river in the world impassable.
   */
  function stepCost(from: GroundNode, to: GroundNode, distance: number, zones: Set<number>, onRoad: boolean): number {
    const grade = Math.abs(to.height - from.height) / distance;
    if (!to.inRiver && grade > ROAD_MAX_GRADE) return Infinity;

    const excess = Math.max(0, grade - ROAD_EASY_GRADE);
    let multiplier = 1 + ROAD_GRADE_WEIGHT * (excess / ROAD_EASY_GRADE) ** 2;
    if (to.inRiver) multiplier += ROAD_RIVER_CROSSING_WEIGHT;
    if (!zones.has(to.areaId)) multiplier *= ROAD_OFF_ZONE_PENALTY;
    if (onRoad) multiplier *= ROAD_REUSE_DISCOUNT;
    return distance * multiplier;
  }

  function findPath({ from, to, zones, roadNodes, detourFactor }: PathRequest): PathResult {
    const startKey = nodeKey(Math.round(from.x / ROAD_GRID), Math.round(from.z / ROAD_GRID));
    const goalKey = nodeKey(Math.round(to.x / ROAD_GRID), Math.round(to.z / ROAD_GRID));
    if (startKey === goalKey) return { nodes: [startKey], expansions: 0, capped: false };

    const goal = nodePoint(goalKey);
    const start = nodePoint(startKey);
    const straight = Math.hypot(goal.x - start.x, goal.z - start.z);
    // The search is confined to an ellipse with the endpoints as foci: any node whose detour via
    // it exceeds the budget cannot be on an acceptable route, so it is never expanded. This is
    // what bounds the search, far more than the expansion cap below.
    const detourBudget = straight * (detourFactor ?? ROAD_MAX_DETOUR_FACTOR);

    const cameFrom = new Map<number, number>();
    const bestCost = new Map<number, number>([[startKey, 0]]);
    const frontier = new Frontier();
    frontier.push(startKey, straight * ROAD_HEURISTIC_WEIGHT);
    const settled = new Set<number>();
    let expansions = 0;

    while (frontier.size > 0 && expansions < ROAD_MAX_EXPANSIONS) {
      const current = frontier.pop();
      if (settled.has(current)) continue;
      settled.add(current);
      expansions++;

      if (current === goalKey) {
        const nodes: number[] = [current];
        let step = current;
        while (step !== startKey) {
          step = cameFrom.get(step)!;
          nodes.push(step);
        }
        nodes.reverse();
        return { nodes, expansions, capped: false };
      }

      const fromGround = groundAt(current);
      const gx = keyToGx(current);
      const gz = keyToGz(current);
      const costSoFar = bestCost.get(current)!;

      for (const [dx, dz] of NEIGHBOUR_OFFSETS) {
        const nextKey = nodeKey(gx + dx, gz + dz);
        if (settled.has(nextKey)) continue;

        const next = nodePoint(nextKey);
        const toGoal = Math.hypot(goal.x - next.x, goal.z - next.z);
        if (Math.hypot(next.x - start.x, next.z - start.z) + toGoal > detourBudget) continue;

        const toGround = groundAt(nextKey);
        if (toGround.blocked) continue;

        const distance = dx !== 0 && dz !== 0 ? ROAD_GRID * Math.SQRT2 : ROAD_GRID;
        const step = stepCost(fromGround, toGround, distance, zones, roadNodes.has(nextKey));
        if (!Number.isFinite(step)) continue;

        const candidate = costSoFar + step;
        const known = bestCost.get(nextKey);
        if (known !== undefined && known <= candidate) continue;
        bestCost.set(nextKey, candidate);
        cameFrom.set(nextKey, current);
        frontier.push(nextKey, candidate + toGoal * ROAD_HEURISTIC_WEIGHT);
      }
    }

    return { nodes: null, expansions, capped: expansions >= ROAD_MAX_EXPANSIONS };
  }

  return { findPath, sampleCount: () => ground.size };
}
