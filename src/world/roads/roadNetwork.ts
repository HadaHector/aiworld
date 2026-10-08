import { Delaunay } from "d3-delaunay";
import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { SettlementSite } from "../settlements/settlementSites";
import type { FeatureSite } from "../features/featureSites";
import { createRoadGraph, type RoadStretch } from "./roadGraph";
import { angleBetween, chooseGate, type SettlementGate } from "../settlements/gates";
import { GATE_PASS_SNAP, STREET_JOIN_BLEND } from "../settlements/settlementConfig";
import { collectPlaces, roadClassFor, wanted, type Place } from "./places";
import { simplify, removeLoops } from "../polyline";
import { straighten, roundCorners, snapToNetwork, createSnapIndex, wobble } from "./roadShaping";
import { createBaseNoise2D } from "../terrain/noise";
import { deriveSeed } from "../rng";
import { createRoadPathfinder, nodePoint } from "./roadPathfinder";
import {
  ROAD_EXTRA_LINK_FRACTION,
  ROAD_HALF_WIDTH,
  ROAD_NEAREST_CANDIDATES,
  ROAD_ON_THE_WAY,
  ROAD_THROUGH_MAX_DEPTH,
  ROAD_WANT_DISCOUNT,
  type RoadClassId,
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
} from "./roadConfig";

/** Why a road exists. Every link is routed the same way; this is which pass asked for it. A "spur"
 *  is a feature's track to the nearest road, for one none of whose planned roads could be built. */
export type RoadKind = "link" | "access" | "rescue" | "spur";

/**
 * One route the network was asked for: two places joined (or a feature to the nearest road). Not
 * what the ground is graded to - a route that runs along roads already there lays none of its own;
 * the road as laid is RoadNetwork.stretches.
 */
export interface RoadLink {
  id: number;
  kind: RoadKind;
  /** How grand a road it asks for on its own - see ROAD_CLASSES. A stretch it shares can be grander. */
  roadClass: RoadClassId;
  /** What it adds to the traffic of every stretch it runs along: its lesser place's importance. */
  weight: number;
  /** The places it joins (Place.id - a settlement's own id), the lower first; a spur's `to` is -1. */
  from: number;
  to: number;
  /** A spur's feature id (FeatureSite.id). */
  featureId?: number;
  /** The way it runs, gate to gate: the routed line before its wander, on the roads it shares. */
  points: CellPoint[];
  /** Length along that line, not the straight-line distance between its places. */
  length: number;
}

export interface RoadNetwork {
  links: RoadLink[];
  /**
   * The road as laid: every stretch once, between junctions and gates, each as grand as the traffic
   * of the routes along it (ROAD_CLASSES). This is what the ground is graded to and painted with.
   * Its heights are the road surface: the ground under it, smoothed along the road and held to a
   * walkable gradient - the level the terrain is brought to, not the level it has.
   */
  stretches: RoadStretch[];
  /** Per place id (a settlement's own id), the gates its roads arrive at - where a settlement's main
   *  streets start. */
  gates: SettlementGate[][];
  /** What the network joins - see places.ts. */
  places: Place[];
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
    /** Routes found running through a settlement on the way, and built by way of it instead. */
    throughSettlements: number;
    /** Roads built to a feature, as any other place's are. */
    featureLinks: number;
    /** Features whose planned roads all failed, given a track to the nearest road instead - and
     *  those that got none at all. */
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
  /** Place ids, the lower first. */
  from: number;
  to: number;
  length: number;
  /** What the plan sorts by - see planLinks. */
  cost: number;
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
 * A settlement standing on the way between two places - near enough the straight line between them
 * (within its own radius and ROAD_ON_THE_WAY), and between them along it - or null.
 */
function settlementBetween(a: Place, b: Place, places: Place[]): Place | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq <= 0) return null;
  for (const place of places) {
    if (place === a || place === b || !place.settlement) continue;
    const u = ((place.x - a.x) * dx + (place.z - a.z) * dz) / lengthSq;
    if (u <= 0 || u >= 1) continue;
    if (Math.hypot(a.x + dx * u - place.x, a.z + dz * u - place.z) < place.radius + ROAD_ON_THE_WAY) return place;
  }
  return null;
}

