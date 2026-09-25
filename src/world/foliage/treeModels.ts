import {
  BoundingInfo,
  Color3,
  Effect,
  Matrix,
  Mesh,
  MeshBuilder,
  RawTexture,
  ShaderMaterial,
  StandardMaterial,
  Texture,
  Vector2,
  Vector3,
  VertexData,
  type BaseTexture,
  type Scene,
} from "@babylonjs/core";
import type { BranchingTree, PrimitiveTree, TreeCrown, TreeKindDef, TreeTrunk } from "./foliageConfig";
import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";
import { LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS, type LitShading } from "../materials/litShading";
import { deriveSeed } from "../rng";
import { generateTree, type TreeDetail, type TreeGeometry } from "./treeGenerator";
import { FOLIAGE_TEXTURE_SIZE, bakeFoliage } from "./treeTextures";
import { TEXTURE_RESOLUTION } from "../materials/textureGen";
import { BARK_FRAGMENT_SHADER, BARK_VERTEX_SHADER, LEAF_FRAGMENT_SHADER, LEAF_VERTEX_SHADER } from "./treeShaders";

/**
 * One archetype's geometry, built in tree space: the base of the trunk sits at the origin and the
 * crown is already lifted into place, so a whole tree is one transform - position, uniform scale, a
 * spin about Y - and both meshes are driven by the same matrix. See treeField.ts.
 */
export interface TreeModel {
  trunk: Mesh;
  canopy: Mesh;
  /** A cheaper model of the same tree for distant chunks, if the kind has one. */
  far?: TreeModel;
  /** The two ends of the palette a tree's tint mixes its canopy between. */
  tintDark: Color3;
  tintLight: Color3;
}

/**
 * A face pointed away from the sun - a frond's underside, the far side of a canopy - is lit by
 * the scene's ambient light alone (see lighting/sunLighting.ts's HemisphericLight groundColor),
 * not by anything foliage sets up for itself, so there is nothing left to do here but turn off
 * the specular highlight a placeholder trunk or leaf would otherwise show, which just reads as
 * plastic. This used to also fake the missing bounce with a flat emissive floor, before the scene
 * light actually had a ground colour to give it one for real - see BACKLOG.md's old "foliage
 * undersides" entry.
 */
function foliageMaterial(scene: Scene, name: string, diffuse: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = diffuse;
  material.specularColor = Color3.Black();
  return material;
}

function color3(color: ColorTuple): Color3 {
  return new Color3(color[0], color[1], color[2]);
}

function trunkMaterial(scene: Scene, kind: string, colour: Color3): StandardMaterial {
  return foliageMaterial(scene, `tree_${kind}_trunkMaterial`, colour);
}

/** Diffuse white, because the per-instance colour buffer is what actually tints a canopy - see
 *  treeField. */
function canopyMaterial(scene: Scene, kind: string): StandardMaterial {
  return foliageMaterial(scene, `tree_${kind}_canopyMaterial`, Color3.White());
}

function buildTrunk(scene: Scene, kind: string, shape: TreeTrunk): Mesh {
  const trunk = MeshBuilder.CreateCylinder(
    `tree_${kind}_trunk`,
    {
      height: shape.height,
      diameterBottom: shape.diameterBottom,
      diameterTop: shape.diameterTop,
      tessellation: shape.sides,
    },
    scene,
  );
  // CreateCylinder centres on the origin; a tree is placed by the ground under its base.
  trunk.bakeTransformIntoVertices(Matrix.Translation(0, shape.height / 2, 0));
  trunk.material = trunkMaterial(scene, kind, color3(shape.color));
  return trunk;
}

/**
 * Welds several parts into one mesh, and so into one draw call.
 *
 * The parts of a crown never move relative to each other, so keeping them separate would only
 * multiply the draw calls by the number of tiers or fronds - a pine would cost three and a palm
 * seven, for geometry that is rigid.
 */
function weld(scene: Scene, kind: string, parts: Mesh[]): Mesh {
  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  if (!merged) throw new Error(`Could not merge the canopy parts of the ${kind} tree`);
  merged.name = `tree_${kind}_canopy`;
  // Faceted rather than smooth: low-poly geometry shaded smooth reads as balloons, shaded flat it
  // reads as stylised foliage, which is much closer to what this is standing in for.
  merged.convertToFlatShadedMesh();
  merged.material = canopyMaterial(scene, kind);
  return merged;
}

