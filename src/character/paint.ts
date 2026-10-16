import { deriveSeed, mulberry32 } from "../world/rng";
import type { ColorTuple } from "../world/terrain/pipeline/pipelineTypes";
import type { AtlasLayout } from "./atlas";
import { smoothNormals } from "./atlas";
import type { BodyGeometry } from "./bodyMesh";
import { curveSampler } from "./curve";
import { sampleGearMaterial, type BakedGearMaterial } from "./gearMaterial";
import { SEXES, type RaceDef, type Sex } from "./raceDef";
import { dot, frameFor, length, sub, type Vec } from "./skeleton";

/** One character's looks, picked from its race's by its seed. */
export interface Appearance {
  sex: Sex;
  skin: ColorTuple;
  hair: ColorTuple;
  eyes: ColorTuple;
  beard: boolean;
  /** Small shifts of where the features sit and how big, so faces differ: -1 to 1 each. */
  eyeSpacing: number;
  browTilt: number;
  mouthWidth: number;
}

/** A character's looks from its seed - its sex too, unless one is given. */
export function chooseAppearance(race: RaceDef, seed: number, sex?: Sex): Appearance {
  const random = mulberry32(deriveSeed(seed, 0x6c6f6f6b));
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
  const rolled = pick([...SEXES]);
  const chosen = sex ?? rolled;
  return {
    sex: chosen,
    skin: pick(race.look.skin),
    hair: pick(race.look.hair),
    eyes: pick(race.look.eyes),
    beard: random() < race.sexes[chosen].beard,
    eyeSpacing: random() * 2 - 1,
    browTilt: random() * 2 - 1,
    mouthWidth: random() * 2 - 1,
  };
}

/** Something worn painted on, until gear is (CHARACTERS.md, step 4): a material over the body
 *  between two heights. */
export interface PaintedCover {
  material: BakedGearMaterial;
  tint: ColorTuple;
  /** From and to, in metres over the ground in the bind pose. */
  from: number;
  to: number;
  /** The regions it covers. */
  regions: string[];
}

/**
 * Paints a body's atlas (CHARACTERS.md, *Texture: a painted atlas*), texel by texel from what the
 * atlas says each one is: skin, mottled; the face drawn on the front of the head - eyes, brows,
 * nose, mouth - and hair and a beard; anything worn over that; and then light painted in, as a
 * hand-painted texture has it: brighter facing up, darker where the body folds in on itself (the
 * armpits, the crotch, under the chin) and a little darker toward the feet. Texels no triangle
 * covers take their neighbours' colour, so filtering never reaches the background.
 */
export function paintAtlas(body: BodyGeometry, layout: AtlasLayout, race: RaceDef, look: Appearance, covers: PaintedCover[] = []): Uint8Array {
  const { size, texels } = layout;
  const pixels = new Uint8Array(size * size * 4);
  const regionNames = body.regions.map((r) => r.name);
  const headRegion = regionNames.indexOf("head");
  const head = body.bones.find((b) => b.name === "head")!;
  const headFrame = frameFor(sub(head.tail, head.head), [0, 0, 1]);
  const headLength = length(sub(head.tail, head.head));
  const headWidth = curveSampler(race.shape.head.out)(0.55);
  const occlusion = createOcclusion(body);
  const tall = Math.max(...body.positions.filter((_, i) => i % 3 === 1));
  const coverRegions = covers.map((cover) => new Set(cover.regions.map((name) => regionNames.indexOf(name))));

  for (let o = 0; o < size * size; o++) {
    const region = texels.region[o];
    if (region < 0) continue;
    const p: Vec = [texels.position[o * 3], texels.position[o * 3 + 1], texels.position[o * 3 + 2]];
    const n: Vec = [texels.normal[o * 3], texels.normal[o * 3 + 1], texels.normal[o * 3 + 2]];
    const around = texels.surface[o * 2];
    const along = texels.surface[o * 2 + 1];
    let color: [number, number, number] = [...look.skin];
    // Skin, mottled a little.
    const mottle = 0.96 + 0.06 * noise3(p[0] * 40, p[1] * 40, p[2] * 40);
    color = [color[0] * mottle, color[1] * mottle, color[2] * (mottle * 0.98)];

    if (region === headRegion) {
      const off = sub(p, head.head);
      const X = dot(off, [1, 0, 0]) / headWidth;
      const H = dot(off, headFrame.along) / headLength;
      const forward = dot(off, headFrame.front);
      const facing = dot(n, headFrame.front);
      const angle = Math.atan2(dot(off, [1, 0, 0]), forward);
      color = paintHead(color, look, race.look.face, X, H, facing, angle, around, along);
    }

    // Nipples where the race's bumps mark them: a darker areola, the nipple darker still.
    for (const mark of body.marks) {
      if (mark.name !== "nipple") continue;
      const d = length(sub(p, mark.position));
      if (d < 0.02) {
        const tone: [number, number, number] = [look.skin[0] * 0.78, look.skin[1] * 0.58, look.skin[2] * 0.56];
        const t = smooth(0.02, 0.014, d);
        color = [color[0] + (tone[0] - color[0]) * t, color[1] + (tone[1] - color[1]) * t, color[2] + (tone[2] - color[2]) * t];
        if (d < 0.006) color = [tone[0] * 0.85, tone[1] * 0.8, tone[2] * 0.8];
      }
    }

    covers.forEach((cover, i) => {
      if (!coverRegions[i].has(region) || p[1] < cover.from || p[1] > cover.to) return;
      const m = sampleGearMaterial(cover.material, around, along);
      color = [m[0] * cover.tint[0], m[1] * cover.tint[1], m[2] * cover.tint[2]];
      // A darker hem along its edges.
      const edge = Math.min(p[1] - cover.from, cover.to - p[1]);
      if (edge < 0.012) color = color.map((c) => c * 0.72) as [number, number, number];
    });

    // Light painted in.
    const up = 0.5 + 0.5 * n[1];
    const shade = (0.8 + 0.22 * up) * (0.9 + 0.1 * Math.min(1, p[1] / tall + 0.2)) * occlusion(p, n);
    pixels[o * 4] = clampByte(color[0] * shade);
    pixels[o * 4 + 1] = clampByte(color[1] * shade);
    pixels[o * 4 + 2] = clampByte(color[2] * shade);
    pixels[o * 4 + 3] = 255;
  }
  // Out far enough that no texel is left empty: a corner a little off its region still finds colour.
  dilate(pixels, texels.region, size, Math.ceil(size / 16));
  return pixels;
}

