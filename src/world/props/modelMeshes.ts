import type { Mesh, Scene } from "@babylonjs/core";
import { appendModel, applyLightmap, createBuildingMesh, emptyGeometry, shareLightmap, type BuildingMaterial } from "../buildings/buildingMesh";
import type { BuildingModel, ModelLight } from "../buildings/buildingTypes";
import { bakeLightmap, halfTexels } from "../lighting/lightBake";
import { createPropMesh, propMaterialsFor } from "./propMesh";

/*
 * A model drawn by two shaders (PROP_RENDERING.md, steps 3 and 4): what the building shader draws -
 * its faces of the materials in the buildings' array, and plain ones - and what the props' shader
 * draws - its furniture, and any face of a material only props are made of. The two are baked as one
 * (a table still shades the floor, the hearth still lights the chairs) and share one lightmap.
 */

/** A model's two parts, both in its own space - either may be missing. */
export interface ModelParts {
  main: BuildingModel | null;
  props: BuildingModel | null;
}

/** Splits a model for drawing - all of it to the props' shader with `allProps` (a prop). */
export function splitModel(model: BuildingModel, building: BuildingMaterial, allProps = false): ModelParts {
  const { furniture, ...own } = model;
  if (allProps) return { main: null, props: joinModels([own, furniture]) };
  const propsOnly = model.materials.map((id) => building.ownTextures.has(id));
  if (!propsOnly.some((only) => only)) return { main: hasFaces(own) ? own : null, props: furniture && hasFaces(furniture) ? furniture : null };
  const isProps = (vertex: number): boolean => {
    const slot = model.materialSlots[vertex];
    return slot >= 0 && propsOnly[slot];
  };
  const main = pickFaces(own, (a) => !isProps(a));
  const stray = pickFaces(own, (a) => isProps(a));
  return { main: hasFaces(main) ? main : null, props: joinModels([stray, furniture]) };
}

function hasFaces(model: BuildingModel): boolean {
  return model.indices.length > 0;
}

/** The faces of a model `keep` keeps (judged by a face's first corner), with just their vertices. */
function pickFaces(model: BuildingModel, keep: (firstCorner: number) => boolean): BuildingModel {
  const remap = new Map<number, number>();
  const out = blank(model);
  const I = model.indices;
  for (let t = 0; t < I.length; t += 3) {
    if (!keep(I[t])) continue;
    for (let c = 0; c < 3; c++) {
      const v = I[t + c];
      let n = remap.get(v);
      if (n === undefined) {
        n = out.positions.length / 3;
        remap.set(v, n);
        copyVertex(model, v, out, model.materialSlots[v]);
      }
      out.indices.push(n);
    }
  }
  return out;
}

/** Models laid together in one (their spaces the same), their materials joined - or null if none
 *  of them has a face. */
function joinModels(models: (BuildingModel | undefined)[]): BuildingModel | null {
  const present = models.filter((m): m is BuildingModel => !!m && hasFaces(m));
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  const out = blank(present[0]);
  for (const model of present) {
    const base = out.positions.length / 3;
    const slotOf = model.materials.map((id) => {
      let slot = out.materials.indexOf(id);
      if (slot < 0) slot = out.materials.push(id) - 1;
      return slot;
    });
    for (let v = 0; v < model.positions.length / 3; v++) {
      const slot = model.materialSlots[v];
      copyVertex(model, v, out, slot < 0 ? -1 : slotOf[slot]);
    }
    for (const index of model.indices) out.indices.push(base + index);
  }
  return out;
}

function blank(like: BuildingModel): BuildingModel {
  return { positions: [], normals: [], tangents: [], uvs: [], colors: [], materialSlots: [], materials: [...like.materials], indices: [], halfWidth: like.halfWidth, halfDepth: like.halfDepth, door: like.door, height: like.height };
}

function copyVertex(from: BuildingModel, v: number, to: BuildingModel, slot: number): void {
  to.positions.push(from.positions[v * 3], from.positions[v * 3 + 1], from.positions[v * 3 + 2]);
  to.normals.push(from.normals[v * 3], from.normals[v * 3 + 1], from.normals[v * 3 + 2]);
  to.tangents.push(from.tangents[v * 3], from.tangents[v * 3 + 1], from.tangents[v * 3 + 2]);
  to.uvs.push(from.uvs[v * 2], from.uvs[v * 2 + 1]);
  to.colors.push(from.colors[v * 4], from.colors[v * 4 + 1], from.colors[v * 4 + 2], from.colors[v * 4 + 3]);
  to.materialSlots.push(slot);
}

/** Where a model's points go (a direction: turned only) - as appendModel's `place`. */
export type Place = (x: number, y: number, z: number, direction: boolean) => [number, number, number];

