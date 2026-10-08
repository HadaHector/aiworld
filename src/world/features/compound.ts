import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { TreeCover } from "../foliage/treeScatter";
import type { BuildingDef } from "../buildings/buildingTypes";
import type { RoadLine } from "../roads/roadField";
import type { SettlementGate } from "../settlements/gates";
import type { House } from "../settlements/settlementLayout";
import { measureBuilding } from "../buildings/buildingGenerator";
import { HOUSE_FLOOR_ABOVE_STREET, HOUSE_MAX_CUT_FILL } from "../settlements/settlementConfig";
import { smoothstep } from "../mathUtils";
import { deriveSeed, mulberry32 } from "../rng";
import type { CompoundDoor, CompoundSpec, FeatureKindDef, TrailDestination } from "./featureTypes";
import type { FeatureSite } from "./featureSites";
import type { RoadNetwork } from "../roads/roadNetwork";

/**
 * A compound (see FEATURES.md): a yard with buildings round it, entrances where its roads arrive and
 * trails leading off. It is sited in two halves, like a settlement. Before the roads, its spot is
 * chosen and everything about it that decides how big it is is rolled - the yard, the buildings
 * (measured, not built) - so the roads keep out of a circle that is sure to hold it. After the
 * roads, its gates known, it is laid out: lanes in from the gates, trails out, the buildings round
 * the rim.
 */

/** A compound's building as rolled: a variant of a building, measured - its width along the yard's
 *  rim and its depth back from it. */
export interface CompoundBuilding {
  building: BuildingDef;
  variant: number;
  width: number;
  depth: number;
  required: boolean;
  doorTo: CompoundDoor;
}

/** A compound as sited, before the roads. */
export interface CompoundSite {
  x: number;
  z: number;
  /** The ground at its centre. */
  height: number;
  yardRadius: number;
  /** The circle it stands within: its gates are on it, and other roads keep out of it. */
  radius: number;
  /** Required first, then largest - the order they are placed in. */
  buildings: CompoundBuilding[];
  trails: { to: TrailDestination; length: number }[];
  /** Seeds its layout, so it is the same however the roads came out. */
  seed: number;
}

/** A way into a compound: a road's gate, or a trail's start, and the direction it leaves in. */
export interface CompoundEntrance {
  kind: "road" | "trail";
  angle: number;
}

/** A compound laid out. Positions are world positions. */
export interface CompoundLayout {
  featureId: number;
  kindId: string;
  x: number;
  z: number;
  /** The yard: a round of `radius` at `y` - and the ground levelled with it out to `level`, under
   *  the buildings' fronts, corners and all, so each is come up to on the level. */
  yard: { x: number; z: number; y: number; radius: number; level: number };
  entrances: CompoundEntrance[];
  /** In from each gate to the yard's rim - narrow road lines, graded from the road's level to the
   *  yard's. */
  lanes: RoadLine[];
  /** Out from the yard's rim, on the ground as it lies. */
  trails: RoadLine[];
  buildings: House[];
  /** Buildings rolled that found no room - a required one among them is a fault in the siting. */
  dropped: number;
  droppedRequired: number;
}

/** A building variant is drawn from this many, as a settlement's houses are. */
const BUILDING_VARIANT_SPACE = 1 << 20;
/** Between the yard's rim and the buildings' fronts: trodden ground before their doors. */
const SETBACK = 5;
/** The yard's level ground reaches this far past the buildings' fronts - their furthest corners - under them. */
const LEVEL_UNDER_FRONTS = 1;
/** Kept between two buildings along the rim. */
const BUILDING_GAP = 3;
/** Past the buildings' furthest corners, inside the compound's circle - where its gates stand: a
 *  road's level ground (ROAD_HALF_WIDTH) and the few metres past it where a building's pad still
 *  gives way to it, so a road arriving along the circle at a gate never grades a building's ground. */
const RING_MARGIN = 14;
/** A lane is this wide next to a road (1), and kept this far clear either side of its middle. */
const LANE_WIDTH = 0.6;
const LANE_CLEARANCE = 8;
/** A trail is this wide next to a road (1), and keeps this far from any road: it leads out into the
 *  wood, and stops short of a road rather than meet it. A trail left shorter than TRAIL_MIN_LENGTH
 *  past the compound's circle is not made. */
