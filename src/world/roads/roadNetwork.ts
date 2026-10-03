import { Delaunay } from "d3-delaunay";
import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { SettlementSite } from "../settlements/settlementSites";
import type { FeatureSite } from "../features/featureSites";
import { createRoadField } from "./roadField";
import { chooseGate, type SettlementGate } from "../settlements/gates";
import { GATE_PASS_SNAP, GATE_ROAD_EXCLUSION_MARGIN, STREET_JOIN_BLEND } from "../settlements/settlementConfig";
import { simplify, removeLoops } from "../polyline";
import { straighten, roundCorners, snapToNetwork, createSnapIndex, wobble } from "./roadShaping";
import { createBaseNoise2D } from "../terrain/noise";
import { deriveSeed } from "../rng";
import { createRoadPathfinder, nodePoint } from "./roadPathfinder";
import {
  ROAD_EXTRA_LINK_FRACTION,
  ROAD_MAX_LINK_LENGTH,
  ROAD_MAX_PATH_RATIO,
  ROAD_RESCUE_DETOUR_FACTOR,
  ROAD_MAX_DETOUR_FACTOR,
  ROAD_GRID,
  ROAD_ACCESS_ATTEMPTS,
  ROAD_SNAP_DISTANCE,
  ROAD_SNAP_SAMPLE,
  ROAD_SIMPLIFY_TOLERANCE,
  ROAD_WOBBLE_AMPLITUDE,
  ROAD_WOBBLE_WAVELENGTH,
  ROAD_WOBBLE_WAVELENGTH_LONG,
  ROAD_WOBBLE_LONG_RATIO,
  ROAD_WOBBLE_SAMPLE_STEP,
  ROAD_WOBBLE_STRAIGHT_WINDOW,
  ROAD_WOBBLE_TURN_FADE_START,
  ROAD_WOBBLE_TURN_FADE_END,
  ROAD_WOBBLE_END_TAPER,
  ROAD_WOBBLE_SIMPLIFY_TOLERANCE,
  ROAD_WOBBLE_SALT,
  ROAD_PROFILE_SMOOTH_REACH,
  ROAD_PROFILE_SMOOTH_PASSES,
  ROAD_PROFILE_MAX_GRADE,
  ROAD_PROFILE_MAX_CUT,
  ROAD_PROFILE_MAX_FILL,
  ROAD_QUERY_RADIUS,
  ROAD_GRADE_END_TAPER,
} from "./roadConfig";

/** Why a road exists. Every link is routed the same way; this is which pass asked for it, and it
 *  is what a later stage would use to draw a local access track narrower than a trunk road. A
 *  "spur" is a feature's own track (a quarry's), from the feature to the nearest road. */
export type RoadKind = "link" | "access" | "rescue" | "spur";

/** One road, as the line it runs along. */
export interface RoadLink {
  id: number;
  kind: RoadKind;
  from: number; // settlement id, -1 for a spur
  to: number;
  /** A spur's feature id (FeatureSite.id). */
  featureId?: number;
  /** Narrower than a road (1) - a spur's track. See RoadLine. */
  widthScale?: number;
  points: CellPoint[];
  /** The road surface height at each point: the ground under it, smoothed along the road and held
   *  to a walkable gradient. This is the level the terrain is brought to, not the level it has. */
  heights: number[];
  /** Length along the shaped line, not the straight-line distance between the settlements. */
  length: number;
  /** A road runs gate to gate and carries straight on into the settlement's main street there, so
   *  its grading does not fade out at the ends the way a road that simply stops does. */
  taperEnds: false;
}

