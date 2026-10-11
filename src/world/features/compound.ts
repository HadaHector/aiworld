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
import { ROAD_HALF_WIDTH } from "../roads/roadConfig";
import { arrangeGroup, arrangeProp, setDown, type Arranged, type PlacedProp } from "../props/propGroups";

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
  /** Its props, set down by their anchors - their heights filled in once the ground is final (see
   *  settleProps). */
  props: PlacedProp[];
  /** Props (or groups) rolled that found no room, by id. */
  droppedProps: string[];
  /** How its level ground blends back to the ground round it (its kind's `pads`). */
  padBlend: { slope: number; min: number; max: number };
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
  worldSeed: number,
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

  const { props, droppedProps } = placeProps(kind.compound!, site, worldSeed, rng, buildings, lanes, trails, nearbyRoads, sampleTerrain, { x, z, yardRadius, rim });
  return { featureId, kindId: kind.id, x, z, yard: { x, z, y, radius: yardRadius, level }, entrances, lanes, trails, buildings, dropped, droppedRequired, props, droppedProps, padBlend: { slope: kind.compound!.pads.slope, min: kind.compound!.pads.blend[0], max: kind.compound!.pads.blend[1] } };
}

/** A prop keeps this far from anything else - a building, another prop. */
const PROP_GAP = 0.6;
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
): { props: PlacedProp[]; droppedProps: string[] } {
  const props: PlacedProp[] = [];
  /** The footprints of what is down already. */
  const down: Box[] = [];
  const droppedProps: string[] = [];
  // The buildings, and the ground before each one's door.
  const houseBoxes = buildings.map((house): Box => ({ x: house.x, z: house.z, ax: house.frontZ, az: -house.frontX, hw: house.width / 2, hd: house.depth / 2 }));
  const aprons = buildings.map((house): Box => {
    const ahead = house.depth / 2 + DOOR_APRON / 2;
    return { x: house.x + house.frontX * ahead, z: house.z + house.frontZ * ahead, ax: house.frontZ, az: -house.frontX, hw: house.width / 2, hd: DOOR_APRON / 2 };
  });
  // The ways across the yard: from where each lane and trail meets it to its middle.
  const paths: CellPoint[][] = [...lanes.map((line) => line.points[line.points.length - 1]), ...trails.map((line) => line.points[0])].map((end) => [end, { x: at.x, z: at.z }]);
  /** The lanes with a gate across them already. */
  const gated = new Set<RoadLine>();
  // A gate stands across its lane: only the other ways are kept clear of it.
  const fits = (box: Box, limit: number | null, onTrail: RoadLine | null, acrossLane: RoadLine | null = null): boolean => {
    if (limit !== null && corners(box).some((p) => Math.hypot(p.x - at.x, p.z - at.z) > limit)) return false;
    if (!acrossLane && paths.some((path) => lineToBox(path, box) < YARD_PATH_CLEARANCE)) return false;
    if (houseBoxes.some((house) => boxGap(house, box) < PROP_GAP) || aprons.some((apron) => boxGap(apron, box) < 0)) return false;
    if (lanes.some((line) => line !== acrossLane && lineToBox(line.points, box) < PROP_LANE_CLEARANCE)) return false;
    if (trails.some((line) => line !== onTrail && lineToBox(line.points, box) < PROP_LANE_CLEARANCE)) return false;
    if (onTrail && lineToBox(onTrail.points, box) < PROP_TRAIL_OFFSET - 0.01) return false;
    if (roads.some((line) => distanceToLine(line.points, box.x, box.z) < Math.hypot(box.hw, box.hd) + ROAD_HALF_WIDTH + 1)) return false;
    if (down.some((other) => boxGap(other, box) < PROP_GAP)) return false;
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
      const candidates: { x: number; z: number; fx: number; fz: number; trail: RoadLine | null; limit: number | null; lane?: RoadLine }[] = [];
      /** Where its footprint lies, set down as a candidate says. */
      const boxAt = (c: (typeof candidates)[number]): Box => {
        const length = Math.hypot(c.fx, c.fz) || 1;
        const fx = c.fx / length;
        const fz = c.fz / length;
        const { cx, cz, hw, hd } = arranged.box;
        return { x: c.x + fz * cx + fx * cz, z: c.z - fx * cx + fz * cz, ax: fz, az: -fx, hw, hd };
      };
      if (entry.at === "yard") {
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
        if (!fits(box, c.limit, c.trail, c.lane ?? null)) continue;
        const score = spread(box) + rng() * 2;
        if (score > bestSpread) {
          bestSpread = score;
          best = c;
          bestBox = box;
          // Along a building or a trail, the first that fits - near the front, near the yard; a gate
          // on the first lane it fits.
          if (entry.at === "byBuilding" || entry.at === "trail" || entry.at === "gate") break;
        }
      }
      if (!best) {
        droppedProps.push(entry.placed.kind === "prop" ? entry.placed.prop.id : entry.placed.group.id);
        continue;
      }
      if (best.lane) gated.add(best.lane);
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
    for (const prop of layout.props) {
      if (prop.on || prop.prop.ground !== "slope") continue;
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
    const levels = new Map<number, number[]>();
    for (const prop of layout.props) {
      if (prop.on || prop.prop.ground === "slope") continue;
      const list = levels.get(prop.group) ?? [];
      list.push(sampleTerrain(prop.x, prop.z).height);
      levels.set(prop.group, list);
    }
    const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length;
    for (const prop of layout.props) {
      if (prop.on) prop.y = prop.on.y + prop.lift;
      else if (prop.prop.ground !== "slope") prop.y = mean(levels.get(prop.group)!);
    }
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
