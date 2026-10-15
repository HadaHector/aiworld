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
import type { BoundaryOpeningSpec, CompoundDoor, CompoundPlace, CompoundSpec, FeatureKindDef, TrailDestination } from "./featureTypes";
import type { FeatureSite } from "./featureSites";
import type { RoadNetwork } from "../roads/roadNetwork";
import { ROAD_HALF_WIDTH } from "../roads/roadConfig";
import { arrangeGroup, arrangeProp, setDown, type Arranged, type PlacedProp } from "../props/propGroups";
import type { PropDef, Spill } from "../props/propTypes";
import { generateLine, type LineEnd, type LineRun } from "../props/propGenerator";
import type { BuildingModel } from "../buildings/buildingTypes";
import type { Vec3 } from "../buildings/buildingGeometry";

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
  place: CompoundPlace;
  /** Where its door is on its footprint's edge, in its own frame: x along its front, z out of it. */
  door: { x: number; z: number };
}

/** A compound as sited, before the roads. */
export interface CompoundSite {
  x: number;
  z: number;
  /** The ground at its centre. */
  height: number;
  yardRadius: number;
  /** A `rows` one's yard's width (its yardRadius half its length); 0 for the others. */
  yardWidth: number;
  /** The circle it stands within: its gates are on it, and other roads keep out of it. */
  radius: number;
  /** Required first, then largest - the order they are placed in. */
  buildings: CompoundBuilding[];
  trails: { to: TrailDestination; length: number }[];
  /** Seeds its layout, so it is the same however the roads came out. */
  seed: number;
  /** A roadside compound's road: the angles (from its middle) it leaves the yard at either way -
   *  its two ways in, kept free as a ring's gates are. Empty for one the roads come to. */
  roadAngles: number[];
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
  /** Its props, set down by their anchors - their heights filled in once the ground is final (see
   *  settleProps). */
  props: PlacedProp[];
  /** Props (or groups) rolled that found no room, by id. */
  droppedProps: string[];
  /** How its level ground blends back to the ground round it (its kind's `pads`). */
  padBlend: { slope: number; min: number; max: number };
  /** The ground under and round each of its buildings and props painted (its kind's pads.spill), or
   *  none. */
  padSpill: Spill | null;
  /** Its boundary's runs, between its buildings and openings (see WallRun) - none without one. */
  walls: WallRun[];
}

/**
 * A run of a compound's boundary: its wall (a line prop) along `points` - their ground `heights`
 * filled in once the ground is final (see settleOnGround) - and how each end is finished (see LineRun):
 * `breach`, where it has fallen.
 */
export interface WallRun {
  prop: PropDef;
  variant: number;
  points: CellPoint[];
  heights: number[];
  ends: [LineEnd, LineEnd];
  breach: boolean;
  /** For one not on the ground - a bridge - its width and how low its piers reach (see LineRun). */
  width?: number;
  base?: number;
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
): Omit<CompoundSite, "x" | "z" | "height" | "roadAngles"> {
  // (A `rows` one returns early, below, once its buildings are measured.)
  const spec = kind.compound!;
  let yardRadius = roll(spec.yard.radius, rng);
  const buildings: CompoundBuilding[] = [];
  for (const entry of spec.buildings) {
    const count = entry.count[0] + Math.floor(rng() * (entry.count[1] - entry.count[0] + 1));
    for (let k = 0; k < count; k++) {
      if (rng() >= entry.chance) continue;
      const variant = Math.floor(rng() * BUILDING_VARIANT_SPACE);
      const { halfWidth, halfDepth, door } = measureBuilding(entry.building, worldSeed, variant);
      buildings.push({ building: entry.building, variant, width: halfWidth * 2, depth: halfDepth * 2, required: entry.required, doorTo: entry.doorTo, place: entry.place, door });
    }
  }
  // Required first, then largest: the order they are placed in, so a required one never finds the
  // rim taken by one that is not.
  buildings.sort((a, b) => Number(b.required) - Number(a.required) || b.width - a.width);
  const trails = spec.trails.flatMap((trail) => (rng() < trail.chance ? [{ to: trail.to, length: roll(trail.length, rng) }] : []));

  // A `rows` one: its yard long and narrow, a building at each end - its circle round them all.
  if (spec.arrangement === "rows") {
    const yardWidth = roll(spec.yard.width ?? spec.yard.radius, rng);
    // (Turned to face its door to the yard, a building may lie either way: its longer side counts.)
    const reach = (place: CompoundPlace): number => Math.max(0, ...buildings.filter((b) => b.place === place).map((b) => Math.max(b.depth, b.width) + ROWS_END_GAP));
    const along = yardRadius + Math.max(reach("head"), reach("foot"));
    const across = yardWidth / 2 + ROWS_WALL_SET_BACK + reach("side");
    return { yardRadius, yardWidth, radius: Math.hypot(along, across) + RING_MARGIN, buildings, trails, seed: Math.floor(rng() * 0x7fffffff) };
  }

  // A road running through takes the rim twice, as two gates would.
  const entrances = (spec.arrangement === "roadside" ? 2 : (kind.road?.links[1] ?? 0)) + trails.length;
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
    yardWidth: 0,
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
  worldSeed: number,
): CompoundLayout {
  if (site.roadAngles.length > 0) return layoutRoadside(featureId, kind, site, roadLines, sampleTerrain, worldSeed);
  if (kind.compound!.arrangement === "rows") return layoutRows(featureId, kind, site, gates, roadLines, sampleTerrain, worldSeed);
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

  const boundary = kind.compound!.boundary ? layoutBoundary(kind.compound!.boundary, worldSeed, rng, buildings, lanes, trails, sampleTerrain, circleOutline(x, z, rim + GATE_SET_BACK)) : { walls: [], gates: [] };
  const { props, droppedProps } = placeProps(kind.compound!, site, worldSeed, rng, buildings, lanes, trails, nearbyRoads, sampleTerrain, { x, z, yardRadius, rim }, boundary);
  return { featureId, kindId: kind.id, x, z, yard: { x, z, y, radius: yardRadius, level }, entrances, lanes, trails, buildings, dropped, droppedRequired, props, droppedProps, padBlend: { slope: kind.compound!.pads.slope, min: kind.compound!.pads.blend[0], max: kind.compound!.pads.blend[1] }, padSpill: kind.compound!.pads.spill, walls: boundary.walls };
}

/** A boundary is followed this finely - for where buildings and openings break it. */
const BOUNDARY_STEP = 0.25;
/** A boundary keeps this clear of a building's footprint (eaves and all - so its end stands under
 *  them, by the building's wall) - more than the half step its runs reach past their last step. */
const BOUNDARY_BUILDING_GAP = 0.2;
/** An opening `anywhere` keeps this far from any other opening and from a building. */
const OPENING_SPACING = 4;
/** A way in with no opening of its own kind is left this wide open: a lane, a trail. */
const ROAD_GAP = 5;
const TRAIL_GAP = 2.5;
/** A wall variant is drawn from this many. */
const WALL_VARIANT_SPACE = 1 << 20;

/** A closed outline - a boundary's line round a compound: its length, where it is `s` metres round
 *  (from its first point, wrapping), which way it runs there and which way is out, where round it
 *  its points are and which of them are corners (turning by more than OUTLINE_CORNER), and where a
 *  line crosses it. */
interface Outline {
  length: number;
  at(s: number): { x: number; z: number; dx: number; dz: number; outX: number; outZ: number };
  vertices: number[];
  corners: number[];
  crossing(line: CellPoint[]): number | null;
}

const OUTLINE_CORNER = 0.25;

