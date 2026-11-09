import type { PackSource } from "../../world/content/resolveContent";
import { ContentError, Reader, type ContentIssue, type RawObject } from "../../world/content/contentReader";
import type { ColorTuple } from "../../world/terrain/pipeline/pipelineTypes";
import type { CurvePoints } from "../curve";
import { characterEntries } from "../raceDef";

/**
 * A beast's body plan (beasts/<id>.json5, see BEASTS.md): a trunk of segments from the snout's tip
 * to the tail's, limb sets hanging off them, rigid parts, alpha cards, paint rules, gaits and clips.
 * The code knows trunks, limbs, parts, cards and gait patterns - never a wolf.
 */
export interface BeastDef {
  id: string;
  name: string;
  /** An individual's overall scale and girth are drawn from these by its seed. */
  size: [number, number];
  build: [number, number];
  /** Vertices round every trunk ring, and round every limb's. */
  verts: { trunk: number; limb: number };
  trunk: TrunkSegment[];
  /** The segment the others hang off: the skeleton's root. */
  root: string;
  limbs: LimbSet[];
  parts: PartDef[];
  cards: CardDef[];
  paint: PaintDef;
  gaits: GaitDef[];
  clips: Map<string, ClipDef>;
  /** Clips the engine plays by purpose: `attack` for a plain swing, `death` for dying. */
  actions: Record<string, string>;
  idle: IdleDef;
  /** How it lies dead when no `death` clip is named: rolled onto its `side` (a mammal), or onto its
   *  `back` with its legs curled (an insect, a spider). */
  dies: "side" | "back";
  /** Bones named by their use, for effects and sounds (FEEDBACK.md): `mouth`, `head`, `chest`, `tail`. */
  places: Record<string, string>;
  /** Named looks a creature kind can ask for (`look.beast: "wolf.frost"`): palette colours over the
   *  plan's, and other size and build ranges. A kind naming a variant the plan lacks is tinted
   *  toward its own colour instead. */
  variants: Map<string, BeastVariant>;
}

export interface BeastVariant {
  palette: Record<string, ColorTuple[]>;
  size?: [number, number];
  build?: [number, number];
}

/**
 * One body segment: a stretch of the trunk from its front end (t = 0) to its back end (t = 1).
 * `slope` is how far its front end rises over its back, in degrees. Its cross-section is three
 * profile curves - distance above the axis, below it, and to each side - filled between as a
 * superellipse of `round`. `rings` is how finely it is cut.
 */
export interface TrunkSegment {
  id: string;
  length: number;
  slope: number;
  up: CurvePoints;
  down: CurvePoints;
  side: CurvePoints;
  round: number;
  rings: number;
  /** What it does in idle and gaits: `head`, `neck`, `body`, `tail`. */
  role: "head" | "neck" | "body" | "tail";
}

/**
 * A set of limbs: `count` pairs (or one, `single`, on the middle) on segment `on`, `at` along it
 * (a range spreads the pairs between its ends), standing `out` to the side of its axis and `drop`
 * below it. Each limb is a chain of segments in a plane: its heading `yaw` (0 forward, 90 straight
 * out) splayed out by `splay`; a segment's `angle` is measured from straight down toward the heading.
 */
export interface LimbSet {
  id: string;
  on: string;
  count: number;
  single: boolean;
  at: [number, number];
  out: number;
  drop: number;
  yaw: [number, number];
  splay: number;
  /** Lengths of the first pair and the last, as factors (a spider's front legs longest). */
  scale: [number, number];
  segments: LimbSegment[];
  /** Whether it walks: a limb that does not (a raised arm, a pedipalp) only idles. */
  walks: boolean;
}

export interface LimbSegment {
  length: number;
  angle: number;
  /** Radius along it, [along, metres]; `depth` flattens it front to back (a paw's 0.6). */
  width: CurvePoints;
  depth: number;
  rings: number;
}

/**
 * A rigid part on a bone: a cone (an ear, a horn, a tusk, a fang, a claw, a spike) set on the
 * bone's surface `at` along it and `around` from the top (degrees, toward +x), pointing by `pitch`
 * (degrees up from the bone's own direction... see beastBuild.ts) and `yaw`, curving by `curve`.
 * `mirror` puts one on each side. `chance` and `scale` are rolled per individual.
 */
