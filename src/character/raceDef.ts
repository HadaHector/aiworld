import { CHARACTER_FOLDERS, orderPacks, parseFile, type PackSource } from "../world/content/resolveContent";
import { ContentError, Reader, type ContentIssue, type RawObject } from "../world/content/contentReader";
import type { ColorTuple } from "../world/terrain/pipeline/pipelineTypes";
import type { CurvePoints } from "./curve";

/**
 * A race's body, as its pack file gives it (races/<id>.json5, see CHARACTERS.md): the skeleton's
 * proportions, the four profile curves round each bone, and a lattice that shapes the whole.
 * Lengths are in metres, angles in degrees.
 */
export interface RaceDef {
  id: string;
  name: string;
  look: RaceLook;
  skeleton: RaceSkeleton;
  shape: Record<ShapedBone, BoneShape>;
  lattice: LatticeDef | null;
  /** How each sex differs from the shape above (see `forSex`). */
  sexes: Record<Sex, SexDef>;
}

export const SEXES = ["male", "female"] as const;
export type Sex = (typeof SEXES)[number];

/** One sex's differences from its race's body: factors on skeleton lengths, factors on a bone's
 *  curves, bumps added to them, and its own share of beards. */
export interface SexDef {
  skeleton: Partial<Record<keyof RaceSkeleton, number>>;
  shape: Partial<Record<ShapedBone, { scale: { front: number; back: number; out: number; in: number }; bumps: Bump[] }>>;
  beard: number;
}

/**
 * A swelling on a bone's surface - a pec, a shoulder blade, a buttock, a breast: highest at `at`
 * along the bone and `angle` degrees round it from its front toward its outer side (on a bone in
 * the middle, toward both sides alike), fading over `length` along and `width` degrees round.
 * `mark` names a point to paint at its peak (paint.ts: "nipple").
 */
export interface Bump {
  at: number;
  angle: number;
  width: number;
  length: number;
  height: number;
  mark?: string;
}

/** What a character of the race can look like: each picks from these by its seed (paint.ts). */
export interface RaceLook {
  skin: ColorTuple[];
  hair: ColorTuple[];
  eyes: ColorTuple[];
  /** The share of characters with a beard. */
  beard: number;
  /** Where the face is painted on the head: heights from the jaw's hinge (0) to the crown (1). */
  face: { eyes: number; brows: number; nose: number; mouth: number; hairline: number };
}

export interface RaceSkeleton {
  /** The ankle joint over the ground. */
  ankle: number;
  shin: number;
  thigh: number;
  /** Each hip joint out from the middle. */
  hipWidth: number;
  /** Up the torso, from the hips: pelvis to the waist, spine to the ribs, chest to the shoulders' top. */
  pelvis: number;
  spine: number;
  chest: number;
  neck: number;
  head: number;
  /** Each shoulder joint out from the middle, and down from the top of the chest. */
  shoulderWidth: number;
  shoulderDrop: number;
  upperArm: number;
  forearm: number;
  hand: number;
  /** How far the arms hang below level in the bind pose. */
  armDown: number;
  /** Heel to toe, and how far the heel reaches behind the ankle. */
  foot: number;
  heel: number;
  /** How far under the shoulder joint the armpit is, and how far under the hip joints the legs
   *  part (the crotch). */
  armpit: number;
  crotch: number;
}

/** The bones a body is shaped round. The clavicles carry no shape of their own. */
export const SHAPED_BONES = ["pelvis", "spine", "chest", "neck", "head", "thigh", "shin", "upperArm", "forearm", "hand", "foot"] as const;
export type ShapedBone = (typeof SHAPED_BONES)[number];

/**
 * The surface round one bone: how far it stands from the bone's axis toward each of four sides,
 * along the bone. `front` and `back` are toward the character's front and back - for a foot, its
 * top and sole; `out` and `in` away from and toward the body's middle - for a bone in the middle,
 * both sides alike (`side` in the file).
 */
export interface BoneShape {
  front: CurvePoints;
  back: CurvePoints;
  out: CurvePoints;
  in: CurvePoints;
  /** Between the four sides: boxy (0) to round (1). */
  round: number;
  /** Rings cut along the bone, and vertices round each ring. */
  loops: number;
  verts: number;
  bumps: Bump[];
}

