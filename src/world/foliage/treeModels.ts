import { Color3, Matrix, Mesh, MeshBuilder, StandardMaterial, type Scene } from "@babylonjs/core";
import type { TreeCrown, TreeKindDef, TreeTrunk } from "./foliageConfig";
import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";

/**
 * One archetype's geometry, built in tree space: the base of the trunk sits at the origin and the
 * crown is already lifted into place, so a whole tree is one transform - position, uniform scale, a
 * spin about Y - and both meshes are driven by the same matrix. See treeField.ts.
 */
export interface TreeModel {
  trunk: Mesh;
  canopy: Mesh;
  /** The two ends of the palette a tree's tint mixes its canopy between. */
  canopyDark: Color3;
  canopyLight: Color3;
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

export function createTreeModel(scene: Scene, def: TreeKindDef): TreeModel {
  return {
    trunk: buildTrunk(scene, def.id, def.trunk),
    canopy: buildCrown(scene, def.id, def.crown),
    canopyDark: color3(def.canopyDark),
    canopyLight: color3(def.canopyLight),
  };
}