function outlineOf(points: CellPoint[]): Outline {
  const n = points.length;
  const lengths = [0];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    lengths.push(lengths[i] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const length = lengths[n];
  const cx = points.reduce((sum, p) => sum + p.x, 0) / n;
  const cz = points.reduce((sum, p) => sum + p.z, 0) / n;
  const wrap = (s: number): number => ((s % length) + length) % length;
  const turn = (i: number): number => {
    const a = points[(i - 1 + n) % n], p = points[i], b = points[(i + 1) % n];
    const ux = p.x - a.x, uz = p.z - a.z, vx = b.x - p.x, vz = b.z - p.z;
    return Math.abs(Math.atan2(ux * vz - uz * vx, ux * vx + uz * vz));
  };
  return {
    length,
    vertices: lengths.slice(0, n),
    corners: lengths.slice(0, n).filter((_, i) => turn(i) > OUTLINE_CORNER),
    at(s) {
      const w = wrap(s);
      let i = 0;
      while (i < n - 1 && lengths[i + 1] <= w) i++;
      const a = points[i];
      const b = points[(i + 1) % n];
      const l = Math.max(1e-6, lengths[i + 1] - lengths[i]);
      const t = (w - lengths[i]) / l;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const dx = (b.x - a.x) / l;
      const dz = (b.z - a.z) / l;
      // Out: square to it, away from the middle.
      const flip = -dz * (x - cx) + dx * (z - cz) >= 0 ? 1 : -1;
      return { x, z, dx, dz, outX: -dz * flip, outZ: dx * flip };
    },
    crossing(line) {
      for (let j = 0; j + 1 < line.length; j++) {
        const p = line[j];
        const q = line[j + 1];
        for (let i = 0; i < n; i++) {
          const a = points[i];
          const b = points[(i + 1) % n];
          const rx = q.x - p.x, rz = q.z - p.z, sx = b.x - a.x, sz = b.z - a.z;
          const den = rx * sz - rz * sx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((a.x - p.x) * sz - (a.z - p.z) * sx) / den;
          const u = ((a.x - p.x) * rz - (a.z - p.z) * rx) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return lengths[i] + u * (lengths[i + 1] - lengths[i]);
        }
      }
      return null;
    },
  };
}

/** A circle as an outline: a polygon of short sides. */
function circleOutline(x: number, z: number, radius: number): CellPoint[] {
  const sides = Math.max(32, Math.ceil((2 * Math.PI * radius) / 1));
  return Array.from({ length: sides }, (_, k) => ({ x: x + Math.cos((k / sides) * Math.PI * 2) * radius, z: z + Math.sin((k / sides) * Math.PI * 2) * radius }));
}

/**
 * A compound's boundary (see CompoundBoundarySpec), round its `outline` (any closed line - a circle
 * through a ring's buildings' sides, a rectangle round a churchyard), its buildings standing in it
 * as part of it: an opening across each lane and each trail where it crosses the outline (a gate
 * set in it, as its kind's openings say, or a plain gap), then its openings `anywhere`, each where
 * it fits, spread out; then its wall in runs between them all, each end finished to what it meets -
 * a gate or a gap (a free end), a building (the same), a breach (broken). A breach is a run of its
 * own, of fallen wall.
 */
function layoutBoundary(
  spec: NonNullable<CompoundSpec["boundary"]>,
  worldSeed: number,
  rng: () => number,
  buildings: House[],
  lanes: RoadLine[],
  trails: RoadLine[],
  sampleTerrain: TerrainSampler,
  outlinePoints: CellPoint[],
  anywhereAllowed: ((p: CellPoint) => boolean) | null = null,
): { walls: WallRun[]; gates: PlacedProp[] } {
  const outline = outlineOf(outlinePoints);
  const steps = Math.max(16, Math.ceil(outline.length / BOUNDARY_STEP));
  const step = outline.length / steps;
  const sOf = (i: number): number => i * step;
  // What each step is: the wall (-1), a building in it (-2), or an opening (its index).
  const BUILT = -2;
  const WALL = -1;
  const at: number[] = new Array(steps).fill(WALL);
  const boxes = buildings.map((house): Box => ({ x: house.x, z: house.z, ax: house.frontZ, az: -house.frontX, hw: house.width / 2 + BOUNDARY_BUILDING_GAP, hd: house.depth / 2 + BOUNDARY_BUILDING_GAP }));
  for (let i = 0; i < steps; i++) {
    const p = outline.at(sOf(i));
    const ground = sampleTerrain(p.x, p.z);
    if (!ground.isLand || ground.lakeFactor > 0.02 || boxes.some((box) => lineToBox([p, p], box) === 0)) at[i] = BUILT;
  }
  /** The step nearest a place round it, and how many steps a width takes either side of it. */
  const stepOf = (s: number): number => ((Math.round(s / step) % steps) + steps) % steps;
  // Its steps either side of the middle one: the opening reaching to within a step short of its
  // width's edge, so a wall's end meets a gate's post rather than leave a slot beside it.
  const halfSteps = (width: number): number => Math.max(0, Math.floor(width / 2 / step - 0.5));
  /** How far apart two places round it are, the short way. */
  const apart = (a: number, b: number): number => {
    const d = Math.abs(a - b) % outline.length;
    return Math.min(d, outline.length - d);
  };

  interface Opening {
    spec: BoundaryOpeningSpec | null;
    kind: "gate" | "gap" | "breach";
    centre: number;
    half: number;
    s: number;
    arranged: Arranged | null;
  }
  const openings: Opening[] = [];
  const open = (opening: Omit<Opening, "centre" | "half">, width: number): void => {
    const centre = stepOf(opening.s);
    const half = halfSteps(width);
    const index = openings.length;
    openings.push({ ...opening, centre, half });
    for (let k = -half; k <= half; k++) {
      const i = (centre + k + steps) % steps;
      if (at[i] !== BUILT) at[i] = index;
    }
  };
  const widthOf = (spec: BoundaryOpeningSpec, arranged: Arranged | null): number => (arranged ? arranged.box.hw * 2 : spec.width[0] + (spec.width[1] - spec.width[0]) * rng());
  const arrange = (spec: BoundaryOpeningSpec | null): Arranged | null => (spec?.kind === "gate" && spec.gate ? arrangeProp(spec.gate, worldSeed, rng) : null);
  // Where the lanes and trails cross it.
  for (const [lines, kind, gap] of [[lanes, "road", ROAD_GAP], [trails, "trail", TRAIL_GAP]] as const) {
    const opening = spec.openings.find((o) => o.at === kind) ?? null;
    for (const line of lines) {
      const s = outline.crossing(line.points);
      if (s === null) continue;
      const arranged = arrange(opening);
      open({ spec: opening, kind: opening?.kind ?? "gap", s, arranged }, opening ? widthOf(opening, arranged) : gap);
    }
  }
  // Then those anywhere: where the whole of one is wall - clear of its corners, too - as far from
  // the others as it can be.
  for (const opening of spec.openings) {
    if (opening.at !== "anywhere") continue;
    const count = opening.count[0] + Math.floor(rng() * (opening.count[1] - opening.count[0] + 1));
    for (let n = 0; n < count; n++) {
      if (rng() >= opening.chance) continue;
      const arranged = arrange(opening);
      const width = widthOf(opening, arranged);
      const half = halfSteps(width) + halfSteps(OPENING_SPACING * 2);
      let best: { s: number; score: number } | null = null;
      for (let i = 0; i < steps; i += 2) {
        let clear = true;
        for (let k = -half; k <= half && clear; k++) clear = at[(i + k + steps) % steps] === WALL;
        if (!clear) continue;
        const s = sOf(i);
        if (anywhereAllowed && !anywhereAllowed(outline.at(s))) continue;
        if (outline.corners.some((corner) => apart(corner, s) < width / 2 + 1)) continue;
        const spread = Math.min(outline.length / 2, ...openings.map((o) => apart(o.s, s)));
        const score = spread + rng() * 2;
        if (!best || score > best.score) best = { s, score };
      }
      if (!best) continue;
      open({ spec: opening, kind: opening.kind, s: best.s, arranged }, width);
    }
  }

  // The gates set in their openings, facing out.
  const gates: PlacedProp[] = [];
  openings.forEach((opening, n) => {
    if (!opening.arranged) return;
    const p = outline.at(opening.s);
    gates.push(...setDown(opening.arranged, p.x, p.z, p.outX, p.outZ, -1 - n));
  });

  // The runs: each stretch of steps that is all wall - or all one breach - from where it starts.
  const walls: WallRun[] = [];
  const kindOf = (i: number): "wall" | "breach" | "stop" => (at[i] === WALL ? "wall" : at[i] >= 0 && openings[at[i]].kind === "breach" ? "breach" : "stop");
  const endFor = (i: number, self: "wall" | "breach"): LineEnd => {
    const kind = kindOf((i + steps) % steps);
    if (self === "wall") return kind === "breach" ? "broken" : "free";
    return "free";
  };
  // Start where one kind gives way to another, so no run wraps past the start.
  let start = 0;
  while (start < steps && kindOf(start) === kindOf((start - 1 + steps) % steps)) start++;
  const closed = start === steps;
  if (closed) start = 0;
  // Each step stands for the half step either side of it; the outline's own points kept.
  const pointsFor = (from: number, count: number): CellPoint[] => {
    const s0 = sOf(from - 0.5);
    const s1 = s0 + count * step;
    const inside = outline.vertices.flatMap((corner) => {
      let c = corner;
      while (c <= s0) c += outline.length;
      return c < s1 - 1e-6 ? [c] : [];
    });
    return [s0, ...inside.sort((a, b) => a - b), s1].map((s) => {
      const p = outline.at(s);
      return { x: p.x, z: p.z };
    });
  };
  let i = 0;
  while (i < steps) {
    const first = (start + i) % steps;
    const kind = kindOf(first);
    let length = 1;
    while (i + length < steps && kindOf((start + i + length) % steps) === kind && (kind !== "breach" || at[(start + i + length) % steps] === at[first])) length++;
    if (kind !== "stop") {
      walls.push({
        prop: spec.wall,
        variant: Math.floor(rng() * WALL_VARIANT_SPACE),
        points: pointsFor(first, closed ? steps : length),
        heights: [],
        ends: closed ? ["join", "join"] : [endFor(first - 1, kind), endFor(first + length, kind)],
        breach: kind === "breach",
      });
    }
    i += length;
  }
  return { walls, gates };
}

/** A `rows` compound's head and foot buildings stand this far past its yard's ends, fronts to it;
 *  its wall this far out past its yard's long sides. */
const ROWS_END_GAP = 1.5;
const ROWS_WALL_SET_BACK = 1.2;
/** Its graves keep this far either side of the path down its middle, and this far along it either
 *  side of the way in across it. */
const GRAVE_PATH_CLEARANCE = 1.4;
const GRAVE_WAY_IN_CLEARANCE = 2.5;
/** A grave is dug nowhere steeper than this (rise over run), along it or across it. */
const GRAVE_MAX_SLOPE = 0.35;
/** And this far from a building - off the bank its level ground blends back by. */
const GRAVE_BUILDING_CLEARANCE = 4;
/** Its other openings keep this far along its long sides from either end - their paths in clear of
 *  the head's and foot's buildings. */
const ROWS_OPENING_END_CLEARANCE = 5;
/** A path's points are this far apart, each on the ground; a churchyard's paths are this wide next
 *  to a road (1). */
const PATH_STEP = 3;
const ROWS_PATH_WIDTH = 0.22;

/**
 * Lays a `rows` compound out (a churchyard): a long yard on the ground as it lies, its way in
 * across one long side - toward its road's gate - and its length along that side.
 *
 * 1. Its `head` building at one end of the yard, its `foot` building at the other, fronts to it;
 *    `side` ones outside its far long side, their backs to it.
 * 2. A path down its middle from the head's door to the foot's; its road's lane up to its long
 *    side, and a path on from there to the middle one.
 * 3. Its graves in rows either side of the middle path (see GravesSpec) - the oldest at its head.
 * 4. Its boundary round the yard, through its head and foot buildings - each part of it - opened
 *    where the way in crosses it.
 * 5. Its props, by their anchors, among it all.
 */
function layoutRows(featureId: number, kind: FeatureKindDef, site: CompoundSite, gates: SettlementGate[], roadLines: RoadLine[], sampleTerrain: TerrainSampler, worldSeed: number): CompoundLayout {
  const spec = kind.compound!;
  const rng = mulberry32(deriveSeed(site.seed, COMPOUND_LAYOUT_SALT));
  const { x, z } = site;
  const halfLength = site.yardRadius;
  const halfWidth = site.yardWidth / 2;
  // Across it (v) toward its way in, and along it (u) toward its head.
  const inAngle = gates.length > 0 ? Math.atan2(gates[0].z - z, gates[0].x - x) : rng() * Math.PI * 2;
  const vx = Math.cos(inAngle);
  const vz = Math.sin(inAngle);
  const flip = rng() < 0.5 ? 1 : -1;
  const ux = -vz * flip;
  const uz = vx * flip;
  /** A point `a` along it (toward its head) and `b` across it (toward its way in) from its middle. */
  const P = (a: number, b: number): CellPoint => ({ x: x + ux * a + vx * b, z: z + uz * a + vz * b });
  const ground = (p: CellPoint): number => sampleTerrain(p.x, p.z).height;
  /** A path on the ground between two points, a point every PATH_STEP metres. */
  const path = (from: CellPoint, to: CellPoint, widthScale: number, fromHeight?: number): RoadLine => {
    const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / PATH_STEP));
    const points = Array.from({ length: n + 1 }, (_, k) => ({ x: from.x + ((to.x - from.x) * k) / n, z: from.z + ((to.z - from.z) * k) / n }));
    return { points, heights: points.map((p, k) => (k === 0 && fromHeight !== undefined ? fromHeight : ground(p))), widthScale, taperEnds: false };
  };

  // Its buildings: at its ends, turned so their doors face it, wherever in them their doors are (a
  // chapel's may be in its side) - and by its far side, backs to its wall.
  const buildings: House[] = [];
  /** Each building's door, a step out before it, and how far the building reaches along the yard
   *  from its middle. */
  const doors: { place: CompoundPlace; at: CellPoint; reach: number }[] = [];
  let dropped = 0;
  let droppedRequired = 0;
  const sides = { side: 0 };
  for (const building of site.buildings) {
    // One at each end at most.
    if (building.place !== "side" && doors.some((d) => d.place === building.place)) {
      dropped++;
      if (building.required) droppedRequired++;
      continue;
    }
    let cx: number, cz: number, fx: number, fz: number;
    let reach = building.depth / 2;
    // Which way its door faces, in its own frame (x across its front, z out of it): out of its
    // front, its back, or a side.
    const { door } = building;
    const [ox, oz] = door.z >= (building.depth / 2) * 0.5 ? [0, 1] : door.z <= -(building.depth / 2) * 0.5 ? [0, -1] : [Math.sign(door.x) || 1, 0];
    let tx = 0;
    let tz = 0;
    if (building.place === "side") {
      const a = (rng() - 0.5) * halfLength + sides.side * (building.width + BUILDING_GAP);
      const p = P(a, -(halfWidth + ROWS_WALL_SET_BACK + 0.5 + building.depth / 2));
      [cx, cz, fx, fz] = [p.x, p.z, -vx, -vz];
      sides.side++;
    } else {
      const sign = building.place === "head" ? 1 : -1;
      // Its door toward the yard: its front turned so its door's own way out points there (its +x
      // is (fz, -fx) to its front).
      [tx, tz] = [-ux * sign, -uz * sign];
      [fx, fz] = oz === 1 ? [tx, tz] : oz === -1 ? [-tx, -tz] : ox === 1 ? [-tz, tx] : [tz, -tx];
      reach = Math.abs(fx * ux + fz * uz) * (building.depth / 2) + Math.abs(fz * ux - fx * uz) * (building.width / 2);
      const p = P(sign * (halfLength + ROWS_END_GAP + reach), 0);
      [cx, cz] = [p.x, p.z];
    }
    // On the mean of the ground under it.
    let sum = 0;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) sum += sampleTerrain(cx + fz * (building.width / 2) * a + fx * (building.depth / 2) * b, cz - fx * (building.width / 2) * a + fz * (building.depth / 2) * b).height;
    const house: House = { x: cx, z: cz, y: sum / 5 + HOUSE_FLOOR_ABOVE_STREET, frontX: fx, frontZ: fz, width: building.width, depth: building.depth, building: building.building, variant: building.variant };
    buildings.push(house);
    // Its door, and the ground a step out before it.
    const at = { x: cx + fz * door.x + fx * door.z + tx * PATH_DOOR_GAP, z: cz - fx * door.x + fz * door.z + tz * PATH_DOOR_GAP };
    doors.push({ place: building.place, at, reach });
  }

  // Its paths: down its middle, door to door; its road's lane to its long side, and on in.
  const headDoor = doors.find((d) => d.place === "head")?.at ?? P(halfLength, 0);
  const footDoor = doors.find((d) => d.place === "foot")?.at ?? P(-halfLength, 0);
  const lanes: RoadLine[] = [path(headDoor, footDoor, ROWS_PATH_WIDTH)];
  const outside = P(0, halfWidth + ROWS_WALL_SET_BACK + 3);
  const entrances: CompoundEntrance[] = [];
  if (gates.length > 0) {
    const gate = gates[0];
    lanes.push(path({ x: gate.x, z: gate.z }, outside, LANE_WIDTH, gate.roadHeight ?? undefined));
    entrances.push({ kind: "road", angle: inAngle });
  }
  lanes.push(path(outside, P(0, 0), ROWS_PATH_WIDTH));

  // Its wall: round the yard, its ends through its head and foot buildings.
  const endReach = (place: CompoundPlace): number => halfLength + ROWS_END_GAP + (doors.find((d) => d.place === place)?.reach ?? 0);
  const [head, foot] = [endReach("head"), endReach("foot")];
  const across = halfWidth + ROWS_WALL_SET_BACK;
  const outline = [P(head, across), P(-foot, across), P(-foot, -across), P(head, -across)];
  // (Its other openings in its long sides, along its yard - their paths in run straight across to
  // the middle one.)
  const alongSide = (p: CellPoint): boolean => Math.abs((p.x - x) * ux + (p.z - z) * uz) <= halfLength - ROWS_OPENING_END_CLEARANCE && Math.abs(Math.abs((p.x - x) * vx + (p.z - z) * vz) - across) < 0.5;
  const boundary = spec.boundary ? layoutBoundary(spec.boundary, worldSeed, rng, buildings, lanes, [], sampleTerrain, outline, alongSide) : { walls: [], gates: [] };
  // A path in from each of its other gates - a wicket in its side - to the middle one, so no grave
  // stands in a gate's way.
  for (const gate of boundary.gates) {
    if (lanes.some((line) => distanceToLine(line.points, gate.x, gate.z) < 2)) continue;
    const a = (gate.x - x) * ux + (gate.z - z) * uz;
    const from = { x: gate.x + gate.frontX * 1.5, z: gate.z + gate.frontZ * 1.5 };
    lanes.push(path(from, P(a, 0), ROWS_PATH_WIDTH));
  }

  // Its graves.
  const props: PlacedProp[] = [];
  const graves = spec.graves;
  const houseBoxes = buildings.map((house): Box => ({ x: house.x, z: house.z, ax: house.frontZ, az: -house.frontX, hw: house.width / 2 + GRAVE_BUILDING_CLEARANCE, hd: house.depth / 2 + GRAVE_BUILDING_CLEARANCE }));
  if (graves && graves.markers.length > 0) {
    const [along, across] = graves.spacing;
    let group = 1000;
    for (const side of [-1, 1]) {
      for (let row = 0; ; row++) {
        const b = side * (GRAVE_PATH_CLEARANCE + across / 2 + row * across);
        if (Math.abs(b) + across / 2 > halfWidth) break;
        for (let a = halfLength - along / 2; a >= -halfLength + along / 2; a -= along) {
          if (side > 0 && Math.abs(a) < GRAVE_WAY_IN_CLEARANCE + along / 2) continue;
          if (rng() >= graves.fill) continue;
          // Which marker: one whose stretch of the yard holds it, by weight.
          const t = (halfLength - a) / (2 * halfLength);
          const fitting = graves.markers.filter((m) => t >= m.from && t <= m.to);
          const total = fitting.reduce((sum, m) => sum + m.weight, 0);
          if (total <= 0) continue;
          let pick = rng() * total;
          const marker = fitting.find((m) => (pick -= m.weight) < 0) ?? fitting[fitting.length - 1];
          const arranged = marker.placed.kind === "prop" ? arrangeProp(marker.placed.prop, worldSeed, rng) : arrangeGroup(marker.placed.group, worldSeed, rng);
          if (arranged.members.length === 0) continue;
          // A little out of line, as graves are.
          const p = P(a + (rng() - 0.5) * 0.25, b + (rng() - 0.5) * 0.2);
          const turn = (rng() - 0.5) * 0.08;
          const fx = -(ux * Math.cos(turn) - uz * Math.sin(turn));
          const fz = -(uz * Math.cos(turn) + ux * Math.sin(turn));
          const { cx, cz, hw, hd } = arranged.box;
          const box: Box = { x: p.x + fz * cx + fx * cz, z: p.z - fx * cx + fz * cz, ax: fz, az: -fx, hw, hd };
          if (houseBoxes.some((house) => boxGap(house, box) < 0) || lanes.some((line) => lineToBox(line.points, box) < 0.6)) continue;
          // Not on ground too steep to dig a grave in, either way.
          const rise = (dx: number, dz: number, reach: number): number => Math.abs(ground({ x: p.x + dx * reach, z: p.z + dz * reach }) - ground({ x: p.x - dx * reach, z: p.z - dz * reach })) / (2 * reach);
          if (Math.max(rise(ux, uz, 1.2), rise(vx, vz, 0.6)) > GRAVE_MAX_SLOPE) continue;
          props.push(...setDown(arranged, p.x, p.z, fx, fz, group++));
        }
      }
    }
  }


  const nearbyRoads = roadLines.filter((line) => distanceToLine(line.points, x, z) < site.radius + TRAIL_ROAD_CLEARANCE);
  const placed = placeProps(spec, site, worldSeed, rng, buildings, lanes, [], nearbyRoads, sampleTerrain, { x, z, yardRadius: Math.min(halfLength, halfWidth), rim: halfWidth }, { walls: boundary.walls, gates: [...boundary.gates, ...props] });
  return {
    featureId,
    kindId: kind.id,
    x,
    z,
    yard: { x, z, y: ground({ x, z }), radius: halfLength, level: 0 },
    entrances,
    lanes,
    trails: [],
    buildings,
    dropped,
    droppedRequired,
    props: placed.props,
    droppedProps: placed.droppedProps,
    padBlend: { slope: spec.pads.slope, min: spec.pads.blend[0], max: spec.pads.blend[1] },
    padSpill: spec.pads.spill,
    walls: boundary.walls,
  };
}

