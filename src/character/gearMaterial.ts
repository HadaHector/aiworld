import { readTexture, type PackSource } from "../world/content/resolveContent";
import { ContentError, Reader, type ContentIssue } from "../world/content/contentReader";
import { bakeMaterialTextures } from "../world/materials/textureBakePool";
import { TEXTURE_RESOLUTION, type TextureDef } from "../world/materials/textureGen";
import { characterEntries } from "./raceDef";

/**
 * A material gear is made of (gearMaterials/<id>.json5, see CHARACTERS.md): linen, leather, plate.
 * The same texture pipeline as the world's materials, but authored at a character's scale and
 * meant to be tinted: a dyeable one is near white, so a piece's tint is its colour.
 */
export interface GearMaterialDef {
  id: string;
  name: string;
  /** How many metres of body one tile of its texture covers. */
  size: number;
  /** How much it shines: 0 matte cloth, toward 1 polished steel. */
  shine: number;
  texture: TextureDef;
}

export function resolveGearMaterials(packs: PackSource[]): Map<string, GearMaterialDef> {
  const issues: ContentIssue[] = [];
  const materials = new Map<string, GearMaterialDef>();
  for (const [id, entry] of characterEntries(packs, "gearMaterials", issues)) {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["name", "size", "shine", "texture"]);
    materials.set(id, {
      id,
      name: reader.optionalString(obj, "name", "") ?? id,
      size: reader.number(obj, "size", "", { min: 0.01 }),
      shine: reader.optionalNumber(obj, "shine", "", 0.05, { min: 0, max: 1 }),
      texture: readTexture(obj.texture, reader, "texture"),
    });
  }
  if (issues.length > 0) throw new ContentError(issues);
  return materials;
}

/** A gear material baked: its tile's colours, RGBA (roughness in alpha), TEXTURE_RESOLUTION a side. */
export interface BakedGearMaterial {
  def: GearMaterialDef;
  color: Uint8Array;
  normal: Uint8Array;
}

const baked = new Map<string, Promise<BakedGearMaterial>>();

/** Bakes a gear material, once per seed and definition however often it is asked for. */
export function bakeGearMaterial(seed: number, def: GearMaterialDef): Promise<BakedGearMaterial> {
  const key = `${seed}|${def.id}|${JSON.stringify(def.texture)}`;
  let found = baked.get(key);
  if (!found) {
    const layer = TEXTURE_RESOLUTION * TEXTURE_RESOLUTION * 4;
    const color = new Uint8Array(layer);
    const normal = new Uint8Array(layer);
    found = bakeMaterialTextures([{ id: `gear-${def.id}`, texture: def.texture }], seed, color, normal).then(() => ({ def, color, normal }));
    baked.set(key, found);
  }
  return found;
}

/** The material's colour at (x, y) metres across the surface, 0-1 a channel, tiling. */
export function sampleGearMaterial(material: BakedGearMaterial, x: number, y: number): [number, number, number] {
  const n = TEXTURE_RESOLUTION;
  const px = ((Math.floor((x / material.def.size) * n) % n) + n) % n;
  const py = ((Math.floor((y / material.def.size) * n) % n) + n) % n;
  const o = (py * n + px) * 4;
  return [material.color[o] / 255, material.color[o + 1] / 255, material.color[o + 2] / 255];
}
