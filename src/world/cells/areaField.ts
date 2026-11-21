import { timed } from "../loadTimings";
import { createVoronoiField, type VoronoiField } from "./voronoiField";
import { computeCellBounds, generateCellDiagram, type CellPoint } from "./cellGrid";
import { createRiverField, type RiverField } from "./riverField";
import { createCentrelineShaper } from "./riverCentreline";
import { createNameGenerator, type NameGenerator } from "../naming/nameGenerator";
import { planWorld } from "./worldLayout";
import { pickStartCell, growLandmass } from "./regionGrowth";
import { partitionIntoAreas, assignAreaBiomes } from "./areaAssignment";
import { generateRivers } from "./riverGeneration";
import { createBaseNoise2D } from "../terrain/noise";
import { deriveSeed, mulberry32 } from "../rng";
import { lerp, smoothstep } from "../mathUtils";
import type { BiomeDefinition, BoundaryHillStyle, ShoreHills } from "../biomes/biomeTypes";
import type { WorldContent } from "../content/worldContent";
import {
  CELL_SPACING,
  CELL_BOUNDS_MARGIN,
  COAST_NOISE_FREQUENCY,
  COAST_NOISE_AMPLITUDE,
  COAST_BORDER_WIDTH,
  AREA_BORDER_WIDTH,
  AREA_BLEND_JITTER_AMPLITUDE,
  AREA_BLEND_NOISE_FREQUENCY,
  AREA_BLEND_OFFSET_X,
  AREA_BLEND_OFFSET_Z,
  EDGE_NOISE_SALT,
  LAKE_BORDER_WIDTH,
  LAKE_NOISE_FREQUENCY,
  LAKE_NOISE_AMPLITUDE,
  LAKE_ROLL_SALT,
  LAKE_EDGE_NOISE_SALT,
} from "./config";
import { BOUNDARY_HILL_WIDTH, BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE, BOUNDARY_HILL_STYLE_SALT, SHORE_BAY_SALT } from "../terrain/boundaryHills/boundaryHillsConfig";
import { RIVER_QUERY_RADIUS, RIVER_TRIBUTARY_LINK } from "../terrain/rivers/riverConfig";
import { rollAreaBiome } from "../content/resolveContent";

export const SEA_LEVEL = 0;
const WORLD_CENTER_X = 0;
const WORLD_CENTER_Z = 0;

/** One area's share of a point, as a weight in 0..1. */
export interface AreaWeight {
  areaId: number;
  biome: BiomeDefinition;
  weight: number;
}

/** Axis-aligned world extent of one area, from the cells that make it up. */
export interface AreaBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface AreaSample {
  landmass: number;
  /** The area owning the nearest cell - the one whose name the zone label shows. */
  primaryAreaId: number;
  isLand: boolean;
  primaryBiome: BiomeDefinition;
  secondaryBiome: BiomeDefinition;
  biomeBlend: number;
  /**
   * Every area close enough to have a say here, weighted by how near its border is, strongest
   * first, always summing to 1. Usually one entry; two near a border; three at a junction.
   *
   * This replaces "primary plus whichever area owns the second-nearest cell" as the basis for
   * blending. The old pairing was decided by a cell identity that flips abruptly, which made the
   * blend bimodal - measured ~49% of points within 40 units of a real border had no blend at all.
   * Each weight here comes from a per-area distance, which is a minimum over a fixed subset of
   * cells and therefore continuous, so an area fades in from zero rather than appearing.
   */
  areaWeights: AreaWeight[];
  borderGap: number;
  /** Distance past the nearest cell to the nearest cell of a DIFFERENT area - continuous, and the
   *  basis of the boundary-hill falloff. Infinity when no other area is within the hill's reach. */
  areaBorderGap: number;
  boundaryHillStyle: BoundaryHillStyle | null;
  lakeFactor: number;
  isRiverEdge: boolean;
  riverTaper: number; // 0 at a river's mouth, 1 at its far end - meaningless unless isRiverEdge
  riverGap: number; // distance to use for the river carve envelope - meaningless unless isRiverEdge
  riverIndex: number; // which river that is (its index in the field's polylines), -1 with none in reach
}

export type AreaSampler = (worldX: number, worldZ: number) => AreaSample;

export interface AreaWorld {
  sampleArea: AreaSampler;
  /** The rivers' centrelines, for the terrain sampler to give their water its levels (terrain/rivers/riverLevels.ts). */
  riverField: RiverField;
  worldExtent: number;
  /** Where each area is, keyed by the id AreaSample reports. Built from the cell sites that make
   *  the area up, so it is the area's own footprint rather than a fixed zoom guess. */
  areaBounds: Map<number, AreaBounds>;
  /** Each area's generated name, keyed the same way. Kept out of AreaSample deliberately: that is
   *  built millions of times per chunk and would pay a map lookup for a string nothing but the UI
   *  reads, which can look it up by primaryAreaId when it actually needs one. */
  areaNames: Map<number, string>;
  /** Sites of every land cell that is not a lake, for anything that wants to scatter content over
   *  the land without rebuilding the cell diagram to find out where the land is. */
  landCellSites: CellPoint[];
  /** The world name generator, so later systems name their own content out of the same pool and
   *  cannot collide with a zone name. */
  nameGenerator: NameGenerator;
  /** Each area's own roll of its biome, by area id - the objects every AreaWeight and primaryBiome
   *  carries, so anything built per biome can be built per area from this list up front. */
  areaBiomes: BiomeDefinition[];
  /** Which areas touch each area: two do where neighbouring land cells belong to them. In ascending
   *  id order - what zone levels are counted out by (see CREATURES.md, *Zones*). */
  areaNeighbours: Map<number, number[]>;
}

/**
 * Weights for every area with a say at this point, normalised to sum to 1.
 *
 * `raw / sum(raw)` is the same shape compositeInto already uses for texture paint layers: whoever
 * is nearest gets a raw of 1 and everyone else fades out over AREA_BORDER_WIDTH, then the set is
 * normalised. At a two-way border both gaps are 0, so it is 50/50 from either side; at a three-way
 * junction all three are 0, so it is a third each - the junction needs no special case, which is
 * the whole reason for weighting every area rather than pairing two.
 */
