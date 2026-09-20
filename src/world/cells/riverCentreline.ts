import type { CellPoint } from "./cellGrid";
import { createBaseNoise2D } from "../terrain/noise";
import { deriveSeed } from "../rng";
import { smoothstep } from "../mathUtils";
import {
  RIVER_MEANDER_SAMPLE_STEP,
  RIVER_MEANDER_MAX_AMPLITUDE,
  RIVER_MEANDER_ROOM_FRACTION,
  RIVER_MEANDER_CLEARANCE_FRACTION,
  RIVER_MEANDER_WAVELENGTH,
  RIVER_MEANDER_DETAIL_WAVELENGTH,
  RIVER_MEANDER_DETAIL_RATIO,
  RIVER_MEANDER_END_TAPER,
  RIVER_SMOOTHING_PASSES,
  RIVER_SIMPLIFY_TOLERANCE,
  RIVER_MEANDER_SALT,
} from "../terrain/rivers/riverConfig";

/** Walks the polyline at a fixed arc step, carrying each new point's arc length and an
 *  interpolation of the per-vertex corridor room along with it. */
function resample(vertices: CellPoint[], rooms: number[], step: number): { points: CellPoint[]; arcs: number[]; rooms: number[]; total: number } {
  const points: CellPoint[] = [];
  const arcs: number[] = [];
  const sampledRooms: number[] = [];
  let travelled = 0;

  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i];
    const b = vertices[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length <= 0) continue;
    const count = Math.max(1, Math.round(length / step));
    for (let k = 0; k < count; k++) {
      const u = k / count;
      points.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
      arcs.push(travelled + length * u);
      sampledRooms.push(rooms[i] + (rooms[i + 1] - rooms[i]) * u);
    }
    travelled += length;
  }

  const last = vertices[vertices.length - 1];
  points.push({ x: last.x, z: last.z });
  arcs.push(travelled);
  sampledRooms.push(rooms[rooms.length - 1]);
  return { points, arcs, rooms: sampledRooms, total: travelled };
}

/** Chaikin corner cutting, with both ends pinned - the mouth has to stay exactly on the shore it
 *  was placed on, and the source where the river was generated to end. */
