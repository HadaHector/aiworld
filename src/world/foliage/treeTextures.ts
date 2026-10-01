import { mulberry32 } from "../rng";
import { FROND_STALK_HALF_WIDTH, FROND_STALK_SHARE, type BushTexture, type ConiferTexture, type FoliageTexture, type Fronds } from "./foliageConfig";

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
    // Only the box the leaf can reach - base to tip, widened by its width - is visited; thin
    // needles cover a sliver of the square round their base.
    const tipX = baseX + dirX * length;
    const tipY = baseY + dirY * length;
    const pad = width / 2 + 2;
    const yFrom = Math.max(Math.floor(baseY - length - 2), Math.floor(Math.min(baseY, tipY) - pad));
    const yTo = Math.min(Math.ceil(baseY + length + 2), Math.ceil(Math.max(baseY, tipY) + pad));
    const xFrom = Math.max(Math.floor(baseX - length - 2), Math.floor(Math.min(baseX, tipX) - pad));
    const xTo = Math.min(Math.ceil(baseX + length + 2), Math.ceil(Math.max(baseX, tipX) + pad));
    for (let py = yFrom; py <= yTo; py++) {
      if (py < clip.y0 || py >= clip.y1) continue;
      for (let px = xFrom; px <= xTo; px++) {
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

  /**
   * Fills one cell from a function of where in it a pixel is - `x` 0-1 left to right, `y` 0-1 from
   * the bottom up - which gives its coverage and colour, or null for none.
   */
  fill(clip: Clip, sample: (x: number, y: number) => [number, number, number, number] | null): void {
    const w = clip.x1 - clip.x0;
    const h = clip.y1 - clip.y0;
    for (let py = clip.y0; py < clip.y1; py++) {
      for (let px = clip.x0; px < clip.x1; px++) {
        const got = sample((px + 0.5 - clip.x0) / w, 1 - (py + 0.5 - clip.y0) / h);
        if (!got || got[0] <= 0) continue;
        this.blend(py * this.size + px, Math.min(1, got[0]), got[1], got[2], got[3]);
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
export function bakeBushFoliage(seed: number, def: BushTexture, fronds: Fronds | null = null, stretch = 1): Uint8Array {
  if (def.builder === "fern" || def.builder === "palmFrond") return bakeFernFoliage(seed, def);
  if (def.builder === "paddleLeaf" || def.builder === "heartLeaf") return bakeBroadLeafFoliage(seed, def, fronds);
  if (def.builder === "willowWhip") return bakeWillowFoliage(seed, def, stretch);
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

/**
 * One fern frond from (x, y): a stem setting off at `angle` (radians from straight up, positive to
 * the right) and curling by `curl` over its `length` - so a frond thrown out sideways arches over
 * and down - with `pairs` pairs of leaflets off it, angled forward towards the tip, longest a third
 * of the way along and tapering to nothing at the tip. The far-side leaflets are painted first and
 * darker, so the frond reads as a spray with a front and a back.
 */
function paintFrond(painter: Painter, rng: () => number, def: BushTexture, clip: Clip, cell: number, x: number, y: number, angle: number, curl: number, length: number, sweep = 0.45): void {
  const palm = def.builder === "palmFrond";
  const steps = 24;
  const points: { x: number; y: number; heading: number }[] = [];
  let px = x;
  let py = y;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const heading = angle + curl * t * t;
    points.push({ x: px, y: py, heading });
    px += Math.sin(heading) * (length / steps);
    py -= Math.cos(heading) * (length / steps);
  }
  const leafletAt = (t: number, back: boolean): void => {
    const f = t * steps;
    const i = Math.min(steps - 1, Math.floor(f));
    const k = f - i;
    const a = points[i];
    const b = points[i + 1];
    const bx = a.x + (b.x - a.x) * k;
    const by = a.y + (b.y - a.y) * k;
    const heading = a.heading + (b.heading - a.heading) * k;
    // Longest a third of the way up, nothing at the tip, shorter again at the base.
    // A palm's leaflets are near one length, tapering only towards the tip.
    const size = palm ? Math.min(1, t * 8) * Math.pow(Math.max(0, 1 - t), 0.35) * (0.93 + rng() * 0.07) : Math.sin(Math.PI * Math.pow(t, 0.75)) * (0.7 + rng() * 0.3);
    const leafLength = def.leafLength * cell * size;
    const leafWidth = def.leafWidth * cell * size;
    if (leafLength < 1.5) return;
    const tone = palm ? Math.min(1, 0.35 + t * 0.35 + rng() * 0.1) : Math.min(1, t * 0.6 + rng() * 0.4);
    const base = [0, 1, 2].map((c) => def.dark[c] + (def.light[c] - def.dark[c]) * tone);
    const brightness = (palm ? 0.85 + 0.15 * t + rng() * 0.05 : 0.75 + 0.3 * t + rng() * 0.15) * (back ? 0.7 : 1);
    for (const side of [-1, 1]) {
      // Out to the side of the stem, swept forward towards its tip.
      const out = heading + side * (Math.PI / 2 - sweep);
      painter.leaf(bx, by, Math.sin(out), -Math.cos(out), leafLength, leafWidth, base, brightness, clip);
    }
  };
  for (let p = 0; p < def.leaves; p++) leafletAt(0.08 + (0.92 * (p + 0.3)) / def.leaves, true);
  for (let i = 0; i < steps; i++) {
    const a = points[i];
    const b = points[i + 1];
    const r = cell * 0.007 * (1 - (i / steps) * 0.8);
    painter.stem(a.x, a.y, b.x, b.y, r, r * 0.9, def.stem, clip);
  }
  for (let p = 0; p < def.leaves; p++) leafletAt(0.08 + (0.92 * (p + 0.75)) / def.leaves, false);
}

/**
 * A fern atlas: four single fronds, one per cell, each rising straight from the cell's bottom to near
 * its top - laid along a fern's frond strips (see treeGenerator.ts's generateFronds), which do the
 * bending. `stems` is unused: the plant's fronds are its geometry.
 */
function bakeFernFoliage(seed: number, def: BushTexture): Uint8Array {
  const size = FOLIAGE_TEXTURE_SIZE;
  const cell = size / 2;
  const painter = new Painter(size);
  for (let variant = 0; variant < 4; variant++) {
    const rng = mulberry32(seed + variant * 7919);
    const clip = cellClip(cell, variant);
    // Drawn wide, its leaflets near square to the stem: a frond strip is several times longer than
    // it is wide, so laid on one the frond is squeezed sideways and its leaflets end up swept
    // forward the way a fern's are.
    paintFrond(painter, rng, def, clip, cell, clip.x0 + cell / 2, clip.y1 - 2, 0, 0, cell * 0.95, 0.12);
  }
  return painter.finish();
}

/**
 * A broad-leaf atlas: one big leaf per cell, standing on its stalk - the stalk down the middle of the
 * cell's bottom FROND_STALK_SHARE, the blade over the rest, tip at the top - laid along a frond strip
 * with a `stalk` (see treeGenerator.ts's generateFronds). A banana's paddle ("paddleLeaf"): long,
 * blunt-ended, a pale midrib, fine veins running out from it at a slant, torn from the edge towards
 * the midrib here and there. Or an elephant ear's heart ("heartLeaf"): two rounded lobes either side
 * of the notch where the stalk joins, a pointed tip, pale veins fanning out from the join.
 *
 * The stalk runs on up the blade, into its midrib, as wide as the plant's own stalk is for its blade
 * (from its `fronds`), so the stem carries on across the join at one width.
 */
function bakeBroadLeafFoliage(seed: number, def: BushTexture, fronds: Fronds | null): Uint8Array {
  const size = FOLIAGE_TEXTURE_SIZE;
  const cell = size / 2;
  const painter = new Painter(size);
  const heart = def.builder === "heartLeaf";
  const halfWidth = def.leafWidth;
  // A pixel's size in the cell's 0-1 units, across (u runs -1 to 1, so twice) and along.
  const pxU = 2 / cell;
  const pxV = 1 / cell;
  const smooth = (edge0: number, edge1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };
  for (let variant = 0; variant < 4; variant++) {
    const rng = mulberry32(seed + variant * 7919);
    const clip = cellClip(cell, variant);
    const tears = Array.from({ length: heart ? 0 : def.leaves }, () => ({
      at: 0.15 + rng() * 0.8,
      side: rng() < 0.5 ? -1 : 1,
      depth: 0.35 + rng() * 0.6,
      slope: 0.08 + rng() * 0.12,
      gap: 0.002 + rng() * 0.006,
    }));
    const toneShift = (rng() - 0.5) * 0.2;
    // Where the stalk meets the blade, in blade units (0 at its base, 1 at its tip).
    const join = heart ? 0.16 : 0;
    // The stalk's half-width on the blade, in u: its width over the blade's. Below the blade, the
    // stalk strip shows the middle of a wider painted stem, so it is all stem.
    const onBlade = fronds?.stalk ? fronds.stalk.width / fronds.width : 0.06;
    const stem = (u: number, v: number): [number, number, number, number] | null => {
      const b = (v - FROND_STALK_SHARE) / (1 - FROND_STALK_SHARE);
      // Up the blade it narrows into the midrib, a little past the join.
      const r = v < FROND_STALK_SHARE ? FROND_STALK_HALF_WIDTH * 2 * 1.5 : onBlade * (1 - 0.6 * smooth(join, join + 0.15, b));
      if (b > join + 0.15 || Math.abs(u) > r + pxU) return null;
      const cover = Math.min(1, Math.max(0, (r - Math.abs(u)) / pxU + 0.5));
      const across = Math.min(1, Math.abs(u) / r);
      const shade = 0.6 + 0.4 * Math.sqrt(1 - across * across) - 0.1 * Math.sign(u) * across;
      return [cover, def.stem[0] * shade, def.stem[1] * shade, def.stem[2] * shade];
    };
    painter.fill(clip, (x, y) => {
      const u = (x - 0.5) * 2;
      const b = (y - FROND_STALK_SHARE) / (1 - FROND_STALK_SHARE);
      const au = Math.abs(u);
      let half: number;
      if (heart) {
        // An ellipse widest a third of the way up, pinched to a point at the tip, rounded off at
        // the lobes' bottoms, with the notch cut up into it between them.
        half = halfWidth * Math.sqrt(Math.max(0, 1 - ((b - 0.36) / 0.68) ** 2));
        if (b > 0.62) half *= Math.pow(Math.min(1, Math.max(0, (1.02 - b) / 0.4)), 0.7);
        half *= Math.sqrt(Math.min(1, Math.max(0, (b + 0.06) / 0.12)));
        if (b < join && au < 0.42 * (join - b) / join) half = 0;
      } else {
        // A long paddle: narrowing into the stalk, near parallel-sided, a blunt rounded tip.
        half = halfWidth * Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, b)) * 0.97 + 0.03)), 0.3);
        half *= smooth(-0.02, 0.12, b);
        // Rounded off inside the cell, not cut by its top edge.
        if (b > 0.78) half *= Math.sqrt(Math.max(0, 1 - ((b - 0.78) / 0.19) ** 2));
      }
      const edge = (half - au) / pxU;
      let cover = b < 0 || b > 0.99 ? 0 : Math.min(1, Math.max(0, edge + 0.5));
      // Torn: slits in from the edge, running back towards the stalk as they near the midrib.
      for (const tear of tears) {
        if (Math.sign(u) !== tear.side || au < half * (1 - tear.depth)) continue;
        const line = b - (tear.at - au * tear.slope);
        if (Math.abs(line) < tear.gap) cover *= Math.min(1, Math.max(0, (Math.abs(line) - tear.gap) / pxV + 1));
      }
      const blade = cover > 0;
      const stalk = stem(u, y);
      if (!blade) return stalk;
      // Tone: darker at the join, fresher towards the tip and the edges; one half a shade lighter.
      const tone = Math.min(1, Math.max(0, 0.25 + 0.45 * b + 0.25 * (au / Math.max(0.05, half)) + toneShift));
      let shade = (u > 0 ? 1.06 : 0.92) * (0.8 + 0.2 * Math.min(1, edge / 6));
      let vein = 0;
      if (heart) {
        // Veins fan from the join.
        const angle = Math.atan2(u, b - join);
        const spacing = Math.PI / Math.max(3, def.leaves);
        const k = Math.abs(((angle / spacing) % 1 + 1) % 1 - 0.5) * 2;
        vein = smooth(0.82, 0.97, k) * smooth(0, 0.08, Math.hypot(u, b - join));
        if (au < 0.012 && b > join) vein = 1;
      } else {
        // A midrib, and fine veins out from it at a slant.
        if (au < 0.022) vein = 1;
        const k = (((b - au * 0.35) * 90) % 1 + 1) % 1;
        shade *= 0.94 + 0.06 * smooth(0.2, 0.5, Math.abs(k - 0.5) * 2);
      }
      const colour = [0, 1, 2].map((c) => (def.dark[c] + (def.light[c] - def.dark[c]) * tone) * shade);
      const veinColour = [0, 1, 2].map((c) => def.light[c] * 1.15 + 0.05);
      const mixed = colour.map((c, i) => c + (veinColour[i] - c) * vein * 0.7);
      return [cover, mixed[0], mixed[1], mixed[2]];
    });
  }
  return painter.finish();
}

