import type { BuildingModel } from "./buildingTypes";
import type { BuildingCollision } from "./buildingColliders";
import { interiorFloorAt, type BuiltInterior } from "./interiorFloors";
import { WALL } from "./interiorGeometry";
import { quatFromEuler, vec3, type ShapeDesc, type Vec3 } from "../collision/index";

/**
 * The buildings as something to walk into, stand in and on, and dig cellars under - everything
 * about placed buildings but drawing them. Pure, so the simulation (see SIMULATION.md) and the drawn
 * world (buildingRenderer.ts) share it.
 */

/** A rectangle taken out of the ground: its middle, the unit direction its width runs, and half
 *  its width and depth. */
export interface TerrainCut {
  x: number;
  z: number;
  ux: number;
  uz: number;
  halfWidth: number;
  halfDepth: number;
}

/** Something set down with a model of its own - a house, a prop: where it stands, which way its
 *  front (+z of its model) faces, and its model, near or far. */
export interface Placed {
  x: number;
  y: number;
  z: number;
  frontX: number;
  frontZ: number;
  /** Which way its up points, where it is tilted - lying on a slope - rather than standing upright. */
  up?: [number, number, number];
  model(far: boolean): BuildingModel;
}

/** Things set down that come into the collision world together - a settlement's houses, a
 *  compound's buildings and props - under `key`, round (x, z). */
export interface BuildingGroup {
  key: string;
  x: number;
  z: number;
  houses: Placed[];
}

/** A group with each thing's near model already made - what the collision is built from. */
export interface ModelledGroup {
  key: string;
  x: number;
  z: number;
  houses: { house: Placed; model: BuildingModel }[];
}

/**
 * Its model's axes in the world: its front (+z) turned to (frontX, frontZ) and its +x to the right
 * of that - and, where it has an `up`, tipped over so its +y runs along it, its front staying as
 * near its front as the tilt lets it.
 */
export function placedAxes(item: { frontX: number; frontZ: number; up?: [number, number, number] }): { x: Vec3; y: Vec3; z: Vec3 } {
  const up = item.up ?? [0, 1, 0];
  const f: [number, number, number] = [item.frontX, 0, item.frontZ];
  const d = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
  let z: [number, number, number] = [f[0] - up[0] * d, f[1] - up[1] * d, f[2] - up[2] * d];
  const zl = Math.hypot(...z) || 1;
  z = [z[0] / zl, z[1] / zl, z[2] / zl];
  // x = up × z.
  const x: [number, number, number] = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  return { x: vec3(...x), y: vec3(...up), z: vec3(...z) };
}

/** Each group's near models, made now - for a caller with no drawn models to take them from. */
export function modelGroups(groups: readonly BuildingGroup[]): ModelledGroup[] {
  return groups.map((group) => ({ key: group.key, x: group.x, z: group.z, houses: group.houses.map((house) => ({ house, model: house.model(false) })) }));
}

export interface PlacedBuildings {
  /** What one stands on inside a building at a world point - see interiorFloorAt - or null outside
   *  every building's rooms. */
  floorAt: (x: number, z: number, feet: number) => number | null;
  /**
   * Keeps the buildings of the groups near any of `points` (the players) in a collision world and
   * takes those further off out of it - `add` and `remove` are the world's (see worldCollision.ts).
   */
  updateCollision: (points: readonly { x: number; z: number }[], add: (key: string, shapes: ShapeDesc[]) => void, remove: (key: string) => void) => void;
  /** The ground taken out over every cellar with rooms - for the ground's collision. */
  readonly cellarCuts: readonly TerrainCut[];
  /** Every house with rooms: where it stands, how far it reaches, and the ground over its cellars. */
  readonly enterable: readonly Enterable[];
}

/** A group's buildings come into the collision world within this far of its edge, and go again
 *  past COLLISION_OUT. */
const COLLISION_IN = 120;
const COLLISION_OUT = 180;

/** How far a step up the floor under the feet may be and still be stepped onto. */
const STEP_UP = 0.75;

/** One house's collision, in its own space, and where it stands. */
interface PlacedCollision {
  house: Placed;
  colliders: BuildingCollision;
}

/** A house with an interior: where it stands, which way it faces, and its rooms. */
export interface Enterable {
  house: Placed;
  interior: BuiltInterior;
  reach: number;
  /** The ground taken out over its cellars, in world space. */
  cuts: TerrainCut[];
}

