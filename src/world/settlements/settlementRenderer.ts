import type { Mesh, CascadedShadowGenerator, Scene } from "@babylonjs/core";
import type { House, SettlementLayout } from "./settlementLayout";
import { generateBuilding } from "../buildings/buildingGenerator";
import { appendModel, createBuildingMesh, emptyGeometry, type BuildingMaterial } from "../buildings/buildingMesh";
import { interiorFloorAt, type BuiltInterior } from "../buildings/interiorFloors";
import { WALL } from "../buildings/interiorGeometry";
import type { TerrainCut } from "../materials/materialLibrary";

/**
 * Where a house's model goes: turned to face its street and stood on its plot. The model's front
 * (+z) turns to the house's front and its +x to the right of that, seen from the street. Positions
 * are relative to the settlement's origin (ox, oz), so each settlement's mesh keeps its numbers
 * small; a direction is only turned.
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

export interface SettlementRenderer {
  setDrawDistance: (distance: number) => void;
  /** What one stands on inside a building at a world point - see interiorFloorAt - or null outside
   *  every building's rooms. */
  floorAt: (x: number, z: number, feet: number) => number | null;
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

/** Past this far from a settlement's edge (metres) its houses are drawn with their small details
 *  left out (see generateBuilding's `far`). */
const FAR_DETAIL_DISTANCE = 220;

/**
 * Draws every settlement's buildings: one mesh per settlement with all its houses merged, shown
 * while the settlement is within the draw distance - in full near, and with their small details
 * left out from FAR_DETAIL_DISTANCE on. Each house is its building's own model (see buildings/),
 * the same the workbench shows. Houses cast shadows (they are few and large - nothing like grass)
 * and are lit through the shared lighting, like the ground they stand on.
 */
export function createSettlementRenderer(
  scene: Scene,
  layouts: SettlementLayout[],
  seed: number,
  material: BuildingMaterial,
  shadowGenerator: CascadedShadowGenerator,
  initialDrawDistance: number,
  setTerrainCuts: (cuts: TerrainCut[]) => void,
): SettlementRenderer {
  const meshes: { near: Mesh; far: Mesh; x: number; z: number; radius: number }[] = [];
  const enterable: Enterable[] = [];
  for (const layout of layouts) {
    if (layout.houses.length === 0) continue;
    const build = (far: boolean): Mesh => {
      const geometry = emptyGeometry();
      for (const house of layout.houses) {
        const model = generateBuilding(house.building, seed, house.variant, far);
        appendModel(geometry, model, material.layerOf, placeHouse(house, layout.x, layout.z));
        if (!far && model.interior) enterable.push(enterableOf(house, model.interior, Math.hypot(model.halfWidth, model.halfDepth)));
      }
      const mesh = createBuildingMesh(scene, `settlement_${layout.siteId}${far ? "_far" : ""}`, geometry, material);
      mesh.position.set(layout.x, 0, layout.z);
      shadowGenerator.addShadowCaster(mesh, false);
      mesh.setEnabled(false);
      return mesh;
    };
    meshes.push({ near: build(false), far: build(true), x: layout.x, z: layout.z, radius: layout.radius });
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
      const distance = Math.hypot(entry.x - x, entry.z - z) - entry.radius;
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
