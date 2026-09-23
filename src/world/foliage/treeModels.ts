import { Color3, Matrix, Mesh, MeshBuilder, StandardMaterial, type Scene } from "@babylonjs/core";
import type { TreeKind } from "./foliageConfig";

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

// Every archetype stands about 18 units tall, ten times the character - the proportion that makes
// walking between them feel like a wood rather than a park. They differ in what that height is
// made of, which is the whole point: a pine puts it in a narrow spire, a palm in a bare trunk with
// everything at the top.
const BROADLEAF = {
  trunkHeight: 24,
  trunkDiameterBottom: 4.9,
  trunkDiameterTop: 2.9,
  trunkSides: 12,
  trunkColour: new Color3(0.32, 0.23, 0.15),
  canopyCentreY: 33,
  canopyRadius: 20,
  /** Squashed a little, so it reads as a crown rather than a ball on a stick. */
  canopyHeightRatio: 0.82,
  canopyDark: new Color3(0.15, 0.33, 0.13),
  canopyLight: new Color3(0.38, 0.56, 0.21),
};

// Three cones of decreasing width, overlapping. One tall cone reads as a party hat; the steps
// where one tier's skirt crosses the next are what make it a conifer.
const PINE = {
  trunkHeight: 10,
  trunkDiameterBottom: 3.5,
  trunkDiameterTop: 2.8,
  trunkSides: 7,
  trunkColour: new Color3(0.28, 0.17, 0.12),
  tiers: [
    { diameter: 10.6, height: 7.5, baseY: 10 },
    { diameter: 8.6, height: 7.5, baseY: 14 },
    { diameter: 6.6, height: 7.5, baseY: 18 },
    { diameter: 4.6, height: 7.5, baseY: 22 },
  ],
  tierSides: 8,
  canopyDark: new Color3(0.09, 0.24, 0.16),
  canopyLight: new Color3(0.19, 0.38, 0.21),
};

// A bare trunk carrying everything at the top. The fronds are flattened ellipsoids swept out and
// down from the crown; seven is enough to close the silhouette from any angle without the crown
// turning into a solid disc.
const PALM = {
  trunkHeight: 23.5,
  trunkDiameterBottom: 2.0,
  trunkDiameterTop: 0.9,
  trunkSides: 8,
  trunkColour: new Color3(0.44, 0.36, 0.25),
  frondCount: 7,
  frondLength: 5.6,
  frondWidth: 1.8,
  frondThickness: 0.35,
  /** How far the root of a frond sits from the trunk's axis, before the droop is applied. */
  frondReach: 4.9,
  /** Radians the frond tips fall below horizontal. */
  frondDroop: 0.5,
  crownY: 23.2,
  canopyDark: new Color3(0.2, 0.38, 0.15),
  canopyLight: new Color3(0.44, 0.59, 0.24),
};

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

function trunkMaterial(scene: Scene, kind: TreeKind, colour: Color3): StandardMaterial {
  return foliageMaterial(scene, `tree_${kind}_trunkMaterial`, colour);
}

/** Diffuse white, because the per-instance colour buffer is what actually tints a canopy - see
 *  treeField. */
function canopyMaterial(scene: Scene, kind: TreeKind): StandardMaterial {
  return foliageMaterial(scene, `tree_${kind}_canopyMaterial`, Color3.White());
}

function buildTrunk(
  scene: Scene,
  kind: TreeKind,
  shape: { trunkHeight: number; trunkDiameterBottom: number; trunkDiameterTop: number; trunkSides: number; trunkColour: Color3 },
): Mesh {
  const trunk = MeshBuilder.CreateCylinder(
    `tree_${kind}_trunk`,
    {
      height: shape.trunkHeight,
      diameterBottom: shape.trunkDiameterBottom,
      diameterTop: shape.trunkDiameterTop,
      tessellation: shape.trunkSides,
    },
    scene,
  );
  // CreateCylinder centres on the origin; a tree is placed by the ground under its base.
  trunk.bakeTransformIntoVertices(Matrix.Translation(0, shape.trunkHeight / 2, 0));
  trunk.material = trunkMaterial(scene, kind, shape.trunkColour);
  return trunk;
}

