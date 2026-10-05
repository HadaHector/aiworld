// The collision sandbox (collision.html): a character on the collision motor among preset scenes and
// shapes spawned at will, with its contacts, rays and lines of sight drawn. See COLLISION.md.
import {
  Color3,
  Color4,
  HemisphericLight,
  DirectionalLight,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Vector3,
  VertexData,
  type LinesMesh,
} from "@babylonjs/core";
import { createEngine, createScene } from "../core/engine";
import { createInput } from "../player/input";
import { createThirdPersonCamera } from "../player/thirdPersonCamera";
import {
  createCharacterMotor,
  createCollisionWorld,
  DEFAULT_MOTOR,
  Layers,
  madd,
  quatFromEuler,
  rotate,
  vec3,
  type ContactKind,
  type Shape,
  type ShapeDesc,
  type Vec3,
} from "../world/collision/index";
import { PRESETS, type Preset } from "./presets";

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>("renderCanvas");
const hud = element<HTMLElement>("hud");
const engine = createEngine(canvas);
const scene = createScene(engine);
scene.fogMode = 0;
scene.clearColor = new Color4(0.42, 0.55, 0.66, 1);
new HemisphericLight("sky", new Vector3(0.2, 1, 0.1), scene).intensity = 0.75;
const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.35), scene);
sun.intensity = 0.55;

const toBabylon = (v: Vec3): Vector3 => new Vector3(v.x, v.y, v.z);
const fromBabylon = (v: Vector3): Vec3 => vec3(v.x, v.y, v.z);

// ---------------------------------------------------------------------------------------------
// The URL: the scene, the character's size and feel, and the camera.

const params = new URLSearchParams(location.search);
const numberParam = (name: string, fallback: number): number => {
  const value = Number(params.get(name));
  return params.has(name) && Number.isFinite(value) ? value : fallback;
};
let preset: Preset = PRESETS.find((p) => p.id === params.get("preset")) ?? PRESETS[0];
const feel = {
  radius: numberParam("radius", DEFAULT_MOTOR.radius),
  height: numberParam("height", DEFAULT_MOTOR.height),
  stepHeight: numberParam("step", DEFAULT_MOTOR.stepHeight),
  maxSlope: numberParam("slope", DEFAULT_MOTOR.maxSlope),
  jumpSpeed: numberParam("jump", DEFAULT_MOTOR.jumpSpeed),
  speed: numberParam("speed", 6),
};

function writeUrl(): void {
  const next = new URLSearchParams();
  next.set("preset", preset.id);
  next.set("radius", String(feel.radius));
  next.set("height", String(feel.height));
  next.set("step", String(feel.stepHeight));
  next.set("slope", String(feel.maxSlope));
  next.set("jump", String(feel.jumpSpeed));
  next.set("speed", String(feel.speed));
  next.set("camera", [camera.alpha, camera.beta, camera.radius].map((n) => n.toFixed(3)).join(","));
  history.replaceState(null, "", `${location.pathname}?${next}`);
}

// ---------------------------------------------------------------------------------------------
// The world, and a mesh for each shape in it.

const world = createCollisionWorld();
let presetBatch = -1;
const meshes = new Map<number, Mesh>();
const spawned = new Set<number>();

function material(name: string, color: Color3, alpha = 1): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(0.05, 0.05, 0.05);
  m.alpha = alpha;
  m.backFaceCulling = false;
  m.twoSidedLighting = true;
  return m;
}
const solidMaterial = material("solid", new Color3(0.72, 0.7, 0.64));
const spawnedMaterial = material("spawned", new Color3(0.55, 0.68, 0.85));
const sightMaterial = material("sightOnly", new Color3(0.45, 0.8, 0.5), 0.45);
const groundMaterial = material("ground", new Color3(0.42, 0.5, 0.36));

