import type { PackSource } from "../world/content/resolveContent";
import { ContentError, Reader, type ContentIssue, type RawObject } from "../world/content/contentReader";
import type { Pose } from "./characterMesh";
import { characterEntries } from "./raceDef";

/**
 * A named animation (animations/<id>.json5, see CHARACTERS.md, *Animation*): keyframes of turns on
 * the body's joints, played by name - by a skill's `animation` action, a cast, the workbench. Turns
 * are anatomical and in degrees, the same for both sides:
 *
 * - arms and legs: x swings forward (90 holds an arm out level in front, 170 overhead), z out from
 *   the body (90 holds an arm out level to the side), y twists along the limb;
 * - forearm x bends the elbow, shin -x bends the knee, hand x bends the wrist forward, foot x lifts
 *   the toes;
 * - pelvis, spine, chest, neck and head: x leans forward, y turns toward the body's right (+x), z
 *   leans toward its left. Turning the pelvis turns the legs with it.
 *
 * A bone a key leaves out holds what the keys either side of it give it; a bone no key names is left
 * to the rest of the animation (walking legs under a swing). `drop` lowers the whole body by that
 * share of its leg's length (a kneel, a crouch), so it fits a dwarf and an elf alike.
 */
export interface AnimationClip {
  id: string;
  name: string;
  /** Where it shows in the workbench's lists: "weapon", "magic", "everyday". */
  group: string;
  /** "upper": over whatever the legs are doing; "full": the body stops walking while it plays. */
  layer: "upper" | "full";
  /** Seconds: its last key's time. */
  length: number;
  /** Plays until stopped, from `loopFrom` (its intro before that played once) to its end, again. */
  loop: boolean;
  loopFrom: number;
  /** Per bone it names, its keys in time order. */
  tracks: Map<string, { at: number; turn: [number, number, number]; ease: Ease }[]>;
  drop: { at: number; value: number; ease: Ease }[];
}

export type Ease = "inOut" | "in" | "out" | "linear";

const BONES = ["pelvis", "spine", "chest", "neck", "head", "clavicle", "upperArm", "forearm", "hand", "thigh", "shin", "foot"];
const SIDED = ["clavicle", "upperArm", "forearm", "hand", "thigh", "shin", "foot"];

export function resolveAnimations(packs: PackSource[]): Map<string, AnimationClip> {
  const issues: ContentIssue[] = [];
  const clips = new Map<string, AnimationClip>();
  for (const [id, entry] of characterEntries(packs, "animations", issues)) clips.set(id, readClip(id, entry.data, new Reader(issues, entry.file)));
  if (issues.length > 0) throw new ContentError(issues);
  return clips;
}

