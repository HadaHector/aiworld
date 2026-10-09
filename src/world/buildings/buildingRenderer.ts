import type { Mesh, CascadedShadowGenerator, Scene } from "@babylonjs/core";
import type { House } from "../settlements/settlementLayout";
import { generateBuilding } from "./buildingGenerator";
import { appendModel, createBuildingMesh, emptyGeometry, type BuildingMaterial } from "./buildingMesh";
import { interiorFloorAt, type BuiltInterior } from "./interiorFloors";
import { WALL } from "./interiorGeometry";
import type { TerrainCut } from "../materials/materialLibrary";
import type { BuildingCollision } from "./buildingColliders";
import { quatFromEuler, vec3, type ShapeDesc, type Vec3 } from "../collision/index";

/** A group of houses that come into the collision world together - a settlement's, a compound's -
 *  under `key`, round (x, z). */
export interface BuildingGroup {
  key: string;
  x: number;
  z: number;
  houses: House[];
}

/**
 * Where a house's model goes: turned to face its street and stood on its plot. The model's front
 * (+z) turns to the house's front and its +x to the right of that, seen from the street. Positions
 * are relative to (ox, oz) - the house's own spot, where its mesh stands - so they stay small; a
 * direction is only turned.
 */
function placeHouse(house: House, ox: number, oz: number) {
  const fx = house.frontX;
  const fz = house.frontZ;
  // A rotation (not a mirror): +x goes to (fz, -fx) when +z goes to (fx, fz).
  const rx = fz;
  const rz = -fx;
  const cx = house.x - ox;
  const cz = house.z - oz;
  return (x: number, y: number, z: number, direction: boolean): [number, number, number] =>
    direction ? [rx * x + fx * z, y, rz * x + fz * z] : [cx + rx * x + fx * z, house.y + y, cz + rz * x + fz * z];
}

export interface BuildingRenderer {
  setDrawDistance: (distance: number) => void;
  /** What one stands on inside a building at a world point - see interiorFloorAt - or null outside
   *  every building's rooms. */
  floorAt: (x: number, z: number, feet: number) => number | null;
  /**
   * Keeps the buildings of the groups near a point in a collision world and takes those further off
   * out of it - `add` and `remove` are the world's (see worldCollision.ts).
   */
  updateCollision: (x: number, z: number, add: (key: string, shapes: ShapeDesc[]) => void, remove: (key: string) => void) => void;
  /** The ground taken out over every cellar with rooms - for the ground's collision. */
  readonly cellarCuts: readonly TerrainCut[];
}

/** A group's buildings come into the collision world within this far of its edge, and go again
 *  past COLLISION_OUT. */
const COLLISION_IN = 120;
const COLLISION_OUT = 180;

/** One house's collision, in its own space, and where it stands. */
interface PlacedCollision {
  house: House;
  colliders: BuildingCollision;
}