function meshFor(shape: Shape): Mesh {
  const name = `shape${shape.id}`;
  let mesh: Mesh;
  switch (shape.kind) {
    case "sphere":
      mesh = MeshBuilder.CreateSphere(name, { diameter: shape.radius * 2, segments: 16 }, scene);
      mesh.position = toBabylon(shape.center);
      break;
    case "capsule": {
      const axis = toBabylon(shape.b).subtract(toBabylon(shape.a));
      const length = axis.length();
      mesh = MeshBuilder.CreateCapsule(name, { height: length + shape.radius * 2, radius: shape.radius, tessellation: 16, subdivisions: 2 }, scene);
      mesh.position = toBabylon(shape.a).add(axis.scale(0.5));
      mesh.rotationQuaternion = new Quaternion();
      if (length > 1e-6) Quaternion.FromUnitVectorsToRef(Vector3.Up(), axis.normalize(), mesh.rotationQuaternion);
      break;
    }
    case "box":
      mesh = MeshBuilder.CreateBox(name, { width: shape.half.x * 2, height: shape.half.y * 2, depth: shape.half.z * 2 }, scene);
      mesh.position = toBabylon(shape.center);
      mesh.rotationQuaternion = new Quaternion(shape.rotation.x, shape.rotation.y, shape.rotation.z, shape.rotation.w);
      break;
    case "convex":
      mesh = customMesh(name, shape.points, shape.triangles);
      break;
    case "heightfield": {
      const points: Vec3[] = [];
      for (let row = 0; row < shape.rows; row++) {
        for (let col = 0; col < shape.columns; col++) {
          points.push(vec3(shape.originX + col * shape.cell, shape.heights[row * shape.columns + col], shape.originZ + row * shape.cell));
        }
      }
      const triangles: number[] = [];
      for (let row = 0; row < shape.rows - 1; row++) {
        for (let col = 0; col < shape.columns - 1; col++) {
          if (shape.holes && shape.holes[row * (shape.columns - 1) + col]) continue;
          const i = (c: number, r: number): number => (row + r) * shape.columns + col + c;
          triangles.push(i(0, 0), i(1, 1), i(1, 0), i(0, 0), i(0, 1), i(1, 1));
        }
      }
      mesh = customMesh(name, points, triangles);
      break;
    }
  }
  mesh.material =
    shape.kind === "heightfield" ? groundMaterial : !(shape.layers & Layers.solid) ? sightMaterial : spawned.has(shape.id) ? spawnedMaterial : solidMaterial;
  // Outlines on the flat-sided ones; round ones would only show their tessellation.
  if (shape.kind === "box" || shape.kind === "convex") {
    mesh.enableEdgesRendering(0.95);
    mesh.edgesWidth = 2;
    mesh.edgesColor = new Color4(0.1, 0.12, 0.15, 0.8);
  }
  return mesh;
}

/** A flat-shaded mesh from points and triangles (counter-clockwise from outside, as the hulls are). */
function customMesh(name: string, points: Vec3[], triangles: number[]): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = points.flatMap((p) => [p.x, p.y, p.z]);
  // Babylon winds the other way round.
  const indices: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) indices.push(triangles[i], triangles[i + 2], triangles[i + 1]);
  data.indices = indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(data.positions, data.indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh);
  mesh.convertToFlatShadedMesh();
  return mesh;
}

function addShapes(ids: Iterable<number>): void {
  for (const id of ids) {
    const shape = world.shape(id);
    if (shape) meshes.set(id, meshFor(shape));
  }
}

function dropMesh(id: number): void {
  meshes.get(id)?.dispose();
  meshes.delete(id);
}

function loadPreset(next: Preset): void {
  if (presetBatch >= 0) {
    for (const [id, mesh] of meshes) {
      if (!spawned.has(id)) { mesh.dispose(); meshes.delete(id); }
    }
    world.removeBatch(presetBatch);
  }
  preset = next;
  presetBatch = world.addBatch(next.shapes);
  addShapes(world.batchShapes(presetBatch).map((shape) => shape.id));
  teleport(next.spawn);
  writeUrl();
}

function teleport(feet: Vec3): void {
  motor.teleport(feet);
  recentContacts.length = 0;
  recentPath.length = 0;
}

// ---------------------------------------------------------------------------------------------
// The character.

