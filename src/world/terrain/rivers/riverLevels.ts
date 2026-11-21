import { deriveSeed, mulberry32 } from "../../rng";
import { lerp, smoothstep } from "../../mathUtils";
import type { CellPoint } from "../../cells/cellGrid";
import {
  RIVER_BANK_SLOPE,
  RIVER_BED_HALF_WIDTH_MOUTH,
  RIVER_BED_HALF_WIDTH_SOURCE,
  RIVER_EDGE_NOISE_AMPLITUDE_RATIO,
  RIVER_FORDS_MAX,
  RIVER_FORD_DEPTH,
  RIVER_FORD_LENGTH,
  RIVER_FORD_MIN_LENGTH,
  RIVER_FORD_SALT,
  RIVER_FREEBOARD,
  RIVER_JOIN_REACH,
  RIVER_LEVEL_SMOOTHING,
  RIVER_MAX_FALL,
  RIVER_MAX_UNDERCUT,
  RIVER_MIN_FALL,
  RIVER_REACH_MARGIN,
  RIVER_SPRING_DEPTH,
  RIVER_SPRING_HALF_WIDTH,
  RIVER_SPRING_LENGTH,
  RIVER_STATION_SPACING,
  RIVER_WATER_DEPTH_MOUTH,
  RIVER_WATER_DEPTH_SOURCE,
} from "./riverConfig";

/** Where across its width a river reads the ground for its ceiling, as shares of its reach. */
const RIVER_BANK_PROBES = [0.35, 0.7, 1];

/**
 * One river's water, sampled at stations spaced evenly along its centreline (mouth first): where each
 * is, the height of the water's surface there, how deep the water is under it, how wide its flat bed
 * is, and how far from the centreline the water reaches (the valley's waterline plus the edge jitter's
 * room). Everything that wants "the river at arc fraction t" - the carve, the water query, the ribbon
 * that draws it - reads it through `riverProfileAt`.
 */
export interface RiverProfile {
  x: Float64Array;
  z: Float64Array;
  /** The water's surface height. Never rises toward the mouth. */
  level: Float64Array;
  /** Metres of water under the surface at the centreline (the bed is `level - depth`). */
  depth: Float64Array;
  /** Half the width of the flat bed: the river's own width, narrowing to its spring. */
  halfWidth: Float64Array;
  /** How far from the centreline the water can lie. */
  reach: Float64Array;
  /** The river's length along its centreline, metres. */
  length: number;
}

export interface RiverWaterSample {
  level: number;
  depth: number;
  halfWidth: number;
  reach: number;
}

/** The river at arc fraction `t` (0 mouth, 1 source), interpolated between its stations. */
export function riverProfileAt(profile: RiverProfile, t: number, out: RiverWaterSample): RiverWaterSample {
  const last = profile.level.length - 1;
  const f = Math.min(last, Math.max(0, t * last));
  const i = Math.min(last - 1, Math.floor(f));
  const u = f - i;
  out.level = profile.level[i] + (profile.level[i + 1] - profile.level[i]) * u;
  out.depth = profile.depth[i] + (profile.depth[i + 1] - profile.depth[i]) * u;
  out.halfWidth = profile.halfWidth[i] + (profile.halfWidth[i + 1] - profile.halfWidth[i]) * u;
  out.reach = profile.reach[i] + (profile.reach[i + 1] - profile.reach[i]) * u;
  return out;
}

/** Each river's spring: where its source is. */
export function riverSprings(profiles: readonly RiverProfile[]): { x: number; z: number }[] {
  return profiles.map((p) => ({ x: p.x[p.x.length - 1], z: p.z[p.z.length - 1] }));
}

/** Positions at `count` evenly spaced arc lengths along a polyline, ends included. */
function resample(polyline: readonly CellPoint[], count: number): { x: Float64Array; z: Float64Array; length: number } {
  const cumulative = [0];
  for (let i = 1; i < polyline.length; i++) cumulative.push(cumulative[i - 1] + Math.hypot(polyline[i].x - polyline[i - 1].x, polyline[i].z - polyline[i - 1].z));
  const length = cumulative[cumulative.length - 1];
  const x = new Float64Array(count);
  const z = new Float64Array(count);
  let k = 1;
  for (let i = 0; i < count; i++) {
    const s = (length * i) / (count - 1);
    while (k < polyline.length - 1 && cumulative[k] < s) k++;
    const span = Math.max(1e-9, cumulative[k] - cumulative[k - 1]);
    const u = Math.min(1, Math.max(0, (s - cumulative[k - 1]) / span));
    x[i] = polyline[k - 1].x + (polyline[k].x - polyline[k - 1].x) * u;
    z[i] = polyline[k - 1].z + (polyline[k].z - polyline[k - 1].z) * u;
  }
  return { x, z, length };
}

