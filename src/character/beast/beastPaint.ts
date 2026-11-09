import { mulberry32, deriveSeed } from "../../world/rng";
import type { ColorTuple } from "../../world/terrain/pipeline/pipelineTypes";
import type { BeastDef, PaintLayer } from "./beastDef";
import { hashId, type BeastGeometry, type BeastTube } from "./beastBuild";
import { length, sub, type Vec } from "../skeleton";

/**
 * A beast's coat painted into its atlas (BEASTS.md, *Painted atlas*): every texel of a tube's rect
 * knows where on the bind-pose body it lies and which way it faces, so the coat, its markings, the
 * eyes and the painted light are rules of position and normal. The palette's colours are picked by
 * the individual's seed and moved toward its kind's tint. Also paints the cards' texture: a row per
 * mask and variant, its alpha cutting the strand's outline.
 */
export interface PaintedBeast {
  atlas: Uint8Array;
  size: number;
  cards: { pixels: Uint8Array; width: number; height: number } | null;
  /** The colours as picked, for anything drawn plain (a swatch, a capsule). */
  colours: Record<string, ColorTuple>;
}

export interface PaintOptions {
  seed: number;
  /** The kind's colour (its template look): the coat moves toward it, the markings with it. */
  tint?: ColorTuple;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: ColorTuple, b: ColorTuple, t: number): ColorTuple => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise in 3D, 0-1, smooth between lattice points `1/frequency` apart. */
function noise(p: Vec, frequency: number, seed: number): number {
  const x = p[0] * frequency;
  const y = p[1] * frequency;
  const z = p[2] * frequency;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  let total = 0;
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++) {
        const k = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
        total += k * hash3(xi + dx, yi + dy, zi + dz, seed);
      }
  return total;
}

/** The palette as this individual has it: one of each colour's choices, moved toward the tint. */
export function pickColours(def: BeastDef, seed: number, tint?: ColorTuple): Record<string, ColorTuple> {
  const rng = mulberry32(deriveSeed(seed >>> 0, hashId(def.id) ^ 0x5eed));
  const picked: Record<string, ColorTuple> = {};
  for (const [name, list] of Object.entries(def.paint.palette)) picked[name] = list[Math.floor(rng() * list.length) % list.length];
  picked.dark ??= mix(picked.coat, [0.05, 0.04, 0.04], 0.75);
  picked.eye ??= [0.75, 0.55, 0.15];
  picked.nose ??= [0.08, 0.07, 0.07];
  picked.horn ??= [0.85, 0.8, 0.68];
  picked.pale ??= mix(picked.coat, [0.95, 0.92, 0.85], 0.6);
  if (tint) {
    // The kind's colour is the new coat; every other colour moves as far as the coat did, so a frost
    // wolf's saddle is a paler grey, not the timber wolf's brown.
    const base = picked.coat;
    for (const name of Object.keys(picked)) {
      if (name === "eye" || name === "nose") continue;
      const c = picked[name];
      picked[name] = name === "coat" ? mix(c, tint, 0.8) : [clamp01(c[0] + (tint[0] - base[0]) * 0.7), clamp01(c[1] + (tint[1] - base[1]) * 0.7), clamp01(c[2] + (tint[2] - base[2]) * 0.7)];
    }
  }
  return picked;
}

