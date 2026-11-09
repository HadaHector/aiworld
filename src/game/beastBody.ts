import { Color3, Vector3, type Scene } from "@babylonjs/core";
import type { PackSource } from "../world/content/resolveContent";
import type { ColorTuple } from "../world/terrain/pipeline/pipelineTypes";
import { resolveBeasts, splitBeastLook, type BeastDef } from "../character/beast/beastDef";
import { makeBeast } from "../character/beast/beastMake";
import { createBeastAnimator } from "../character/beast/beastAnim";
import { createBeastMesh } from "../character/beast/beastMesh";
import { hashId } from "../character/beast/beastBuild";
import type { BodyPlace, CharacterBody } from "./characterBody";

/**
 * A beast drawn where the server has its entity (BEASTS.md, *Connection*): built from the body plan
 * its template's look names (`look.beast`, "wolf" or "wolf.frost"), its individual looks from the
 * entity's seed and its kind's traits, animated from how it moves between snapshots - as a humanoid
 * body is (characterBody.ts), and with the same face to the rest of the game: flashes, flinches,
 * pauses, cue places, footsteps and named clips (a skill's `animation`: bite, gore, maul, web...).
 */
export interface BeastKit {
  plans: Map<string, BeastDef>;
  /** A creature kind's traits this world (CREATURES.md), by its template id. */
  traitsOf: (templateId: string) => string[];
}

export function createBeastKit(packs: PackSource[], traitsOf: (templateId: string) => string[] = () => []): BeastKit {
  return { plans: resolveBeasts(packs), traitsOf };
}

export interface BeastLook {
  /** The template's `look.beast`. */
  beast: string;
  templateId: string;
  seed: number;
  /** The template's colour: the tint for a variant its plan has no palette for. */
  color: ColorTuple;
}

/** How many different individuals a kind is drawn as: seeds fold onto these, so a camp of one kind
 *  shares a few cached bodies instead of making one each. */
const VARIETY = 6;
/** Atlas texels a side: a beast is seen at a distance, under a humanoid's 512. */
const ATLAS = 256;
const TURN_RATE = 10;
const TELEPORT = 3;
/** Beyond this the pose is worked out every other frame, and beyond FAR not at all (it is a dot). */
const NEAR = 45;
const FAR = 110;

const scratch = new Vector3();
const scratch2 = new Vector3();