/** A free-form deformation over the whole body (see lattice.ts). */
export interface LatticeDef {
  /** Control points along x (across), y (up) and z (front to back), at least 2 each. */
  divisions: [number, number, number];
  /** Control points moved, by index from the lattice's -x, bottom, back corner. With `mirror`, a
   *  move is made on the other side too, mirrored. */
  moves: { at: [number, number, number]; by: [number, number, number] }[];
  mirror: boolean;
}

const MIDDLE_BONES: readonly ShapedBone[] = ["pelvis", "spine", "chest", "neck", "head"];
const SKELETON_KEYS: (keyof RaceSkeleton)[] = ["ankle", "shin", "thigh", "hipWidth", "pelvis", "spine", "chest", "neck", "head", "shoulderWidth", "shoulderDrop", "upperArm", "forearm", "hand", "armDown", "foot", "heel", "armpit", "crotch"];
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Every race in the packs, later packs replacing earlier ones' by id. Throws a ContentError with
 *  every problem found. */
export function resolveRaces(packs: PackSource[]): Map<string, RaceDef> {
  const issues: ContentIssue[] = [];
  const entries = characterEntries(packs, "races", issues);
  const races = new Map<string, RaceDef>();
  for (const [id, entry] of entries) races.set(id, readRace(id, entry.data, new Reader(issues, entry.file)));
  if (issues.length > 0) throw new ContentError(issues);
  return races;
}