/** Whether a place takes only one road - a dead end, which hangs off the rest and never joins two
 *  of them. */
function isLeaf(place: Place): boolean {
  return place.links[1] <= 1;
}

/**
 * Which places to try to connect, as three lists: the links between places that can carry a road
 * on (`hubs`), the ones hanging a dead end off them (`leaves`), and every candidate pair of hubs
 * (`all`), for the rescue pass.
 *
 * Delaunay gives each place its natural neighbours without comparing every pair; a feature is also
 * offered its few nearest places, since its natural neighbours can be other features or nothing in
 * its reach. Each pair costs its length over its two places' importance (the root of their
 * product), less where either end wants the other's kind - so important places join first and most
 * directly, and small ones hang off them. Then, cheapest first:
 *
 *  - the spanning forest over the hubs, so everything reachable is connected;
 *  - each dead end, onto the cheapest hub with room for it;
 *  - each place still short of its fewest roads, from its cheapest candidates left;
 *  - the cheapest of the leftovers between hubs, so the network has loops and alternate routes
 *    rather than being a tree - which is what a real road network looks like.
 *
 * No place is given more than its most. Two dead ends are never joined to each other, which would
 * leave them a pair on their own. Links longer than ROAD_MAX_LINK_LENGTH (or either end's own
 * maxLength) are dropped before any of that; continents are separated by six times the cell
 * spacing, so this is also what stops the triangulation from proposing a route across open ocean -
 * which would otherwise spend its entire expansion budget failing.
 */
function planLinks(places: Place[]): { hubs: Candidate[]; leaves: Candidate[]; all: Candidate[] } {
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  const offer = (i: number, j: number): void => {
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const pairKey = lo * places.length + hi;
    if (i === j || seen.has(pairKey)) return;
    seen.add(pairKey);
    const a = places[lo];
    const b = places[hi];
    if (isLeaf(a) && isLeaf(b)) return;
    const length = Math.hypot(a.x - b.x, a.z - b.z);
    if (length > Math.min(ROAD_MAX_LINK_LENGTH, a.maxLength, b.maxLength)) return;
    // A road between them would run through it: they are joined by way of it instead.
    if (settlementBetween(a, b, places)) return;
    const cost = (length / Math.sqrt(a.importance * b.importance)) * (wanted(a, b) ? ROAD_WANT_DISCOUNT : 1);
    candidates.push({ from: lo, to: hi, length, cost });
  };
  if (places.length >= 3) {
    const delaunay = Delaunay.from(
      places,
      (p) => p.x,
      (p) => p.z,
    );
    for (let i = 0; i < places.length; i++) for (const j of delaunay.neighbors(i)) offer(i, j);
  } else if (places.length === 2) {
    offer(0, 1);
  }
  for (const place of places) {
    if (!place.feature) continue;
    places
      .filter((other) => other !== place)
      .map((other) => ({ other, distance: Math.hypot(other.x - place.x, other.z - place.z) }))
      .sort((p, q) => p.distance - q.distance || p.other.id - q.other.id)
      .slice(0, ROAD_NEAREST_CANDIDATES)
      .forEach(({ other }) => offer(place.id, other.id));
  }
  // Cheapest first, tie-broken by ids so the plan is the same for a given world rather than
  // depending on the sort being stable.
  candidates.sort((a, b) => a.cost - b.cost || a.from - b.from || a.to - b.to);

  const degree = new Array<number>(places.length).fill(0);
  const chosen = new Set<Candidate>();
  const fits = (c: Candidate): boolean => degree[c.from] < places[c.from].links[1] && degree[c.to] < places[c.to].links[1];
  const take = (c: Candidate): void => {
    chosen.add(c);
    degree[c.from]++;
    degree[c.to]++;
  };
  const hubPairs = candidates.filter((c) => !isLeaf(places[c.from]) && !isLeaf(places[c.to]));

  const union = createUnionFind(places.length);
  for (const c of hubPairs) {
    if (fits(c) && union.union(c.from, c.to)) take(c);
  }
  // Most important dead ends first, so they get the best of the hubs' room.
  const leafIds = places.filter(isLeaf).sort((a, b) => b.importance - a.importance || a.id - b.id);
  for (const leaf of leafIds) {
    const best = candidates.find((c) => (c.from === leaf.id || c.to === leaf.id) && fits(c));
    if (best) take(best);
  }
  for (const place of places) {
    for (const c of candidates) {
      if (degree[place.id] >= place.links[0]) break;
      if ((c.from === place.id || c.to === place.id) && !chosen.has(c) && fits(c)) take(c);
    }
  }
  const leftover = hubPairs.filter((c) => !chosen.has(c));
  let extras = Math.round(leftover.length * ROAD_EXTRA_LINK_FRACTION);
  for (const c of leftover) {
    if (extras <= 0) break;
    if (!fits(c)) continue;
    take(c);
    extras--;
  }

  // Built shortest first, so the short local links exist before the long ones and the long ones
  // have something to bundle onto - the build order is part of the topology, not an accident. The
  // dead ends are built after every hub link, so each can merge onto the roads already there.
  const byLength = (a: Candidate, b: Candidate) => a.length - b.length || a.from - b.from || a.to - b.to;
  const picked = [...chosen];
  return {
    hubs: picked.filter((c) => !isLeaf(places[c.from]) && !isLeaf(places[c.to])).sort(byLength),
    leaves: picked.filter((c) => isLeaf(places[c.from]) || isLeaf(places[c.to])).sort(byLength),
    all: [...hubPairs].sort(byLength),
  };
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

/** How far a new stretch's surface is eased to the level of the road it joins at a junction. */
const JUNCTION_JOIN_BLEND = 40;

// Laying a route (see `lay`). A junction is at its lattice node's anchor - where the road through it
// was laid. Only a node with none (a run too short to lay) has its road looked for, within this.
const LAY_JUNCTION_REACH = ROAD_GRID * 0.75;
// A junction this near a stretch's end is that end, rather than a split leaving a sliver.
const LAY_JUNCTION_END_SNAP = 6;
// A crossing this near a new run's own end is the junction or gate already there.
const LAY_CROSSING_END_CLEARANCE = 12;
// A new run shorter than this is not laid: it is a junction, not a road.
const LAY_MIN_RUN = 6;

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

/** How far a point is from a polyline. */
function distanceToLine(points: CellPoint[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const q = closestOnSegment({ x, z }, points[i], points[i + 1]);
    best = Math.min(best, Math.hypot(q.x - x, q.z - z));
  }
  return best;
}

/** The point of segment a-b nearest p. */
function closestOnSegment(p: CellPoint, a: CellPoint, b: CellPoint): CellPoint {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const u = lengthSq > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq)) : 0;
  return { x: a.x + dx * u, z: a.z + dz * u };
}