/**
 * A willow atlas: each cell one tile of a whip, repeated end to end down it (see treeGenerator.ts's
 * LeafBuilder.ribbon) - a straight stem down the middle, and `leaves` narrow, pointed leaves off it,
 * alternately left and right, spread evenly up the whole stem and angled up towards the cell's top
 * (the whip's tip, which hangs down), each its own length and shade, the ones behind the stem
 * darker. Seamless: a leaf running over the cell's top is painted again a cell lower, where the next
 * tile carries it on. `leafLength`/`leafWidth` are fractions of the whip's width.
 *
 * A tile may be `stretch` times longer than the whip is wide: the cell then holds that many widths of
 * whip - `stretch` times the leaves - every one squashed down by as much, to come out leaf-shaped on
 * it. Fewer, longer tiles, fewer quads.
 */
function bakeWillowFoliage(seed: number, def: BushTexture, stretch: number): Uint8Array {
  const size = FOLIAGE_TEXTURE_SIZE;
  const cell = size / 2;
  const painter = new Painter(size);
  for (let variant = 0; variant < 4; variant++) {
    const rng = mulberry32(seed + variant * 7919);
    const clip = cellClip(cell, variant);
    const x = clip.x0 + cell / 2;
    const bottom = clip.y1;
    const leafAt = (back: boolean): void => {
      const count = Math.round(def.leaves * stretch);
      for (let i = 0; i < count; i++) {
        if ((i % 3 === 0) !== back) continue;
        const side = i % 2 === 0 ? -1 : 1;
        const angle = side * (0.6 + rng() * 0.35);
        const onWhip = def.leafLength * cell * (0.85 + rng() * 0.3);
        // Squashed down by the stretch: its run along the whip shortened, its reach across kept.
        const dx = Math.sin(angle) * onWhip;
        const dy = (Math.cos(angle) * onWhip) / stretch;
        const leafLength = Math.hypot(dx, dy);
        const leafWidth = def.leafWidth * cell * (0.85 + rng() * 0.3) * (0.5 + 0.5 / stretch);
        // Spread evenly up the whole stem.
        const y = bottom - ((i + 0.5 + (rng() - 0.5) * 0.4) / count) * cell;
        const tone = Math.min(1, 0.3 + rng() * 0.6);
        const base = [0, 1, 2].map((c) => def.dark[c] + (def.light[c] - def.dark[c]) * tone);
        const brightness = (0.85 + rng() * 0.25) * (back ? 0.75 : 1);
        // Painted again a cell lower, so what runs over the top carries on at the next tile's bottom.
        for (const shift of [0, cell]) painter.leaf(x, y + shift, dx / leafLength, -dy / leafLength, leafLength, leafWidth, base, brightness, clip);
      }
    };
    leafAt(true);
    painter.stem(x, clip.y0, x, clip.y1, cell * 0.012, cell * 0.012, def.stem, clip);
    leafAt(false);
  }
  return painter.finish();
}

