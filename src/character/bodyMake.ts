import { buildBody, type BodyGeometry } from "./bodyMesh";
import { layoutAtlas, type AtlasLayout } from "./atlas";
import { preparePaint, type PaintBase, type PaintedCover } from "./paint";
import type { BakedGearMaterial } from "./gearMaterial";
import { sided } from "./characterConsts";
import type { GearDef } from "./gearDef";
import type { RaceDef, Sex } from "./raceDef";
import { paintPieceTexture } from "./pieceTexturePaint";

/** What a body is built from: the race (with its sex), the gear worn, and how it is cut and painted. */
export interface BodyRecipe {
  /** The race as defined, and the sex to take of it. */
  race: RaceDef;
  sex: Sex;
  gear: GearDef[];
  smallclothes: boolean;
  /** The race's loops times this; whether its lattice applies; the atlas's size, or 0 for none. */
  detail: number;
  lattice: boolean;
  atlas: number;
}

/** The materials a recipe paints with: the linen of smallclothes and what its gear's paint names. */
export function paintMaterials(recipe: Pick<BodyRecipe, "gear" | "smallclothes">): string[] {
  const ids = new Set<string>();
  if (recipe.smallclothes) ids.add("linen");
  for (const piece of recipe.gear) {
    for (const paint of piece.paint) ids.add(paint.material);
    for (const island of Object.values(piece.texture?.islands ?? {})) ids.add(island.material);
  }
  return [...ids];
}

/** Paints the pieces' own textures (their layout is in the body already): what the gear's cloth is
 *  cut and sewn into. */
export function paintPieces(body: BodyGeometry, material: (id: string) => BakedGearMaterial | null): void {
  for (const texture of body.pieceTextures) if (!texture.pixels) texture.pixels = paintPieceTexture(texture, material);
}

/** What is painted on a body's skin: smallclothes, then each piece of gear's paint, over it. */
export function coversFor(recipe: Pick<BodyRecipe, "sex" | "gear" | "smallclothes">, race: RaceDef, body: BodyGeometry, material: (id: string) => BakedGearMaterial | null): PaintedCover[] {
  const covers: PaintedCover[] = [];
  const linen = recipe.smallclothes ? material("linen") : null;
  if (linen) {
    const hips = race.skeleton.ankle + race.skeleton.shin + race.skeleton.thigh;
    const tint: [number, number, number] = [0.86, 0.8, 0.68];
    covers.push({ material: linen, tint, span: "height", from: hips - 0.14, to: hips + 0.06, regions: ["torso", "legR", "legL"], hem: true });
    // A band over the breasts, too.
    const nipple = body.marks.find((m) => m.name === "nipple");
    if (recipe.sex === "female" && nipple) covers.push({ material: linen, tint, span: "height", from: nipple.position[1] - 0.075, to: nipple.position[1] + 0.05, regions: ["torso"], hem: true });
  }
  for (const piece of recipe.gear) {
    for (const paint of piece.paint) {
      const found = material(paint.material);
      if (found) covers.push({ material: found, tint: paint.tint, span: "along", from: paint.from, to: paint.to, regions: paint.regions.flatMap(sided), hem: paint.hem });
    }
  }
  return covers;
}

/** The whole of a body's making, with no waiting: what a worker does (bodyBuild.worker.ts). */
export function makeBody(recipe: BodyRecipe, race: RaceDef, material: (id: string) => BakedGearMaterial | null): { body: BodyGeometry; layout: AtlasLayout | null; base: PaintBase | null } {
  const body = buildBody(race, { detail: recipe.detail, lattice: recipe.lattice, gear: recipe.gear });
  paintPieces(body, material);
  if (recipe.atlas <= 0) return { body, layout: null, base: null };
  const layout = layoutAtlas(body, recipe.atlas);
  return { body, layout, base: preparePaint(body, layout, race, coversFor(recipe, race, body, material)) };
}
