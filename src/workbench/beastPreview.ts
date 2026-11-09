import { SkeletonViewer, type Scene } from "@babylonjs/core";
import type { PackSource } from "../world/content/resolveContent";
import { resolveBeasts, type BeastDef } from "../character/beast/beastDef";
import { makeBeastNow, type MadeBeast } from "../character/beast/beastMake";
import { createBeastAnimator, type BeastInput } from "../character/beast/beastAnim";
import { createBeastMesh } from "../character/beast/beastMesh";
import type { StageOptions } from "./stage";
import type { TextureImage } from "./textureView";

/**
 * The workbench's beasts (BEASTS.md): a body plan made at a seed, standing on the stage and playing
 * a gait, a clip, a flinch or dying - one, a herd of seeds, or every plan side by side - and its
 * painted atlas. The same making as the game's (beastMake.ts), done on this thread.
 */
export interface BeastPreviewOptions {
  /** "" for the plan's own colours, or one of its variants. */
  variant: string;
  seed: number;
  /** "gait", "idle", "attack", "flinch", "die" or "clip.<id>". */
  play: string;
  /** Metres a second over the ground, for "gait". */
  speed: number;
  path: "place" | "circle";
  bones: boolean;
  atlas: number;
}

export const BEAST_PLAYS: [string, string][] = [
  ["gait", "Gait at the speed"],
  ["idle", "Idle"],
  ["attack", "Attack"],
  ["flinch", "Flinching"],
  ["die", "Dying"],
];

export function readBeastPlans(packs: PackSource[]): Map<string, BeastDef> {
  return resolveBeasts(packs);
}

export function makeBeastFor(def: BeastDef, options: BeastPreviewOptions, seed = options.seed): MadeBeast {
  return makeBeastNow(def, { variant: options.variant, seed, traits: [], atlas: options.atlas });
}

const FLINCH_FROM: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** A made beast standing at (x, z), facing the camera's right, animated as the options say. */
export function beastFigure(made: MadeBeast, options: BeastPreviewOptions, x = 0, z = 0): NonNullable<StageOptions["figure"]> {
  const { def, body, painted, baked } = made;
  return (scene: Scene, shadows, height) => {
    const beast = createBeastMesh(scene, `beast_${def.id}_${x}_${z}`, body, painted, { nearest: options.atlas <= 128 });
    beast.mesh.scaling.setAll(body.size);
    for (const mesh of beast.meshes) {
      shadows.addShadowCaster(mesh, false);
      mesh.receiveShadows = true;
    }
    if (options.bones) {
      const viewer = new SkeletonViewer(beast.skeleton, beast.mesh, scene, true, 1, { displayMode: SkeletonViewer.DISPLAY_SPHERE_AND_SPURS });
      viewer.isEnabled = true;
    }
    const animator = createBeastAnimator(def, body, baked, options.seed);
    const play = options.play;
    const moving = play === "gait" && options.speed > 0;
    const circle = moving && options.path === "circle";
    const radius = Math.max(2, body.length * body.size * 1.5);
    let time = 0;
    let next = 0.6;
    let blows = 0;
    let angle = 0;
    const place = (): void => {
      let px = x;
      let pz = z;
      // Side on to the camera's first view, as a herd walking past; round a circle when asked.
      let facing = -Math.PI / 2;
      if (circle) {
        px = x + Math.cos(angle) * radius;
        pz = z + Math.sin(angle) * radius;
        facing = -angle;
      }
      beast.mesh.position.set(px, height(px, pz), pz);
      beast.mesh.rotation.y = facing;
    };
    place();
    beast.setPose(animator.update({ speed: 0 }, 0));
    scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000);
      time += dt;
      const input: BeastInput = { speed: play === "gait" ? options.speed / body.size : 0 };
      const wanted = play === "attack" ? def.actions.swing ?? def.actions.attack ?? "" : play.startsWith("clip.") ? play.slice(5) : "";
      if (wanted && time > next) {
        input.play = play === "attack" ? "swing" : wanted;
        const clip = def.clips.get(wanted);
        next = time + (clip?.length ?? 1) + (clip?.loop ? 2.5 : 0.8);
      }
      if (play === "flinch" && time > next) {
        const [forward, side] = FLINCH_FROM[blows++ % FLINCH_FROM.length];
        input.flinch = { forward, side, strength: 1 };
        next = time + 0.9;
      }
      if (play === "die") input.dead = time % 6 > 1.2;
      beast.setPose(animator.update(input, dt));
      if (circle) angle += (options.speed / radius) * dt;
      place();
    });
    return { width: Math.max(body.width, body.length) * body.size * (circle ? 3 : 1), height: body.height * body.size };
  };
}

/** Several figures as one: the stage frames them together. */
export function together(figures: NonNullable<StageOptions["figure"]>[], width: number): NonNullable<StageOptions["figure"]> {
  return (scene, shadows, height) => {
    let tallest = 0;
    for (const f of figures) tallest = Math.max(tallest, f(scene, shadows, height).height);
    return { width, height: tallest };
  };
}

/** A line of the summary table: how big, how many triangles, cards and bones, what parts. */
export function beastFacts(made: MadeBeast): string[] {
  const b = made.body;
  return [made.def.name, `${(b.height * b.size).toFixed(2)} m tall, ${(b.length * b.size).toFixed(2)} m long`, `${b.triangles} tris, ${b.cards.count} cards, ${b.bones.length} bones`, b.parts.join(" ") || "-"];
}

export function beastSummary(rows: string[][]): HTMLElement {
  const table = document.createElement("table");
  for (const cells of rows) {
    const row = table.insertRow();
    for (const cell of cells) row.insertCell().textContent = cell;
  }
  return table;
}

/** The painted atlas, or the cards' texture, for the 2D view. */
export function beastAtlasImage(made: MadeBeast, show: "atlas" | "cards"): TextureImage {
  const cards = made.painted.cards;
  if (show === "cards" && cards) return { width: cards.width, height: cards.height, pixels: cards.pixels, tiles: 1, describe: (x, y) => `card texel ${x}, ${y}` };
  const size = made.painted.size;
  const tubes = made.body.tubes;
  return {
    width: size,
    height: size,
    pixels: made.painted.atlas,
    tiles: 1,
    describe: (x, y) => {
      const tube = tubes.find((t) => x >= t.rect.x && x < t.rect.x + t.rect.w && y >= t.rect.y && y < t.rect.y + t.rect.h);
      return tube ? `${tube.kind === "trunk" ? "trunk" : tube.limb} (${x}, ${y})` : `${x}, ${y}`;
    },
  };
}
