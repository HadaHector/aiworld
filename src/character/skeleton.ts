import type { RaceDef, ShapedBone } from "./raceDef";

export type Vec = [number, number, number];

export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec): Vec => scale(a, 1 / Math.max(1e-9, length(a)));
export const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** One bone of the bind pose, in the character's space: feet on y = 0, facing +z, +x its right. */
export interface BoneDef {
  name: string;
  parent: number;
  head: Vec;
  tail: Vec;
  /** -1 for the middle, else which side: +1 for +x, -1 for -x. */
  side: number;
  /** The race shape it carries, if any. */
  shape?: ShapedBone;
}

/** The bones every humanoid has, in an order where a parent comes before its children. */
export interface Skeleton {
  bones: BoneDef[];
  index: (name: string) => number;
}

/**
 * The bind pose a race's proportions give: standing, arms hanging `armDown` below level, the legs
 * straight down from the hips and the feet pointing forward. Bones run from their head joint to
 * their tail: the pelvis from the hip joints' height up to the waist, the spine on to the ribs, the
 * chest to the top of the shoulders, the neck and head above. A foot's bone runs from the ankle to
 * the toe, so turning it turns the foot about the ankle.
 */
export function buildSkeleton(race: RaceDef): Skeleton {
  const s = race.skeleton;
  const bones: BoneDef[] = [];
  const add_ = (name: string, parent: string | null, head: Vec, tail: Vec, side: number, shape?: ShapedBone): void => {
    bones.push({ name, parent: parent === null ? -1 : bones.findIndex((b) => b.name === parent), head, tail, side, shape });
  };
  const hipY = s.ankle + s.shin + s.thigh;
  const waist: Vec = [0, hipY + s.pelvis, 0];
  const ribs: Vec = [0, waist[1] + s.spine, 0];
  const top: Vec = [0, ribs[1] + s.chest, 0];
  add_("root", null, [0, 0, 0], [0, hipY, 0], 0);
  add_("pelvis", "root", [0, hipY, 0], waist, 0, "pelvis");
  add_("spine", "pelvis", waist, ribs, 0, "spine");
  add_("chest", "spine", ribs, top, 0, "chest");
  add_("neck", "chest", top, [0, top[1] + s.neck, 0], 0, "neck");
  add_("head", "neck", [0, top[1] + s.neck, 0], [0, top[1] + s.neck + s.head, 0], 0, "head");
  const down = (s.armDown * Math.PI) / 180;
  for (const side of [1, -1]) {
    const suffix = side > 0 ? "R" : "L";
    const shoulderY = top[1] - s.shoulderDrop;
    const shoulder: Vec = [side * s.shoulderWidth, shoulderY, 0];
    const arm: Vec = [side * Math.cos(down), -Math.sin(down), 0];
    const elbow = add(shoulder, scale(arm, s.upperArm));
    const wrist = add(elbow, scale(arm, s.forearm));
    add_(`clavicle${suffix}`, "chest", [0, shoulderY, 0], shoulder, side);
    add_(`upperArm${suffix}`, `clavicle${suffix}`, shoulder, elbow, side, "upperArm");
    add_(`forearm${suffix}`, `upperArm${suffix}`, elbow, wrist, side, "forearm");
    add_(`hand${suffix}`, `forearm${suffix}`, wrist, add(wrist, scale(arm, s.hand)), side, "hand");
  }
  for (const side of [1, -1]) {
    const suffix = side > 0 ? "R" : "L";
    const x = side * s.hipWidth;
    add_(`thigh${suffix}`, "pelvis", [x, hipY, 0], [x, s.ankle + s.shin, 0], side, "thigh");
    add_(`shin${suffix}`, `thigh${suffix}`, [x, s.ankle + s.shin, 0], [x, s.ankle, 0], side, "shin");
    add_(`foot${suffix}`, `shin${suffix}`, [x, s.ankle, 0], [x, TOE_HEIGHT, s.foot - s.heel], side, "foot");
  }
  const names = new Map(bones.map((b, i) => [b.name, i]));
  return { bones, index: (name) => names.get(name) ?? -1 };
}

/** The toe's tip over the ground, and the heel's: where a foot's shape runs between. */
export const TOE_HEIGHT = 0.035;
export function footAxis(race: RaceDef, side: number): { from: Vec; to: Vec } {
  const s = race.skeleton;
  const x = side * s.hipWidth;
  return { from: [x, s.ankle * 0.6, -s.heel], to: [x, TOE_HEIGHT, s.foot - s.heel] };
}

/**
 * A frame for a direction: `along` it, `front` the given reference made square to it, and `side`
 * the third axis, `along × front` - so angles round `along`, from `front` toward `side`, always
 * turn the same way, which keeps every ring's triangles facing out (see bodyMesh.ts).
 */
export function frameFor(along: Vec, reference: Vec): { along: Vec; front: Vec; side: Vec } {
  const a = normalize(along);
  let f = sub(reference, scale(a, dot(reference, a)));
  if (length(f) < 1e-6) f = sub([0, 1, 0], scale(a, a[1]));
  f = normalize(f);
  return { along: a, front: f, side: cross(a, f) };
}