/**
 * The face and hair on the head, from where a texel is in the head's own measures: X across (in
 * head widths from the middle), H up (0 at the jaw's hinge, 1 at the crown), and which way it
 * faces, at the heights the race's `face` gives. Features are soft-edged ellipses there, so they
 * hold at any atlas size.
 */
function paintHead(skin: [number, number, number], look: Appearance, face: RaceDef["look"]["face"], X: number, H: number, facing: number, angle: number, around: number, along: number): [number, number, number] {
  let color = skin;
  const front = facing > 0.25 ? Math.min(1, (facing - 0.25) / 0.25) : 0;
  const mix = (to: readonly number[], amount: number): void => {
    if (amount <= 0) return;
    color = [color[0] + (to[0] - color[0]) * amount, color[1] + (to[1] - color[1]) * amount, color[2] + (to[2] - color[2]) * amount];
  };
  const darken = (amount: number): void => mix([color[0] * 0.55, color[1] * 0.45, color[2] * 0.42], amount);
  const ax = Math.abs(X);
  const eyeX = 0.36 + look.eyeSpacing * 0.04;

  if (front > 0) {
    // Cheeks a little warmer.
    mix([skin[0] * 1.05, skin[1] * 0.82, skin[2] * 0.78], 0.35 * blob(ax, H, 0.5, 0.42, 0.2, 0.08) * front);
    // Eyes: a shadowed socket, the white, the iris and its pupil, a dark upper lid.
    const eyeH = face.eyes;
    darken(0.35 * blob(ax, H, eyeX, eyeH + 0.01, 0.24, 0.06) * front);
    mix([0.92, 0.9, 0.86], blob(ax, H, eyeX, eyeH, 0.15, 0.03) * front);
    mix(look.eyes, blob(ax, H, eyeX, eyeH - 0.002, 0.065, 0.026) * front);
    mix([0.06, 0.05, 0.05], blob(ax, H, eyeX, eyeH - 0.002, 0.03, 0.014) * front);
    mix([0.12, 0.08, 0.07], blob(ax, H, eyeX, eyeH + 0.027, 0.17, 0.008) * front);
    // Brows, the hair's colour, their outer ends tilted.
    const browH = face.brows + (ax - eyeX) * (0.06 * look.browTilt - 0.04);
    mix(scaleColor(look.hair, 0.85), blob(ax, H, eyeX + 0.02, browH, 0.21, 0.017) * front);
    // The nose: a shadow under it, a light down its ridge.
    darken(0.4 * blob(ax, H, 0, face.nose - 0.02, 0.15, 0.022) * front);
    mix(scaleColor(skin, 1.1), 0.4 * blob(ax, H, 0, (face.nose + face.eyes) / 2, 0.06, 0.06) * front);
    // The mouth: a dark line and a fuller lower lip.
    const mouthW = 0.24 + look.mouthWidth * 0.04;
    mix([skin[0] * 0.62, skin[1] * 0.38, skin[2] * 0.36], blob(ax, H, 0, face.mouth, mouthW, 0.011) * front);
    mix([skin[0] * 0.92, skin[1] * 0.66, skin[2] * 0.62], 0.7 * blob(ax, H, 0, face.mouth - 0.018, mouthW * 0.75, 0.014) * front);
    // Under the chin.
    darken(0.25 * smooth(face.mouth - 0.12, face.mouth - 0.22, H) * smooth(-0.15, 0.05, H) * front);
  }

  // Hair: down to a hairline over the brow in front, to the nape behind.
  const back = Math.min(1, Math.max(0, (Math.abs(angle) - 1.0) / 0.9));
  const hairline = face.hairline + 0.05 * ax * ax + (0.3 - face.hairline) * back;
  const strands = 0.82 + 0.28 * noise3(around * 120, along * 10, 0.5);
  const hair = smooth(hairline - 0.015, hairline + 0.015, H);
  mix(scaleColor(look.hair, strands), hair);

  if (look.beard && front > 0) {
    // A beard on the chin, narrowing up the jaw, and a moustache - leaving the lips and cheeks.
    const chin = smooth(face.mouth + 0.01, face.mouth - 0.035, H) * smooth(0.75 + (face.mouth - H) * 1.5, 0.55, ax) * smooth(face.mouth - 0.3, face.mouth - 0.24, H);
    const moustache = blob(ax, H, 0, face.mouth + 0.032, 0.3, 0.022);
    const lips = blob(ax, H, 0, face.mouth - 0.008, 0.2, 0.012);
    const beard = Math.max(chin, moustache) * (1 - lips);
    mix(scaleColor(look.hair, 0.95 * strands), beard * front);
  }
  return color;
}

