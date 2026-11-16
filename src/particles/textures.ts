// Generated particle textures (see FEEDBACK.md, *Particles*): soft dots, sparks, stars, smoke
// puffs, flames, rings, runes and slashes, drawn from a few numbers in `particleTextures/` rather
// than painted. Each is greyscale with alpha - a particle's colour over life tints it - and every
// variant of every texture is packed into one atlas. Pure pixels: the probe renders them in Node.

import type { Reader } from "../world/content/contentReader";
import { deriveSeed, mulberry32 } from "../world/rng";

export const TEXTURE_KINDS = ["dot", "spark", "star", "smoke", "flame", "fire", "blaze", "ring", "rune", "slash", "web", "tangle"] as const;
export type TextureKind = (typeof TEXTURE_KINDS)[number];

export interface ParticleTextureDef {
  id: string;
  kind: TextureKind;
  /** Pixels a side: 16 to 256, a power of two. */
  size: number;
  /** How many different ones are drawn (smoke puffs, runes); a particle picks one at random. */
  variants: number;
  /** `dot`: how fast it falls off (higher harder). `spark`: how fast it fades along. */
  power: number;
  /** `spark`, `ring`, `slash`, `rune`: line width as a share of the size. */
  width: number;
  /** `ring`: its radius as a share of the half size. `slash`: the arc's sweep in degrees. */
  radius: number;
  sweep: number;
  /** `star`: its points. `web`: its spokes. */
  points: number;
  /** `rune`: how many strokes, low to high; and whether a circle surrounds them. `web`: how many
   *  concentric strands; `tangle`: how many threads across. */
  strokes: [number, number];
  ring: boolean;
  /** A soft halo added around what is drawn, 0..1. */
  glow: number;
  /** `smoke`, `flame`: how lumpy, 0..1. */
  rough: number;
}

const KEYS = ["kind", "size", "variants", "power", "width", "radius", "sweep", "points", "strokes", "ring", "glow", "rough"];

export function readParticleTexture(id: string, reader: Reader, value: unknown): ParticleTextureDef {
  const obj = reader.object(value, "");
  reader.onlyKeys(obj, "", KEYS);
  const size = reader.optionalNumber(obj, "size", "", 64, { min: 16, max: 256, integer: true });
  if ((size & (size - 1)) !== 0) reader.fail("size", "must be a power of two (16, 32, 64, 128 or 256)");
  let strokes: [number, number] = [3, 5];
  if (obj.strokes !== undefined) {
    if (typeof obj.strokes === "number") {
      const count = reader.number(obj, "strokes", "", { min: 1, max: 12, integer: true });
      strokes = [count, count];
    }
    else strokes = reader.range(obj, "strokes", "", { allowEqual: true });
  }
  return {
    id,
    kind: reader.oneOf(obj, "kind", "", TEXTURE_KINDS),
    size,
    variants: reader.optionalNumber(obj, "variants", "", 1, { min: 1, max: 32, integer: true }),
    power: reader.optionalNumber(obj, "power", "", 2, { min: 0.2, max: 16 }),
    width: reader.optionalNumber(obj, "width", "", 0.08, { min: 0.01, max: 0.5 }),
    radius: reader.optionalNumber(obj, "radius", "", 0.7, { min: 0.05, max: 1 }),
    sweep: reader.optionalNumber(obj, "sweep", "", 120, { min: 10, max: 360 }),
    points: reader.optionalNumber(obj, "points", "", 4, { min: 2, max: 16, integer: true }),
    strokes,
    ring: reader.boolean(obj, "ring", "", false),
    glow: reader.optionalNumber(obj, "glow", "", 0, { min: 0, max: 1 }),
    rough: reader.optionalNumber(obj, "rough", "", 0.5, { min: 0, max: 1 }),
  };
}