export function paintBeast(def: BeastDef, body: BeastGeometry, options: PaintOptions): PaintedBeast {
  const size = body.atlasSize;
  const pixels = new Uint8Array(size * size * 4);
  const colours = pickColours(def, options.seed, options.tint);
  const rng = mulberry32(deriveSeed(options.seed >>> 0, hashId(def.id) ^ 0xa71a5));
  const noiseSeed = Math.floor(rng() * 1e9);
  // Which layers this individual has, and its scars.
  const layers = def.paint.layers.filter((layer) => rng() < layer.chance);
  const trunk = body.tubes[0];
  const scars: { a: Vec; b: Vec }[] = [];
  for (const layer of layers) {
    if (layer.kind !== "scars") continue;
    const n = 1 + Math.floor(rng() * 3 * layer.amount + 0.5);
    for (let s = 0; s < n; s++) {
      const k = 1 + Math.floor(rng() * (trunk.rings - 2));
      const j = Math.floor(rng() * trunk.columns);
      const at = vec(trunk.positions, k * trunk.columns + j);
      const dir: Vec = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
      const len = (layer.size || 0.12) * (0.6 + rng() * 0.8);
      const d = length(dir) || 1;
      scars.push({ a: at, b: [at[0] + (dir[0] / d) * len, at[1] + (dir[1] / d) * len, at[2] + (dir[2] / d) * len] });
    }
  }
  const eyeSize = def.paint.eyes.size;
  const headIndex = def.trunk.findIndex((s) => s.role === "head");

  const colourAt = (tube: BeastTube, p: Vec, n: Vec, ring: number, ringF: number): ColorTuple => {
    const segment = tube.kind === "trunk" ? def.trunk[tube.segment[ring]] : null;
    const name = segment ? segment.id : tube.limb;
    const whole = tube.whole[ring] + (tube.whole[Math.min(tube.rings - 1, ring + 1)] - tube.whole[ring]) * ringF;
    let c: ColorTuple = colours.coat;
    // Mottle: two scales of noise, the coat's own unevenness.
    const m = def.paint.mottle;
    const k = 1 + m * (noise(p, 14, noiseSeed) - 0.5) * 1.4 + m * (noise(p, 55, noiseSeed + 7) - 0.5) * 0.8;
    c = [c[0] * k, c[1] * k, c[2] * k];
    for (const layer of layers) {
      if (layer.on.length > 0 && !layer.on.includes(name)) continue;
      const w = layerWeight(layer, tube, p, n, whole, segment, ring, ringF, noiseSeed, scars);
      if (w > 0) c = mix(c, colours[layer.colour] ?? colours.coat, w * layer.amount);
    }
    // The nose: the snout's very tip, dark and a little shiny.
    if (tube.kind === "trunk" && headIndex === 0 && tube.segment[ring] === 0) {
      const t = ringT(tube, ring, ringF);
      const w = smooth(0.12, 0.04, t) * smooth(-0.6, 0.1, n[1] + n[2]);
      if (w > 0) c = mix(c, colours.nose, w);
    }
    // Eyes: an iris, a pupil, a glint; a darker ring round each.
    if (eyeSize > 0 && tube.kind === "trunk") {
      for (const eye of body.eyes) {
        const d = length(sub(p, eye));
        if (d > eyeSize * 1.6) continue;
        if (d > eyeSize) c = mix(c, colours.dark, 0.6 * smooth(eyeSize * 1.6, eyeSize, d));
        else {
          c = colours.eye;
          if (d < eyeSize * 0.45) c = [0.03, 0.03, 0.03];
          const glint = length(sub(p, [eye[0], eye[1] + eyeSize * 0.4, eye[2] + eyeSize * 0.3]));
          if (glint < eyeSize * 0.22) c = [0.95, 0.95, 0.92];
          if (def.paint.eyes.glow) c = mix(c, [1, 0.9, 0.5], 0.4);
          return c;
        }
      }
    }
    // Painted light: lighter on top, darker under; the limbs darker where they meet the body.
    let shade = 0.72 + 0.34 * clamp01(n[1] * 0.5 + 0.5);
    if (tube.kind === "limb") shade *= 0.8 + 0.2 * smooth(0, 0.18, whole);
    else for (const root of body.roots) shade *= 1 - 0.25 * smooth(root.radius * 1.4, root.radius * 0.5, length(sub(p, root.at)));
    return [clamp01(c[0] * shade), clamp01(c[1] * shade), clamp01(c[2] * shade)];
  };

  for (const tube of body.tubes) {
    const { rect } = tube;
    // A gutter of two texels round each rect, copying its edge, so mips do not bleed the background.
    for (let y = -2; y < rect.h + 2; y++) {
      const py = rect.y + y;
      if (py < 0 || py >= size) continue;
      const v = clamp01(y / Math.max(1, rect.h - 1));
      let ring = 0;
      while (ring < tube.rings - 2 && tube.v[ring + 1] < v) ring++;
      const span = tube.v[ring + 1] - tube.v[ring] || 1;
      const ringF = clamp01((v - tube.v[ring]) / span);
      for (let x = -2; x < rect.w + 2; x++) {
        const px = rect.x + x;
        if (px < 0 || px >= size) continue;
        const u = clamp01(x / Math.max(1, rect.w - 1)) * tube.columns;
        const j0 = Math.floor(u) % tube.columns;
        const j1 = (j0 + 1) % tube.columns;
        const fu = u - Math.floor(u);
        const p = bilinear(tube.positions, tube.columns, ring, j0, j1, fu, ringF);
        const n = normalised(bilinear(tube.normals, tube.columns, ring, j0, j1, fu, ringF));
        const c = colourAt(tube, p, n, ring, ringF);
        const o = (py * size + px) * 4;
        pixels[o] = c[0] * 255;
        pixels[o + 1] = c[1] * 255;
        pixels[o + 2] = c[2] * 255;
        pixels[o + 3] = 255;
      }
    }
  }
  // Swatches for the parts: their colour, darker at the root, lighter at the tip.
  for (const [name, rect] of Object.entries(body.swatches)) {
    const base = colours[name] ?? colours.horn;
    for (let y = -2; y < rect.h + 2; y++)
      for (let x = -2; x < rect.w + 2; x++) {
        const px = rect.x + x;
        const py = rect.y + y;
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        const t = clamp01(y / (rect.h - 1));
        const k = 0.7 + 0.45 * t;
        const o = (py * size + px) * 4;
        pixels[o] = clamp01(base[0] * k) * 255;
        pixels[o + 1] = clamp01(base[1] * k) * 255;
        pixels[o + 2] = clamp01(base[2] * k) * 255;
        pixels[o + 3] = 255;
      }
  }
  return { atlas: pixels, size, cards: paintCards(body, colours, noiseSeed), colours };
}

