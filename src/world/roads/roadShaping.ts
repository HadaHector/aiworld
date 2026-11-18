import type { CellPoint } from "../cells/cellGrid";
import {
  ROAD_STRAIGHTEN_SPAN_STEPS,
  ROAD_CORNER_RADIUS,
  ROAD_CORNER_SEGMENTS,
  ROAD_CORNER_RADIUS_SHARES,
  ROAD_CORNER_MIN_RADIUS,
  ROAD_CORNER_FREE_RADIUS,
  ROAD_SWITCHBACK_ANGLE,
  ROAD_SWITCHBACK_APART,
  ROAD_SWITCHBACK_REACH_SHARE,
  ROAD_SWITCHBACK_SEGMENTS,
  ROAD_RIVER_STRAIGHTEN_SLACK,
  ROAD_MAX_GRADE,
  ROAD_PROFILE_MAX_CUT,
  ROAD_PROFILE_MAX_FILL,
  ROAD_STEEP_NARROW_FROM,
  ROAD_STEEP_NARROW_TO,
  ROAD_STEEP_WIDTH,
  ROAD_STEEP_WIDTH_SMOOTH,
} from "./roadConfig";
import { smoothstep } from "../mathUtils";

/** How wide a road is at a point for the hillside under it, as a share of its full width: 1 on
 *  gentle ground, down to ROAD_STEEP_WIDTH on steep. */
export function steepWidth(heightAt: (x: number, z: number) => number, x: number, z: number): number {
  const d = 4;
  const slope = Math.hypot(heightAt(x + d, z) - heightAt(x - d, z), heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d);
  return 1 - (1 - ROAD_STEEP_WIDTH) * smoothstep(ROAD_STEEP_NARROW_FROM, ROAD_STEEP_NARROW_TO, slope);
}

/** `steepWidth` at each point of a line, averaged over ROAD_STEEP_WIDTH_SMOOTH either way along it. */
export function steepWidths(points: CellPoint[], heightAt: (x: number, z: number) => number): number[] {
  const raw = points.map((p) => steepWidth(heightAt, p.x, p.z));
  const arcs = [0];
  for (let i = 1; i < points.length; i++) arcs.push(arcs[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  return raw.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = i; j >= 0 && arcs[i] - arcs[j] <= ROAD_STEEP_WIDTH_SMOOTH; j--) {
      sum += raw[j];
      count++;
    }
    for (let j = i + 1; j < points.length && arcs[j] - arcs[i] <= ROAD_STEEP_WIDTH_SMOOTH; j++) {
      sum += raw[j];
      count++;
    }
    return sum / count;
  });
}

/** Whether a straight run between two points is road-worthy - see RoadPathfinder.chordIsClear.
 *  `graded`: judge everything but the slope, which the caller judges over a whole run itself. */
export type ChordTest = (from: CellPoint, to: CellPoint, graded?: boolean) => boolean;

/** The ground's height at a point, before any road. */
export type HeightAt = (x: number, z: number) => number;

/**
 * Whether a switchback can be built: its ground clear (no water, no other zone, no settlement), its
 * climb from end to end within ROAD_MAX_GRADE, and the ground along it never further above or below
 * that steady climb than a road's grading cuts or fills.
 *
 * Not the step-by-step slope test every other line gets: a half turn on a hillside points straight
 * up it at some moment, so on any slope steeper than the limit a turn always fails that - and a
 * real switchback is not laid on the slope, it is cut into it, levelled across. The road's own
 * profile (roadNetwork.ts's computeRoadProfile) is what then levels it.
 */
function switchbackIsBuildable(run: CellPoint[], chordIsClear: ChordTest, heightAt: HeightAt): boolean {
  for (let step = 0; step < run.length - 1; step++) {
    if (!chordIsClear(run[step], run[step + 1], true)) return false;
  }
  const arcs = [0];
  for (let i = 1; i < run.length; i++) arcs.push(arcs[i - 1] + Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z));
  const length = arcs[arcs.length - 1];
  const heights = run.map((point) => heightAt(point.x, point.z));
  const first = heights[0];
  const last = heights[heights.length - 1];
  if (Math.abs(last - first) / length > ROAD_MAX_GRADE) return false;
  return heights.every((height, i) => {
    const level = first + ((last - first) * arcs[i]) / length;
    return height - level <= ROAD_PROFILE_MAX_CUT && level - height <= ROAD_PROFILE_MAX_FILL;
  });
}

/** How much of a straight run lies inside a river channel. */
export type RiverLength = (from: CellPoint, to: CellPoint) => number;