const motor = createCharacterMotor(world, { radius: feel.radius, height: feel.height, stepHeight: feel.stepHeight, maxSlope: feel.maxSlope, jumpSpeed: feel.jumpSpeed });
// See-through, so its contacts show.
const playerMaterial = material("player", new Color3(0.2, 0.5, 0.9), 0.45);
let player = makePlayerMesh();
function makePlayerMesh(): Mesh {
  const mesh = MeshBuilder.CreateCapsule("player", { height: motor.settings.height, radius: motor.settings.radius, tessellation: 16 }, scene);
  mesh.material = playerMaterial;
  mesh.isPickable = false;
  return mesh;
}
const cameraTarget = new Mesh("cameraTarget", scene);
const camera = createThirdPersonCamera(scene, canvas, cameraTarget);
camera.lowerRadiusLimit = 2;
camera.radius = 14;
{
  const saved = params.get("camera")?.split(",").map(Number);
  if (saved && saved.length === 3 && saved.every(Number.isFinite)) [camera.alpha, camera.beta, camera.radius] = saved;
}
camera.onViewMatrixChangedObservable.add(() => scheduleUrl());
let urlTimer = 0;
function scheduleUrl(): void {
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(writeUrl, 300);
}

const input = createInput();
const forward = new Vector3();
const right = new Vector3();
let updateMs = 0;

function updatePlayer(dt: number): void {
  const axis = input.getMoveAxis();
  camera.getDirectionToRef(Vector3.Forward(), forward);
  forward.y = 0;
  forward.normalize();
  camera.getDirectionToRef(Vector3.Right(), right);
  right.y = 0;
  right.normalize();
  const move = forward.scale(axis.y).add(right.scale(axis.x)).scale(feel.speed);
  const start = performance.now();
  motor.update(dt, { move: fromBabylon(move), jump: input.takeJump() });
  updateMs = updateMs * 0.9 + (performance.now() - start) * 0.1;
  const feet = motor.state.feet;
  player.position.set(feet.x, feet.y + motor.settings.height / 2, feet.z);
  if (move.lengthSquared() > 0) player.rotation.y = Math.atan2(move.x, move.z);
  cameraTarget.position.set(feet.x, feet.y + motor.settings.height * 0.8, feet.z);
}

// ---------------------------------------------------------------------------------------------
// Drawing: contacts and their normals, the path the sweeps took, rays.

const KIND_COLORS: Record<ContactKind, Color4> = {
  ground: new Color4(0.37, 0.82, 0.41, 1),
  wall: new Color4(0.94, 0.63, 0.25, 1),
  ceiling: new Color4(0.94, 0.31, 0.31, 1),
};
let contactLines: LinesMesh | null = null;
/** Contacts linger a moment, so a single frame's touch can be seen. */
const recentContacts: { point: Vec3; normal: Vec3; kind: ContactKind; age: number }[] = [];
const recentPath: Vec3[] = [];

function drawContacts(dt: number, show: boolean): void {
  contactLines?.dispose();
  contactLines = null;
  for (const c of motor.state.contacts) recentContacts.push({ ...c, age: 0 });
  for (const c of recentContacts) c.age += dt;
  while (recentContacts.length > 0 && recentContacts[0].age > 0.5) recentContacts.shift();
  if (recentContacts.length > 200) recentContacts.splice(0, recentContacts.length - 200);
  recentPath.push(...motor.state.path.slice(1));
  if (recentPath.length > 400) recentPath.splice(0, recentPath.length - 400);
  if (!show) return;
  const lines: Vector3[][] = [];
  const colors: Color4[][] = [];
  for (const c of recentContacts) {
    lines.push([toBabylon(c.point), toBabylon(madd(c.point, c.normal, 0.6))]);
    colors.push([KIND_COLORS[c.kind], KIND_COLORS[c.kind]]);
  }
  if (recentPath.length > 1) {
    lines.push(recentPath.map((p) => toBabylon(p).add(new Vector3(0, 0.03, 0))));
    colors.push(recentPath.map(() => new Color4(0.9, 0.9, 1, 0.8)));
  }
  if (motor.state.grounded && motor.state.groundNormal) {
    const f = motor.state.feet;
    lines.push([toBabylon(f), toBabylon(madd(f, motor.state.groundNormal, 1))]);
    colors.push([new Color4(1, 1, 1, 1), new Color4(1, 1, 1, 1)]);
  }
  if (lines.length > 0) {
    contactLines = MeshBuilder.CreateLineSystem("contacts", { lines, colors }, scene);
    contactLines.isPickable = false;
  }
}

let rayLines: LinesMesh | null = null;
const hitMarker = MeshBuilder.CreateSphere("hit", { diameter: 0.18 }, scene);
hitMarker.material = material("hitMarker", new Color3(1, 0.85, 0.2));
hitMarker.isPickable = false;
hitMarker.setEnabled(false);
let lastHit: Vec3 | null = null;
let sightLine: LinesMesh | null = null;

