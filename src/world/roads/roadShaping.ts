import type { CellPoint } from "../cells/cellGrid";
import {
  ROAD_STRAIGHTEN_SPAN_STEPS,
  ROAD_CORNER_RADIUS,
  ROAD_CORNER_SEGMENTS,
  ROAD_RIVER_STRAIGHTEN_SLACK,
} from "./roadConfig";

/** Whether a straight run between two points is road-worthy - see RoadPathfinder.chordIsClear. */
export type ChordTest = (from: CellPoint, to: CellPoint) => boolean;

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
export function roundCorners(points: CellPoint[], chordIsClear: ChordTest): CellPoint[] {
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
    const radius = Math.min(ROAD_CORNER_RADIUS, inLength / 2, outLength / 2);
    if (radius <= 0 || inLength <= 0 || outLength <= 0) {
      result.push(corner);
      continue;
    }

    const start = {
      x: corner.x + ((before.x - corner.x) / inLength) * radius,
      z: corner.z + ((before.z - corner.z) / inLength) * radius,
    };
    const end = {
      x: corner.x + ((after.x - corner.x) / outLength) * radius,
      z: corner.z + ((after.z - corner.z) / outLength) * radius,
    };

    // A quadratic through start and end with the corner as the control point: tangent to both
    // straights at the joins, so the line leaves and rejoins them without a kink.
    const arc: CellPoint[] = [];
    for (let step = 1; step < ROAD_CORNER_SEGMENTS; step++) {
      const t = step / ROAD_CORNER_SEGMENTS;
      const inv = 1 - t;
      arc.push({
        x: inv * inv * start.x + 2 * inv * t * corner.x + t * t * end.x,
        z: inv * inv * start.z + 2 * inv * t * corner.z + t * t * end.z,
      });
    }

    // The arc cuts the corner, so it runs over ground the straights did not. Checked as one run
    // through its own points; if any part of it is not buildable the corner simply stays sharp.
    const run = [start, ...arc, end];
    let clear = true;
    for (let step = 0; step < run.length - 1 && clear; step++) {
      if (!chordIsClear(run[step], run[step + 1])) clear = false;
    }

    if (clear) result.push(...run);
    else result.push(corner);
  }

  result.push(points[points.length - 1]);
  return result;
}
