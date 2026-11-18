import type { Mesh, CascadedShadowGenerator, Scene } from "@babylonjs/core";
import { appendModel, applyLightmap, createBuildingMesh, emptyGeometry, setMeshFade, type BuildingMaterial } from "./buildingMesh";
import { createLightBakePool } from "../lighting/lightBakePool";
import type { ModelEffect, ModelLight } from "./buildingTypes";
import type { EffectGroup } from "../props/propEffects";
// Placing buildings - their collision, floors and cellars - is the simulation's too, and lives where
// it can reach it without Babylon.
import { createPlacedBuildings, placedAxes, shapeOf, type BuildingGroup, type ModelledGroup, type Placed, type PlacedBuildings, type TerrainCut } from "./buildingCollision";

type House = Placed;

/** A near mesh's vertices, as its lights are baked from them (see LIGHTS.md). */
interface LightBakeGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  layers: Float32Array;
}

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
  /** Every house's flames (PROP_EFFECTS.md), in the world's space. */
  readonly effectGroups: readonly EffectGroup[];
  /** Every group with its near models - what a server in the same page takes rather than making
   *  them again (see SIMULATION.md). */
  readonly models: readonly ModelledGroup[];
  /** Stops what lives outside the scene (the light bake workers); the meshes go with the scene. */
  dispose: () => void;
}

/** Cellars within this far of the camera have the ground taken out over them. */
const CUT_DISTANCE = 160;

/** Past this far from a house (metres, from its own edge) it is drawn with its small details left
 *  out (see generateBuilding's `far`). */
const FAR_DETAIL_DISTANCE = 220;

/** A prop drawn by its size (PROP_RENDERING.md) is drawn out to this many times its size (its reach
 *  or its height, metres) - at the default draw distance; the player's draw distance scales it, as
 *  the graphics quality. A candle goes in a few tens of metres, a cart or a gallows far later. */
const DISTANCE_PER_SIZE = 80;
/** The draw distance DISTANCE_PER_SIZE is at (world.ts's DEFAULT_DRAW_DISTANCE). */
const REFERENCE_DRAW_DISTANCE = 800;
/** Nothing drawn by its size goes nearer than this. */
const MIN_SIZE_CULL = 24;
/** A prop fades out over this share of how far it is drawn - at least FADE_MIN metres. */
const FADE_SHARE = 0.25;
const FADE_MIN = 4;

/** How far something is drawn: as far as its size says (scaled by the draw distance, never past
 *  it) - or, with no size, to the draw distance. */
function cullDistance(size: number | null, drawDistance: number): number {
  if (size === null) return drawDistance;
  return Math.min(drawDistance, Math.max(MIN_SIZE_CULL, DISTANCE_PER_SIZE * size * (drawDistance / REFERENCE_DRAW_DISTANCE)));
}

