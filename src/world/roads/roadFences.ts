import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { PropDef } from "../props/propTypes";
import type { WallRun } from "../features/compound";
import { deriveSeed, mulberry32 } from "../rng";
import { ROAD_HALF_WIDTH } from "./roadConfig";
import type { RoadStretch } from "./roadGraph";

/**
 * Fences along the roads where the ground falls away beside them - the fill side of a road cut into
 * a hillside, a road along a cliff's edge or a lake's steep shore: a line prop (the zone's
 * `roadFence` - a rail fence, a drystone wall) standing on the road's level verge, along the side
 * that drops.
 *
 * Found cheaply: every FENCE_SCAN metres along each road, the ground FENCE_FAR past its verge on
 * either side is read against the road's own height; only where the road stands FENCE_DROP or more
 * over it is the road looked at closely - every FENCE_STEP metres either side of there - for a fall
 * as steep as a cliff's. Not within FENCE_END_SKIP
 * of a road's ends (its junctions and gates), across a river (a bridge's, later), or by a place
 * beside the road - an inn's ground, its paths.
 */

/** A road is fenced where, past its verge (and its ditch), the ground falls like a cliff: from
 *  FENCE_NEAR out to FENCE_FAR past its verge it drops at least FENCE_STEEPNESS (rise over run -
 *  steeper than any road's bank) and the road stands at least FENCE_DROP over it there. */
const FENCE_NEAR = 4;
const FENCE_FAR = 10;
const FENCE_STEEPNESS = 0.7;
const FENCE_DROP = 4;
/** How often the roads are looked along, and - where they need it - how closely. */
const FENCE_SCAN = 12;
const FENCE_STEP = 2;
/** Fences keep this far from a road's ends, and from a river. */
const FENCE_END_SKIP = 15;
const FENCE_RIVER_CLEARANCE = 30;
/** And off any levelled ground (a building's, a prop's) by this much, and out of a feature's own
 *  ground. */
const FENCE_PAD_CLEARANCE = 4;
/** A fence stands this far in from the edge of the road's level ground (in its own widths). */
const FENCE_IN_FROM_EDGE = 1;
/** Fenced stretches closer than this are joined; shorter than this are left out; each reaches this
 *  far past where the drop starts and ends. */
const FENCE_JOIN = 6;
const FENCE_MIN_LENGTH = 8;
const FENCE_REACH = 2;
const FENCE_SALT = 1453;
const WALL_VARIANT_SPACE = 1 << 20;

export function planRoadFences(stretches: RoadStretch[], sampleTerrain: TerrainSampler, props: ReadonlyMap<string, PropDef>, seed: number): WallRun[] {
  const runs: WallRun[] = [];
  for (const stretch of stretches) {
    const { points, heights } = stretch;
    if (points.length < 2) continue;
    const lengths = [0];
    for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
    const total = lengths[lengths.length - 1];
    if (total < 2 * FENCE_END_SKIP + FENCE_MIN_LENGTH) continue;
    /** Where it is `s` metres along, which way it runs there, and its surface's height. */
    const along = (s: number): { x: number; z: number; dx: number; dz: number; h: number } => {
      let i = 1;
      while (i < lengths.length - 1 && lengths[i] < s) i++;
      const a = points[i - 1];
      const b = points[i];
      const l = Math.max(1e-6, lengths[i] - lengths[i - 1]);
      const t = Math.max(0, Math.min(1, (s - lengths[i - 1]) / l));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: (b.x - a.x) / l, dz: (b.z - a.z) / l, h: heights[i - 1] + (heights[i] - heights[i - 1]) * t };
    };
    const verge = ROAD_HALF_WIDTH * stretch.widthScale;
    const fenceAt = (ROAD_HALF_WIDTH - FENCE_IN_FROM_EDGE) * stretch.widthScale;
    /** The ground `out` metres from the road's middle on a side (+1 left, -1 right) at `s`. */
    const groundAt = (s: number, side: number, out: number): { h: number; road: number } => {
      const p = along(s);
      return { h: sampleTerrain(p.x - p.dz * side * out, p.z + p.dx * side * out).height, road: p.h };
    };
    /** Whether the road stands high over the ground far out on a side - the cheap look. */
    const high = (s: number, side: number): boolean => {
      const far = groundAt(s, side, verge + FENCE_FAR);
      return far.road - far.h >= FENCE_DROP;
    };
    /** Whether a side falls away like a cliff at `s` - the close look. */
    const drops = (s: number, side: number): boolean => {
      const near = groundAt(s, side, verge + FENCE_NEAR);
      const far = groundAt(s, side, verge + FENCE_FAR);
      return far.road - far.h >= FENCE_DROP && (near.h - far.h) / (FENCE_FAR - FENCE_NEAR) >= FENCE_STEEPNESS;
    };
    const clear = (s: number, side: number): boolean => {
      const p = along(s);
      const at = sampleTerrain(p.x - p.dz * side * fenceAt, p.z + p.dx * side * fenceAt);
      return at.riverGap > FENCE_RIVER_CLEARANCE && at.padGap > FENCE_PAD_CLEARANCE && at.featureGap > FENCE_PAD_CLEARANCE;
    };
    for (const side of [1, -1]) {
      // Coarse first, then closely about every station that drops.
      const fenced: [number, number][] = [];
      for (let s = FENCE_END_SKIP; s <= total - FENCE_END_SKIP; s += FENCE_SCAN) {
        if (!high(s, side) || !drops(s, side)) continue;
        for (let f = Math.max(FENCE_END_SKIP, s - FENCE_SCAN); f <= Math.min(total - FENCE_END_SKIP, s + FENCE_SCAN); f += FENCE_STEP) {
          if (!drops(f, side) || !clear(f, side)) continue;
          const last = fenced[fenced.length - 1];
          if (last && f - last[1] <= FENCE_JOIN) last[1] = Math.max(last[1], f);
          else if (!last || f > last[1]) fenced.push([f, f]);
        }
      }
      for (const [from, to] of fenced) {
        const s0 = Math.max(FENCE_END_SKIP, from - FENCE_REACH);
        const s1 = Math.min(total - FENCE_END_SKIP, to + FENCE_REACH);
        if (s1 - s0 < FENCE_MIN_LENGTH) continue;
        const line: CellPoint[] = [];
        const n = Math.max(1, Math.ceil((s1 - s0) / FENCE_STEP));
        for (let k = 0; k <= n; k++) {
          const p = along(s0 + ((s1 - s0) * k) / n);
          line.push({ x: p.x - p.dz * side * fenceAt, z: p.z + p.dx * side * fenceAt });
        }
        // Its zone's fence, where it starts.
        const biome = sampleTerrain(line[0].x, line[0].z).primaryBiome;
        const prop = props.get(biome.roadFenceId);
        if (!prop) continue;
        const rng = mulberry32(deriveSeed(deriveSeed(seed, FENCE_SALT), stretch.id * 4096 + Math.round(s0) * 2 + (side > 0 ? 1 : 0)));
        runs.push({ prop, variant: Math.floor(rng() * WALL_VARIANT_SPACE), points: line, heights: [], ends: ["free", "free"], breach: false });
      }
    }
  }
  return runs;
}