/** How far in from its cell's corners a fir spray's stem starts and ends, as a fraction of the cell. */
const FIR_SPRAY_MARGIN = 0.05;
/** How much of the diamond round a fir spray's stem it may fill - its widest, halfway along. */
const FIR_SPRAY_FILL = 0.8;

/**
 * A conifer atlas: four variants of a fir-branch spray, each drawn along its cell's diagonal - the
 * stem from near the top-left corner to near the bottom-right, the way a cone panel runs from the
 * trunk to the rim (see treeGenerator.ts's conePanel) - with side twigs off both sides angled
 * forward, towards the tip, every twig clothed in needle pairs angled the same way: dark old growth
 * near the stem, light fresh growth at the tips. Along the diagonal the spray has the most room a
 * square offers, the diamond between its corners, and it stays inside it - twigs longest halfway,
 * shorter towards both ends, and short enough that their needles never reach the cell's edge, so
 * no panel ever shows a spray cut off. Half the needles are painted before the twigs and darker, as
 * the far side of the spray, so the twigs show among them.
 */
export function bakeConiferFoliage(seed: number, def: ConiferTexture): Uint8Array {
  const size = FOLIAGE_TEXTURE_SIZE;
  const cell = size / 2;
  const painter = new Painter(size);

  for (let variant = 0; variant < 4; variant++) {
    const rng = mulberry32(seed + variant * 7919);
    const clip = cellClip(cell, variant);
    const needleLength = def.needleLength * cell;
    const needleWidth = def.needleWidth * cell;
    const gap = Math.max(1.5, def.needleGap * cell);

    // The stem's line, in pixels: from `start` along `axis` for `length`, with `across` at right
    // angles to it (towards the top-right corner).
    const start: [number, number] = [clip.x0 + cell * FIR_SPRAY_MARGIN, clip.y0 + cell * FIR_SPRAY_MARGIN];
    const length = Math.SQRT2 * cell * (1 - 2 * FIR_SPRAY_MARGIN);
    const axis: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
    const across: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
    const at = (along: number, side: number): [number, number] => [
      start[0] + axis[0] * along * length + across[0] * side,
      start[1] + axis[1] * along * length + across[1] * side,
    ];
    // How far from the stem a twig's tip may reach, `along` the way down it: the diamond, less the
    // reach of the needles at a twig's tip (they point on past it) so they stay inside too.
    const room = (along: number): number => Math.max(0, Math.min(along, 1 - along) * length * FIR_SPRAY_FILL - needleLength * 1.6);

    const twigs: { points: [number, number][]; radius: number }[] = [];
    const bow = (rng() - 0.5) * cell * 0.05;
    // The stem stops a needle's length short of the corner: the needles at its end point on past it.
    const stemEnd = 1 - (needleLength * 1.3) / length;
    const stem: [number, number][] = [];
    for (let i = 0; i <= 12; i++) {
      const t = (i / 12) * stemEnd;
      stem.push(at(t, bow * Math.sin(Math.PI * t)));
    }
    twigs.push({ points: stem, radius: cell * 0.009 });
    for (const side of [-1, 1]) {
      for (let k = 0; k < def.twigs; k++) {
        const t = 0.05 + (0.85 * (k + 0.3 + rng() * 0.4)) / def.twigs;
        // Angled forward, towards the stem's tip, and long enough for the tip to reach the room
        // there is where it ends - found by a few steps of refining where that is.
        const angle = (38 + rng() * 22) * (Math.PI / 180);
        let reach = room(t);
        for (let i = 0; i < 4; i++) reach = room(Math.min(1, t + (reach * Math.cos(angle)) / length)) / Math.sin(angle);
        reach *= 0.7 + rng() * 0.3;
        const curl = (rng() - 0.3) * 0.25;
        const origin = at(t, bow * Math.sin(Math.PI * t));
        const points: [number, number][] = [];
        for (let i = 0; i <= 6; i++) {
          const u = i / 6;
          const a = angle + curl * u;
          const forward = Math.cos(a) * reach * u;
          const out = side * Math.sin(a) * reach * u;
          points.push([origin[0] + axis[0] * forward + across[0] * out, origin[1] + axis[1] * forward + across[1] * out]);
        }
        twigs.push({ points, radius: cell * 0.005 });
      }
    }

    interface Needle {
      x: number;
      y: number;
      dirX: number;
      dirY: number;
      age: number;
      back: boolean;
      scale: number;
    }
    const needles: Needle[] = [];
    for (const twig of twigs) {
      const { points } = twig;
      let travelled = 0;
      const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
      const total = lengths.reduce((a, b) => a + b, 0);
      for (let i = 0; i < lengths.length; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[i + 1];
        const dx = (x1 - x0) / lengths[i];
        const dy = (y1 - y0) / lengths[i];
        for (let d = 0; d < lengths[i]; d += gap) {
          const along = (travelled + d) / total;
          const x = x0 + dx * d;
          const y = y0 + dy * d;
          for (const side of [-1, 1]) {
            // Angled forward, towards the twig's tip, and splayed a little at random.
            const a = side * (0.75 + (rng() - 0.5) * 0.5);
            const nx = dx * Math.cos(a) - dy * Math.sin(a);
            const ny = dx * Math.sin(a) + dy * Math.cos(a);
            needles.push({ x, y, dirX: nx, dirY: ny, age: along, back: rng() < 0.45, scale: 0.75 + rng() * 0.45 });
          }
        }
        travelled += lengths[i];
      }
    }

    const paintNeedles = (back: boolean): void => {
      for (const needle of needles) {
        if (needle.back !== back) continue;
        // Fresh growth at a twig's end is lighter; the far side of the spray is in shade.
        const fresh = Math.pow(needle.age, 2.2);
        const mix = Math.min(1, fresh * 0.85 + rng() * 0.25);
        const base = [0, 1, 2].map((c) => def.dark[c] + (def.light[c] - def.dark[c]) * mix);
        const brightness = (0.75 + 0.35 * rng()) * (back ? 0.7 : 1);
        const length = needleLength * needle.scale;
        painter.leaf(needle.x, needle.y, needle.dirX, needle.dirY, length, needleWidth, base, brightness, clip);
      }
    };

    paintNeedles(true);
    for (const twig of twigs) {
      const count = twig.points.length - 1;
      for (let i = 0; i < count; i++) {
        const [x0, y0] = twig.points[i];
        const [x1, y1] = twig.points[i + 1];
        painter.stem(x0, y0, x1, y1, twig.radius * (1 - 0.6 * (i / count)), twig.radius * (1 - 0.6 * ((i + 1) / count)), def.twig, clip);
      }
    }
    paintNeedles(false);
  }
  return painter.finish();
}