/**
 * Replaces runs of lattice steps with the longest straight line that is still road-worthy.
 *
 * An 8-neighbour grid can only travel at multiples of 45 degrees, so a road running at any other
 * angle comes out as a staircase - alternating straight and diagonal steps, which is exactly what
 * it looks like. That is a property of the search space, not of the route: the straight line the
 * staircase approximates is usually perfectly buildable, and the grid simply had no way to express
 * it.
 *
 * So this is not a smoothing pass. It does not move the road toward some average of where it was;
 * it asks whether a straight run is allowed and takes it when it is, which both removes the
 * staircase and makes the line MORE faithful to the terrain than the one it replaces - the chord
 * is checked over the same lattice at the same grade limit the search used. Smoothing does the
 * opposite, moving the line onto ground nothing ever checked.
 *
 * Spans are tried longest-first from a fixed ladder, so each anchor costs a handful of chord tests
 * rather than a scan, and the chords themselves are nearly free because every cell they cross is
 * already in the pathfinder's cache.
 *
 * A chord is refused if it would spend longer in a river channel than the path it replaces. Without
 * that, straightening quietly undid the router's crossings: it cannot see the crossing COST, only
 * whether the ground is passable, so it would cut a chord diagonally across a channel the route had
 * carefully crossed square-on. Measured, that took river crossings from 65 to 152, with one chord
 * running 919 units along a river - a road in a river, not a road over one.
 */
export function straighten(points: CellPoint[], chordIsClear: ChordTest, riverLength: RiverLength): CellPoint[] {
  if (points.length < 3) return points;

  const result: CellPoint[] = [points[0]];
  let anchor = 0;

  while (anchor < points.length - 1) {
    let next = anchor + 1;
    for (const span of ROAD_STRAIGHTEN_SPAN_STEPS) {
      const candidate = Math.min(anchor + span, points.length - 1);
      if (candidate <= anchor + 1) continue;
      if (!chordIsClear(points[anchor], points[candidate])) continue;

      let replaced = 0;
      for (let i = anchor; i < candidate; i++) replaced += riverLength(points[i], points[i + 1]);
      if (riverLength(points[anchor], points[candidate]) > replaced + ROAD_RIVER_STRAIGHTEN_SLACK) continue;

      next = candidate;
      break;
    }
    result.push(points[next]);
    anchor = next;
  }

  return result;
}

/**
 * A switchback round a sharp corner: the road leaves the first leg where the two legs are `apart`
 * from each other (or at `maxReach`, if they meet more gently than that), swings out past the
 * corner round a half circle `apart` across, and rejoins the second leg as far down it. Rounding the
 * corner on the inside instead brings the two legs together - a road running into itself.
 *
 * The joins to the legs are Hermite curves, tangent to the leg at one end and to the circle at the
 * other, so the line has no kink anywhere.
 */
export function switchback(before: CellPoint, corner: CellPoint, after: CellPoint, apart: number, maxReach: number): CellPoint[] {
  const unit = (x: number, z: number): [number, number] => {
    const length = Math.hypot(x, z);
    return [x / length, z / length];
  };
  const u1 = unit(before.x - corner.x, before.z - corner.z);
  const u2 = unit(after.x - corner.x, after.z - corner.z);
  // Into the wedge between the legs, and across it from the first leg's side to the second's.
  const inward = unit(u1[0] + u2[0], u1[1] + u2[1]);
  const across = unit(u2[0] - u1[0], u2[1] - u1[1]);
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))) / 2;
  const reach = Math.min(maxReach, apart / 2 / Math.max(Math.sin(halfAngle), 1e-3));
  const radius = apart / 2;

  const start: [number, number] = [corner.x + u1[0] * reach, corner.z + u1[1] * reach];
  const end: [number, number] = [corner.x + u2[0] * reach, corner.z + u2[1] * reach];
  // The circle's centre stands a little past the corner, so the turn is round the outside of it.
  const centre: [number, number] = [corner.x - inward[0] * radius * 0.5, corner.z - inward[1] * radius * 0.5];
  const enter: [number, number] = [centre[0] - across[0] * radius, centre[1] - across[1] * radius];
  const leave: [number, number] = [centre[0] + across[0] * radius, centre[1] + across[1] * radius];

  const hermite = (p0: [number, number], m0: [number, number], p1: [number, number], m1: [number, number], s: number): CellPoint => {
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    return {
      x: h00 * p0[0] + h10 * m0[0] + h01 * p1[0] + h11 * m1[0],
      z: h00 * p0[1] + h10 * m0[1] + h01 * p1[1] + h11 * m1[1],
    };
  };

  const segments = ROAD_SWITCHBACK_SEGMENTS;
  const points: CellPoint[] = [];
  const inSpan = Math.hypot(enter[0] - start[0], enter[1] - start[1]);
  for (let i = 0; i < segments; i++) {
    points.push(hermite(start, [-u1[0] * inSpan, -u1[1] * inSpan], enter, [-inward[0] * inSpan, -inward[1] * inSpan], i / segments));
  }
  // Round the far side of the circle, from the first leg's side to the second's.
  for (let i = 0; i < segments * 2; i++) {
    const angle = (Math.PI * i) / (segments * 2);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    points.push({ x: centre[0] + (-across[0] * c - inward[0] * s) * radius, z: centre[1] + (-across[1] * c - inward[1] * s) * radius });
  }
  const outSpan = Math.hypot(end[0] - leave[0], end[1] - leave[1]);
  for (let i = 0; i <= segments; i++) {
    points.push(hermite(leave, [inward[0] * outSpan, inward[1] * outSpan], end, [u2[0] * outSpan, u2[1] * outSpan], i / segments));
  }
  return points;
}