function computeAreaWeights(
  distanceByArea: Map<number, number>,
  areaBiomeOf: (areaId: number) => BiomeDefinition,
  jitterFor: (areaId: number) => number,
): AreaWeight[] {
  let nearest = Infinity;
  for (const distance of distanceByArea.values()) {
    if (distance < nearest) nearest = distance;
  }

  const weights: AreaWeight[] = [];
  let total = 0;
  for (const [areaId, distance] of distanceByArea) {
    const gap = distance - nearest + jitterFor(areaId);
    const raw = 1 - smoothstep(0, AREA_BORDER_WIDTH, gap);
    if (raw <= 0) continue;
    weights.push({ areaId, biome: areaBiomeOf(areaId), weight: raw });
    total += raw;
  }

  // Jitter can in principle push every area past the width at once; fall back to the nearest rather
  // than dividing by zero.
  if (total <= 0) {
    for (const [areaId, distance] of distanceByArea) {
      if (distance === nearest) return [{ areaId, biome: areaBiomeOf(areaId), weight: 1 }];
    }
    return [];
  }

  for (const entry of weights) entry.weight /= total;
  // Strongest first, tie-broken by id so two vertices that see the same set always emit it in the
  // same order - consumers rely on that ordering to keep their material slots aligned.
  weights.sort((a, b) => b.weight - a.weight || a.areaId - b.areaId);
  return weights;
}

// deriveSeed(a, b) = (Math.imul(a^b, K) ^ (a+b)) >>> 0 always has bit 0 = 0: (a^b) and (a+b) share
// the exact same low bit (addition's carry never reaches bit 0), Math.imul by an odd constant
// preserves its operand's low-bit parity, so the two XOR operands' low bits always match and cancel.
// That single dead bit is harmless everywhere else in this codebase (deriveSeed's output always
// feeds mulberry32, a real PRNG that doesn't care about one structurally-fixed input bit) - but
// area ids here are small sequential integers (0-150ish), and empirically deriveSeed(lo, hi) over
// that exact range is far more degenerate than the one-dead-bit proof alone suggests: every pair
// landed in the same `% BOUNDARY_HILL_STYLES.length` bucket, so only one style could ever be
// picked, silently breaking "different mountain styles" (verified by scanning the actual generated
// world before this fix, and confirmed by testing the fix below across 150x150 synthetic id pairs -
// see conversation). A proper 32-bit avalanche mix (Murmur3-style finalizer) fixes this.
function mixSeed(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Picks a boundary-hill style for a specific area pair, or null if this pair shouldn't generate
 * hills. `primaryAreaId === secondaryAreaId` happens routinely deep inside a single area's
 * interior (landField is built from ~10 cells per area, so internal cell-to-cell seams are common)
 * - that's not a real border, just an internal seam, and must be excluded or hills would sprout as
 * spurious fragments scattered through every "mountain"-bordered area's interior.
 */
/**
 * The style for a border between two areas, seeded from the unordered pair so both sides of the
 * same border agree - otherwise the style would swap as you stepped across, exactly where the hill
 * is tallest.
 *
 * This no longer decides *whether* there is a hill. That used to be gated on "are the two nearest
 * cells in different areas?", which is a binary predicate over the second-nearest cell's identity -
 * and that identity flips abruptly along Voronoi bisectors. Paired with an amplitude that falls off
 * smoothly with distance, it meant the hill switched on at whatever height the envelope happened to
 * have there: measured cliffs of 12 units at one border and up to 92 elsewhere, in half a world
 * unit. Presence is now decided by areaBorderDistance (see sampleArea), which is continuous.
 */
function resolveBoundaryHillStyle(
  seed: number,
  styles: BoundaryHillStyle[],
  primaryBiome: BiomeDefinition,
  otherBiome: BiomeDefinition,
  primaryAreaId: number,
  otherAreaId: number,
): BoundaryHillStyle | null {
  if (primaryBiome.borderType !== "mountain" && otherBiome.borderType !== "mountain") return null;

  const lo = Math.min(primaryAreaId, otherAreaId);
  const hi = Math.max(primaryAreaId, otherAreaId);
  const pairKey = ((lo << 16) ^ hi) >>> 0;
  const pairSeed = mixSeed(deriveSeed(seed, BOUNDARY_HILL_STYLE_SALT) ^ pairKey);
  return styles[pairSeed % styles.length];
}

/** Squared distance transform of one row (Felzenszwalb and Huttenlocher): `f` in, `d` out. */
function distanceTransform1D(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = 0;
    for (;;) {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s > z[k] || k === 0) break;
      k--;
    }
    if (s <= z[k]) {
      v[k] = q;
      continue;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/** Distance in cells from every cell to the nearest cell where `source` is 1. */
function distanceToSources(source: Uint8Array, width: number, height: number): Float64Array {
  const size = Math.max(width, height);
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = source[i] ? 0 : 1e20;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    distanceTransform1D(f, d, v, z, height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x];
    distanceTransform1D(f, d, v, z, width);
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x] >= 1e19 ? 1e9 : Math.sqrt(d[x]);
  }
  return grid;
}

/** Spacing of the shore distance field, and how far past the zones' cells it reaches. */
const SHORE_FIELD_STEP = 20;
const SHORE_FIELD_MARGIN = 700;
/** How far a shore hill's edge wobbles, as a share of its width (a border hill's wobbles by a fixed
 *  BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE, too much for a ring on land a kilometre or two across). */
const SHORE_EDGE_NOISE = 0.5;
/** How far round a point the land's thickness is looked for: a peninsula is thin all along, while a
 *  point near the island's body sees its depth within this reach. */
