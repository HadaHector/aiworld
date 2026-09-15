import { Color3, MeshBuilder, StandardMaterial, type Mesh, type Scene } from "@babylonjs/core";
import { SEA_LEVEL } from "../cells/areaField";

export interface OceanOptions {
  size: number;
}

/** A flat, semi-transparent water plane at sea level. No textures, no physics — purely visual. */
export function createOceanPlane(scene: Scene, options: OceanOptions): Mesh {
  const ocean = MeshBuilder.CreateGround("ocean", { width: options.size, height: options.size, subdivisions: 1 }, scene);
  ocean.position.y = SEA_LEVEL;
  ocean.isPickable = false;

  const material = new StandardMaterial("oceanMaterial", scene);
  material.diffuseColor = new Color3(0.09, 0.32, 0.45);
  material.specularColor = new Color3(0.2, 0.25, 0.3);
  material.alpha = 0.75;
  ocean.material = material;

  return ocean;
}
