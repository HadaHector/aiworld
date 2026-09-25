import { mulberry32 } from "../rng";
import type { GrassKindDef } from "./grassConfig";

export const GRASS_TEXTURE_SIZE = 256;

/**
 * Channels: R is shading (dark root to light tip), G is a petal mask (1 on flower petals, 0
 * elsewhere), B repeats R, A is the cut-out. The colour itself is not in the texture: stems and
 * blades take each tuft's tint and petals its petal colour (see grassField.ts).
 *
 * Grey blades on transparent, where empty pixels still carry a mid-grey rather than black: mipmaps
 * average colour across the cut-out edge, and a black surround would darken every blade's outline
 * as the texture shrinks with distance.
 */
const EMPTY_LUMINANCE = 0.72;

/**
 * Draws one kind's blades into its layer. Each blade is a tapered, leaning curve from the bottom
 * edge (v = 0, where the tuft meets the ground) up to its tip, dark at the root and light at the
 * tip - the colour itself comes from each tuft's tint (see grassScatter.ts), so the texture only
 * holds shading and the cut-out shape.
 */
function drawBlades(pixels: Uint8Array, layer: number, def: GrassKindDef, seed: number): void {
  const size = GRASS_TEXTURE_SIZE;
  const offset = layer * size * size * 4;
  const coverage = new Float32Array(size * size);
  const luminance = new Float32Array(size * size).fill(EMPTY_LUMINANCE);
  const petal = new Float32Array(size * size);
  const rng = mulberry32(seed);
  const { count, minHeight, maxHeight, baseWidth, lean, fan, seedHeads, flowerHeads } = def.blades;

  const plot = (px: number, py: number, cover: number, lum: number, petalMask = 0): void => {
    if (px < 0 || px >= size || py < 0 || py >= size || cover <= 0) return;
    const i = py * size + px;
    // Later blades are drawn over earlier ones, so where they overlap the nearer blade's shading wins.
    luminance[i] = coverage[i] > 0 ? luminance[i] + (lum - luminance[i]) * cover : lum;
    petal[i] = coverage[i] > 0 ? petal[i] + (petalMask - petal[i]) * cover : petalMask;
    coverage[i] = Math.max(coverage[i], cover);
  };

  /** An antialiased disc - a petal, or a flower's centre. */
  const disc = (cx: number, cy: number, radius: number, lum: number, petalMask: number): void => {
    for (let py = Math.floor(cy - radius - 1); py <= Math.ceil(cy + radius + 1); py++) {
      for (let px = Math.floor(cx - radius - 1); px <= Math.ceil(cx + radius + 1); px++) {
        const distance = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
        plot(px, py, Math.min(1, Math.max(0, radius + 0.5 - distance)), lum, petalMask);
      }
    }
  };

  for (let b = 0; b < count; b++) {
    const baseX = (fan ? 0.5 + (rng() - 0.5) * 0.18 : 0.06 + rng() * 0.88) * size;
    // Blades near the sides of a side-by-side tuft are shorter, so it has a rounded crown instead of
    // the flat top (and visible quad outline) of blades all reaching the same height.
    const fromCentre = Math.abs(baseX / size - 0.5) * 2;
    const crown = fan ? 1 : 1 - 0.55 * fromCentre * fromCentre;
    const height = (minHeight + rng() * (maxHeight - minHeight)) * crown * size;
    // Blades lean either way at random; a fan's all start near the centre, so the same leans spread
    // them out into a tussock.
    const tipShift = (rng() - 0.5) * 2 * lean * size;
    const shade = 0.82 + rng() * 0.28;
    const width = baseWidth * (0.7 + rng() * 0.6);

    for (let y = 0; y < height; y++) {
      const t = y / height;
      const cx = baseX + tipShift * Math.pow(t, 1.6);
      const half = Math.max(0.35, (width * Math.pow(1 - t, 0.75)) / 2);
      const lum = shade * (0.6 + 0.4 * Math.pow(t, 0.8));
      for (let px = Math.floor(cx - half - 1); px <= Math.ceil(cx + half + 1); px++) {
        const cover = Math.min(1, Math.max(0, half + 0.5 - Math.abs(px + 0.5 - cx)));
        plot(px, y, cover, lum);
      }
    }

    if (flowerHeads && b < flowerHeads.count) {
      // Five petals round a darker centre, all in petal colour; the head sits just below the stem's
      // tip so the stem does not poke out through it.
      const radius = flowerHeads.radius * (0.75 + rng() * 0.5);
      const tipX = baseX + tipShift * Math.pow(0.97, 1.6);
      const tipY = height * 0.97;
      const turn = rng() * Math.PI * 2;
      for (let p = 0; p < 5; p++) {
        const angle = turn + (p * Math.PI * 2) / 5;
        disc(tipX + Math.cos(angle) * radius * 0.5, tipY + Math.sin(angle) * radius * 0.5, radius * 0.42, 0.92 + rng() * 0.08, 1);
      }
      disc(tipX, tipY, radius * 0.26, 0.55, 1);
    }

    if (seedHeads) {
      // A slim, speckled head along the top of the stalk.
      const headLength = height * 0.14;
      for (let y = Math.floor(height - headLength); y < height + 2; y++) {
        const along = Math.min(1, Math.max(0, (y - (height - headLength)) / headLength));
        const cx = baseX + tipShift * Math.pow(Math.min(1, y / height), 1.6);
        const half = 2.4 * Math.sin(Math.PI * Math.min(1, along * 0.9 + 0.1));
        for (let px = Math.floor(cx - half - 1); px <= Math.ceil(cx + half + 1); px++) {
          const cover = Math.min(1, Math.max(0, half + 0.5 - Math.abs(px + 0.5 - cx)));
          plot(px, y, cover, shade * (0.95 + rng() * 0.2));
        }
      }
    }
  }

  for (let i = 0; i < size * size; i++) {
    const value = Math.round(Math.min(1, luminance[i]) * 255);
    pixels[offset + i * 4] = value;
    pixels[offset + i * 4 + 1] = Math.round(Math.min(1, petal[i]) * 255);
    pixels[offset + i * 4 + 2] = value;
    pixels[offset + i * 4 + 3] = Math.round(coverage[i] * 255);
  }
}

/** Every grass kind's blade texture, one RGBA layer each in list order. Row 0 is the root (v = 0).
 *  Deterministic from the seed. */
export function bakeGrassTextures(seed: number, grassKinds: GrassKindDef[]): Uint8Array {
  const pixels = new Uint8Array(GRASS_TEXTURE_SIZE * GRASS_TEXTURE_SIZE * 4 * grassKinds.length);
  grassKinds.forEach((kind, layer) => drawBlades(pixels, layer, kind, (seed ^ (0x9e37 * (layer + 1))) >>> 0));
  return pixels;
}