function layerWeight(layer: PaintLayer, tube: BeastTube, p: Vec, n: Vec, whole: number, segment: BeastDef["trunk"][number] | null, ring: number, ringF: number, seed: number, scars: { a: Vec; b: Vec }[]): number {
  const s = layer.size || 0.1;
  switch (layer.kind) {
    case "belly":
      return smooth(0.05, -0.6, n[1] + (noise(p, 9, seed + 3) - 0.5) * 0.25);
    case "back":
      return tube.kind === "trunk" ? smooth(0.3, 0.85, n[1] + (noise(p, 7, seed + 4) - 0.5) * 0.3) : 0;
    case "stripes": {
      if (tube.kind !== "trunk") return 0;
      const warp = (noise(p, 6, seed + 5) - 0.5) * 0.9;
      const wave = 0.5 + 0.5 * Math.sin(((p[2] + p[1] * 0.3) / s) * Math.PI * 2 + warp * 3);
      return smooth(0.62, 0.82, wave) * smooth(-0.55, -0.1, n[1]);
    }
    case "bands": {
      const wave = 0.5 + 0.5 * Math.sin((p[1] / s) * Math.PI * 2 + (noise(p, 8, seed + 6) - 0.5) * 2);
      return smooth(0.6, 0.8, wave);
    }
    case "spots": {
      let best = 0;
      const cx = Math.floor(p[0] / s);
      const cy = Math.floor(p[1] / s);
      const cz = Math.floor(p[2] / s);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const x = cx + dx;
            const y = cy + dy;
            const z = cz + dz;
            const centre: Vec = [(x + hash3(x, y, z, seed + 11)) * s, (y + hash3(x, y, z, seed + 12)) * s, (z + hash3(x, y, z, seed + 13)) * s];
            const r = s * (0.18 + 0.2 * hash3(x, y, z, seed + 14));
            best = Math.max(best, smooth(r, r * 0.7, length(sub(p, centre))));
          }
      return best;
    }
    case "socks":
      return tube.kind === "limb" ? smooth(1 - s - 0.06, 1 - s + 0.06, whole + (noise(p, 20, seed + 8) - 0.5) * 0.08) : 0;
    case "mask": {
      if (!segment || segment.role !== "head") return 0;
      const t = ringT(tube, ring, ringF);
      return smooth(s + 0.1, s - 0.1, t) * smooth(-0.9, -0.2, n[1] - 0.5);
    }
    case "scars": {
      let w = 0;
      for (const scar of scars) w = Math.max(w, smooth(0.012, 0.005, segmentDistance(p, scar.a, scar.b)));
      return w;
    }
  }
}