/** A roadside compound's buildings stand back from its road this far past its level ground (times
 *  its width), fronts to it - and along it no further than its circle less this. */
const ROADSIDE_SETBACK = 4;
const ROADSIDE_SPAN_MARGIN = 12;
/** And a path to each one's door, this wide next to a road (1). */
const PATH_WIDTH = 0.4;
/** How far apart along its road a roadside building is tried. */
const ROADSIDE_STEP = 2;

/**
 * Lays a roadside compound out (a coaching inn): no yard of its own - its buildings stand along both
 * sides of the road it was sited on, fronts to it, set back past the road's level ground, each where
 * the ground under it needs the least cut and fill and as near the middle as it can; and a narrow
 * path from the road to each one's door. Its props are set down about them (see placeProps). Its
 * "yard" is the strip between the road and the fronts.
 */
function layoutRoadside(featureId: number, kind: FeatureKindDef, site: CompoundSite, roadLines: RoadLine[], sampleTerrain: TerrainSampler, worldSeed: number): CompoundLayout {
  const rng = mulberry32(deriveSeed(site.seed, COMPOUND_LAYOUT_SALT));
  const { x, z } = site;
  const nearbyRoads = roadLines.filter((line) => distanceToLine(line.points, x, z) < site.radius + TRAIL_ROAD_CLEARANCE);
  const [way] = waysOut(nearbyRoads, [], x, z, true);
  const entrances: CompoundEntrance[] = site.roadAngles.map((angle) => ({ kind: "road", angle }));
  const buildings: House[] = [];
  const lanes: RoadLine[] = [];
  let dropped = 0;
  let droppedRequired = 0;
  const padBlend = { slope: kind.compound!.pads.slope, min: kind.compound!.pads.blend[0], max: kind.compound!.pads.blend[1] };
  if (!way) {
    return { featureId, kindId: kind.id, x, z, yard: { x, z, y: site.height, radius: 0, level: 0 }, entrances, lanes, trails: [], buildings, dropped: site.buildings.length, droppedRequired: site.buildings.filter((b) => b.required).length, props: [], droppedProps: [], padBlend, padSpill: kind.compound!.pads.spill, walls: [] };
  }
  const road = way.line;
  const setback = ROAD_HALF_WIDTH * (road.widthScale ?? 1) + ROADSIDE_SETBACK;
  const span = Math.max(10, site.radius - ROADSIDE_SPAN_MARGIN);
  const heightAt = (s: number): number => {
    const { lengths } = way;
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < s) i++;
    const t = Math.max(0, Math.min(1, (s - lengths[i - 1]) / Math.max(1e-6, lengths[i] - lengths[i - 1])));
    return road.heights[i - 1] + (road.heights[i] - road.heights[i - 1]) * t;
  };
  const footprints: Box[] = [];
  for (const building of site.buildings) {
    type Spot = { house: House; box: Box; s: number; cost: number };
    let best: Spot | null = null;
    let bestAny: Spot | null = null;
    const first = rng() < 0.5 ? 1 : -1;
    for (let t = -span; t <= span; t += ROADSIDE_STEP) {
      const s = way.start + t;
      const p = alongWay(way, s);
      if (!p) continue;
      for (const side of [first, -first]) {
        // Out from the road on this side, its front back to it.
        const nx = -p.dz * side;
        const nz = p.dx * side;
        const out = setback + building.depth / 2;
        const cx = p.x + nx * out;
        const cz = p.z + nz * out;
        const box: Box = { x: cx, z: cz, ax: p.dx, az: p.dz, hw: building.width / 2, hd: building.depth / 2 };
        if (footprints.some((other) => boxGap(other, box) < BUILDING_GAP)) continue;
        if (nearbyRoads.some((line) => lineToBox(line.points, box) < ROAD_HALF_WIDTH * (line.widthScale ?? 1) + 1)) continue;
        let total = 0;
        let worst = 0;
        let dry = true;
        const samples: number[] = [];
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]]) {
          const sample = sampleTerrain(cx + p.dx * box.hw * a + nx * box.hd * b, cz + p.dz * box.hw * a + nz * box.hd * b);
          if (!sample.isLand || sample.lakeFactor > MAX_LAKE_FACTOR) dry = false;
          samples.push(sample.height);
        }
        if (!dry) continue;
        const ground = samples.reduce((sum, h) => sum + h, 0) / samples.length;
        for (const h of samples) {
          worst = Math.max(worst, Math.abs(h - ground));
          total += Math.abs(h - ground);
        }
        // Level ground first, then near the middle, and a little chance.
        const cost = total / samples.length + Math.abs(t) * 0.02 + rng() * 0.3;
        const house: House = { x: cx, z: cz, y: ground + HOUSE_FLOOR_ABOVE_STREET, frontX: -nx, frontZ: -nz, width: building.width, depth: building.depth, building: building.building, variant: building.variant };
        const candidate = { house, box, s, cost };
        if (!bestAny || cost < bestAny.cost) bestAny = candidate;
        if (worst <= HOUSE_MAX_CUT_FILL && (!best || cost < best.cost)) best = candidate;
      }
    }
    const chosen = best ?? (building.required ? bestAny : null);
    if (!chosen) {
      dropped++;
      if (building.required) droppedRequired++;
      continue;
    }
    buildings.push(chosen.house);
    footprints.push(chosen.box);
    lanes.push(pathToDoor(way, chosen.s, chosen.house, building.door, heightAt));
  }
  const { props, droppedProps } = placeProps(kind.compound!, site, worldSeed, rng, buildings, lanes, [], nearbyRoads, sampleTerrain, { x, z, yardRadius: 0, rim: 0 });
  return { featureId, kindId: kind.id, x, z, yard: { x, z, y: site.height, radius: 0, level: 0 }, entrances, lanes, trails: [], buildings, dropped, droppedRequired, props, droppedProps, padBlend, padSpill: kind.compound!.pads.spill, walls: [] };
}

