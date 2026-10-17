import { buildBody, type BodyGeometry } from "./bodyMesh";
import { layoutAtlas, type AtlasLayout } from "./atlas";
import { chooseAppearance, paintAtlas, type Appearance, type PaintedCover } from "./paint";
import { bakeGearMaterial, type BakedGearMaterial, type GearMaterialDef } from "./gearMaterial";
import { sided, type GearDef } from "./gearDef";
import { forSex, withLook, type RaceDef, type Sex, type Slider } from "./raceDef";

/** Who a character is, as far as its body goes: everything else comes from its race and seed. */
export interface CharacterSpec {
  race: RaceDef;
  /** Its own seed: its sex, skin, hair, eyes, face and sliders. */
  seed: number;
  /** A sex instead of the seed's. */
  sex?: Sex;
  /** Slider positions instead of the seed's (0 at the race's low limit, 1 at its high one). */
  sliders?: Partial<Record<Slider, number>>;
  /** The gear worn, in order: later pieces paint over earlier ones. */
  gear: GearDef[];
  /** Linen smallclothes painted on under the gear. */
  smallclothes: boolean;
}

export interface CharacterBuildOptions {
  /** The race's loops per bone times this. */
  detail?: number;
  lattice?: boolean;
  /** The atlas's size in texels a side, or 0 for none (the skin's colour alone). */
  atlas?: number;
}

/** A character made: its body, its atlas painted, the gear materials it is drawn in baked. */
export interface DressedCharacter {
  /** The race as the character's sliders and sex have it - what the body was built from. */
  race: RaceDef;
  look: Appearance;
  body: BodyGeometry;
  layout: AtlasLayout | null;
  pixels: Uint8Array | null;
  baked: Map<string, BakedGearMaterial>;
}

/**
 * Makes a character's body (CHARACTERS.md): its looks from its seed, its race shaped by its sliders
 * and sex, the body and its gear built, the atlas painted - skin, face, smallclothes, the gear's
 * paint - and the gear materials baked. What the workbench shows and the game draws.
 */
export async function dressCharacter(spec: CharacterSpec, materials: Map<string, GearMaterialDef>, worldSeed: number, options: CharacterBuildOptions = {}): Promise<DressedCharacter> {
  const look = chooseAppearance(spec.race, spec.seed, spec.sex, spec.sliders ?? {});
  const race = forSex(withLook(spec.race, look.height, look.build), look.sex);
  const body = buildBody(race, { detail: options.detail, lattice: options.lattice, gear: spec.gear, skin: look.skin });
  const baked = new Map<string, BakedGearMaterial>();
  const bake = async (id: string): Promise<BakedGearMaterial | null> => {
    const def = materials.get(id);
    if (!def) return null;
    if (!baked.has(id)) baked.set(id, await bakeGearMaterial(worldSeed, def));
    return baked.get(id)!;
  };
  for (const layer of body.layers) await bake(layer.material);
  const size = options.atlas ?? 512;
  if (size <= 0) return { race, look, body, layout: null, pixels: null, baked };

  const layout = layoutAtlas(body, size);
  const covers: PaintedCover[] = [];
  const linen = spec.smallclothes ? await bake("linen") : null;
  if (linen) {
    const hips = race.skeleton.ankle + race.skeleton.shin + race.skeleton.thigh;
    const tint: [number, number, number] = [0.86, 0.8, 0.68];
    covers.push({ material: linen, tint, span: "height", from: hips - 0.14, to: hips + 0.06, regions: ["torso", "legR", "legL"], hem: true });
    // A band over the breasts, too.
    const nipple = body.marks.find((m) => m.name === "nipple");
    if (look.sex === "female" && nipple) covers.push({ material: linen, tint, span: "height", from: nipple.position[1] - 0.075, to: nipple.position[1] + 0.05, regions: ["torso"], hem: true });
  }
  for (const piece of spec.gear) {
    for (const paint of piece.paint) {
      const material = await bake(paint.material);
      if (material) covers.push({ material, tint: paint.tint, span: "along", from: paint.from, to: paint.to, regions: paint.regions.flatMap(sided), hem: paint.hem });
    }
  }
  const pixels = paintAtlas(body, layout, race, look, covers);
  return { race, look, body, layout, pixels, baked };
}