function polylineLength(points: CellPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return total;
}

/**
 * Builds the road network over the places: the settlements, and the features whose kind wants roads
 * (see places.ts) - planned together, so a feature is an end of a road as much as a village is.
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
  const places = collectPlaces(settlements, features);
  if (places.length < 2) {
    return {
      links: [],
      stretches: [],
      gates: places.map(() => []),
      places,
      stats: {
        candidates: 0, attempted: 0, built: 0, access: 0, rescued: 0, unreached: 0,
        withoutHomeAccess: 0, unreachable: 0, capped: 0, noGate: 0, tooIndirect: 0, throughSettlements: 0, featureLinks: 0, spurs: 0, spursFailed: 0,
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

  const { hubs, leaves, all } = planLinks(places);
  const pathfinder = createRoadPathfinder(sampleTerrain);
  const roadNodes = new Set<number>();
  const nodeUses = new Map<number, number>();
  // Geometry of the roads already built, so a new one can be pulled onto a stretch it shares with
  // them rather than rendering as a second road beside it.
  const snapIndex = createSnapIndex(ROAD_SNAP_DISTANCE);
  // The road as laid, each stretch once - see `lay`.
  const graph = createRoadGraph();
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
  let throughSettlements = 0;
  let expansions = 0;

  const built = createUnionFind(places.length);
  /** Per place, the gates its roads arrive at. A place with fixed gates commits each the first time
   *  a road uses it, as any gate is. */
  const gates: SettlementGate[][] = places.map(() => []);
  /** How many roads were built to each place. */
  const builtLinks = new Array<number>(places.length).fill(0);

  /** A settlement's interior, which roads keep out of so they end at its gates. */
  const interior = (place: Place) => ({ x: place.x, z: place.z, radius: place.avoidRadius });

  /** The ground features stand on, which no road crosses (but for a feature's own roads) - only
   *  those a route between `a` and `b` could reach at all, since every search step tests each one. */
  const footprints = features.filter((f) => f.footprint > 0).map((f) => ({ x: f.x, z: f.z, radius: f.footprint, id: f.id }));
  function footprintsNear(a: CellPoint, b: CellPoint, detourFactor: number, except: (number | undefined)[] = []): { x: number; z: number; radius: number }[] {
    const midX = (a.x + b.x) / 2;
    const midZ = (a.z + b.z) / 2;
    const reach = (Math.hypot(b.x - a.x, b.z - a.z) * detourFactor) / 2 + ROAD_GRID;
    return footprints.filter((c) => !except.includes(c.id) && Math.hypot(c.x - midX, c.z - midZ) < reach + c.radius);
  }

  /** The gate a road from a place toward a point arrives at: one of its fixed gates (the one facing
   *  that way best), or one found on its rim - see chooseGate. */
  function gateFor(place: Place, towardX: number, towardZ: number): SettlementGate | null {
    if (!place.fixedGates) return chooseGate(place, towardX, towardZ, gates[place.id], sampleTerrain);
    const direction = Math.atan2(towardZ - place.z, towardX - place.x);
    let best: SettlementGate | null = null;
    for (const gate of place.fixedGates) if (!best || angleBetween(gate.angle, direction) < angleBetween(best.angle, direction)) best = gate;
    return best;
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

  /** A lattice step, either way round - what roadEdges holds. */
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}>${b}` : `${b}>${a}`);
  /** Every lattice step a laid route has taken: a step on one of these is on a road already laid. */
  const roadEdges = new Set<string>();

  /**
   * Where each lattice node a road was laid through lies on that road: the nearest point of the road
   * as laid - straightened, rounded and wandering, so up to a grid step or more off the node. Set by
   * the first road through a node, and never moved: a later route that joins or leaves a road at a
   * node meets it exactly there.
   */
  const nodeAnchors = new Map<number, CellPoint>();

  /**
   * Lays a route's road: only where there is none yet. The route is split first, on the lattice it
   * was found on: a step it takes along a road already laid (a lattice step some earlier route took)
   * is shared, and lays nothing - the route adds its weight to that road's traffic. Its junctions are
   * the nodes where it leaves or joins a road, or touches one on the way, each at its anchor
   * (nodeAnchors). Each run of steps off the network, from a junction or its gate to the next, is
   * laid as a new stretch, and only then shaped - straightened, rounded and given its wander on its
   * own, between ends that stay put - so shaping can never pull a route off a road it shares, lay a
   * road beside one, or move a junction. Where a run crosses a road between nodes, both are cut
   * there. The stretches it meets are split at its junctions, so each has one set of routes along all
   * of it, and a junction is one level.
   *
   * `path` is the route as found: its first point a gate, then the lattice nodes (`keys`), then its
   * other gate - or, for a track to the nearest road, the point on that road. A step in from a gate
   * already used by a road along the same first node is shared too (`startShared`, `endShared`).
   */
  function lay(
    path: CellPoint[],
    keys: (number | null)[],
    route: number,
    weight: number,
    startGate: SettlementGate | null,
    endGate: SettlementGate | null,
    startShared: boolean,
    endShared: boolean,
    chordIsClear: (a: CellPoint, b: CellPoint) => boolean,
  ): void {
    const n = path.length;
    const shared = (i: number): boolean => {
      if (i === 0 && startGate) return startShared;
      if (i === n - 2 && endGate) return endShared;
      const a = keys[i];
      const b = keys[i + 1];
      return a !== null && b !== null && roadEdges.has(edgeKey(a, b));
    };
    const steps = Array.from({ length: n - 1 }, (_, i) => shared(i));
    const onRoad = (i: number): boolean => keys[i] !== null && roadNodes.has(keys[i]!);

    // The junctions: where the route leaves or joins a road, where it touches one between new steps,
    // and the end of a track that meets one. Found first, so the stretches its shared steps then
    // find are already cut to them.
    const junctions = new Map<number, { x: number; z: number; height: number }>();
    const junctionAt = (i: number): void => {
      const key = keys[i];
      const anchor = key !== null ? nodeAnchors.get(key) : undefined;
      const hit = anchor ? graph.nearest(anchor.x, anchor.z, 0.5) : graph.nearest(path[i].x, path[i].z, LAY_JUNCTION_REACH);
      if (hit) junctions.set(i, graph.splitAt(hit, LAY_JUNCTION_END_SNAP));
    };
    for (let i = 1; i < n - 1; i++) {
      if (steps[i - 1] !== steps[i] || (!steps[i - 1] && onRoad(i))) junctionAt(i);
    }
    if (!endGate && !steps[n - 2]) junctionAt(n - 1);

    // The shared steps: the route's weight on the stretch each runs along - judged between its two
    // nodes' anchors, and not beside a junction, where the stretch beyond it is as near.
    for (let i = 0; i < n - 1; i++) {
      if (!steps[i] || junctions.has(i) || junctions.has(i + 1)) continue;
      const a = (keys[i] !== null && nodeAnchors.get(keys[i]!)) || path[i];
      const b = (keys[i + 1] !== null && nodeAnchors.get(keys[i + 1]!)) || path[i + 1];
      const hit = graph.nearest((a.x + b.x) / 2, (a.z + b.z) / 2, LAY_JUNCTION_REACH);
      if (hit) graph.use(hit.stretch, route, weight);
    }

    // The new runs, each between two of: its gates and its junctions.
    let i = 0;
    while (i < n - 1) {
      if (steps[i]) {
        i++;
        continue;
      }
      const first = i;
      let last = i + 1;
      while (last < n - 1 && !steps[last] && !junctions.has(last)) last++;
      i = last;
      const laid = layRun(path, first, last, junctions, route, weight, first === 0 ? startGate : null, last === n - 1 ? endGate : null, chordIsClear);
      // Its nodes are anchored where it was laid.
      if (laid.length === 0) continue;
      for (let k = first; k <= last; k++) {
        const key = keys[k];
        if (key === null || nodeAnchors.has(key)) continue;
        let best: CellPoint | null = null;
        let bestDistance = Infinity;
        for (const points of laid) {
          for (let m = 0; m < points.length - 1; m++) {
            const q = closestOnSegment(path[k], points[m], points[m + 1]);
            const distance = Math.hypot(q.x - path[k].x, q.z - path[k].z);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = q;
            }
          }
        }
        if (best) nodeAnchors.set(key, best);
      }
    }

    // Its steps are road now.
    for (let k = 0; k < n - 1; k++) {
      const a = keys[k];
      const b = keys[k + 1];
      if (a !== null && b !== null) roadEdges.add(edgeKey(a, b));
    }
  }

  /**
   * Lays one run of a route off the network - path[first..last], each end a gate or a junction - as
   * new stretches: straightened and rounded between its ends, cut where it crosses a road, each piece
   * given its wander and its surface, eased to the level of what it meets at either end. Returns the
   * pieces' lines as laid.
   */
  function layRun(
    path: CellPoint[],
    first: number,
    last: number,
    junctions: Map<number, { x: number; z: number; height: number }>,
    route: number,
    weight: number,
    startGate: SettlementGate | null,
    endGate: SettlementGate | null,
    chordIsClear: (a: CellPoint, b: CellPoint) => boolean,
  ): CellPoint[][] {
    const run = path.slice(first, last + 1);
    const startJunction = junctions.get(first);
    const endJunction = junctions.get(last);
    if (startJunction) run[0] = { x: startJunction.x, z: startJunction.z };
    if (endJunction) run[run.length - 1] = { x: endJunction.x, z: endJunction.z };
    // Straightened between the gates' approach points only - a shortcut must not skip the straight
    // run in to a gate - and rounding turns the corner there into a curve that ends in a straight run
    // head-on into the gate. Its ends stay where they are.
    const body = run.slice(startGate ? 1 : 0, endGate ? run.length - 1 : run.length);
    const straightened = body.length >= 3 ? straighten(body, chordIsClear, pathfinder.riverLengthAlong) : body;
    const line = removeLoops(
      simplify(roundCorners([...(startGate ? [run[0]] : []), ...straightened, ...(endGate ? [run[run.length - 1]] : [])], chordIsClear), ROAD_SIMPLIFY_TOLERANCE),
    );
    if (line.length < 2 || polylineLength(line) < LAY_MIN_RUN) return [];

    // Where it crosses a road on the way, both are cut: a crossroads, at the old road's level.
    type End = { kind: "gate"; gate: SettlementGate } | { kind: "junction"; height: number } | { kind: "free" };
    const startEnd: End = startGate ? { kind: "gate", gate: startGate } : startJunction ? { kind: "junction", height: startJunction.height } : { kind: "free" };
    const endEnd: End = endGate ? { kind: "gate", gate: endGate } : endJunction ? { kind: "junction", height: endJunction.height } : { kind: "free" };
    const pieces: { points: CellPoint[]; start: End; end: End }[] = [];
    let current: CellPoint[] = [line[0]];
    let currentStart = startEnd;
    const clearOf = (point: CellPoint, other: CellPoint): boolean => Math.hypot(point.x - other.x, point.z - other.z) >= LAY_CROSSING_END_CLEARANCE;
    for (let k = 0; k < line.length - 1; k++) {
      for (const crossing of graph.crossings(line[k], line[k + 1])) {
        const point = { x: crossing.x, z: crossing.z };
        // Not at its own ends, which are junctions or gates already.
        if (!clearOf(point, line[0]) || !clearOf(point, line[line.length - 1]) || !clearOf(point, current[current.length - 1])) continue;
        const junction = graph.splitAt(crossing, LAY_JUNCTION_END_SNAP);
        current.push({ x: junction.x, z: junction.z });
        pieces.push({ points: current, start: currentStart, end: { kind: "junction", height: junction.height } });
        current = [{ x: junction.x, z: junction.z }];
        currentStart = { kind: "junction", height: junction.height };
      }
      current.push(line[k + 1]);
    }
    pieces.push({ points: current, start: currentStart, end: endEnd });

    const laid: CellPoint[][] = [];
    for (const piece of pieces) {
      if (piece.points.length < 2) continue;
      const points = removeLoops(
        simplify(
          wobble(piece.points, displacement, ROAD_WOBBLE_SAMPLE_STEP, ROAD_WOBBLE_STRAIGHT_WINDOW, ROAD_WOBBLE_TURN_FADE_START, ROAD_WOBBLE_TURN_FADE_END, ROAD_WOBBLE_END_TAPER),
          ROAD_WOBBLE_SIMPLIFY_TOLERANCE,
        ),
      );
      const heights = computeRoadProfile(points, sampleTerrain);
      for (const [end, atStart] of [[piece.start, true], [piece.end, false]] as [End, boolean][]) {
        if (end.kind === "gate") joinAtGate(heights, points, end.gate, atStart);
        else if (end.kind === "junction") blendEnd(heights, points, end.height, atStart, JUNCTION_JOIN_BLEND);
      }
      graph.use(graph.add(points, heights), route, weight);
      laid.push(points);
    }
    return laid;
  }

  /** The pairs of places a road has been built between. */
  const joined = new Set<string>();
  const pairKey = (a: number, b: number): string => `${Math.min(a, b)},${Math.max(a, b)}`;

  /**
   * A route found running through a settlement that is neither of its ends is not built: its two
   * places are joined by way of that settlement instead - a road to it and a road on from it, each
   * arriving and leaving at its gates, either one already built taken as it is. So no road ever runs
   * through a village it does not stop at. Where a leg cannot be built (no gate that way, no route),
   * the two places are joined after all, by a route kept out of that settlement - around it.
   */
  function buildThrough(candidate: Candidate, via: Place, kind: RoadKind, depth: number, around: Place[]): boolean {
    let ok = true;
    for (const end of [candidate.from, candidate.to]) {
      if (joined.has(pairKey(end, via.id))) continue;
      const leg = { from: Math.min(end, via.id), to: Math.max(end, via.id), length: Math.hypot(places[end].x - via.x, places[end].z - via.z), cost: 0 };
      ok = build(leg, kind, depth + 1) && ok;
    }
    return ok || build(candidate, kind, depth + 1, [...around, via]);
  }

  /** Builds a route between two places - see `lay`. `around` are settlements it must keep out of
   *  besides its own ends'. */
  function build(candidate: Candidate, kind: RoadKind = "link", depth = 0, around: Place[] = []): boolean {
    const fromSite = places[candidate.from];
    const toSite = places[candidate.to];
    // Each end is a gate on that place's edge, chosen by the ground there - not the centre.
    let fromGate = gateFor(fromSite, toSite.x, toSite.z);
    let toGate = gateFor(toSite, fromSite.x, fromSite.z);
    if (!fromGate || !toGate) {
      noGate++;
      return false;
    }
    // Routed between the gates' approach points; the straight run in to each gate is added after.
    let from = { x: fromGate.x, z: fromGate.z };
    let to = { x: toGate.x, z: toGate.z };
    const approach = (gate: SettlementGate): CellPoint => ({ x: gate.approachX, z: gate.approachZ });
    // A place with gates on its rim (a settlement, a compound) keeps its roads out of its middle
    // right up to them; a feature with a way in of its own (a quarry's open front) is entered.
    const interiors = [
      ...[fromSite, toSite].filter((place) => !place.fixedGates).map(interior),
      // One it goes around is kept clear by a road's width past its rim, not merely out of its middle.
      ...around.map((place) => ({ x: place.x, z: place.z, radius: place.radius + ROAD_HALF_WIDTH * 2 })),
      ...footprintsNear(fromSite, toSite, kind === "link" ? ROAD_MAX_DETOUR_FACTOR : ROAD_RESCUE_DETOUR_FACTOR, [fromSite.feature?.id, toSite.feature?.id]),
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

    // Through a settlement on the way - the line it would be laid along, not only its lattice nodes,
    // which can step past a village's edge: by way of it instead.
    if (depth < ROAD_THROUGH_MAX_DEPTH) {
      const via = places.find((place) => place.settlement && place !== fromSite && place !== toSite && distanceToLine(base, place.x, place.z) < place.radius);
      if (via) {
        throughSettlements++;
        return buildThrough(candidate, via, kind, depth, around);
      }
    }

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
    const weight = Math.min(fromSite.importance, toSite.importance);
    lay(
      [from, ...raw, to],
      [null, ...nodes, null],
      links.length,
      weight,
      fromGate,
      toGate,
      gates[candidate.from].includes(fromGate) && roadNodes.has(nodes[0]),
      gates[candidate.to].includes(toGate) && roadNodes.has(nodes[nodes.length - 1]),
      chordIsClear,
    );
    snapIndex.add(base);
    for (const key of nodes) {
      roadNodes.add(key);
      nodeUses.set(key, (nodeUses.get(key) ?? 0) + 1);
    }
    // Only now that the road exists are its gates real.
    if (!gates[candidate.from].includes(fromGate)) gates[candidate.from].push(fromGate);
    if (!gates[candidate.to].includes(toGate)) gates[candidate.to].push(toGate);
    links.push({
      id: links.length,
      kind,
      roadClass: roadClassFor(weight).id,
      from: candidate.from,
      to: candidate.to,
      weight,
      points: base,
      length,
    });
    built.union(candidate.from, candidate.to);
    joined.add(pairKey(candidate.from, candidate.to));
    builtLinks[candidate.from]++;
    builtLinks[candidate.to]++;
    if (fromSite.settlement && toSite.settlement) {
      homeAccess[candidate.from] ||= fromSite.areaId === toSite.areaId;
      homeAccess[candidate.to] ||= homeAccess[candidate.from];
    }
    return true;
  }

  for (const candidate of hubs) build(candidate);

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
        cost: 0,
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
  // two places the built roads left apart is retried with a far larger detour budget - a very
  // indirect road, but a settlement no road reaches at all is worse. Shortest first, and each
  // success is unioned immediately, so one rescue can close a whole component.
  let rescued = 0;
  for (const candidate of all) {
    if (built.connected(candidate.from, candidate.to)) continue;
    if (build(candidate, "rescue")) rescued++;
  }

  // Then the dead ends, each onto the network as it now stands - so a track merges onto the road it
  // meets on the way rather than running beside it.
  for (const candidate of leaves) build(candidate);

  const reached = new Set<number>();
  for (const link of links) {
    if (places[link.from].settlement) reached.add(link.from);
    if (places[link.to].settlement) reached.add(link.to);
  }
  let withoutHomeAccess = 0;
  for (let id = 0; id < settlements.length; id++) {
    if (!homeAccess[id] && (zoneMembers.get(settlements[id].areaId) ?? []).length > 1) withoutHomeAccess++;
  }

  // Last, a feature none of whose planned roads could be built - none in its reach, or none that
  // routed - still gets a track: from its way in to the nearest road already built, routed like any
  // road, so it merges onto one where that is cheaper and later tracks can join earlier ones. Its
  // end is pulled onto the road it reaches and brought to that road's level.
  const allInteriors = places.filter((place) => place.settlement).map(interior);
  let spurs = 0;
  let spursFailed = 0;
  for (const place of places) {
    const feature = place.feature;
    if (!feature || builtLinks[place.id] > 0) continue;
    // Its own way in - or, for one whose gates are found on its rim (a compound), the gate facing
    // the nearest road.
    let entrance = place.fixedGates?.[0] ?? null;
    if (!entrance) {
      let nearest: CellPoint | null = null;
      for (const key of roadNodes) {
        const point = nodePoint(key);
        if (!nearest || Math.hypot(point.x - place.x, point.z - place.z) < Math.hypot(nearest.x - place.x, nearest.z - place.z)) nearest = point;
      }
      entrance = nearest ? gateFor(place, nearest.x, nearest.z) : null;
    }
    if (!entrance) {
      spursFailed++;
      continue;
    }
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
    if (target < 0 || targetDistance > place.maxLength) {
      spursFailed++;
      continue;
    }
    const targetPoint = nodePoint(target);
    const avoid = [
      ...allInteriors.filter((c) => Math.hypot(c.x - approach.x, c.z - approach.z) < targetDistance * ROAD_MAX_DETOUR_FACTOR + c.radius),
      ...footprintsNear(approach, targetPoint, ROAD_MAX_DETOUR_FACTOR, [feature.id]),
      // Out of its own middle, if its gates are on its rim.
      ...(place.fixedGates ? [] : [interior(place)]),
    ];
    const zones = new Set([feature.areaId, pathfinder.zoneOfNode(target)]);
    // As a rescue is: it is this place's only road, and an indirect one beats none.
    const result = pathfinder.findPath({ from: approach, to: targetPoint, zones, roadNodes, avoid, detourFactor: ROAD_RESCUE_DETOUR_FACTOR });
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
    // Level with the feature's floor where it starts (its gate's level is set), and with the road
    // where it ends - the junction lay finds there.
    lay(
      [start, ...raw],
      [null, ...nodes],
      links.length,
      place.importance,
      entrance,
      null,
      gates[place.id].includes(entrance) && roadNodes.has(nodes[0]),
      false,
      chordIsClear,
    );
    snapIndex.add(base);
    for (const key of nodes) {
      roadNodes.add(key);
      nodeUses.set(key, (nodeUses.get(key) ?? 0) + 1);
    }
    links.push({
      id: links.length,
      kind: "spur",
      roadClass: roadClassFor(place.importance).id,
      from: place.id,
      to: -1,
      featureId: feature.id,
      weight: place.importance,
      points: base,
      length: polylineLength(base),
    });
    if (!gates[place.id].includes(entrance)) gates[place.id].push(entrance);
    spurs++;
  }

  let featureLinks = 0;
  for (const link of links) if (link.kind !== "spur" && (places[link.from].feature || places[link.to].feature)) featureLinks++;

  let sharedNodes = 0;
  for (const uses of nodeUses.values()) if (uses > 1) sharedNodes++;

  // Each stretch as grand as the traffic along it: where routes between important places run
  // together, the road they share is a highway.
  for (const stretch of graph.stretches) {
    const roadClass = roadClassFor(stretch.traffic);
    stretch.roadClass = roadClass.id;
    stretch.widthScale = roadClass.width;
  }

  return {
    links,
    stretches: graph.stretches,
    gates,
    places,
    stats: {
      candidates: all.length,
      attempted: hubs.length + leaves.length,
      built: links.length,
      access,
      rescued,
      unreached: settlements.length - reached.size,
      withoutHomeAccess,
      unreachable,
      capped,
      noGate,
      tooIndirect,
      throughSettlements,
      featureLinks,
      spurs,
      spursFailed,
      expansions,
      samples: pathfinder.sampleCount(),
      sharedNodes,
    },
  };
}
