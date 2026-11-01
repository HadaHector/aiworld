import type { BakedGearMaterial } from "./gearMaterial";
import { sampleGearMaterial } from "./gearSample";
import type { IslandDef, IslandFeature } from "./gearDef";
import { islandRecipe, PROFILE_STEP, type IslandPlace, type PieceTexture } from "./pieceTexture";

/**
 * Paints a piece's own texture (CHARACTERS.md, *Pieces and islands*), island by island, the way the
 * panel would be made: cloth cut with its threads running the way the recipe says, then what a
 * tailor does to it - seams sewn flat with a row of stitches each side, a hem folded and stitched, a
 * bias binding on a raw edge, a panel sewn to the next along its edge. Every texel is worked out
 * from where it is on the panel (metres across it from its middle, metres down from its top), and
 * edges are the panel's real edges - the polylines the geometry gave - so a hem lies along the hem
 * and a binding follows the neckline however the cut curves.
 *
 * Details are drawn twice life size, as everything here is, so they read from the third-person
 * camera: a thread of stitching is 5 mm, a seam allowance 2.5 cm.
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

/** Metres a thread of stitching is wide, and how long a stitch and its gap are. */
const THREAD = 0.0055;
const STITCH = 0.012;
const GAP = 0.007;

/** An edge as line segments in metres, with how far along the edge each starts (for the stitches). */
interface Edge {
  segments: [number, number, number, number][];
  start: number[];
}

function edgeOf(place: IslandPlace, kinds: ("top" | "bottom" | "join" | "seam")[], fallback: [number, number, number, number]): Edge {
  const segments: [number, number, number, number][] = [];
  const start: number[] = [];
  for (const loop of place.loops) {
    if (!kinds.includes(loop.kind) || loop.points.length < 2) continue;
    // A ring round the panel goes round once more either side, so an edge across the seam is whole;
    // a loop of its own (an armhole) is walked once.
    const points: [number, number][] = [];
    for (const k of loop.ring ? [-1, 0, 1] : [0]) for (const p of loop.points) points.push([(p.round - 0.5 + k) * p.circumference, p.v]);
    let walked = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      segments.push([points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]]);
      start.push(walked);
      walked += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    }
  }
  if (segments.length === 0) {
    segments.push(fallback);
    start.push(0);
  }
  return { segments, start };
}

/** The distance from (u, v) to the edge, and how far along it the nearest point is. */
function toEdge(edge: Edge, u: number, v: number): { distance: number; along: number } {
  let best = Infinity;
  let along = 0;
  for (let i = 0; i < edge.segments.length; i++) {
    const [x0, y0, x1, y1] = edge.segments[i];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length2 = dx * dx + dy * dy;
    const t = length2 > 0 ? Math.min(1, Math.max(0, ((u - x0) * dx + (v - y0) * dy) / length2)) : 0;
    const d = Math.hypot(u - (x0 + dx * t), v - (y0 + dy * t));
    if (d < best) {
      best = d;
      along = edge.start[i] + t * Math.sqrt(length2);
    }
  }
  return { distance: best, along };
}