export interface PartDef {
  id: string;
  bone: string;
  shape: "cone" | "blade";
  at: number;
  around: number;
  /** How deep its root sinks into the surface, as a share of the surface's distance there. */
  sink: number;
  length: number;
  radius: number;
  /** Flattening across: 1 round, less a blade (an ear). */
  flat: number;
  /** Its direction in the body's frame, as [right, up, forward]: normalised. */
  direction: [number, number, number];
  curve: number;
  mirror: boolean;
  chance: number;
  scale: [number, number];
  colour: string;
  /** Traits that make it certain, and scale it by this much more. */
  traits: Record<string, number>;
}

/**
 * A group of alpha cards (BEASTS.md, *Alpha cards*): `count` strips rooted on a segment's surface
 * between `from` and `to` along it and `arc` round it about `around`, standing out `lean` from the
 * surface toward the back, `droop`ing, cut by the mask `mask`.
 */
export interface CardDef {
  id: string;
  bone: string;
  from: number;
  to: number;
  around: number;
  arc: number;
  count: number;
  length: [number, number];
  width: [number, number];
  /** How far it leans back along the body (0 standing straight out, 1 lying along it), and droops. */
  lean: number;
  droop: number;
  curl: number;
  mask: "strands" | "tuft" | "fringe" | "frond";
  colour: string;
  /** Free ends that sway with the body's motion. */
  soft: boolean;
  chance: number;
  traits: Record<string, number>;
  mirror: boolean;
}

/** Colours by name, each a list the seed picks from, then the paint layers. */
export interface PaintDef {
  palette: Record<string, ColorTuple[]>;
  /** How far the coat varies, texel to texel (0 smooth). */
  mottle: number;
  layers: PaintLayer[];
  eyes: { segment: string; at: number; around: number; size: number; colour: string; glow: boolean; count: number; style: "painted" | "detailed" };
}

export interface PaintLayer {
  kind: "belly" | "back" | "stripes" | "spots" | "socks" | "mask" | "scars" | "bands";
  colour: string;
  /** How strongly, 0-1. */
  amount: number;
  /** The segments or limb sets it paints (empty for all). */
  on: string[];
  /** Kind-specific: stripes' spacing (metres), spots' size, socks' reach (share of the leg). */
  size: number;
  chance: number;
}

/**
 * A gait: from `speed` metres a second (at size 1) up to the next gait's, a cycle covering `stride`
 * metres; its footfall `pattern` (BEASTS.md, *Range of the generator*); each foot down `duty` of the
 * cycle and lifted `lift` metres; the body bobbing `bob` metres, the trunk waving `wave` radians and
 * pitching `pitch`.
 */
export interface GaitDef {
  id: string;
  speed: number;
  stride: number;
  pattern: GaitPattern;
  duty: number;
  lift: number;
  bob: number;
  wave: number;
  pitch: number;
  /** How far forward and back of its rest a foot reaches, as a share of the stride (1 = all of it). */
  reach: number;
}

export type GaitPattern = "walk" | "trot" | "pace" | "bound" | "gallop" | "tripod" | "tetrapod" | "wave" | "metachronal";
export const GAIT_PATTERNS: readonly GaitPattern[] = ["walk", "trot", "pace", "bound", "gallop", "tripod", "tetrapod", "wave", "metachronal"];

/**
 * A clip: keyed turns on bones by name (`*` matching any letters, so `fore*` is every fore limb
 * bone), as degrees about the body's right, up and forward axes, and a whole-body offset in metres.
 * `layer`: "full" stands the legs still under it; "upper" plays over the gait. One-shot unless `loop`.
 */
export interface ClipDef {
  id: string;
  length: number;
  layer: "full" | "upper";
  loop: boolean;
  /** Held at its last key until stopped: a death. */
  hold: boolean;
  keys: { t: number; turns: Record<string, [number, number, number]>; offset: [number, number, number] }[];
}

export interface IdleDef {
  breathe: number;
  tail: number;
  head: number;
}

export function resolveBeasts(packs: PackSource[]): Map<string, BeastDef> {
  const issues: ContentIssue[] = [];
  const beasts = new Map<string, BeastDef>();
  for (const [id, entry] of characterEntries(packs, "beasts", issues)) beasts.set(id, readBeast(id, entry.data, new Reader(issues, entry.file)));
  if (issues.length > 0) throw new ContentError(issues);
  return beasts;
}

