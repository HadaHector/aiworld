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
import type { BoulderShape, BushShape, PrimitiveTree, TreeCrown, TreeKindDef, TreeTrunk } from "./foliageConfig";
import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";
import { LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS, type LitShading } from "../materials/litShading";
import { deriveSeed } from "../rng";
import { generateBush, generateConifer, generateTree, type TreeDetail, type TreeGeometry } from "./treeGenerator";
import { FOLIAGE_TEXTURE_SIZE, bakeBushFoliage, bakeConiferFoliage, bakeFoliage } from "./treeTextures";
import { TEXTURE_RESOLUTION } from "../materials/textureGen";
import { BARK_FRAGMENT_SHADER, BARK_VERTEX_SHADER, LEAF_FRAGMENT_SHADER, LEAF_VERTEX_SHADER, ROCK_FRAGMENT_SHADER, ROCK_VERTEX_SHADER } from "./treeShaders";
import { generateBoulder } from "./boulderGenerator";
import type { ColorMatrix } from "../materials/colorAdjust";

/**
 * One archetype's geometry, built in tree space: the base of the trunk sits at the origin and the
 * crown is already lifted into place, so a whole tree is one transform - position, uniform scale, a
 * spin about Y - and both meshes are driven by the same matrix. See treeField.ts.
 */