function castClickRay(x: number, y: number, remove: boolean): void {
  const ray = scene.createPickingRay(x, y, null, camera);
  const origin = fromBabylon(ray.origin);
  const dir = fromBabylon(ray.direction);
  const hit = world.raycast(origin, dir, 500, ~0);
  rayLines?.dispose();
  rayLines = null;
  if (!hit) { hitMarker.setEnabled(false); lastHit = null; return; }
  if (remove && spawned.has(hit.shape.id)) {
    world.remove(hit.shape.id);
    spawned.delete(hit.shape.id);
    dropMesh(hit.shape.id);
    return;
  }
  lastHit = madd(hit.point, hit.normal, 0.05);
  hitMarker.position = toBabylon(hit.point);
  hitMarker.setEnabled(true);
  rayLines = MeshBuilder.CreateLineSystem(
    "ray",
    {
      lines: [
        [toBabylon(madd(origin, dir, Math.min(hit.distance, 1.5))), toBabylon(hit.point)],
        [toBabylon(hit.point), toBabylon(madd(hit.point, hit.normal, 1.2))],
      ],
      colors: [
        [new Color4(1, 0.85, 0.2, 0.6), new Color4(1, 0.85, 0.2, 1)],
        [new Color4(0.3, 0.9, 1, 1), new Color4(0.3, 0.9, 1, 1)],
      ],
    },
    scene,
  );
  rayLines.isPickable = false;
}

function drawSight(show: boolean): void {
  sightLine?.dispose();
  sightLine = null;
  if (!show || !lastHit) return;
  const f = motor.state.feet;
  const eye = vec3(f.x, f.y + motor.settings.height * 0.9, f.z);
  const to = vec3(lastHit.x - eye.x, lastHit.y - eye.y, lastHit.z - eye.z);
  const distance = Math.hypot(to.x, to.y, to.z);
  const blocked = world.raycast(eye, to, distance - 0.01, Layers.sight);
  const color = blocked ? new Color4(0.95, 0.3, 0.3, 1) : new Color4(0.4, 0.95, 0.45, 1);
  const end = blocked ? blocked.point : lastHit;
  sightLine = MeshBuilder.CreateLines("sight", { points: [toBabylon(eye), toBabylon(end)], colors: [color, color] }, scene);
  sightLine.isPickable = false;
}

// Click (not a drag) to cast; shift-click deletes a spawned shape.
let down: { x: number; y: number } | null = null;
canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointerup", (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) {
    const rect = canvas.getBoundingClientRect();
    castClickRay(e.clientX - rect.left, e.clientY - rect.top, e.shiftKey);
  }
  down = null;
});

// ---------------------------------------------------------------------------------------------
// Spawning in front of the character.

function spawn(kind: "sphere" | "capsule" | "box" | "convex"): void {
  const size = Number(element<HTMLInputElement>("spawnSize").value);
  const tilt = element<HTMLInputElement>("spawnTilt").checked;
  const sightOnly = element<HTMLInputElement>("spawnSightOnly").checked;
  // Out ahead of it the way the camera looks, sat on whatever is below that point.
  camera.getDirectionToRef(Vector3.Forward(), forward);
  const ahead = vec3(forward.x, 0, forward.z);
  const flat = Math.hypot(ahead.x, ahead.z) || 1;
  const feet = motor.state.feet;
  const spot = madd(feet, vec3(ahead.x / flat, 0, ahead.z / flat), motor.settings.radius + 1.5 + size);
  const above = vec3(spot.x, feet.y + motor.settings.height + size * 2, spot.z);
  const hit = world.raycast(above, vec3(0, -1, 0), 100, ~0);
  const at = hit ? madd(hit.point, vec3(0, 1, 0), size * 0.45) : vec3(spot.x, feet.y + size * 0.5, spot.z);
  const rotation = tilt ? quatFromEuler(Math.random() * 7, Math.random() * 7, Math.random() * 7) : quatFromEuler(Math.random() * 7);
  const layers = sightOnly ? Layers.sight : Layers.solid | Layers.sight | Layers.shot;
  let desc: ShapeDesc;
  switch (kind) {
    case "sphere":
      desc = { kind, center: at, radius: size / 2, layers };
      break;
    case "capsule": {
      const half = rotate(rotation, vec3(0, size / 2, 0));
      desc = { kind, a: madd(at, half, -1), b: madd(at, half, 1), radius: size * 0.22, layers };
      break;
    }
    case "box":
      desc = { kind, center: at, half: vec3(size / 2, size * (0.2 + Math.random() * 0.4), size * (0.25 + Math.random() * 0.4)), rotation, layers };
      break;
    case "convex":
      desc = {
        kind,
        points: Array.from({ length: 6 + Math.floor(Math.random() * 8) }, () => vec3(at.x + (Math.random() - 0.5) * size, at.y + (Math.random() - 0.5) * size, at.z + (Math.random() - 0.5) * size)),
        layers,
      };
      break;
  }
  const id = world.add(desc);
  spawned.add(id);
  addShapes([id]);
}

