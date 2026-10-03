import { Mesh, VertexData, type CascadedShadowGenerator, type Scene } from "@babylonjs/core";
import type { LitShading } from "../materials/litShading";
import type { House, SettlementLayout } from "./settlementLayout";
import type { BuildingModel } from "../buildings/buildingTypes";
import { generateBuilding } from "../buildings/buildingGenerator";
import { createBuildingMaterial } from "../buildings/buildingMesh";

export interface SettlementRenderer {
  setDrawDistance: (distance: number) => void;
}

interface Builder {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

/**
 * One house: its building's model, turned to face its street and stood on its plot. The model's
 * front (+z) turns to the house's front and its +x to the right of that, seen from the street.
 * Positions are relative to the settlement's origin (ox, oz), so each settlement's mesh keeps its
 * numbers small.
 */
function addHouse(b: Builder, house: House, model: BuildingModel, ox: number, oz: number): void {
  const fx = house.frontX;
  const fz = house.frontZ;
  // A rotation (not a mirror): +x goes to (fz, -fx) when +z goes to (fx, fz).
  const rx = fz;
  const rz = -fx;
  const cx = house.x - ox;
  const cz = house.z - oz;
  const base = b.positions.length / 3;
  const p = model.positions;
  const n = model.normals;
  for (let i = 0; i < p.length; i += 3) {
    b.positions.push(cx + rx * p[i] + fx * p[i + 2], house.y + p[i + 1], cz + rz * p[i] + fz * p[i + 2]);
    b.normals.push(rx * n[i] + fx * n[i + 2], n[i + 1], rz * n[i] + fz * n[i + 2]);
  }
  for (const c of model.colors) b.colors.push(c);
  for (const index of model.indices) b.indices.push(base + index);
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
  litShading: LitShading,
  shadowGenerator: CascadedShadowGenerator,
  initialDrawDistance: number,
): SettlementRenderer {
  const material = createBuildingMaterial(scene, litShading);

  const meshes: { mesh: Mesh; x: number; z: number; radius: number }[] = [];
  for (const layout of layouts) {
    if (layout.houses.length === 0) continue;
    const builder: Builder = { positions: [], normals: [], colors: [], indices: [] };
    for (const house of layout.houses) addHouse(builder, house, generateBuilding(house.building, seed, house.variant), layout.x, layout.z);
    const mesh = new Mesh(`settlement_${layout.siteId}`, scene);
    const data = new VertexData();
    data.positions = builder.positions;
    data.normals = builder.normals;
    data.colors = builder.colors;
    data.indices = builder.indices;
    data.applyToMesh(mesh);
    mesh.position.set(layout.x, 0, layout.z);
    mesh.material = material;
    mesh.isPickable = false;
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