const SHORE_THICKNESS_REACH = 400;
/** Land thinner than the ring's own reach (inset plus width) times the first of these raises no
 *  hills - from both shores they would meet in one ridge; past the second they stand at full height. */
const SHORE_THIN_FROM = 1;
const SHORE_THIN_TO = 1.6;
/** The land grows out over the sea for the hills (ShoreHills.grow) except near a river - its mouth
 *  stays open, an estuary through the hills - fading in between these distances from its line. */
const SHORE_GROW_RIVER_INNER = 40;
const SHORE_GROW_RIVER_OUTER = 260;
/** Nor near water the land closes round: its shore stays where the cells put it, and the grown
 *  coast fades in over this distance from it. */
const SHORE_GROW_ENCLOSED_REACH = 150;
/** Past `grow` the grown coast still pulls the land up a little (its blend), so a strait is checked
 *  this much wider; the passes that open a closed one; and how far the growth fades in round it. */
const SHORE_GROW_BLEND = 60;
const SHORE_GROW_PASSES = 8;
const SHORE_GROW_HOLD_FADE = 160;

interface ShoreField {
  /** Distance to the coast, positive on land; -Infinity outside the field. */
  distance: (x: number, z: number) => number;
  /** How deep inland the land round a point reaches (see SHORE_THICKNESS_REACH): small on a thin peninsula. */
  thickness: (x: number, z: number) => number;
  /** How much of the shore's growth may happen here, 0..1: none where it would close a strait. */
  growFree: (x: number, z: number) => number;
  /** Distance to the nearest water the land closes round (an inland pocket of sea cells). */
  enclosedGap: (x: number, z: number) => number;
  /** Where `count` bays open: points on the coast of the zone's largest piece of land, spread apart. */
  bayCentres: (count: number, rng: () => number) => CellPoint[];
}

/**
 * Distance to the coast, signed (positive on land), over a box, measured on the land and sea split
 * the area field draws. A true distance, unlike the coast blend's edge gap: the coast's wobble
 * (COAST_NOISE_AMPLITUDE) makes that a poor one, and a ridge keyed on it bunches and thins at random.
 */