// ---------------------------------------------------------------------------------------------
// The panel.

const presetSelect = element<HTMLSelectElement>("preset");
for (const p of PRESETS) presetSelect.add(new Option(p.label, p.id, false, p.id === preset.id));
presetSelect.addEventListener("change", () => {
  loadPreset(PRESETS.find((p) => p.id === presetSelect.value) ?? PRESETS[0]);
  canvas.focus();
});
element("respawn").addEventListener("click", () => { teleport(preset.spawn); canvas.focus(); });
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-spawn]")) {
  button.addEventListener("click", () => { spawn(button.dataset.spawn as "sphere"); canvas.focus(); });
}
element("clear").addEventListener("click", () => {
  for (const id of spawned) { world.remove(id); dropMesh(id); }
  spawned.clear();
  canvas.focus();
});

function slider(id: keyof typeof feel, digits: number, apply: (value: number) => void): void {
  const inputEl = element<HTMLInputElement>(id);
  const out = inputEl.parentElement!.querySelector("output")!;
  inputEl.value = String(feel[id]);
  out.textContent = feel[id].toFixed(digits);
  inputEl.addEventListener("input", () => {
    feel[id] = Number(inputEl.value);
    out.textContent = feel[id].toFixed(digits);
    apply(feel[id]);
    scheduleUrl();
  });
  inputEl.addEventListener("change", () => canvas.focus());
}
element<HTMLInputElement>("spawnSize").nextElementSibling!.textContent = element<HTMLInputElement>("spawnSize").value;
element<HTMLInputElement>("spawnSize").addEventListener("input", (e) => {
  (e.target as HTMLInputElement).nextElementSibling!.textContent = (e.target as HTMLInputElement).value;
});
const resize = (): void => {
  motor.configure({ radius: feel.radius, height: Math.max(feel.height, feel.radius * 2) });
  player.dispose();
  player = makePlayerMesh();
};
slider("radius", 2, resize);
slider("height", 1, resize);
slider("stepHeight", 2, (v) => motor.configure({ stepHeight: v }));
slider("maxSlope", 0, (v) => motor.configure({ maxSlope: v }));
slider("jumpSpeed", 1, (v) => motor.configure({ jumpSpeed: v }));
slider("speed", 1, () => {});

// ---------------------------------------------------------------------------------------------

loadPreset(preset);
canvas.focus();

engine.runRenderLoop(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
  updatePlayer(dt);
  drawContacts(dt, element<HTMLInputElement>("showContacts").checked);
  drawSight(element<HTMLInputElement>("sight").checked);
  const s = motor.state;
  const slope = s.groundNormal ? (Math.acos(Math.min(1, s.groundNormal.y)) * 180) / Math.PI : null;
  hud.textContent = [
    `feet      ${s.feet.x.toFixed(2)}, ${s.feet.y.toFixed(2)}, ${s.feet.z.toFixed(2)}`,
    `grounded  ${s.grounded ? "yes" : "no"}${slope !== null ? `  (slope ${slope.toFixed(1)}°)` : ""}`,
    `velocity  ${Math.hypot(s.velocity.x, s.velocity.z).toFixed(2)} across, ${s.velocity.y.toFixed(2)} up`,
    `contacts  ${s.contacts.length}`,
    `motor     ${updateMs.toFixed(3)} ms`,
  ].join("\n");
  scene.render();
});
window.addEventListener("resize", () => engine.resize());

/** A console handle, as `__aiworld` is on the world. */
(window as unknown as { __collision: unknown }).__collision = { world, motor, scene, camera, loadPreset: (id: string) => loadPreset(PRESETS.find((p) => p.id === id)!) };