/** One variant's pixels: `size`² luminance and alpha, 0..1, row by row. */
export interface TexturePixels {
  size: number;
  luminance: Float32Array;
  alpha: Float32Array;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Value noise on a small periodic grid, smoothly interpolated: lumps for smoke and flames. */
function valueNoise(rng: () => number, cells: number): (x: number, y: number) => number {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  return (x, y) => {
    const fx = x * cells;
    const fy = y * cells;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const at = (cx: number, cy: number): number => grid[(((cy % cells) + cells) % cells) * cells + (((cx % cells) + cells) % cells)];
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const top = at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx;
    const bottom = at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx;
    return top * (1 - sy) + bottom * sy;
  };
}

/** Distance from p to the segment a-b. */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Draws one variant. Coordinates run -1..1 across the texture, y up; every shape fades to nothing
 * before the edge, so a sprite never shows its square.
 */
export function drawParticleTexture(def: ParticleTextureDef, variant: number): TexturePixels {
  const size = def.size;
  // A blaze's variants are the frames of one animation: the same noise, moved on.
  const rng = mulberry32(deriveSeed(hashId(def.id), def.kind === "blaze" ? 0 : variant));
  const luminance = new Float32Array(size * size).fill(1);
  const alpha = new Float32Array(size * size);
  const lumps = valueNoise(rng, 5);
  const fine = valueNoise(rng, 11);

  const count = def.strokes[0] + Math.floor(rng() * (def.strokes[1] - def.strokes[0] + 1));
  const segments = def.kind === "rune" ? runeStrokes(rng, count) : def.kind === "web" ? webStrands(rng, def.points, count, def.rough) : def.kind === "tangle" ? tangleThreads(rng, count) : [];

  // The distance to the nearest thread, worked out only near each thread (a web has a hundred).
  const near = new Float32Array(segments.length > 0 ? size * size : 0).fill(Infinity);
  if (segments.length > 0) {
    const reach = def.width * 11;
    const toPx = (v: number): number => ((v + 1) / 2) * size;
    for (const [ax, ay, bx, by] of segments) {
      const x0 = Math.max(0, Math.floor(toPx(Math.min(ax, bx) - reach)));
      const x1 = Math.min(size - 1, Math.ceil(toPx(Math.max(ax, bx) + reach)));
      const y0 = Math.max(0, Math.floor(toPx(-Math.max(ay, by) - reach)));
      const y1 = Math.min(size - 1, Math.ceil(toPx(-Math.min(ay, by) + reach)));
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const d = segmentDistance(((px + 0.5) / size) * 2 - 1, 1 - ((py + 0.5) / size) * 2, ax, ay, bx, by);
          if (d < near[py * size + px]) near[py * size + px] = d;
        }
      }
    }
  }

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 - 1;
      const y = 1 - ((py + 0.5) / size) * 2;
      const r = Math.hypot(x, y);
      let a = 0;
      let lum = 1;
      switch (def.kind) {
        case "dot":
          a = Math.pow(Math.max(0, 1 - r), def.power);
          break;
        case "spark": {
          // A streak along x: thin across, fading toward both ends, brightest just ahead of the middle.
          const across = Math.abs(y) / def.width;
          const along = Math.abs(x);
          a = Math.exp(-across * across * 2) * Math.pow(Math.max(0, 1 - along), def.power * 0.5);
          break;
        }
        case "star": {
          const angle = Math.atan2(y, x);
          const spike = Math.pow(Math.abs(Math.cos((angle * def.points) / 2)), 24 / def.power);
          a = Math.max(Math.pow(Math.max(0, 1 - r / (0.15 + 0.85 * spike)), 2), Math.pow(Math.max(0, 1 - r * 2.5), 2));
          break;
        }
        case "smoke": {
          const n = lumps((x + 1) / 2, (y + 1) / 2) * 0.7 + fine((x + 1) / 2, (y + 1) / 2) * 0.3;
          const edge = 0.55 + def.rough * 0.4 * (n - 0.5) * 2;
          a = smoothstep(edge, edge * 0.35, r) * (0.6 + 0.4 * n);
          lum = 0.65 + 0.35 * smoothstep(-0.8, 0.8, y + n * 0.4);
          break;
        }
        case "flame": {
          // A teardrop pointing up: wide and round below the middle, narrowing to a tip.
          const v = (y + 1) / 2;
          const halfWidth = 0.55 * Math.sqrt(Math.max(0, 1 - Math.pow((v - 0.3) / 0.7, 2))) * (v < 0.3 ? Math.sqrt(Math.max(0, v / 0.3)) : 1);
          const wobble = (lumps((x + 1) / 2, v * 0.8) - 0.5) * def.rough * 0.5;
          const across = Math.abs(x + wobble * v) / Math.max(0.001, halfWidth);
          a = smoothstep(1, 0.4, across) * smoothstep(0, 0.12, v) * smoothstep(1, 0.75, v);
          lum = 0.75 + 0.25 * smoothstep(1, 0, across);
          break;
        }
        case "fire": {
          // A hearth fire's tongue: ragged, streaked, hot and bright in its heart low down, darker and
          // thinner toward a torn tip. `rough` is how ragged.
          const v = (y + 1) / 2;
          const envelope = 0.52 * Math.pow(Math.max(0, 1 - Math.pow(v, 1.5)), 0.7) * smoothstep(0, 0.12, v);
          const tear = (lumps((x + 1) / 2, v * 1.7) - 0.5) * def.rough * 1.3 + (fine((x + 1) / 2 * 0.9, v * 3.1) - 0.5) * def.rough * 0.8;
          const d = 1 - Math.abs(x + tear * 0.35 * v) / Math.max(0.001, envelope) + tear * v * 0.6;
          a = smoothstep(0, 0.4, d) * smoothstep(1, 0.82, v) * smoothstep(0, 0.06, v);
          const streak = 0.82 + 0.3 * fine((x + 1) / 2 * 2.2, v * 0.6);
          lum = Math.min(1, (0.4 + 0.65 * smoothstep(0.05, 0.95, d) * (1 - v * 0.55)) * streak);
          break;
        }
        case "blaze": {
          // A whole fire, one frame of a loop: a broad base and tongues that lick up, the noise that
          // tears them rising frame by frame (periodic, so the last frame runs into the first).
          const s = variant / def.variants;
          const v = (y + 1) / 2;
          const xn = (x + 1) / 2;
          const sway = (lumps(xn, v * 0.8 - s) - 0.5) * 0.9 * def.rough * v + (fine(xn * 1.3, v * 1.6 - s * 2) - 0.5) * 0.5 * def.rough * v;
          // How high each part of the fire reaches: its tongues, rising and falling through the loop.
          const reach = 0.5 + 0.45 * lumps(xn * 1.1 + 0.3, s) + 0.2 * (fine(xn * 1.6, s * 2) - 0.5);
          const base = 0.56 * Math.pow(Math.max(0, 1 - Math.pow(v / Math.max(0.2, reach), 1.6)), 0.55) * smoothstep(0, 0.07, v);
          const d = 1 - Math.abs(x + sway) / Math.max(0.001, base);
          a = smoothstep(0, 0.35, d) * smoothstep(0, 0.05, v) * smoothstep(1, 0.88, v);
          const streak = 0.8 + 0.35 * fine(xn * 2.2, v * 0.7 - s);
          lum = Math.min(1, (0.3 + 0.8 * smoothstep(0.05, 0.9, d) * (1 - v * 0.6)) * streak);
          break;
        }
        case "ring": {
          const d = Math.abs(r - def.radius) / def.width;
          a = Math.exp(-d * d * 2.5);
          break;
        }
        case "rune": {
          const d = near[py * size + px];
          a = smoothstep(def.width, def.width * 0.4, d);
          if (def.ring) a = Math.max(a, smoothstep(def.width, def.width * 0.4, Math.abs(r - 0.8)));
          break;
        }
        case "web":
        case "tangle": {
          // Thin bright threads with a soft glow round them, so they show in daylight and in the dark.
          const d = near[py * size + px];
          const line = smoothstep(def.width, def.width * 0.25, d);
          const halo = 0.3 * Math.exp(-Math.pow(d / (def.width * 3.5), 2));
          // A bead of silk where the threads meet at the hub.
          const hub = def.kind === "web" ? smoothstep(def.width * 2.5, def.width * 0.8, r) : 0;
          a = Math.max(line, halo, hub * 0.9);
          break;
        }
        case "slash": {
          // An arc around the centre, thick in its middle and thin at its ends.
          const half = (def.sweep * Math.PI) / 360;
          const angle = Math.atan2(y, x) - Math.PI / 2;
          const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle));
          const along = Math.abs(wrapped) / half;
          if (along < 1) {
            const thick = def.width * (1 - along * along);
            a = smoothstep(thick, thick * 0.3, Math.abs(r - def.radius)) * (1 - along);
          }
          break;
        }
      }
      if (def.glow > 0) a = Math.max(a, def.glow * Math.pow(Math.max(0, 1 - r), 2.5));
      // Nothing reaches the edge: the outermost pixels are clear, so a sprite never shows its square.
      a *= smoothstep(0, Math.max(2, size * 0.06), Math.min(px, py, size - 1 - px, size - 1 - py));
      alpha[py * size + px] = Math.min(1, Math.max(0, a));
      luminance[py * size + px] = lum;
    }
  }
  return { size, luminance, alpha };
}