const TOP_KEYS = ["name", "size", "build", "verts", "trunk", "root", "limbs", "parts", "cards", "paint", "gaits", "clips", "actions", "idle", "dies", "places", "variants"];

export function readBeast(id: string, data: unknown, reader: Reader): BeastDef {
  const obj = reader.object(data, "");
  reader.onlyKeys(obj, "", TOP_KEYS);
  const verts = obj.verts === undefined ? {} : reader.object(obj.verts, "verts");
  reader.onlyKeys(verts, "verts", ["trunk", "limb"]);
  const trunk = reader.array(obj, "trunk", "").map((raw, i) => readSegment(raw, `trunk[${i}]`, reader));
  if (trunk.length === 0) reader.fail("trunk", "needs at least one segment");
  const ids = new Set(trunk.map((s) => s.id));
  const root = reader.string(obj, "root", "");
  if (root && !ids.has(root)) reader.fail("root", `no trunk segment "${root}"`);
  const limbs = reader.optionalArray(obj, "limbs", "").map((raw, i) => readLimb(raw, `limbs[${i}]`, reader, ids));
  const boneNames = new Set([...ids, ...limbs.flatMap(limbBoneNames)]);
  const parts = reader.optionalArray(obj, "parts", "").map((raw, i) => readPart(raw, `parts[${i}]`, reader, boneNames));
  const cards = reader.optionalArray(obj, "cards", "").map((raw, i) => readCards(raw, `cards[${i}]`, reader, boneNames));
  const paint = readPaint(obj.paint === undefined ? {} : reader.object(obj.paint, "paint"), reader, ids);
  const gaits = reader.optionalArray(obj, "gaits", "").map((raw, i) => readGait(raw, `gaits[${i}]`, reader)).sort((a, b) => a.speed - b.speed);
  const clips = new Map<string, ClipDef>();
  const rawClips = obj.clips === undefined ? {} : reader.object(obj.clips, "clips");
  for (const [clipId, raw] of Object.entries(rawClips)) clips.set(clipId, readClip(clipId, raw, `clips.${clipId}`, reader));
  const actions = stringRecord(obj.actions, "actions", reader);
  for (const [action, clip] of Object.entries(actions)) if (!clips.has(clip)) reader.fail(`actions.${action}`, `no clip "${clip}"`);
  const idle = obj.idle === undefined ? {} : reader.object(obj.idle, "idle");
  reader.onlyKeys(idle, "idle", ["breathe", "tail", "head"]);
  const variants = new Map<string, BeastVariant>();
  const rawVariants = obj.variants === undefined ? {} : reader.object(obj.variants, "variants");
  for (const [name, raw] of Object.entries(rawVariants)) {
    const path = `variants.${name}`;
    const v = reader.object(raw, path);
    reader.onlyKeys(v, path, ["palette", "size", "build"]);
    const palette: Record<string, ColorTuple[]> = {};
    const rawPalette = v.palette === undefined ? {} : reader.object(v.palette, `${path}.palette`);
    for (const [colour, list] of Object.entries(rawPalette)) palette[colour] = (Array.isArray(list) ? list : [list]).map((c, i) => reader.colorValue(c, `${path}.palette.${colour}[${i}]`));
    variants.set(name, { palette, size: v.size === undefined ? undefined : reader.range(v, "size", path, { allowEqual: true }), build: v.build === undefined ? undefined : reader.range(v, "build", path, { allowEqual: true }) });
  }
  const places = stringRecord(obj.places, "places", reader);
  for (const [place, bone] of Object.entries(places)) if (!boneNames.has(bone)) reader.fail(`places.${place}`, `no bone "${bone}"`);
  return {
    id,
    name: reader.string(obj, "name", ""),
    size: obj.size === undefined ? [1, 1] : reader.range(obj, "size", "", { allowEqual: true }),
    build: obj.build === undefined ? [1, 1] : reader.range(obj, "build", "", { allowEqual: true }),
    verts: { trunk: reader.optionalNumber(verts, "trunk", "verts", 12, { min: 4, max: 32, integer: true }), limb: reader.optionalNumber(verts, "limb", "verts", 7, { min: 3, max: 24, integer: true }) },
    trunk,
    root,
    limbs,
    parts,
    cards,
    paint,
    gaits,
    clips,
    actions,
    idle: { breathe: reader.optionalNumber(idle, "breathe", "idle", 1), tail: reader.optionalNumber(idle, "tail", "idle", 1), head: reader.optionalNumber(idle, "head", "idle", 1) },
    dies: obj.dies === undefined ? "side" : reader.oneOf(obj, "dies", "", ["side", "back"] as const),
    places,
    variants,
  };
}