/** The ground at (x, z) as another river's valley leaves it: its bank's profile, rising from its bed. */
function cutByOther(other: RiverProfile, x: number, z: number): number {
  let best = Infinity;
  let at = 0;
  for (let i = 0; i < other.level.length; i++) {
    const d = (other.x[i] - x) ** 2 + (other.z[i] - z) ** 2;
    if (d < best) {
      best = d;
      at = i;
    }
  }
  const d = Math.sqrt(best);
  // In its water, its surface is what a river meeting it runs down to (plus the bank this one keeps).
  if (d < other.reach[at]) return other.level[at] + RIVER_FREEBOARD;
  const edge = other.halfWidth[at] * (1 + RIVER_EDGE_NOISE_AMPLITUDE_RATIO);
  return other.level[at] - other.depth[at] + RIVER_BANK_SLOPE * Math.max(0, d - edge);
}

/**
 * The water of every river, at its own level (WATER.md, *Water at its own level*).
 *
 * The surface starts at the source, no higher than the ground there, and runs down the river never
 * rising and never above the ground anywhere across its width (less a little freeboard, so a bank
 * stands over it) - the ground as the other rivers' valleys leave it too, so where two come close the
 * higher does not stand over the lower's cut. Where the land falls, the water falls with it; where it
 * climbs again the water keeps its level and the valley deepens around it. Smoothing keeps it from
 * stepping with the ground. At the mouth it meets the sea - or the river it joins - and nothing runs
 * below that. A river narrows and shallows over its last stretch to a spring. Fords are shallow
 * stretches (a road can wade them) rolled per river.
 *
 * `baseHeight` is the ground as the river finds it: before its own cut, after the coast and the lakes.
 */
export function buildRiverProfiles(
  polylines: ReadonlyArray<ReadonlyArray<CellPoint>>,
  baseHeight: (x: number, z: number) => number,
  seaSurface: number,
  seed: number,
): RiverProfile[] {
  // Twice: the second time each river's ceiling also counts the other rivers' valleys as the first
  // pass laid them.
  const first = buildPass(polylines, baseHeight, seaSurface, seed, null);
  return buildPass(polylines, baseHeight, seaSurface, seed, first);
}

