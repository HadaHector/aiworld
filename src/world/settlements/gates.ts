import type { TerrainSample, TerrainSampler } from "../terrain/terrainSampler";
import type { SettlementSite } from "./settlementSites";
import { ROAD_MAX_LAKE_FACTOR, ROAD_MIN_HEIGHT } from "../roads/roadConfig";
import {
  GATE_APPROACH_MAX_GRADE,
  GATE_APPROACH_MAX_STEP_GRADE,
  GATE_APPROACH_STEP,
  GATE_FLAT_RADIUS,
  GATE_MAX_RELIEF,
  GATE_MERGE_ANGLE,
  GATE_MIN_SEPARATION,
  GATE_APPROACH_LENGTH,
  GATE_RELAXED,
  GATE_SEARCH_ANGLE,
  GATE_SEARCH_STEP,
} from "./settlementConfig";

/** Where a countryside road meets a settlement's own streets. */
export interface SettlementGate {
  x: number;
  z: number;
  /** Direction from the settlement's centre, radians. */
  angle: number;
  /** GATE_APPROACH_LENGTH straight out from the gate: where roads are routed to, before running
   *  straight in. */
  approachX: number;
  approachZ: number;
  /** The road surface height here, once the first road to use the gate has been built - later
   *  roads, and the main street, are brought to the same level so they join without a step. */
  roadHeight: number | null;
}

/** Smallest difference between two angles, 0..PI. */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

function buildable(sample: TerrainSample, riverClearance: number): boolean {
  return (
    sample.isLand &&
    sample.height >= ROAD_MIN_HEIGHT &&
    sample.lakeFactor <= ROAD_MAX_LAKE_FACTOR &&
    sample.riverGap > riverClearance
  );
}

interface GateCandidate {
  x: number;
  z: number;
  angle: number;
  cost: number;
}

/**
 * Judges one spot on the settlement's circle as a gate, or rejects it.
 *
 * Three things have to hold, all read off the terrain:
 *  - the gate's own ground is dry and level enough to be a junction;
 *  - the way in, a straight line from the gate to the centre, stays on dry land and climbs at a
 *    grade a street can take - the main street is routed properly later, but if even the direct
 *    line is a cliff or crosses water, the gate faces the wrong way;
 *  - the way out, a stretch beyond the gate, is passable, so the countryside road leaving it is not
 *    forced straight back through the settlement.
 * Cost prefers staying near the neighbour's direction, level ground and an easy approach.
 */
interface GateLimits {
  searchAngle: number;
  maxRelief: number;
  approachMaxStepGrade: number;
  approachMaxGrade: number;
}

const STRICT: GateLimits = {
  searchAngle: GATE_SEARCH_ANGLE,
  maxRelief: GATE_MAX_RELIEF,
  approachMaxStepGrade: GATE_APPROACH_MAX_STEP_GRADE,
  approachMaxGrade: GATE_APPROACH_MAX_GRADE,
};

