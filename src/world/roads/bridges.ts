import type { CellPoint } from "../cells/cellGrid";
import type { TerrainSampler } from "../terrain/terrainSampler";
import type { PropDef } from "../props/propTypes";
import { SEA_LEVEL } from "../cells/areaField";
import type { RoadStretch } from "./roadGraph";

/**
 * Bridges: where a road would run under the water - across a river, down to its bed - it is carried
 * over instead. Each crossing is found on the ground as it lies, before the roads are graded into it:
 * the stretch of a road whose ground is under the water, widened out to firm bank either side. Over
 * it the road's surface becomes a deck - level with each bank at its ends, rising in a slight hump to
 * stand at least BRIDGE_CLEARANCE over the water - and the stretch is marked bridged there
 * (RoadLine.bridges), so its grading leaves the river be rather than dam it; the road either side
 * climbs to the deck at no more than BRIDGE_APPROACH_GRADE. The bridge itself is a line prop (its
 * zone's `roadBridge`) laid along the deck.
 */
export interface Bridge {
  prop: PropDef;
  points: CellPoint[];
  /** The deck's surface height at each point. */
  heights: number[];
  /** How wide its deck is, metres. */
  width: number;
  /** A stable number for its rolls. */
  variant: number;
}

/** Ground under this is under the water - a road on it is bridged. */
const WET_HEIGHT = SEA_LEVEL + 0.3;
/** A bridge reaches out to ground this high above the water - firm bank - at most BRIDGE_REACH past
 *  the water on either side. */
const BANK_HEIGHT = SEA_LEVEL + 1.5;
const BRIDGE_REACH = 30;
/** Its deck stands at least this high over the water mid-span, and humps at least this much over the
 *  line between its ends - then HUMP_SCALE times that, but never more than BRIDGE_MAX_HUMP_GRADE of
 *  its length (so a short one stays walkable: its steepest, at its ends, HUMP_POWER * 2 times that).
 *  The hump a basket-handle arch's line (a Korbbogen): rising quickly off the banks, flattening over
 *  the middle - 1 - |2t - 1|^HUMP_POWER along it. */
const BRIDGE_CLEARANCE = 3;
const BRIDGE_MIN_HUMP = 0.6;
const HUMP_SCALE = 4;
const BRIDGE_MAX_HUMP_GRADE = 0.06;
const HUMP_POWER = 2.5;
/** Along a road, the ground is read this often; a bridge's deck has a point this often. */
const BRIDGE_SCAN = 2;
const DECK_STEP = 4;
/** Wet ground closer than this along a road is one crossing. */
const BRIDGE_JOIN = 12;
/** The road either side climbs to the deck no steeper than this. */
const BRIDGE_APPROACH_GRADE = 0.12;
/** A deck is this wide for a countryside road (its widthScale 1) - wider than the road, built at
 *  twice life size as everything is. */
const DECK_WIDTH = 13;