export interface RoadNetwork {
  links: RoadLink[];
  /** Per settlement id, the gates its roads arrive at - where its main streets start. */
  gates: SettlementGate[][];
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
    /** Dropped before routing: one end's settlement had no ground fit for a gate facing that way. */
    noGate: number;
    /** Routes found but rejected as too indirect to be a road - see ROAD_MAX_PATH_RATIO. */
    tooIndirect: number;
    /** Features given a track to the road, and those that wanted one and got none. */
    spurs: number;
    spursFailed: number;
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

/**
 * The height a road's surface should have along its length.
 *
 * Starts from the ground under the centreline, which is the only sensible reference, then does two
 * things to it. Averaging over a window in ARC LENGTH rather than over a fixed number of points
 * makes the smoothing independent of how densely the line happens to be stored - and it is stored
 * very unevenly, a few units apart where the wander applies and hundreds apart on a bare straight.
 *
 * Then a two-way sweep holds the result to ROAD_PROFILE_MAX_GRADE. Smoothing alone does not do
 * that: a long steady climb comes out of the average exactly as steep as it went in, since there is
 * nothing local about it to average away. The sweep pulls high ground down against its neighbours
 * from one end and then the other, which is the standard way to enforce a slope limit on a profile
 * and needs no iteration to converge.
 */
function computeRoadProfile(points: CellPoint[], sampleTerrain: TerrainSampler): number[] {
  const count = points.length;
  const spans: number[] = new Array(count).fill(0);
  for (let i = 0; i < count - 1; i++) {
    spans[i] = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }

  const ground = points.map((point) => sampleTerrain(point.x, point.z).height);
  let heights = ground.slice();

  for (let pass = 0; pass < ROAD_PROFILE_SMOOTH_PASSES; pass++) {
    const next = heights.slice();
    for (let i = 0; i < count; i++) {
      let sum = heights[i];
      let weight = 1;
      let reach = 0;
      for (let j = i - 1; j >= 0 && reach < ROAD_PROFILE_SMOOTH_REACH; j--) {
        reach += spans[j];
        sum += heights[j];
        weight++;
      }
      reach = 0;
      for (let j = i + 1; j < count && reach < ROAD_PROFILE_SMOOTH_REACH; j++) {
        reach += spans[j - 1];
        sum += heights[j];
        weight++;
      }
      next[i] = sum / weight;
    }
    heights = next;
  }

  for (let i = 1; i < count; i++) {
    heights[i] = Math.min(heights[i], heights[i - 1] + spans[i - 1] * ROAD_PROFILE_MAX_GRADE);
  }
  for (let i = count - 2; i >= 0; i--) {
    heights[i] = Math.min(heights[i], heights[i + 1] + spans[i] * ROAD_PROFILE_MAX_GRADE);
  }

  // Last, so it is the one that wins: the road may be steeper than the gradient limit, but it may
  // not leave the ground.
  for (let i = 0; i < count; i++) {
    heights[i] = Math.min(ground[i] + ROAD_PROFILE_MAX_FILL, Math.max(ground[i] - ROAD_PROFILE_MAX_CUT, heights[i]));
  }

  return heights;
}

/** How far a track's surface is eased to the level it meets at either end. */
const SPUR_JOIN_BLEND = 20;

/** Eases a profile's first (or last) `reach` of length onto `level`, fully at the end itself. */
function blendEnd(heights: number[], points: CellPoint[], level: number, atStart: boolean, reach: number): void {
  const n = heights.length;
  let travelled = 0;
  for (let k = 0; k < n; k++) {
    const i = atStart ? k : n - 1 - k;
    if (k > 0) {
      const prev = atStart ? i - 1 : i + 1;
      travelled += Math.hypot(points[i].x - points[prev].x, points[i].z - points[prev].z);
    }
    if (travelled >= reach) break;
    const t = travelled / reach;
    const keep = t * t * (3 - 2 * t);
    heights[i] = level + (heights[i] - level) * keep;
  }
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
export function generateRoadNetwork(
  seed: number,
  settlements: SettlementSite[],
  sampleTerrain: TerrainSampler,
  features: FeatureSite[] = [],
): RoadNetwork {
  if (settlements.length < 2) {
    return {
      links: [],
      gates: settlements.map(() => []),
      stats: {
        candidates: 0, attempted: 0, built: 0, access: 0, rescued: 0, unreached: 0,
        withoutHomeAccess: 0, unreachable: 0, capped: 0, noGate: 0, tooIndirect: 0, spurs: 0, spursFailed: 0,
        expansions: 0, samples: 0, sharedNodes: 0,
      },
    };
  }

  // One field for the whole world, sampled at world position rather than along each road - see the
  // note on `wobble` for why that is what keeps shared roads sharing.
  const wobbleNoise = createBaseNoise2D(deriveSeed(seed, ROAD_WOBBLE_SALT));
  const displacement = (x: number, z: number): number =>
    ((wobbleNoise(x / ROAD_WOBBLE_WAVELENGTH, z / ROAD_WOBBLE_WAVELENGTH) +
      ROAD_WOBBLE_LONG_RATIO *
        wobbleNoise(x / ROAD_WOBBLE_WAVELENGTH_LONG + 53.1, z / ROAD_WOBBLE_WAVELENGTH_LONG + 17.7)) /
      (1 + ROAD_WOBBLE_LONG_RATIO)) *
    ROAD_WOBBLE_AMPLITUDE;

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
  let noGate = 0;
  let tooIndirect = 0;
  let expansions = 0;

  const built = createUnionFind(settlements.length);
  const gates: SettlementGate[][] = settlements.map(() => []);

  /** A settlement's interior, which roads keep out of so they end at its gates. */
  const interior = (site: SettlementSite) => ({ x: site.x, z: site.z, radius: Math.max(0, site.radius - GATE_ROAD_EXCLUSION_MARGIN) });

  /** The ground features stand on, which no road crosses (but for a feature's own track) - only
   *  those a route between `a` and `b` could reach at all, since every search step tests each one. */
  const footprints = features.filter((f) => f.footprint > 0).map((f) => ({ x: f.x, z: f.z, radius: f.footprint, id: f.id }));
  function footprintsNear(a: CellPoint, b: CellPoint, detourFactor: number, except = -1): { x: number; z: number; radius: number }[] {
    const midX = (a.x + b.x) / 2;
    const midZ = (a.z + b.z) / 2;
    const reach = (Math.hypot(b.x - a.x, b.z - a.z) * detourFactor) / 2 + ROAD_GRID;
    return footprints.filter((c) => c.id !== except && Math.hypot(c.x - midX, c.z - midZ) < reach + c.radius);
  }

  /** Whether a straight stretch keeps out of both settlements' interiors. */
  function clearOfInteriors(a: CellPoint, b: CellPoint, circles: { x: number; z: number; radius: number }[]): boolean {
    for (const c of circles) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      const u = lengthSq > 0 ? Math.min(1, Math.max(0, ((c.x - a.x) * dx + (c.z - a.z) * dz) / lengthSq)) : 0;
      if ((a.x + u * dx - c.x) ** 2 + (a.z + u * dz - c.z) ** 2 < c.radius * c.radius) return false;
    }
    return true;
  }

  /** Brings a road's surface to a gate's level over its first (or last) stretch, so two roads
   *  meeting at one gate - and the main street leaving it - all join at the same height. The first
   *  road to use a gate sets that level. */
  function joinAtGate(heights: number[], points: CellPoint[], gate: SettlementGate, atStart: boolean): void {
    const n = heights.length;
    const endIndex = atStart ? 0 : n - 1;
    if (gate.roadHeight === null) {
      gate.roadHeight = heights[endIndex];
      return;
    }
    let travelled = 0;
    for (let k = 0; k < n; k++) {
      const i = atStart ? k : n - 1 - k;
      if (k > 0) {
        const prev = atStart ? i - 1 : i + 1;
        travelled += Math.hypot(points[i].x - points[prev].x, points[i].z - points[prev].z);
      }
      if (travelled >= STREET_JOIN_BLEND * 2) break;
      const t = travelled / (STREET_JOIN_BLEND * 2);
      const keep = t * t * (3 - 2 * t);
      heights[i] = gate.roadHeight + (heights[i] - gate.roadHeight) * keep;
    }
  }

  function build(candidate: Candidate, kind: RoadKind = "link"): boolean {
    const fromSite = settlements[candidate.from];
    const toSite = settlements[candidate.to];
    // Each end is a gate on that settlement's edge, chosen by the ground there - not the centre.
    let fromGate = chooseGate(fromSite, toSite.x, toSite.z, gates[candidate.from], sampleTerrain);
    let toGate = chooseGate(toSite, fromSite.x, fromSite.z, gates[candidate.to], sampleTerrain);
    if (!fromGate || !toGate) {
      noGate++;
      return false;
    }
    // Routed between the gates' approach points; the straight run in to each gate is added after.
    let from = { x: fromGate.x, z: fromGate.z };
    let to = { x: toGate.x, z: toGate.z };
    const approach = (gate: SettlementGate): CellPoint => ({ x: gate.approachX, z: gate.approachZ });
    const interiors = [
      interior(fromSite),
      interior(toSite),
      ...footprintsNear(fromSite, toSite, kind === "link" ? ROAD_MAX_DETOUR_FACTOR : ROAD_RESCUE_DETOUR_FACTOR),
    ];
    const result = pathfinder.findPath({
      from: approach(fromGate),
      to: approach(toGate),
      zones: new Set([fromSite.areaId, toSite.areaId]),
      roadNodes,
      detourFactor: kind === "link" ? undefined : ROAD_RESCUE_DETOUR_FACTOR,
      avoid: interiors,
    });
    expansions += result.expansions;

    if (!result.nodes) {
      if (result.capped) capped++;
      else unreachable++;
      return false;
    }

    // A route that reaches another gate of either settlement on the way (typically by following a
    // road already built to it) is cut short there: it has arrived, and joins that gate's roads
    // instead of running on along the rim to the gate it was aimed at.
    let nodes = result.nodes;
    const otherGateNear = (siteGates: SettlementGate[], chosen: SettlementGate, point: CellPoint) =>
      siteGates.find(
        (g) =>
          g !== chosen &&
          (Math.hypot(g.x - point.x, g.z - point.z) < GATE_PASS_SNAP ||
            Math.hypot(g.approachX - point.x, g.approachZ - point.z) < GATE_PASS_SNAP),
      );
    for (let i = 0; i < nodes.length - 1; i++) {
      const gate = otherGateNear(gates[candidate.to], toGate, nodePoint(nodes[i]));
      if (gate && i >= 1) {
        nodes = nodes.slice(0, i + 1);
        toGate = gate;
        to = { x: gate.x, z: gate.z };
        break;
      }
    }
    for (let i = nodes.length - 1; i > 0; i--) {
      const gate = otherGateNear(gates[candidate.from], fromGate, nodePoint(nodes[i]));
      if (gate && i <= nodes.length - 2) {
        nodes = nodes.slice(i);
        fromGate = gate;
        from = { x: gate.x, z: gate.z };
        break;
      }
    }

    // Likewise a route whose end would snap onto an existing road that serves another of the
    // settlement's gates: it is arriving along that road, so it ends at that road's gate.
    const snappedOntoGate = (siteGates: SettlementGate[], chosen: SettlementGate, point: CellPoint) => {
      const snapped = snapIndex.snap(point);
      return snapped ? otherGateNear(siteGates, chosen, snapped) : undefined;
    };
    const arriving = snappedOntoGate(gates[candidate.to], toGate, to);
    if (arriving) {
      toGate = arriving;
      to = { x: arriving.x, z: arriving.z };
    }
    const leaving = snappedOntoGate(gates[candidate.from], fromGate, from);
    if (leaving) {
      fromGate = leaving;
      from = { x: leaving.x, z: leaving.z };
    }

    // The grid path snapped both ends to the lattice; the approach points are where they are, so
    // they replace the snapped ends before anything is smoothed.
    const raw = nodes.map(nodePoint);
    raw[0] = approach(fromGate);
    raw[raw.length - 1] = approach(toGate);

    const zones = new Set([fromSite.areaId, toSite.areaId]);
    // Straightening may not wander into a zone the route it replaces did not already visit -
    // otherwise a shortcut could cut a corner through the zone next door, undoing the containment
    // the off-zone penalty bought.
    for (const key of nodes) zones.add(pathfinder.zoneOfNode(key));
    const chordIsClear = (a: CellPoint, b: CellPoint): boolean =>
      clearOfInteriors(a, b, interiors) && pathfinder.chordIsClear(a, b, zones);

    // Straightened between the approach points only - a shortcut must not skip the straight run in
    // to a gate - then the gates go on the ends, and rounding turns the corner at each approach
    // point into a curve that ends in a straight run head-on into the gate.
    const straightened = [from, ...straighten(raw, chordIsClear, pathfinder.riverLengthAlong), to];
    // removeLoops after rounding: a hairpin tight enough that its arc crosses the line is rare but
    // real - measured at 6 across the network - and it is the same fix rivers already use.
    const snapped = snapToNetwork(roundCorners(straightened, chordIsClear), snapIndex, ROAD_SNAP_SAMPLE);
    // Loops removed AFTER simplification, not before: dropping points can itself cross a line over
    // itself, so the check has to see the line that will actually be drawn.
    const base = removeLoops(simplify(snapped, ROAD_SIMPLIFY_TOLERANCE));
    const length = polylineLength(base);

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
    for (const key of nodes) {
      roadNodes.add(key);
      nodeUses.set(key, (nodeUses.get(key) ?? 0) + 1);
    }
    // The wander is added last and the UNWOBBLED line is what later roads snap to, so a shared
    // stretch shares one underlying line and both copies then pick up the same displacement from
    // the same world position. Snapping to the wobbled line instead would wobble it twice.
    snapIndex.add(base);
    const points = removeLoops(
      simplify(
        wobble(
          base,
          displacement,
          ROAD_WOBBLE_SAMPLE_STEP,
          ROAD_WOBBLE_STRAIGHT_WINDOW,
          ROAD_WOBBLE_TURN_FADE_START,
          ROAD_WOBBLE_TURN_FADE_END,
          ROAD_WOBBLE_END_TAPER,
        ),
        ROAD_WOBBLE_SIMPLIFY_TOLERANCE,
      ),
    );
    // Only now that the road exists are its gates real.
    if (!gates[candidate.from].includes(fromGate)) gates[candidate.from].push(fromGate);
    if (!gates[candidate.to].includes(toGate)) gates[candidate.to].push(toGate);
    const heights = computeRoadProfile(points, sampleTerrain);
    joinAtGate(heights, points, fromGate, true);
    joinAtGate(heights, points, toGate, false);
    links.push({
      id: links.length,
      kind,
      from: candidate.from,
      to: candidate.to,
      points,
      heights,
      length,
      taperEnds: false,
    });
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

  // Last, each feature that wants one gets a track: from its entrance to the nearest road already
  // built, routed like any road, so it merges onto one where that is cheaper and later tracks can
  // join earlier ones. Its end is pulled onto the road it reaches and brought to that road's level.
  const builtField = createRoadField(links, ROAD_QUERY_RADIUS, ROAD_GRADE_END_TAPER);
  const spurLinks: RoadLink[] = [];
  /** The road's surface height at a point on it - the network's, or a track built since. */
  function roadHeightAt(point: CellPoint): number | null {
    let best = builtField.query(point.x, point.z);
    let height: number | null = Number.isFinite(best.distance) ? best.height : null;
    let bestDistance = best.distance;
    for (const spur of spurLinks) {
      const field = createRoadField([spur], ROAD_QUERY_RADIUS, ROAD_GRADE_END_TAPER);
      best = field.query(point.x, point.z);
      if (best.distance < bestDistance) {
        bestDistance = best.distance;
        height = best.height;
      }
    }
    return height;
  }
  const allInteriors = settlements.map(interior);
  let spurs = 0;
  let spursFailed = 0;
  for (const feature of features) {
    const road = feature.kind.road;
    const entrance = feature.entrance;
    if (!road || !entrance) continue;
    const approach = { x: entrance.approachX, z: entrance.approachZ };
    let target = -1;
    let targetDistance = Infinity;
    for (const key of roadNodes) {
      const point = nodePoint(key);
      const distance = Math.hypot(point.x - approach.x, point.z - approach.z);
      if (distance < targetDistance) {
        targetDistance = distance;
        target = key;
      }
    }
    if (target < 0 || targetDistance > road.maxLength) {
      spursFailed++;
      continue;
    }
    const targetPoint = nodePoint(target);
    const avoid = [
      ...allInteriors.filter((c) => Math.hypot(c.x - approach.x, c.z - approach.z) < targetDistance * ROAD_MAX_DETOUR_FACTOR + c.radius),
      ...footprintsNear(approach, targetPoint, ROAD_MAX_DETOUR_FACTOR, feature.id),
    ];
    const zones = new Set([feature.areaId, pathfinder.zoneOfNode(target)]);
    const result = pathfinder.findPath({ from: approach, to: targetPoint, zones, roadNodes, avoid });
    expansions += result.expansions;
    if (!result.nodes) {
      spursFailed++;
      continue;
    }
    const nodes = result.nodes;
    const raw = nodes.map(nodePoint);
    raw[0] = approach;
    // Onto the road itself, not the lattice node beside it.
    raw[raw.length - 1] = snapIndex.snap(targetPoint) ?? targetPoint;
    for (const key of nodes) zones.add(pathfinder.zoneOfNode(key));
    const chordIsClear = (a: CellPoint, b: CellPoint): boolean => clearOfInteriors(a, b, avoid) && pathfinder.chordIsClear(a, b, zones);
    const start = { x: entrance.x, z: entrance.z };
    const shaped = snapToNetwork(roundCorners([start, ...straighten(raw, chordIsClear, pathfinder.riverLengthAlong)], chordIsClear), snapIndex, ROAD_SNAP_SAMPLE);
    const base = removeLoops(simplify(shaped, ROAD_SIMPLIFY_TOLERANCE));
    if (base.length < 2) {
      spursFailed++;
      continue;
    }
    for (const key of nodes) {
      roadNodes.add(key);
      nodeUses.set(key, (nodeUses.get(key) ?? 0) + 1);
    }
    snapIndex.add(base);
    const points = removeLoops(
      simplify(
        wobble(
          base,
          displacement,
          ROAD_WOBBLE_SAMPLE_STEP,
          ROAD_WOBBLE_STRAIGHT_WINDOW,
          ROAD_WOBBLE_TURN_FADE_START,
          ROAD_WOBBLE_TURN_FADE_END,
          ROAD_WOBBLE_END_TAPER,
        ),
        ROAD_WOBBLE_SIMPLIFY_TOLERANCE,
      ),
    );
    const heights = computeRoadProfile(points, sampleTerrain);
    // Level with the feature's floor where it starts, and with the road where it ends.
    blendEnd(heights, points, entrance.height, true, SPUR_JOIN_BLEND);
    const joinHeight = roadHeightAt(points[points.length - 1]);
    if (joinHeight !== null) blendEnd(heights, points, joinHeight, false, SPUR_JOIN_BLEND * 2);
    const spur: RoadLink = {
      id: links.length + spurLinks.length,
      kind: "spur",
      from: -1,
      to: -1,
      featureId: feature.id,
      widthScale: road.width,
      points,
      heights,
      length: polylineLength(base),
      taperEnds: false,
    };
    spurLinks.push(spur);
    spurs++;
  }
  links.push(...spurLinks);

  let sharedNodes = 0;
  for (const uses of nodeUses.values()) if (uses > 1) sharedNodes++;

  return {
    links,
    gates,
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
      noGate,
      tooIndirect,
      spurs,
      spursFailed,
      expansions,
      samples: pathfinder.sampleCount(),
      sharedNodes,
    },
  };
}