/** How far along its own segment a point between two rings is: where the next ring starts the next
 *  segment, this one's runs on to 1. */
function ringT(tube: BeastTube, ring: number, f: number): number {
  const next = Math.min(tube.rings - 1, ring + 1);
  const end = tube.segment[next] === tube.segment[ring] ? tube.along[next] : 1;
  return tube.along[ring] + (end - tube.along[ring]) * f;
}

function segmentDistance(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const t = clamp01(((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / Math.max(1e-9, ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]));
  return length(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
}

const vec = (a: Float32Array, i: number): Vec => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const normalised = (v: Vec): Vec => {
  const l = length(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

function bilinear(a: Float32Array, columns: number, ring: number, j0: number, j1: number, fu: number, fv: number): Vec {
  const r1 = ring + 1;
  const p00 = vec(a, ring * columns + j0);
  const p01 = vec(a, ring * columns + j1);
  const p10 = vec(a, r1 * columns + j0);
  const p11 = vec(a, r1 * columns + j1);
  const out: Vec = [0, 0, 0];
  for (let c = 0; c < 3; c++) out[c] = (p00[c] * (1 - fu) + p01[c] * fu) * (1 - fv) + (p10[c] * (1 - fu) + p11[c] * fu) * fv;
  return out;
}

/** Card texture: a row per mask and variant, strands cut by alpha, darker at their roots. */
function paintCards(body: BeastGeometry, colours: Record<string, ColorTuple>, seed: number): PaintedBeast["cards"] {
  const rows = body.cards.rows;
  if (rows.length === 0) return null;
  const width = 32;
  const rowHeight = 64;
  const height = rows.length * rowHeight;
  const pixels = new Uint8Array(width * height * 4);
  rows.forEach((row, index) => {
    const rng = mulberry32(seed + index * 7919);
    const base = colours[row.colour] ?? colours.coat;
    // Strands: a few tapering hairs, each its own length, lean and shade.
    const strands = Array.from({ length: 5 + Math.floor(rng() * 3) }, () => ({ x: 0.12 + rng() * 0.76, lean: (rng() - 0.5) * 0.4, width: 0.05 + rng() * 0.06, long: 0.7 + rng() * 0.3, shade: 0.85 + rng() * 0.3 }));
    for (let y = 0; y < rowHeight; y++) {
      const v = y / (rowHeight - 1);
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        let alpha = 0;
        let shade = 1;
        switch (row.mask) {
          case "strands":
            for (const s of strands) {
              if (v > s.long) continue;
              const centre = s.x + s.lean * v * v;
              const w = s.width * Math.pow(1 - v / s.long, 0.7) + 0.012;
              if (Math.abs(u - centre) < w) {
                alpha = 1;
                shade = s.shade;
              }
            }
            break;
          case "tuft": {
            const ragged = (hash3(x, y >> 2, index, seed) - 0.5) * 0.12;
            alpha = Math.abs(u - 0.5) < 0.46 * Math.pow(1 - v, 1.1) + ragged ? 1 : 0;
            break;
          }
          case "fringe": {
            const tooth = (u * 7) % 1;
            alpha = v < 0.45 + 0.5 * (1 - Math.abs(tooth - 0.5) * 2) ? 1 : 0;
            break;
          }
          case "frond": {
            const edge = 0.42 * Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.05)), 0.8) - 0.04 * Math.abs(Math.sin(v * 40));
            alpha = Math.abs(u - 0.5) < edge ? 1 : 0;
            if (Math.abs(u - 0.5) < 0.02) shade = 0.75;
            break;
          }
        }
        const k = (0.55 + 0.6 * v) * shade;
        const o = ((index * rowHeight + y) * width + x) * 4;
        pixels[o] = clamp01(base[0] * k) * 255;
        pixels[o + 1] = clamp01(base[1] * k) * 255;
        pixels[o + 2] = clamp01(base[2] * k) * 255;
        pixels[o + 3] = alpha ? 255 : 0;
      }
    }
  });
  return { pixels, width, height };
}
