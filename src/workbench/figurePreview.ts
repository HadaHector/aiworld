import { Color3, MeshBuilder, SkeletonViewer, Vector3, type Scene } from "@babylonjs/core";
import type { BodyGeometry } from "../character/bodyMesh";
import { createCharacterMesh, type BodySkin, type CharacterMesh, type Pose } from "../character/characterMesh";
import { createAnimator } from "../character/animation";
import type { RaceDef, Sex, Slider } from "../character/raceDef";
import type { AtlasLayout } from "../character/atlas";
import { chooseAppearance } from "../character/paint";
import type { BakedGearMaterial, GearMaterialDef } from "../character/gearMaterial";
import type { GearDef } from "../character/gearDef";
import { dressCharacter } from "../character/character";
import type { StageOptions } from "./stage";

export interface FigureOptions {
  /** The race's loops per bone times this. */
  detail: number;
  /** "off" leaves the race's lattice out; "shown" applies it and draws it. */
  lattice: "on" | "off" | "shown";
  pose: keyof typeof POSES;
  bones: boolean;
  /** "painted": a 512 atlas, smoothly filtered; "retro": 128, its texels square; "flat": the skin's
   *  colour alone, no atlas. */
  texture: "painted" | "retro" | "flat";
  /** Linen smallclothes painted on, under any gear. */
  smallclothes: boolean;
  /** The gear worn, in order: later pieces paint over earlier ones. */
  gear: GearDef[];
  /** The character's own seed: its sex, skin, hair, eyes and face. */
  seed: number;
  /** A sex to show instead of the seed's. */
  sex: Sex | null;
  /** Slider positions to show instead of the seed's (0 low, 1 high). */
  sliders: Partial<Record<Slider, number>>;
  /** "still" holds `pose`; the others play (animation.ts). */
  animation: keyof typeof ANIMATIONS;
  /** How fast it moves while walking, jumping, swimming or swinging, metres a second. */
  speed: number;
  /** Moving on the spot, or round a circle on the ground. */
  path: "place" | "circle";
}

/** What the workbench can play, and what each asks of the animator. */
export const ANIMATIONS = {
  still: { label: "Still pose" },
  idle: { label: "Idle" },
  walk: { label: "Walk / run" },
  jump: { label: "Jumping" },
  swim: { label: "Swimming" },
  swing: { label: "Swinging" },
} satisfies Record<string, { label: string }>;

/** A body and the atlas painted for it. */
export interface PaintedBody {
  /** The race as the character's sex has it - what the body was built from. */
  race: RaceDef;
  body: BodyGeometry;
  layout: AtlasLayout | null;
  pixels: Uint8Array | null;
  /** The gear materials its gear is drawn in, baked. */
  baked: Map<string, BakedGearMaterial>;
  summary: HTMLElement;
}

/** Builds a race's body and paints its atlas, as the options say. */
export async function paintedBody(race: RaceDef, gear: Map<string, GearMaterialDef>, worldSeed: number, options: FigureOptions): Promise<PaintedBody> {
  const dressed = await dressCharacter(
    { race, seed: options.seed, sex: options.sex ?? undefined, sliders: options.sliders, gear: options.gear, smallclothes: options.smallclothes },
    gear,
    worldSeed,
    { detail: options.detail, lattice: options.lattice !== "off", atlas: options.texture === "flat" ? 0 : options.texture === "retro" ? 128 : 512 },
  );
  const { body, layout, pixels, baked, look } = dressed;
  const tall = Math.max(...body.positions.filter((_, i) => i % 3 === 1));
  const summary = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = `${race.name}, ${tall.toFixed(2)} m`;
  const table = document.createElement("table");
  const rows: [string, string | number][] = [...Object.entries(body.parts), ["triangles", body.triangles]];
  if (layout) rows.push(["atlas", `${layout.size}², ${(layout.density / 100).toFixed(1)} texels/cm`]);
  rows.push(["look", `${look.sex}, ${look.beard ? "beard, " : ""}seed ${options.seed}`]);
  rows.push(["sliders", `height ×${look.height.toFixed(2)}, build ×${look.build.toFixed(2)}`]);
  for (const [label, value] of rows) {
    const row = table.insertRow();
    row.insertCell().textContent = label;
    row.insertCell().textContent = String(value);
  }
  summary.append(title, table);
  return { race: dressed.race, body, layout, pixels, baked, summary };
}

/**
 * Plays an animation on the stage: the animator fed what the game would feed it - speed, whether
 * it is on the ground, how fast it rises or falls - with a jump every so often or a swing, on the
 * spot or round a circle over the ground.
 */