/** A path ends this far out from the door it leads to. */
const PATH_DOOR_GAP = 1.5;

/**
 * The path from a roadside compound's road to one of its buildings' doors (`door` in the building's
 * own frame - x along its front, z out of it): from the road's middle square across to a door in its
 * front; to one in a side wall, across to the front and round its corner. From the road's level to
 * the building's ground. A door at the back is come to at the front's middle instead.
 */
function pathToDoor(way: WayOut, s: number, house: House, door: { x: number; z: number }, heightAt: (s: number) => number): RoadLine {
  // The building's own axes in the world: x along its front, z out of it.
  const ax = house.frontZ;
  const az = -house.frontX;
  const world = (x: number, z: number): CellPoint => ({ x: house.x + ax * x + house.frontX * z, z: house.z + az * x + house.frontZ * z });
  const hd = house.depth / 2;
  const hw = house.width / 2;
  const front = door.z > hd * 0.5;
  const side = !front && Math.abs(door.x) > hw * 0.5 ? Math.sign(door.x) : 0;
  // Where it meets the front: before the door, or past the corner on the door's side.
  const frontX = front ? door.x : side !== 0 ? door.x + side * PATH_DOOR_GAP : 0;
  // (Its depth measures its eaves too: a door in its front stands on the wall, further in.)
  const ends: CellPoint[] = [world(frontX, (front ? door.z : hd) + PATH_DOOR_GAP)];
  if (side !== 0) ends.push(world(door.x + side * PATH_DOOR_GAP, door.z));
  // Along the road to square across from where it meets the front.
  const road = alongWay(way, s)!;
  const along = ((ends[0].x - road.x) * road.dx + (ends[0].z - road.z) * road.dz);
  const start = alongWay(way, s + along) ?? road;
  const ground = house.y - HOUSE_FLOOR_ABOVE_STREET;
  return { points: [{ x: start.x, z: start.z }, ...ends], heights: [heightAt(s + along), ...ends.map(() => ground)], widthScale: PATH_WIDTH, taperEnds: false };
}