/** A look's `beast` - "wolf" or "wolf.frost" - as a plan and a variant ("" for none). */
export function splitBeastLook(look: string): { plan: string; variant: string } {
  const dot = look.indexOf(".");
  return dot < 0 ? { plan: look, variant: "" } : { plan: look.slice(0, dot), variant: look.slice(dot + 1) };
}

/** The plan as a variant has it: its palette over the plan's, its ranges for size and build. */
export function withVariant(def: BeastDef, variant: string): BeastDef {
  const v = def.variants.get(variant);
  if (!v) return def;
  return { ...def, size: v.size ?? def.size, build: v.build ?? def.build, paint: { ...def.paint, palette: { ...def.paint.palette, ...v.palette } } };
}

/** The bones a limb set makes, in order: `<id><pair>L<k>` and `R`, the pair left out when there is one. */
export function limbBoneNames(set: LimbSet): string[] {
  const names: string[] = [];
  for (let pair = 0; pair < set.count; pair++) for (const side of set.single ? [""] : ["L", "R"]) for (let k = 0; k < set.segments.length; k++) names.push(limbBoneName(set, pair, side, k));
  return names;
}

export function limbBoneName(set: LimbSet, pair: number, side: string, k: number): string {
  return `${set.id}${set.count > 1 ? pair : ""}${side}${k}`;
}

/** The bones a name or a pattern (`*` any letters) picks out. */
export function bonesMatching(pattern: string, names: string[]): string[] {
  if (!pattern.includes("*")) return names.includes(pattern) ? [pattern] : [];
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return names.filter((n) => re.test(n));
}

function readSegment(raw: unknown, path: string, reader: Reader): TrunkSegment {
  const obj = reader.object(raw, path);
  reader.onlyKeys(obj, path, ["id", "length", "slope", "up", "down", "side", "round", "rings", "role"]);
  return {
    id: reader.string(obj, "id", path),
    length: reader.number(obj, "length", path, { min: 0.01, max: 20 }),
    slope: reader.optionalNumber(obj, "slope", path, 0, { min: -90, max: 90 }),
    up: readCurve(obj, "up", path, reader),
    down: readCurve(obj, "down", path, reader),
    side: readCurve(obj, "side", path, reader),
    round: reader.optionalNumber(obj, "round", path, 0.7, { min: 0, max: 1 }),
    rings: reader.optionalNumber(obj, "rings", path, 3, { min: 1, max: 24, integer: true }),
    role: obj.role === undefined ? "body" : reader.oneOf(obj, "role", path, ["head", "neck", "body", "tail"] as const),
  };
}

function readLimb(raw: unknown, path: string, reader: Reader, segments: Set<string>): LimbSet {
  const obj = reader.object(raw, path);
  reader.onlyKeys(obj, path, ["id", "on", "count", "single", "at", "out", "drop", "yaw", "splay", "scale", "segments", "walks"]);
  const on = reader.string(obj, "on", path);
  if (on && !segments.has(on)) reader.fail(`${path}.on`, `no trunk segment "${on}"`);
  const segs = reader.array(obj, "segments", path).map((s, i) => {
    const p = `${path}.segments[${i}]`;
    const seg = reader.object(s, p);
    reader.onlyKeys(seg, p, ["length", "angle", "width", "depth", "rings"]);
    return {
      length: reader.number(seg, "length", p, { min: 0.005, max: 20 }),
      angle: reader.number(seg, "angle", p, { min: -360, max: 360 }),
      width: readCurve(seg, "width", p, reader),
      depth: reader.optionalNumber(seg, "depth", p, 1, { min: 0.1, max: 4 }),
      rings: reader.optionalNumber(seg, "rings", p, 2, { min: 1, max: 12, integer: true }),
    };
  });
  if (segs.length === 0) reader.fail(`${path}.segments`, "needs at least one segment");
  return {
    id: reader.string(obj, "id", path),
    on,
    count: reader.optionalNumber(obj, "count", path, 1, { min: 1, max: 32, integer: true }),
    single: reader.boolean(obj, "single", path, false),
    at: numberOrRange(obj, "at", path, reader, 0.5),
    out: reader.optionalNumber(obj, "out", path, 0),
    drop: reader.optionalNumber(obj, "drop", path, 0),
    yaw: numberOrRange(obj, "yaw", path, reader, 0),
    splay: reader.optionalNumber(obj, "splay", path, 0, { min: -90, max: 90 }),
    scale: numberOrRange(obj, "scale", path, reader, 1),
    segments: segs,
    walks: reader.boolean(obj, "walks", path, true),
  };
}

