import { createWorldCollision, type WorldCollision } from "../world/worldCollision";
import { createTreeScatter } from "../world/foliage/treeScatter";
import { generateTreeHulls, treeColliders, type TreeHulls } from "../world/foliage/treeColliders";
import { createPlacedBuildings, modelGroups, type ModelledGroup, type PlacedBuildings } from "../world/buildings/buildingCollision";
import type { WorldData } from "../world/worldData";
import { COLLISION_CHUNK_SIZE, createCollisionStreamer, type CollisionStreamer } from "./collisionStreamer";
import { createPlayerBody, type PlayerBody } from "./playerBody";
import type { Entity } from "./entity";
import { createTrunkField, type TrunkField } from "./trunks";

/**
 * What a host hands the server for one dimension: its world as generated from its seed and its
 * content, and whatever it has already made from that in the same process. Each extra is pure,
 * read-only data - the server would make exactly the same itself.
 */
export interface DimensionWorld {
  world: WorldData;
  /** Every tree kind's hulls (see foliage/treeColliders.ts). */
  treeHulls?: TreeHulls;
  /** Every building group with its near models made (see buildings/buildingCollision.ts). */
  buildingModels?: readonly ModelledGroup[];
}

/** One loaded dimension on the server: its world's collision, kept around the bodies in it. */
export interface Dimension {
  readonly id: string;
  readonly world: WorldData;
  readonly collision: WorldCollision;
  readonly streamer: CollisionStreamer;
  readonly buildings: PlacedBuildings;
  /** Its trees as rings round each foot, and its buildings' footprints: where a body fits, collision in or not. */
  readonly trunks: TrunkField;
  /** A body standing on the ground at a point, in this dimension's collision. */
  createBody: (x: number, z: number) => PlayerBody;
  /** What is stood on at a point: the floor of a building there, or the ground. */
  groundAt: (x: number, z: number) => number;
  /** Every entity in it, by id: the ones it places, those made in it since, and the players in it
   *  that have a body (see ENTITIES.md). */
  readonly entities: Map<number, Entity>;
}

/**
 * One world on the server (see DIMENSIONS.md): its ground, trees and buildings in a collision world
 * of its own, streamed in around whichever bodies walk it. Nothing in it knows any other dimension.
 */
export function createDimension(id: string, { world, treeHulls, buildingModels }: DimensionWorld): Dimension {
  const { seed, content } = world;
  const hulls = treeHulls ?? generateTreeHulls(content.treeKinds, seed);
  const buildings = createPlacedBuildings(buildingModels ?? modelGroups(world.buildingGroups));
  const collision = createWorldCollision({ colliders: (trees) => treeColliders(hulls, trees) }, COLLISION_CHUNK_SIZE, buildings.cellarCuts);
  const scatterTrees = createTreeScatter(seed, content);
  const streamer = createCollisionStreamer({ sampleTerrain: world.sampleTerrain, scatterTrees }, collision, buildings);
  const groundAt = (x: number, z: number, feet: number): number => buildings.floorAt(x, z, feet) ?? world.heightAt(x, z);
  return {
    id,
    world,
    collision,
    streamer,
    buildings,
    trunks: createTrunkField(world, hulls, scatterTrees),
    createBody: (x, z) => createPlayerBody(collision, world.heightAt, groundAt, { x, z }),
    groundAt: (x, z) => groundAt(x, z, world.heightAt(x, z) + 0.5),
    entities: new Map(),
  };
}
