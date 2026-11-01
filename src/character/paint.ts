import { addTime } from "./bodyTiming";
import { deriveSeed, mulberry32 } from "../world/rng";
import type { ColorTuple } from "../world/terrain/pipeline/pipelineTypes";
import type { AtlasLayout } from "./atlas";
import { smoothNormals } from "./atlas";
import type { BodyGeometry } from "./bodyMesh";
import { curveSampler } from "./curve";
import { sampleGearMaterial, type BakedGearMaterial } from "./gearMaterial";
import { PLAIN_HAIR, SEXES, SLIDERS, type HairStyle, type RaceDef, type Sex, type Slider } from "./raceDef";
import type { LookChoices } from "../sim/protocol";
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
  /** Factors on the race's lengths and girth, between its sliders' limits (raceDef.ts, withLook). */
  height: number;
  build: number;
  hairStyle: HairStyle;
}

/**
 * A character's looks from its seed - its sex too, unless one is given, and its sliders, unless
 * they are (each 0 at the race's low limit to 1 at its high one) - with what the player chose over
 * the seed's picks (FRONTEND.md, *Looks*). The seed is drawn from in the same order whatever was
 * chosen, so a choice changes only itself.
 */
export function chooseAppearance(race: RaceDef, seed: number, sex?: Sex, sliders: Partial<Record<Slider, number>> = {}, choices: LookChoices = {}): Appearance {
  const random = mulberry32(deriveSeed(seed, 0x6c6f6f6b));
  const index = (length: number): number => Math.floor(random() * length);
  const from = <T>(list: T[], rolled: number, chosen: number | undefined): T => list[chosen === undefined ? rolled : ((Math.round(chosen) % list.length) + list.length) % list.length];
  const rolledSex = SEXES[index(SEXES.length)];
  const chosenSex = sex ?? rolledSex;
  const skin = from(race.look.skin, index(race.look.skin.length), choices.skin);
  const hair = from(race.look.hair, index(race.look.hair.length), choices.hair);
  const eyes = from(race.look.eyes, index(race.look.eyes.length), choices.eyes);
  const beardRoll = random() < race.sexes[chosenSex].beard;
  const shift = (chosen: number | undefined): number => {
    const rolled = random() * 2 - 1;
    return chosen === undefined ? rolled : Math.max(-1, Math.min(1, chosen));
  };
  const eyeSpacing = shift(choices.eyeSpacing);
  const browTilt = shift(choices.browTilt);
  const mouthWidth = shift(choices.mouthWidth);
  const shaped = pickSliders(race, random, { height: choices.height ?? sliders.height, build: choices.build ?? sliders.build });
  // Drawn last, so looks from before there were styles keep every other pick.
  const styles = race.look.hairStyles;
  const hairStyle = styles.length > 0 ? from(styles, index(styles.length), choices.hairStyle) : PLAIN_HAIR;
  return {
    sex: chosenSex,
    skin,
    hair,
    eyes,
    beard: choices.beard === undefined ? beardRoll : choices.beard >= 0.5,
    eyeSpacing,
    browTilt,
    mouthWidth,
    ...shaped,
    hairStyle,
  };
}

function pickSliders(race: RaceDef, random: () => number, chosen: Partial<Record<Slider, number | undefined>>): Record<Slider, number> {
  const out = {} as Record<Slider, number>;
  for (const key of SLIDERS) {
    const [low, high] = race.sliders[key];
    const k = random();
    out[key] = low + (high - low) * Math.max(0, Math.min(1, chosen[key] ?? k));
  }
  return out;
}

/** Something worn painted on, until gear is (CHARACTERS.md, step 4): a material over the body
 *  between two heights. */
export interface PaintedCover {
  material: BakedGearMaterial;
  tint: ColorTuple;
  /** From and to: metres over the ground in the bind pose ("height"), or shares of each region's
   *  length from its top ("along"). */
  span: "height" | "along";
  from: number;
  to: number;
  /** The regions it covers. */
  regions: string[];
  /** A darker hem along its edges. */
  hem: boolean;
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
  return paintLook(preparePaint(body, layout, race, covers), layout, race, look);
}