/** A house's collision shapes in the world: turned to face its street and stood on its plot. */
function placedShapes({ house, colliders }: PlacedCollision, group: number): ShapeDesc[] {
  // Its +z turns to (frontX, frontZ), its +x to (frontZ, -frontX): a turn about y by this.
  const rotation = quatFromEuler(Math.atan2(house.frontX, house.frontZ));
  const a = placedAxes(house);
  const place = (x: number, y: number, z: number): Vec3 =>
    vec3(house.x + a.x.x * x + a.y.x * y + a.z.x * z, house.y + a.x.y * x + a.y.y * y + a.z.y * z, house.z + a.x.z * x + a.y.z * y + a.z.z * z);
  const shapes: ShapeDesc[] = [];
  const b = colliders.boxes;
  for (let i = 0; i < b.length; i += 6) {
    // Tilted, a box is no longer turned about y alone: its corners' hull instead.
    if (house.up && house.up[1] < 0.9999) {
      const points: Vec3[] = [];
      for (const x of [b[i], b[i + 3]]) for (const y of [b[i + 1], b[i + 4]]) for (const z of [b[i + 2], b[i + 5]]) points.push(place(x, y, z));
      shapes.push({ kind: "convex", points, group });
      continue;
    }
    shapes.push({
      kind: "box",
      center: place((b[i] + b[i + 3]) / 2, (b[i + 1] + b[i + 4]) / 2, (b[i + 2] + b[i + 5]) / 2),
      half: vec3((b[i + 3] - b[i]) / 2, (b[i + 4] - b[i + 1]) / 2, (b[i + 5] - b[i + 2]) / 2),
      rotation,
      group,
    });
  }
  for (const hull of colliders.hulls) {
    const points: Vec3[] = [];
    for (let i = 0; i < hull.length; i += 3) points.push(place(hull[i], hull[i + 1], hull[i + 2]));
    shapes.push({ kind: "convex", points, group });
  }
  return shapes;
}

export function createPlacedBuildings(groups: readonly ModelledGroup[]): PlacedBuildings {
  const enterable: Enterable[] = [];
  /** Each group's houses' collision, from their near models. */
  const collisions: { key: string; x: number; z: number; radius: number; houses: PlacedCollision[] }[] = [];
  const inCollision = new Set<string>();
  for (const group of groups) {
    if (group.houses.length === 0) continue;
    const houses: PlacedCollision[] = [];
    let radius = 0;
    for (const { house, model } of group.houses) {
      const reach = Math.hypot(model.halfWidth, model.halfDepth);
      if (model.interior) enterable.push(enterableOf(house, model.interior, reach));
      if (model.colliders) houses.push({ house, colliders: model.colliders });
      radius = Math.max(radius, Math.hypot(house.x - group.x, house.z - group.z) + reach);
    }
    collisions.push({ key: group.key, x: group.x, z: group.z, radius, houses });
  }

  return {
    updateCollision(points, add, remove) {
      for (const entry of collisions) {
        let distance = Infinity;
        for (const { x, z } of points) distance = Math.min(distance, Math.hypot(entry.x - x, entry.z - z) - entry.radius);
        if (!inCollision.has(entry.key) && distance <= COLLISION_IN) {
          inCollision.add(entry.key);
          add(entry.key, entry.houses.flatMap((house, n) => placedShapes(house, n)));
        } else if (inCollision.has(entry.key) && distance > COLLISION_OUT) {
          inCollision.delete(entry.key);
          remove(entry.key);
        }
      }
    },
    cellarCuts: enterable.flatMap((entry) => entry.cuts),
    enterable,
    floorAt(x, z, feet) {
      let best: number | null = null;
      for (const { house, interior, reach } of enterable) {
        const dx = x - house.x;
        const dz = z - house.z;
        if (dx * dx + dz * dz > reach * reach) continue;
        // Into the model's own space: the inverse of its placement's turn.
        const rx = house.frontZ;
        const rz = -house.frontX;
        const local = interiorFloorAt(interior, rx * dx + rz * dz, house.frontX * dx + house.frontZ * dz, feet - house.y, STEP_UP);
        if (local !== null && (best === null || house.y + local > best)) best = house.y + local;
      }
      return best;
    },
  };
}

/** A house's interior as the world needs it: its rooms, and the ground over its cellars. */
function enterableOf(house: Placed, interior: BuiltInterior, reach: number): Enterable {
  const rx = house.frontZ;
  const rz = -house.frontX;
  const { X0, Z0, tile } = interior;
  const cuts = interior.layout.rooms
    .filter((room) => room.base < 0)
    .map((room): TerrainCut => {
      const x0 = X0 + room.rect.i0 * tile + WALL;
      const x1 = X0 + room.rect.i1 * tile - WALL;
      const z0 = Z0 + room.rect.j0 * tile + WALL;
      const z1 = Z0 + room.rect.j1 * tile - WALL;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      return { x: house.x + rx * cx + house.frontX * cz, z: house.z + rz * cx + house.frontZ * cz, ux: rx, uz: rz, halfWidth: (x1 - x0) / 2, halfDepth: (z1 - z0) / 2 };
    });
  return { house, interior, reach, cuts };
}