function paintIsland(pixels: Uint8Array, texture: PieceTexture, place: IslandPlace, recipe: IslandDef, cloth: BakedGearMaterial): void {
  const { size, density, pad } = texture;
  const width = place.widthMeters;
  const height = place.heightMeters;
  const circumferenceAt = (v: number): number => place.profile[Math.min(place.profile.length - 1, Math.max(0, Math.round(v / PROFILE_STEP)))];
  const features: IslandFeature[] = recipe.features.map((f) => (f.kind === "seam" && place.mirrored ? { ...f, at: 1 - f.at } : f));
  const edges = {
    top: edgeOf(place, ["top"], [-width, 0, width, 0]),
    bottom: edgeOf(place, ["bottom"], [-width, height, width, height]),
    join: edgeOf(place, ["join"], [-width, -10, width, -10]),
    seam: edgeOf(place, ["seam"], [-width, -10, width, -10]),
  };
  const warm = [recipe.tint[0], recipe.tint[1], recipe.tint[2]];
  for (let py = 0; py < place.height; py++) {
    for (let px = 0; px < place.width; px++) {
      // Metres across the panel from its middle, and down from its top.
      const u = (px - pad + 0.5) / density - width / 2;
      const beyond = (py - pad + 0.5) / density;
      const v = Math.min(height, Math.max(0, beyond));
      const circumference = circumferenceAt(v);
      let [r, g, b] = fabric(cloth, recipe, u, v, true, warm);
      let shade = hang(u, v, circumference);
      let thread = 0;
      for (const f of features) {
        if (f.kind === "band") {
          // A strip of another cloth, stitched along each edge.
          const across = Math.abs(u - (f.at - 0.5) * circumference);
          if (across < f.width / 2) {
            [r, g, b] = fabric(cloth, recipe, u, v, true, f.tint);
            shade *= 0.97;
            if (f.width / 2 - across < 0.003) shade *= 0.88;
          }
          if (Math.abs(across - (f.width / 2 - 0.007)) < THREAD / 2) thread = Math.max(thread, dash(v));
          if (Math.abs(across - f.width / 2) < 0.0016) shade *= 0.78;
          continue;
        }
        if (f.kind === "seam") {
          // A seam sewn flat: the allowance pressed to one side, an edge each side of it, and a row
          // of stitches over each edge. `at` is how far round the panel (the front is its middle),
          // so it is a line in the cloth that follows the cut's width.
          if (v / height < f.from || v / height > f.to) continue;
          let across = Infinity;
          for (const k of [-1, 0, 1]) across = Math.min(across, Math.abs(u - (f.at - 0.5 + k) * circumference));
          if (across < 0.0125) shade *= 0.95;
          if (Math.abs(across - 0.0125) < 0.0017) shade *= 0.82;
          if (across < 0.0017) shade *= 0.9;
          if (Math.abs(across - 0.0075) < THREAD / 2) thread = Math.max(thread, dash(v));
          continue;
        }
        const edge = edges[f.edge];
        const { distance, along } = toEdge(edge, u, v);
        if (f.kind === "hem") {
          if (distance < f.width) {
            // The fold: a second layer of cloth, a shade heavier, its cut edge folded under.
            shade *= 0.95;
            if (distance < 0.0035) shade *= 1.05;
          }
          if (Math.abs(distance - f.width) < THREAD / 2) thread = Math.max(thread, dash(along));
          if (Math.abs(distance - f.width) < 0.0016) shade *= 0.86;
        } else if (f.kind === "binding") {
          if (distance < f.width) {
            // Bias cut: its threads at 45 degrees, in the binding's own cloth.
            [r, g, b] = fabric(cloth, recipe, u, v, false, f.tint);
            shade *= 0.97;
            if (distance < 0.003 || f.width - distance < 0.003) shade *= 0.9;
          }
          if (Math.abs(distance - 0.006) < THREAD / 2 || Math.abs(distance - (f.width - 0.006)) < THREAD / 2) thread = Math.max(thread, dash(along));
          if (Math.abs(distance - f.width) < 0.0016) shade *= 0.78;
        } else {
          // A panel sewn to the next: the allowance turned in, a shadow where they meet, a stitch row.
          if (distance < f.inset) shade *= 0.93;
          if (Math.abs(distance - f.inset) < 0.0016) shade *= 0.8;
          if (Math.abs(distance - f.inset * 0.5) < THREAD / 2) thread = Math.max(thread, dash(along));
        }
      }
      // The thread is the cloth a few shades darker.
      r *= shade;
      g *= shade;
      b *= shade;
      if (thread > 0) {
        r *= 0.5;
        g *= 0.5;
        b *= 0.5;
      }
      // Past the panel's bottom the last row carries on, a little darker.
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
 *  (or across it), coloured by `colour`; `straight` false cuts it on the bias, at 45 degrees.
 *  Averaged over a few samples a texel, so the weave does not shimmer. */
function fabric(cloth: BakedGearMaterial, recipe: IslandDef, u: number, v: number, straight: boolean, colour: readonly number[]): [number, number, number] {
  const across = recipe.grain === "across";
  let r = 0;
  let g = 0;
  let b = 0;
  const step = 0.4 / 300;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      let a = u + (i - 0.5) * step;
      let c = v + (j - 0.5) * step;
      if (!straight) [a, c] = [(a + c) * Math.SQRT1_2, (c - a) * Math.SQRT1_2];
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
  return 1 + 0.022 * Math.sin(a * 3 + 0.7 + v * 2.1) + 0.012 * Math.sin(a * 7 + v * 5.3) - 0.02 * Math.min(1, v * 0.5);
}

/** 1 on a stitch, 0 in the gap between, `along` the row. */
function dash(along: number): number {
  const cycle = STITCH + GAP;
  const at = ((along % cycle) + cycle) % cycle;
  return at < STITCH ? 1 : 0;
}

function byte(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : Math.round(x);
}