export interface TreeModel {
  /** None for a bush, which is all leaves, or a boulder, which is all stone. */
  trunk?: Mesh;
  /** The leaves - or a boulder's stone. */
  canopy: Mesh;
  /** A cheaper model of the same tree for distant chunks, if the kind has one. */
  far?: TreeModel;
  /** The two ends of the palette a tree's tint mixes its canopy between. */
  tintDark: Color3;
  tintLight: Color3;
  /** Whether its materials read the tree tint table (treeShaders.ts) - generated trees and bushes
   *  do; a primitive tree's plain canopy is recoloured through its instance colour instead. */
  shaderTint: boolean;
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
    shaderTint: false,
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

/** A tree kind's bark - or a boulder's stone - baked from its texture graph like a ground material
 *  (see textureGen.ts): colour with roughness in alpha, and a normal map with height in alpha. */
export interface BakedBark {
  color: Uint8Array;
  normal: Uint8Array;
}

/**
 * The material every leaf card of one kind is drawn with: its atlas, cut out, lit as a crown and
 * swaying in the wind - more the higher a card is up to `swayHeight`, so a plant's base stays put.
 */
function createLeafMaterial(scene: Scene, id: string, atlasPixels: Uint8Array, swayHeight: number, litShading: LitShading): LeafMaterial {
  const atlas = RawTexture.CreateRGBATexture(atlasPixels, FOLIAGE_TEXTURE_SIZE, FOLIAGE_TEXTURE_SIZE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  atlas.wrapU = Texture.CLAMP_ADDRESSMODE;
  atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
  atlas.hasAlpha = true;

  Effect.ShadersStore["treeLeafVertexShader"] = LEAF_VERTEX_SHADER;
  Effect.ShadersStore["treeLeafFragmentShader"] = LEAF_FRAGMENT_SHADER;
  const leaves = new LeafMaterial(`tree_${id}_leaves`, scene, "treeLeaf", {
    attributes: ["position", "normal", "uv", "lie"],
    uniforms: ["world", "view", "viewProjection", "time", "windDirection", "treeHeight", ...LIT_SHADING_UNIFORMS],
    samplers: ["leafAtlas", "treeTints", ...LIT_SHADING_SAMPLERS],
    needAlphaTesting: true,
  });
  leaves.alphaTexture = atlas;
  leaves.setTexture("leafAtlas", atlas);
  leaves.setVector2("windDirection", WIND_DIRECTION);
  leaves.setFloat("treeHeight", swayHeight);
  leaves.backFaceCulling = false;
  litShading.register(leaves);
  const start = performance.now();
  scene.onBeforeRenderObservable.add(() => leaves.setFloat("time", (performance.now() - start) / 1000));
  return leaves;
}

/** A seed of a kind's own, from its id, so each kind's variants and atlas are its own. */
function kindSeed(seed: number, id: string): number {
  return deriveSeed(seed, [...id].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7));
}

/** A generated tree's two materials: its baked bark, and its leaves from `atlasPixels`. */
function createWoodAndLeafMaterials(
  scene: Scene,
  id: string,
  bakedBark: BakedBark,
  atlasPixels: Uint8Array | null,
  swayHeight: number,
  litShading: LitShading,
): { bark: ShaderMaterial; leaves: LeafMaterial | null } {
  const barkColor = RawTexture.CreateRGBATexture(bakedBark.color, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  const barkNormal = RawTexture.CreateRGBATexture(bakedBark.normal, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  for (const texture of [barkColor, barkNormal]) {
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
  }
  Effect.ShadersStore["treeBarkVertexShader"] = BARK_VERTEX_SHADER;
  Effect.ShadersStore["treeBarkFragmentShader"] = BARK_FRAGMENT_SHADER;

  const bark = new ShaderMaterial(`tree_${id}_bark`, scene, "treeBark", {
    attributes: ["position", "normal", "uv", "axis"],
    uniforms: ["world", "view", "viewProjection", ...LIT_SHADING_UNIFORMS],
    samplers: ["barkColor", "barkNormal", "treeTints", ...LIT_SHADING_SAMPLERS],
  });
  bark.setTexture("barkColor", barkColor);
  bark.setTexture("barkNormal", barkNormal);
  // Limbs are closed tubes wound clockwise from outside (treeGenerator.ts's WoodBuilder), so their
  // insides are culled - a camera inside a trunk sees through it, and no wood is drawn twice. A
  // limb's open end is always buried in the trunk or the ground.
  bark.backFaceCulling = true;
  litShading.register(bark);

  const leaves = atlasPixels ? createLeafMaterial(scene, id, atlasPixels, swayHeight, litShading) : null;
  return { bark, leaves };
}

/** How a generated kind makes one of its trees, and the atlas its leaves are cut from - none for
 *  a bare tree. */
interface GeneratedKind {
  variants: number;
  atlas: (seed: number) => Uint8Array | null;
  swayHeight: number;
  generate: (seed: number, detail: TreeDetail) => TreeGeometry;
}

function generatedKind(shape: Extract<TreeKindDef["shape"], { model: "branching" | "conifer" }>): GeneratedKind {
  if (shape.model === "conifer") {
    return {
      variants: shape.variants,
      atlas: (seed) => bakeConiferFoliage(seed, shape.foliage),
      // A conifer's tiers are stiff: they sway less for their height than a broadleaf's crown.
      swayHeight: shape.trunk.height * 2.4,
      generate: (seed, detail) => generateConifer(shape, seed, detail),
    };
  }
  return {
    variants: shape.variants,
    atlas: (seed) => (shape.foliage ? bakeFoliage(seed, shape.foliage) : null),
    swayHeight: shape.trunk.height * 1.8,
    generate: (seed, detail) => generateTree(shape, seed, detail),
  };
}

/** The seed a kind's leaf atlas is baked from. */
function atlasSeed(seed: number, id: string): number {
  return deriveSeed(kindSeed(seed, id), 0x1eaf);
}

/**
 * A kind's leaf atlas, FOLIAGE_TEXTURE_SIZE² RGBA - exactly the one its models are drawn with - or
 * null for a primitive tree, which has none.
 */
export function bakeLeafAtlas(def: TreeKindDef, seed: number): Uint8Array | null {
  if (def.shape.model === "bush") return bakeBushFoliage(atlasSeed(seed, def.id), def.shape.foliage);
  if (def.shape.model === "branching" || def.shape.model === "conifer") return generatedKind(def.shape).atlas(atlasSeed(seed, def.id));
  return null;
}

function createGeneratedModels(scene: Scene, def: TreeKindDef, kind: GeneratedKind, seed: number, bakedBark: BakedBark, litShading: LitShading, atlas?: Uint8Array): TreeModel[] {
  const ownSeed = kindSeed(seed, def.id);
  const materials = createWoodAndLeafMaterials(scene, def.id, bakedBark, atlas ?? kind.atlas(atlasSeed(seed, def.id)), kind.swayHeight, litShading);
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
    // A bare tree is all wood: its wood stands in the canopy's place, where every model has a mesh.
    if (!materials.leaves) return { canopy: trunk, tintDark, tintLight, shaderTint: true };

    const canopy = new Mesh(`${name}_leaves`, scene);
    const leafData = new VertexData();
    leafData.positions = geometry.leaves.positions;
    leafData.normals = geometry.leaves.normals;
    leafData.uvs = geometry.leaves.uvs;
    leafData.indices = geometry.leaves.indices;
    leafData.applyToMesh(canopy);
    canopy.setVerticesData("lie", geometry.leaves.lie, false, 1);
    canopy.material = materials.leaves;
    // The leaves sway in the vertex shader, beyond where the vertex data alone would put them.
    const reach = geometry.height * 0.6;
    canopy.setBoundingInfo(new BoundingInfo(new Vector3(-reach, -2, -reach), new Vector3(reach, geometry.height + 2, reach)));

    return { trunk, canopy, tintDark, tintLight, shaderTint: true };
  };

  const models: TreeModel[] = [];
  for (let variant = 0; variant < kind.variants; variant++) {
    const variantSeed = deriveSeed(ownSeed, variant + 1);
    const detailed = (detail: TreeDetail): TreeModel => build(kind.generate(variantSeed, detail), `tree_${def.id}_${variant}_${detail}`);
    models.push({ ...detailed("near"), far: detailed("far") });
  }
  return models;
}

/** One leaf-only model per variant, all sharing the kind's atlas and material. */
function createBushModels(scene: Scene, def: TreeKindDef, shape: BushShape, seed: number, litShading: LitShading, atlas?: Uint8Array): TreeModel[] {
  const ownSeed = kindSeed(seed, def.id);
  // Swaying to a fraction of what a tree's crown does: a bush is stiff, and low.
  const leaves = createLeafMaterial(scene, def.id, atlas ?? bakeBushFoliage(atlasSeed(seed, def.id), shape.foliage), shape.height[1] * 2.2, litShading);
  const tintDark = color3(def.tint[0]);
  const tintLight = color3(def.tint[1]);

  const models: TreeModel[] = [];
  for (let variant = 0; variant < shape.variants; variant++) {
    const geometry = generateBush(shape, deriveSeed(ownSeed, variant + 1));
    const canopy = new Mesh(`bush_${def.id}_${variant}`, scene);
    const data = new VertexData();
    data.positions = geometry.leaves.positions;
    data.normals = geometry.leaves.normals;
    data.uvs = geometry.leaves.uvs;
    data.indices = geometry.leaves.indices;
    data.applyToMesh(canopy);
    canopy.setVerticesData("lie", geometry.leaves.lie, false, 1);
    canopy.material = leaves;
    const reach = shape.width[1] * 0.7;
    canopy.setBoundingInfo(new BoundingInfo(new Vector3(-reach, -1, -reach), new Vector3(reach, geometry.height + 1, reach)));
    models.push({ canopy, tintDark, tintLight, shaderTint: true });
  }
  return models;
}

/** A baked colour texture through a colour matrix, alpha (roughness) left as it is. */
function recoloured(pixels: Uint8Array, m: ColorMatrix): Uint8Array {
  if (m.every((v, i) => v === (i % 4 === 0 ? 1 : 0))) return pixels;
  const out = new Uint8Array(pixels);
  const clamped = new Uint8ClampedArray(out.buffer);
  for (let i = 0; i < out.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    clamped[i] = m[0] * r + m[1] * g + m[2] * b;
    clamped[i + 1] = m[3] * r + m[4] * g + m[5] * b;
    clamped[i + 2] = m[6] * r + m[7] * g + m[8] * b;
  }
  return out;
}

/** One model per variant - a near one and a far one each - all drawn with the kind's stone. */
function createBoulderModels(scene: Scene, def: TreeKindDef, shape: BoulderShape, seed: number, stone: BakedBark, litShading: LitShading): TreeModel[] {
  const stoneColor = RawTexture.CreateRGBATexture(recoloured(stone.color, shape.stone.adjust), TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  const stoneNormal = RawTexture.CreateRGBATexture(stone.normal, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  for (const texture of [stoneColor, stoneNormal]) {
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
  }
  Effect.ShadersStore["treeRockVertexShader"] = ROCK_VERTEX_SHADER;
  Effect.ShadersStore["treeRockFragmentShader"] = ROCK_FRAGMENT_SHADER;
  const material = new ShaderMaterial(`rock_${def.id}`, scene, "treeRock", {
    attributes: ["position", "normal"],
    uniforms: ["world", "view", "viewProjection", "stoneTile", ...LIT_SHADING_UNIFORMS],
    samplers: ["stoneColor", "stoneNormal", "treeTints", ...LIT_SHADING_SAMPLERS],
  });
  material.setTexture("stoneColor", stoneColor);
  material.setTexture("stoneNormal", stoneNormal);
  material.setFloat("stoneTile", shape.stone.tile);
  litShading.register(material);

  const ownSeed = kindSeed(seed, def.id);
  const tintDark = color3(def.tint[0]);
  const tintLight = color3(def.tint[1]);
  const models: TreeModel[] = [];
  for (let variant = 0; variant < shape.variants; variant++) {
    const variantSeed = deriveSeed(ownSeed, variant + 1);
    const detailed = (detail: TreeDetail): TreeModel => {
      const geometry = generateBoulder(shape, variantSeed, detail);
      const canopy = new Mesh(`rock_${def.id}_${variant}_${detail}`, scene);
      const data = new VertexData();
      data.positions = geometry.positions;
      data.normals = geometry.normals;
      data.indices = geometry.indices;
      data.applyToMesh(canopy);
      canopy.material = material;
      return { canopy, tintDark, tintLight, shaderTint: true };
    };
    models.push({ ...detailed("near"), far: detailed("far") });
  }
  return models;
}

/**
 * Every model a tree kind is drawn with: one for a primitive tree, one per variant for a branching
 * one, a bush or a boulder, each a different plant generated from the same description.
 *
 * `atlas` is the kind's leaf atlas if it has already been baked (see bakeLeafAtlas) - the
 * workbench keeps its bakes - and is baked here otherwise.
 */
export function createTreeModels(scene: Scene, def: TreeKindDef, seed: number, bakedBark: BakedBark | undefined, litShading: LitShading, atlas?: Uint8Array): TreeModel[] {
  if (def.shape.model === "bush") return createBushModels(scene, def, def.shape, seed, litShading, atlas);
  if (def.shape.model === "boulder") {
    if (!bakedBark) throw new Error(`Boulder kind "${def.id}" has no baked stone`);
    return createBoulderModels(scene, def, def.shape, seed, bakedBark, litShading);
  }
  if (def.shape.model === "branching" || def.shape.model === "conifer") {
    if (!bakedBark) throw new Error(`Tree kind "${def.id}" has no baked bark`);
    return createGeneratedModels(scene, def, generatedKind(def.shape), seed, bakedBark, litShading, atlas);
  }
  return [createPrimitiveModel(scene, def, def.shape)];
}
