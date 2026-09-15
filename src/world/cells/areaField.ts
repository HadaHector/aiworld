import { createVoronoiField, type VoronoiField } from "./voronoiField";
import { computeCellBounds, generateCellDiagram, type CellPoint } from "./cellGrid";
import { pickStartCell, growLandmass } from "./regionGrowth";
import { partitionIntoAreas, assignAreaBiomes } from "./areaAssignment";
import { createBaseNoise2D } from "../terrain/noise";
import { deriveSeed } from "../rng";
import { smoothstep } from "../mathUtils";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import { BIOME_REGISTRY } from "../biomes/biomeDefinitions";
import {
  WORLD_EXTENT,
  CELL_SPACING,
  CELL_BOUNDS_MARGIN,
  TARGET_LAND_CELLS,
  TARGET_AREA_COUNT,
  COAST_NOISE_FREQUENCY,
  COAST_NOISE_AMPLITUDE,
  COAST_BORDER_WIDTH,
  AREA_BORDER_WIDTH,
  EDGE_NOISE_SALT,
} from "./config";

export const SEA_LEVEL = 0;
const WORLD_CENTER_X = 0;
const WORLD_CENTER_Z = 0;

export interface AreaSample {
  landmass: number;
  isLand: boolean;
  primaryBiome: BiomeDefinition;
  secondaryBiome: BiomeDefinition;
  biomeBlend: number;
}

export type AreaSampler = (worldX: number, worldZ: number) => AreaSample;

function computeBorderBlend(nearestDistance: number, secondNearestDistance: number, jitter: number): number {
  const gap = secondNearestDistance - nearestDistance + jitter;
  const t = 1 - smoothstep(0, AREA_BORDER_WIDTH, gap);
  return t * 0.5;
}

/** Composes the cell diagram, land growth, and area partitioning into one queryable per-position sample. */
export function createAreaSampler(seed: number): AreaSampler {
  const bounds = computeCellBounds(WORLD_CENTER_X, WORLD_CENTER_Z, WORLD_EXTENT, CELL_BOUNDS_MARGIN);
  const { points, adjacency } = generateCellDiagram(seed, bounds, CELL_SPACING);

  const startIndex = pickStartCell(seed, points, WORLD_CENTER_X, WORLD_CENTER_Z, CELL_SPACING);
  const landCells = growLandmass(seed, adjacency, startIndex, TARGET_LAND_CELLS);

  const cellToAreaId = partitionIntoAreas(seed, adjacency, landCells, TARGET_AREA_COUNT);
  const areaBiomes = assignAreaBiomes(seed, TARGET_AREA_COUNT);

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

  function areaBiomeOf(landFieldIndex: number): BiomeDefinition {
    if (landFieldIndex === -1) return areaBiomes[0] ?? BIOME_REGISTRY[0];
    const originalCellIndex = landIndexRemap[landFieldIndex];
    const areaId = cellToAreaId.get(originalCellIndex) ?? 0;
    return areaBiomes[areaId] ?? BIOME_REGISTRY[0];
  }

  return function sampleArea(worldX: number, worldZ: number): AreaSample {
    const nearLand = landField.query(worldX, worldZ);
    const nearOcean = oceanField.query(worldX, worldZ);
    const jitter = coastNoise2D(worldX * COAST_NOISE_FREQUENCY, worldZ * COAST_NOISE_FREQUENCY) * COAST_NOISE_AMPLITUDE;

    const edgeGap = nearOcean.nearestDistance - nearLand.nearestDistance + jitter;
    const landmass = smoothstep(-COAST_BORDER_WIDTH, COAST_BORDER_WIDTH, edgeGap) * 2 - 1;

    const primaryBiome = areaBiomeOf(nearLand.nearestIndex);
    const secondaryBiome = nearLand.secondNearestIndex === -1 ? primaryBiome : areaBiomeOf(nearLand.secondNearestIndex);
    const biomeBlend =
      nearLand.secondNearestIndex === -1 ? 0 : computeBorderBlend(nearLand.nearestDistance, nearLand.secondNearestDistance, jitter);

    return { landmass, isLand: landmass > 0, primaryBiome, secondaryBiome, biomeBlend };
  };
}
