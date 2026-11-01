import type { BodyGeometry } from "./bodyMesh";
import type { AtlasLayout } from "./atlas";
import { chooseAppearance, type Appearance } from "./paint";
import type { BakedGearMaterial, GearMaterialDef } from "./gearMaterial";
import type { GearDef } from "./gearDef";
import { forSex, type RaceDef, type Sex, type Slider } from "./raceDef";
import { canonicalBody, paintedAtlas } from "./bodyCache";
import type { LookChoices } from "../sim/protocol";

/** Who a character is, as far as its body goes: everything else comes from its race and seed. */
export interface CharacterSpec {
  race: RaceDef;
  /** Its own seed: its sex, skin, hair, eyes, face and sliders. */
  seed: number;
  /** A sex instead of the seed's. */
  sex?: Sex;
  /** Slider positions instead of the seed's (0 at the race's low limit, 1 at its high one). */
  sliders?: Partial<Record<Slider, number>>;
  /** What the player chose over the seed's picks (FRONTEND.md, *Looks*). */
  choices?: LookChoices;
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
  /** Given, the work is done a few milliseconds at a time with this awaited between, so a page keeps
   *  drawing while a body is made; left out, all at once. */
  pause?: () => Promise<void>;
}

/** A character made: its body, its atlas painted, the gear materials it is drawn in baked. */
export interface DressedCharacter {
  /** The race as the character's sex has it - what the body was built from. Height and build are
   *  not in it: they are `scale`, applied to the body. */
  race: RaceDef;
  look: Appearance;
  body: BodyGeometry;
  layout: AtlasLayout | null;
  pixels: Uint8Array | null;
  baked: Map<string, BakedGearMaterial>;
  /** What to scale the body by, across, up and front to back: its height and build. */
  scale: [number, number, number];
}

/** The scale a look's height and build give a body: build is girth, across and front to back. */
export function bodyScale(look: Pick<Appearance, "height" | "build">): [number, number, number] {
  return [look.height * look.build, look.height, look.height * look.build];
}

/**
 * Makes a character's body (CHARACTERS.md): its looks from its seed, its race's body for its sex
 * dressed in its gear and painted - the body shared by every character of that race, sex and gear
 * (bodyCache.ts) - then its skin, face, hair and beard painted on it, and the gear materials baked.
 * Its height and build are the `scale` the body is drawn at, not another body. What the workbench
 * shows and the game draws.
 */
export async function dressCharacter(spec: CharacterSpec, materials: Map<string, GearMaterialDef>, worldSeed: number, options: CharacterBuildOptions = {}): Promise<DressedCharacter> {
  const look = chooseAppearance(spec.race, spec.seed, spec.sex, spec.sliders ?? {}, spec.choices ?? {});
  const race = forSex(spec.race, look.sex);
  const canon = await canonicalBody(
    { race: spec.race, sex: look.sex, gear: spec.gear, smallclothes: spec.smallclothes, detail: options.detail ?? 1, lattice: options.lattice !== false, atlas: options.atlas ?? 512 },
    race,
    materials,
    worldSeed,
    options.pause,
  );
  if (!canon.layout) return { race, look, body: canon.body, layout: null, pixels: null, baked: canon.baked, scale: bodyScale(look) };
  const pixels = await paintedAtlas(canon, look, options.pause);
  return { race, look, body: canon.body, layout: canon.layout, pixels, baked: canon.baked, scale: bodyScale(look) };
}
