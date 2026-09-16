import { createVoronoiField, type VoronoiField } from "./voronoiField";
import { computeCellBounds, generateCellDiagram, type CellPoint } from "./cellGrid";
import { planWorld } from "./continentLayout";
import { pickStartCell, growLandmass } from "./regionGrowth";
import { partitionIntoAreas, assignAreaBiomes } from "./areaAssignment";
import { createBaseNoise2D } from "../terrain/noise";
import { deriveSeed } from "../rng";
import { smoothstep } from "../mathUtils";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import { BIOME_REGISTRY } from "../biomes/biomeDefinitions";
import { CELL_SPACING, CELL_BOUNDS_MARGIN, COAST_NOISE_FREQUENCY, COAST_NOISE_AMPLITUDE, COAST_BORDER_WIDTH, AREA_BORDER_WIDTH, EDGE_NOISE_SALT } from "./config";

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

export interface AreaWorld {
  sampleArea: AreaSampler;
  worldExtent: number;
}

function computeBorderBlend(nearestDistance: number, secondNearestDistance: number, jitter: number): number {
  const gap = secondNearestDistance - nearestDistance + jitter;
  const t = 1 - smoothstep(0, AREA_BORDER_WIDTH, gap);
  return t * 0.5;
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

  function areaBiomeOf(landFieldIndex: number): BiomeDefinition {
    if (landFieldIndex === -1) return areaBiomes[0] ?? BIOME_REGISTRY[0];
    const originalCellIndex = landIndexRemap[landFieldIndex];
    const areaId = cellToAreaId.get(originalCellIndex) ?? 0;
    return areaBiomes[areaId] ?? BIOME_REGISTRY[0];
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

    const primaryBiome = areaBiomeOf(nearLand.nearestIndex);
    const secondaryBiome = nearLand.secondNearestIndex === -1 ? primaryBiome : areaBiomeOf(nearLand.secondNearestIndex);
    const biomeBlend =
      nearLand.secondNearestIndex === -1 ? 0 : computeBorderBlend(nearLand.nearestDistance, nearLand.secondNearestDistance, jitter);

    return { landmass, isLand: landmass > 0, primaryBiome, secondaryBiome, biomeBlend };
  }

  return { sampleArea, worldExtent: layout.worldExtent };
}