/**
 * An orb web's threads: `spokes` radial threads at slightly uneven angles and lengths from a hub a
 * little off the middle, and `rings` spiral strands across them, each strand sagging inward between
 * two spokes the way silk does, the last ones spaced closer. Coordinates run -1..1, y up.
 */
function webStrands(rng: () => number, spokes: number, rings: number, rough: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const hubX = (rng() - 0.5) * 0.08 * rough;
  const hubY = (rng() - 0.5) * 0.08 * rough;
  const angle0 = rng() * Math.PI * 2;
  const ends: { cos: number; sin: number; reach: number }[] = [];
  for (let k = 0; k < spokes; k++) {
    const a = angle0 + ((k + (rng() - 0.5) * 0.5 * rough) / spokes) * Math.PI * 2;
    const reach = 0.88 - rng() * 0.12 * rough;
    ends.push({ cos: Math.cos(a), sin: Math.sin(a), reach });
    out.push([hubX, hubY, hubX + Math.cos(a) * reach, hubY + Math.sin(a) * reach]);
  }
  for (let j = 1; j <= rings; j++) {
    // Close together near the hub, wider apart outward.
    const f = Math.pow(j / (rings + 0.35), 1.2);
    for (let k = 0; k < spokes; k++) {
      const a = ends[k];
      const b = ends[(k + 1) % spokes];
      const ra = f * a.reach * (1 + (rng() - 0.5) * 0.08 * rough);
      const rb = f * b.reach * (1 + (rng() - 0.5) * 0.08 * rough);
      const p: [number, number] = [hubX + a.cos * ra, hubY + a.sin * ra];
      const q: [number, number] = [hubX + b.cos * rb, hubY + b.sin * rb];
      // The strand sags toward the hub: one bend in the middle.
      const sag = 0.82 + 0.06 * rng();
      const mx = hubX + (p[0] - hubX + q[0] - hubX) / 2 * sag;
      const my = hubY + (p[1] - hubY + q[1] - hubY) / 2 * sag;
      out.push([p[0], p[1], mx, my], [mx, my, q[0], q[1]]);
    }
  }
  return out;
}