/** A prop keeps this far from anything else - a building, another prop. */
const PROP_GAP = 0.6;
/** And this far from a boundary's line (a wall's middle). */
const WALL_PROP_GAP = 0.9;
/** And clear of the ground before a building's front, this deep - its door's approach. */
const DOOR_APRON = 4;
/** And this far from a lane's middle or a trail's (beyond its own reach); a trail's props lie this
 *  far off it. */
const PROP_LANE_CLEARANCE = 3;
const PROP_TRAIL_OFFSET = 2;
/** Where round the yard's rim a prop is tried: this many steps round. */
const PROP_RIM_STEPS = 72;
/** The ways across the yard - from each lane's end and each trail's start to its middle - are kept
 *  this clear either side, so every way in leads on across it. */
const YARD_PATH_CLEARANCE = 2.5;
/** In the yard, a prop is tried on rings this far apart, and this far apart round each. */
const YARD_STEP = 2.5;
/** A lane's gate stands this far out past the yard's rim - back among the buildings' sides. */
const GATE_SET_BACK = 3;
/** A prop by a road stands this far from its middle (times its width), past its painted surface. */
const ROADSIDE_PROP_OFFSET = 6;

/** A road leading away from a compound: its line, how far along it the compound is, and which way
 *  along it is away. */
interface WayOut {
  line: RoadLine;
  lengths: number[];
  start: number;
  direction: 1 | -1;
}

/** Where a road is `s` metres along it, and which way it runs there - or null past its ends. */
function alongWay(way: WayOut, s: number): { x: number; z: number; dx: number; dz: number } | null {
  const { points } = way.line;
  const { lengths } = way;
  if (s < 0 || s > lengths[lengths.length - 1]) return null;
  let i = 1;
  while (i < lengths.length - 1 && lengths[i] < s) i++;
  const a = points[i - 1];
  const b = points[i];
  const length = Math.max(1e-6, lengths[i] - lengths[i - 1]);
  const t = (s - lengths[i - 1]) / length;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: (b.x - a.x) / length, dz: (b.z - a.z) / length };
}

/** The ways out of a compound along the roads: a roadside one's road both ways from its middle; a
 *  ring's, each road from where it arrives at a gate (its lane's outer end), on away from it. */