export function planBridges(stretches: RoadStretch[], sampleTerrain: TerrainSampler, propFor: (x: number, z: number) => PropDef | null): Bridge[] {
  const bridges: Bridge[] = [];
  stretches.forEach((stretch, index) => {
    const lengths = [0];
    for (let i = 1; i < stretch.points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(stretch.points[i].x - stretch.points[i - 1].x, stretch.points[i].z - stretch.points[i - 1].z));
    const total = lengths[lengths.length - 1];
    if (total <= 0) return;
    const at = (s: number): { x: number; z: number; h: number } => {
      let i = 1;
      while (i < lengths.length - 1 && lengths[i] < s) i++;
      const a = stretch.points[i - 1];
      const b = stretch.points[i];
      const t = Math.max(0, Math.min(1, (s - lengths[i - 1]) / Math.max(1e-6, lengths[i] - lengths[i - 1])));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, h: stretch.heights[i - 1] + (stretch.heights[i] - stretch.heights[i - 1]) * t };
    };
    const ground = (s: number): number => {
      const p = at(s);
      return sampleTerrain(p.x, p.z).height;
    };
    // Its wet stretches, joined where close.
    const wet: [number, number][] = [];
    for (let s = 0; s <= total; s += BRIDGE_SCAN) {
      // Only where the road dips low - it runs down to the water where it crosses one.
      if (at(s).h > BANK_HEIGHT + 2 || ground(s) >= WET_HEIGHT) continue;
      const last = wet[wet.length - 1];
      if (last && s - last[1] <= BRIDGE_JOIN) last[1] = s;
      else wet.push([s, s]);
    }
    if (wet.length === 0) return;
    const spans: { s0: number; s1: number; h0: number; h1: number }[] = [];
    for (const [w0, w1] of wet) {
      // Out to firm bank either side - or as far as it may reach.
      let s0 = w0;
      while (s0 > 0 && w0 - s0 < BRIDGE_REACH && ground(s0) < BANK_HEIGHT) s0 = Math.max(0, s0 - BRIDGE_SCAN);
      let s1 = w1;
      while (s1 < total && s1 - w1 < BRIDGE_REACH && ground(s1) < BANK_HEIGHT) s1 = Math.min(total, s1 + BRIDGE_SCAN);
      // Each end level with the bank - or with the road there, where it stands higher.
      spans.push({ s0, s1, h0: Math.max(ground(s0), at(s0).h, BANK_HEIGHT), h1: Math.max(ground(s1), at(s1).h, BANK_HEIGHT) });
    }
    // The stretch rebuilt: its points before each bridge, the bridge's deck, its points after - and
    // the road either side brought up to the deck.
    const deck = (span: (typeof spans)[number], s: number): number => {
      const t = (s - span.s0) / Math.max(1e-6, span.s1 - span.s0);
      const line = span.h0 + (span.h1 - span.h0) * t;
      const mid = (span.h0 + span.h1) / 2;
      const hump = Math.min(HUMP_SCALE * Math.max(BRIDGE_MIN_HUMP, SEA_LEVEL + BRIDGE_CLEARANCE - mid), (span.s1 - span.s0) * BRIDGE_MAX_HUMP_GRADE);
      return line + hump * (1 - Math.abs(2 * t - 1) ** HUMP_POWER);
    };
    const points: CellPoint[] = [];
    const heights: number[] = [];
    const spansOut: [number, number][] = [];
    let travelled = 0;
    const push = (p: CellPoint, h: number): void => {
      if (points.length > 0) travelled += Math.hypot(p.x - points[points.length - 1].x, p.z - points[points.length - 1].z);
      points.push(p);
      heights.push(h);
    };
    let k = 0;
    for (const span of spans) {
      while (k < stretch.points.length && lengths[k] < span.s0 - 1e-6) {
        // Up to the deck no steeper than the approach grade.
        push(stretch.points[k], Math.max(stretch.heights[k], span.h0 - (span.s0 - lengths[k]) * BRIDGE_APPROACH_GRADE));
        k++;
      }
      let start = 0;
      const n = Math.max(2, Math.ceil((span.s1 - span.s0) / DECK_STEP));
      const deckPoints: CellPoint[] = [];
      const deckHeights: number[] = [];
      // Straight from bank to bank, whatever way the road wandered across.
      const a = at(span.s0);
      const b = at(span.s1);
      for (let i = 0; i <= n; i++) {
        const s = span.s0 + ((span.s1 - span.s0) * i) / n;
        const p = { x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n };
        push({ x: p.x, z: p.z }, deck(span, s));
        if (i === 0) start = travelled;
        deckPoints.push({ x: p.x, z: p.z });
        deckHeights.push(deck(span, s));
      }
      spansOut.push([start, travelled]);
      while (k < stretch.points.length && lengths[k] <= span.s1 + 1e-6) k++;
      const prop = propFor(deckPoints[0].x, deckPoints[0].z);
      if (prop) bridges.push({ prop, points: deckPoints, heights: deckHeights, width: DECK_WIDTH * stretch.widthScale, variant: index * 64 + bridges.length });
      // After it, down from the deck no steeper than the approach grade - until the next bridge's.
      const next = spans[spans.indexOf(span) + 1];
      for (let j = k; j < stretch.points.length && (!next || lengths[j] < next.s0); j++) {
        stretch.heights[j] = Math.max(stretch.heights[j], span.h1 - (lengths[j] - span.s1) * BRIDGE_APPROACH_GRADE);
      }
    }
    while (k < stretch.points.length) {
      push(stretch.points[k], stretch.heights[k]);
      k++;
    }
    stretch.points = points;
    stretch.heights = heights;
    stretch.bridges = spansOut;
  });
  return bridges;
}
