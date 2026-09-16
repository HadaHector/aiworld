import { createVoronoiField, type VoronoiField } from "./voronoiField";
import { computeCellBounds, generateCellDiagram, type CellPoint } from "./cellGrid";
import { planWorld, type ContinentPlan } from "./continentLayout";
import { pickStartCell, growLandmass } from "./regionGrowth";
import { partitionIntoAreas, assignAreaBiomes } from "./areaAssignment";
import { createBaseNoise2D } from "../terrain/noise";
import { deriveSeed } from "../rng";
import { smoothstep } from "../mathUtils";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import { BIOME_REGISTRY } from "../biomes/biomeDefinitions";
import { BOUNDARY_HILL_STYLES, type BoundaryHillStyle } from "../biomes/boundaryHillStyles";
import { CELL_SPACING, CELL_BOUNDS_MARGIN, COAST_NOISE_FREQUENCY, COAST_NOISE_AMPLITUDE, COAST_BORDER_WIDTH, AREA_BORDER_WIDTH, EDGE_NOISE_SALT } from "./config";
import { BOUNDARY_HILL_WIDTH, BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE, BOUNDARY_HILL_STYLE_SALT } from "../terrain/boundaryHills/boundaryHillsConfig";

export const SEA_LEVEL = 0;
const WORLD_CENTER_X = 0;
const WORLD_CENTER_Z = 0;

export interface AreaSample {
  landmass: number;
  isLand: boolean;
  primaryBiome: BiomeDefinition;
  secondaryBiome: BiomeDefinition;
  biomeBlend: number;
  borderGap: number;
  boundaryHillStyle: BoundaryHillStyle | null;
}

export type AreaSampler = (worldX: number, worldZ: number) => AreaSample;

export interface AreaWorld {
  sampleArea: AreaSampler;
  worldExtent: number;
  continents: ContinentPlan[];
}