function evaluateGate(site: SettlementSite, angle: number, offset: number, sampleTerrain: TerrainSampler, limits: GateLimits): GateCandidate | null {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = site.x + cos * site.radius;
  const z = site.z + sin * site.radius;

  const here = sampleTerrain(x, z);
  if (!buildable(here, 25)) return null;

  let lowest = here.height;
  let highest = here.height;
  for (let probe = 0; probe < 4; probe++) {
    const a = angle + (probe * Math.PI) / 2;
    const h = sampleTerrain(x + Math.cos(a) * GATE_FLAT_RADIUS, z + Math.sin(a) * GATE_FLAT_RADIUS).height;
    lowest = Math.min(lowest, h);
    highest = Math.max(highest, h);
  }
  const relief = highest - lowest;
  if (relief > limits.maxRelief) return null;

  // In from the gate to the centre.
  const steps = Math.ceil(site.radius / GATE_APPROACH_STEP);
  let previous = here.height;
  let worstStep = 0;
  for (let i = 1; i <= steps; i++) {
    const r = site.radius * (1 - i / steps);
    const sample = sampleTerrain(site.x + cos * r, site.z + sin * r);
    if (!buildable(sample, 8)) return null;
    worstStep = Math.max(worstStep, Math.abs(sample.height - previous) / (site.radius / steps));
    previous = sample.height;
  }
  if (worstStep > limits.approachMaxStepGrade) return null;
  const approachGrade = Math.abs(here.height - site.height) / site.radius;
  if (approachGrade > limits.approachMaxGrade) return null;

  // Out beyond the gate: the straight stretch every road arrives along.
  let outsidePrevious = here.height;
  const outwardSteps = Math.ceil(GATE_APPROACH_LENGTH / GATE_APPROACH_STEP);
  for (let i = 1; i <= outwardSteps; i++) {
    const r = (GATE_APPROACH_LENGTH * i) / outwardSteps;
    const outside = sampleTerrain(x + cos * r, z + sin * r);
    if (!buildable(outside, 8)) return null;
    if (Math.abs(outside.height - outsidePrevious) / (GATE_APPROACH_LENGTH / outwardSteps) > limits.approachMaxStepGrade) return null;
    outsidePrevious = outside.height;
  }

  const cost = offset / limits.searchAngle + relief / limits.maxRelief + (approachGrade / limits.approachMaxGrade) * 1.5 + worstStep;
  return { x, z, angle, cost };
}

/**
 * The gate a road toward (towardX, towardZ) should use: an existing gate if one already faces
 * roughly that way, otherwise the best new spot within GATE_SEARCH_ANGLE of the direction, judged
 * on the ground (see evaluateGate) and kept clear of the gates already there. Null if nowhere in
 * that range passes - the caller then gives up on the road rather than ending it somewhere
 * unusable.
 *
 * Does not add the gate to `existing`: a road may still fail to route, and a gate nobody arrives at
 * must not be left behind. The caller commits it once the road is built.
 */
export function chooseGate(
  site: SettlementSite,
  towardX: number,
  towardZ: number,
  existing: SettlementGate[],
  sampleTerrain: TerrainSampler,
  searchAngle = GATE_SEARCH_ANGLE,
): SettlementGate | null {
  const direction = Math.atan2(towardZ - site.z, towardX - site.x);

  let reuse: SettlementGate | null = null;
  for (const gate of existing) {
    if (angleBetween(gate.angle, direction) < GATE_MERGE_ANGLE && (!reuse || angleBetween(gate.angle, direction) < angleBetween(reuse.angle, direction))) {
      reuse = gate;
    }
  }
  if (reuse) return reuse;

  // Strict limits first; the relaxed ones only if nothing passed them.
  for (const limits of [{ ...STRICT, searchAngle: Math.max(searchAngle, STRICT.searchAngle) }, { ...GATE_RELAXED, searchAngle: Math.max(searchAngle, GATE_RELAXED.searchAngle) }]) {
    let best: GateCandidate | null = null;
    for (let offset = 0; offset <= Math.min(Math.PI, limits.searchAngle) + 1e-9; offset += GATE_SEARCH_STEP) {
      for (const sign of offset === 0 ? [1] : [1, -1]) {
        const angle = direction + sign * offset;
        if (existing.some((gate) => angleBetween(gate.angle, angle) < GATE_MIN_SEPARATION)) continue;
        const candidate = evaluateGate(site, angle, offset, sampleTerrain, limits);
        if (candidate && (!best || candidate.cost < best.cost)) best = candidate;
      }
    }
    if (best) {
      return {
        x: best.x,
        z: best.z,
        angle: best.angle,
        approachX: best.x + Math.cos(best.angle) * GATE_APPROACH_LENGTH,
        approachZ: best.z + Math.sin(best.angle) * GATE_APPROACH_LENGTH,
        roadHeight: null,
      };
    }
  }
  return null;
}