/** A house's collision shapes in the world: turned to face its street and stood on its plot. */
function placedShapes({ house, colliders }: PlacedCollision, group: number): ShapeDesc[] {
  // Its +z turns to (frontX, frontZ), its +x to (frontZ, -frontX): a turn about y by this.
  const rotation = quatFromEuler(Math.atan2(house.frontX, house.frontZ));
  const place = (x: number, y: number, z: number): Vec3 =>
    vec3(house.x + house.frontZ * x + house.frontX * z, house.y + y, house.z - house.frontX * x + house.frontZ * z);
  const shapes: ShapeDesc[] = [];
  const b = colliders.boxes;
  for (let i = 0; i < b.length; i += 6) {
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

/** How far a step up the floor under the feet may be and still be stepped onto. */
const STEP_UP = 0.75;
/** Cellars within this far of the camera have the ground taken out over them. */
const CUT_DISTANCE = 160;

/** A house with an interior: where it stands, which way it faces, and its rooms. */
interface Enterable {
  house: House;
  interior: BuiltInterior;
  reach: number;
  /** The ground taken out over its cellars, in world space. */
  cuts: TerrainCut[];
}

/** Past this far from a house (metres, from its own edge) it is drawn with its small details left
 *  out (see generateBuilding's `far`). */
const FAR_DETAIL_DISTANCE = 220;

/**
 * Draws the buildings of every settlement and compound, each its own mesh, shown while it is within
 * the draw distance - in full near, and with its small details left out from FAR_DETAIL_DISTANCE on.
 * Each house is its building's own model (see buildings/), the same the workbench shows. Houses cast
 * shadows (they are few and large - nothing like grass) and are lit through the shared lighting,
 * like the ground they stand on.
 */
export function createBuildingRenderer(
  scene: Scene,
  groups: BuildingGroup[],
  seed: number,
  material: BuildingMaterial,
  shadowGenerator: CascadedShadowGenerator,
  initialDrawDistance: number,
  setTerrainCuts: (cuts: TerrainCut[]) => void,
): BuildingRenderer {
  const meshes: { near: Mesh; far: Mesh; x: number; z: number; reach: number }[] = [];
  const enterable: Enterable[] = [];
  /** Each group's houses' collision, from their near models. */
  const collisions: { key: string; x: number; z: number; radius: number; houses: PlacedCollision[] }[] = [];
  const inCollision = new Set<string>();
  for (const group of groups) {
    if (group.houses.length === 0) continue;
    const houses: PlacedCollision[] = [];
    let radius = 0;
    group.houses.forEach((house, n) => {
      const build = (far: boolean): { mesh: Mesh; reach: number } => {
        const model = generateBuilding(house.building, seed, house.variant, far);
        const geometry = emptyGeometry();
        appendModel(geometry, model, material.layerOf, placeHouse(house, house.x, house.z));
        const reach = Math.hypot(model.halfWidth, model.halfDepth);
        if (!far && model.interior) enterable.push(enterableOf(house, model.interior, reach));
        if (!far && model.colliders) houses.push({ house, colliders: model.colliders });
        const mesh = createBuildingMesh(scene, `${group.key}:${n}${far ? ":far" : ""}`, geometry, material);
        mesh.position.set(house.x, 0, house.z);
        mesh.freezeWorldMatrix();
        shadowGenerator.addShadowCaster(mesh, false);
        mesh.setEnabled(false);
        return { mesh, reach };
      };
      const near = build(false);
      const far = build(true);
      meshes.push({ near: near.mesh, far: far.mesh, x: house.x, z: house.z, reach: near.reach });
      radius = Math.max(radius, Math.hypot(house.x - group.x, house.z - group.z) + near.reach);
    });
    collisions.push({ key: group.key, x: group.x, z: group.z, radius, houses });
  }

  let drawDistance = initialDrawDistance;
  let lastCuts = "";
  scene.onBeforeRenderObservable.add(() => {
    const camera = scene.activeCamera;
    if (!camera) return;
    const { x, z } = camera.position;
    // The ground taken out over the nearest cellars.
    const cuts = enterable
      .map((entry) => ({ entry, distance: Math.hypot(entry.house.x - x, entry.house.z - z) - entry.reach }))
      .filter(({ entry, distance }) => entry.cuts.length > 0 && distance < CUT_DISTANCE)
      .sort((p, q) => p.distance - q.distance)
      .flatMap(({ entry }) => entry.cuts);
    const key = cuts.map((cut) => `${cut.x.toFixed(2)},${cut.z.toFixed(2)}`).join(";");
    if (key !== lastCuts) {
      lastCuts = key;
      setTerrainCuts(cuts);
    }
    for (const entry of meshes) {
      const distance = Math.hypot(entry.x - x, entry.z - z) - entry.reach;
      const shown = distance <= drawDistance;
      const near = distance <= FAR_DETAIL_DISTANCE;
      entry.near.setEnabled(shown && near);
      entry.far.setEnabled(shown && !near);
    }
  });

  return {
    setDrawDistance(distance) {
      drawDistance = distance;
    },
    updateCollision(x, z, add, remove) {
      for (const entry of collisions) {
        const distance = Math.hypot(entry.x - x, entry.z - z) - entry.radius;
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
    floorAt(x, z, feet) {
      let best: number | null = null;
      for (const { house, interior, reach } of enterable) {
        const dx = x - house.x;
        const dz = z - house.z;
        if (dx * dx + dz * dz > reach * reach) continue;
        // Into the model's own space: the inverse of placeHouse's turn.
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
function enterableOf(house: House, interior: BuiltInterior, reach: number): Enterable {
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