/**
 * The same painting, a few milliseconds at a time: between slices it awaits `pause`, so the page
 * keeps drawing frames while a body is painted (a bandit camp coming into view, CREATURES.md).
 */
export async function paintAtlasSliced(body: BodyGeometry, layout: AtlasLayout, race: RaceDef, look: Appearance, covers: PaintedCover[], pause: () => Promise<void>, budgetMs = 4): Promise<Uint8Array> {
  const base = await sliced(prepareSteps(body, layout, race, covers), pause, budgetMs);
  return paintLookSliced(base, layout, race, look, pause, budgetMs);
}

/** What painting a body needs that does not depend on who it is: where the light and shadow fall,
 *  the skin's mottle, what is worn over it (already painted), the head's measures and the
 *  nipples' distances, and where empty texels take their colour from. It is all a character's
 *  painting reads of the body, so the layout's per-texel places can be let go once it is made. */
export interface PaintBase {
  size: number;
  /** Per texel: the light painted in (facing up, folds, toward the feet), and the skin's mottle. */
  shade: Float32Array;
  mottle: Float32Array;
  /** Per texel: whether something worn covers it, and then its pixel is in `worn`. */
  covered: Uint8Array;
  worn: Uint8Array;
  /** Per texel: the texel its pixels are copied from once painted (itself if painted, -1 if none). */
  source: Int32Array;
  /** The head's uncovered texels and, six a texel, where on the head they are (paintHead's inputs). */
  head: { index: Int32Array; values: Float64Array };
  /** The uncovered texels near a nipple, a pair for each nipple near one, and the distance. */
  nipples: { index: Int32Array; distance: Float64Array };
}

/** The painting that does not depend on a character's looks, made once for a body and the gear
 *  painted on it, then used for every character of that body (bodyCache.ts). */
export function preparePaint(body: BodyGeometry, layout: AtlasLayout, race: RaceDef, covers: PaintedCover[] = []): PaintBase {
  return run(prepareSteps(body, layout, race, covers));
}

export function preparePaintSliced(body: BodyGeometry, layout: AtlasLayout, race: RaceDef, covers: PaintedCover[], pause: () => Promise<void>, budgetMs = 4): Promise<PaintBase> {
  return sliced(prepareSteps(body, layout, race, covers), pause, budgetMs);
}

/** Paints one character's looks - skin, face, hair, beard - on a body's prepared painting. */
export function paintLook(base: PaintBase, layout: Pick<AtlasLayout, "texels">, race: RaceDef, look: Appearance): Uint8Array {
  return run(paintSteps(base, layout, race, look));
}

export function paintLookSliced(base: PaintBase, layout: Pick<AtlasLayout, "texels">, race: RaceDef, look: Appearance, pause: () => Promise<void>, budgetMs = 4): Promise<Uint8Array> {
  return sliced(paintSteps(base, layout, race, look), pause, budgetMs);
}

function run<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

async function sliced<T>(steps: Generator<void, T>, pause: () => Promise<void>, budgetMs: number): Promise<T> {
  for (;;) {
    const started = performance.now();
    let step = steps.next();
    while (!step.done && performance.now() - started < budgetMs) step = steps.next();
    addTime("4a paint cpu", performance.now() - started);
    if (step.done) return step.value;
    await pause();
  }
}

/** Texels painted between chances to stop. */
const PAINT_SLICE = 2048;