function readPart(raw: unknown, path: string, reader: Reader, bones: Set<string>): PartDef {
  const obj = reader.object(raw, path);
  reader.onlyKeys(obj, path, ["id", "bone", "shape", "at", "around", "sink", "length", "radius", "flat", "direction", "curve", "mirror", "chance", "scale", "colour", "traits"]);
  const bone = reader.string(obj, "bone", path);
  if (bone && !bones.has(bone)) reader.fail(`${path}.bone`, `no bone "${bone}"`);
  return {
    id: reader.string(obj, "id", path),
    bone,
    shape: obj.shape === undefined ? "cone" : reader.oneOf(obj, "shape", path, ["cone", "blade"] as const),
    at: reader.optionalNumber(obj, "at", path, 0.5, { min: 0, max: 1 }),
    around: reader.optionalNumber(obj, "around", path, 0, { min: -360, max: 360 }),
    sink: reader.optionalNumber(obj, "sink", path, 0.2, { min: 0, max: 1 }),
    length: reader.number(obj, "length", path, { min: 0.001, max: 10 }),
    radius: reader.number(obj, "radius", path, { min: 0.001, max: 5 }),
    flat: reader.optionalNumber(obj, "flat", path, 1, { min: 0.05, max: 1 }),
    direction: triple(obj.direction, `${path}.direction`, reader, [0, 1, 0]),
    curve: reader.optionalNumber(obj, "curve", path, 0, { min: -3, max: 3 }),
    mirror: reader.boolean(obj, "mirror", path, false),
    chance: reader.optionalNumber(obj, "chance", path, 1, { min: 0, max: 1 }),
    scale: obj.scale === undefined ? [1, 1] : reader.range(obj, "scale", path, { allowEqual: true }),
    colour: reader.optionalString(obj, "colour", path) ?? "horn",
    traits: numberRecord(obj.traits, `${path}.traits`, reader),
  };
}

function readCards(raw: unknown, path: string, reader: Reader, bones: Set<string>): CardDef {
  const obj = reader.object(raw, path);
  reader.onlyKeys(obj, path, ["id", "bone", "from", "to", "around", "arc", "count", "length", "width", "lean", "droop", "curl", "mask", "colour", "soft", "chance", "traits", "mirror"]);
  const bone = reader.string(obj, "bone", path);
  if (bone && bonesMatching(bone, [...bones]).length === 0) reader.fail(`${path}.bone`, `no bone "${bone}"`);
  return {
    id: reader.string(obj, "id", path),
    bone,
    from: reader.optionalNumber(obj, "from", path, 0, { min: 0, max: 1 }),
    to: reader.optionalNumber(obj, "to", path, 1, { min: 0, max: 1 }),
    around: reader.optionalNumber(obj, "around", path, 0, { min: -360, max: 360 }),
    arc: reader.optionalNumber(obj, "arc", path, 60, { min: 0, max: 360 }),
    count: reader.optionalNumber(obj, "count", path, 20, { min: 1, max: 2000, integer: true }),
    length: obj.length === undefined ? [0.1, 0.15] : reader.range(obj, "length", path, { allowEqual: true }),
    width: obj.width === undefined ? [0.04, 0.06] : reader.range(obj, "width", path, { allowEqual: true }),
    lean: reader.optionalNumber(obj, "lean", path, 0.6, { min: 0, max: 1 }),
    droop: reader.optionalNumber(obj, "droop", path, 0.2, { min: -1, max: 1 }),
    curl: reader.optionalNumber(obj, "curl", path, 0, { min: -2, max: 2 }),
    mask: obj.mask === undefined ? "strands" : reader.oneOf(obj, "mask", path, ["strands", "tuft", "fringe", "frond"] as const),
    colour: reader.optionalString(obj, "colour", path) ?? "coat",
    soft: reader.boolean(obj, "soft", path, true),
    chance: reader.optionalNumber(obj, "chance", path, 1, { min: 0, max: 1 }),
    traits: numberRecord(obj.traits, `${path}.traits`, reader),
    mirror: reader.boolean(obj, "mirror", path, false),
  };
}