function createShoreDistanceField(box: AreaBounds, isLandAt: (x: number, z: number) => boolean, grow: number): ShoreField {
  const minX = box.minX - SHORE_FIELD_MARGIN;
  const minZ = box.minZ - SHORE_FIELD_MARGIN;
  const width = Math.ceil((box.maxX + SHORE_FIELD_MARGIN - minX) / SHORE_FIELD_STEP) + 1;
  const height = Math.ceil((box.maxZ + SHORE_FIELD_MARGIN - minZ) / SHORE_FIELD_STEP) + 1;
  const land = new Uint8Array(width * height);
  const sea = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (isLandAt(minX + i * SHORE_FIELD_STEP, minZ + j * SHORE_FIELD_STEP)) land[j * width + i] = 1;
      else sea[j * width + i] = 1;
    }
  }
  const enclosed = new Uint8Array(width * height);
  // Only the open sea is a shore: water the land closes round (an inland pocket of sea cells) raises
  // no ring of its own, so it counts as land here. Open sea is what reaches the field's edge.
  {
    const open = new Uint8Array(width * height);
    const stack: number[] = [];
    for (let i = 0; i < width; i++) stack.push(i, (height - 1) * width + i);
    for (let j = 0; j < height; j++) stack.push(j * width, j * width + width - 1);
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (!sea[at] || open[at]) continue;
      open[at] = 1;
      const ax = at % width;
      if (ax > 0) stack.push(at - 1);
      if (ax < width - 1) stack.push(at + 1);
      if (at >= width) stack.push(at - width);
      if (at + width < sea.length) stack.push(at + width);
    }
    for (let i = 0; i < sea.length; i++) {
      if (sea[i] && !open[i]) {
        sea[i] = 0;
        land[i] = 1;
        enclosed[i] = 1;
      }
    }
  }
  const toLand = distanceToSources(land, width, height);
  const toSea = distanceToSources(sea, width, height);
  // Land cells: how far to the sea; sea cells: minus how far to land. The coast lies between two cells, hence the half.
  const signed = new Float32Array(width * height);
  for (let i = 0; i < signed.length; i++) signed[i] = (land[i] ? toSea[i] - 0.5 : -(toLand[i] - 0.5)) * SHORE_FIELD_STEP;
  // How thick the land is round each point: the deepest it gets inland (the largest distance to the
  // sea) within SHORE_THICKNESS_REACH - a square max filter, one pass per axis. Small on a thin
  // peninsula or a spit all the way along it; large anywhere near the body of the island.
  const thick = new Float32Array(width * height);
  {
    const reach = Math.round(SHORE_THICKNESS_REACH / SHORE_FIELD_STEP);
    const rows = new Float32Array(width * height);
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        let most = 0;
        for (let k = Math.max(0, i - reach); k <= Math.min(width - 1, i + reach); k++) most = Math.max(most, signed[j * width + k]);
        rows[j * width + i] = most;
      }
    }
    for (let i = 0; i < width; i++) {
      for (let j = 0; j < height; j++) {
        let most = 0;
        for (let k = Math.max(0, j - reach); k <= Math.min(height - 1, j + reach); k++) most = Math.max(most, rows[k * width + i]);
        thick[j * width + i] = most;
      }
    }
  }
  const sampleGrid = (grid: Float32Array, x: number, z: number, outside: number): number => {
    const fx = (x - minX) / SHORE_FIELD_STEP;
    const fz = (z - minZ) / SHORE_FIELD_STEP;
    if (fx < 0 || fz < 0 || fx >= width - 1 || fz >= height - 1) return outside;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a = grid[j * width + i];
    const b = grid[j * width + i + 1];
    const c = grid[(j + 1) * width + i];
    const e = grid[(j + 1) * width + i + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + e) * tx * tz;
  };
  // Where the land may grow (ShoreHills.grow): everywhere, except where growing would close a strait
  // or the neck of an inlet and cut water off from the open sea - a river running into that inlet
  // would end in a landlocked pool. Grown everywhere first; then every pocket of sea that lost its way
  // out takes the growth back from round itself, again until none is left cut off. The neck goes
  // last, a band at a time from the pocket outward.
  const growFree = new Float32Array(width * height).fill(1);
  if (grow > 0) {
    const reach = grow + SHORE_GROW_BLEND;
    const grows = new Uint8Array(width * height);
    for (let i = 0; i < grows.length; i++) grows[i] = sea[i] && (toLand[i] - 0.5) * SHORE_FIELD_STEP < reach ? 1 : 0;
    const held = new Uint8Array(width * height);
    const reached = new Uint8Array(width * height);
    const stack: number[] = [];
    for (let pass = 0; pass < SHORE_GROW_PASSES; pass++) {
      reached.fill(0);
      for (let i = 0; i < width; i++) stack.push(i, (height - 1) * width + i);
      for (let j = 0; j < height; j++) stack.push(j * width, j * width + width - 1);
      while (stack.length > 0) {
        const at = stack.pop()!;
        if (!sea[at] || reached[at] || (grows[at] && !held[at])) continue;
        reached[at] = 1;
        const ax = at % width;
        if (ax > 0) stack.push(at - 1);
        if (ax < width - 1) stack.push(at + 1);
        if (at >= width) stack.push(at - width);
        if (at + width < sea.length) stack.push(at + width);
      }
      const cutOff = new Uint8Array(width * height);
      let any = false;
      for (let i = 0; i < cutOff.length; i++) {
        if (sea[i] && !reached[i] && !(grows[i] && !held[i])) {
          cutOff[i] = 1;
          any = true;
        }
      }
      if (!any) break;
      const toCutOff = distanceToSources(cutOff, width, height);
      for (let i = 0; i < held.length; i++) if (grows[i] && toCutOff[i] * SHORE_FIELD_STEP <= reach) held[i] = 1;
    }
    // Faded out round the held water rather than stopped dead, so the coast there does not step.
    const toHeld = distanceToSources(held, width, height);
    for (let i = 0; i < growFree.length; i++) growFree[i] = smoothstep(0, SHORE_GROW_HOLD_FADE, toHeld[i] * SHORE_FIELD_STEP);
  }
  const growFreeAt = (x: number, z: number): number => sampleGrid(growFree, x, z, 1);
  const toEnclosed = distanceToSources(enclosed, width, height);
  const enclosedGrid = new Float32Array(width * height);
  for (let i = 0; i < enclosedGrid.length; i++) enclosedGrid[i] = toEnclosed[i] * SHORE_FIELD_STEP;
  const distance = (x: number, z: number): number => sampleGrid(signed, x, z, -Infinity);
  const enclosedGap = (x: number, z: number): number => sampleGrid(enclosedGrid, x, z, Infinity);
  const thickness = (x: number, z: number): number => sampleGrid(thick, x, z, 0);

  // The largest piece of land (a flood fill of the land cells), and its shoreline cells.
  const shoreline: CellPoint[] = [];
  {
    const label = new Int32Array(width * height).fill(-1);
    let best = -1;
    let bestSize = 0;
    let labels = 0;
    const stack: number[] = [];
    for (let start = 0; start < land.length; start++) {
      if (!land[start] || label[start] !== -1) continue;
      let size = 0;
      label[start] = labels;
      stack.push(start);
      while (stack.length > 0) {
        const at = stack.pop()!;
        size++;
        const ax = at % width;
        for (const next of [at - 1, at + 1, at - width, at + width]) {
          if (next < 0 || next >= land.length || !land[next] || label[next] !== -1) continue;
          if ((next === at - 1 && ax === 0) || (next === at + 1 && ax === width - 1)) continue;
          label[next] = labels;
          stack.push(next);
        }
      }
      if (size > bestSize) {
        bestSize = size;
        best = labels;
      }
      labels++;
    }
    for (let at = 0; at < land.length; at++) {
      if (label[at] !== best || toSea[at] > 1.5) continue;
      shoreline.push({ x: minX + (at % width) * SHORE_FIELD_STEP, z: minZ + Math.floor(at / width) * SHORE_FIELD_STEP });
    }
  }
  const bayCentres = (count: number, rng: () => number): CellPoint[] => {
    const chosen: CellPoint[] = [];
    if (shoreline.length === 0) return chosen;
    chosen.push(shoreline[Math.floor(rng() * shoreline.length)]);
    // Each next bay: the shoreline point farthest from the ones chosen, so the bays spread round the coast.
    while (chosen.length < count) {
      let far = chosen[0];
      let farDistance = -1;
      for (const point of shoreline) {
        let nearest = Infinity;
        for (const other of chosen) nearest = Math.min(nearest, Math.hypot(point.x - other.x, point.z - other.z));
        if (nearest > farDistance) {
          farDistance = nearest;
          far = point;
        }
      }
      chosen.push(far);
    }
    return chosen;
  };
  return { distance, thickness, enclosedGap, growFree: growFreeAt, bayCentres };
}

