// Shots (SHOTS.md): the stage taken from fixed angles and laid out on one image - a contact sheet of
// views, or a filmstrip of one view over time - for `npm run shot` (scripts/shot/shot.mjs) or by hand
// from the console: `await __workbench.shoot({ views: ["front", "side"] })` returns a PNG data URL.
// Only with `?shot` in the URL: the render loop stops and time stands still until a shot steps it.

import { Color3, Matrix, MeshBuilder, StandardMaterial, Vector3, type AbstractMesh, type Engine, type Scene } from "@babylonjs/core";
import type { Stage } from "./stage";

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
  width?: number;
  height?: number;
  title?: string;
}

interface ShotHost {
  engine: Engine;
  canvas: HTMLCanvasElement;
  stage: () => Stage | null;
  /** The status line: empty once a preview is up. */
  status: () => string;
  folder: () => string;
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
    const cells = film ? times.map((t) => ({ view: views[0], t })) : views.map((view) => ({ view, t: times[0] }));
    const width = spec.width ?? 1600;
    const height = spec.height ?? 1000;
    const titleH = 28;
    // Cells as near square as the image allows.
    let best = { cols: 1, rows: 1, size: 0 };
    for (let cols = 1; cols <= cells.length; cols++) {
      const rows = Math.ceil(cells.length / cols);
      const size = Math.min(width / cols, (height - titleH) / rows / 0.75);
      if (size > best.size) best = { cols, rows, size };
    }
    const cellW = Math.floor(width / best.cols);
    const cellH = Math.floor((height - titleH) / best.rows);

    const reference = addReference(scene, host.folder());
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
      for (const [i, cell] of cells.entries()) {
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
        g.strokeStyle = "#2a2f37";
        g.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
        label(g, film ? `${cell.view}  t=${cell.t.toFixed(2)} s` : cell.view, x + 8, y + 14, "#ffd479");
        if (!film || i === 0) labelFigures(g, stage, subject, x, y, cellW, cellH);
      }
    } finally {
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

  return {
    shoot,
    /** A preview is up and done: what a shot waits for. */
    shotReady: () => !!host.stage() && host.status() === "",
    views: SHOT_VIEWS,
  };
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

function subjectMeshes(scene: Scene): AbstractMesh[] {
  return scene.meshes.filter((mesh) => mesh.isEnabled() && mesh.isVisible && mesh.getTotalVertices() > 0 && mesh.getClassName() !== "LinesMesh" && !NOT_SUBJECT.test(mesh.name));
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
