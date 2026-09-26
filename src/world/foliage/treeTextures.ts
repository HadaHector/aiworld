import { mulberry32 } from "../rng";
import type { BushTexture, FoliageTexture } from "./foliageConfig";

/** Four clump variants in a 2x2 atlas. */
export const FOLIAGE_TEXTURE_SIZE = 1024;

/** A rectangle of the atlas nothing may be painted outside of - one cell. */
interface Clip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Paints anti-aliased leaves and stems into an atlas, each over whatever is already there, keeping
 * coverage apart from colour so the finished atlas can fill its empty pixels (see `finish`).
 */
class Painter {
  readonly size: number;
  readonly coverage: Float32Array;
  readonly rgb: Float32Array;

  constructor(size: number) {
    this.size = size;
    this.coverage = new Float32Array(size * size);
    this.rgb = new Float32Array(size * size * 3);
  }

  private blend(i: number, cover: number, r: number, g: number, b: number): void {
    const { coverage, rgb } = this;
    const amount = coverage[i] > 0 ? cover : 1;
    rgb[i * 3] += (r - rgb[i * 3]) * amount;
    rgb[i * 3 + 1] += (g - rgb[i * 3 + 1]) * amount;
    rgb[i * 3 + 2] += (b - rgb[i * 3 + 2]) * amount;
    coverage[i] = Math.max(coverage[i], cover);
  }

  /**
   * One leaf from (baseX, baseY) towards (dirX, dirY): a pointed ellipse, widest a third of the way
   * up, with a midrib, one half a shade lighter than the other and a darker outline - painted
   * rather than photographic.
   */
  leaf(baseX: number, baseY: number, dirX: number, dirY: number, length: number, width: number, base: number[], brightness: number, clip: Clip): void {
    const reach = length + 2;
    for (let py = Math.floor(baseY - reach); py <= Math.ceil(baseY + reach); py++) {
      if (py < clip.y0 || py >= clip.y1) continue;
      for (let px = Math.floor(baseX - reach); px <= Math.ceil(baseX + reach); px++) {
        if (px < clip.x0 || px >= clip.x1) continue;
        const rx = px + 0.5 - baseX;
        const ry = py + 0.5 - baseY;
        const along = (rx * dirX + ry * dirY) / length;
        if (along < 0 || along > 1) continue;
        const across = -rx * dirY + ry * dirX;
        const halfWidth = (width / 2) * Math.pow(Math.sin(Math.PI * Math.pow(along, 0.8)), 0.85);
        const edge = halfWidth - Math.abs(across);
        const cover = Math.min(1, Math.max(0, edge + 0.5));
        if (cover <= 0) continue;
        let shade = brightness * (across > 0 ? 1.08 : 0.9);
        if (Math.abs(across) < 0.9 && along < 0.9) shade *= 0.78; // midrib
        if (edge < 1.8) shade *= 0.85;
        shade *= 0.85 + 0.15 * along; // darker where the leaf joins the stem
        this.blend(py * this.size + px, cover, base[0] * shade, base[1] * shade, base[2] * shade);
      }
    }
  }

  /** A tapering stroke from (x0, y0) to (x1, y1), shaded as a round stem lit from its left. */
  stem(x0: number, y0: number, x1: number, y1: number, r0: number, r1: number, colour: readonly number[], clip: Clip): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSq = Math.max(1e-6, dx * dx + dy * dy);
    const length = Math.sqrt(lengthSq);
    const reach = Math.max(r0, r1) + 1;
    for (let py = Math.floor(Math.min(y0, y1) - reach); py <= Math.ceil(Math.max(y0, y1) + reach); py++) {
      if (py < clip.y0 || py >= clip.y1) continue;
      for (let px = Math.floor(Math.min(x0, x1) - reach); px <= Math.ceil(Math.max(x0, x1) + reach); px++) {
        if (px < clip.x0 || px >= clip.x1) continue;
        const rx = px + 0.5 - x0;
        const ry = py + 0.5 - y0;
        const t = Math.min(1, Math.max(0, (rx * dx + ry * dy) / lengthSq));
        const radius = r0 + (r1 - r0) * t;
        const side = (rx * dy - ry * dx) / length;
        const distance = Math.hypot(rx - dx * t, ry - dy * t);
        // Thinner than a pixel still leaves a faint line rather than breaking up.
        const cover = Math.min(1, Math.max(0, radius - distance + 0.5)) * Math.min(1, radius * 1.5);
        if (cover <= 0) continue;
        const across = Math.max(-1, Math.min(1, side / Math.max(0.5, radius)));
        const shade = 0.55 + 0.4 * Math.sqrt(1 - across * across) - 0.15 * across;
        this.blend(py * this.size + px, cover, colour[0] * shade, colour[1] * shade, colour[2] * shade);
      }
    }
  }

  /**
   * The atlas's pixels, alpha the coverage. Empty pixels carry the average colour rather than
   * black, so mipmaps - which average across the cut-out edge - do not draw a dark outline round
   * every clump in the distance.
   */
  finish(): Uint8Array {
    const { size, coverage, rgb } = this;
    const pixels = new Uint8Array(size * size * 4);
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
}