/**
 * Rounds each corner with an arc of bounded radius.
 *
 * Deliberately not Chaikin, which is what shaped rivers and what this originally used. Chaikin cuts
 * a corner by a fraction of the adjoining segments, so once straightening has produced segments
 * hundreds of units long it rounds the corner over hundreds of units - it would undo the straight
 * runs it was given. A fixed radius rounds a corner the way a road is actually built, by the same
 * amount whether the straights either side are 60 units or 600.
 *
 * The radius shrinks to fit short segments, so two corners close together cannot overlap and cross
 * the line over itself, and each arc is checked before it is taken: at ROAD_CORNER_RADIUS the arc
 * strays at most a quarter of that from the corner, but a quarter of it can still be a cliff.
 */
export function roundCorners(points: CellPoint[], chordIsClear: ChordTest, heightAt: HeightAt): CellPoint[] {
  if (points.length < 3) return points;

  const result: CellPoint[] = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1];
    const corner = points[i];
    const after = points[i + 1];

    const inLength = Math.hypot(corner.x - before.x, corner.z - before.z);
    const outLength = Math.hypot(after.x - corner.x, after.z - corner.z);
    // Half of each neighbouring segment at most, so the arcs of two adjacent corners meet rather
    // than overlap.
    const fullRadius = Math.min(ROAD_CORNER_RADIUS, inLength / 2, outLength / 2);
    if (fullRadius <= 0 || inLength <= 0 || outLength <= 0) {
      result.push(corner);
      continue;
    }

    // The full radius first, then smaller ones: on a hillside the arc cuts across ground the
    // straights did not touch, often too steep, and a corner left sharp is a hairpin cut at a
    // point. A tighter arc stays near the corner and is nearly always buildable, and a rounded
    // corner of any size beats a sharp one.
    // A quadratic from `radius` back along one straight to `radius` out along the other, with the
    // corner as the control point: tangent to both at the joins, so the line leaves and rejoins
    // them without a kink.
    const arcOf = (radius: number): CellPoint[] => {
      const start = {
        x: corner.x + ((before.x - corner.x) / inLength) * radius,
        z: corner.z + ((before.z - corner.z) / inLength) * radius,
      };
      const end = {
        x: corner.x + ((after.x - corner.x) / outLength) * radius,
        z: corner.z + ((after.z - corner.z) / outLength) * radius,
      };
      const run: CellPoint[] = [start];
      for (let step = 1; step < ROAD_CORNER_SEGMENTS; step++) {
        const t = step / ROAD_CORNER_SEGMENTS;
        const inv = 1 - t;
        run.push({
          x: inv * inv * start.x + 2 * inv * t * corner.x + t * t * end.x,
          z: inv * inv * start.z + 2 * inv * t * corner.z + t * t * end.z,
        });
      }
      run.push(end);
      return run;
    };

    let rounded: CellPoint[] | null = null;
    // A corner sharper than a right angle is a switchback: rounded inside, its two legs would run
    // into each other - the road beside itself, overlapping, all the way in to the turn. It swings
    // out round the corner instead, holding the legs apart.
    const along = ((before.x - corner.x) * (after.x - corner.x) + (before.z - corner.z) * (after.z - corner.z)) / (inLength * outLength);
    if (along > Math.cos(ROAD_SWITCHBACK_ANGLE)) {
      // As far apart as the road is wide there - a narrowed mountain road turns tighter.
      const width = steepWidth(heightAt, corner.x, corner.z);
      for (const apart of ROAD_SWITCHBACK_APART) {
        const run = switchback(before, corner, after, apart * width,Math.min(inLength, outLength) * ROAD_SWITCHBACK_REACH_SHARE);
        if (switchbackIsBuildable(run, chordIsClear, heightAt)) {
          rounded = run;
          break;
        }
      }
    }
    for (const share of ROAD_CORNER_RADIUS_SHARES) {
      if (rounded) break;
      const radius = fullRadius * share;
      if (radius < ROAD_CORNER_MIN_RADIUS) break;
      // Checked as one run through its own points; if any part is not buildable, try a tighter one.
      const run = arcOf(radius);
      let clear = true;
      for (let step = 0; step < run.length - 1 && clear; step++) {
        if (!chordIsClear(run[step], run[step + 1])) clear = false;
      }
      if (clear) {
        rounded = run;
        break;
      }
    }
    // Nothing passed: a small arc anyway, unchecked. Its middle is half its radius from the corner
    // at most, so at ROAD_CORNER_FREE_RADIUS it never leaves the level ground the road grades
    // round its own corner - there is no new ground for a check to refuse.
    rounded ??= arcOf(Math.min(fullRadius, ROAD_CORNER_FREE_RADIUS));

    result.push(...rounded);
  }

  result.push(points[points.length - 1]);
  return result;
}