function readClip(id: string, data: unknown, reader: Reader): AnimationClip {
  const obj = reader.object(data, "");
  reader.onlyKeys(obj, "", ["name", "group", "layer", "loop", "loopFrom", "keys"]);
  const tracks = new Map<string, { at: number; turn: [number, number, number]; ease: Ease }[]>();
  const drop: AnimationClip["drop"] = [];
  let length = 0;
  let last = -1;
  reader.array(obj, "keys", "").forEach((raw, i) => {
    const path = `keys[${i}]`;
    const key = reader.object(raw, path);
    reader.onlyKeys(key, path, ["at", "ease", "drop", "pose", "both"]);
    const at = reader.number(key, "at", path, { min: 0, max: 30 });
    if (at <= last) reader.fail(`${path}.at`, "keys must come later and later");
    last = at;
    length = Math.max(length, at);
    const ease = key.ease === undefined ? "inOut" : reader.oneOf(key, "ease", path, ["inOut", "in", "out", "linear"] as const);
    if (key.drop !== undefined) drop.push({ at, value: reader.number(key, "drop", path, { min: -0.5, max: 1.5 }), ease });
    const put = (bone: string, turn: [number, number, number]): void => {
      let track = tracks.get(bone);
      if (!track) tracks.set(bone, (track = []));
      track.push({ at, turn, ease });
    };
    const turns = (value: unknown, where: string): [number, number, number] | null => {
      if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v))) {
        const [x, y, z] = value as number[];
        const r = Math.PI / 180;
        return [x * r, y * r, z * r];
      }
      reader.fail(where, "expected [x, y, z] in degrees");
      return null;
    };
    // The -x side's own axes are mirrored (characterMesh.ts): turned here, so a turn means the same
    // on both sides.
    const mirrored = (t: [number, number, number]): [number, number, number] => [t[0], -t[1], -t[2]];
    if (key.pose !== undefined) {
      const pose: RawObject = reader.object(key.pose, `${path}.pose`);
      for (const [name, value] of Object.entries(pose)) {
        const where = `${path}.pose.${name}`;
        const side = name.endsWith("R") ? "R" : name.endsWith("L") ? "L" : "";
        const base = side ? name.slice(0, -1) : name;
        if (!BONES.includes(base) || (side === "") !== !SIDED.includes(base)) {
          reader.fail(where, `no bone "${name}" (expected ${BONES.map((b) => (SIDED.includes(b) ? `${b}R, ${b}L` : b)).join(", ")})`);
          continue;
        }
        const t = turns(value, where);
        if (t) put(name, side === "L" ? mirrored(t) : t);
      }
    }
    if (key.both !== undefined) {
      const both: RawObject = reader.object(key.both, `${path}.both`);
      for (const [name, value] of Object.entries(both)) {
        const where = `${path}.both.${name}`;
        if (!SIDED.includes(name)) {
          reader.fail(where, `"both" takes a sided bone (${SIDED.join(", ")})`);
          continue;
        }
        const t = turns(value, where);
        if (!t) continue;
        put(`${name}R`, t);
        put(`${name}L`, mirrored(t));
      }
    }
  });
  const loop = reader.boolean(obj, "loop", "", false);
  const loopFrom = reader.optionalNumber(obj, "loopFrom", "", 0, { min: 0 });
  if (loopFrom >= length && loop) reader.fail("loopFrom", `must be before the last key (${length} s)`);
  return {
    id,
    name: reader.optionalString(obj, "name", "") ?? id,
    group: reader.optionalString(obj, "group", "") ?? "everyday",
    layer: obj.layer === undefined ? "upper" : reader.oneOf(obj, "layer", "", ["upper", "full"] as const),
    length,
    loop,
    loopFrom,
    tracks,
    drop,
  };
}

const eased = (ease: Ease, k: number): number => (ease === "linear" ? k : ease === "in" ? k * k : ease === "out" ? 1 - (1 - k) * (1 - k) : k * k * (3 - 2 * k));

/** Where a track is at `t`: between the keys either side, eased as the later one says; held past
 *  its ends. */
function sample<T>(keys: { at: number; ease: Ease }[], t: number, value: (i: number) => T, blend: (a: T, b: T, k: number) => T): T {
  if (t <= keys[0].at) return value(0);
  for (let i = 0; i + 1 < keys.length; i++) {
    if (t <= keys[i + 1].at) return blend(value(i), value(i + 1), eased(keys[i + 1].ease, (t - keys[i].at) / Math.max(1e-6, keys[i + 1].at - keys[i].at)));
  }
  return value(keys.length - 1);
}

/** A clip's pose `t` seconds in (already wrapped round its loop), and how far it lowers the body. */
export function sampleClip(clip: AnimationClip, t: number): { pose: Pose; drop: number } {
  const pose: Pose = {};
  for (const [bone, keys] of clip.tracks) {
    pose[bone] = sample(keys, t, (i) => keys[i].turn, (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
  }
  const drop = clip.drop.length === 0 ? 0 : sample(clip.drop, t, (i) => clip.drop[i].value, (a, b, k) => a + (b - a) * k);
  return { pose, drop };
}
