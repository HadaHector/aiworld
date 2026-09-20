import { Delaunay } from "d3-delaunay";
import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { SettlementSite } from "../settlements/settlementSites";
import { simplify, removeLoops } from "../polyline";
import { straighten, roundCorners, snapToNetwork, createSnapIndex } from "./roadShaping";
import { createRoadPathfinder, nodePoint } from "./roadPathfinder";
import {
  ROAD_EXTRA_LINK_FRACTION,
  ROAD_MAX_LINK_LENGTH,
  ROAD_MAX_PATH_RATIO,
  ROAD_RESCUE_DETOUR_FACTOR,
  ROAD_ACCESS_ATTEMPTS,
  ROAD_SNAP_DISTANCE,
  ROAD_SIMPLIFY_TOLERANCE,
} from "./roadConfig";

/** Why a road exists. Every link is routed the same way; this is which pass asked for it, and it
 *  is what a later stage would use to draw a local access track narrower than a trunk road. */
export type RoadKind = "link" | "access" | "rescue";

/** One road, as the line it runs along. */
export interface RoadLink {
  id: number;
  kind: RoadKind;
  from: number; // settlement id
  to: number;
  points: CellPoint[];
  /** Length along the shaped line, not the straight-line distance between the settlements. */
  length: number;
}

export interface RoadNetwork {
  links: RoadLink[];
  /** Reported rather than logged: these are the numbers that say whether the cost function is
   *  behaving, and they are worth having at hand when it is being tuned. */
  stats: {
    candidates: number;
    attempted: number;
    built: number;
    /** Links added so that a settlement is reachable from inside its own zone. */
    access: number;
    /** Links added by the last pass purely to stop settlements being unreachable by road. */
    rescued: number;
    /** Settlements still with no road at all, and with no road to their own zone. Reported rather
     *  than hidden: both are properties of the terrain, not of the plan. */
    unreached: number;
    withoutHomeAccess: number;
    /** No route at all inside the detour budget - almost always a link the triangulation proposed
     *  across water or over ground nothing can climb. */
    unreachable: number;
    /** Ran out of expansion budget before finding a route that exists. */
    capped: number;
    /** Routes found but rejected as too indirect to be a road - see ROAD_MAX_PATH_RATIO. */
    tooIndirect: number;
    expansions: number;
    samples: number;
    /** Grid nodes reached by more than one link - the shared trunks, and so a direct measure of
     *  whether the reuse discount is doing anything at all. */
    sharedNodes: number;
  };
}

interface Candidate {
  from: number;
  to: number;
  length: number;
}

interface UnionFind {
  /** Joins two ids, returning false if they were already in the same component. */
  union(a: number, b: number): boolean;
  connected(a: number, b: number): boolean;
}

/** Union-find over settlement ids - for the spanning forest first, and then over the links that
 *  actually got built, which is not the same graph: a planned link whose route failed leaves the
 *  two sides apart however the plan counted them. */
function createUnionFind(count: number): UnionFind {
  const parent = new Int32Array(count).map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  return {
    union(a, b) {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA === rootB) return false;
      parent[rootA] = rootB;
      return true;
    },
    connected: (a, b) => find(a) === find(b),
  };
}

/**
 * Which settlements to try to connect.
 *
 * Delaunay gives each settlement its natural neighbours without comparing every pair. The spanning
 * forest over those guarantees everything reachable is connected; the shortest of the leftovers are
 * added back so the network has loops and alternate routes rather than being a tree, which is what
 * a real road network looks like.
 *
 * Links longer than ROAD_MAX_LINK_LENGTH are dropped before any of that. Continents are separated
 * by six times the cell spacing, so this is also what stops the triangulation from proposing a
 * route across open ocean - which would otherwise spend its entire expansion budget failing.
 */
