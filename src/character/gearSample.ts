import { TEXTURE_RESOLUTION } from "../world/materials/textureGen";
import type { BakedGearMaterial } from "./gearMaterial";

// Apart from gearMaterial.ts, which reaches the bake pool, so a worker can sample a material too.

/** The material's colour at (x, y) metres across the surface, 0-1 a channel, tiling. */
export function sampleGearMaterial(material: BakedGearMaterial, x: number, y: number): [number, number, number] {
  const n = TEXTURE_RESOLUTION;
  const px = ((Math.floor((x / material.def.size) * n) % n) + n) % n;
  const py = ((Math.floor((y / material.def.size) * n) % n) + n) % n;
  const o = (py * n + px) * 4;
  return [material.color[o] / 255, material.color[o + 1] / 255, material.color[o + 2] / 255];
}