function* prepareSteps(body: BodyGeometry, layout: AtlasLayout, race: RaceDef, covers: PaintedCover[]): Generator<void, PaintBase> {
  const { size, texels } = layout;
  const count = size * size;
  const shade = new Float32Array(count);
  const mottle = new Float32Array(count);
  const covered = new Uint8Array(count);
  const worn = new Uint8Array(count * 4);
  const regionNames = body.regions.map((r) => r.name);
  const headRegion = regionNames.indexOf("head");
  const head = body.bones.find((b) => b.name === "head")!;
  const headFrame = frameFor(sub(head.tail, head.head), [0, 0, 1]);
  const headLength = length(sub(head.tail, head.head));
  const headWidth = curveSampler(race.shape.head.out)(0.55);
  const nipples = body.marks.filter((m) => m.name === "nipple");
  const occlusion = createOcclusion(body);
  const tall = Math.max(...body.positions.filter((_, i) => i % 3 === 1));
  const coverRegions = covers.map((c) => new Set(c.regions.map((name) => regionNames.indexOf(name))));
  const regionLengths = body.regions.map((r) => r.axis.slice(1).reduce((sum, p, i) => sum + length(sub(p, r.axis[i])), 0));
  const headIndex: number[] = [];
  const headValues: number[] = [];
  const nippleIndex: number[] = [];
  const nippleDistance: number[] = [];

  for (let o = 0; o < count; o++) {
    if (o % PAINT_SLICE === 0) yield;
    const region = texels.region[o];
    if (region < 0) continue;
    const px = texels.position[o * 3];
    const py = texels.position[o * 3 + 1];
    const pz = texels.position[o * 3 + 2];
    const nx = texels.normal[o * 3];
    const ny = texels.normal[o * 3 + 1];
    const nz = texels.normal[o * 3 + 2];
    const around = texels.surface[o * 2];
    const along = texels.surface[o * 2 + 1];
    mottle[o] = 0.96 + 0.06 * noise3(px * 40, py * 40, pz * 40);
    let worn_: [number, number, number] | null = null;
    for (let i = 0; i < covers.length; i++) {
      const c = covers[i];
      if (!coverRegions[i].has(region)) continue;
      // How far inside the cover the texel is, in metres from its nearer edge.
      const scale = c.span === "height" ? 1 : regionLengths[region];
      const at = c.span === "height" ? py : along / scale;
      const inside = Math.min(at - c.from, c.to - at) * (c.span === "height" ? 1 : scale);
      if (inside < 0) continue;
      const m = sampleGearMaterial(c.material, around, along);
      let color: [number, number, number] = [m[0] * c.tint[0], m[1] * c.tint[1], m[2] * c.tint[2]];
      if (c.hem && inside < 0.012) color = color.map((x) => x * 0.72) as [number, number, number];
      worn_ = color;
    }
    // Light painted in.
    const up = 0.5 + 0.5 * ny;
    const light = (0.8 + 0.22 * up) * (0.9 + 0.1 * Math.min(1, py / tall + 0.2)) * occlusion(px, py, pz, nx, ny, nz);
    shade[o] = light;
    if (worn_) {
      // What is worn hides the skin, the face and all.
      const color = worn_ as [number, number, number];
      covered[o] = 1;
      worn[o * 4] = clampByte(color[0] * light);
      worn[o * 4 + 1] = clampByte(color[1] * light);
      worn[o * 4 + 2] = clampByte(color[2] * light);
      worn[o * 4 + 3] = 255;
      continue;
    }
    if (region === headRegion) {
      const p: Vec = [px, py, pz];
      const n: Vec = [nx, ny, nz];
      const off = sub(p, head.head);
      headIndex.push(o);
      headValues.push(
        dot(off, [1, 0, 0]) / headWidth,
        dot(off, headFrame.along) / headLength,
        dot(n, headFrame.front),
        Math.atan2(dot(off, [1, 0, 0]), dot(off, headFrame.front)),
        around,
        along,
      );
    }
    for (const mark of nipples) {
      const d = Math.hypot(px - mark.position[0], py - mark.position[1], pz - mark.position[2]);
      if (d < 0.02) {
        nippleIndex.push(o);
        nippleDistance.push(d);
      }
    }
  }
  yield;
  return {
    size,
    shade,
    mottle,
    covered,
    worn,
    source: dilateSource(texels.region, size, Math.ceil(size / 16)),
    head: { index: Int32Array.from(headIndex), values: Float64Array.from(headValues) },
    nipples: { index: Int32Array.from(nippleIndex), distance: Float64Array.from(nippleDistance) },
  };
}