function waysOut(roads: RoadLine[], lanes: RoadLine[], x: number, z: number, roadside: boolean): WayOut[] {
  const starts = roadside ? [{ x, z }] : lanes.map((lane) => lane.points[0]);
  return starts.flatMap((start) => {
    let best: { line: RoadLine; segment: number; u: number; distance: number } | null = null;
    for (const line of roads) {
      for (let i = 0; i + 1 < line.points.length; i++) {
        const a = line.points[i];
        const b = line.points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const u = Math.max(0, Math.min(1, ((start.x - a.x) * dx + (start.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        const distance = Math.hypot(start.x - a.x - u * dx, start.z - a.z - u * dz);
        if (!best || distance < best.distance) best = { line, segment: i, u, distance };
      }
    }
    if (!best || best.distance > 3) return [];
    const { line, segment, u } = best;
    const lengths = [0];
    for (let i = 1; i < line.points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(line.points[i].x - line.points[i - 1].x, line.points[i].z - line.points[i - 1].z));
    const startAt = lengths[segment] + u * (lengths[segment + 1] - lengths[segment]);
    const ways: WayOut[] = [1, -1].map((direction) => ({ line, lengths, start: startAt, direction: direction as 1 | -1 }));
    if (roadside) return ways;
    // From a gate, only the way that leads off from the compound.
    const further = (way: WayOut): number => {
      const p = alongWay(way, way.start + way.direction * 10);
      return p ? Math.hypot(p.x - x, p.z - z) : -Infinity;
    };
    return [ways[0], ways[1]].sort((p, q) => further(q) - further(p)).slice(0, 1);
  });
}

/**
 * Sets a compound's props down by their anchors, in their list's order: each where it fits - clear
 * of the buildings (and the ground before their doors), the lanes, the trails, the roads and the
 * props already down - and, among those, as far from the props already down as it can be, so they
 * spread out. One that fits nowhere is left out.
 */
function placeProps(
  spec: CompoundSpec,
  site: CompoundSite,
  worldSeed: number,
  rng: () => number,
  buildings: House[],
  lanes: RoadLine[],
  trails: RoadLine[],
  roads: RoadLine[],
  sampleTerrain: TerrainSampler,
  at: { x: number; z: number; yardRadius: number; rim: number },
  boundary: { walls: WallRun[]; gates: PlacedProp[] } = { walls: [], gates: [] },
): { props: PlacedProp[]; droppedProps: string[] } {
  // The boundary's gates are down already, and its wall in the way.
  const props: PlacedProp[] = [...boundary.gates];
  /** The footprints of what is down already. */
  const down: Box[] = boundary.gates.map((gate): Box => ({ x: gate.x, z: gate.z, ax: gate.frontZ, az: -gate.frontX, hw: gate.halfWidth, hd: gate.halfDepth }));
  const walled = (box: Box): boolean => boundary.walls.some((run) => lineToBox(run.points, box) < WALL_PROP_GAP);
  const droppedProps: string[] = [];
  // The buildings, and the ground before each one's door.
  const houseBoxes = buildings.map((house): Box => ({ x: house.x, z: house.z, ax: house.frontZ, az: -house.frontX, hw: house.width / 2, hd: house.depth / 2 }));
  const aprons = buildings.map((house): Box => {
    const ahead = house.depth / 2 + DOOR_APRON / 2;
    return { x: house.x + house.frontX * ahead, z: house.z + house.frontZ * ahead, ax: house.frontZ, az: -house.frontX, hw: house.width / 2, hd: DOOR_APRON / 2 };
  });
  const roadside = site.roadAngles.length > 0;
  // The ways across the yard: from where each lane and trail meets it to its middle. A roadside
  // one has no yard to cross - its paths are its lanes.
  const paths: CellPoint[][] = roadside ? [] : [...lanes.map((line) => line.points[line.points.length - 1]), ...trails.map((line) => line.points[0])].map((end) => [end, { x: at.x, z: at.z }]);
  /** The lanes with a gate across them already. */
  const gated = new Set<RoadLine>();
  // The roads leading away from it, and those with a prop by them already.
  const ways = waysOut(roads, lanes, at.x, at.z, site.roadAngles.length > 0);
  const signed = new Set<WayOut>();
  // Beside a road out on its own: on dry land, off every other road, clear of what is down already.
  const fitsByRoad = (box: Box, own: RoadLine): boolean => {
    if (roads.some((line) => line !== own && lineToBox(line.points, box) < ROAD_HALF_WIDTH)) return false;
    if (houseBoxes.some((house) => boxGap(house, box) < PROP_GAP) || down.some((other) => boxGap(other, box) < PROP_GAP)) return false;
    return corners(box).every((p) => {
      const ground = sampleTerrain(p.x, p.z);
      return ground.isLand && ground.lakeFactor < 0.02;
    });
  };
  // A gate stands across its lane: only the other ways are kept clear of it.
  // One set before a building's front stands on its apron, off the path to its door.
  const fits = (box: Box, limit: number | null, onTrail: RoadLine | null, acrossLane: RoadLine | null = null, onApron = false): boolean => {
    if (limit !== null && corners(box).some((p) => Math.hypot(p.x - at.x, p.z - at.z) > limit)) return false;
    if (!acrossLane && paths.some((path) => lineToBox(path, box) < YARD_PATH_CLEARANCE)) return false;
    if (houseBoxes.some((house) => boxGap(house, box) < PROP_GAP) || (!onApron && aprons.some((apron) => boxGap(apron, box) < 0))) return false;
    if (lanes.some((line) => line !== acrossLane && lineToBox(line.points, box) < PROP_LANE_CLEARANCE)) return false;
    if (trails.some((line) => line !== onTrail && lineToBox(line.points, box) < PROP_LANE_CLEARANCE)) return false;
    if (onTrail && lineToBox(onTrail.points, box) < PROP_TRAIL_OFFSET - 0.01) return false;
    if (roads.some((line) => distanceToLine(line.points, box.x, box.z) < Math.hypot(box.hw, box.hd) + ROAD_HALF_WIDTH + 1)) return false;
    if (down.some((other) => boxGap(other, box) < PROP_GAP)) return false;
    if (!acrossLane && walled(box)) return false;
    return corners(box).every((p) => {
      const ground = sampleTerrain(p.x, p.z);
      return ground.isLand && ground.lakeFactor < 0.02;
    });
  };
  const spread = (box: Box): number => Math.min(Infinity, ...down.map((other) => boxGap(other, box)));

  for (const entry of spec.props) {
    const count = entry.count[0] + Math.floor(rng() * (entry.count[1] - entry.count[0] + 1));
    for (let k = 0; k < count; k++) {
      if (rng() >= entry.chance) continue;
      const arranged: Arranged = entry.placed.kind === "prop" ? arrangeProp(entry.placed.prop, worldSeed, rng) : arrangeGroup(entry.placed.group, worldSeed, rng);
      if (arranged.members.length === 0) continue;
      const r = arranged.reach;
      /** Candidates: where, which way it faces, the trail it lies by, and how far from the middle it
       *  may reach (null: no matter). */
      const candidates: { x: number; z: number; fx: number; fz: number; trail: RoadLine | null; limit: number | null; lane?: RoadLine; way?: WayOut; front?: boolean }[] = [];
      /** Where its footprint lies, set down as a candidate says. */
      const boxAt = (c: (typeof candidates)[number]): Box => {
        const length = Math.hypot(c.fx, c.fz) || 1;
        const fx = c.fx / length;
        const fz = c.fz / length;
        const { cx, cz, hw, hd } = arranged.box;
        return { x: c.x + fz * cx + fx * cz, z: c.z - fx * cx + fz * cz, ax: fz, az: -fx, hw, hd };
      };
      if (roadside && (entry.at === "yard" || entry.at === "yardEdge") && ways.length > 0) {
        // A roadside one's yard: the strip either side of its road, between it and the fronts -
        // further out for its edge - turned freely.
        const way = ways[0];
        const span = Math.max(10, site.radius - ROADSIDE_SPAN_MARGIN);
        const near = ROAD_HALF_WIDTH * (way.line.widthScale ?? 1) + r + 1;
        const offsets = entry.at === "yard" ? [near, near + 2, near + 4] : [near + 8, near + 12];
        for (let t = -span; t <= span; t += YARD_STEP) {
          const p = alongWay(way, way.start + t);
          if (!p) continue;
          for (const side of [-1, 1]) {
            for (const off of offsets) {
              const turn = rng() * Math.PI * 2;
              candidates.push({ x: p.x - p.dz * side * off, z: p.z + p.dx * side * off, fx: Math.sin(turn), fz: Math.cos(turn), trail: null, limit: null });
            }
          }
        }
      } else if (entry.at === "yard") {
        // Anywhere in the yard, on rings out from its middle, turned freely.
        for (let ring = 0; ring * YARD_STEP <= at.yardRadius - Math.min(arranged.box.hw, arranged.box.hd); ring++) {
          const radius = ring * YARD_STEP;
          const steps = Math.max(1, Math.floor((2 * Math.PI * radius) / YARD_STEP));
          const start = rng() * Math.PI * 2;
          for (let s = 0; s < steps; s++) {
            const angle = start + (s / steps) * Math.PI * 2;
            const turn = rng() * Math.PI * 2;
            candidates.push({ x: at.x + Math.cos(angle) * radius, z: at.z + Math.sin(angle) * radius, fx: Math.sin(turn), fz: Math.cos(turn), trail: null, limit: at.yardRadius });
          }
        }
      } else if (entry.at === "yardEdge") {
        // Round the rim: just inside the yard's edge, or back between the buildings, facing in.
        const start = rng() * Math.PI * 2;
        for (let s = 0; s < PROP_RIM_STEPS; s++) {
          const angle = start + (s / PROP_RIM_STEPS) * Math.PI * 2;
          for (const radius of [at.rim + r + 0.5, at.rim + r + 3, at.yardRadius - r - 0.5]) {
            if (radius <= r) continue;
            const turn = (rng() - 0.5) * 0.6;
            candidates.push({ x: at.x + Math.cos(angle) * radius, z: at.z + Math.sin(angle) * radius, fx: -Math.cos(angle + turn), fz: -Math.sin(angle + turn), trail: null, limit: site.radius });
          }
        }
      } else if (entry.at === "byBuilding") {
        // Along a building's sides, from just behind its front back - then along its back - facing
        // as it does.
        // By its building where it has one - otherwise by any.
        const named = buildings.filter((house) => house.building === entry.building);
        const houses = entry.building && named.length > 0 ? named : buildings;
        for (const house of shuffled(houses, rng)) {
          const hw = house.width / 2;
          const hd = house.depth / 2;
          const at = (u: number, w: number) => ({ x: house.x + house.frontZ * u + house.frontX * w, z: house.z - house.frontX * u + house.frontZ * w, fx: house.frontX, fz: house.frontZ, trail: null, limit: site.radius });
          for (let w = hd - r - PROP_GAP; w >= -hd + r; w -= 1.5) {
            for (const side of rng() < 0.5 ? [-1, 1] : [1, -1]) candidates.push(at(side * (hw + r + PROP_GAP + 0.05), w));
          }
          for (let u = -hw + r; u <= hw - r; u += 1.5) candidates.push(at(u, -(hd + r + PROP_GAP + 0.05)));
        }
      } else if (entry.at === "front") {
        // Along a building's front, just out from it (past its eaves), anywhere across it the path
        // to its door leaves free - facing out as it does.
        const named = buildings.filter((house) => house.building === entry.building);
        const houses = entry.building && named.length > 0 ? named : buildings;
        for (const house of shuffled(houses, rng)) {
          const hw = house.width / 2;
          const out = house.depth / 2 + r + PROP_GAP;
          const across: number[] = [];
          for (let u = -hw + r; u <= hw - r; u += 1) across.push(u);
          for (const u of shuffled(across, rng)) {
            candidates.push({ x: house.x + house.frontZ * u + house.frontX * out, z: house.z - house.frontX * u + house.frontZ * out, fx: house.frontX, fz: house.frontZ, trail: null, limit: null, front: true });
          }
        }
      } else if (entry.at === "gate") {
        // Across a lane not gated yet, out past the yard's rim, facing out along it.
        const open = lanes.filter((line) => !gated.has(line));
        if (open.length === 0) continue;
        for (const lane of shuffled(open, rng)) {
          const outer = lane.points[0];
          const angle = Math.atan2(outer.z - at.z, outer.x - at.x);
          const radius = at.rim + GATE_SET_BACK;
          candidates.push({ x: at.x + Math.cos(angle) * radius, z: at.z + Math.sin(angle) * radius, fx: Math.cos(angle), fz: Math.sin(angle), trail: null, limit: null, lane });
        }
      } else if (entry.at === "road") {
        // Out along a road not signed yet, beside it - either side - its +x towards the road, so a
        // sign's arm reaches over it and its board faces the way the road runs.
        const open = ways.filter((way) => !signed.has(way));
        if (open.length === 0) continue;
        const out = entry.distance[0] + rng() * (entry.distance[1] - entry.distance[0]);
        for (const way of shuffled(open, rng)) {
          for (const tried of [out, out * 0.8, out * 1.2, out * 0.6]) {
            const p = alongWay(way, way.start + way.direction * tried);
            if (!p) continue;
            for (const side of rng() < 0.5 ? [-1, 1] : [1, -1]) {
              const nx = -p.dz * side;
              const nz = p.dx * side;
              const off = ROADSIDE_PROP_OFFSET * (way.line.widthScale ?? 1) + r;
              candidates.push({ x: p.x + nx * off, z: p.z + nz * off, fx: nz, fz: -nx, trail: null, limit: null, way });
            }
          }
        }
      } else {
        // Beside a trail, out past the buildings, lying along it.
        for (const trail of trails) {
          let travelled = 0;
          for (let i = 0; i + 1 < trail.points.length; i++) {
            const a = trail.points[i];
            const b = trail.points[i + 1];
            const length = Math.hypot(b.x - a.x, b.z - a.z);
            const dx = (b.x - a.x) / length;
            const dz = (b.z - a.z) / length;
            for (let t = 0; t < length; t += 3) {
              const along = travelled + t;
              // Out past the buildings' furthest corners.
              if (along + at.yardRadius < site.radius - RING_MARGIN + 2) continue;
              const px = a.x + dx * t;
              const pz = a.z + dz * t;
              for (const side of rng() < 0.5 ? [-1, 1] : [1, -1]) {
                const off = r + PROP_TRAIL_OFFSET;
                const turn = (rng() - 0.5) * 0.5;
                // Its +x (the long way of a log) along the trail.
                candidates.push({ x: px - dz * side * off, z: pz + dx * side * off, fx: -Math.sin(Math.atan2(dz, dx) + turn), fz: Math.cos(Math.atan2(dz, dx) + turn), trail, limit: null });
              }
            }
            travelled += length;
          }
        }
      }
      let best: (typeof candidates)[number] | null = null;
      let bestBox: Box | null = null;
      let bestSpread = -Infinity;
      for (const c of candidates) {
        const box = boxAt(c);
        if (!(c.way ? fitsByRoad(box, c.way.line) : fits(box, c.limit, c.trail, c.lane ?? null, c.front === true))) continue;
        const score = spread(box) + rng() * 2;
        if (score > bestSpread) {
          bestSpread = score;
          best = c;
          bestBox = box;
          // Along a building or a trail, the first that fits - near the front, near the yard; a gate
          // on the first lane it fits.
          if (entry.at === "byBuilding" || entry.at === "front" || entry.at === "trail" || entry.at === "gate" || entry.at === "road") break;
        }
      }
      if (!best) {
        droppedProps.push(entry.placed.kind === "prop" ? entry.placed.prop.id : entry.placed.group.id);
        continue;
      }
      if (best.lane) gated.add(best.lane);
      if (best.way) signed.add(best.way);
      const length = Math.hypot(best.fx, best.fz) || 1;
      props.push(...setDown(arranged, best.x, best.z, best.fx / length, best.fz / length, down.length));
      down.push(bestBox!);
    }
  }
  return { props, droppedProps };
}

/** A footprint: a rectangle round (x, z), its half-extents along its unit axis (ax, az) and across
 *  it. */
interface Box {
  x: number;
  z: number;
  ax: number;
  az: number;
  hw: number;
  hd: number;
}

function corners(box: Box): CellPoint[] {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ x: box.x + box.ax * box.hw * a - box.az * box.hd * b, z: box.z + box.az * box.hw * a + box.ax * box.hd * b }));
}

/** How far apart two footprints are along the axis that parts them most - negative where they
 *  overlap (a lower bound of the distance between them). */
function boxGap(p: Box, q: Box): number {
  let gap = -Infinity;
  for (const box of [p, q]) {
    for (const [ux, uz] of [[box.ax, box.az], [-box.az, box.ax]]) {
      const project = (b: Box): [number, number] => {
        const values = corners(b).map((c) => c.x * ux + c.z * uz);
        return [Math.min(...values), Math.max(...values)];
      };
      const [p0, p1] = project(p);
      const [q0, q1] = project(q);
      gap = Math.max(gap, q0 - p1, p0 - q1);
    }
  }
  return gap;
}

/** How far a line comes to a footprint - 0 where it crosses it. */
function lineToBox(points: CellPoint[], box: Box): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5));
    for (let s = 0; s <= steps; s++) {
      const px = a.x + ((b.x - a.x) * s) / steps - box.x;
      const pz = a.z + ((b.z - a.z) * s) / steps - box.z;
      const u = Math.abs(px * box.ax + pz * box.az) - box.hw;
      const w = Math.abs(-px * box.az + pz * box.ax) - box.hd;
      best = Math.min(best, Math.hypot(Math.max(0, u), Math.max(0, w)));
    }
  }
  return best;
}