function buildSphereCrown(scene: Scene, kind: string, crown: Extract<TreeCrown, { builder: "sphereCrown" }>): Mesh {
  const canopy = MeshBuilder.CreateIcoSphere(`tree_${kind}_canopy`, { radius: 1, subdivisions: 2 }, scene);
  canopy.bakeTransformIntoVertices(
    Matrix.Scaling(crown.radius, crown.radius * crown.heightRatio, crown.radius).multiply(Matrix.Translation(0, crown.centreY, 0)),
  );
  canopy.convertToFlatShadedMesh();
  canopy.material = canopyMaterial(scene, kind);
  return canopy;
}

// One tall cone reads as a party hat; the steps where one tier's skirt crosses the next are what
// make it a conifer.
function buildTieredCones(scene: Scene, kind: string, crown: Extract<TreeCrown, { builder: "tieredCones" }>): Mesh {
  const tiers = crown.tiers.map((tier, i) => {
    const cone = MeshBuilder.CreateCylinder(
      `tree_${kind}_tier${i}`,
      { height: tier.height, diameterBottom: tier.diameter, diameterTop: 0, tessellation: crown.sides },
      scene,
    );
    cone.bakeTransformIntoVertices(Matrix.Translation(0, tier.baseY + tier.height / 2, 0));
    return cone;
  });
  return weld(scene, kind, tiers);
}

function buildFrondCrown(scene: Scene, kind: string, crown: Extract<TreeCrown, { builder: "frondCrown" }>): Mesh {
  const fronds: Mesh[] = [];
  for (let i = 0; i < crown.count; i++) {
    const frond = MeshBuilder.CreateIcoSphere(`tree_${kind}_frond${i}`, { radius: 1, subdivisions: 1 }, scene);
    // Flatten into a blade lying along +X, push it out to the end of its reach, droop it, then
    // swing it round to its share of the crown and lift the whole thing to the top of the trunk.
    frond.bakeTransformIntoVertices(
      Matrix.Scaling(crown.length, crown.thickness, crown.width)
        .multiply(Matrix.Translation(crown.reach, 0, 0))
        .multiply(Matrix.RotationZ(-crown.droop))
        .multiply(Matrix.RotationY((i / crown.count) * Math.PI * 2))
        .multiply(Matrix.Translation(0, crown.y, 0)),
    );
    fronds.push(frond);
  }
  return weld(scene, kind, fronds);
}

function buildCrown(scene: Scene, kind: string, crown: TreeCrown): Mesh {
  switch (crown.builder) {
    case "sphereCrown":
      return buildSphereCrown(scene, kind, crown);
    case "tieredCones":
      return buildTieredCones(scene, kind, crown);
    case "frondCrown":
      return buildFrondCrown(scene, kind, crown);
  }
}

function createPrimitiveModel(scene: Scene, def: TreeKindDef, shape: PrimitiveTree): TreeModel {
  return {
    trunk: buildTrunk(scene, def.id, shape.trunk),
    canopy: buildCrown(scene, def.id, shape.crown),
    tintDark: color3(def.tint[0]),
    tintLight: color3(def.tint[1]),
  };
}

/** Wind blows this way (x, z) - the same way it blows through the grass. */
const WIND_DIRECTION = new Vector2(0.8, 0.6).normalize();

/**
 * Leaf cards are cut out of their texture, and the shadow map has to cut them out the same way or
 * each clump would cast a square shadow. Babylon's shadow pass alpha-tests with whatever texture a
 * material hands it here, which a plain ShaderMaterial never does.
 */
class LeafMaterial extends ShaderMaterial {
  alphaTexture: BaseTexture | null = null;

  override getAlphaTestTexture(): BaseTexture | null {
    return this.alphaTexture;
  }
}

/** A tree kind's bark, baked from its texture graph like a ground material (see textureGen.ts):
 *  colour with roughness in alpha, and a normal map with height in alpha. */
export interface BakedBark {
  color: Uint8Array;
  normal: Uint8Array;
}