export async function createBeastBody(scene: Scene, name: string, kit: BeastKit, look: BeastLook): Promise<CharacterBody> {
  const { plan, variant } = splitBeastLook(look.beast);
  const def = kit.plans.get(plan);
  if (!def) throw new Error(`no beast plan "${plan}"`);
  const traits = kit.traitsOf(look.templateId);
  const seed = (hashId(look.templateId) + (Math.abs(look.seed) % VARIETY)) >>> 0;
  const made = await makeBeast(def, { variant, seed, traits, tint: look.color, atlas: ATLAS });
  const { body } = made;
  const beast = createBeastMesh(scene, name, body, made.painted);
  for (const mesh of beast.meshes) mesh.isPickable = false;
  beast.mesh.scaling.setAll(body.size);
  const animator = createBeastAnimator(made.def, body, made.baked, seed);
  // The mouth is the head bone's far end; the feet the walking limbs' last bones.
  const headBone = body.places.mouth ?? 0;
  const headLength = Math.hypot(body.bones[headBone].tail[0] - body.bones[headBone].head[0], body.bones[headBone].tail[1] - body.bones[headBone].head[1], body.bones[headBone].tail[2] - body.bones[headBone].head[2]);
  const fronts = body.limbs.filter((l) => l.walks && l.rank === 0).map((l) => l.bones[l.bones.length - 1]);

  let last: { x: number; z: number; at: number } | null = null;
  let speed = 0;
  let facing: number | null = null;
  let wasDead: boolean | null = null;
  let playing: string | undefined;
  let stopping: string | undefined;
  let flinching: { forward: number; side: number; strength: number } | undefined;
  let pausedUntil = 0;
  let steps = 0;
  let skipped = 0;
  let flash: { start: number; seconds: number } | null = null;
  const flashColour = new Color3();

  const along = (bone: number, t: number, out: Vector3): Vector3 => {
    const b = beast.skeleton.bones[bone];
    b.getAbsolutePositionToRef(beast.mesh, out);
    if (t !== 0) {
      b.getDirectionToRef(Vector3.UpReadOnly, beast.mesh, scratch2);
      const len = Math.hypot(body.bones[bone].tail[0] - body.bones[bone].head[0], body.bones[bone].tail[1] - body.bones[bone].head[1], body.bones[bone].tail[2] - body.bones[bone].head[2]);
      out.addInPlace(scratch2.normalize().scaleInPlace(len * t * body.size));
    }
    return out;
  };

  return {
    meshes: beast.meshes,
    show(state) {
      const now = performance.now() / 1000;
      const dt = last ? Math.min(0.1, now - last.at) : 0;
      let jumped = false;
      if (last && dt > 0) {
        const moved = Math.hypot(state.x - last.x, state.z - last.z);
        jumped = moved > TELEPORT;
        // The animator works in the plan's metres: a bigger beast covers more ground a stride.
        const ground = jumped ? 0 : moved / dt / body.size;
        speed += (ground - speed) * Math.min(1, dt * 10);
      }
      last = { x: state.x, z: state.z, at: now };
      if (facing === null) facing = state.facing;
      const turn = Math.atan2(Math.sin(state.facing - facing), Math.cos(state.facing - facing));
      facing += turn * Math.min(1, dt * TURN_RATE);
      const dead = state.dead ?? false;
      const snap = (wasDead === null && dead) || (wasDead === true && !dead && jumped);
      wasDead = dead;
      beast.mesh.position.set(state.x, state.y, state.z);
      beast.mesh.rotation.y = facing;
      // Far off, the pose is worked out less often, or not at all.
      const camera = scene.activeCamera;
      const away = camera ? Vector3.Distance(camera.globalPosition, beast.mesh.position) : 0;
      const due = away < NEAR || (away < FAR && ++skipped % 2 === 0) || playing !== undefined || snap;
      if (now >= pausedUntil && due) {
        const pose = animator.update({ speed, play: playing, stop: stopping, flinch: flinching, dead, snap }, away < NEAR ? dt : dt * 2);
        playing = undefined;
        stopping = undefined;
        flinching = undefined;
        if (pose.step !== undefined) steps++;
        beast.setPose(pose);
      }
      if (flash) {
        const left = 1 - (now - flash.start) / flash.seconds;
        for (const mesh of beast.meshes) {
          mesh.renderOverlay = left > 0;
          mesh.overlayAlpha = 0.6 * Math.max(0, left);
          mesh.overlayColor = flashColour;
        }
        if (left <= 0) flash = null;
      }
    },
    swing() {
      playing = "swing";
    },
    play(clip) {
      playing = clip;
    },
    stop(clip) {
      stopping = clip;
    },
    flash(colour, seconds) {
      flashColour.set(colour[0], colour[1], colour[2]);
      flash = { start: performance.now() / 1000, seconds };
    },
    flinch(x, z, strength) {
      const length = Math.hypot(x, z) || 1;
      const f = facing ?? 0;
      flinching = { forward: (x * Math.sin(f) + z * Math.cos(f)) / length, side: (x * Math.cos(f) - z * Math.sin(f)) / length, strength };
    },
    pause(seconds) {
      pausedUntil = Math.max(pausedUntil, performance.now() / 1000 + seconds);
    },
    steps: () => steps,
    place(at: BodyPlace, out) {
      switch (at) {
        case "feet":
          out.copyFrom(beast.mesh.position);
          return;
        case "head":
          along(headBone, 0.6, out);
          return;
        case "chest":
          beast.skeleton.bones[body.places.chest ?? 0].getAbsolutePositionToRef(beast.mesh, out);
          return;
        // A beast's weapon is its mouth (a bite, a spit), its hands its forefeet.
        case "weapon":
          along(headBone, headLength > 0 ? 1 : 0, out);
          return;
        case "mainHand":
        case "offHand":
        case "hands": {
          if (fronts.length === 0) {
            along(headBone, 1, out);
            return;
          }
          const which = at === "mainHand" ? fronts.slice(-1) : at === "offHand" ? fronts.slice(0, 1) : fronts;
          out.setAll(0);
          for (const bone of which) out.addInPlace(along(bone, 1, scratch));
          out.scaleInPlace(1 / which.length);
          return;
        }
      }
    },
    dispose: () => beast.dispose(),
  };
}
