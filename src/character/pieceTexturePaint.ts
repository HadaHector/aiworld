import type { BakedGearMaterial } from "./gearMaterial";
import { sampleGearMaterial } from "./gearSample";
import type { IslandDef, IslandFeature } from "./gearDef";
import { islandRecipe, type IslandPlace, type PieceTexture } from "./pieceTexture";

/**
 * Paints a piece's own texture (CHARACTERS.md, *Pieces and islands*), island by island, the way the
 * panel would be made: cloth cut with its threads running the way the recipe says, then what a
 * tailor does to it - seams sewn flat with a row of stitches each side, a hem folded and stitched, a
 * bias binding on a raw edge, a panel sewn to the next along its edge. Every texel is worked out
 * from where it is on the panel (metres round it from its front, metres down from its top), so the
 * same recipe fits an island of any size, and a race's panel is its own size.
 *
 * Details are drawn twice life size, as everything here is, so they read from the third-person
 * camera: a thread of stitching is 3 mm, a seam allowance 2.4 cm.
 */
export function paintPieceTexture(texture: PieceTexture, material: (id: string) => BakedGearMaterial | null): Uint8Array {
  const { size } = texture;
  const pixels = new Uint8Array(size * size * 4);
  // What the texture holds outside its islands is the cloth's own colour, so a mip never mixes in black.
  const first = Object.values(texture.def.islands)[0];
  const fill = first ? first.tint : ([1, 1, 1] as const);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = Math.round(fill[0] * 200);
    pixels[i * 4 + 1] = Math.round(fill[1] * 200);
    pixels[i * 4 + 2] = Math.round(fill[2] * 200);
    pixels[i * 4 + 3] = 255;
  }
  for (const place of texture.islands) {
    const recipe = islandRecipe(texture, place);
    const cloth = recipe ? material(recipe.material) : null;
    if (recipe && cloth) paintIsland(pixels, texture, place, recipe, cloth);
  }
  return pixels;
}

/** Texels a thread of stitching is wide, and how long a stitch and its gap are: in metres. */
const THREAD = 0.0036;
const STITCH = 0.009;
const GAP = 0.006;

function paintIsland(pixels: Uint8Array, texture: PieceTexture, place: IslandPlace, recipe: IslandDef, cloth: BakedGearMaterial): void {
  const { size, density, pad } = texture;
  const circumference = place.widthMeters / 1.2;
  const height = place.heightMeters;
  const features: IslandFeature[] = recipe.features.map((f) => (f.kind === "seam" && place.mirrored ? { ...f, at: 1 - f.at } : f));
  const warm = [recipe.tint[0], recipe.tint[1], recipe.tint[2]];
  for (let py = 0; py < place.height; py++) {
    for (let px = 0; px < place.width; px++) {
      // Metres round the panel (round the seam: it wraps) and down from its top; past the top and
      // bottom the edge's own cloth carries on, so a mip does not blend in the next island.
      const roundRaw = (px - pad + 0.5) / density;
      const u = ((roundRaw % circumference) + circumference) % circumference;
      const v = Math.min(height, Math.max(0, (py - pad + 0.5) / density));
      const beyond = (py - pad + 0.5) / density;
      let [r, g, b] = fabric(cloth, recipe, u, v, 1, warm);
      let shade = hang(u, v, circumference);
      let thread = 0;
      let bias = false;
      for (const f of features) {
        if (f.kind === "hem") {
          const d = f.edge === "top" ? v : height - v;
          if (d < f.width) {
            // The fold: a second layer of cloth, a shade heavier, its cut edge folded under.
            shade *= 0.95;
            if (d < 0.0035) shade *= 1.05;
          }
          thread = Math.max(thread, stitchRow(Math.abs(d - f.width), u, 0.0045));
          if (Math.abs(d - f.width) < 0.0016) shade *= 0.86;
        } else if (f.kind === "binding") {
          const d = f.edge === "top" ? v : height - v;
          if (d < f.width) {
            bias = true;
            [r, g, b] = fabric(cloth, recipe, u, v, 0, f.tint);
            shade *= 0.97;
            if (d < 0.003 || f.width - d < 0.003) shade *= 0.9;
          }
          thread = Math.max(thread, stitchRow(Math.abs(d - 0.006), u, 0.0045), stitchRow(Math.abs(d - (f.width - 0.006)), u, 0.0045));
          if (Math.abs(d - f.width) < 0.0016) shade *= 0.78;
        } else if (f.kind === "join") {
          const d = f.edge === "top" ? v : height - v;
          // A panel sewn to the next: the allowance turned in, a shadow where they meet, a stitch row.
          if (d < f.inset) shade *= 0.93;
          if (Math.abs(d - f.inset) < 0.0016) shade *= 0.8;
          thread = Math.max(thread, stitchRow(Math.abs(d - f.inset * 0.5), u, 0.0045));
        } else {
          // A seam sewn flat: the allowance pressed to one side, an edge each side of it, and a row
          // of stitches over each edge.
          const centre = f.at * circumference;
          const across = Math.abs(wrapDistance(u, centre, circumference));
          if (across < 0.0125) shade *= 0.95;
          if (Math.abs(across - 0.0125) < 0.0017) shade *= 0.82;
          if (across < 0.0017) shade *= 0.9;
          thread = Math.max(thread, stitchRow(Math.abs(across - 0.0075), v, 0.0045));
        }
      }
      void bias;
      // The thread is the cloth a few shades darker.
      r *= shade;
      g *= shade;
      b *= shade;
      if (thread > 0) {
        const t = Math.min(1, thread);
        r += (r * 0.55 - r) * t;
        g += (g * 0.55 - g) * t;
        b += (b * 0.55 - b) * t;
      }
      // Below the hem the bottom edge's last row carries on, a little darker.
      if (beyond > height) {
        r *= 0.92;
        g *= 0.92;
        b *= 0.92;
      }
      const o = ((place.y + py) * size + place.x + px) * 4;
      pixels[o] = byte(r);
      pixels[o + 1] = byte(g);
      pixels[o + 2] = byte(b);
      pixels[o + 3] = 255;
    }
  }
}