function chaikin(points: CellPoint[], passes: number): CellPoint[] {
  let current = points;
  for (let pass = 0; pass < passes; pass++) {
    if (current.length < 3) return current;
    const next: CellPoint[] = [current[0]];
    for (let i = 0; i < current.length - 1; i++) {
      const a = current[i];
      const b = current[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

/**
 * Ramer-Douglas-Peucker. Resampling and two Chaikin passes leave points every few units, and
 * riverField tests every segment in a bucket against every terrain sample - so the segment count is
 * a direct cost on terrain generation. Dropping points that sit within a couple of units of the
 * line through their neighbours cuts that by an order of magnitude and is invisible against a
 * channel over a hundred units wide.
 */
function simplify(points: CellPoint[], tolerance: number): CellPoint[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const toleranceSq = tolerance * tolerance;

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    const a = points[first];
    const b = points[last];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;

    let worst = -1;
    let worstDistSq = 0;
    for (let i = first + 1; i < last; i++) {
      const px = points[i].x - a.x;
      const pz = points[i].z - a.z;
      const u = lengthSq > 0 ? Math.min(1, Math.max(0, (px * dx + pz * dz) / lengthSq)) : 0;
      const ox = px - u * dx;
      const oz = pz - u * dz;
      const distSq = ox * ox + oz * oz;
      if (distSq > worstDistSq) {
        worstDistSq = distSq;
        worst = i;
      }
    }

    if (worst >= 0 && worstDistSq > toleranceSq) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  return points.filter((_, i) => keep[i] === 1);
}

/** How far a point may move sideways before it leaves the corridor of cells the river runs
 *  through - i.e. before it would be inside some other cell, and so possibly some other zone. */
export type Clearance = (point: CellPoint) => number;

/** Where two segments properly cross, or null. Shared endpoints do not count - consecutive
 *  segments always have one. */
function crossingPoint(a: CellPoint, b: CellPoint, c: CellPoint, d: CellPoint): CellPoint | null {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const denominator = rx * sz - rz * sx;
  if (denominator === 0) return null;

  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / denominator;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / denominator;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { x: a.x + rx * t, z: a.z + rz * t };
}

/**
 * Cuts out any loop the displacement created.
 *
 * Offsetting a line sideways makes it cross itself wherever the offset exceeds the local radius of
 * curvature, which at a sharp corner of the generated path is small. Measured, that left 1-11
 * crossings per seed - every one of them a cusp of 10-600 units of arc, never a real oxbow.
 * Bounding the amplitude by curvature would give up real meanders everywhere to prevent them; this
 * deletes exactly the offending loop and leaves the rest of the line untouched, and it is exact
 * rather than a margin that has to be tuned.
 */
function removeLoops(points: CellPoint[]): CellPoint[] {
  let current = points;
  for (let guard = 0; guard < 64; guard++) {
    let cut: { from: number; to: number; at: CellPoint } | null = null;
    outer: for (let i = 0; i < current.length - 1 && !cut; i++) {
      for (let j = i + 2; j < current.length - 1; j++) {
        const at = crossingPoint(current[i], current[i + 1], current[j], current[j + 1]);
        if (at) {
          cut = { from: i, to: j, at };
          break outer;
        }
      }
    }
    if (!cut) return current;
    // Keep everything up to the first segment's start, the crossing itself, then resume after the
    // second segment's start - which is precisely the loop between them, removed.
    current = [...current.slice(0, cut.from + 1), cut.at, ...current.slice(cut.to + 1)];
  }
  return current;
}

export type CentrelineShaper = (
  vertices: CellPoint[],
  rooms: number[],
  clearanceAt: Clearance,
  riverIndex: number,
) => CellPoint[];

/**
 * Turns a river's raw chain of cell-border midpoints into something that looks like a river:
 * resampled, pushed side to side by a noise field, and rounded off.
 *
 * The raw chain is a handful of points hundreds of units apart, so a river reads as a sequence of
 * long straight runs meeting at angles. Displacing it sideways along its own arc length is what
 * turns that into meanders, and doing it as a function of arc length rather than of world position
 * is what keeps the wave travelling ALONG the river instead of a noise field being stamped over it.
 *
 * The amplitude is bounded by how much room the corridor actually has, not by a single constant,
 * and the binding bound is measured per point rather than estimated per vertex - see the comment on
 * `room` below. Since area borders are cell borders, keeping the line inside the cells its path
 * runs through is also what stops a meander from swinging across a zone boundary into a
 * neighbouring biome. On top of that the amplitude tapers to zero at both ends, so the mouth stays
 * exactly on the shore it was placed on.
 */
export function createCentrelineShaper(seed: number): CentrelineShaper {
  const wiggle2D = createBaseNoise2D(deriveSeed(seed, RIVER_MEANDER_SALT));

  return function shapeCentreline(vertices, rooms, clearanceAt, riverIndex) {
    if (vertices.length < 2) return vertices;

    const sampled = resample(vertices, rooms, RIVER_MEANDER_SAMPLE_STEP);
    if (sampled.total <= 0) return vertices;

    // Each river reads its own lane through the shared noise field, so two rivers never meander in
    // step with each other.
    const lane = riverIndex * 37.19;
    const detailNorm = 1 / (1 + RIVER_MEANDER_DETAIL_RATIO);

    const displaced: CellPoint[] = sampled.points.map((point, i) => {
      const arc = sampled.arcs[i];

      // Direction from the neighbours rather than from one segment, so the normal turns smoothly
      // through the original polyline's corners instead of snapping at them.
      const prev = sampled.points[Math.max(0, i - 1)];
      const next = sampled.points[Math.min(sampled.points.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const length = Math.hypot(dx, dz);
      if (length <= 0) return point;

      const wave =
        (wiggle2D(arc / RIVER_MEANDER_WAVELENGTH, lane) +
          RIVER_MEANDER_DETAIL_RATIO * wiggle2D(arc / RIVER_MEANDER_DETAIL_WAVELENGTH, lane + 11.3)) *
        detailNorm;

      // Three independent ceilings, smallest wins: a flat maximum, a fraction of the border this
      // station sits on, and a fraction of the room the corridor has right here. The first two are
      // estimates made at the raw vertices; the third is measured at this point, and is what lets
      // the flat maximum be set high enough to produce real meanders without the wave ever pushing
      // the line out of the cells its path runs through - and so out of its own zones.
      const room = Math.min(
        RIVER_MEANDER_MAX_AMPLITUDE,
        sampled.rooms[i] * RIVER_MEANDER_ROOM_FRACTION,
        clearanceAt(point) * RIVER_MEANDER_CLEARANCE_FRACTION,
      );
      const taper =
        smoothstep(0, RIVER_MEANDER_END_TAPER, arc) *
        smoothstep(0, RIVER_MEANDER_END_TAPER, sampled.total - arc);
      const offset = wave * room * taper;

      return { x: point.x + (-dz / length) * offset, z: point.z + (dx / length) * offset };
    });

    return simplify(removeLoops(chaikin(displaced, RIVER_SMOOTHING_PASSES)), RIVER_SIMPLIFY_TOLERANCE);
  };
}