function cellClip(cell: number, variant: number): Clip {
  const x0 = (variant % 2) * cell;
  const y0 = Math.floor(variant / 2) * cell;
  return { x0, y0, x1: x0 + cell, y1: y0 + cell };
}

/**
 * Leaf clumps: four variants of a rounded clump of leaves, each drawn leaf by leaf - pointed
 * ellipses fanning out from the middle, darker and smaller towards the centre where they shade one
 * another, lighter at the rim where they catch the light. The alpha is the cut-out.
 */
export function bakeFoliage(seed: number, def: FoliageTexture): Uint8Array {
  const size = FOLIAGE_TEXTURE_SIZE;
  const cell = size / 2;
  const painter = new Painter(size);

  for (let variant = 0; variant < 4; variant++) {
    const rng = mulberry32(seed + variant * 7919);
    const clip = cellClip(cell, variant);
    const radius = cell * 0.44;
    const cx = clip.x0 + cell / 2;
    const cy = clip.y0 + cell / 2;

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
      painter.leaf(baseX, baseY, dirX, dirY, length, width, base, brightness, clip);
    }
  }
  return painter.finish();
}

/** Where a bush's leaves may hang from: a point on one of its stems. */
interface StemPoint {
  x: number;
  y: number;
}

interface StemSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r0: number;
  r1: number;
}

/**
 * Grows a stem and its side shoots as 2D strokes, angles measured from straight up (image y runs
 * down). A stem bends gently back towards vertical as it rises and forks `depth` more times.
 */
function growStem(
  rng: () => number,
  x: number,
  y: number,
  angle: number,
  length: number,
  radius: number,
  depth: number,
  segments: StemSegment[],
  anchors: StemPoint[],
): void {
  const steps = 6;
  const bend = (rng() - 0.5) * 0.2;
  const points: { x: number; y: number; angle: number; radius: number }[] = [{ x, y, angle, radius }];
  let a = angle;
  for (let s = 1; s <= steps; s++) {
    a += bend - a * 0.06;
    const previous = points[s - 1];
    const r = radius * (1 - (0.7 * s) / steps);
    const next = { x: previous.x + Math.sin(a) * (length / steps), y: previous.y - Math.cos(a) * (length / steps), angle: a, radius: r };
    segments.push({ x0: previous.x, y0: previous.y, x1: next.x, y1: next.y, r0: previous.radius, r1: r });
    anchors.push({ x: next.x, y: next.y });
    points.push(next);
  }
  if (depth <= 0) return;
  const shoots = 1 + Math.floor(rng() * 2);
  for (let c = 0; c < shoots; c++) {
    const at = points[2 + Math.floor(rng() * (steps - 2))];
    const side = (c % 2 === 0 ? 1 : -1) * (rng() < 0.5 ? 1 : -1);
    growStem(rng, at.x, at.y, at.angle + side * (0.35 + rng() * 0.45), length * (0.4 + rng() * 0.25), at.radius * 0.75, depth - 1, segments, anchors);
  }
}

/**
 * A bush atlas: cells 0 and 1 are two whole bushes seen from the side, cells 2 and 3 two leaf
 * clumps for the cards over a bush's top.
 *
 * A side view is stems first - a handful rising from one spot at the bottom of the cell, fanning
 * out and forking twice - with the leaves hung off their upper parts inside a rounded outline, and
 * the bottom `bare` of the bush left as stems alone. Some of the leaves are painted before the
 * stems and darker, as the far side of the bush, and the rest after, so the branches show through
 * the gaps in the foliage rather than only below it. A clump is the same on a smaller scale: a
 * few twigs from its bottom edge - the side of the card nearer the bush's middle - under a round
 * spray of leaves.
 */