function chooseLinks(settlements: SettlementSite[]): { all: Candidate[]; chosen: Candidate[] } {
  const delaunay = Delaunay.from(
    settlements,
    (s) => s.x,
    (s) => s.z,
  );

  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  for (let i = 0; i < settlements.length; i++) {
    for (const j of delaunay.neighbors(i)) {
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      const pairKey = lo * settlements.length + hi;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const length = Math.hypot(settlements[lo].x - settlements[hi].x, settlements[lo].z - settlements[hi].z);
      if (length > ROAD_MAX_LINK_LENGTH) continue;
      candidates.push({ from: lo, to: hi, length });
    }
  }

  // Shortest first, tie-broken by id so the forest is the same for a given world rather than
  // depending on the sort being stable.
  candidates.sort((a, b) => a.length - b.length || a.from - b.from || a.to - b.to);

  const union = createUnionFind(settlements.length);
  const spanning: Candidate[] = [];
  const leftover: Candidate[] = [];
  for (const candidate of candidates) {
    if (union.union(candidate.from, candidate.to)) spanning.push(candidate);
    else leftover.push(candidate);
  }

  const extras = leftover.slice(0, Math.round(leftover.length * ROAD_EXTRA_LINK_FRACTION));
  // Built shortest first, so the short local links exist before the long ones and the long ones
  // have something to bundle onto - the build order is part of the topology, not an accident.
  const chosen = [...spanning, ...extras].sort((a, b) => a.length - b.length || a.from - b.from || a.to - b.to);
  return { all: candidates, chosen };
}

function polylineLength(points: CellPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return total;
}

/**
 * Builds the road network over the settlements.
 *
 * Links are routed one at a time, cheapest-to-build first, and every completed road marks the grid
 * nodes it occupies. Later links get those nodes at ROAD_REUSE_DISCOUNT, so they merge onto an
 * existing road wherever merging is genuinely cheaper and leave it where it stops going their way.
 * Junctions and shared trunks are the output of that, not a separate step - which is why there is
 * no "is there a road within N units" test anywhere here.
 */
