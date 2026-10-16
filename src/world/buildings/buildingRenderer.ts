import type { Mesh, CascadedShadowGenerator, Scene } from "@babylonjs/core";
import { appendModel, applyLightmap, createBuildingMesh, emptyGeometry, type BuildingMaterial } from "./buildingMesh";
import { createLightBakePool } from "../lighting/lightBakePool";
import type { ModelLight } from "./buildingTypes";
// Placing buildings - their collision, floors and cellars - is the simulation's too, and lives where
// it can reach it without Babylon.
import { createPlacedBuildings, placedAxes, type BuildingGroup, type ModelledGroup, type Placed, type PlacedBuildings, type TerrainCut } from "./buildingCollision";

type House = Placed;

/**
 * Where a house's model goes: turned to face its street and stood on its plot. The model's front
 * (+z) turns to the house's front and its +x to the right of that, seen from the street. Positions
 * are relative to (ox, oz) - the house's own spot, where its mesh stands - so they stay small; a
 * direction is only turned.
 */
function placeHouse(house: House, ox: number, oz: number) {
  // A rotation (not a mirror): +x goes to (fz, -fx) when +z goes to (fx, fz) - tipped to its up.
  const a = placedAxes(house);
  const cx = house.x - ox;
  const cz = house.z - oz;
  return (x: number, y: number, z: number, direction: boolean): [number, number, number] => {
    const p: [number, number, number] = [a.x.x * x + a.y.x * y + a.z.x * z, a.x.y * x + a.y.y * y + a.z.y * z, a.x.z * x + a.y.z * y + a.z.z * z];
    return direction ? p : [cx + p[0], house.y + p[1], cz + p[2]];
  };
}

export interface BuildingRenderer extends PlacedBuildings {
  setDrawDistance: (distance: number) => void;
  /** The houses' own lights (see LIGHTS.md) whose reach a point is in, in the world's space. */
  lightsNear: (x: number, y: number, z: number) => ModelLight[];
  /** Every group with its near models - what a server in the same page takes rather than making
   *  them again (see SIMULATION.md). */
  readonly models: readonly ModelledGroup[];
}

/** Cellars within this far of the camera have the ground taken out over them. */
const CUT_DISTANCE = 160;

/** Past this far from a house (metres, from its own edge) it is drawn with its small details left
 *  out (see generateBuilding's `far`). */
const FAR_DETAIL_DISTANCE = 220;

/**
 * Draws the buildings of every settlement and compound - and a compound's props - each its own mesh, shown while it is within
 * the draw distance - in full near, and with its small details left out from FAR_DETAIL_DISTANCE on.
 * Each house is its building's own model (see buildings/), the same the workbench shows. Houses cast
 * shadows (they are few and large - nothing like grass) and are lit through the shared lighting,
 * like the ground they stand on.
 */
export function createBuildingRenderer(
  scene: Scene,
  groups: BuildingGroup[],
  material: BuildingMaterial,
  shadowGenerator: CascadedShadowGenerator,
  initialDrawDistance: number,
  setTerrainCuts: (cuts: TerrainCut[]) => void,
): BuildingRenderer {
  /** Each house's meshes - and its lights, placed as its near mesh is, until they are baked (see
   *  LIGHTS.md): asked for the first time its near model is shown. */
  const meshes: { near: Mesh; far: Mesh; x: number; z: number; reach: number; lights: ModelLight[] | null }[] = [];
  const lightBakes = createLightBakePool();
  /** Every house's lights in the world's own space, for what moves among them (the player). */
  const worldLights: { x: number; z: number; reach: number; lights: ModelLight[] }[] = [];
  /** Each group's near models, which its collision, floors and cellars are made from. */
  const modelled: ModelledGroup[] = [];
  for (const group of groups) {
    if (group.houses.length === 0) continue;
    const houses: ModelledGroup["houses"] = [];
    group.houses.forEach((house, n) => {
      let lights: ModelLight[] | null = null;
      const build = (far: boolean): { mesh: Mesh; reach: number } => {
        const model = house.model(far);
        if (!far) houses.push({ house, model });
        const geometry = emptyGeometry();
        const place = placeHouse(house, house.x, house.z);
        appendModel(geometry, model, material.layerOf, place);
        if (!far && model.lights?.length) {
          lights = model.lights.map((light) => ({ ...light, position: place(...light.position, false), facing: light.facing && place(...light.facing, true) }));
        }
        const reach = Math.hypot(model.halfWidth, model.halfDepth);
        const mesh = createBuildingMesh(scene, `${group.key}:${n}${far ? ":far" : ""}`, geometry, material);
        mesh.position.set(house.x, 0, house.z);
        mesh.freezeWorldMatrix();
        shadowGenerator.addShadowCaster(mesh, false);
        mesh.setEnabled(false);
        return { mesh, reach };
      };
      const near = build(false);
      const far = build(true);
      meshes.push({ near: near.mesh, far: far.mesh, x: house.x, z: house.z, reach: near.reach, lights });
      const placed = lights as ModelLight[] | null;
      if (placed) worldLights.push({ x: house.x, z: house.z, reach: near.reach, lights: placed.map((light) => ({ ...light, position: [light.position[0] + house.x, light.position[1], light.position[2] + house.z] })) });
    });
    modelled.push({ key: group.key, x: group.x, z: group.z, houses });
  }
  const placedBuildings = createPlacedBuildings(modelled);
  const { enterable } = placedBuildings;

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
      if (shown && near && entry.lights) bakeLights(entry);
    }
  });

  /** A house's lights baked in a worker from its near mesh's own vertices, and laid onto it when
   *  they come back - the nearest house first. */
  function bakeLights(entry: (typeof meshes)[number]): void {
    const lights = entry.lights!;
    entry.lights = null;
    const mesh = entry.near;
    const data = (kind: string): Float32Array => Float32Array.from(mesh.getVerticesData(kind) ?? []);
    const request = {
      positions: data("position"),
      normals: data("normal"),
      indices: Uint32Array.from(mesh.getIndices() ?? []),
      layers: data("layer"),
      casts: material.castsByLayer,
      lights,
    };
    const priority = (): number => {
      const camera = scene.activeCamera;
      return camera ? Math.hypot(entry.x - camera.position.x, entry.z - camera.position.z) : 0;
    };
    lightBakes
      .bake(request, priority)
      .then((baked) => {
        if (!mesh.isDisposed()) applyLightmap(scene, mesh, baked);
      })
      .catch((error: unknown) => console.warn("A house's lights failed to bake:", error));
  }

  return {
    ...placedBuildings,
    models: modelled,
    setDrawDistance(distance) {
      drawDistance = distance;
    },
    lightsNear(x, y, z) {
      const found: ModelLight[] = [];
      for (const house of worldLights) {
        if (Math.hypot(house.x - x, house.z - z) > house.reach + 12) continue;
        for (const light of house.lights) {
          const [lx, ly, lz] = light.position;
          if (Math.hypot(lx - x, ly - y, lz - z) < light.radius) found.push(light);
        }
      }
      return found;
    },
  };
}
