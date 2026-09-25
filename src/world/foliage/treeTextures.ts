import { mulberry32 } from "../rng";
import type { FoliageTexture } from "./foliageConfig";

/** Four clump variants in a 2x2 atlas. */
export const FOLIAGE_TEXTURE_SIZE = 1024;

/**
 * Leaf clumps: four variants of a rounded clump of leaves, each drawn leaf by leaf - pointed
 * ellipses fanning out from the middle, darker and smaller towards the centre where they shade one
 * another, lighter at the rim where they catch the light, each with a midrib and one half a shade
 * lighter than the other. The alpha is the cut-out.
 *
 * Empty pixels carry the clump's average colour rather than black, so mipmaps - which average across
 * the cut-out edge - do not draw a dark outline round every clump in the distance.
 */
export function bakeFoliage(seed: number, def: FoliageTexture): Uint8Array {
  const size = FOLIAGE_TEXTURE_SIZE;
  const cell = size / 2;
  const pixels = new Uint8Array(size * size * 4);
  const coverage = new Float32Array(size * size);
  const rgb = new Float32Array(size * size * 3);

  for (let variant = 0; variant < 4; variant++) {
    const rng = mulberry32(seed + variant * 7919);
    const originX = (variant % 2) * cell;
    const originY = Math.floor(variant / 2) * cell;
    const radius = cell * 0.44;
    const cx = originX + cell / 2;
    const cy = originY + cell / 2;

    const leaves = Array.from({ length: def.leaves }, () => {
      // More leaves towards the rim than a uniform scatter would give, so the clump has a full edge.
      const r = radius * Math.pow(rng(), 0.6) * 0.82;
      const angle = rng() * Math.PI * 2;
      return { r, angle, depth: r / radius + rng() * 0.5, turn: (rng() - 0.5) * 1.2, scale: 0.75 + rng() * 0.5, shade: rng() };
    }).sort((a, b) => a.depth - b.depth);

    for (const leaf of leaves) {
      const rim = leaf.r / radius;
      const length = def.leafLength * cell * leaf.scale * (0.7 + 0.3 * rim);
      const width = def.leafWidth * cell * leaf.scale * (0.7 + 0.3 * rim);
      // Leaves point outward from the middle, turned a little either way.
      const heading = leaf.angle + leaf.turn;
      const dirX = Math.cos(heading);
      const dirY = Math.sin(heading);
      const baseX = cx + Math.cos(leaf.angle) * leaf.r - dirX * length * 0.35;
      const baseY = cy + Math.sin(leaf.angle) * leaf.r - dirY * length * 0.35;
      const brightness = (0.55 + 0.45 * rim) * (0.8 + 0.35 * leaf.shade);
      const base = [0, 1, 2].map((c) => def.dark[c] + (def.light[c] - def.dark[c]) * Math.min(1, rim * 0.7 + leaf.shade * 0.45));

      const reach = length + 2;
      for (let py = Math.floor(baseY - reach); py <= Math.ceil(baseY + reach); py++) {
        if (py < originY || py >= originY + cell) continue;
        for (let px = Math.floor(baseX - reach); px <= Math.ceil(baseX + reach); px++) {
          if (px < originX || px >= originX + cell) continue;
          const rx = px + 0.5 - baseX;
          const ry = py + 0.5 - baseY;
          const along = (rx * dirX + ry * dirY) / length;
          if (along < 0 || along > 1) continue;
          const across = -rx * dirY + ry * dirX;
          // Widest a third of the way up, coming to a point at the tip.
          const halfWidth = (width / 2) * Math.pow(Math.sin(Math.PI * Math.pow(along, 0.8)), 0.85);
          const edge = halfWidth - Math.abs(across);
          const cover = Math.min(1, Math.max(0, edge + 0.5));
          if (cover <= 0) continue;
          let shade = brightness * (across > 0 ? 1.08 : 0.9);
          if (Math.abs(across) < 0.9 && along < 0.9) shade *= 0.78; // midrib
          if (edge < 1.8) shade *= 0.85; // a darker outline, painted rather than photographic
          shade *= 0.85 + 0.15 * along; // darker where the leaf joins the clump
          const i = py * size + px;
          const blend = coverage[i] > 0 ? cover : 1;
          for (let c = 0; c < 3; c++) rgb[i * 3 + c] += (base[c] * shade - rgb[i * 3 + c]) * blend;
          coverage[i] = Math.max(coverage[i], cover);
        }
      }
    }
  }

  const average = [0, 0, 0];
  let covered = 0;
  for (let i = 0; i < size * size; i++) {
    if (coverage[i] < 0.5) continue;
    for (let c = 0; c < 3; c++) average[c] += rgb[i * 3 + c];
    covered++;
  }
  for (let c = 0; c < 3; c++) average[c] /= Math.max(1, covered);
  for (let i = 0; i < size * size; i++) {
    const a = coverage[i];
    for (let c = 0; c < 3; c++) {
      const value = a > 0 ? rgb[i * 3 + c] : average[c];
      pixels[i * 4 + c] = Math.min(255, Math.max(0, value * 255));
    }
    pixels[i * 4 + 3] = a * 255;
  }
  return pixels;
}
