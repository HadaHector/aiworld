// A kit dungeon drawn (DUNGEONS.md, *Building it*): a mesh per part in the building shader - and its
// fixtures (candles, urns, the altar) in the props' shader (PROP_RENDERING.md, step 3) - each part's
// light baked on its own in the light-bake workers, fixtures and all - its own torches and its
// neighbours' that reach into it, against its own faces, which close it in but for its doorways.
import { Mesh, Vector3, type Scene } from "@babylonjs/core";
import { appendModel, createBuildingMesh, emptyGeometry, type BuildingMaterial } from "../buildings/buildingMesh";
import type { BuildingModel } from "../buildings/buildingTypes";
import { createPropMesh, propMaterialsFor } from "../props/propMesh";
import { bakeRequestOf, layLightmap, splitModel } from "../props/modelMeshes";
import type { ModelEffect, ModelLight } from "../buildings/buildingTypes";
import type { PropDef } from "../props/propTypes";
import { createLightBakePool } from "../lighting/lightBakePool";
import type { DungeonStyleDef } from "./dungeonDefs";
import { buildPartModel, lightsReaching } from "./kitMesh";
import { frameToWorld, type DungeonLayout } from "./layout";

export interface DungeonMeshes {
  readonly meshes: Mesh[];
  /** Its torches' lights in the world, to light the player by (World.setExtraLights). */
  readonly lights: ModelLight[];
  /** Its torches' and candles' flames in the world (PROP_EFFECTS.md). */
  readonly effects: ModelEffect[];
  /** Resolves once every part's light is baked and laid on it. */
  readonly baked: Promise<{ ms: number; cached: number }>;
  /** What it took: parts, triangles, the time to build them. */
  readonly stats: { parts: number; triangles: number; buildMs: number };
  dispose: () => void;
}

/**
 * Builds a layout's parts as meshes under `parent` (placed at the layout's frame), drawn with the
 * world's building shader; bakes their light, the parts nearest `near` first.
 */
export function createDungeonMeshes(
  scene: Scene,
  layout: DungeonLayout,
  style: DungeonStyleDef,
  fixture: PropDef | undefined,
  material: BuildingMaterial,
  near: () => { x: number; y: number; z: number },
  onBaked?: (done: number, total: number) => void,
  props?: (id: string) => PropDef | undefined,
): DungeonMeshes {
  const started = performance.now();
  const root = new Mesh(`dungeon:${layout.style}:${layout.seed}`, scene);
  // The layout's frame: every part is built in it, square to its axes.
  root.position.set(layout.frame.x, 0, layout.frame.z);
  root.rotation.y = layout.frame.yaw;
  root.computeWorldMatrix(true);
  root.freezeWorldMatrix();
  const models = layout.parts.map((_, i) => buildPartModel(layout, i, style, fixture, props));
  const all = models.flatMap((m) => m.lights);
  const pool = createLightBakePool();
  const meshes: Mesh[] = [];
  let triangles = 0;
  let done = 0;
  let cached = 0;
  const bakes: Promise<void>[] = [];
  const centreOf = (i: number): Vector3 => {
    const b = layout.parts[i].box;
    const w = frameToWorld(layout.frame, (b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2);
    return new Vector3(w.x, (b.min.y + b.max.y) / 2, w.z);
  };
  const reached = layout.parts.map((p) => lightsReaching(p, all));
  const total = reached.filter((r) => r.length > 0).length;
  const propMaterials = propMaterialsFor(scene, material);
  const geometryCache = new Map();
  const same = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  /** A part's meshes under the root: its main part by the building shader, its fixtures (and any
   *  face only props are made of) by the props' - `lit` by a lightmap to come. */
  const partMeshes = (name: string, model: BuildingModel, lit: boolean): { meshes: Mesh[]; parts: BuildingModel[] } => {
    const { main, props } = splitModel(model, material);
    const meshes: Mesh[] = [];
    if (main) {
      const geometry = emptyGeometry();
      appendModel(geometry, main, material.layerOf, same);
      triangles += geometry.indices.length / 3;
      meshes.push(createBuildingMesh(scene, name, geometry, material));
    }
    if (props) {
      triangles += props.indices.length / 3;
      const mesh = createPropMesh(scene, `${name}:props`, props, { x: 0, y: 0, z: 0, frontX: 0, frontZ: 1 }, propMaterials, null, geometryCache, lit) as Mesh;
      mesh.unfreezeWorldMatrix();
      meshes.push(mesh);
    }
    for (const mesh of meshes) {
      mesh.parent = root;
      mesh.computeWorldMatrix(true);
      mesh.freezeWorldMatrix();
    }
    return { meshes, parts: [main, props].filter((p): p is BuildingModel => p !== null) };
  };
  // A part's outside (an entrance's house): in sunlight with the world, not baked.
  models.forEach(({ exterior }, i) => {
    if (!exterior || exterior.indices.length === 0) return;
    meshes.push(...partMeshes(`dungeonOutside:${i}:${layout.parts[i].part.id}`, exterior, false).meshes);
  });
  models.forEach(({ model }, i) => {
    if (model.indices.length === 0 && !model.furniture) return;
    const lit = reached[i].length > 0;
    const part = partMeshes(`dungeonPart:${i}:${layout.parts[i].part.id}`, model, lit);
    meshes.push(...part.meshes);
    if (!lit) return;
    // What the bake takes: the part and its fixtures, as one.
    const { counts, ...geometry } = bakeRequestOf(part.parts, (x, y, z) => [x, y, z], material);
    const request = { ...geometry, casts: material.castsByLayer, lights: reached[i] };
    const centre = centreOf(i);
    const priority = (): number => {
      const p = near();
      return Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z);
    };
    bakes.push(
      pool.bake(request, priority).then((baked) => {
        layLightmap(scene, part.meshes, counts, baked);
        if (baked.cached) cached++;
        onBaked?.(++done, total);
      }),
    );
  });
  const buildMs = performance.now() - started;
  const baked = Promise.all(bakes).then(() => ({ ms: performance.now() - started, cached }));
  // The torches in the world, for what moves about in their light.
  const lights = all.map((light): ModelLight => {
    const w = frameToWorld(layout.frame, light.position[0], light.position[2]);
    return { ...light, position: [w.x, light.position[1], w.z] };
  });
  const effects = models.flatMap(({ model }) =>
    (model.effects ?? []).map((e): ModelEffect => {
      const w = frameToWorld(layout.frame, e.position[0], e.position[2]);
      return { ...e, position: [w.x, e.position[1], w.z] };
    }),
  );
  return {
    meshes,
    lights,
    effects,
    baked,
    stats: { parts: layout.parts.length, triangles, buildMs },
    dispose() {
      pool.dispose();
      root.dispose();
    },
  };
}