const TRAIL_WIDTH = 0.35;
const TRAIL_ROAD_CLEARANCE = 25;
const TRAIL_MIN_LENGTH = 15;
/** How many directions a trail is tried in. */
const TRAIL_DIRECTIONS = 72;
/** Room on the rim kept for each road a compound may take and each trail: no more of the rim than
 *  this share of it is built on, so a building never has to stand in a gate's way. */
const RIM_FILL = 0.8;
/** A yard that cannot hold its buildings grows, but never past this times its largest roll; then
 *  its least buildings are left out instead. */
const YARD_MAX_GROWTH = 1.6;
/** How steps round the rim a building is tried at. */
const RING_STEPS = 180;

const COMPOUND_LAYOUT_SALT = 905;

function roll(range: [number, number], rng: () => number): number {
  return range[0] + (range[1] - range[0]) * rng();
}

/** Half the angle a width takes up on a circle of radius r. */
function halfAngle(width: number, r: number): number {
  return Math.atan2(width / 2, r);
}

/**
 * What a compound of this kind will hold, rolled before it is sited: its yard, its buildings
 * (measured) and its trails, and from them the circle it needs. The rim is checked to hold every
 * building with room for its entrances; a yard too small for them grows, and past that the least
 * of its buildings that are not required are left out.
 */
export function planCompound(
  kind: FeatureKindDef,
  worldSeed: number,
  rng: () => number,
): Omit<CompoundSite, "x" | "z" | "height"> {
  const spec = kind.compound!;
  let yardRadius = roll(spec.yard.radius, rng);
  const buildings: CompoundBuilding[] = [];
  for (const entry of spec.buildings) {
    const count = entry.count[0] + Math.floor(rng() * (entry.count[1] - entry.count[0] + 1));
    for (let k = 0; k < count; k++) {
      if (rng() >= entry.chance) continue;
      const variant = Math.floor(rng() * BUILDING_VARIANT_SPACE);
      const { halfWidth, halfDepth } = measureBuilding(entry.building, worldSeed, variant);
      buildings.push({ building: entry.building, variant, width: halfWidth * 2, depth: halfDepth * 2, required: entry.required, doorTo: entry.doorTo });
    }
  }
  // Required first, then largest: the order they are placed in, so a required one never finds the
  // rim taken by one that is not.
  buildings.sort((a, b) => Number(b.required) - Number(a.required) || b.width - a.width);
  const trails = spec.trails.flatMap((trail) => (rng() < trail.chance ? [{ to: trail.to, length: roll(trail.length, rng) }] : []));

  const entrances = (kind.road?.links[1] ?? 0) + trails.length;
  const needed = (): number => {
    const r = yardRadius + SETBACK;
    let angle = entrances * 2 * halfAngle(LANE_CLEARANCE * 2, r);
    for (const b of buildings) angle += 2 * halfAngle(b.width + BUILDING_GAP, r);
    return angle;
  };
  const maxYard = spec.yard.radius[1] * YARD_MAX_GROWTH;
  while (needed() > Math.PI * 2 * RIM_FILL) {
    if (yardRadius < maxYard) {
      yardRadius = Math.min(maxYard, yardRadius + 1);
      continue;
    }
    const optional = buildings.map((b) => !b.required).lastIndexOf(true);
    if (optional < 0) break;
    buildings.splice(optional, 1);
  }
  // Out to the furthest of the buildings' back corners - a wide one's reach past its back's middle.
  const furthest = Math.max(yardRadius + SETBACK, ...buildings.map((b) => Math.hypot(yardRadius + SETBACK + b.depth, b.width / 2)));
  return {
    yardRadius,
    radius: furthest + RING_MARGIN,
    buildings,
    trails,
    seed: Math.floor(rng() * 0x7fffffff),
  };
}

// Where a compound may go: dry ground, clear of water and zone borders (whose hills it has no
// business on), as level across its whole circle as its kind asks.
const MIN_HEIGHT = 3;
const MAX_LAKE_FACTOR = 0.02;
const RIVER_CLEARANCE = 15;
const BORDER_CLEARANCE = 30;
/** How far the ground under it may stand off a plane through it - a ridge or a dip across it - as a
 *  share of its radius: a big camp's circle may be as uneven as a small one's, in proportion. */