/** What the light bake (its workers) takes for a model's parts, each laid by `place` into one space,
 *  and how many vertices each part has - to hand each its share of the lightmap's places back. */
export interface PartsBake {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per vertex, its material's bake layer (BuildingMaterial.bakeLayerOf) - -1 plain. */
  layers: Float32Array;
  counts: number[];
}

export function bakeRequestOf(parts: BuildingModel[], place: Place, building: BuildingMaterial): PartsBake {
  const vertices = parts.reduce((n, m) => n + m.positions.length / 3, 0);
  const triangles = parts.reduce((n, m) => n + m.indices.length, 0);
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const layers = new Float32Array(vertices);
  const indices = new Uint32Array(triangles);
  let v0 = 0;
  let i0 = 0;
  const counts: number[] = [];
  for (const model of parts) {
    const count = model.positions.length / 3;
    const layerOfSlot = model.materials.map((id) => building.bakeLayerOf.get(id) ?? -1);
    for (let v = 0; v < count; v++) {
      positions.set(place(model.positions[v * 3], model.positions[v * 3 + 1], model.positions[v * 3 + 2], false), (v0 + v) * 3);
      normals.set(place(model.normals[v * 3], model.normals[v * 3 + 1], model.normals[v * 3 + 2], true), (v0 + v) * 3);
      const slot = model.materialSlots[v];
      layers[v0 + v] = slot < 0 ? -1 : layerOfSlot[slot];
    }
    for (let i = 0; i < model.indices.length; i++) indices[i0 + i] = v0 + model.indices[i];
    v0 += count;
    i0 += model.indices.length;
    counts.push(count);
  }
  return { positions, normals, indices, layers, counts };
}

/** A bake laid onto the meshes it was made for (one per part, in the order baked): the first takes
 *  the lightmap, the rest share it - each its own share of the places on it. */
export function layLightmap(scene: Scene, meshes: Mesh[], counts: number[], baked: { width: number; height: number; half: Uint16Array; uvs: Float32Array }): void {
  let at = 0;
  meshes.forEach((mesh, i) => {
    const uvs = baked.uvs.subarray(at * 2, (at + counts[i]) * 2);
    at += counts[i];
    if (mesh.isDisposed()) return;
    if (i === 0) applyLightmap(scene, mesh, { width: baked.width, height: baked.height, half: baked.half, uvs: Float32Array.from(uvs) });
    else shareLightmap(meshes[0], mesh, Float32Array.from(uvs));
  });
}

/**
 * A model drawn where the workbench puts it (no workers: its light baked here and now): its main
 * part by the building shader, turned by `placed`'s axes and stood at its point, and its props part
 * by the props' shader, placed the same - lit by one lightmap if it has lights. The meshes, main first.
 */
export function drawModelNow(
  scene: Scene,
  name: string,
  model: BuildingModel,
  building: BuildingMaterial,
  placed: { x: number; y: number; z: number; frontX: number; frontZ: number; up?: [number, number, number] },
  turn: (x: number, y: number, z: number) => [number, number, number],
): Mesh[] {
  const { main, props } = splitModel(model, building);
  const lights: ModelLight[] = model.lights ?? [];
  const lit = lights.length > 0;
  const parts = [main, props].filter((p): p is BuildingModel => p !== null);
  const meshes: Mesh[] = [];
  if (main) {
    const geometry = emptyGeometry();
    appendModel(geometry, main, building.layerOf, (x, y, z) => turn(x, y, z));
    const mesh = createBuildingMesh(scene, name, geometry, building);
    mesh.position.set(placed.x, placed.y, placed.z);
    meshes.push(mesh);
  }
  if (props) meshes.push(createPropMesh(scene, `${name}:props`, props, placed, propMaterialsFor(scene, building), null, new Map(), lit) as Mesh);
  if (lit && parts.length > 0) {
    // One model of both parts, in the model's own space, as the bake takes it.
    const joined = { positions: [] as number[], normals: [] as number[], indices: [] as number[], materialSlots: [] as number[], materials: [] as string[] };
    for (const part of parts) {
      const base = joined.positions.length / 3;
      const slotOf = part.materials.map((id) => {
        let slot = joined.materials.indexOf(id);
        if (slot < 0) slot = joined.materials.push(id) - 1;
        return slot;
      });
      joined.positions.push(...part.positions);
      joined.normals.push(...part.normals);
      for (const slot of part.materialSlots) joined.materialSlots.push(slot < 0 ? -1 : slotOf[slot]);
      for (const index of part.indices) joined.indices.push(base + index);
    }
    const map = bakeLightmap(joined, lights, building.casts);
    layLightmap(scene, meshes, parts.map((p) => p.positions.length / 3), { width: map.width, height: map.height, half: halfTexels(map.texels), uvs: map.uvs });
  }
  return meshes;
}