/** One character folder's files, parsed, by id - later packs replacing earlier ones - in id order. */
export function characterEntries(packs: PackSource[], folder: (typeof CHARACTER_FOLDERS)[number], issues: ContentIssue[]): Map<string, { file: string; data: unknown }> {
  const entries = new Map<string, { file: string; data: unknown }>();
  for (const pack of orderPacks(packs, issues)) {
    for (const { path, text } of pack.files) {
      const parts = path.split("/");
      if (parts.length !== 2 || parts[0] !== folder) continue;
      const file = `${pack.id}/${path}`;
      const id = parts[1].replace(/\.json5$/, "");
      if (!ID_PATTERN.test(id)) {
        issues.push({ file, path: "", message: "file names (which are ids) may only use letters, digits, - and _" });
        continue;
      }
      const data = parseFile(file, text, issues);
      if (data !== undefined) entries.set(id, { file, data });
    }
  }
  return new Map([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

function readRace(id: string, data: unknown, reader: Reader): RaceDef {
  const obj = reader.object(data, "");
  reader.onlyKeys(obj, "", ["name", "look", "skeleton", "shape", "lattice", "sexes"]);
  const rawSkeleton = reader.object(obj.skeleton, "skeleton");
  reader.onlyKeys(rawSkeleton, "skeleton", SKELETON_KEYS);
  const skeleton = Object.fromEntries(SKELETON_KEYS.map((key) => [key, reader.number(rawSkeleton, key, "skeleton", { min: key === "armDown" ? -90 : 0, max: key === "armDown" ? 90 : 3 })])) as unknown as RaceSkeleton;
  const rawShape = reader.object(obj.shape, "shape");
  reader.onlyKeys(rawShape, "shape", SHAPED_BONES);
  const shape = Object.fromEntries(SHAPED_BONES.map((bone) => [bone, readShape(rawShape[bone], bone, reader)])) as Record<ShapedBone, BoneShape>;
  const rawSexes = obj.sexes === undefined ? {} : reader.object(obj.sexes, "sexes");
  reader.onlyKeys(rawSexes, "sexes", SEXES);
  const look = readLook(reader.object(obj.look, "look"), reader);
  const sexes = Object.fromEntries(SEXES.map((sex) => [sex, readSex(rawSexes[sex], `sexes.${sex}`, look.beard, reader)])) as Record<Sex, SexDef>;
  const torsoVerts = shape.pelvis.verts;
  if (torsoVerts !== 12 && torsoVerts !== 16) reader.fail("shape.pelvis.verts", "the torso's rings need 12 or 16 vertices - the legs, arms and neck join them at fixed places");
  for (const bone of ["spine", "chest"] as const) if (shape[bone].verts !== torsoVerts) reader.fail(`shape.${bone}.verts`, `the torso's rings all have the pelvis's count (${torsoVerts})`);
  return {
    id,
    name: reader.optionalString(obj, "name", "") ?? id,
    look,
    sexes,
    skeleton,
    shape,
    lattice: obj.lattice === undefined ? null : readLattice(reader.object(obj.lattice, "lattice"), reader),
  };
}

function readLook(obj: RawObject, reader: Reader): RaceLook {
  reader.onlyKeys(obj, "look", ["skin", "hair", "eyes", "beard", "face"]);
  const colors = (key: string): ColorTuple[] => {
    const list = reader.array(obj, key, "look").map((value, i) => reader.colorValue(value, `look.${key}[${i}]`));
    if (list.length === 0) reader.fail(`look.${key}`, "needs at least one colour");
    return list.length > 0 ? list : [[1, 0, 1]];
  };
  const face = obj.face === undefined ? {} : reader.object(obj.face, "look.face");
  reader.onlyKeys(face, "look.face", ["eyes", "brows", "nose", "mouth", "hairline"]);
  const height = (key: string, fallback: number): number => reader.optionalNumber(face, key, "look.face", fallback, { min: 0, max: 1 });
  return {
    skin: colors("skin"),
    hair: colors("hair"),
    eyes: colors("eyes"),
    beard: reader.optionalNumber(obj, "beard", "look", 0, { min: 0, max: 1 }),
    face: { eyes: height("eyes", 0.6), brows: height("brows", 0.69), nose: height("nose", 0.5), mouth: height("mouth", 0.36), hairline: height("hairline", 0.82) },
  };
}

function readShape(raw: unknown, bone: ShapedBone, reader: Reader): BoneShape {
  const path = `shape.${bone}`;
  const obj: RawObject = reader.object(raw, path);
  const middle = MIDDLE_BONES.includes(bone);
  const foot = bone === "foot";
  const sides = middle ? ["front", "back", "side"] : foot ? ["top", "sole", "out", "in"] : ["front", "back", "out", "in"];
  reader.onlyKeys(obj, path, [...sides, "round", "loops", "verts", "bumps"]);
  const curve = (key: string): CurvePoints => readCurve(obj, key, path, reader);
  const front = curve(foot ? "top" : "front");
  const back = curve(foot ? "sole" : "back");
  const out = curve(middle ? "side" : "out");
  return {
    front,
    back,
    out,
    in: middle ? out : curve("in"),
    round: reader.optionalNumber(obj, "round", path, 0.7, { min: 0, max: 1 }),
    loops: reader.optionalNumber(obj, "loops", path, 2, { min: 0, max: 12, integer: true }),
    verts: reader.optionalNumber(obj, "verts", path, 8, { min: 4, max: 24, integer: true }),
    bumps: readBumps(obj, path, reader),
  };
}

function readBumps(obj: RawObject, path: string, reader: Reader): Bump[] {
  return reader.optionalArray(obj, "bumps", path).map((raw, i) => {
    const at = `${path}.bumps[${i}]`;
    const bump = reader.object(raw, at);
    reader.onlyKeys(bump, at, ["at", "angle", "width", "length", "height", "mark"]);
    return {
      at: reader.number(bump, "at", at, { min: 0, max: 1 }),
      angle: reader.number(bump, "angle", at, { min: -180, max: 180 }),
      width: reader.number(bump, "width", at, { min: 1, max: 180 }),
      length: reader.number(bump, "length", at, { min: 0.01, max: 1 }),
      height: reader.number(bump, "height", at, { min: -0.2, max: 0.2 }),
      mark: reader.optionalString(bump, "mark", at),
    };
  });
}

function readSex(raw: unknown, path: string, beard: number, reader: Reader): SexDef {
  const obj = raw === undefined ? {} : reader.object(raw, path);
  reader.onlyKeys(obj, path, ["skeleton", "shape", "beard"]);
  const rawSkeleton = obj.skeleton === undefined ? {} : reader.object(obj.skeleton, `${path}.skeleton`);
  reader.onlyKeys(rawSkeleton, `${path}.skeleton`, SKELETON_KEYS);
  const skeleton: SexDef["skeleton"] = {};
  for (const key of Object.keys(rawSkeleton) as (keyof RaceSkeleton)[]) skeleton[key] = reader.number(rawSkeleton, key, `${path}.skeleton`, { min: 0.1, max: 3 });
  const rawShape = obj.shape === undefined ? {} : reader.object(obj.shape, `${path}.shape`);
  reader.onlyKeys(rawShape, `${path}.shape`, SHAPED_BONES);
  const shape: SexDef["shape"] = {};
  for (const bone of Object.keys(rawShape) as ShapedBone[]) {
    const at = `${path}.shape.${bone}`;
    const entry = reader.object(rawShape[bone], at);
    reader.onlyKeys(entry, at, ["scale", "bumps"]);
    const rawScale = entry.scale === undefined ? {} : reader.object(entry.scale, `${at}.scale`);
    const middle = MIDDLE_BONES.includes(bone);
    reader.onlyKeys(rawScale, `${at}.scale`, middle ? ["front", "back", "side"] : bone === "foot" ? ["top", "sole", "out", "in"] : ["front", "back", "out", "in"]);
    const factor = (key: string): number => reader.optionalNumber(rawScale, key, `${at}.scale`, 1, { min: 0.1, max: 3 });
    const front = factor(bone === "foot" ? "top" : "front");
    const back = factor(bone === "foot" ? "sole" : "back");
    const out = factor(middle ? "side" : "out");
    shape[bone] = { scale: { front, back, out, in: middle ? out : factor("in") }, bumps: readBumps(entry, at, reader) };
  }
  return { skeleton, shape, beard: reader.optionalNumber(obj, "beard", path, beard, { min: 0, max: 1 }) };
}

/** The race's body as one sex has it: its lengths and curves scaled, its bumps added. */
export function forSex(race: RaceDef, sex: Sex): RaceDef {
  const def = race.sexes[sex];
  const skeleton = { ...race.skeleton };
  for (const [key, factor] of Object.entries(def.skeleton) as [keyof RaceSkeleton, number][]) skeleton[key] *= factor;
  const shape = { ...race.shape };
  for (const [bone, change] of Object.entries(def.shape) as [ShapedBone, NonNullable<SexDef["shape"][ShapedBone]>][]) {
    const base = race.shape[bone];
    const scaled = (curve: CurvePoints, k: number): CurvePoints => curve.map(([t, d]) => [t, d * k]);
    shape[bone] = {
      ...base,
      front: scaled(base.front, change.scale.front),
      back: scaled(base.back, change.scale.back),
      out: scaled(base.out, change.scale.out),
      in: scaled(base.in, change.scale.in),
      bumps: [...base.bumps, ...change.bumps],
    };
  }
  return { ...race, skeleton, shape, look: { ...race.look, beard: def.beard } };
}

function readCurve(obj: RawObject, key: string, path: string, reader: Reader): CurvePoints {
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
    if (points.length > 0 && t <= points[points.length - 1][0]) reader.fail(`${path}.${key}[${i}]`, "points must rise along the bone");
    points.push([t, d]);
  });
  if (list.length === 0) reader.fail(`${path}.${key}`, "needs at least one point");
  return points;
}

function readLattice(obj: RawObject, reader: Reader): LatticeDef {
  reader.onlyKeys(obj, "lattice", ["divisions", "moves", "mirror"]);
  const divisions = readTriple(obj.divisions, "lattice.divisions", reader).map((n) => Math.round(n)) as [number, number, number];
  if (divisions.some((n) => n < 2 || n > 8)) reader.fail("lattice.divisions", "each must be 2 to 8");
  const moves = reader.optionalArray(obj, "moves", "lattice").map((raw, i) => {
    const path = `lattice.moves[${i}]`;
    const move = reader.object(raw, path);
    reader.onlyKeys(move, path, ["at", "by"]);
    const at = readTriple(move.at, `${path}.at`, reader).map((n) => Math.round(n)) as [number, number, number];
    if (at.some((n, axis) => n < 0 || n >= divisions[axis])) reader.fail(`${path}.at`, `outside the lattice (${divisions.join(" × ")} points)`);
    return { at, by: readTriple(move.by, `${path}.by`, reader) };
  });
  return { divisions, moves, mirror: reader.boolean(obj, "mirror", "lattice", true) };
}

function readTriple(value: unknown, path: string, reader: Reader): [number, number, number] {
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v))) return value as [number, number, number];
  reader.fail(path, "expected [x, y, z]");
  return [0, 0, 0];
}