/**
 * Welds several parts into one mesh, and so into one draw call.
 *
 * The parts of a crown never move relative to each other, so keeping them separate would only
 * multiply the draw calls by the number of tiers or fronds - a pine would cost three and a palm
 * seven, for geometry that is rigid.
 */
function weld(scene: Scene, kind: TreeKind, parts: Mesh[]): Mesh {
  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  if (!merged) throw new Error(`Could not merge the canopy parts of the ${kind} tree`);
  merged.name = `tree_${kind}_canopy`;
  // Faceted rather than smooth: low-poly geometry shaded smooth reads as balloons, shaded flat it
  // reads as stylised foliage, which is much closer to what this is standing in for.
  merged.convertToFlatShadedMesh();
  merged.material = canopyMaterial(scene, kind);
  return merged;
}

function buildBroadleaf(scene: Scene): TreeModel {
  const canopy = MeshBuilder.CreateIcoSphere("tree_broadleaf_canopy", { radius: 1, subdivisions: 2 }, scene);
  canopy.bakeTransformIntoVertices(
    Matrix.Scaling(BROADLEAF.canopyRadius, BROADLEAF.canopyRadius * BROADLEAF.canopyHeightRatio, BROADLEAF.canopyRadius).multiply(
      Matrix.Translation(0, BROADLEAF.canopyCentreY, 0),
    ),
  );
  canopy.convertToFlatShadedMesh();
  canopy.material = canopyMaterial(scene, "broadleaf");
  return {
    trunk: buildTrunk(scene, "broadleaf", BROADLEAF),
    canopy,
    canopyDark: BROADLEAF.canopyDark,
    canopyLight: BROADLEAF.canopyLight,
  };
}

function buildPine(scene: Scene): TreeModel {
  const tiers = PINE.tiers.map((tier, i) => {
    const cone = MeshBuilder.CreateCylinder(
      `tree_pine_tier${i}`,
      { height: tier.height, diameterBottom: tier.diameter, diameterTop: 0, tessellation: PINE.tierSides },
      scene,
    );
    cone.bakeTransformIntoVertices(Matrix.Translation(0, tier.baseY + tier.height / 2, 0));
    return cone;
  });
  return {
    trunk: buildTrunk(scene, "pine", PINE),
    canopy: weld(scene, "pine", tiers),
    canopyDark: PINE.canopyDark,
    canopyLight: PINE.canopyLight,
  };
}

function buildPalm(scene: Scene): TreeModel {
  const fronds: Mesh[] = [];
  for (let i = 0; i < PALM.frondCount; i++) {
    const frond = MeshBuilder.CreateIcoSphere(`tree_palm_frond${i}`, { radius: 1, subdivisions: 1 }, scene);
    // Flatten into a blade lying along +X, push it out to the end of its reach, droop it, then
    // swing it round to its share of the crown and lift the whole thing to the top of the trunk.
    frond.bakeTransformIntoVertices(
      Matrix.Scaling(PALM.frondLength, PALM.frondThickness, PALM.frondWidth)
        .multiply(Matrix.Translation(PALM.frondReach, 0, 0))
        .multiply(Matrix.RotationZ(-PALM.frondDroop))
        .multiply(Matrix.RotationY((i / PALM.frondCount) * Math.PI * 2))
        .multiply(Matrix.Translation(0, PALM.crownY, 0)),
    );
    fronds.push(frond);
  }
  return {
    trunk: buildTrunk(scene, "palm", PALM),
    canopy: weld(scene, "palm", fronds),
    canopyDark: PALM.canopyDark,
    canopyLight: PALM.canopyLight,
  };
}

const BUILDERS: Record<TreeKind, (scene: Scene) => TreeModel> = {
  broadleaf: buildBroadleaf,
  pine: buildPine,
  palm: buildPalm,
};

export function createTreeModel(scene: Scene, kind: TreeKind): TreeModel {
  return BUILDERS[kind](scene);
}
