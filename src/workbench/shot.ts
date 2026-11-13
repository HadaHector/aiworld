// Shots (SHOTS.md): the stage taken from fixed angles and laid out on one image - a contact sheet of
// views, or a filmstrip of one view over time - for `npm run shot` (scripts/shot/shot.mjs) or by hand
// from the console: `await __workbench.shoot({ views: ["front", "side"] })` returns a PNG data URL.
// Only with `?shot` in the URL: the render loop stops and time stands still until a shot steps it.

import { Color3, Matrix, MeshBuilder, StandardMaterial, Vector3, type AbstractMesh, type Engine, type Mesh, type Scene } from "@babylonjs/core";
import type { Stage } from "./stage";
import { DEBUG_MODES, setDebugMode } from "./debugMaterial";
import { checkMesh, floatingPieces, hashArrays } from "./meshChecks";
import { keepBuildingCpuCopies } from "../world/buildings/buildingMesh";

/** Named views: the camera's angles round the model (Babylon's arc camera: alpha round the y axis,
 *  0 on +x, pi/2 on +z; beta down from straight above). Models face +z, as the stage frames them. */
const VIEWS: Record<string, { alpha: number; beta: number; head?: boolean }> = {
  "3q": { alpha: Math.PI / 2 - 0.6, beta: 1.15 },
  front: { alpha: Math.PI / 2, beta: Math.PI / 2 - 0.08 },
  side: { alpha: 0, beta: Math.PI / 2 - 0.08 },
  back: { alpha: -Math.PI / 2, beta: Math.PI / 2 - 0.08 },
  top: { alpha: Math.PI / 2, beta: 0.001 },
  under: { alpha: Math.PI / 2, beta: Math.PI - 0.001 },
  head: { alpha: Math.PI / 2 - 0.4, beta: Math.PI / 2 - 0.15, head: true },
};
export const SHOT_VIEWS = Object.keys(VIEWS);

/** The stage's own furniture - everything else on it is the subject. */
const NOT_SUBJECT = /^(grid|groundPatch|sky|grass|colliders|colliderEdges|line_|yard_|plan_|door_|lattice|shotFigure)/;
/** A narrow lens: little perspective, so proportions read true. */
const FOV = 0.35;
/** Time steps when a shot moves time on: the animations' frame delta. */
const STEP = 1 / 30;

export interface ShotSpec {
  views?: string[];
  /** Seconds since the preview was built - one, or several for a filmstrip of the first view. */
  times?: number[];
  /** Looks (debugMaterial.ts), a row each - "lit" is the game's own. */
  modes?: string[];
  width?: number;
  height?: number;
  title?: string;
  /** Pictures only: no labels, no reference figure - for measuring. */
  bare?: boolean;
}

interface ShotHost {
  engine: Engine;
  canvas: HTMLCanvasElement;
  stage: () => Stage | null;
  /** The status line: empty once a preview is up. */
  status: () => string;
  folder: () => string;
  /** The look the page shows by hand, put back after a shot. */
  mode: () => string;
}

/** Names for the subject's figures in the order they were made (each a root mesh), set by a preview
 *  that knows them - "sword crude" - or none, and the meshes' own names are used. */
let names: string[] = [];
export function setShotNames(list: string[]): void {
  names = list;
}

/** Whether the page was opened to take shots. */
export const shotMode = new URLSearchParams(location.search).has("shot");

