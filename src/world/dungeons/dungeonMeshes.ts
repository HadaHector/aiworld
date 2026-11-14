// A kit dungeon drawn (DUNGEONS.md, *Building it*): a mesh per part in the building shader, each
// part's light baked on its own in the light-bake workers - its own torches and its neighbours'
// that reach into it, against its own faces, which close it in but for its doorways.
import { Mesh, Vector3, type Scene } from "@babylonjs/core";
import { appendModel, applyLightmap, createBuildingMesh, emptyGeometry, type BuildingMaterial } from "../buildings/buildingMesh";
import type { ModelLight } from "../buildings/buildingTypes";
import type { PropDef } from "../props/propTypes";
import { createLightBakePool } from "../lighting/lightBakePool";
import type { DungeonStyleDef } from "./dungeonDefs";
import { buildPartModel, lightsReaching } from "./kitMesh";
import { createCobwebMesh } from "./cobwebs";
import { frameToWorld, type DungeonLayout } from "./layout";

export interface DungeonMeshes {
  readonly meshes: Mesh[];
  /** Its torches' lights in the world, to light the player by (World.setExtraLights). */
  readonly lights: ModelLight[];
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
  models.forEach(({ model }, i) => {
    if (model.indices.length === 0) return;
    const geometry = emptyGeometry();
    appendModel(geometry, model, material.layerOf, (x, y, z) => [x, y, z]);
    triangles += geometry.indices.length / 3;
    // What the bake takes, copied before the mesh lets go of its CPU copy.
    const request = {
      positions: new Float32Array(geometry.positions),
      normals: new Float32Array(geometry.normals),
      indices: new Uint32Array(geometry.indices),
      layers: new Float32Array(geometry.layers),
      casts: material.castsByLayer,
      lights: reached[i],
    };
    const mesh = createBuildingMesh(scene, `dungeonPart:${i}:${layout.parts[i].part.id}`, geometry, material);
    mesh.parent = root;
    mesh.computeWorldMatrix(true);
    mesh.freezeWorldMatrix();
    meshes.push(mesh);
    if (reached[i].length === 0) return;
    const centre = centreOf(i);
    const priority = (): number => {
      const p = near();
      return Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z);
    };
    bakes.push(
      pool.bake(request, priority).then((baked) => {
        if (!mesh.isDisposed()) applyLightmap(scene, mesh, baked);
        if (baked.cached) cached++;
        onBaked?.(++done, total);
      }),
    );
  });
  // The cobwebs, all parts' in one mesh, lit by the fixtures near them.
  const webs = style.cobwebs ? models.flatMap((m) => m.webs) : [];
  if (style.cobwebs && webs.length > 0) {
    const mesh = createCobwebMesh(scene, `dungeonWebs:${layout.style}:${layout.seed}`, webs, all, style.light.ambient, style.cobwebs.texture);
    mesh.parent = root;
    mesh.computeWorldMatrix(true);
    mesh.freezeWorldMatrix();
    meshes.push(mesh);
  }
  const buildMs = performance.now() - started;
  const baked = Promise.all(bakes).then(() => ({ ms: performance.now() - started, cached }));
  // The torches in the world, for what moves about in their light.
  const lights = all.map((light): ModelLight => {
    const w = frameToWorld(layout.frame, light.position[0], light.position[2]);
    return { ...light, position: [w.x, light.position[1], w.z] };
  });
  return {
    meshes,
    lights,
    baked,
    stats: { parts: layout.parts.length, triangles, buildMs },
    dispose() {
      pool.dispose();
      root.dispose();
    },
  };
}