/** The fade before a prop's cull distance. */
function fadeOf(cull: number): { start: number; end: number } {
  return { start: cull - Math.max(FADE_MIN, cull * FADE_SHARE), end: cull };
}

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
  const meshes: {
    near: Mesh;
    /** Its far mesh - made when first wanted, for a prop drawn by its size (most never are). */
    far: Mesh | null;
    makeFar: () => Mesh;
    x: number;
    z: number;
    reach: number;
    /** How big it is (metres: its reach or its height), for one drawn by its size - or null, drawn
     *  to the draw distance. */
    size: number | null;
    /** How far it is drawn, from its edge - the draw distance, or nearer for a prop by its size. */
    cull: number;
    lights: ModelLight[] | null;
    bake: LightBakeGeometry | null;
  }[] = [];
  const lightBakes = createLightBakePool();
  /** Every house's lights in the world's own space, for what moves among them (the player). */
  const worldLights: { x: number; z: number; reach: number; lights: ModelLight[] }[] = [];
  /** Every house's flames in the world's space, and whether its near mesh is drawn (PROP_EFFECTS.md). */
  const effectGroups: EffectGroup[] = [];
  /** Each group's near models, which its collision, floors and cellars are made from. */
  const modelled: ModelledGroup[] = [];
  for (const group of groups) {
    if (group.houses.length === 0) continue;
    const houses: ModelledGroup["houses"] = [];
    group.houses.forEach((house, n) => {
      let lights: ModelLight[] | null = null;
      let bake: LightBakeGeometry | null = null;
      let nearEffects: ModelEffect[] = [];
      const build = (far: boolean): { mesh: Mesh; reach: number; height: number } => {
        const model = house.model(far);
        let height = 0;
        for (let i = 1; i < model.positions.length; i += 3) height = Math.max(height, model.positions[i]);
        if (!far) houses.push({ house, model: shapeOf(model) });
        const geometry = emptyGeometry();
        const place = placeHouse(house, house.x, house.z);
        appendModel(geometry, model, material.layerOf, place);
        if (!far && model.effects?.length) nearEffects = model.effects.map((e) => ({ ...e, position: place(...e.position, false) }));
        if (!far && model.lights?.length) {
          lights = model.lights.map((light) => ({ ...light, position: place(...light.position, false), facing: light.facing && place(...light.facing, true) }));
          // What its lights are baked from, kept until they are: the mesh keeps no CPU copy.
          bake = {
            positions: Float32Array.from(geometry.positions),
            normals: Float32Array.from(geometry.normals),
            indices: Uint32Array.from(geometry.indices),
            layers: Float32Array.from(geometry.layers),
          };
        }
        const reach = Math.hypot(model.halfWidth, model.halfDepth);
        const mesh = createBuildingMesh(scene, `${group.key}:${n}${far ? ":far" : ""}`, geometry, material);
        mesh.position.set(house.x, 0, house.z);
        mesh.freezeWorldMatrix();
        shadowGenerator.addShadowCaster(mesh, false);
        mesh.setEnabled(false);
        return { mesh, reach, height };
      };
      const near = build(false);
      const size = house.bySize ? Math.max(near.reach, near.height) : null;
      const cull = cullDistance(size, initialDrawDistance);
      const makeFar = (): Mesh => build(true).mesh;
      if (size !== null) setMeshFade(near.mesh, fadeOf(cull));
      meshes.push({ near: near.mesh, far: size === null ? makeFar() : null, makeFar, x: house.x, z: house.z, reach: near.reach, size, cull, lights, bake });
      if (nearEffects.length > 0) effectGroups.push({ effects: nearEffects.map((e) => ({ ...e, position: [e.position[0] + house.x, e.position[1], e.position[2] + house.z] })), shown: () => near.mesh.isEnabled() });
      const placed = lights as ModelLight[] | null;
      if (placed) worldLights.push({ x: house.x, z: house.z, reach: near.reach, lights: placed.map((light) => ({ ...light, position: [light.position[0] + house.x, light.position[1], light.position[2] + house.z] })) });
    });
    modelled.push({ key: group.key, x: group.x, z: group.z, houses });
  }
  const placedBuildings = createPlacedBuildings(modelled);
  const { enterable, holed } = placedBuildings;

  let drawDistance = initialDrawDistance;
  let lastCuts = "";
  scene.onBeforeRenderObservable.add(() => {
    const camera = scene.activeCamera;
    if (!camera) return;
    const { x, z } = camera.position;
    // The ground taken out over the nearest cellars.
    const cuts = [...enterable, ...holed]
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
      const shown = distance <= entry.cull;
      const near = distance <= FAR_DETAIL_DISTANCE;
      entry.near.setEnabled(shown && near);
      if (shown && !near && !entry.far) {
        entry.far = entry.makeFar();
        if (entry.size !== null) setMeshFade(entry.far, fadeOf(entry.cull));
      }
      entry.far?.setEnabled(shown && !near);
      if (shown && near && entry.lights) bakeLights(entry);
    }
  });

  /** A house's lights baked in a worker from its near mesh's own vertices, and laid onto it when
   *  they come back - the nearest house first. */
  function bakeLights(entry: (typeof meshes)[number]): void {
    const lights = entry.lights!;
    const geometry = entry.bake!;
    entry.lights = null;
    entry.bake = null;
    const mesh = entry.near;
    const request = {
      ...geometry,
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
    effectGroups,
    dispose: () => lightBakes.dispose(),
    setDrawDistance(distance) {
      drawDistance = distance;
      for (const entry of meshes) {
        entry.cull = cullDistance(entry.size, drawDistance);
        if (entry.size === null) continue;
        setMeshFade(entry.near, fadeOf(entry.cull));
        if (entry.far) setMeshFade(entry.far, fadeOf(entry.cull));
      }
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
