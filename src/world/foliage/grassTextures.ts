import { mulberry32 } from "../rng";
import type { FlowerShape, GrassKindDef } from "./grassConfig";

export const GRASS_TEXTURE_SIZE = 256;

/**
 * Channels: R is shading (dark root to light tip), G is a petal mask (1 on flower petals, 0
 * elsewhere), B an eye mask (a flower's centre, in its kind's eye colour), A is the cut-out. The
 * colour itself is not in the texture: stems and blades take each tuft's tint, petals its petal
 * colour and eyes the kind's eye colour (see grassField.ts).
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
  const eye = new Float32Array(size * size);
  const rng = mulberry32(seed);
  const { count, minHeight, maxHeight, baseWidth, lean, fan, seedHeads, flowerHeads } = def.blades;

  const plot = (px: number, py: number, cover: number, lum: number, petalMask = 0, eyeMask = 0): void => {
    if (px < 0 || px >= size || py < 0 || py >= size || cover <= 0) return;
    const i = py * size + px;
    // Later blades are drawn over earlier ones, so where they overlap the nearer blade's shading wins.
    luminance[i] = coverage[i] > 0 ? luminance[i] + (lum - luminance[i]) * cover : lum;
    petal[i] = coverage[i] > 0 ? petal[i] + (petalMask - petal[i]) * cover : petalMask;
    eye[i] = coverage[i] > 0 ? eye[i] + (eyeMask - eye[i]) * cover : eyeMask;
    coverage[i] = Math.max(coverage[i], cover);
  };

  /** An antialiased ellipse, `rx` along `angle` and `ry` across it - a petal, a bell, a floret. */
  const ellipse = (cx: number, cy: number, rx: number, ry: number, angle: number, lum: number, petalMask: number, eyeMask = 0): void => {
    const reach = Math.max(rx, ry) + 1;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const thin = Math.max(0.5, Math.min(rx, ry));
    for (let py = Math.floor(cy - reach); py <= Math.ceil(cy + reach); py++) {
      for (let px = Math.floor(cx - reach); px <= Math.ceil(cx + reach); px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const along = (dx * c + dy * s) / Math.max(0.5, rx);
        const across = (-dx * s + dy * c) / Math.max(0.5, ry);
        const d = Math.sqrt(along * along + across * across);
        plot(px, py, Math.min(1, Math.max(0, (1 - d) * thin + 0.5)), lum, petalMask, eyeMask);
      }
    }
  };
  const disc = (cx: number, cy: number, radius: number, lum: number, petalMask: number, eyeMask = 0): void =>
    ellipse(cx, cy, radius, radius, 0, lum, petalMask, eyeMask);

  /** A flower's centre: in the eye colour if the kind has one, else a darker shade of the petals. */
  const hasEye = flowerHeads?.eye !== undefined;
  const centre = (cx: number, cy: number, radius: number, lum: number): void =>
    hasEye ? disc(cx, cy, radius, lum, 0, 1) : disc(cx, cy, radius, lum * 0.6, 1);

  /**
   * One flower head at the top of a stem, `radius` pixels in size. The card is seen from the side,
   * so each shape is drawn as it looks from there: a flower or daisy turned towards the viewer, a
   * cup, bells or a spike of florets in profile. `stemX` is the stem's x at a height, so heads set
   * along the stem follow its lean.
   */
  const drawHead = (shape: FlowerShape, petalCount: number | undefined, radius: number, stemX: (y: number) => number, height: number): void => {
    // Just below the stem's tip, so the stem does not poke out through the head.
    const tipY = height * 0.97;
    const tipX = stemX(tipY);
    const turn = rng() * Math.PI * 2;
    switch (shape) {
      case "flower": {
        // Broad, round petals round a centre - buttercup, wild rose, poppy seen from above.
        const n = petalCount ?? 5;
        for (let p = 0; p < n; p++) {
          const angle = turn + (p * Math.PI * 2) / n;
          ellipse(tipX + Math.cos(angle) * radius * 0.5, tipY + Math.sin(angle) * radius * 0.5, radius * 0.46, radius * Math.min(0.42, 2.2 / n), angle, 0.92 + rng() * 0.08, 1);
        }
        centre(tipX, tipY, radius * 0.26, 0.9);
        break;
      }
      case "daisy": {
        // Many narrow petals raying out of a large eye.
        const n = petalCount ?? 14;
        for (let p = 0; p < n; p++) {
          const angle = turn + (p * Math.PI * 2) / n + (rng() - 0.5) * 0.15;
          const reach = radius * (0.58 + rng() * 0.1);
          ellipse(tipX + Math.cos(angle) * reach, tipY + Math.sin(angle) * reach, radius * 0.4, radius * 0.1, angle, 0.9 + rng() * 0.1, 1);
        }
        centre(tipX, tipY, radius * 0.3, 0.95);
        break;
      }
      case "cup": {
        // A tulip or a closed poppy in profile: a tall middle petal between two leaning out.
        const n = Math.max(2, petalCount ?? 3);
        const cupY = tipY + radius * 0.55;
        for (let p = 0; p < n; p++) {
          const side = n === 1 ? 0 : (p / (n - 1)) * 2 - 1;
          const lum = 0.78 + 0.18 * (1 - Math.abs(side)) + rng() * 0.05;
          ellipse(tipX + side * radius * 0.32, cupY, radius * 0.72, radius * 0.36, Math.PI / 2 - side * 0.35, lum, 1);
        }
        if (hasEye) disc(tipX, tipY + radius * 0.08, radius * 0.18, 0.7, 0, 1);
        break;
      }
      case "bell": {
        // Bluebell, harebell: the stem arches over at its tip and bells hang from it, mouths down.
        const n = petalCount ?? 3;
        for (let k = 0; k < n; k++) {
          const y = height * (0.8 + (0.17 * k) / Math.max(1, n - 1));
          const side = k % 2 === 0 ? 1 : -1;
          const hangX = stemX(y) + side * radius * 0.45;
          const size = radius * (0.95 - 0.35 * (k / Math.max(1, n - 1)));
          const top = y - size * 0.25;
          // The bell: narrow at its top, widening to a flared lip at the bottom.
          for (let row = 0; row < size * 1.1; row++) {
            const t = row / (size * 1.1);
            const w = size * (0.22 + 0.3 * t * t) + (t > 0.85 ? size * 0.12 * (t - 0.85) / 0.15 : 0);
            const py = Math.floor(top - row);
            for (let px = Math.floor(hangX - w - 1); px <= Math.ceil(hangX + w + 1); px++) {
              const across = (px + 0.5 - hangX) / Math.max(0.5, w);
              const cover = Math.min(1, Math.max(0, w + 0.5 - Math.abs(px + 0.5 - hangX)));
              plot(px, py, cover, (0.7 + 0.25 * (0.5 - across * 0.5)) * (0.85 + 0.15 * (1 - t)), 1);
            }
          }
        }
        break;
      }
      case "raceme": {
        // Lupin, foxglove, lavender: florets crowded up the top of the stem, smaller towards the tip.
        const n = petalCount ?? 12;
        for (let k = 0; k < n; k++) {
          const u = k / Math.max(1, n - 1);
          const y = height * (0.62 + 0.36 * u);
          const size = radius * (0.5 - 0.28 * u);
          const side = (k % 2 === 0 ? 1 : -1) * size * 0.45;
          ellipse(stemX(y) + side, y, size, size * 0.8, 0, 0.8 + 0.2 * u + rng() * 0.06, 1);
        }
        break;
      }
      case "umbel": {
        // Yarrow, cow parsley: a flat-topped dome of tiny florets on thin rays from the tip.
        const n = petalCount ?? 9;
        const top = tipY + radius * 0.45;
        for (let k = 0; k < n; k++) {
          const u = n === 1 ? 0.5 : k / (n - 1);
          const endX = tipX + (u - 0.5) * radius * 2.2;
          const endY = top - Math.pow(Math.abs(u - 0.5) * 2, 2) * radius * 0.35;
          // The ray: a hair-thin stem line from the tip.
          const steps = Math.ceil(Math.hypot(endX - tipX, endY - tipY));
          for (let s = 0; s <= steps; s++) plot(Math.round(tipX + ((endX - tipX) * s) / steps), Math.round(tipY + ((endY - tipY) * s) / steps), 0.8, 0.75);
          for (let f = 0; f < 4; f++) disc(endX + (rng() - 0.5) * radius * 0.35, endY + rng() * radius * 0.15, radius * (0.1 + rng() * 0.06), 0.85 + rng() * 0.15, 1);
        }
        break;
      }
      case "globe": {
        // Clover, allium, thistle: a ball of tiny florets.
        const ball = radius * 0.62;
        const cy = tipY + ball * 0.7;
        disc(tipX, cy, ball, 0.68, 1);
        const n = petalCount ?? 26;
        for (let k = 0; k < n; k++) {
          const a = rng() * Math.PI * 2;
          const r = Math.sqrt(rng()) * ball * 0.9;
          // Lit from above: lighter florets towards the top of the ball.
          const lift = 0.5 + 0.5 * Math.sin(a) * (r / ball);
          disc(tipX + Math.cos(a) * r, cy + Math.sin(a) * r, radius * 0.12, 0.72 + 0.28 * lift, 1);
        }
        if (hasEye) ellipse(tipX, tipY + ball * 0.05, ball * 0.55, ball * 0.3, 0, 0.7, 0, 1);
        break;
      }
      case "spike":
        // Drawn by the caller (it follows the stem rather than sitting at its tip).
        break;
      case "plume": {
        // A reed's panicle: hair-thin florets fanning out from the top quarter of the stem, drooping
        // as they go and all nodding the same way, each ending in a fluffy tuft.
        const n = petalCount ?? 40;
        const nod = rng() < 0.5 ? -1 : 1;
        for (let k = 0; k < n; k++) {
          const u = rng();
          const y0 = height * (0.74 + 0.25 * u);
          const x0 = stemX(y0);
          const length = radius * (0.7 + rng() * 0.6) * (1 - 0.45 * u);
          // Out to the nodding side mostly, a few the other way; up at first, drooping at the end.
          const out = (rng() < 0.8 ? nod : -nod) * (0.35 + rng() * 0.65);
          const steps = Math.max(2, Math.ceil(length));
          let x = x0;
          let y = y0;
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            x += (out * length) / steps;
            y += (length / steps) * (0.55 - 1.3 * t);
            plot(Math.round(x), Math.round(y), 0.9, 0.75 + 0.25 * t, 1);
          }
          disc(x, y, radius * (0.03 + rng() * 0.025), 0.85 + rng() * 0.15, 1);
        }
        break;
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

    if (flowerHeads && flowerHeads.shape === "spike" && b < flowerHeads.count) {
      // A cattail: a long, rounded head in petal colour a little below the tip, so the bare stem
      // carries on above it; lit on one side, flecked, darker at its ends.
      const half = flowerHeads.radius * (0.8 + rng() * 0.4);
      const top = height * 0.9;
      const bottom = top - half * 7;
      for (let y = Math.floor(bottom - half); y <= Math.ceil(top + half); y++) {
        const along = (y - bottom) / (top - bottom);
        const t = Math.min(1, Math.max(0, y / height));
        const cx = baseX + tipShift * Math.pow(t, 1.6);
        // Rounded ends: the half-width eases in over the first and last bit of the head.
        const end = along < 0 ? 1 + along * ((top - bottom) / half) : along > 1 ? 1 - (along - 1) * ((top - bottom) / half) : 1;
        const w = half * Math.sqrt(Math.max(0, Math.min(1, end)) * (2 - Math.min(1, end)));
        if (w <= 0) continue;
        for (let px = Math.floor(cx - w - 1); px <= Math.ceil(cx + w + 1); px++) {
          const across = (px + 0.5 - cx) / Math.max(0.5, w);
          const cover = Math.min(1, Math.max(0, w + 0.5 - Math.abs(px + 0.5 - cx)));
          const lum = (0.62 + 0.3 * (0.5 - across * 0.5)) * (0.9 + rng() * 0.15) * (0.8 + 0.2 * Math.min(1, end));
          plot(px, y, cover, lum, 1);
        }
      }
    } else if (flowerHeads && b < flowerHeads.count) {
      const stemX = (y: number): number => baseX + tipShift * Math.pow(Math.min(1, Math.max(0, y / height)), 1.6);
      drawHead(flowerHeads.shape, flowerHeads.petals, flowerHeads.radius * (0.75 + rng() * 0.5), stemX, height);
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
    pixels[offset + i * 4 + 2] = Math.round(Math.min(1, eye[i]) * 255);
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