function shuffled<T>(list: T[], rng: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Each prop's height, once the yard and the buildings' pads are levelled: a group's members on the
 * ground all at the mean of the ground under them (a pad of its own levels it there - see
 * propPads), and one on another on that one's top. One that lies on the slope (PropDef.ground)
 * sits on the ground under its middle instead, tilted to the ground's rise across its footprint
 * either way. In list order - one is always after what it stands on.
 */
export function settleProps(layouts: CompoundLayout[], sampleTerrain: TerrainSampler): void {
  for (const layout of layouts) {
    for (const prop of layout.props) if (!prop.on && prop.prop.ground === "slope") lieOnSlope(prop, sampleTerrain);
    // One standing plumb: on the ground under its middle, upright.
    for (const prop of layout.props) if (!prop.on && prop.prop.ground === "plumb") prop.y = sampleTerrain(prop.x, prop.z).height;
    const levels = new Map<number, number[]>();
    for (const prop of layout.props) {
      if (prop.on || prop.prop.ground !== "level") continue;
      const list = levels.get(prop.group) ?? [];
      list.push(sampleTerrain(prop.x, prop.z).height);
      levels.set(prop.group, list);
    }
    const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length;
    for (const prop of layout.props) {
      if (prop.on) prop.y = prop.on.y + prop.lift;
      else if (prop.prop.ground === "level") prop.y = mean(levels.get(prop.group)!);
    }
  }
}

/** A boundary run is drawn (and comes into the collision world) in stretches no longer than this. */
const WALL_STRETCH = 24;

/**
 * A boundary run as the stretches it is drawn in - each its own model, stood at its first point, its
 * points in its own space from there - joined end to end (see LineRun's `join`).
 */
export function wallStretches(run: WallRun, seed: number): { x: number; y: number; z: number; frontX: number; frontZ: number; model: (far: boolean) => BuildingModel }[] {
  const cuts = [0];
  let travelled = 0;
  for (let k = 1; k < run.points.length; k++) {
    travelled += Math.hypot(run.points[k].x - run.points[k - 1].x, run.points[k].z - run.points[k - 1].z);
    if (travelled >= WALL_STRETCH && k < run.points.length - 1) {
      cuts.push(k);
      travelled = 0;
    }
  }
  cuts.push(run.points.length - 1);
  const stretches = [];
  for (let n = 0; n + 1 < cuts.length; n++) {
    const from = cuts[n];
    const to = cuts[n + 1];
    const origin = { x: run.points[from].x, y: run.heights[from], z: run.points[from].z };
    const points: Vec3[] = [];
    for (let k = from; k <= to; k++) points.push([run.points[k].x - origin.x, run.heights[k] - origin.y, run.points[k].z - origin.z]);
    const line: LineRun = { points, ends: [n === 0 ? run.ends[0] : "join", n === cuts.length - 2 ? run.ends[1] : "join"], breach: run.breach, width: run.width, base: run.base === undefined ? undefined : run.base - origin.y };
    const variant = run.variant + n;
    stretches.push({ ...origin, frontX: 0, frontZ: 1, model: (far: boolean) => generateLine(run.prop, seed, variant, line, far) });
  }
  return stretches;
}

/** A prop lying on the slope (PropDef.ground "slope"): on the ground under its middle, tilted to
 *  the ground's rise across its footprint either way. */
function lieOnSlope(prop: PlacedProp, sampleTerrain: TerrainSampler): void {
  // The ground's rise across it (along its width, its +x) and along it (front to back).
  const ax = prop.frontZ;
  const az = -prop.frontX;
  const h = (u: number, w: number): number => sampleTerrain(prop.x + ax * u + prop.frontX * w, prop.z + az * u + prop.frontZ * w).height;
  const across = (h(prop.halfWidth, 0) - h(-prop.halfWidth, 0)) / Math.max(0.1, 2 * prop.halfWidth);
  const along = (h(0, prop.halfDepth) - h(0, -prop.halfDepth)) / Math.max(0.1, 2 * prop.halfDepth);
  const gx = ax * across + prop.frontX * along;
  const gz = az * across + prop.frontZ * along;
  const length = Math.hypot(gx, 1, gz);
  prop.up = [-gx / length, 1 / length, -gz / length];
  prop.y = h(0, 0);
}

/** A wall run's ground (and a plumb prop's) is read at least this often along it. */
const WALL_GROUND_STEP = 1.5;

/**
 * What stands on the ground as it lies, set on it once the ground is final - pads, props' pads and
 * all: each plumb prop (a headstone) on the ground under its middle; and each boundary run, its
 * line (any polyline - a long straight side as well as a curve) filled in with points no further
 * apart than WALL_GROUND_STEP, its corners kept where they are, and the ground read at each - so it
 * follows every dip and rise between its corners.
 */
export function settleOnGround(layouts: CompoundLayout[], sampleTerrain: TerrainSampler): void {
  for (const layout of layouts) {
    for (const prop of layout.props) {
      if (prop.on) continue;
      if (prop.prop.ground === "plumb") prop.y = sampleTerrain(prop.x, prop.z).height;
      // (And one lying on the slope again - a pad may have changed it.)
      else if (prop.prop.ground === "slope") lieOnSlope(prop, sampleTerrain);
    }
    settleWallRuns(layout.walls, sampleTerrain);
  }
}

/** Wall runs set on the ground as it lies (see settleOnGround) - a compound's boundary, a road's
 *  fences. */
export function settleWallRuns(runs: WallRun[], sampleTerrain: TerrainSampler): void {
  for (const run of runs) {
    const points: CellPoint[] = [run.points[0]];
    for (let k = 1; k < run.points.length; k++) {
      const a = run.points[k - 1];
      const b = run.points[k];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / WALL_GROUND_STEP));
      for (let i = 1; i <= n; i++) points.push({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n });
    }
    run.points = points;
    run.heights = points.map((p) => sampleTerrain(p.x, p.z).height);
  }
}

/** Every compound laid out, round the gates its roads arrived at (RoadNetwork.gates, by place). */
export function layoutCompounds(features: FeatureSite[], roads: Pick<RoadNetwork, "places" | "gates" | "stretches">, sampleTerrain: TerrainSampler, worldSeed: number): CompoundLayout[] {
  const placeOf = new Map(roads.places.flatMap((place) => (place.feature ? [[place.feature, place.id] as const] : [])));
  return features.flatMap((feature) => {
    if (!feature.compound) return [];
    const placeId = placeOf.get(feature);
    const gates = placeId === undefined ? [] : roads.gates[placeId];
    return [layoutCompound(feature.id, feature.kind, feature.compound, gates, roads.stretches, sampleTerrain, worldSeed)];
  });
}