function play(scene: Scene, character: CharacterMesh, race: RaceDef, options: FigureOptions, height: (x: number, z: number) => number, at = 0): void {
  const animator = createAnimator(race.skeleton);
  const radius = 3;
  let angle = 0;
  let time = 0;
  let lift = 0;
  let rise = 0;
  let nextJump = 0.8;
  let nextSwing = 0.5;
  const moving = options.animation !== "idle";
  const speed = moving ? options.speed : 0;
  scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000);
    time += dt;
    let x = at;
    let z = 0;
    let facing = 0;
    if (options.path === "circle" && speed > 0) {
      angle += (speed * dt) / radius;
      x = at + radius * Math.cos(angle);
      z = radius * Math.sin(angle);
      facing = Math.atan2(-Math.sin(angle), Math.cos(angle));
    }
    // A jump as the game's body jumps (sim/playerBody.ts: 7.6 m/s up, 24 m/s² down).
    if (options.animation === "jump") {
      if (lift <= 0 && rise <= 0 && time >= nextJump) rise = 7.6;
      if (lift > 0 || rise > 0) {
        rise -= 24 * dt;
        lift += rise * dt;
        if (lift <= 0) {
          lift = 0;
          rise = 0;
          nextJump = time + 0.7;
        }
      }
    }
    let swing = false;
    if (options.animation === "swing" && time >= nextSwing) {
      swing = true;
      nextSwing = time + 1.3;
    }
    const grounded = lift <= 0 && rise <= 0;
    const { pose, offset } = animator.update({ speed, grounded, verticalSpeed: rise, swimming: options.animation === "swim", swing }, dt);
    character.setPose(pose, offset);
    character.mesh.position.set(x, height(x, z) + lift, z);
    character.mesh.rotation.y = facing;
  });
}

/** Mirrors a turn made on a bone of the +x side onto its -x twin (see characterMesh.ts's Pose). */
function both(pose: Pose, name: string, angles: [number, number, number]): void {
  pose[`${name}R`] = angles;
  pose[`${name}L`] = [angles[0], -angles[1], -angles[2]];
}

function pose(build: (pose: Pose) => void): Pose {
  const made: Pose = {};
  build(made);
  return made;
}

/** Still poses to judge the body and its skinning by, until there is animation (CHARACTERS.md). */
export const POSES = {
  bind: { label: "Bind pose", pose: {} as Pose },
  stand: {
    label: "Standing",
    pose: pose((p) => {
      both(p, "upperArm", [0.1, 0, -0.04]);
      both(p, "forearm", [-0.25, 0, 0]);
      both(p, "thigh", [0.04, 0, 0]);
      both(p, "shin", [-0.06, 0, 0]);
    }),
  },
  bends: {
    label: "Bends (skinning test)",
    pose: pose((p) => {
      p.upperArmR = [-1.2, 0, 0.2];
      p.forearmR = [-1.6, 0, 0];
      p.upperArmL = [0.6, 0, -1.1];
      p.forearmL = [-0.8, 0, 0];
      p.handL = [0.6, 0, 0];
      p.thighR = [1.1, 0, 0];
      p.shinR = [-1.5, 0, 0];
      p.footR = [0.4, 0, 0];
      p.thighL = [-0.35, 0, 0];
      p.spine = [0.25, 0.2, 0];
      p.chest = [0.1, 0.25, 0];
      p.head = [-0.2, 0.6, 0];
    }),
  },
} satisfies Record<string, { label: string; pose: Pose }>;

/**
 * A race's body standing in the middle of the stage (CHARACTERS.md, build steps 1-2): flat-shaded,
 * painted or in its skin's colour, in one of the still poses, with its bones and its lattice drawn
 * if asked.
 */
export function figureFor(race: RaceDef, painted: PaintedBody, options: FigureOptions, at = 0): NonNullable<StageOptions["figure"]> {
  const { body, layout, pixels } = painted;
  const tall = Math.max(...body.positions.filter((_, i) => i % 3 === 1));
  const skin: BodySkin = layout && pixels ? { pixels, size: layout.size, uvs: layout.uvs, nearest: options.texture === "retro" } : { color: chooseAppearance(race, options.seed, options.sex ?? undefined).skin };
  return (scene, shadows, height) => {
      const ground = height(at, 0);
      const character = createCharacterMesh(scene, `race_${race.id}`, body, skin, painted.baked);
      character.mesh.position.set(at, ground, 0);
      character.setPose(POSES[options.pose].pose);
      for (const mesh of character.meshes) shadows.addShadowCaster(mesh, false);
      if (options.animation !== "still") play(scene, character, painted.race, options, height, at);
      if (options.bones) {
        const viewer = new SkeletonViewer(character.skeleton, character.mesh, scene, true, 1, { displayMode: SkeletonViewer.DISPLAY_SPHERE_AND_SPURS });
        viewer.isEnabled = true;
      }
      if (body.lattice && options.lattice === "shown") {
        const grid = body.lattice.points();
        const at = (p: [number, number, number]): Vector3 => new Vector3(p[0], p[1] + ground, p[2]);
        const lines: Vector3[][] = [];
        const nx = grid.length;
        const ny = grid[0].length;
        const nz = grid[0][0].length;
        for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) lines.push(grid.map((plane) => at(plane[j][k])));
        for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) lines.push(grid[i].map((row) => at(row[k])));
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) lines.push(grid[i][j].map(at));
        const lattice = MeshBuilder.CreateLineSystem("lattice", { lines }, scene);
        lattice.color = new Color3(0.4, 0.85, 1);
        lattice.isPickable = false;
        lattice.renderingGroupId = 1;
      }
      return { width: 1.2, height: tall };
  };
}