/** A wad of silk threads: `count` straight threads across a circle, a few doubled up, to wrap a body in. */
function tangleThreads(rng: () => number, count: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let k = 0; k < count; k++) {
    const a = rng() * Math.PI * 2;
    const b = a + Math.PI * (0.55 + rng() * 0.9);
    const ra = 0.78 + rng() * 0.12;
    const rb = 0.78 + rng() * 0.12;
    out.push([Math.cos(a) * ra, Math.sin(a) * ra, Math.cos(b) * rb, Math.sin(b) * rb]);
  }
  return out;
}

/**
 * A rune's strokes, cut the way runes are, not scribbled: a straight vertical stave (or two), with
 * short twigs at about 45° branching off it at the top, the middle or the bottom - often in mirror
 * pairs - and now and then a closed diamond instead. `strokes` is about how many lines it has.
 * Coordinates run -1..1, y up; everything stays inside a ring of radius 0.8.
 */
function runeStrokes(rng: () => number, strokes: number): [number, number, number, number][] {
  const top = 0.56;
  const out: [number, number, number, number][] = [];
  const kind = rng();
  if (kind < 0.12) {
    // A diamond, with crossing tails when there are strokes to spare.
    const w = 0.3;
    const h = strokes > 4 ? 0.3 : 0.45;
    out.push([0, h, w, 0], [w, 0, 0, -h], [0, -h, -w, 0], [-w, 0, 0, h]);
    if (strokes > 4) out.push([-w * 0.5, h * 0.5, w * 1.4, -top], [w * 0.5, h * 0.5, -w * 1.4, -top]);
    return out;
  }
  if (kind < 0.32) {
    // Two staves, joined by a crossbar, a cross or a diagonal.
    const x = 0.24;
    out.push([-x, -top, -x, top], [x, -top, x, top]);
    const join = rng();
    if (join < 0.34) out.push([-x, 0.15, x, -0.15]);
    else if (join < 0.67) out.push([-x, top, x, 0], [x, top, -x, 0]);
    else out.push([-x, top, x, -top], [x, top, -x, -top]);
    return out;
  }
  // One stave and its twigs.
  out.push([0, -top, 0, top]);
  const anchors = [top, top * 0.3, -top * 0.3, -top];
  const mirrored = rng() < 0.45;
  let twigs = Math.max(1, strokes - 1);
  while (twigs > 0 && anchors.length > 0) {
    const y = anchors.splice(Math.floor(rng() * anchors.length), 1)[0];
    // From the stave's ends twigs can only go inward; from the middle either way.
    const down = y === top ? true : y === -top ? false : rng() < 0.5;
    const length = 0.32 + rng() * 0.12;
    const dx = length * 0.72;
    const dy = (down ? -1 : 1) * length * 0.72;
    const side = rng() < 0.5 ? -1 : 1;
    out.push([0, y, side * dx, y + dy]);
    twigs--;
    if (mirrored && twigs > 0) {
      out.push([0, y, -side * dx, y + dy]);
      twigs--;
    }
  }
  return out;
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Where one variant sits in the atlas, in 0..1 texture coordinates. */
export interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface ParticleAtlas {
  size: number;
  /** RGBA, row by row from the top: luminance in RGB, alpha in A. */
  pixels: Uint8ClampedArray;
  /** By texture index, every variant's place. */
  rects: AtlasRect[][];
}

/** Packs every variant of every texture into the smallest square atlas they fit (256² to 4096²),
 *  largest first, in shelves. */
export function buildParticleAtlas(defs: readonly ParticleTextureDef[]): ParticleAtlas {
  for (let size = 256; ; size *= 2) {
    const atlas = packAtlas(defs, size);
    if (atlas || size >= 4096) {
      if (!atlas) throw new Error("particle textures do not fit a 4096² atlas");
      return atlas;
    }
  }
}

function packAtlas(defs: readonly ParticleTextureDef[], size: number): ParticleAtlas | null {
  const items = defs.flatMap((def, index) => Array.from({ length: def.variants }, (_, variant) => ({ def, index, variant, x: 0, y: 0 })));
  items.sort((a, b) => b.def.size - a.def.size || a.index - b.index || a.variant - b.variant);
  // Places first: shelves of the tallest left, left to right.
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const item of items) {
    if (x + item.def.size > size) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    if (y + item.def.size > size) return null;
    item.x = x;
    item.y = y;
    x += item.def.size;
    shelf = Math.max(shelf, item.def.size);
  }
  // Then the pixels.
  const pixels = new Uint8ClampedArray(size * size * 4);
  const rects: AtlasRect[][] = defs.map(() => []);
  for (const { def, index, variant, x: left, y: top } of items) {
    const drawn = drawParticleTexture(def, variant);
    for (let row = 0; row < def.size; row++) {
      for (let col = 0; col < def.size; col++) {
        const from = row * def.size + col;
        const to = ((top + row) * size + left + col) * 4;
        const lum = Math.round(drawn.luminance[from] * 255);
        pixels[to] = pixels[to + 1] = pixels[to + 2] = lum;
        pixels[to + 3] = Math.round(drawn.alpha[from] * 255);
      }
    }
    rects[index][variant] = { u0: left / size, v0: top / size, u1: (left + def.size) / size, v1: (top + def.size) / size };
  }
  return { size, pixels, rects };
}