const LAYER_KINDS = ["belly", "back", "stripes", "spots", "socks", "mask", "scars", "bands"] as const;

function readPaint(obj: RawObject, reader: Reader, segments: Set<string>): PaintDef {
  reader.onlyKeys(obj, "paint", ["palette", "mottle", "layers", "eyes"]);
  const palette: Record<string, ColorTuple[]> = {};
  const rawPalette = obj.palette === undefined ? {} : reader.object(obj.palette, "paint.palette");
  for (const [name, list] of Object.entries(rawPalette)) {
    const values = Array.isArray(list) ? list : [list];
    palette[name] = values.map((v, i) => reader.colorValue(v, `paint.palette.${name}[${i}]`));
  }
  palette.coat ??= [[0.5, 0.45, 0.4]];
  const layers = reader.optionalArray(obj, "layers", "paint").map((raw, i) => {
    const path = `paint.layers[${i}]`;
    const layer = reader.object(raw, path);
    reader.onlyKeys(layer, path, ["kind", "colour", "amount", "on", "size", "chance"]);
    const colour = reader.optionalString(layer, "colour", path) ?? "coat";
    if (!palette[colour]) reader.fail(`${path}.colour`, `no palette colour "${colour}"`);
    return {
      kind: reader.oneOf(layer, "kind", path, LAYER_KINDS),
      colour,
      amount: reader.optionalNumber(layer, "amount", path, 1, { min: 0, max: 1 }),
      on: layer.on === undefined ? [] : reader.stringList(layer, "on", path),
      size: reader.optionalNumber(layer, "size", path, 0.1, { min: 0 }),
      chance: reader.optionalNumber(layer, "chance", path, 1, { min: 0, max: 1 }),
    };
  });
  const eyes = obj.eyes === undefined ? {} : reader.object(obj.eyes, "paint.eyes");
  reader.onlyKeys(eyes, "paint.eyes", ["segment", "at", "around", "size", "colour", "glow", "count", "style"]);
  const eyeSegment = reader.optionalString(eyes, "segment", "paint.eyes") ?? "";
  if (eyeSegment && !segments.has(eyeSegment)) reader.fail("paint.eyes.segment", `no trunk segment "${eyeSegment}"`);
  return {
    palette,
    mottle: reader.optionalNumber(obj, "mottle", "paint", 0.12, { min: 0, max: 1 }),
    layers,
    eyes: {
      segment: eyeSegment,
      at: reader.optionalNumber(eyes, "at", "paint.eyes", 0.4, { min: 0, max: 1 }),
      around: reader.optionalNumber(eyes, "around", "paint.eyes", 60, { min: 0, max: 180 }),
      size: reader.optionalNumber(eyes, "size", "paint.eyes", 0.025, { min: 0 }),
      colour: reader.optionalString(eyes, "colour", "paint.eyes") ?? "eye",
      glow: reader.boolean(eyes, "glow", "paint.eyes", false),
      count: reader.optionalNumber(eyes, "count", "paint.eyes", 1, { min: 1, max: 8, integer: true }),
      // "detailed": an eyeball of its own on the head - socket, white, iris, pupil and a shine - with
      // texels to spare however coarse the body atlas; "painted": dots in the body atlas (insects).
      style: eyes.style === undefined ? "painted" : reader.oneOf(eyes, "style", "paint.eyes", ["painted", "detailed"] as const),
    },
  };
}