export function installShot(host: ShotHost): Record<string, unknown> {
  // Time stands still unless a shot moves it: every animation steps by the engine's delta.
  let delta = 0;
  let clock = 0;
  let clockStage: Stage | null = null;
  host.engine.getDeltaTime = () => delta;
  host.engine.stopRenderLoop();
  // The report reads meshes back; buildings drop their CPU copy otherwise.
  keepBuildingCpuCopies(true);

  const stepTo = (stage: Stage, seconds: number): void => {
    if (clockStage !== stage) {
      clockStage = stage;
      clock = 0;
    }
    if (seconds < clock - 1e-6) throw new Error(`t=${seconds} is before ${clock.toFixed(2)}: times must rise`);
    delta = STEP * 1000;
    while (clock + STEP / 2 < seconds) {
      stage.scene.render();
      clock += STEP;
    }
    delta = 0;
  };

  const shoot = async (spec: ShotSpec = {}): Promise<string> => {
    const stage = host.stage();
    if (!stage) throw new Error("No 3D stage on screen");
    const scene = stage.scene;
    const views = spec.views?.length ? spec.views : ["3q", "front", "side", "back", "top"];
    for (const v of views) if (!VIEWS[v]) throw new Error(`No view "${v}" - one of ${SHOT_VIEWS.join(", ")}`);
    const times = spec.times?.length ? spec.times : [0];
    const film = times.length > 1;
    const modes = spec.modes?.length ? spec.modes : [host.mode()];
    for (const m of modes) if (!(DEBUG_MODES as readonly string[]).includes(m)) throw new Error(`No mode "${m}" - one of ${DEBUG_MODES.join(", ")}`);
    const row = film ? times.map((t) => ({ view: views[0], t })) : views.map((view) => ({ view, t: times[0] }));
    const cells = modes.flatMap((mode) => row.map((cell) => ({ ...cell, mode })));
    const width = spec.width ?? 1600;
    const height = spec.height ?? 1000;
    const titleH = 28;
    // Cells as near square as the image allows.
    let best = { cols: 1, rows: 1, size: 0 };
    // Several looks: a row each.
    if (modes.length > 1) best = { cols: row.length, rows: modes.length, size: 1 };
    else for (let cols = 1; cols <= cells.length; cols++) {
      const rows = Math.ceil(cells.length / cols);
      const size = Math.min(width / cols, (height - titleH) / rows / 0.75);
      if (size > best.size) best = { cols, rows, size };
    }
    const cellW = Math.floor(width / best.cols);
    const cellH = Math.floor((height - titleH) / best.rows);

    const reference = spec.bare ? null : addReference(scene, host.folder());
    // A mesh whose shader is still compiling is left out of a frame.
    await scene.whenReadyAsync();
    const camera = stage.camera;
    const saved = stage.getView();
    const savedFov = camera.fov;
    const style = host.canvas.style.cssText;
    host.canvas.style.cssText = `position:fixed;left:0;top:0;width:${cellW}px;height:${cellH}px;display:block;z-index:9`;
    host.engine.resize();

    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const g = out.getContext("2d")!;
    g.fillStyle = "#15181d";
    g.fillRect(0, 0, width, height);
    g.fillStyle = "#e6e9ee";
    g.font = "bold 16px sans-serif";
    g.textBaseline = "middle";
    g.fillText(spec.title ?? "", 10, titleH / 2);

    try {
      let look = "";
      for (const [i, cell] of cells.entries()) {
        if (cell.mode !== look) {
          look = cell.mode;
          setDebugMode(scene, look, isLooked);
          await scene.whenReadyAsync();
        }
        stepTo(stage, cell.t);
        const subject = subjectMeshes(scene);
        const box = boundsOf(reference ? [...subject, reference] : subject);
        // Views turn with the subject: "front" looks at the way its first figure faces.
        const ahead = [...rootsOf(subject).keys()][0]?.getDirection(Vector3.Forward());
        const turn = ahead ? Math.atan2(ahead.z, ahead.x) - Math.PI / 2 : 0;
        const view = VIEWS[cell.view];
        frame(stage, { ...view, alpha: view.alpha + turn }, box, cellW / cellH);
        scene.render();
        const x = (i % best.cols) * cellW;
        const y = titleH + Math.floor(i / best.cols) * cellH;
        g.drawImage(host.canvas, x, y, cellW, cellH);
        if (spec.bare) continue;
        g.strokeStyle = "#2a2f37";
        g.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
        const mode = modes.length > 1 || cell.mode !== "lit" ? `  ${cell.mode}` : "";
        label(g, (film ? `${cell.view}  t=${cell.t.toFixed(2)} s` : cell.view) + mode, x + 8, y + 14, "#ffd479");
        if (!film || i === 0) labelFigures(g, stage, subject, x, y, cellW, cellH);
        // The shape at icon size, as an inventory slot shows it.
        if (cell.mode === "silhouette") {
          const icon = 64;
          const side = Math.min(cellW, cellH);
          g.fillStyle = "#000";
          g.fillRect(x + cellW - icon - 9, y + cellH - icon - 9, icon + 2, icon + 2);
          g.drawImage(host.canvas, (cellW - side) / 2, (cellH - side) / 2, side, side, x + cellW - icon - 8, y + cellH - icon - 8, icon, icon);
        }
      }
    } finally {
      setDebugMode(scene, host.mode(), isLooked);
      reference?.dispose();
      camera.fov = savedFov;
      camera.alpha = saved.alpha;
      camera.beta = saved.beta;
      camera.radius = saved.radius;
      camera.target.set(...saved.target);
      host.canvas.style.cssText = style;
      host.engine.resize();
    }
    return out.toDataURL("image/png");
  };

  /** The text report (SHOTS.md): each figure's size and budget, each mesh's checks, the look's value. */
  const report = async (): Promise<string> => {
    const stage = host.stage();
    if (!stage) throw new Error("No 3D stage on screen");
    const subject = subjectMeshes(stage.scene);
    const lines: string[] = [];
    const flag = (bad: boolean, text: string): void => {
      lines.push(`${bad ? "!" : " "} ${text}`);
    };
    const roots = [...rootsOf(subject).entries()];
    const checked = new Map<unknown, ReturnType<typeof checkMesh>>();
    const materials = new Set<unknown>();
    let triangles = 0;
    const hashed: ArrayLike<number>[] = [];
    roots.forEach(([root, meshes], r) => {
      const box = boundsOf(meshes)!;
      const size = box.max.subtract(box.min);
      const name = names[r] ?? root.name;
      const tris = meshes.reduce((sum, m) => sum + m.getTotalIndices() / 3, 0);
      lines.push(`${name}: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m (w h d), ${tris} triangles, ${meshes.length} meshes`);
      // Pieces of the figure that touch nothing else of it: every mesh posed as drawn, in world space.
      const world = posedTogether(meshes);
      const floating = floatingPieces(world.positions, world.indices);
      for (const piece of floating.slice(0, 5)) flag(true, `  a piece of ${piece.triangles} tris floats ${piece.gap.toFixed(3)} m clear of the rest, at ${piece.at.map((v) => v.toFixed(2)).join(", ")}`);
      if (floating.length > 5) flag(true, `  ...and ${floating.length - 5} more floating pieces`);
      for (const mesh of meshes) {
        materials.add(mesh.material);
        const geometry = (mesh as unknown as { geometry?: unknown }).geometry ?? mesh;
        if (checked.has(geometry)) continue;
        const positions = mesh.getVerticesData("position");
        const indices = mesh.getIndices();
        if (!positions || !indices) continue;
        hashed.push(positions, indices);
        triangles += indices.length / 3;
        const facts = checkMesh(positions, indices, mesh.getVerticesData("normal"));
        checked.set(geometry, facts);
        const layers = mesh.getVerticesData("layer");
        const parts = layers ? `, ${new Set(Array.from(layers)).size} layers` : "";
        lines.push(`  ${mesh.name}: ${facts.triangles} tris, ${facts.vertices} verts, ${facts.pieces} pieces${parts}`);
        if (facts.degenerate) flag(true, `    ${facts.degenerate} degenerate triangles`);
        if (facts.duplicates) flag(true, `    ${facts.duplicates} duplicate triangles (drawn twice)`);
        if (facts.coplanar) flag(true, `    ${facts.coplanar} triangles overlap another in the same plane, same facing (z-fighting)`);
        if (facts.flipped) flag(true, `    ${facts.flipped} triangles wound against their normals`);
        if (facts.nonManifold) flag(true, `    ${facts.nonManifold} edges shared by 3+ triangles`);
        if (facts.openEdges) lines.push(`      ${facts.openEdges} open edges (holes, or the rims of sheets and cut walls)`);
      }
    });
    lines.push(`total: ${triangles} triangles in ${checked.size} distinct meshes, ${materials.size} materials; hash ${hashArrays(hashed)}`);

    // The value: mean brightness of the lit model where its silhouette is, seen from the front.
    const size = 200;
    const url = await shoot({ views: ["front"], modes: ["lit", "silhouette"], width: size, height: size * 2 + 28, bare: true });
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const g = canvas.getContext("2d")!;
    g.drawImage(image, 0, 0);
    const lit = g.getImageData(0, 28, size, size).data;
    const mask = g.getImageData(0, 28 + size, size, size).data;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < mask.length; i += 4) {
      if (mask[i] < 240 || mask[i + 1] < 240) continue;
      sum += (0.2126 * lit[i] + 0.7152 * lit[i + 1] + 0.0722 * lit[i + 2]) / 255;
      count++;
    }
    const value = count ? sum / count : 0;
    flag(value < 0.15 || value > 0.85, `value (front, lit): ${value.toFixed(2)} mean over ${count} px${value < 0.15 ? " - near black" : value > 0.85 ? " - blown out" : ""}`);
    return lines.join(String.fromCharCode(10));
  };

  return {
    shoot,
    report,
    /** A preview is up and done: what a shot waits for. */
    shotReady: () => !!host.stage() && host.status() === "",
    views: SHOT_VIEWS,
  };
}

