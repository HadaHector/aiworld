import type { IslandDef, PieceTextureDef } from "./gearDef";
import type { IslandRec } from "./meshKit";

/**
 * A piece's own texture (CHARACTERS.md, *Pieces and islands*): the islands its shells and skirts
 * are unrolled into, laid out in one square, and - once painted - its pixels. The layout needs only
 * the geometry, so bodies are built with it; the pixels are painted when the materials are baked.
 */
export interface PieceTexture {
  /** Texels a side. */
  size: number;
  /** Texels a metre, and the margin round each island, in texels. */
  density: number;
  pad: number;
  def: PieceTextureDef;
  islands: IslandPlace[];
  /** RGBA, `size`² - null until painted. */
  pixels: Uint8Array | null;
}

/** An island's place in the texture and what it is. */
export interface IslandPlace {
  /** Its name on the geometry ("sleeveR") and the recipe it is made by (`def.islands`' key). */
  name: string;
  recipe: string;
  /** The left of a pair: a recipe's `at`s are mirrored. */
  mirrored: boolean;
  /** Where its margin starts, and its size with margin, in texels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** How wide round it (the mean circumference, a little past it for the seam) and how tall, in metres. */
  widthMeters: number;
  heightMeters: number;
}

/** How far past the circumference an island reaches, for the triangles across the seam. */
const SEAM_ROOM = 1.2;
const PAD = 3;

/**
 * Lays a piece's islands out in a square - tallest first, in shelves, the smallest square that
 * holds them - and gives every triangle corner in them its place in it (`gearUVs`, replaced).
 */
export function placeIslands(def: PieceTextureDef, islands: IslandRec[], cornerIsland: number[], cornerRound: number[], cornerAlong: number[], gearUVs: number[]): PieceTexture {
  const sized = islands.map((rec) => {
    const circumference = rec.circumferences.reduce((a, b) => a + b, 0) / Math.max(1, rec.circumferences.length);
    return { widthMeters: circumference * SEAM_ROOM, heightMeters: Math.max(0.01, rec.rawMax - rec.rawMin), circumference };
  });
  const widths = sized.map((s) => Math.ceil(s.widthMeters * def.density) + 2 * PAD);
  const heights = sized.map((s) => Math.ceil(s.heightMeters * def.density) + 2 * PAD);
  let size = 64;
  let places: { x: number; y: number }[] | null = null;
  for (; size <= 2048 && !places; size *= 2) places = shelves(widths, heights, size);
  size /= 2;
  if (!places) throw new Error(`a piece's islands do not fit a 2048 texture at ${def.density} texels a metre`);

  const placed: IslandPlace[] = islands.map((rec, i) => {
    const base = islandBase(rec.name, def);
    return { name: rec.name, recipe: base.recipe, mirrored: base.mirrored, x: places![i].x, y: places![i].y, width: widths[i], height: heights[i], widthMeters: sized[i].widthMeters, heightMeters: sized[i].heightMeters };
  });
  for (let corner = 0; corner < cornerIsland.length; corner++) {
    const at = cornerIsland[corner];
    if (at < 0) continue;
    const rec = islands[at];
    const place = placed[at];
    const down = rec.down > 0 ? cornerAlong[corner] - rec.rawMin : rec.rawMax - cornerAlong[corner];
    const x = place.x + PAD + cornerRound[corner] * sized[at].circumference * def.density;
    const y = place.y + PAD + down * def.density;
    gearUVs[corner * 2] = x / size;
    gearUVs[corner * 2 + 1] = y / size;
  }
  return { size, density: def.density, pad: PAD, def, islands: placed, pixels: null };
}

/** Which recipe an island of this name is made by: its own, or - sided, with "R" or "L" after it - its base's. */
export function islandBase(name: string, def: PieceTextureDef): { recipe: string; mirrored: boolean } {
  if (def.islands[name]) return { recipe: name, mirrored: false };
  const base = name.slice(0, -1);
  if (def.islands[base]?.sided && (name.endsWith("R") || name.endsWith("L"))) return { recipe: base, mirrored: name.endsWith("L") };
  return { recipe: name, mirrored: false };
}

export function islandRecipe(texture: PieceTexture, place: IslandPlace): IslandDef | undefined {
  return texture.def.islands[place.recipe];
}

/** Shelves, tallest first: null if the rectangles do not fit. */
function shelves(widths: number[], heights: number[], size: number): { x: number; y: number }[] | null {
  const order = widths.map((_, i) => i).sort((a, b) => heights[b] - heights[a]);
  const out: { x: number; y: number }[] = new Array(widths.length);
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const i of order) {
    if (widths[i] > size) return null;
    if (x + widths[i] > size) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    if (y + heights[i] > size) return null;
    out[i] = { x, y };
    x += widths[i];
    shelf = Math.max(shelf, heights[i]);
  }
  return out;
}