/** How hidden a point of the body is by the body round it, as a shade (1 open, less in a fold): the
 *  body's vertices near it on the side its normal faces darken it. */
function createOcclusion(body: BodyGeometry): (p: Vec, n: Vec) => number {
  const P = body.positions;
  const normals = smoothNormals(body);
  const cell = 0.08;
  const reach = 0.16;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  for (let v = 0; v < P.length / 3; v++) {
    const k = key(Math.floor(P[v * 3] / cell), Math.floor(P[v * 3 + 1] / cell), Math.floor(P[v * 3 + 2] / cell));
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(v);
  }
  return (p, n) => {
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    const cz = Math.floor(p[2] / cell);
    let hidden = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          const list = grid.get(key(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const v of list) {
            const d: Vec = [P[v * 3] - p[0], P[v * 3 + 1] - p[1], P[v * 3 + 2] - p[2]];
            const distance = length(d);
            if (distance < 0.03 || distance > reach) continue;
            const toward = dot(d, n) / distance;
            // Only what faces back at it - the other side of a fold, not its own surface curving away.
            const facing = -(d[0] * normals[v * 3] + d[1] * normals[v * 3 + 1] + d[2] * normals[v * 3 + 2]) / distance;
            if (toward > 0.2 && facing > 0) hidden += toward * facing * (1 - distance / reach);
          }
        }
      }
    }
    return 1 - Math.min(0.45, hidden * 0.12);
  };
}

/** Copies colour into empty texels from filled ones beside them, `passes` texels out. */
function dilate(pixels: Uint8Array, region: Int16Array, size: number, passes: number): void {
  const filled = new Uint8Array(size * size);
  for (let i = 0; i < filled.length; i++) filled[i] = region[i] >= 0 ? 1 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const next = filled.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = y * size + x;
        if (filled[o]) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const q = ny * size + nx;
          if (!filled[q]) continue;
          pixels.copyWithin(o * 4, q * 4, q * 4 + 4);
          next[o] = 1;
          break;
        }
      }
    }
    filled.set(next);
  }
}

/** 1 inside an ellipse round (cx, cy), fading to 0 just outside it. */
function blob(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  const e = Math.hypot((x - cx) / rx, (y - cy) / ry);
  return smooth(1.15, 0.85, e);
}

/** 0 at `from`, 1 at `to`, smoothly - either way round. */
function smooth(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

function scaleColor(c: readonly number[], s: number): [number, number, number] {
  return [c[0] * s, c[1] * s, c[2] * s];
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** Smooth value noise, -1 to 1. */
function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number): number => {
    let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 2147483647);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const x00 = lerp(h(xi, yi, zi), h(xi + 1, yi, zi), u);
  const x10 = lerp(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u);
  const x01 = lerp(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u);
  const x11 = lerp(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}