function computeBorderBlend(nearestDistance: number, secondNearestDistance: number, jitter: number): number {
  const gap = secondNearestDistance - nearestDistance + jitter;
  const t = 1 - smoothstep(0, AREA_BORDER_WIDTH, gap);
  return t * 0.5;
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
function resolveBoundaryHillStyle(
  seed: number,
  primaryBiome: BiomeDefinition,
  secondaryBiome: BiomeDefinition,
  primaryAreaId: number,
  secondaryAreaId: number,
  borderGap: number,
): BoundaryHillStyle | null {
  if (primaryAreaId === secondaryAreaId) return null;
  if (primaryBiome.borderType !== "mountain" && secondaryBiome.borderType !== "mountain") return null;
  if (borderGap > BOUNDARY_HILL_WIDTH + BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE) return null;

  const lo = Math.min(primaryAreaId, secondaryAreaId);
  const hi = Math.max(primaryAreaId, secondaryAreaId);
  const pairKey = ((lo << 16) ^ hi) >>> 0;
  const pairSeed = mixSeed(deriveSeed(seed, BOUNDARY_HILL_STYLE_SALT) ^ pairKey);
  return BOUNDARY_HILL_STYLES[pairSeed % BOUNDARY_HILL_STYLES.length];
}

/** Composes the cell diagram, multi-continent land growth, and area partitioning into one queryable per-position sample. */
export function createAreaSampler(seed: number): AreaWorld {
  const layout = planWorld(seed);
  const bounds = computeCellBounds(WORLD_CENTER_X, WORLD_CENTER_Z, layout.worldExtent, CELL_BOUNDS_MARGIN);
  const { points, adjacency } = generateCellDiagram(seed, bounds, CELL_SPACING);

  const landCells = new Set<number>();
  const cellToAreaId = new Map<number, number>();
  const areaBiomes: BiomeDefinition[] = [];
  let areaIdOffset = 0;

  for (const continent of layout.continents) {
    const startIndex = pickStartCell(continent.seed, points, continent.centerX, continent.centerZ, CELL_SPACING, landCells);
    const continentCells = growLandmass(continent.seed, adjacency, startIndex, continent.cellCount, landCells);
    continentCells.forEach((index) => landCells.add(index));

    const localAreaId = partitionIntoAreas(continent.seed, adjacency, continentCells, continent.areaCount);
    localAreaId.forEach((id, cellIndex) => cellToAreaId.set(cellIndex, id + areaIdOffset));

    areaBiomes.push(...assignAreaBiomes(continent.seed, continent.areaCount));
    areaIdOffset += continent.areaCount;
  }

  // landField is built from a filtered point array, so its query indices need remapping back to
  // the original cell indices that cellToAreaId is keyed by.
  const landIndexRemap: number[] = [];
  points.forEach((_, index) => {
    if (landCells.has(index)) landIndexRemap.push(index);
  });
  const landPoints: CellPoint[] = landIndexRemap.map((originalIndex) => points[originalIndex]);
  const oceanPoints: CellPoint[] = points.filter((_, index) => !landCells.has(index));

  const landField: VoronoiField = createVoronoiField(landPoints, CELL_SPACING * 1.5);
  const oceanField: VoronoiField = createVoronoiField(oceanPoints, CELL_SPACING * 1.5);

  const coastNoise2D = createBaseNoise2D(deriveSeed(seed, EDGE_NOISE_SALT));

  function areaIdOf(landFieldIndex: number): number {
    if (landFieldIndex === -1) return -1;
    return cellToAreaId.get(landIndexRemap[landFieldIndex]) ?? 0;
  }

  function areaBiomeOf(areaId: number): BiomeDefinition {
    return areaId === -1 ? (areaBiomes[0] ?? BIOME_REGISTRY[0]) : (areaBiomes[areaId] ?? BIOME_REGISTRY[0]);
  }

  function sampleArea(worldX: number, worldZ: number): AreaSample {
    const nearLand = landField.query(worldX, worldZ);
    const nearOcean = oceanField.query(worldX, worldZ);
    const jitter = coastNoise2D(worldX * COAST_NOISE_FREQUENCY, worldZ * COAST_NOISE_FREQUENCY) * COAST_NOISE_AMPLITUDE;

    // Beyond both fields' search range (e.g. far outside the generated world) neither distance is
    // finite; treat that as open ocean rather than letting Infinity - Infinity produce NaN.
    const bothUnresolved = nearLand.nearestIndex === -1 && nearOcean.nearestIndex === -1;
    const edgeGap = bothUnresolved ? -Infinity : nearOcean.nearestDistance - nearLand.nearestDistance + jitter;
    const landmass = smoothstep(-COAST_BORDER_WIDTH, COAST_BORDER_WIDTH, edgeGap) * 2 - 1;

    const primaryAreaId = areaIdOf(nearLand.nearestIndex);
    const secondaryAreaId = nearLand.secondNearestIndex === -1 ? primaryAreaId : areaIdOf(nearLand.secondNearestIndex);
    const primaryBiome = areaBiomeOf(primaryAreaId);
    const secondaryBiome = nearLand.secondNearestIndex === -1 ? primaryBiome : areaBiomeOf(secondaryAreaId);
    const biomeBlend =
      nearLand.secondNearestIndex === -1 ? 0 : computeBorderBlend(nearLand.nearestDistance, nearLand.secondNearestDistance, jitter);

    // Raw, unjittered - boundary hills apply their own independent edge jitter rather than reusing
    // the coastline/area-blend jitter above. When there's no second neighbor, secondNearestDistance
    // is Infinity (voronoiField.ts), so this naturally comes out Infinity too - no special-casing
    // needed, resolveBoundaryHillStyle's width check rejects it the same as any far-interior point.
    const borderGap = nearLand.secondNearestDistance - nearLand.nearestDistance;
    const boundaryHillStyle = resolveBoundaryHillStyle(seed, primaryBiome, secondaryBiome, primaryAreaId, secondaryAreaId, borderGap);

    return { landmass, isLand: landmass > 0, primaryBiome, secondaryBiome, biomeBlend, borderGap, boundaryHillStyle };
  }

  return { sampleArea, worldExtent: layout.worldExtent, continents: layout.continents };
}
