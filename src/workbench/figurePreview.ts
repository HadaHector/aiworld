import { Color3, MeshBuilder, SkeletonViewer, Vector3 } from "@babylonjs/core";
import { buildBody, type BodyGeometry } from "../character/bodyMesh";
import { createCharacterMesh, type BodySkin, type Pose } from "../character/characterMesh";
import type { RaceDef } from "../character/raceDef";
import { layoutAtlas, type AtlasLayout } from "../character/atlas";
import { chooseAppearance, paintAtlas, type PaintedCover } from "../character/paint";
import { bakeGearMaterial, type GearMaterialDef } from "../character/gearMaterial";
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
  /** Linen smallclothes painted on, standing in for gear until there is some. */
  smallclothes: boolean;
  /** The character's own seed: its skin, hair, eyes and face. */
  seed: number;
}

/** A body and the atlas painted for it. */
export interface PaintedBody {
  body: BodyGeometry;
  layout: AtlasLayout | null;
  pixels: Uint8Array | null;
  summary: HTMLElement;
}

/** Builds a race's body and paints its atlas, as the options say. */
export async function paintedBody(race: RaceDef, gear: Map<string, GearMaterialDef>, worldSeed: number, options: FigureOptions): Promise<PaintedBody> {
  const body = buildBody(race, { detail: options.detail, lattice: options.lattice !== "off" });
  const look = chooseAppearance(race, options.seed);
  let layout: AtlasLayout | null = null;
  let pixels: Uint8Array | null = null;
  if (options.texture !== "flat") {
    layout = layoutAtlas(body, options.texture === "retro" ? 128 : 512);
    const covers: PaintedCover[] = [];
    const linen = gear.get("linen");
    if (options.smallclothes && linen) {
      const hips = race.skeleton.ankle + race.skeleton.shin + race.skeleton.thigh;
      covers.push({ material: await bakeGearMaterial(worldSeed, linen), tint: [0.86, 0.8, 0.68], from: hips - 0.14, to: hips + 0.06, regions: ["torso", "legR", "legL"] });
    }
    pixels = paintAtlas(body, layout, race, look, covers);
  }
  const tall = Math.max(...body.positions.filter((_, i) => i % 3 === 1));
  const summary = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = `${race.name}, ${tall.toFixed(2)} m`;
  const table = document.createElement("table");
  const rows: [string, string | number][] = [...Object.entries(body.parts), ["triangles", body.triangles]];
  if (layout) rows.push(["atlas", `${layout.size}², ${(layout.density / 100).toFixed(1)} texels/cm`]);
  rows.push(["look", `${look.beard ? "beard, " : ""}seed ${options.seed}`]);
  for (const [label, value] of rows) {
    const row = table.insertRow();
    row.insertCell().textContent = label;
    row.insertCell().textContent = String(value);
  }
  summary.append(title, table);
  return { body, layout, pixels, summary };
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
export function figureFor(race: RaceDef, painted: PaintedBody, options: FigureOptions): NonNullable<StageOptions["figure"]> {
  const { body, layout, pixels } = painted;
  const tall = Math.max(...body.positions.filter((_, i) => i % 3 === 1));
  const skin: BodySkin = layout && pixels ? { pixels, size: layout.size, uvs: layout.uvs, nearest: options.texture === "retro" } : { color: chooseAppearance(race, options.seed).skin };
  return (scene, shadows, height) => {
      const ground = height(0, 0);
      const character = createCharacterMesh(scene, `race_${race.id}`, body, skin);
      character.mesh.position.y = ground;
      character.setPose(POSES[options.pose].pose);
      shadows.addShadowCaster(character.mesh, false);
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