function buildPass(
  polylines: ReadonlyArray<ReadonlyArray<CellPoint>>,
  baseHeight: (x: number, z: number) => number,
  seaSurface: number,
  seed: number,
  previous: RiverProfile[] | null,
): RiverProfile[] {
  const profiles: RiverProfile[] = [];
  /** Which earlier river each joins, and at which of its stations (-1: the sea). */
  const joins: { parent: number; station: number }[] = [];
  polylines.forEach((polyline, river) => {
    const rough = resample(polyline, 2);
    const count = Math.max(3, Math.ceil(rough.length / RIVER_STATION_SPACING) + 1);
    const { x, z, length } = resample(polyline, count);
    const step = length / (count - 1);

    // Where it meets the water it drains into.
    let mouth = seaSurface;
    let nearest = RIVER_JOIN_REACH;
    const join = { parent: -1, station: -1 };
    profiles.forEach((other, parent) => {
      for (let i = 0; i < other.level.length; i++) {
        const d = Math.hypot(other.x[i] - x[0], other.z[i] - z[0]);
        if (d < nearest) {
          nearest = d;
          mouth = Math.max(seaSurface, other.level[i]);
          join.parent = parent;
          join.station = i;
        }
      }
    });
    joins.push(join);

    // Its width and depth: from the mouth's to the source's, then down to a spring over the last stretch.
    const rng = mulberry32(deriveSeed(seed, RIVER_FORD_SALT + river * 31));
    const fords: number[] = [];
    if (length >= RIVER_FORD_MIN_LENGTH) {
      const wanted = 1 + Math.floor(rng() * RIVER_FORDS_MAX);
      for (let k = 0; k < wanted; k++) fords.push(0.2 + rng() * 0.6);
    }
    const fordHalf = RIVER_FORD_LENGTH / 2 / length;
    const depth = new Float64Array(count);
    const halfWidth = new Float64Array(count);
    const reach = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const spring = smoothstep(0, Math.min(RIVER_SPRING_LENGTH, length * 0.5), (count - 1 - i) * step);
      let ford = 0;
      for (const at of fords) ford = Math.max(ford, 1 - smoothstep(fordHalf * 0.4, fordHalf, Math.abs(t - at)));
      depth[i] = lerp(lerp(RIVER_SPRING_DEPTH, lerp(RIVER_WATER_DEPTH_MOUTH, RIVER_WATER_DEPTH_SOURCE, t), spring), RIVER_FORD_DEPTH, ford);
      halfWidth[i] = lerp(RIVER_SPRING_HALF_WIDTH, lerp(RIVER_BED_HALF_WIDTH_MOUTH, RIVER_BED_HALF_WIDTH_SOURCE, t), spring);
      reach[i] = halfWidth[i] * (1 + RIVER_EDGE_NOISE_AMPLITUDE_RATIO) + depth[i] / RIVER_BANK_SLOPE + RIVER_REACH_MARGIN;
    }

    // The water stands no higher than the ground anywhere across its width - both banks, not only the
    // line (a river along a hillside would otherwise hang over the side that falls away) - nor than the
    // other rivers' valleys leave it.
    const ground = (px: number, pz: number): number => {
      let h = baseHeight(px, pz);
      if (previous) previous.forEach((other, k) => k !== river && (h = Math.min(h, cutByOther(other, px, pz))));
      return h;
    };
    const ceiling = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(count - 1, i + 1);
      const tl = Math.hypot(x[b] - x[a], z[b] - z[a]) || 1;
      const nx = -(z[b] - z[a]) / tl;
      const nz = (x[b] - x[a]) / tl;
      const across = reach[i] - RIVER_REACH_MARGIN;
      let low = ground(x[i], z[i]);
      for (const f of RIVER_BANK_PROBES) {
        low = Math.min(low, ground(x[i] + nx * across * f, z[i] + nz * across * f), ground(x[i] - nx * across * f, z[i] - nz * across * f));
      }
      ceiling[i] = low - RIVER_FREEBOARD;
    }

    // How steeply it may fall at each station: under the bank's slope, and gentler the wider it is - a
    // flat bed reaches back up the river by its own width, so a wide river falling steeply cuts under
    // its own water upstream. A narrow head may run steep; a broad river runs gently.
    const maxFall = new Float64Array(count);
    for (let i = 0; i < count; i++) maxFall[i] = Math.min(RIVER_MAX_FALL, RIVER_MAX_UNDERCUT / (halfWidth[i] * (1 + RIVER_EDGE_NOISE_AMPLITUDE_RATIO)));
    const level = new Float64Array(count);
    const fit = (): void => {
      for (let i = count - 2; i >= 0; i--) level[i] = Math.min(level[i], level[i + 1]);
      for (let i = 0; i < count; i++) level[i] = Math.max(mouth, Math.min(level[i], ceiling[i]));
      for (let i = count - 2; i >= 0; i--) level[i] = Math.min(level[i], level[i + 1]);
      for (let i = 1; i < count; i++) level[i] = Math.min(level[i], level[i - 1] + maxFall[i] * step);
    };
    // From the source down, falling at least a little, never over the ground.
    level[count - 1] = ceiling[count - 1];
    for (let i = count - 2; i >= 0; i--) level[i] = Math.min(ceiling[i], level[i + 1] - RIVER_MIN_FALL * step);
    fit();
    for (let pass = 0; pass < RIVER_LEVEL_SMOOTHING; pass++) {
      const before = Float64Array.from(level);
      for (let i = 1; i < count - 1; i++) level[i] = (before[i - 1] + 2 * before[i] + before[i + 1]) / 4;
      fit();
    }
    // Never over the ground, whatever the mouth asked for: a tributary whose ground lies below its
    // trunk's water where they meet ends below it rather than standing in the air over its valley.
    // Never under the sea either - the sea plane covers what is below it.
    for (let i = 0; i < count; i++) level[i] = Math.max(seaSurface, Math.min(level[i], ceiling[i]));
    level[0] = Math.max(seaSurface, Math.min(mouth, ceiling[0]));
    for (let i = count - 2; i >= 0; i--) level[i] = Math.min(level[i], level[i + 1]);
    for (let i = 1; i < count; i++) level[i] = Math.min(level[i], level[i - 1] + maxFall[i] * step);

    for (let i = 0; i < count; i++) reach[i] = halfWidth[i] * (1 + RIVER_EDGE_NOISE_AMPLITUDE_RATIO) + depth[i] / RIVER_BANK_SLOPE + RIVER_REACH_MARGIN;

    profiles.push({ x, z, level, depth, halfWidth, reach, length });

    // A tributary whose valley lies below its trunk's water where they meet: the trunk falls to it
    // there (a rapid or a fall above the join) and runs on at no more than its level - and so on down,
    // if that trunk is itself a tributary. Two waters meet at one level.
    let child = river;
    while (joins[child].parent >= 0) {
      const { parent, station } = joins[child];
      const meet = profiles[child].level[0];
      const trunk = profiles[parent].level;
      if (trunk[station] <= meet + 1e-9) break;
      for (let k = 0; k <= station; k++) trunk[k] = Math.min(trunk[k], meet);
      child = parent;
    }
  });
  return profiles;
}