/** Composes the cell diagram, land growth, and area partitioning into one queryable per-position sample. */
export function createAreaSampler(seed: number, content: WorldContent): AreaWorld {
  const layout = planWorld(seed, content.world);
  // The biomes' shore hills rise only in a world that asks for them (WorldShape.shoreHills).
  const shoreHillsOn = content.world.shoreHills === true;
  const bounds = computeCellBounds(WORLD_CENTER_X, WORLD_CENTER_Z, layout.worldExtent, CELL_BOUNDS_MARGIN);
  const { points, adjacency, seamBetween } = timed("Laying out the cells", () => generateCellDiagram(seed, bounds, CELL_SPACING));
  const landStarted = performance.now();

  const landCells = new Set<number>();
  const cellToAreaId = new Map<number, number>();
  const areaBiomes: BiomeDefinition[] = [];
  const lakeCells = new Set<number>();
  const usedRiverCells = new Set<number>();
  const riverPolylines: CellPoint[][] = [];
  const shapeCentreline = createCentrelineShaper(seed);

  {
    const { landSeed } = layout;
    const startIndex = pickStartCell(landSeed, points, 0, 0, CELL_SPACING);
    growLandmass(landSeed, adjacency, startIndex, layout.cellCount).forEach((index) => landCells.add(index));

    const localAreaId = partitionIntoAreas(landSeed, adjacency, landCells, layout.areaCount);
    localAreaId.forEach((id, cellIndex) => cellToAreaId.set(cellIndex, id));

    // Each area its own roll of its biome - its own ranges, options and noise seeds (see
    // content/biomeRolls.ts) - so everything that asks an area for its biome gets the area's.
    areaBiomes.push(...assignAreaBiomes(landSeed, layout.areaCount, content.biomes).map((biome, i) => rollAreaBiome(seed, i, biome, content)));

    // Rolled per-cell - never lets the land-growth start cell become a lake, since that's at 0, 0
    // (the player spawns at heightAt(0,0)) and could otherwise spawn the player inside a lake. Also
    // excludes any cell touching open ocean - a lake sitting right on the coastline would just read
    // as a notch in the coast, not a distinct inland body of water.
    const lakeRng = mulberry32(deriveSeed(landSeed, LAKE_ROLL_SALT));
    for (const cellIndex of landCells) {
      const roll = lakeRng();
      if (cellIndex === startIndex) continue;
      if (adjacency[cellIndex].some((n) => !landCells.has(n))) continue;
      const biome = areaBiomes[localAreaId.get(cellIndex)!];
      if (roll < (biome.lakeChance ?? 0)) lakeCells.add(cellIndex);
    }

    const riverPaths = generateRivers({ landSeed, adjacency, landCells, lakeCells, usedRiverCells, shape: content.world });
    for (const { cells: path, mouthLink } of riverPaths) {
      // The centreline runs through the midpoint of each consecutive pair's shared Voronoi border -
      // the actual point on the ground between the two cells, not the midpoint of their two sites,
      // which is on the same bisector but need not lie on the bounded edge (see cellGrid.ts).
      //
      // Prepending the cell the mouth drains into puts the line's first point on that shore, so the
      // river starts at its lake, trunk or coastline instead of a cell inland of it.
      const chain = mouthLink === -1 ? path : [mouthLink, ...path];
      const centreline: CellPoint[] = [];
      // How far the river can wander sideways here without ceasing to run between the two cells it
      // is following. Half the shared border's own length is the right measure: the centreline sits
      // at that border's midpoint, so that is exactly the distance to the vertex where a third cell
      // takes over. Since area borders are cell borders, staying inside it is also what stops a
      // meander from swinging across a zone boundary.
      const rooms: number[] = [];
      for (let i = 0; i < chain.length - 1; i++) {
        const seam = seamBetween(chain[i], chain[i + 1]);
        centreline.push(seam.midpoint);
        rooms.push(seam.halfLength);
      }
      if (centreline.length >= 2) {
        // Sites of the cells the path runs through, and of everything bordering them. Half the
        // difference between the two nearest is the distance to the edge of the path's own
        // territory, which is as far as a meander may push without leaving it.
        const ownSites = chain.map((cell) => points[cell]);
        const chainSet = new Set(chain);
        const otherSites: CellPoint[] = [];
        const seen = new Set<number>();
        for (const cell of chain) {
          for (const neighbour of adjacency[cell]) {
            if (chainSet.has(neighbour) || seen.has(neighbour)) continue;
            seen.add(neighbour);
            otherSites.push(points[neighbour]);
          }
        }
        const nearest = (sites: CellPoint[], p: CellPoint): number => {
          let best = Infinity;
          for (const site of sites) {
            const d = (site.x - p.x) ** 2 + (site.z - p.z) ** 2;
            if (d < best) best = d;
          }
          return Math.sqrt(best);
        };
        const clearanceAt = (p: CellPoint): number =>
          otherSites.length === 0 ? Infinity : Math.max(0, (nearest(otherSites, p) - nearest(ownSites, p)) / 2);

        riverPolylines.push(shapeCentreline(centreline, rooms, clearanceAt, riverPolylines.length));
      }
    }
  }

  console.info(`[shaping] Growing the land, zones, lakes and rivers: ${((performance.now() - landStarted) / 1000).toFixed(2)} s`);
  const riverField = timed("Indexing rivers", () => createRiverField(riverPolylines, RIVER_QUERY_RADIUS, { joinWithin: content.world.riverLevels ? RIVER_TRIBUTARY_LINK : 0 }));
  // Where each river would run on past its mouth (the line's first point, on the shore it drains
  // into): its last stretch carried straight on. Grown shore land keeps clear of these, so a river
  // reaches the new coast through a gap in the hills rather than ending against them.
  const mouthReach = Math.max(0, ...content.biomes.map((biome) => (shoreHillsOn ? biome.shoreHills?.grow ?? 0 : 0))) + SHORE_GROW_RIVER_OUTER;
  const mouthRuns: { ax: number; az: number; bx: number; bz: number }[] = [];
  for (const line of riverPolylines) {
    if (line.length < 2 || mouthReach <= SHORE_GROW_RIVER_OUTER) continue;
    const dx = line[0].x - line[1].x;
    const dz = line[0].z - line[1].z;
    const length = Math.hypot(dx, dz) || 1;
    mouthRuns.push({ ax: line[0].x, az: line[0].z, bx: line[0].x + (dx / length) * mouthReach, bz: line[0].z + (dz / length) * mouthReach });
  }
  /** Distance to the nearest river, its run on past the mouth included. */
  const riverOrMouthGap = (x: number, z: number, riverGap: number): number => {
    let best = riverGap;
    for (const run of mouthRuns) {
      const vx = run.bx - run.ax;
      const vz = run.bz - run.az;
      const t = Math.max(0, Math.min(1, ((x - run.ax) * vx + (z - run.az) * vz) / (vx * vx + vz * vz)));
      best = Math.min(best, Math.hypot(x - run.ax - vx * t, z - run.az - vz * t));
    }
    return best;
  };

  // landField is built from a filtered point array, so its query indices need remapping back to
  // the original cell indices that cellToAreaId is keyed by.
  const landIndexRemap: number[] = [];
  points.forEach((_, index) => {
    if (landCells.has(index)) landIndexRemap.push(index);
  });
  const landPoints: CellPoint[] = landIndexRemap.map((originalIndex) => points[originalIndex]);
  const oceanPoints: CellPoint[] = points.filter((_, index) => !landCells.has(index));

  // Shore hills: the style each zone raises them in, as a boundary-hill style.
  const shoreStyleCache = new Map<string, BoundaryHillStyle>();
  /** The shore's hill as a boundary-hill style: the named style's texture with the shore's own size. */
  const shoreStyleFor = (biome: BiomeDefinition, shore: ShoreHills): BoundaryHillStyle => {
    let style = shoreStyleCache.get(biome.seedKey);
    if (!style) {
      const base = content.boundaryHillStyles.find((candidate) => candidate.id === shore.style);
      if (!base) throw new Error(`biome ${biome.id}: shoreHills style "${shore.style}" is not a borderHills style`);
      shoreStyleCache.set(biome.seedKey, (style = { ...base, width: shore.width, peak: shore.peak, edgeNoise: shore.width * SHORE_EDGE_NOISE }));
    }
    return style;
  };

  const landField: VoronoiField = createVoronoiField(landPoints, CELL_SPACING * 1.5);
  const oceanField: VoronoiField = createVoronoiField(oceanPoints, CELL_SPACING * 1.5);

  const coastNoise2D = createBaseNoise2D(deriveSeed(seed, EDGE_NOISE_SALT));
  // The world's own wobble (WorldShape.coastWobble); unset keeps the continent's COAST_NOISE_AMPLITUDE.
  const coastAmplitude = content.world.coastWobble === undefined ? COAST_NOISE_AMPLITUDE : COAST_BORDER_WIDTH * content.world.coastWobble;
  const lakeNoise2D = createBaseNoise2D(deriveSeed(seed, LAKE_EDGE_NOISE_SALT));

  function areaIdOf(landFieldIndex: number): number {
    if (landFieldIndex === -1) return -1;
    return cellToAreaId.get(landIndexRemap[landFieldIndex]) ?? 0;
  }

  function areaBiomeOf(areaId: number): BiomeDefinition {
    return areaId === -1 ? (areaBiomes[0] ?? content.biomes[0]) : (areaBiomes[areaId] ?? content.biomes[0]);
  }

  function cellIdOf(landFieldIndex: number): number {
    return landFieldIndex === -1 ? -1 : landIndexRemap[landFieldIndex];
  }

  /** Signed lake-shore blend: 0 deep in dry land, 1 deep in a lake cell, smooth transition at the
   *  shore. Unlike computeBorderBlend (always positive, used to lerp two biomes together), this
   *  branches on which side is the lake since the transition needs to go both directions. */
  function computeLakeFactor(primaryCellId: number, secondaryCellId: number, borderGap: number, jitter: number): number {
    const primaryIsLake = lakeCells.has(primaryCellId);
    if (secondaryCellId === -1) return primaryIsLake ? 1 : 0;
    const secondaryIsLake = lakeCells.has(secondaryCellId);
    if (primaryIsLake === secondaryIsLake) return primaryIsLake ? 1 : 0; // an ordinary dry-dry (or lake-lake) cell seam, not a shore
    const signedGap = (primaryIsLake ? 1 : -1) * borderGap + jitter;
    return smoothstep(-LAKE_BORDER_WIDTH, LAKE_BORDER_WIDTH, signedGap);
  }

  /** The coast's edge gap at a point: positive on land (see sampleArea). */
  function coastEdgeGap(worldX: number, worldZ: number): number {
    const nearLand = landField.query(worldX, worldZ);
    const nearOcean = oceanField.query(worldX, worldZ);
    if (nearLand.nearestIndex === -1 && nearOcean.nearestIndex === -1) return -Infinity;
    const jitter = coastNoise2D(worldX * COAST_NOISE_FREQUENCY, worldZ * COAST_NOISE_FREQUENCY) * coastAmplitude;
    return nearOcean.nearestDistance - nearLand.nearestDistance + jitter;
  }

  // Shore hills need the distance to the coast: measured over the cells of the zones that raise
  // them, and only if one does, so a world without shore hills pays nothing.
  let shoreField: ShoreField | null = null;
  const bayCache = new Map<number, CellPoint[]>();
  const baysFor = (count: number): CellPoint[] => {
    let bays = bayCache.get(count);
    if (!bays) bayCache.set(count, (bays = shoreField!.bayCentres(count, mulberry32(deriveSeed(layout.landSeed, SHORE_BAY_SALT)))));
    return bays;
  };
  {
    let box: AreaBounds | null = null;
    for (const [cellIndex, areaId] of cellToAreaId) {
      if (!shoreHillsOn || !areaBiomes[areaId]?.shoreHills) continue;
      const site = points[cellIndex];
      if (!box) box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
      box.minX = Math.min(box.minX, site.x - CELL_SPACING / 2);
      box.minZ = Math.min(box.minZ, site.z - CELL_SPACING / 2);
      box.maxX = Math.max(box.maxX, site.x + CELL_SPACING / 2);
      box.maxZ = Math.max(box.maxZ, site.z + CELL_SPACING / 2);
    }
    if (box) {
      const measured = box;
      const maxGrow = Math.max(0, ...areaBiomes.map((biome) => (shoreHillsOn ? biome.shoreHills?.grow ?? 0 : 0)));
      shoreField = timed("Measuring the shore", () => createShoreDistanceField(measured, (x, z) => coastEdgeGap(x, z) > 0, maxGrow));
    }
  }

  function sampleArea(worldX: number, worldZ: number): AreaSample {
    const nearLand = landField.query(worldX, worldZ);
    const nearOcean = oceanField.query(worldX, worldZ);
    const jitter = coastNoise2D(worldX * COAST_NOISE_FREQUENCY, worldZ * COAST_NOISE_FREQUENCY) * coastAmplitude;

    // Beyond both fields' search range (e.g. far outside the generated world) neither distance is
    // finite; treat that as open ocean rather than letting Infinity - Infinity produce NaN.
    const bothUnresolved = nearLand.nearestIndex === -1 && nearOcean.nearestIndex === -1;
    const rawEdgeGap = bothUnresolved ? -Infinity : nearOcean.nearestDistance - nearLand.nearestDistance + jitter;

    const primaryAreaId = areaIdOf(nearLand.nearestIndex);
    const primaryBiome = areaBiomeOf(primaryAreaId);

    // True distance to the nearest river centreline, and where along that river this is (see below).
    const river = riverField.query(worldX, worldZ);

    // Shore hills (ShoreHills): the land grows out over the open sea by `grow`, and a ridge runs a set
    // distance inland of that new coast, parting for the bays - where the new coast falls back toward
    // the old, so the sea reaches in and there is a beach where the hills part. The cells keep all the
    // land they had: the hills stand on what was added. `shoreGap` is the distance to the crest, or
    // Infinity where the biome raises none.
    const shore = shoreField ? primaryBiome.shoreHills : undefined;
    let shoreGap = Infinity;
    let landmass = smoothstep(-COAST_BORDER_WIDTH, COAST_BORDER_WIDTH, rawEdgeGap) * 2 - 1;
    const toOldCoast = shore && shoreField ? shoreField.distance(worldX, worldZ) : -Infinity;
    if (shore && shoreField && toOldCoast > -Infinity) {
      let bay = 0;
      if (shore.bays > 0) {
        // A bay is a disc on the coast: the ring parts and the coast falls back inside it.
        let near = Infinity;
        for (const centre of baysFor(shore.bays)) near = Math.min(near, Math.hypot(worldX - centre.x, worldZ - centre.z));
        bay = 1 - smoothstep(shore.bayWidth * 0.15, shore.bayWidth, near);
      }
      const toRiver = riverOrMouthGap(worldX, worldZ, river.distance);
      const grow = shore.grow * smoothstep(SHORE_GROW_RIVER_INNER, SHORE_GROW_RIVER_OUTER, toRiver) * shoreField.growFree(worldX, worldZ);
      const pulled = Math.max(0, grow - Math.min(grow, shore.bayDepth) * bay);
      const toCoast = toOldCoast + pulled;
      // The grown land, blended to the sea over the same width the cells' coast is; never less land
      // than the cells give, and none at all over water the land closes round.
      const grown = smoothstep(-COAST_BORDER_WIDTH, COAST_BORDER_WIDTH, 2 * toCoast) * 2 - 1;
      const keepOld = 1 - smoothstep(0, SHORE_GROW_ENCLOSED_REACH, shoreField.enclosedGap(worldX, worldZ));
      landmass = lerp(Math.max(landmass, grown), landmass, keepOld);
      // A bay opens the ring: its gap grows past the hill's reach (and its edge jitter's).
      // Thin land (a peninsula) lets them go the same way: no ridge down the middle of a spit.
      const reach = shore.inset + shore.width;
      const thin = 1 - smoothstep(reach * SHORE_THIN_FROM, reach * SHORE_THIN_TO, shoreField.thickness(worldX, worldZ) + pulled);
      // And the river's way out: no ridge across its mouth.
      const estuary = 1 - smoothstep(SHORE_GROW_RIVER_INNER, SHORE_GROW_RIVER_OUTER, toRiver);
      shoreGap = Math.abs(toCoast - shore.inset) + Math.max(bay, thin, estuary) * shore.width * (1 + SHORE_EDGE_NOISE);
    }

    // Every area whose border is close enough to matter, not just the one owning the second-nearest
    // cell. One sweep collects a per-area distance; each is a minimum over a fixed subset of cells,
    // so it moves continuously and an area can fade in from zero weight instead of switching on.
    const blendReach = AREA_BORDER_WIDTH + AREA_BLEND_JITTER_AMPLITUDE;
    const distanceByArea = landField.queryNearestPerGroup(worldX, worldZ, areaIdOf, nearLand.nearestDistance + blendReach);
    const areaWeights = computeAreaWeights(distanceByArea, areaBiomeOf, (areaId) =>
      coastNoise2D(
        worldX * AREA_BLEND_NOISE_FREQUENCY + areaId * AREA_BLEND_OFFSET_X,
        worldZ * AREA_BLEND_NOISE_FREQUENCY + areaId * AREA_BLEND_OFFSET_Z,
      ) * AREA_BLEND_JITTER_AMPLITUDE,
    );

    // Kept for consumers that just want "which zone is this, roughly" - the zone label and the
    // debug map - and derived from the same weights so they cannot disagree with what is rendered.
    const secondaryBiome = areaWeights.length > 1 ? areaWeights[1].biome : primaryBiome;
    const biomeBlend = areaWeights.length > 1 ? 1 - areaWeights[0].weight : 0;

    // Raw, unjittered - boundary hills apply their own independent edge jitter rather than reusing
    // the coastline/area-blend jitter above. When there's no second neighbor, secondNearestDistance
    // is Infinity (voronoiField.ts), so this naturally comes out Infinity too - no special-casing
    // needed, resolveBoundaryHillStyle's width check rejects it the same as any far-interior point.
    const borderGap = nearLand.secondNearestDistance - nearLand.nearestDistance;

    const primaryCellId = cellIdOf(nearLand.nearestIndex);
    const secondaryCellId = nearLand.secondNearestIndex === -1 ? primaryCellId : cellIdOf(nearLand.secondNearestIndex);
    const lakeJitter = lakeNoise2D(worldX * LAKE_NOISE_FREQUENCY, worldZ * LAKE_NOISE_FREQUENCY) * LAKE_NOISE_AMPLITUDE;
    const lakeFactor = computeLakeFactor(primaryCellId, secondaryCellId, borderGap, lakeJitter);

    // True distance to the nearest river centreline, and where along that river this is. Both come
    // straight out of the geometry, so they are defined and continuous everywhere - there is no
    // longer any "is this point on a river edge" predicate for the carve to switch on. isRiverEdge
    // survives only as "close enough for the valley to reach", which riverEvaluator.ts fades to
    // nothing before it becomes false.
    const isRiverEdge = river.distance < RIVER_QUERY_RADIUS;
    const riverTaper = river.taper;
    const riverGap = river.distance;

    // How far this point is from the border of its own area, as the gap to the nearest cell
    // belonging to a DIFFERENT area. Unlike borderGap above - which is a cell-pair gap, and so
    // measures the distance to the nearest cell seam whether or not that seam is an area border -
    // this is a minimum over a fixed subset of cells, so it stays continuous even where the winning
    // cell changes. That is the whole point: it is what lets the hill fade in instead of switching
    // on. Beyond the envelope's own reach the answer cannot matter, so the search is capped there.
    const hillReach = BOUNDARY_HILL_WIDTH + BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE;
    const nearestOtherArea = landField.queryNearestWhere(
      worldX,
      worldZ,
      (index) => areaIdOf(index) !== primaryAreaId,
      nearLand.nearestDistance + hillReach,
    );
    const areaBorderGap = nearestOtherArea.distance - nearLand.nearestDistance;
    const otherAreaId = nearestOtherArea.index === -1 ? primaryAreaId : areaIdOf(nearestOtherArea.index);

    // Rivers take precedence over boundary hills where they overlap - a river's centreline runs
    // along cell borders, which are often area borders too (every biome is mountain-type today),
    // and a hill would otherwise raise a bump exactly where the valley is cutting one away. That
    // precedence is applied as a fade in terrainSampler rather than as a style gate here: deciding
    // it by "is there a river near this point" made the hill appear at full height the moment that
    // went false.
    let boundaryHillStyle =
      nearestOtherArea.index === -1
        ? null
        : resolveBoundaryHillStyle(seed, content.boundaryHillStyles, primaryBiome, areaBiomeOf(otherAreaId), primaryAreaId, otherAreaId);
    // Whichever hill is nearer rules, and its distance is what everything that keeps off the hills
    // (settlements, compounds) reads as areaBorderGap.
    let hillGap = areaBorderGap;
    if (shore && shoreGap < hillGap) {
      boundaryHillStyle = shoreStyleFor(primaryBiome, shore);
      hillGap = shoreGap;
    }

    return {
      landmass,
      primaryAreaId,
      isLand: landmass > 0,
      primaryBiome,
      secondaryBiome,
      biomeBlend,
      areaWeights,
      borderGap,
      areaBorderGap: hillGap,
      boundaryHillStyle,
      lakeFactor,
      isRiverEdge,
      riverTaper,
      riverGap,
      riverIndex: river.river,
    };
  }

  // A cell's site is its centre, not its edge, so the footprint is grown by roughly half a cell to
  // reach the borders - close enough for framing a view, and it avoids needing the Voronoi polygons
  // here just to draw a map.
  const areaBounds = new Map<number, AreaBounds>();
  for (const [cellIndex, areaId] of cellToAreaId) {
    const site = points[cellIndex];
    const existing = areaBounds.get(areaId);
    if (existing) {
      existing.minX = Math.min(existing.minX, site.x - CELL_SPACING / 2);
      existing.minZ = Math.min(existing.minZ, site.z - CELL_SPACING / 2);
      existing.maxX = Math.max(existing.maxX, site.x + CELL_SPACING / 2);
      existing.maxZ = Math.max(existing.maxZ, site.z + CELL_SPACING / 2);
    } else {
      areaBounds.set(areaId, {
        minX: site.x - CELL_SPACING / 2,
        minZ: site.z - CELL_SPACING / 2,
        maxX: site.x + CELL_SPACING / 2,
        maxZ: site.z + CELL_SPACING / 2,
      });
    }
  }

  // Named in ascending id so the set of names is stable: the generator re-rolls on a collision,
  // which makes a later name depend on which earlier ones were already taken.
  const nameGenerator = createNameGenerator(seed, content.voices);
  const areaNames = new Map<number, string>();
  for (let areaId = 0; areaId < areaBiomes.length; areaId++) {
    areaNames.set(areaId, nameGenerator.nameFor(areaBiomes[areaId].voiceId, areaId));
  }

  const touching = new Map<number, Set<number>>();
  for (const [cellIndex, areaId] of cellToAreaId) {
    for (const neighbour of adjacency[cellIndex]) {
      const other = cellToAreaId.get(neighbour);
      if (other === undefined || other === areaId) continue;
      if (!touching.has(areaId)) touching.set(areaId, new Set());
      touching.get(areaId)!.add(other);
    }
  }
  const areaNeighbours = new Map<number, number[]>();
  for (let areaId = 0; areaId < areaBiomes.length; areaId++) areaNeighbours.set(areaId, [...(touching.get(areaId) ?? [])].sort((a, b) => a - b));

  const landCellSites: CellPoint[] = [];
  for (const cellIndex of landCells) {
    if (!lakeCells.has(cellIndex)) landCellSites.push(points[cellIndex]);
  }

  return {
    sampleArea,
    riverField,
    // The shore hills' land grows past the cells' own reach; whatever is sized by the world's extent
    // (spawns, starts, cave mouths, the map) has to see it.
    worldExtent: layout.worldExtent + 2 * Math.max(0, ...areaBiomes.map((biome) => (shoreHillsOn ? biome.shoreHills?.grow ?? 0 : 0))),
    areaBounds,
    areaNames,
    landCellSites,
    nameGenerator,
    areaBiomes,
    areaNeighbours,
  };
}