/** Meshes as drawn - skinned ones posed - in world space, as one set of buffers. */
function posedTogether(meshes: AbstractMesh[]): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  const v = new Vector3();
  for (const mesh of meshes) {
    const raw = mesh.getVerticesData("position");
    const own = mesh.getIndices();
    if (!raw || !own) continue;
    const skinned = mesh.skeleton ? skin(mesh as Mesh, raw) : raw;
    const matrix = mesh.computeWorldMatrix(true);
    const base = positions.length / 3;
    for (let i = 0; i < skinned.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(skinned[i], skinned[i + 1], skinned[i + 2], matrix, v);
      positions.push(v.x, v.y, v.z);
    }
    for (let i = 0; i < own.length; i++) indices.push(base + own[i]);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** A skinned mesh's points as posed: each a weighted sum of its bones' matrices (four influences). */
function skin(mesh: Mesh, raw: ArrayLike<number>): Float32Array {
  const bones = mesh.skeleton!.getTransformMatrices(mesh);
  const which = mesh.getVerticesData("matricesIndices");
  const weights = mesh.getVerticesData("matricesWeights");
  const out = Float32Array.from(raw);
  if (!which || !weights) return out;
  for (let v = 0; v < raw.length / 3; v++) {
    const x = raw[v * 3], y = raw[v * 3 + 1], z = raw[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k];
      if (!w) continue;
      const m = which[v * 4 + k] * 16;
      ox += w * (x * bones[m] + y * bones[m + 4] + z * bones[m + 8] + bones[m + 12]);
      oy += w * (x * bones[m + 1] + y * bones[m + 5] + z * bones[m + 9] + bones[m + 13]);
      oz += w * (x * bones[m + 2] + y * bones[m + 6] + z * bones[m + 10] + bones[m + 14]);
    }
    out[v * 3] = ox;
    out[v * 3 + 1] = oy;
    out[v * 3 + 2] = oz;
  }
  return out;
}

