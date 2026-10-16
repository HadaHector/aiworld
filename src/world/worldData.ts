import { createTerrainSampler } from "./terrain/terrainSampler";
import { generateBuilding } from "./buildings/buildingGenerator";
import { generateProp } from "./props/propGenerator";
import { settleWallRuns, wallStretches } from "./features/compound";
import { planRoadFences } from "./roads/roadFences";
import { planRoadSigns } from "./roads/roadSigns";
import type { House } from "./settlements/settlementLayout";
import type { BuildingGroup, Placed } from "./buildings/buildingCollision";
import type { WorldContent } from "./content/worldContent";

/** The world's seed - also what the workbench previews with until told otherwise. */
export const WORLD_SEED = 1338;

/** The roads' fences are drawn (and come into the collision world) in cells this wide. */
const FENCE_CELL = 256;
/** A bridge's piers reach down to this height - the deepest river's bed, under the water. */
const BRIDGE_PIER_FOOT = -9;

/** A thing's label is shown this high over its foot - over a sign's board, at about eye level. */
const LABEL_HEIGHT = 2.2;

/** Something in the world that says what it is to a player standing by it - a wayside sign its
 *  place's name (see ui/placeLabels.ts). */
export interface PlaceLabel {
  x: number;
  y: number;
  z: number;
  text: string;
  /** Read by pointing at it rather than by standing by it - one of several close together, a
   *  fingerpost's arms: shown while the pointer is over it on screen, the player within
   *  HOVER_DISTANCE. */
  hover?: boolean;
}

/**
 * The world as generated from the seed and the packs, before anything is drawn: its terrain, its
 * places, and every building, prop, fence and bridge set down in it. Pure - no Babylon, no browser -
 * so the simulation (see SIMULATION.md) and the drawn world (world.ts) each make their own from the
 * same seed and get the same world.
 */
export interface WorldData extends ReturnType<typeof createTerrainSampler> {
  seed: number;
  content: WorldContent;
  heightAt: (worldX: number, worldZ: number) => number;
  /** Everything set down with a model, in the groups that come into the collision world together:
   *  each settlement, each compound, and the roads' fences, bridges and signs by cell. */
  buildingGroups: BuildingGroup[];
  /** What the world's things say to a player standing by them. */
  labels: PlaceLabel[];
  /** The building whose footprint (x, y, z) stands in, with a key unique to that one building. */
  buildingAt: (x: number, y: number, z: number) => { id: string; key: number } | undefined;
}

export function createWorldData(seed: number, content: WorldContent): WorldData {
  const terrain = createTerrainSampler(seed, content);
  const { sampleTerrain, features, roads, settlementLayouts, compoundLayouts, bridges } = terrain;

  // The roads' fences where the ground falls away beside them, set on the ground, drawn in cells.
  const propById = new Map(content.props.map((prop) => [prop.id, prop]));
  const roadFences = planRoadFences(roads.stretches, sampleTerrain, propById, seed);
  settleWallRuns(roadFences, sampleTerrain);
  // And fingerposts at their junctions, an arm down each road saying where it leads.
  const roadSigns = planRoadSigns(roads, sampleTerrain, propById, seed);
  const fenceCells = new Map<string, BuildingGroup>();
  const fenceCell = (x: number, z: number): Placed[] => {
    const gx = Math.floor(x / FENCE_CELL);
    const gz = Math.floor(z / FENCE_CELL);
    const key = `fences:${gx},${gz}`;
    let cell = fenceCells.get(key);
    if (!cell) {
      cell = { key, x: (gx + 0.5) * FENCE_CELL, z: (gz + 0.5) * FENCE_CELL, houses: [] };
      fenceCells.set(key, cell);
    }
    return cell.houses;
  };
  for (const run of roadFences) {
    fenceCell(run.points[0].x, run.points[0].z).push(...wallStretches(run, seed));
  }
  // The bridges: each a line prop along its deck, its piers down under the water.
  for (const bridge of bridges) {
    const run = { prop: bridge.prop, variant: bridge.variant, points: bridge.points, heights: bridge.heights, ends: ["free", "free"] as ["free", "free"], breach: false, width: bridge.width, base: BRIDGE_PIER_FOOT };
    fenceCell(bridge.points[0].x, bridge.points[0].z).push(...wallStretches(run, seed));
  }
  for (const prop of roadSigns.props) {
    fenceCell(prop.x, prop.z).push({ ...prop, model: (far: boolean) => generateProp(prop.prop, seed, prop.variant, far) });
  }
  const houseModel = (house: House): Placed => ({ ...house, model: (far: boolean) => generateBuilding(house.building, seed, house.variant, far) });
  const buildingGroups: BuildingGroup[] = [
    ...settlementLayouts.map((layout) => ({ key: `settlement:${layout.siteId}`, x: layout.x, z: layout.z, houses: layout.houses.map(houseModel) })),
    ...compoundLayouts.map((layout) => ({
      key: `compound:${layout.featureId}`,
      x: layout.x,
      z: layout.z,
      houses: [
        ...layout.buildings.map(houseModel),
        ...layout.props.map((prop) => ({ ...prop, model: (far: boolean) => generateProp(prop.prop, seed, prop.variant, far) })),
        ...layout.walls.flatMap((run) => wallStretches(run, seed)),
      ],
    })),
    ...fenceCells.values(),
  ];

  // Every building of every settlement and compound, bucketed by where it stands, for buildingAt.
  const BUILDING_CELL = 32;
  const buildingCells = new Map<string, { house: House; key: number }[]>();
  [...settlementLayouts.flatMap((l) => l.houses), ...compoundLayouts.flatMap((l) => l.buildings)].forEach((house, key) => {
    const reach = Math.hypot(house.width, house.depth) / 2;
    for (let cx = Math.floor((house.x - reach) / BUILDING_CELL); cx <= Math.floor((house.x + reach) / BUILDING_CELL); cx++) {
      for (let cz = Math.floor((house.z - reach) / BUILDING_CELL); cz <= Math.floor((house.z + reach) / BUILDING_CELL); cz++) {
        const cell = `${cx},${cz}`;
        const list = buildingCells.get(cell);
        if (list) list.push({ house, key });
        else buildingCells.set(cell, [{ house, key }]);
      }
    }
  });
  const buildingAt = (x: number, y: number, z: number): { id: string; key: number } | undefined => {
    for (const { house, key } of buildingCells.get(`${Math.floor(x / BUILDING_CELL)},${Math.floor(z / BUILDING_CELL)}`) ?? []) {
      // Depth runs along the front (toward the street), width across it.
      const dx = x - house.x;
      const dz = z - house.z;
      const along = dx * house.frontX + dz * house.frontZ;
      const across = -dx * house.frontZ + dz * house.frontX;
      if (Math.abs(along) <= house.depth / 2 && Math.abs(across) <= house.width / 2 && y > house.y - 1 && y < house.y + 12) return { id: house.building.id, key };
    }
    return undefined;
  };

  const labels: PlaceLabel[] = compoundLayouts
    .flatMap((layout) =>
      layout.props
        .filter((prop) => prop.prop.label === "place")
        .map((prop) => ({ x: prop.x, y: prop.y + LABEL_HEIGHT, z: prop.z, text: features[layout.featureId]?.name ?? features[layout.featureId]?.kind.name ?? layout.kindId })),
    )
    .concat(roadSigns.labels);

  return {
    ...terrain,
    seed,
    content,
    heightAt: (worldX, worldZ) => sampleTerrain(worldX, worldZ).height,
    buildingGroups,
    labels,
    buildingAt,
  };
}