/** The cloth at (u, v) metres on a panel: the material's weave, its threads running down the panel
 *  (or across it), coloured by `colour`; `grain` 0 cuts it on the bias, at 45 degrees. Averaged over
 *  a few samples a texel, so the weave does not shimmer. */
function fabric(cloth: BakedGearMaterial, recipe: IslandDef, u: number, v: number, grain: number, colour: readonly number[]): [number, number, number] {
  const across = recipe.grain === "across";
  let r = 0;
  let g = 0;
  let b = 0;
  const step = 0.4 / 300;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      let a = u + (i - 0.5) * step;
      let c = v + (j - 0.5) * step;
      if (!grain) [a, c] = [(a + c) * Math.SQRT1_2, (c - a) * Math.SQRT1_2];
      const [x, y] = across ? [c, a] : [a, c];
      const s = sampleGearMaterial(cloth, x, y);
      r += s[0];
      g += s[1];
      b += s[2];
    }
  }
  return [(r / 4) * colour[0] * 255, (g / 4) * colour[1] * 255, (b / 4) * colour[2] * 255];
}

/** How cloth hangs: slow, long folds down the panel and a little unevenness across it. */
function hang(u: number, v: number, circumference: number): number {
  const a = (u / circumference) * Math.PI * 2;
  return 1 + 0.035 * Math.sin(a * 3 + 0.7 + v * 2.1) + 0.02 * Math.sin(a * 7 + v * 5.3) - 0.02 * Math.min(1, v * 0.5);
}

/** The distance from `a` to `b` round a circle of `circumference`. */
function wrapDistance(a: number, b: number, circumference: number): number {
  let d = a - b;
  if (d > circumference / 2) d -= circumference;
  if (d < -circumference / 2) d += circumference;
  return d;
}

/** 1 on a thread of stitching `across` metres from a stitch row's line, `along` the row: stitches
 *  with gaps between. The dash has a soft end, so it survives being a texel or two. */
function stitchRow(across: number, along: number, reach: number): number {
  if (across > THREAD * 0.5) return 0;
  const cycle = STITCH + GAP;
  const at = ((along % cycle) + cycle) % cycle;
  void reach;
  return at < STITCH ? 1 : 0;
}

function byte(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : Math.round(x);
}