const MAX_UNEVENNESS = 0.1;
/** Tree cover is judged out to this times its radius: the wood it stands in, not the clearing. */
const COVER_REACH = 1.8;

/** A candidate's height and area and how good it is (0-1), or null where the compound cannot go. */
export function evaluateCompound(
  x: number,
  z: number,
  spec: CompoundSpec,
  radius: number,
  sampleTerrain: TerrainSampler,
  treeCover: TreeCover,
): { height: number; areaId: number; score: number } | null {
  const here = sampleTerrain(x, z);
  if (!here.isLand || here.height < MIN_HEIGHT || here.lakeFactor > MAX_LAKE_FACTOR) return null;
  if (here.riverGap < radius + RIVER_CLEARANCE || here.areaBorderGap < radius + BORDER_CLEARANCE) return null;

  // The ground across its circle: its grade (the plane through it) and how far it stands off that.
  const ring: { dx: number; dz: number; h: number }[] = [];
  for (const share of [0.5, 1]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const dx = Math.cos(a) * radius * share;
      const dz = Math.sin(a) * radius * share;
      const sample = sampleTerrain(x + dx, z + dz);
      if (!sample.isLand || sample.height < MIN_HEIGHT || sample.lakeFactor > MAX_LAKE_FACTOR) return null;
      ring.push({ dx, dz, h: sample.height });
    }
  }
  const outer = ring.slice(8);
  const gx = (outer[0].h - outer[4].h) / (2 * radius);
  const gz = (outer[2].h - outer[6].h) / (2 * radius);
  const grade = Math.hypot(gx, gz);
  if (grade < spec.site.grade[0] || grade > spec.site.grade[1]) return null;
  const unevenness = Math.max(...ring.map((p) => Math.abs(p.h - (here.height + gx * p.dx + gz * p.dz))));
  const maxUnevenness = MAX_UNEVENNESS * radius;
  if (unevenness > maxUnevenness) return null;

  // The wood round it.
  const slope = grade / Math.sqrt(1 + grade * grade);
  let cover = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const px = x + Math.cos(a) * radius * COVER_REACH;
    const pz = z + Math.sin(a) * radius * COVER_REACH;
    const sample = sampleTerrain(px, pz);
    cover += treeCover(px, pz, { height: sample.height, surfaceHeight: sample.height, slope, sample }) / 8;
  }
  if (cover < spec.site.cover[0]) return null;

  const level = 1 - unevenness / maxUnevenness;
  const wooded = spec.site.cover[1] > spec.site.cover[0] ? Math.min(1, (cover - spec.site.cover[0]) / (spec.site.cover[1] - spec.site.cover[0])) : 1;
  const nearWater = spec.site.nearWater;
  const score =
    nearWater === null
      ? 0.45 * level + 0.55 * wooded
      : 0.35 * level + 0.45 * wooded + 0.2 * (1 - smoothstep(radius + RIVER_CLEARANCE, nearWater, here.riverGap));
  return { height: here.height, areaId: here.primaryAreaId, score };
}

/** Distance past a compound's yard, 0 inside it. */
export function compoundGap(site: CompoundSite, x: number, z: number): number {
  return Math.max(0, Math.hypot(x - site.x, z - site.z) - site.yardRadius);
}

/** The arcs of the rim already taken - by entrances and by buildings - as [centre, half-width]. */
type Arc = [number, number];

function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

function overlaps(arcs: Arc[], centre: number, half: number): boolean {
  return arcs.some(([c, h]) => angleBetween(c, centre) < h + half);
}

/** How far a point is from a polyline. */
function distanceToLine(points: CellPoint[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const u = lengthSq > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0;
    best = Math.min(best, Math.hypot(x - a.x - u * dx, z - a.z - u * dz));
  }
  return best;
}

