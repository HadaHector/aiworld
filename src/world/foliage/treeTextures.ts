import { mulberry32 } from "../rng";
import { smoothstep } from "../mathUtils";
import type { BarkTexture, FoliageTexture } from "./foliageConfig";

export const BARK_TEXTURE_SIZE = 512;
/** Four clump variants in a 2x2 atlas. */
export const FOLIAGE_TEXTURE_SIZE = 1024;

/** Smooth value noise on a lattice `cellsX` x `cellsY` cells across the unit square, wrapping in
 *  both directions - so anything built from it tiles. Returns 0..1. */
function periodicNoise(seed: number, cellsX: number, cellsY: number): (u: number, v: number) => number {
  const rng = mulberry32(seed);
  const lattice = new Float32Array(cellsX * cellsY);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const at = (ix: number, iy: number): number => lattice[(((iy % cellsY) + cellsY) % cellsY) * cellsX + (((ix % cellsX) + cellsX) % cellsX)];
  return (u, v) => {
    const x = u * cellsX;
    const y = v * cellsY;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(ix, iy);
    const b = at(ix + 1, iy);
    const c = at(ix, iy + 1);
    const d = at(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

/** Writes a tangent-space normal map of a height field (0..1) into `normal`, wrapping at the edges. */
function writeNormals(height: Float32Array, size: number, strength: number, normal: Uint8Array): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = height[y * size + x];
      const dx = height[y * size + ((x + 1) % size)] - h;
      const dy = height[((y + 1) % size) * size + x] - h;
      const nx = -dx * strength;
      const ny = -dy * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y * size + x) * 4;
      normal[i] = (nx * inv * 0.5 + 0.5) * 255;
      normal[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      normal[i + 2] = (inv * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;
    }
  }
}

/**
 * Bark: long vertical plates with dark grooves between them that wander as they climb, the odd
 * horizontal crack across a plate, and fine lengthwise streaking. u runs around the limb, v along
 * it, and both wrap, so the texture tiles around a trunk and up it.
 */
export function bakeBark(seed: number, def: BarkTexture): { color: Uint8Array; normal: Uint8Array } {
  const size = BARK_TEXTURE_SIZE;
  const rng = mulberry32(seed);
  const plates = Math.max(2, Math.round(def.plates));
  const grooves = Array.from({ length: plates }, (_, k) => ({
    x: (k + 0.2 + rng() * 0.6) / plates,
    waves: 1 + Math.floor(rng() * 3),
    phase: rng() * Math.PI * 2,
    amplitude: (0.15 + rng() * 0.2) / plates,
  }));
  const plateTone = Array.from({ length: plates }, () => 0.85 + rng() * 0.25);
  const cracks = Array.from({ length: plates * 3 }, () => ({ plate: Math.floor(rng() * plates), v: rng(), depth: 0.4 + rng() * 0.4 }));
  const streaks = periodicNoise(seed ^ 0x51, 48, 6);
  const wobble = periodicNoise(seed ^ 0x77, 4, 8);
  const grain = periodicNoise(seed ^ 0x93, 128, 128);

  const height = new Float32Array(size * size);
  const tone = new Float32Array(size * size);
  const plateWidth = 1 / plates;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    // Where each groove is at this height.
    const at = grooves.map((g) => g.x + g.amplitude * Math.sin(v * Math.PI * 2 * g.waves + g.phase));
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let nearest = 1;
      let plate = 0;
      let nearestLeft = 2;
      for (let k = 0; k < plates; k++) {
        let d = Math.abs(u - at[k]);
        d = Math.min(d, 1 - d);
        if (d < nearest) nearest = d;
        // The plate a pixel sits on is named after the groove on its left.
        const left = (((u - at[k]) % 1) + 1) % 1;
        if (left < nearestLeft) {
          nearestLeft = left;
          plate = k;
        }
      }
      const q = Math.min(1, nearest / (plateWidth * 0.5));
      const grooveWidth = 0.16 + 0.22 * wobble(u, v);
      let h = smoothstep(0, grooveWidth, q) * (0.72 + 0.28 * Math.sqrt(q));
      for (const crack of cracks) {
        if (crack.plate !== plate) continue;
        let dv = Math.abs(v - crack.v);
        dv = Math.min(dv, 1 - dv) * size;
        if (dv < 3) h *= 1 - crack.depth * (1 - dv / 3) * smoothstep(0.1, 0.4, q);
      }
      h += (streaks(u, v) - 0.5) * 0.22 * h + (grain(u, v) - 0.5) * 0.06;
      height[y * size + x] = Math.min(1, Math.max(0, h));
      tone[y * size + x] = plateTone[plate];
    }
  }

  const color = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const h = height[i];
    // Grooves dark, ridges light, and the very tops of the ridges a touch lighter still - the
    // painted look of a hand-textured trunk rather than a photographic one.
    const t = Math.min(1, Math.pow(h, 1.3) * tone[i]);
    for (let c = 0; c < 3; c++) color[i * 4 + c] = Math.min(255, (def.dark[c] + (def.light[c] - def.dark[c]) * t) * 255);
    color[i * 4 + 3] = 255;
  }
  const normal = new Uint8Array(size * size * 4);
  writeNormals(height, size, def.bumpStrength * (size / 256), normal);
  return { color, normal };
}

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