export function generateRoadNetwork(settlements: SettlementSite[], sampleTerrain: TerrainSampler): RoadNetwork {
  if (settlements.length < 2) {
    return {
      links: [],
      stats: {
        candidates: 0, attempted: 0, built: 0, access: 0, rescued: 0, unreached: 0,
        withoutHomeAccess: 0, unreachable: 0, capped: 0, tooIndirect: 0, expansions: 0, samples: 0,
        sharedNodes: 0,
      },
    };
  }

  const { all, chosen } = chooseLinks(settlements);
  const pathfinder = createRoadPathfinder(sampleTerrain);
  const roadNodes = new Set<number>();
  const nodeUses = new Map<number, number>();
  // Geometry of the roads already built, so a new one can be pulled onto a stretch it shares with
  // them rather than rendering as a second road beside it.
  const snapIndex = createSnapIndex(ROAD_SNAP_DISTANCE);
  const links: RoadLink[] = [];
  // Whether a settlement is reachable from its own zone - i.e. has a road to another settlement in
  // it. Tracked as links are built rather than recomputed, since the access pass below both reads
  // and extends it.
  const homeAccess = new Array<boolean>(settlements.length).fill(false);
  const zoneMembers = new Map<number, number[]>();
  settlements.forEach((settlement, id) => {
    const members = zoneMembers.get(settlement.areaId);
    if (members) members.push(id);
    else zoneMembers.set(settlement.areaId, [id]);
  });
  let unreachable = 0;
  let capped = 0;
  let tooIndirect = 0;
  let expansions = 0;

  const built = createUnionFind(settlements.length);

  function build(candidate: Candidate, kind: RoadKind = "link"): boolean {
    const from = settlements[candidate.from];
    const to = settlements[candidate.to];
    const result = pathfinder.findPath({
      from,
      to,
      zones: new Set([from.areaId, to.areaId]),
      roadNodes,
      detourFactor: kind === "link" ? undefined : ROAD_RESCUE_DETOUR_FACTOR,
    });
    expansions += result.expansions;

    if (!result.nodes) {
      if (result.capped) capped++;
      else unreachable++;
      return false;
    }

    // The grid path snapped both ends to the lattice; the settlements are where they are, so the
    // real endpoints replace the snapped ones before anything is smoothed.
    const raw = result.nodes.map(nodePoint);
    raw[0] = { x: from.x, z: from.z };
    raw[raw.length - 1] = { x: to.x, z: to.z };

    const zones = new Set([from.areaId, to.areaId]);
    // Straightening may not wander into a zone the route it replaces did not already visit -
    // otherwise a shortcut could cut a corner through the zone next door, undoing the containment
    // the off-zone penalty bought.
    for (const key of result.nodes) zones.add(pathfinder.zoneOfNode(key));
    const chordIsClear = (a: CellPoint, b: CellPoint): boolean => pathfinder.chordIsClear(a, b, zones);

    const straightened = straighten(raw, chordIsClear, pathfinder.riverLengthAlong);
    // removeLoops after rounding: a hairpin tight enough that its arc crosses the line is rare but
    // real - measured at 6 across the network - and it is the same fix rivers already use.
    const snapped = snapToNetwork(roundCorners(straightened, chordIsClear), snapIndex);
    const points = simplify(removeLoops(snapped), ROAD_SIMPLIFY_TOLERANCE);
    const length = polylineLength(points);

    // Judged on the finished line rather than on the search, because that is the road that would
    // actually be drawn. A rescue link is exempt: it exists precisely because nothing better was
    // available.
    const straight = Math.hypot(to.x - from.x, to.z - from.z);
    if (kind === "link" && straight > 0 && length > straight * ROAD_MAX_PATH_RATIO) {
      tooIndirect++;
      return false;
    }

    // Only now that the link is accepted: a rejected route must leave no trace, or it would mark
    // ground as carrying a road that was never built and pull later links toward it.
    for (const key of result.nodes) {
      roadNodes.add(key);
      nodeUses.set(key, (nodeUses.get(key) ?? 0) + 1);
    }
    snapIndex.add(points);
    links.push({ id: links.length, kind, from: candidate.from, to: candidate.to, points, length });
    built.union(candidate.from, candidate.to);
    homeAccess[candidate.from] ||= settlements[candidate.from].areaId === settlements[candidate.to].areaId;
    homeAccess[candidate.to] ||= homeAccess[candidate.from];
    return true;
  }

  for (const candidate of chosen) build(candidate);

  // Access pass. A settlement whose every road arrives from a neighbouring zone is connected but
  // not served: nothing leads to it from the land it belongs to. This gives each of those a road
  // to its nearest same-zone settlement, which - since both ends are in one zone - is routed
  // entirely inside it by the ordinary off-zone penalty, with no special case.
  //
  // Zones holding a single settlement are skipped: there is nothing in-zone to connect to, and
  // that is a fact about the zone rather than a link that failed.
  let access = 0;
  for (let id = 0; id < settlements.length; id++) {
    if (homeAccess[id]) continue;
    const neighbours = zoneMembers.get(settlements[id].areaId) ?? [];
    if (neighbours.length < 2) continue;

    const nearest = neighbours
      .filter((other) => other !== id)
      .map((other) => ({
        from: Math.min(id, other),
        to: Math.max(id, other),
        length: Math.hypot(settlements[other].x - settlements[id].x, settlements[other].z - settlements[id].z),
      }))
      .sort((a, b) => a.length - b.length)
      .slice(0, ROAD_ACCESS_ATTEMPTS);

    for (const candidate of nearest) {
      if (build(candidate, "access")) {
        access++;
        break;
      }
    }
  }

  // Whatever the plan said, what is connected is what got built. Every candidate that would join
  // two settlements the built roads left apart is retried with a far larger detour budget - a very
  // indirect road, but a settlement no road reaches at all is worse. Shortest first, and each
  // success is unioned immediately, so one rescue can close a whole component.
  let rescued = 0;
  for (const candidate of all) {
    if (built.connected(candidate.from, candidate.to)) continue;
    if (build(candidate, "rescue")) rescued++;
  }

  const reached = new Set<number>();
  for (const link of links) {
    reached.add(link.from);
    reached.add(link.to);
  }
  let withoutHomeAccess = 0;
  for (let id = 0; id < settlements.length; id++) {
    if (!homeAccess[id] && (zoneMembers.get(settlements[id].areaId) ?? []).length > 1) withoutHomeAccess++;
  }

  let sharedNodes = 0;
  for (const uses of nodeUses.values()) if (uses > 1) sharedNodes++;

  return {
    links,
    stats: {
      candidates: all.length,
      attempted: chosen.length,
      built: links.length,
      access,
      rescued,
      unreached: settlements.length - reached.size,
      withoutHomeAccess,
      unreachable,
      capped,
      tooIndirect,
      expansions,
      samples: pathfinder.sampleCount(),
      sharedNodes,
    },
  };
}