function readGait(raw: unknown, path: string, reader: Reader): GaitDef {
  const obj = reader.object(raw, path);
  reader.onlyKeys(obj, path, ["id", "speed", "stride", "pattern", "duty", "lift", "bob", "wave", "pitch", "reach"]);
  return {
    id: reader.string(obj, "id", path),
    speed: reader.number(obj, "speed", path, { min: 0 }),
    stride: reader.number(obj, "stride", path, { min: 0.01 }),
    pattern: reader.oneOf(obj, "pattern", path, GAIT_PATTERNS),
    duty: reader.optionalNumber(obj, "duty", path, 0.6, { min: 0.1, max: 0.95 }),
    lift: reader.optionalNumber(obj, "lift", path, 0.06, { min: 0 }),
    bob: reader.optionalNumber(obj, "bob", path, 0.01),
    wave: reader.optionalNumber(obj, "wave", path, 0),
    pitch: reader.optionalNumber(obj, "pitch", path, 0),
    reach: reader.optionalNumber(obj, "reach", path, 1, { min: 0.1, max: 2 }),
  };
}

function readClip(id: string, raw: unknown, path: string, reader: Reader): ClipDef {
  const obj = reader.object(raw, path);
  reader.onlyKeys(obj, path, ["length", "layer", "loop", "hold", "keys"]);
  const keys = reader.array(obj, "keys", path).map((k, i) => {
    const p = `${path}.keys[${i}]`;
    const key = reader.object(k, p);
    reader.onlyKeys(key, p, ["t", "turns", "offset"]);
    const turns: Record<string, [number, number, number]> = {};
    const rawTurns = key.turns === undefined ? {} : reader.object(key.turns, `${p}.turns`);
    for (const [bone, value] of Object.entries(rawTurns)) turns[bone] = triple(value, `${p}.turns.${bone}`, reader, [0, 0, 0]);
    return { t: reader.number(key, "t", p, { min: 0, max: 1 }), turns, offset: key.offset === undefined ? ([0, 0, 0] as [number, number, number]) : triple(key.offset, `${p}.offset`, reader, [0, 0, 0]) };
  });
  return {
    id,
    length: reader.number(obj, "length", path, { min: 0.05, max: 60 }),
    layer: obj.layer === undefined ? "full" : reader.oneOf(obj, "layer", path, ["full", "upper"] as const),
    loop: reader.boolean(obj, "loop", path, false),
    hold: reader.boolean(obj, "hold", path, false),
    keys: keys.sort((a, b) => a.t - b.t),
  };
}

function readCurve(obj: RawObject, key: string, path: string, reader: Reader): CurvePoints {
  const value = obj[key];
  if (typeof value === "number") return [[0, value]];
  const list = reader.array(obj, key, path);
  const points: CurvePoints = [];
  list.forEach((point, i) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every((v) => typeof v === "number" && Number.isFinite(v))) {
      reader.fail(`${path}.${key}[${i}]`, "expected [along, distance]");
      return;
    }
    const [t, d] = point as [number, number];
    if (t < 0 || t > 1) reader.fail(`${path}.${key}[${i}]`, `along must be 0 to 1, got ${t}`);
    if (d < 0) reader.fail(`${path}.${key}[${i}]`, `distance can't be negative, got ${d}`);
    if (points.length > 0 && t <= points[points.length - 1][0]) reader.fail(`${path}.${key}[${i}]`, "points must rise along the segment");
    points.push([t, d]);
  });
  if (list.length === 0) reader.fail(`${path}.${key}`, "needs at least one point");
  return points;
}

function numberOrRange(obj: RawObject, key: string, path: string, reader: Reader, fallback: number): [number, number] {
  const value = obj[key];
  if (value === undefined) return [fallback, fallback];
  if (typeof value === "number") return [value, value];
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number")) return value as [number, number];
  reader.fail(`${path}.${key}`, "expected a number or [first, last]");
  return [fallback, fallback];
}

function triple(value: unknown, path: string, reader: Reader, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v))) return value as [number, number, number];
  if (value !== undefined) reader.fail(path, "expected [x, y, z]");
  return fallback;
}

function stringRecord(value: unknown, path: string, reader: Reader): Record<string, string> {
  if (value === undefined) return {};
  const obj = reader.object(value, path);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === "string") out[key] = v;
    else reader.fail(`${path}.${key}`, "expected text");
  }
  return out;
}

function numberRecord(value: unknown, path: string, reader: Reader): Record<string, number> {
  if (value === undefined) return {};
  const obj = reader.object(value, path);
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === "number") out[key] = v;
    else reader.fail(`${path}.${key}`, "expected a number");
  }
  return out;
}