/**
 * Pulls a shaped road onto roads already built where it runs alongside them.
 *
 * Straightening is a per-link decision: two links whose routes follow exactly the same lattice
 * nodes still pick their anchors at different places along their own point lists, so their chords
 * come out up to half a grid step apart. On the ground that is two roads a stone's throw apart
 * where the router intended one. Measured, straightening moved 21.8% of all nearby road length out
 * of the "exactly overlaid" band and into a 10-50 unit gap - which is lattice scale, and is the
 * tell that this is a shaping artifact rather than two genuinely different routes.
 *
 * Snapping to the earlier road's own geometry makes the shared stretch identical rather than
 * merely similar. It is also safe by construction: a point is only ever moved onto a road that was
 * itself validated, so it cannot land on ground nothing checked.
 */
export interface SnapIndex {
  add(points: CellPoint[]): void;
  snap(point: CellPoint): CellPoint | null;
}

export function createSnapIndex(snapDistance: number): SnapIndex {
  const bucketSize = Math.max(snapDistance * 4, 100);
  const buckets = new Map<number, { ax: number; az: number; bx: number; bz: number }[]>();
  const key = (gx: number, gz: number): number => (gx + 32768) * 65536 + (gz + 32768);

  return {
    add(points) {
      for (let i = 0; i < points.length - 1; i++) {
        const segment = { ax: points[i].x, az: points[i].z, bx: points[i + 1].x, bz: points[i + 1].z };
        const gxMin = Math.floor((Math.min(segment.ax, segment.bx) - snapDistance) / bucketSize);
        const gxMax = Math.floor((Math.max(segment.ax, segment.bx) + snapDistance) / bucketSize);
        const gzMin = Math.floor((Math.min(segment.az, segment.bz) - snapDistance) / bucketSize);
        const gzMax = Math.floor((Math.max(segment.az, segment.bz) + snapDistance) / bucketSize);
        for (let gx = gxMin; gx <= gxMax; gx++) {
          for (let gz = gzMin; gz <= gzMax; gz++) {
            const bucket = buckets.get(key(gx, gz));
            if (bucket) bucket.push(segment);
            else buckets.set(key(gx, gz), [segment]);
          }
        }
      }
    },

    snap(point) {
      const bucket = buckets.get(key(Math.floor(point.x / bucketSize), Math.floor(point.z / bucketSize)));
      if (!bucket) return null;

      let bestDistSq = snapDistance * snapDistance;
      let best: CellPoint | null = null;
      for (const segment of bucket) {
        const dx = segment.bx - segment.ax;
        const dz = segment.bz - segment.az;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq <= 0) continue;
        const u = Math.min(1, Math.max(0, ((point.x - segment.ax) * dx + (point.z - segment.az) * dz) / lengthSq));
        const cx = segment.ax + dx * u;
        const cz = segment.az + dz * u;
        const distSq = (cx - point.x) ** 2 + (cz - point.z) ** 2;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          best = { x: cx, z: cz };
        }
      }
      return best;
    },
  };
}

