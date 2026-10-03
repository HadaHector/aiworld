import type { Mesh, CascadedShadowGenerator, Scene } from "@babylonjs/core";
import type { House, SettlementLayout } from "./settlementLayout";
import { generateBuilding } from "../buildings/buildingGenerator";
import { appendModel, createBuildingMesh, emptyGeometry, type BuildingMaterial } from "../buildings/buildingMesh";

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
}

/**
 * Draws every settlement's buildings: one mesh per settlement with all its houses merged, shown
 * while the settlement is within the draw distance. Each house is its building's own model (see
 * buildings/), the same the workbench shows. Houses cast shadows (they are few and large - nothing
 * like grass) and are lit through the shared lighting, like the ground they stand on.
 */
export function createSettlementRenderer(
  scene: Scene,
  layouts: SettlementLayout[],
  seed: number,
  material: BuildingMaterial,
  shadowGenerator: CascadedShadowGenerator,
  initialDrawDistance: number,
): SettlementRenderer {
  const meshes: { mesh: Mesh; x: number; z: number; radius: number }[] = [];
  for (const layout of layouts) {
    if (layout.houses.length === 0) continue;
    const geometry = emptyGeometry();
    for (const house of layout.houses) {
      appendModel(geometry, generateBuilding(house.building, seed, house.variant), material.layerOf, placeHouse(house, layout.x, layout.z));
    }
    const mesh = createBuildingMesh(scene, `settlement_${layout.siteId}`, geometry, material);
    mesh.position.set(layout.x, 0, layout.z);
    shadowGenerator.addShadowCaster(mesh, false);
    meshes.push({ mesh, x: layout.x, z: layout.z, radius: layout.radius });
  }

  let drawDistance = initialDrawDistance;
  scene.onBeforeRenderObservable.add(() => {
    const camera = scene.activeCamera;
    if (!camera) return;
    const { x, z } = camera.position;
    for (const entry of meshes) {
      const reach = drawDistance + entry.radius;
      entry.mesh.setEnabled((entry.x - x) ** 2 + (entry.z - z) ** 2 <= reach * reach);
    }
  });

  return {
    setDrawDistance(distance) {
      drawDistance = distance;
    },
  };
}
