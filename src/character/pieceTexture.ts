import type { IslandDef, PieceTextureDef } from "./gearDef";
import type { IslandRec } from "./meshKit";

/**
 * A piece's own texture (CHARACTERS.md, *Pieces and islands*): the islands its shells, skirts and
 * covers are unrolled into, laid out in one square, and - once painted - its pixels. The layout needs
 * only the geometry, so bodies are built with it; the pixels are painted when the materials are baked.
 *
 * An island is a pattern piece: centred, as wide round as the cloth is at each height (wide at a
 * hem, narrow at a neck), so a texel covers the same cloth everywhere and the outline is the cut.
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
  /** How wide the rectangle holds (the widest the cloth gets, with room for the seam) and how tall, in metres. */
  widthMeters: number;
  heightMeters: number;
  /** How wide round the cloth is at each `PROFILE_STEP` metres down from the top. */
  profile: number[];
  /** The edges of the panel as points in metres (across from its middle, down from its top), and
   *  the circumference at each, so a seam or hem is drawn along the real edge. */
  loops: { kind: "top" | "bottom" | "join" | "seam"; ring: boolean; points: { round: number; u: number; v: number; circumference: number }[] }[];
}

/** How much wider than its widest the rectangle is, for the triangles across the seam. */
export const SEAM_ROOM = 1.15;
const PAD = 3;
/** Metres between the profile's entries. */
export const PROFILE_STEP = 0.01;

/**
 * Lays a piece's islands out in a square - tallest first, in shelves, the smallest square that
 * holds them - and gives every triangle corner in them its place in it (`gearUVs`, replaced).
 */
export function placeIslands(def: PieceTextureDef, islands: IslandRec[], cornerIsland: number[], cornerRound: number[], cornerAlong: number[], cornerCircumference: number[], gearUVs: number[]): PieceTexture {
  const sized = islands.map((rec) => {
    const heightMeters = Math.max(0.01, rec.rawMax - rec.rawMin);
    const downOf = (raw: number): number => (rec.down > 0 ? raw - rec.rawMin : rec.rawMax - raw);
    // Widest the cloth is at each step down, and between the steps where nothing is, on a line.
    const steps = Math.ceil(heightMeters / PROFILE_STEP) + 1;
    const profile = new Array<number>(steps).fill(0);
    for (const [raw, circumference] of rec.samples) {
      const i = Math.min(steps - 1, Math.max(0, Math.round(downOf(raw) / PROFILE_STEP)));
      profile[i] = Math.max(profile[i], circumference);
    }
    const known = profile.map((c) => c > 0);
    const firstKnown = known.indexOf(true);
    const lastKnown = known.lastIndexOf(true);
    for (let i = 0; i < steps; i++) {
      if (known[i]) continue;
      if (i < firstKnown) profile[i] = profile[firstKnown];
      else if (i > lastKnown) profile[i] = profile[lastKnown];
      else {
        let before = i - 1;
        while (!known[before]) before--;
        let after = i + 1;
        while (!known[after]) after++;
        profile[i] = profile[before] + ((profile[after] - profile[before]) * (i - before)) / (after - before);
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      const copy = profile.slice();
      for (let i = 0; i < steps; i++) profile[i] = (copy[Math.max(0, i - 1)] + copy[i] * 2 + copy[Math.min(steps - 1, i + 1)]) / 4;
    }
    // The smoothing must not narrow it below what a vertex needs.
    for (const [raw, circumference] of rec.samples) {
      const i = Math.min(steps - 1, Math.max(0, Math.round(downOf(raw) / PROFILE_STEP)));
      profile[i] = Math.max(profile[i], circumference);
    }
    const widest = Math.max(...profile);
    // Room for the seam, and for the triangles that reach a little past a cut.
    return { heightMeters, widthMeters: widest * SEAM_ROOM + 0.08, profile, downOf };
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
    const s = sized[i];
    return {
      name: rec.name,
      recipe: base.recipe,
      mirrored: base.mirrored,
      x: places![i].x,
      y: places![i].y,
      width: widths[i],
      height: heights[i],
      widthMeters: s.widthMeters,
      heightMeters: s.heightMeters,
      profile: s.profile,
      loops: rec.loops.map((loop) => ({
        kind: loop.kind,
        ring: loop.ring,
        points: loop.points.map((p) => ({ round: p.round, u: (p.round - 0.5) * p.circumference, v: s.downOf(p.raw), circumference: p.circumference })),
      })),
    };
  });
  for (let corner = 0; corner < cornerIsland.length; corner++) {
    const at = cornerIsland[corner];
    if (at < 0) continue;
    const s = sized[at];
    const place = placed[at];
    const v = s.downOf(cornerAlong[corner]);
    const circumference = cornerCircumference[corner] > 0 ? cornerCircumference[corner] : s.profile[Math.min(s.profile.length - 1, Math.max(0, Math.round(v / PROFILE_STEP)))];
    const x = place.x + PAD + (s.widthMeters / 2 + (cornerRound[corner] - 0.5) * circumference) * def.density;
    const y = place.y + PAD + v * def.density;
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