function* paintSteps(base: PaintBase, layout: Pick<AtlasLayout, "texels">, race: RaceDef, look: Appearance): Generator<void, Uint8Array> {
  const { size, shade, mottle, covered, source } = base;
  const { region } = layout.texels;
  const pixels = base.worn.slice();
  const skin = (o: number): [number, number, number] => [look.skin[0] * mottle[o], look.skin[1] * mottle[o], look.skin[2] * (mottle[o] * 0.98)];
  const put = (o: number, color: readonly number[]): void => {
    pixels[o * 4] = clampByte(color[0] * shade[o]);
    pixels[o * 4 + 1] = clampByte(color[1] * shade[o]);
    pixels[o * 4 + 2] = clampByte(color[2] * shade[o]);
    pixels[o * 4 + 3] = 255;
  };
  // Skin, mottled a little, wherever nothing is worn.
  for (let o = 0; o < size * size; o++) {
    if (o % PAINT_SLICE === 0) yield;
    if (region[o] >= 0 && !covered[o]) put(o, skin(o));
  }
  // The face and hair, on the head.
  const { index: headIndex, values } = base.head;
  for (let i = 0; i < headIndex.length; i++) {
    if (i % PAINT_SLICE === 0) yield;
    const o = headIndex[i];
    put(o, paintHead(skin(o), look, race.look.face, values[i * 6], values[i * 6 + 1], values[i * 6 + 2], values[i * 6 + 3], values[i * 6 + 4], values[i * 6 + 5]));
  }
  // Nipples where the race's bumps mark them: a darker areola, the nipple darker still.
  const tone: [number, number, number] = [look.skin[0] * 0.78, look.skin[1] * 0.58, look.skin[2] * 0.56];
  const { index: nippleIndex, distance } = base.nipples;
  let current = -1;
  let color: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < nippleIndex.length; i++) {
    const o = nippleIndex[i];
    if (o !== current) {
      if (current >= 0) put(current, color);
      current = o;
      color = skin(o);
    }
    const d = distance[i];
    const t = smooth(0.02, 0.014, d);
    color = [color[0] + (tone[0] - color[0]) * t, color[1] + (tone[1] - color[1]) * t, color[2] + (tone[2] - color[2]) * t];
    if (d < 0.006) color = [tone[0] * 0.85, tone[1] * 0.8, tone[2] * 0.8];
  }
  if (current >= 0) put(current, color);
  // Out far enough that no texel is left empty: a corner a little off its region still finds colour.
  for (let o = 0; o < source.length; o++) if (source[o] >= 0 && source[o] !== o) pixels.copyWithin(o * 4, source[o] * 4, source[o] * 4 + 4);
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

  // Hair: down to a hairline over the brow in front, to the nape behind, as its style moves them -
  // the sides above the ears shaved to stubble where it says, all of it thinner when cropped.
  const style = look.hairStyle;
  const back = Math.min(1, Math.max(0, (Math.abs(angle) - 1.0) / 0.9));
  const brow = face.hairline + style.hairline;
  const hairline = brow + style.temples * ax * ax + (style.nape - brow) * back;
  const strands = 0.82 + 0.28 * noise3(around * 120, along * 10, 0.5);
  const sides = style.shaved * smooth(0.32, 0.5, ax) * (1 - smooth(0.8, 0.9, H));
  const hair = smooth(hairline - 0.015, hairline + 0.015, H) * style.thickness * (1 - 0.75 * sides);
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
function createOcclusion(body: BodyGeometry): (px: number, py: number, pz: number, nx: number, ny: number, nz: number) => number {
  const P = body.positions;
  const normals = smoothNormals(body);
  const cell = 0.08;
  const reach = 0.16;
  // Vertices bucketed by cell under a numeric key (no strings: this runs for every texel).
  const OFFSET = 512;
  const SPAN = 1024;
  const key = (x: number, y: number, z: number): number => ((x + OFFSET) * SPAN + (y + OFFSET)) * SPAN + (z + OFFSET);
  const lists = new Map<number, number[]>();
  for (let v = 0; v < P.length / 3; v++) {
    const k = key(Math.floor(P[v * 3] / cell), Math.floor(P[v * 3 + 1] / cell), Math.floor(P[v * 3 + 2] / cell));
    let list = lists.get(k);
    if (!list) lists.set(k, (list = []));
    list.push(v);
  }
  const grid = new Map<number, Int32Array>([...lists].map(([k, list]) => [k, Int32Array.from(list)]));
  // The vertices in the 5x5x5 cells round a cell, in the order they are walked, made once per cell
  // however many texels fall in it.
  const near = new Map<number, Int32Array>();
  const neighbourhood = (cx: number, cy: number, cz: number): Int32Array => {
    const k = key(cx, cy, cz);
    let found = near.get(k);
    if (!found) {
      const ids: number[] = [];
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
        const list = grid.get(key(cx + dx, cy + dy, cz + dz));
        if (list) for (let i = 0; i < list.length; i++) ids.push(list[i]);
      }
      near.set(k, (found = Int32Array.from(ids)));
    }
    return found;
  };
  // Squared distances to compare before the exact test, with a margin so rounding never decides.
  const farthest = reach * reach * 1.000001;
  const nearest = 0.03 * 0.03 * 0.999999;
  return (px, py, pz, nx, ny, nz) => {
    const list = neighbourhood(Math.floor(px / cell), Math.floor(py / cell), Math.floor(pz / cell));
    let hidden = 0;
    for (let i = 0; i < list.length; i++) {
      const v = list[i] * 3;
      const x = P[v] - px;
      const y = P[v + 1] - py;
      const z = P[v + 2] - pz;
      const squared = x * x + y * y + z * z;
      if (squared > farthest || squared < nearest) continue;
      const distance = Math.sqrt(squared);
      if (distance < 0.03 || distance > reach) continue;
      const toward = (x * nx + y * ny + z * nz) / distance;
      if (toward <= 0.2) continue;
      // Only what faces back at it - the other side of a fold, not its own surface curving away.
      const facing = -(x * normals[v] + y * normals[v + 1] + z * normals[v + 2]) / distance;
      if (facing > 0) hidden += toward * facing * (1 - distance / reach);
    }
    return 1 - Math.min(0.45, hidden * 0.12);
  };
}