/** A plain 1.8 m figure beside things that have no body to give their scale. */
function addReference(scene: Scene, folder: string): AbstractMesh | null {
  if (["races", "gear", "outfits", "weapons", "beasts"].includes(folder)) return null;
  const box = boundsOf(subjectMeshes(scene));
  if (!box) return null;
  const figure = MeshBuilder.CreateCapsule("shotFigure", { height: 1.8, radius: 0.25 }, scene);
  const material = new StandardMaterial("shotFigure", scene);
  material.diffuseColor = new Color3(0.55, 0.6, 0.7);
  figure.material = material;
  figure.position.set(box.max.x + 0.6, box.min.y + 0.9, (box.min.z + box.max.z) / 2);
  return figure;
}

/** Whether a mesh is the thing looked at, not the stage round it. */
export function isSubject(mesh: AbstractMesh): boolean {
  return mesh.getClassName() !== "LinesMesh" && !NOT_SUBJECT.test(mesh.name);
}

/** What a look (debugMaterial.ts) is put on: the subject, and the reference figure beside it. */
const isLooked = (mesh: AbstractMesh): boolean => isSubject(mesh) || mesh.name === "shotFigure";

function subjectMeshes(scene: Scene): AbstractMesh[] {
  return scene.meshes.filter((mesh) => mesh.isEnabled() && mesh.isVisible && mesh.getTotalVertices() > 0 && isSubject(mesh));
}

function boundsOf(meshes: AbstractMesh[]): { min: Vector3; max: Vector3 } | null {
  if (meshes.length === 0) return null;
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    const b = mesh.getBoundingInfo().boundingBox;
    min.minimizeInPlace(b.minimumWorld);
    max.maximizeInPlace(b.maximumWorld);
  }
  return { min, max };
}

