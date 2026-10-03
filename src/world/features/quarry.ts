import type { TerrainSampler } from "../terrain/terrainSampler";
import type { QuarrySpec } from "./featureTypes";
import { lerp, smoothstep } from "../mathUtils";

/**
 * A quarry: a level floor cut back into a hillside. Behind it and along its sides the hill is cut
 * away in benches - a steep rock face, a ledge, another face - and in front the spoil is tipped out
 * to a bank falling back to the ground. Everything is a limit on the ground's own height rather
 * than a shape of its own: the ground is cut down to the benches wherever it stands above them and
 * filled up to the spoil bank wherever it falls below it, so the quarry fits whatever hillside it
 * is in and ends where the hill does.
 */
export interface QuarryShape {
  /** The floor's centre, and the downhill direction its length runs along (unit). */
  x: number;
  z: number;
  ax: number;
  az: number;
  halfLength: number;
  halfWidth: number;
  /** The floor's height. */
  level: number;
  benchHeight: number;
  /** The horizontal run of one bench's face. */
  benchRun: number;
  benchWidth: number;
  spoilSlope: number;
}

/** How far past the floor's edge a quarry can still change the ground. It fades back to the
 *  untouched ground over the last stretch, for a hill that keeps rising past what the benches cut. */
export const QUARRY_REACH = 60;
const QUARRY_REACH_FADE = 12;
/** The floor's corners are rounded off by this share of its smaller half-size. */
const CORNER_SHARE = 0.4;
/** How softly the cut and the spoil meet the ground they leave (world units of height). */
const MEET_SOFTNESS = 1.5;

/** Distance from the floor's edge, 0 on the floor. */
export function quarryGap(shape: QuarryShape, x: number, z: number): number {
  const dx = x - shape.x;
  const dz = z - shape.z;
  const corner = Math.min(shape.halfLength, shape.halfWidth) * CORNER_SHARE;
  const along = Math.abs(dx * shape.ax + dz * shape.az) - (shape.halfLength - corner);
  const across = Math.abs(-dx * shape.az + dz * shape.ax) - (shape.halfWidth - corner);
  return Math.max(0, Math.hypot(Math.max(0, along), Math.max(0, across)) - corner);
}

/** How high above the floor the cut face may stand, `gap` past its edge: bench after bench. */
function benchRise(shape: QuarryShape, gap: number): number {
  const period = shape.benchRun + shape.benchWidth;
  const bench = Math.floor(gap / period);
  const into = gap - bench * period;
  return (bench + smoothstep(0, shape.benchRun, into)) * shape.benchHeight;
}

/** min, with its corner rounded over `k`. */
function softMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0);
  return Math.min(a, b) - (h * h) / (4 * k);
}

/** The ground's height with the quarry cut into it, `gap` (quarryGap) past the floor's edge. */
export function quarryHeight(shape: QuarryShape, gap: number, natural: number): number {
  if (gap >= QUARRY_REACH) return natural;
  if (gap <= 0) return shape.level;
  // Soft only away from the floor, so the floor itself stays exactly level.
  const k = MEET_SOFTNESS * smoothstep(0, 3, gap);
  const cut = softMin(natural, shape.level + benchRise(shape, gap), k);
  const filled = -softMin(-cut, -(shape.level - gap * shape.spoilSlope), k);
  return lerp(filled, natural, smoothstep(QUARRY_REACH - QUARRY_REACH_FADE, QUARRY_REACH, gap));
}

/** Where a track to a quarry starts (the middle of its open front) and the point a little way out
 *  that the track is routed from. */
export function quarryEntrance(shape: QuarryShape): { x: number; z: number; approachX: number; approachZ: number } {
  return {
    x: shape.x + shape.ax * (shape.halfLength - 4),
    z: shape.z + shape.az * (shape.halfLength - 4),
    approachX: shape.x + shape.ax * (shape.halfLength + 30),
    approachZ: shape.z + shape.az * (shape.halfLength + 30),
  };
}

/** How far out from its centre a quarry reaches - what roads keep out of. */
export function quarryFootprint(shape: QuarryShape): number {
  return Math.hypot(shape.halfLength, shape.halfWidth) + 30;
}

// Where a quarry may go. The ground must be dry and clear of water and zone borders (whose hills a
// quarry has no business cutting), and its floor's own ground must slope one way: neither a ridge
// nor a gully across it, and the hill must go on rising behind it, so the cut has a face.
const MIN_HEIGHT = 6;
const MAX_LAKE_FACTOR = 0.02;
const MIN_RIVER_GAP = 80;
const MIN_BORDER_GAP = 60;
const GRADE_STEP = 10;
const MAX_ACROSS_BEND = 4;
const BEHIND = 20;
const AHEAD = 30;

/** A candidate's shape and how good its hillside is (0-1), or null where no quarry can go. */
export function evaluateQuarry(
  x: number,
  z: number,
  spec: QuarrySpec,
  size: { halfLength: number; halfWidth: number; benchHeight: number; benchWidth: number },
  sampleTerrain: TerrainSampler,
): { shape: QuarryShape; score: number; areaId: number } | null {
  const here = sampleTerrain(x, z);
  if (!here.isLand || here.height < MIN_HEIGHT || here.lakeFactor > MAX_LAKE_FACTOR) return null;
  if (here.riverGap < MIN_RIVER_GAP || here.areaBorderGap < MIN_BORDER_GAP) return null;

  const h = (px: number, pz: number): number => sampleTerrain(px, pz).height;
  const gx = (h(x + GRADE_STEP, z) - h(x - GRADE_STEP, z)) / (2 * GRADE_STEP);
  const gz = (h(x, z + GRADE_STEP) - h(x, z - GRADE_STEP)) / (2 * GRADE_STEP);
  const grade = Math.hypot(gx, gz);
  if (grade < spec.grade[0] || grade > spec.grade[1]) return null;
  const ax = -gx / grade;
  const az = -gz / grade;
  const { halfLength, halfWidth } = size;

  // Level across the floor: the two sides' heights average to the middle's.
  const left = h(x - az * halfWidth, z + ax * halfWidth);
  const right = h(x + az * halfWidth, z - ax * halfWidth);
  if (Math.abs(left + right - 2 * here.height) > MAX_ACROSS_BEND) return null;

  // Still rising behind - a face to cut - and still land, and lower, in front: somewhere to tip the
  // spoil and for a track to come in.
  const behind = h(x - ax * (halfLength + BEHIND), z - az * (halfLength + BEHIND));
  const rising = (behind - here.height) / (halfLength + BEHIND);
  if (rising < grade * 0.6) return null;
  const ahead = sampleTerrain(x + ax * (halfLength + AHEAD), z + az * (halfLength + AHEAD));
  if (!ahead.isLand || ahead.height < MIN_HEIGHT * 0.5 || ahead.height > here.height) return null;

  const score = Math.max(0, 1 - Math.abs(grade - spec.idealGrade) / spec.idealGrade) * 0.7 + Math.min(1, rising / grade) * 0.3;
  return {
    shape: {
      x,
      z,
      ax,
      az,
      halfLength,
      halfWidth,
      // Mostly cut: the floor sits a quarter of its length's fall below the middle, so its back is
      // dug three times as deep as its front is built up.
      level: here.height - grade * halfLength * 0.5,
      benchHeight: size.benchHeight,
      benchRun: size.benchHeight / spec.benchSteepness,
      benchWidth: size.benchWidth,
      spoilSlope: spec.spoilSlope,
    },
    score,
    areaId: here.primaryAreaId,
  };
}