/**
 * Moves everything within the snap distance of an already-built road onto it.
 *
 * The line is resampled first, and that is the whole trick. Snapping only the vertices leaves the
 * straight chord between two snapped vertices cutting across whatever the existing road does in
 * between: measured at Mabraen Crossing, the road to Laemora had vertices lying exactly on the road
 * to Rothwell Steps and still bowed about 25 units away from it between them, because the Rothwell
 * road bends twice over that stretch and the chord does not. Two roads leaving one town, touching
 * at two points and forming a long thin lens in between - which is exactly what it looks like.
 *
 * Resampling to well under the snap distance means the shared stretch is followed rather than
 * merely met, and simplification afterwards throws away every point that adds nothing.
 */
export function snapToNetwork(points: CellPoint[], index: SnapIndex, step: number): CellPoint[] {
  const dense: CellPoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(length / step));
    for (let k = 0; k < steps; k++) {
      const u = k / steps;
      dense.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
    }
  }
  dense.push(points[points.length - 1]);
  // The two ends stay put: a road ends at a settlement's gate, and a gate's position (and the height
  // its roads and main street are joined at) is fixed.
  return dense.map((point, i) => (i === 0 || i === dense.length - 1 ? point : (index.snap(point) ?? point)));
}

/** A lateral displacement for a point, from a noise field. See `wobble`. */
export type Wobble = (x: number, z: number) => number;

/**
 * Adds a small sideways wander to the straight parts of a road.
 *
 * Routed roads are straight because the cost function has no reason to make them anything else,
 * and a line that is straight to the world unit reads as surveyed rather than trodden. This is the
 * one part of a road's shape that answers to nothing but appearance, so it is kept small enough
 * that it cannot argue with anything the router decided.
 *
 * Two properties are load-bearing:
 *
 * The displacement is a function of WORLD POSITION, not of distance along the road. That is the
 * opposite of how river meanders are parameterised, and deliberately so: two roads sharing a
 * stretch have the same tangent there, so a position-based field gives them the same displacement
 * and they stay exactly on top of each other. Arc-length noise would give each its own phase and
 * re-open the gap between shared roads that `snapToNetwork` exists to close.
 *
 * And it only applies where the road is already running straight. Where it is turning, the shape
 * is the router's answer to the terrain, and wobbling it would be second-guessing a decision made
 * for a reason. Straightness is measured over a window and faded rather than switched, so the
 * wander dies away as a bend approaches instead of stopping at an edge.
 */
export function wobble(
  points: CellPoint[],
  displacement: Wobble,
  sampleStep: number,
  straightWindow: number,
  turnFadeStart: number,
  turnFadeEnd: number,
  endTaper: number,
): CellPoint[] {
  if (points.length < 2) return points;

  // Resampled fine enough to carry the wander - a wavelength needs several points or it comes out
  // as a straight line through a few displaced corners.
  const dense: CellPoint[] = [];
  const arcs: number[] = [];
  let travelled = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length <= 0) continue;
    const steps = Math.max(1, Math.ceil(length / sampleStep));
    for (let k = 0; k < steps; k++) {
      const u = k / steps;
      dense.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
      arcs.push(travelled + length * u);
    }
    travelled += length;
  }
  dense.push(points[points.length - 1]);
  arcs.push(travelled);
  if (dense.length < 3) return points;

  const windowSteps = Math.max(1, Math.round(straightWindow / sampleStep));

  return dense.map((point, i) => {
    const backIndex = Math.max(0, i - windowSteps);
    const forwardIndex = Math.min(dense.length - 1, i + windowSteps);
    const back = dense[backIndex];
    const forward = dense[forwardIndex];

    const inX = point.x - back.x;
    const inZ = point.z - back.z;
    const outX = forward.x - point.x;
    const outZ = forward.z - point.z;
    const inLength = Math.hypot(inX, inZ);
    const outLength = Math.hypot(outX, outZ);
    if (inLength <= 0 || outLength <= 0) return point;

    // How much the road turns across the window, in degrees. Straight is 0.
    const cos = Math.min(1, Math.max(-1, (inX * outX + inZ * outZ) / (inLength * outLength)));
    const turn = (Math.acos(cos) * 180) / Math.PI;
    const straightness = 1 - smoothstepLocal(turnFadeStart, turnFadeEnd, turn);
    if (straightness <= 0) return point;

    // Held to zero at both ends, so a road still meets its settlements exactly where it was routed
    // to and a junction does not come apart by a couple of units.
    const arc = arcs[i];
    const taper = smoothstepLocal(0, endTaper, arc) * smoothstepLocal(0, endTaper, travelled - arc);

    const offset = displacement(point.x, point.z) * straightness * taper;
    const nx = -(outZ + inZ) / (inLength + outLength);
    const nz = (outX + inX) / (inLength + outLength);
    return { x: point.x + nx * offset, z: point.z + nz * offset };
  });
}

function smoothstepLocal(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