/** The camera at a view's angles, near enough that the box fills the cell. */
function frame(stage: Stage, view: { alpha: number; beta: number; head?: boolean }, box: { min: Vector3; max: Vector3 } | null, aspect: number): void {
  const camera = stage.camera;
  camera.fov = FOV;
  camera.alpha = view.alpha;
  camera.beta = view.beta;
  if (!box) return;
  let min = box.min.clone();
  const max = box.max.clone();
  // The head: the top fifth of the subject's height.
  if (view.head) min = new Vector3(min.x, max.y - (max.y - min.y) * 0.2, min.z);
  const centre = min.add(max).scale(0.5);
  camera.target.copyFrom(centre);
  // Extent of the box across and up the screen, from the view's direction.
  const dir = new Vector3(Math.cos(view.alpha) * Math.sin(view.beta), Math.cos(view.beta), Math.sin(view.alpha) * Math.sin(view.beta));
  const up = Math.abs(dir.y) > 0.99 ? new Vector3(-Math.cos(view.alpha), 0, -Math.sin(view.alpha)) : Vector3.Up();
  const right = Vector3.Cross(up, dir).normalize();
  const screenUp = Vector3.Cross(dir, right).normalize();
  let w = 0;
  let h = 0;
  let d = 0;
  for (const corner of corners(min, max)) {
    const r = corner.subtract(centre);
    w = Math.max(w, Math.abs(Vector3.Dot(r, right)));
    h = Math.max(h, Math.abs(Vector3.Dot(r, screenUp)));
    d = Math.max(d, Math.abs(Vector3.Dot(r, dir)));
  }
  const tan = Math.tan(FOV / 2);
  camera.radius = Math.max(h / tan, w / (tan * aspect)) * 1.12 + d;
  camera.minZ = Math.max(0.01, camera.radius / 1000);
  camera.lowerRadiusLimit = null;
  camera.upperRadiusLimit = null;
  camera.lowerBetaLimit = null;
  camera.upperBetaLimit = null;
  camera.getViewMatrix(true);
}

function corners(min: Vector3, max: Vector3): Vector3[] {
  const list: Vector3[] = [];
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) list.push(new Vector3(x, y, z));
  return list;
}

/** The subject's figures: each root mesh, with the meshes under it. */
function rootsOf(subject: AbstractMesh[]): Map<AbstractMesh, AbstractMesh[]> {
  const roots = new Map<AbstractMesh, AbstractMesh[]>();
  for (const mesh of subject) {
    let root: AbstractMesh = mesh;
    while (root.parent && (root.parent as AbstractMesh).getBoundingInfo) root = root.parent as AbstractMesh;
    roots.set(root, [...(roots.get(root) ?? []), mesh]);
  }
  return roots;
}

/** Each figure (a root mesh with its children) named under its feet, as the camera sees it. */
function labelFigures(g: CanvasRenderingContext2D, stage: Stage, subject: AbstractMesh[], x: number, y: number, w: number, h: number): void {
  const roots = rootsOf(subject);
  if (roots.size < 2 || roots.size > 24) return;
  const scene = stage.scene;
  const transform = scene.getTransformMatrix();
  const viewport = stage.camera.viewport.toGlobal(w, h);
  [...roots.entries()].forEach(([root, meshes], i) => {
    const box = boundsOf(meshes)!;
    const foot = new Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    const p = Vector3.Project(foot, Matrix.Identity(), transform, viewport);
    if (p.z < 0 || p.z > 1) return;
    const text = names[i] ?? root.name;
    g.font = "12px sans-serif";
    const tw = g.measureText(text).width;
    label(g, text, x + Math.max(4, Math.min(w - tw - 4, p.x - tw / 2)), y + Math.min(h - 10, p.y + 12), "#cfe3ff");
  });
}

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  g.font = g.font.includes("bold") ? "12px sans-serif" : g.font;
  const tw = g.measureText(text).width;
  g.fillStyle = "rgba(0,0,0,0.6)";
  g.fillRect(x - 3, y - 9, tw + 6, 18);
  g.fillStyle = color;
  g.textBaseline = "middle";
  g.fillText(text, x, y);
}