export function bakeBushFoliage(seed: number, def: BushTexture): Uint8Array {
  const size = FOLIAGE_TEXTURE_SIZE;
  const cell = size / 2;
  const painter = new Painter(size);

  for (let variant = 0; variant < 4; variant++) {
    const rng = mulberry32(seed + variant * 7919);
    const clip = cellClip(cell, variant);
    const view = variant < 2;
    const cx = clip.x0 + cell / 2;
    const bottom = clip.y1 - 4;

    // --- the stems ---
    const segments: StemSegment[] = [];
    const anchors: StemPoint[] = [];
    let massX = cx;
    let massY: number;
    let massRx: number;
    let massRy: number;
    let top: number;
    if (view) {
      const height = cell * 0.84;
      top = bottom - height;
      const bareY = bottom - height * def.bare;
      massY = (bareY + top) / 2 - height * 0.04;
      massRx = cell * 0.42;
      massRy = (bareY - top) / 2 + height * 0.04;
      const count = def.stems[0] + Math.floor(rng() * (def.stems[1] - def.stems[0] + 1));
      for (let i = 0; i < count; i++) {
        const spread = ((i + 0.5 + (rng() - 0.5) * 0.7) / count - 0.5) * 2;
        const length = height * (0.68 + rng() * 0.2) * (1 - 0.3 * Math.abs(spread));
        growStem(rng, cx + spread * cell * 0.035, bottom, spread * 0.6, length, cell * 0.012, 2, segments, anchors);
      }
    } else {
      const radius = cell * 0.4;
      massY = clip.y0 + cell * 0.45;
      massRx = radius;
      massRy = radius;
      top = massY - radius;
      const count = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < count; i++) {
        const spread = ((i + 0.5) / count - 0.5) * 2;
        growStem(rng, cx + spread * cell * 0.03, bottom, spread * 0.55, radius * (1.1 + rng() * 0.4), cell * 0.008, 1, segments, anchors);
      }
      massX = cx;
    }

    // --- the leaves, each hung near a point on a stem and kept inside the outline ---
    const hanging = anchors.filter((a) => ((a.x - massX) / massRx) ** 2 + ((a.y - massY) / massRy) ** 2 < 1.1);
    const from = hanging.length > 0 ? hanging : anchors;
    const count = view ? def.leaves : Math.round(def.leaves * 0.6);
    const spray = cell * 0.08;
    const leaves: { x: number; y: number; rim: number; depth: number; turn: number; scale: number; shade: number; back: boolean }[] = [];
    for (let i = 0; i < count; i++) {
      // Most leaves hang off the stems, which is what gives the bush its structure; the rest are
      // spread through the outline - more towards its rim - so it fills out into a rounded mass.
      const onStem = rng() < 0.6;
      const anchor = from[Math.floor(rng() * from.length)];
      const angle = rng() * Math.PI * 2;
      const distance = onStem ? spray * Math.sqrt(rng()) : Math.pow(rng(), view ? 0.45 : 0.65);
      const x = onStem ? anchor.x + Math.cos(angle) * distance : massX + Math.cos(angle) * distance * massRx;
      const y = onStem ? anchor.y + Math.sin(angle) * distance : massY + Math.sin(angle) * distance * massRy;
      // The outline is ragged: each leaf is allowed a little further out or kept a little further in.
      const rim = Math.sqrt(((x - massX) / massRx) ** 2 + ((y - massY) / massRy) ** 2);
      const limit = 1 + (rng() - 0.5) * 0.16;
      const turn = (rng() - 0.5) * 1.4;
      const scale = 0.75 + rng() * 0.5;
      const shade = rng();
      const back = rng() < 0.45;
      if (rim > limit) continue;
      leaves.push({ x, y, rim, depth: rim + rng() * 0.5, turn, scale, shade, back });
    }
    leaves.sort((a, b) => a.depth - b.depth);

    const paintLeaves = (back: boolean): void => {
      for (const leaf of leaves) {
        if (leaf.back !== back) continue;
        const rim = Math.min(1, leaf.rim);
        const up = Math.min(1, Math.max(0, (bottom - leaf.y) / (bottom - top)));
        const length = def.leafLength * cell * leaf.scale * (0.75 + 0.25 * rim);
        const width = def.leafWidth * cell * leaf.scale * (0.75 + 0.25 * rim);
        const heading = Math.atan2(leaf.y - massY, leaf.x - massX) + leaf.turn;
        const dirX = Math.cos(heading);
        const dirY = Math.sin(heading);
        const brightness = (0.55 + 0.35 * rim + 0.15 * up) * (0.8 + 0.35 * leaf.shade) * (back ? 0.72 : 1);
        const mix = Math.min(1, rim * 0.45 + up * 0.35 + leaf.shade * 0.35);
        const base = [0, 1, 2].map((c) => def.dark[c] + (def.light[c] - def.dark[c]) * mix);
        painter.leaf(leaf.x - dirX * length * 0.35, leaf.y - dirY * length * 0.35, dirX, dirY, length, width, base, brightness, clip);
      }
    };

    paintLeaves(true);
    for (const s of segments) painter.stem(s.x0, s.y0, s.x1, s.y1, s.r0, s.r1, def.stem, clip);
    paintLeaves(false);
  }
  return painter.finish();
}