/**
 * Lays a compound out, once its roads are built. `gates` are where they arrived, on its circle.
 *
 * 1. The yard: level at the ground's mean height over it.
 * 2. A lane in from each gate to the yard's rim.
 * 3. Its buildings, required first and then largest, round the rim, fronts to the yard, each where
 *    the ground under it needs the least cut and fill and clear of the lanes and of each other. One
 *    that fits nowhere within HOUSE_MAX_CUT_FILL is tried again without that limit if it is
 *    required, and is left out otherwise.
 * 4. Each trail out through the rim that leaves, as far from the roads' gates as it can be and
 *    clear of every road round it - so the felling lies away from the way in - stopping short of
 *    any road it would still meet.
 */
export function layoutCompound(
  featureId: number,
  kind: FeatureKindDef,
  site: CompoundSite,
  gates: SettlementGate[],
  roadLines: RoadLine[],
  sampleTerrain: TerrainSampler,
): CompoundLayout {
  const rng = mulberry32(deriveSeed(site.seed, COMPOUND_LAYOUT_SALT));
  const { x, z, yardRadius } = site;
  const rim = yardRadius + SETBACK;

  // The yard's level: the ground's mean over it.
  let sum = sampleTerrain(x, z).height;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    sum += sampleTerrain(x + Math.cos(a) * yardRadius * 0.7, z + Math.sin(a) * yardRadius * 0.7).height;
  }
  const y = sum / 9;
  const rimPoint = (angle: number, r: number): CellPoint => ({ x: x + Math.cos(angle) * r, z: z + Math.sin(angle) * r });

  // The gates' lanes.
  const taken: Arc[] = [];
  const entrances: CompoundEntrance[] = [];
  const lanes: RoadLine[] = [];
  const laneHalf = halfAngle(LANE_CLEARANCE * 2, rim);
  for (const gate of gates) {
    const angle = Math.atan2(gate.z - z, gate.x - x);
    entrances.push({ kind: "road", angle });
    taken.push([angle, laneHalf]);
    const inner = rimPoint(angle, yardRadius);
    lanes.push({ points: [{ x: gate.x, z: gate.z }, inner], heights: [gate.roadHeight ?? sampleTerrain(gate.x, gate.z).height, y], widthScale: LANE_WIDTH, taperEnds: false });
  }
  // Buildings round the rim.
  const buildings: House[] = [];
  let dropped = 0;
  let droppedRequired = 0;
  const floor = y + HOUSE_FLOOR_ABOVE_STREET;
  const start = rng() * Math.PI * 2;
  for (const building of site.buildings) {
    const half = halfAngle(building.width + BUILDING_GAP, rim);
    const centreDistance = rim + building.depth / 2;
    let best: { angle: number; cost: number } | null = null;
    let bestAny: { angle: number; cost: number } | null = null;
    for (let step = 0; step < RING_STEPS; step++) {
      const angle = start + (step / RING_STEPS) * Math.PI * 2;
      if (overlaps(taken, angle, half)) continue;
      const cx = x + Math.cos(angle) * centreDistance;
      const cz = z + Math.sin(angle) * centreDistance;
      // Along the rim (u) and out from the yard (w).
      const ux = -Math.sin(angle);
      const uz = Math.cos(angle);
      const wx = Math.cos(angle);
      const wz = Math.sin(angle);
      let worst = 0;
      let total = 0;
      let dry = true;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]]) {
        const sample = sampleTerrain(cx + ux * (building.width / 2) * a + wx * (building.depth / 2) * b, cz + uz * (building.width / 2) * a + wz * (building.depth / 2) * b);
        if (!sample.isLand || sample.lakeFactor > MAX_LAKE_FACTOR) dry = false;
        const off = Math.abs(sample.height - floor);
        worst = Math.max(worst, off);
        total += off;
      }
      if (!dry) continue;
      // A little chance in it, so two camps on the same ground do not come out alike.
      const cost = total / 9 + rng() * 0.3;
      if (!bestAny || cost < bestAny.cost) bestAny = { angle, cost };
      if (worst <= HOUSE_MAX_CUT_FILL && (!best || cost < best.cost)) best = { angle, cost };
    }
    const chosen = best ?? (building.required ? bestAny : null);
    if (!chosen) {
      dropped++;
      if (building.required) droppedRequired++;
      continue;
    }
    taken.push([chosen.angle, half]);
    buildings.push({
      x: x + Math.cos(chosen.angle) * centreDistance,
      z: z + Math.sin(chosen.angle) * centreDistance,
      y: floor,
      // Its front to the yard's middle.
      frontX: -Math.cos(chosen.angle),
      frontZ: -Math.sin(chosen.angle),
      width: building.width,
      depth: building.depth,
      building: building.building,
      variant: building.variant,
    });
  }

  // The yard's level ground: out under the buildings' fronts - a wide one's corners stand further
  // out than its middle, its front straight and the yard round.
  const level = Math.max(rim, ...buildings.map((b) => Math.hypot(rim, b.width / 2))) + LEVEL_UNDER_FRONTS;

  // Then the trails, through the rim the gates and the buildings leave.
  const trails: RoadLine[] = [];
  const reach = site.radius + Math.max(0, ...site.trails.map((t) => t.length)) + TRAIL_ROAD_CLEARANCE;
  const nearbyRoads = roadLines.filter((line) => distanceToLine(line.points, x, z) < reach);
  const roadClearance = (p: CellPoint): number => Math.min(Infinity, ...nearbyRoads.map((line) => distanceToLine(line.points, p.x, p.z)));
  for (const trail of site.trails) {
    // Out from the rim, wandering a little.
    const bend = (rng() - 0.5) * 0.6;
    const pathFor = (angle: number): CellPoint[] => {
      const steps = Math.max(2, Math.ceil(trail.length / 10));
      return Array.from({ length: steps + 1 }, (_, k) => {
        const t = k / steps;
        return rimPoint(angle + bend * t * t, yardRadius + trail.length * t);
      });
    };
    let best: { angle: number; path: CellPoint[]; clear: boolean; spread: number; clearance: number } | null = null;
    for (let k = 0; k < TRAIL_DIRECTIONS; k++) {
      const angle = (k / TRAIL_DIRECTIONS) * Math.PI * 2;
      if (overlaps(taken, angle, laneHalf)) continue;
      const path = pathFor(angle);
      const clearance = Math.min(...path.map(roadClearance));
      const spread = taken.length === 0 ? Math.PI : Math.min(...taken.map(([c]) => angleBetween(c, angle)));
      const candidate = { angle, path, clear: clearance >= TRAIL_ROAD_CLEARANCE, spread, clearance };
      // Clear of the roads first; then as far from the entrances as it can be - or, with no
      // direction clear, as far from the roads as it can get.
      if (!best || (candidate.clear && !best.clear) || (candidate.clear === best.clear && (candidate.clear ? candidate.spread > best.spread : candidate.clearance > best.clearance))) best = candidate;
    }
    if (!best) continue;
    // Stopping short of a road it would still meet.
    const end = best.path.findIndex((p) => roadClearance(p) < TRAIL_ROAD_CLEARANCE);
    const points = end < 0 ? best.path : best.path.slice(0, end);
    if (points.length < 2 || Math.hypot(points[points.length - 1].x - x, points[points.length - 1].z - z) < site.radius + TRAIL_MIN_LENGTH) continue;
    entrances.push({ kind: "trail", angle: best.angle });
    taken.push([best.angle, laneHalf]);
    // On the ground as it lies - but starting at the yard's level, where it leaves it.
    const heights = points.map((p, k) => (k === 0 ? y : sampleTerrain(p.x, p.z).height));
    trails.push({ points, heights, widthScale: TRAIL_WIDTH, taperEnds: false });
  }

  return { featureId, kindId: kind.id, x, z, yard: { x, z, y, radius: yardRadius, level }, entrances, lanes, trails, buildings, dropped, droppedRequired };
}

/** Every compound laid out, round the gates its roads arrived at (RoadNetwork.gates, by place). */
export function layoutCompounds(features: FeatureSite[], roads: Pick<RoadNetwork, "places" | "gates" | "stretches">, sampleTerrain: TerrainSampler): CompoundLayout[] {
  const placeOf = new Map(roads.places.flatMap((place) => (place.feature ? [[place.feature, place.id] as const] : [])));
  return features.flatMap((feature) => {
    if (!feature.compound) return [];
    const placeId = placeOf.get(feature);
    const gates = placeId === undefined ? [] : roads.gates[placeId];
    return [layoutCompound(feature.id, feature.kind, feature.compound, gates, roads.stretches, sampleTerrain)];
  });
}
