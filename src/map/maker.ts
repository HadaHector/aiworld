import type { BuildingGroup } from "../world/buildings/buildingCollision";
import type { WorldContent } from "../world/content/worldContent";
import type { MaterialBlender } from "../world/materials/materialBlend";
import { samplerGround, type TreeCover, type TreeScatter } from "../world/foliage/treeScatter";
import type { TerrainSampler } from "../world/terrain/terrainSampler";
import { mapTileSteps, type Rgb } from "./tiles";
import type { MapThings } from "./things";

/** How high over a thing's foot the map cuts it away (MAP.md: 8 m). */
export const MAP_CUT = 8;

/** The colours the map draws things in, known once the page has baked its textures. */
export interface MapColors {
  /** The ground's materials' average colours, by material index. */
  ground: Rgb[];
  /** Building materials' average colours, by id. */
  buildings: Record<string, Rgb>;
  /** Tree kinds' leaves' and wood's colours, by id (TreeField.mapColors). */
  trees: Record<string, { leaves: Rgb; wood: Rgb }>;
}

/** What a world holds that the map is drawn from - the chunk workers' copy has all of it. */
export interface MapWorld {
  seed: number;
  content: WorldContent;
  sampleTerrain: TerrainSampler;
  materialBlender: Pick<MaterialBlender, "buildMaterialBlend">;
  treeCover: TreeCover;
  scatterTrees: TreeScatter;
  scatterBushes: TreeScatter;
  scatterRocks: TreeScatter;
  /** Asked for on the first tile, so a worker that is never asked for one never makes them. */
  buildingGroups: () => readonly BuildingGroup[];
}

/** Makes tiles of one world, a slice at a time (see mapTileSteps), in whatever thread holds it. */
export function createMapTileMaker(world: MapWorld, colors: MapColors): (tx: number, tz: number) => Generator<void, Uint8ClampedArray> {
  const ground = { sampleTerrain: world.sampleTerrain, buildMaterialBlend: world.materialBlender.buildMaterialBlend, groundColors: colors.ground, treeCover: world.treeCover };
  let things: MapThings | null = null;
  return (tx, tz) => {
    things ??= {
      groups: world.buildingGroups(),
      buildingColors: colors.buildings,
      scatterTrees: world.scatterTrees,
      scatterBushes: world.scatterBushes,
      scatterRocks: world.scatterRocks,
      treeGround: samplerGround(world.sampleTerrain),
      treeKinds: [...world.content.treeKinds, ...world.content.bushKinds, ...world.content.rockKinds],
      treeColors: colors.trees,
      seed: world.seed,
      cut: MAP_CUT,
      near: false,
    };
    return mapTileSteps(ground, tx, tz, things);
  };
}