/** Where the texels no triangle covers take their pixels from, `passes` steps out: each takes the
 *  first filled one of its right, left, lower and upper neighbours as the last step had them. A
 *  painted texel is its own source; one never reached has none (-1). */
function dilateSource(region: Int16Array, size: number, passes: number): Int32Array {
  const source = new Int32Array(size * size);
  let filled = new Uint8Array(size * size);
  for (let i = 0; i < filled.length; i++) {
    filled[i] = region[i] >= 0 ? 1 : 0;
    source[i] = filled[i] ? i : -1;
  }
  let next = filled.slice();
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = y * size + x;
        if (filled[o]) continue;
        let q = -1;
        if (x + 1 < size && filled[o + 1]) q = o + 1;
        else if (x > 0 && filled[o - 1]) q = o - 1;
        else if (y + 1 < size && filled[o + size]) q = o + size;
        else if (y > 0 && filled[o - size]) q = o - size;
        if (q < 0) continue;
        source[o] = source[q];
        next[o] = 1;
        changed = true;
      }
    }
    if (!changed) break;
    const swap = filled;
    filled = next;
    next = swap;
    next.set(filled);
  }
  return source;
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
function hash3(a: number, b: number, c: number): number {
  let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 2147483647);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

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
  const x00 = mix(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u);
  const x10 = mix(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u);
  const x01 = mix(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u);
  const x11 = mix(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u);
  return mix(mix(x00, x10, v), mix(x01, x11, v), w) * 2 - 1;
}
