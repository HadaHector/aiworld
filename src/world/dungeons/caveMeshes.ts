// A field dungeon drawn (DUNGEONS.md, *Building it*): its rock meshed by caveField.ts, a mesh per
// chunk, in the cave shader (caveMaterial.ts), lit per vertex by its fixtures (caveFixtures.ts,
// caveLight.ts) - under the same DungeonMeshes face a kit's has (dungeonMeshes.ts), so the page
// treats a cave as it does a crypt.
import { Color3, Material, Mesh, StandardMaterial, VertexData, type Scene } from "@babylonjs/core";
import type { BuildingMaterial } from "../buildings/buildingMesh";
import type { MaterialDef } from "../materials/materialTypes";
import type { LitShading } from "../materials/litShading";
import type { PropDef } from "../props/propTypes";
import { createPropMesh, propMaterialsFor } from "../props/propMesh";
import { bakeRequestOf, layLightmap, splitModel } from "../props/modelMeshes";
import { createLightBakePool } from "../lighting/lightBakePool";
import type { DungeonStyleDef } from "./dungeonDefs";
import type { DungeonLayout } from "./layout";
import { layoutField, type CaveMesh } from "./caveField";
import type { DungeonMeshes } from "./dungeonMeshes";
import { createCaveMaterial } from "./caveMaterial";
import { caveFixtures } from "./caveFixtures";
import { bakeCaveLight } from "./caveLight";

/** What a cave's drawing needs of the world: its ground materials, the light every world shader
 *  shares, the props its fixtures are, and the material props are drawn over. */
export interface CaveDrawing {
  seed: number;
  materials: readonly MaterialDef[];
  lit: LitShading;
  props: (id: string) => PropDef | undefined;
  building: BuildingMaterial;
}

/** Draws a cave's rock, already meshed (the same `CaveMesh` its colliders are made from), and its fixtures. */
export async function createCaveMeshes(scene: Scene, layout: DungeonLayout, style: DungeonStyleDef, cave: CaveMesh, drawing: CaveDrawing): Promise<DungeonMeshes> {
  const started = performance.now();
  const root = new Mesh(`cave:${layout.style}:${layout.seed}`, scene);
  const shaded = await createCaveMaterial(scene, drawing.seed, style.rock, drawing.materials, drawing.lit);
  // Plain, if its materials are missing.
  let plain: StandardMaterial | null = null;
  if (!shaded) {
    plain = new StandardMaterial(`caveRockPlain:${layout.seed}`, scene);
    plain.diffuseColor = new Color3(0.45, 0.43, 0.4);
    plain.specularColor = Color3.Black();
    plain.sideOrientation = Material.ClockWiseSideOrientation;
    plain.maxSimultaneousLights = 6;
  }
  // Its fixtures, set against its rock, and their light baked into it.
  const fixtures = caveFixtures(layout, style, cave.field ?? layoutField(layout, style.noise), drawing.props);
  const baked = bakeCaveLight(cave, fixtures.lights);
  const meshes: Mesh[] = [];
  let triangles = 0;
  cave.chunks.forEach((chunk, i) => {
    const mesh = new Mesh(`caveChunk:${i}`, scene);
    const data = new VertexData();
    data.positions = chunk.positions;
    data.normals = chunk.normals;
    data.indices = chunk.indices;
    data.applyToMesh(mesh);
    const count = chunk.positions.length / 3;
    const lit = new Float32Array(count * 4);
    const given = baked.light[i];
    for (let v = 0; v < count; v++) {
      lit[v * 4] = given[v * 3];
      lit[v * 4 + 1] = given[v * 3 + 1];
      lit[v * 4 + 2] = given[v * 3 + 2];
      lit[v * 4 + 3] = 1;
    }
    mesh.setVerticesData("light", lit, false, 4);
    mesh.material = shaded?.material ?? plain;
    mesh.parent = root;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    triangles += chunk.indices.length / 3;
    meshes.push(mesh);
  });
  // The fixtures themselves, their own light baked onto them as a crypt's are (in the light-bake
  // workers): lit by one another, in the world's own frame.
  const pool = createLightBakePool();
  let bake: Promise<unknown> = Promise.resolve();
  const props = fixtures.model ? splitModel(fixtures.model, drawing.building).props : null;
  if (props) {
    const mesh = createPropMesh(scene, `caveFixtures:${layout.seed}`, props, { x: 0, y: 0, z: 0, frontX: 0, frontZ: 1 }, propMaterialsFor(scene, drawing.building), null, new Map(), true) as Mesh;
    triangles += props.indices.length / 3;
    meshes.push(mesh);
    const { counts, ...geometry } = bakeRequestOf([props], (x, y, z) => [x, y, z], drawing.building);
    bake = pool.bake({ ...geometry, casts: drawing.building.castsByLayer, lights: fixtures.lights }, () => 0).then((done) => layLightmap(scene, [mesh], counts, done));
  }
  console.info(`cave ${layout.seed}: ${cave.chunks.length} chunks, ${fixtures.lights.length} lights baked into the rock in ${baked.ms.toFixed(0)} ms (${baked.rays} rays)`);
  return {
    meshes,
    lights: fixtures.lights,
    effects: fixtures.effects,
    baked: bake.then(() => ({ ms: performance.now() - started, cached: 0 })),
    stats: { parts: layout.parts.length, triangles, buildMs: performance.now() - started + cave.stats.ms },
    dispose() {
      pool.dispose();
      for (const mesh of meshes) mesh.dispose();
      root.dispose();
      shaded?.dispose();
      plain?.dispose();
    },
  };
}