function createBranchingMaterials(
  scene: Scene,
  id: string,
  shape: BranchingTree,
  seed: number,
  bakedBark: BakedBark,
  litShading: LitShading,
): { bark: ShaderMaterial; leaves: LeafMaterial } {
  const barkColor = RawTexture.CreateRGBATexture(bakedBark.color, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  const barkNormal = RawTexture.CreateRGBATexture(bakedBark.normal, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  for (const texture of [barkColor, barkNormal]) {
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
  }
  const atlas = RawTexture.CreateRGBATexture(bakeFoliage(deriveSeed(seed, 0x1eaf), shape.foliage), FOLIAGE_TEXTURE_SIZE, FOLIAGE_TEXTURE_SIZE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  atlas.wrapU = Texture.CLAMP_ADDRESSMODE;
  atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
  atlas.hasAlpha = true;

  Effect.ShadersStore["treeBarkVertexShader"] = BARK_VERTEX_SHADER;
  Effect.ShadersStore["treeBarkFragmentShader"] = BARK_FRAGMENT_SHADER;
  Effect.ShadersStore["treeLeafVertexShader"] = LEAF_VERTEX_SHADER;
  Effect.ShadersStore["treeLeafFragmentShader"] = LEAF_FRAGMENT_SHADER;

  const bark = new ShaderMaterial(`tree_${id}_bark`, scene, "treeBark", {
    attributes: ["position", "normal", "uv", "axis"],
    uniforms: ["world", "view", "viewProjection", ...LIT_SHADING_UNIFORMS],
    samplers: ["barkColor", "barkNormal", ...LIT_SHADING_SAMPLERS],
  });
  bark.setTexture("barkColor", barkColor);
  bark.setTexture("barkNormal", barkNormal);
  // Limbs are closed tubes, but their winding is not worth being careful about for the few
  // back faces an open end could show.
  bark.backFaceCulling = false;
  litShading.register(bark);

  const leaves = new LeafMaterial(`tree_${id}_leaves`, scene, "treeLeaf", {
    attributes: ["position", "normal", "uv"],
    uniforms: ["world", "view", "viewProjection", "time", "windDirection", "treeHeight", ...LIT_SHADING_UNIFORMS],
    samplers: ["leafAtlas", ...LIT_SHADING_SAMPLERS],
    needAlphaTesting: true,
  });
  leaves.alphaTexture = atlas;
  leaves.setTexture("leafAtlas", atlas);
  leaves.setVector2("windDirection", WIND_DIRECTION);
  leaves.setFloat("treeHeight", shape.trunk.height * 1.8);
  leaves.backFaceCulling = false;
  litShading.register(leaves);
  const start = performance.now();
  scene.onBeforeRenderObservable.add(() => leaves.setFloat("time", (performance.now() - start) / 1000));

  return { bark, leaves };
}

function createBranchingModels(
  scene: Scene,
  def: TreeKindDef,
  shape: BranchingTree,
  seed: number,
  bakedBark: BakedBark,
  litShading: LitShading,
): TreeModel[] {
  const kindSeed = deriveSeed(seed, [...def.id].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7));
  const materials = createBranchingMaterials(scene, def.id, shape, kindSeed, bakedBark, litShading);
  const tintDark = color3(def.tint[0]);
  const tintLight = color3(def.tint[1]);

  const build = (geometry: TreeGeometry, name: string): TreeModel => {
    const trunk = new Mesh(`${name}_wood`, scene);
    const wood = new VertexData();
    wood.positions = geometry.wood.positions;
    wood.normals = geometry.wood.normals;
    wood.uvs = geometry.wood.uvs;
    wood.indices = geometry.wood.indices;
    wood.applyToMesh(trunk);
    trunk.setVerticesData("axis", geometry.wood.axes, false, 3);
    trunk.material = materials.bark;

    const canopy = new Mesh(`${name}_leaves`, scene);
    const leafData = new VertexData();
    leafData.positions = geometry.leaves.positions;
    leafData.normals = geometry.leaves.normals;
    leafData.uvs = geometry.leaves.uvs;
    leafData.indices = geometry.leaves.indices;
    leafData.applyToMesh(canopy);
    canopy.material = materials.leaves;
    // The leaves sway in the vertex shader, beyond where the vertex data alone would put them.
    const reach = geometry.height * 0.6;
    canopy.setBoundingInfo(new BoundingInfo(new Vector3(-reach, -2, -reach), new Vector3(reach, geometry.height + 2, reach)));

    return { trunk, canopy, tintDark, tintLight };
  };

  const models: TreeModel[] = [];
  for (let variant = 0; variant < shape.variants; variant++) {
    const variantSeed = deriveSeed(kindSeed, variant + 1);
    const detailed = (detail: TreeDetail): TreeModel => build(generateTree(shape, variantSeed, detail), `tree_${def.id}_${variant}_${detail}`);
    models.push({ ...detailed("near"), far: detailed("far") });
  }
  return models;
}

/**
 * Every model a tree kind is drawn with: one for a primitive tree, one per variant for a branching
 * one, each a different tree generated from the same description.
 */
export function createTreeModels(scene: Scene, def: TreeKindDef, seed: number, bakedBark: BakedBark | undefined, litShading: LitShading): TreeModel[] {
  if (def.shape.model === "branching") {
    if (!bakedBark) throw new Error(`Tree kind "${def.id}" has no baked bark`);
    return createBranchingModels(scene, def, def.shape, seed, bakedBark, litShading);
  }
  return [createPrimitiveModel(scene, def, def.shape)];
}
