// The beasts page (beasts.html, see BEASTS.md, *Workbench*): every beast plan in the packs, a row
// each, at several seeds side by side, playing a gait at a speed, a clip, a flinch or dying - to
// judge looks and gaits. Editing a plan's json5 reloads the page, keeping what was chosen.

import { ArcRotateCamera, Color3, Color4, DirectionalLight, HemisphericLight, MeshBuilder, Scene, ShadowGenerator, SkeletonViewer, StandardMaterial, Vector3 } from "@babylonjs/core";
import { createEngine } from "../core/engine";
import { configNameFromUrl, fetchPackSources, fetchWorldConfig } from "../world/content/loadContent";
import { ContentError, formatIssue } from "../world/content/contentReader";
import { resolveBeasts, type BeastDef } from "../character/beast/beastDef";
import { buildBeast, type BeastGeometry } from "../character/beast/beastBuild";
import { paintBeast } from "../character/beast/beastPaint";
import { bakeGaits, createBeastAnimator, type BeastInput } from "../character/beast/beastAnim";
import { createBeastMesh } from "../character/beast/beastMesh";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("stage");
const side = $<HTMLDivElement>("side");
const status = $<HTMLSpanElement>("status");
const controls = {
  only: $<HTMLSelectElement>("only"),
  seeds: $<HTMLInputElement>("seeds"),
  seed: $<HTMLInputElement>("seed"),
  play: $<HTMLSelectElement>("play"),
  speed: $<HTMLInputElement>("speed"),
  path: $<HTMLSelectElement>("path"),
  atlas: $<HTMLSelectElement>("atlas"),
  traits: $<HTMLInputElement>("traits"),
  wire: $<HTMLInputElement>("wire"),
  bones: $<HTMLInputElement>("bones"),
};

// What was chosen survives a reload (the page reloads on every pack edit).
const params = new URLSearchParams(location.search);
for (const [key, input] of Object.entries(controls)) {
  const value = params.get(key);
  if (value === null) continue;
  if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = value === "1";
  else input.value = value;
}
function remember(): void {
  const next = new URLSearchParams();
  for (const [key, input] of Object.entries(controls)) next.set(key, input instanceof HTMLInputElement && input.type === "checkbox" ? (input.checked ? "1" : "0") : input.value);
  history.replaceState(null, "", `?${next}`);
}

let beasts: Map<string, BeastDef>;
try {
  const config = await fetchWorldConfig(configNameFromUrl());
  beasts = resolveBeasts(await fetchPackSources(undefined, config));
} catch (error) {
  side.innerHTML = "";
  const pre = document.createElement("pre");
  pre.className = "error";
  pre.textContent = error instanceof ContentError ? error.issues.map(formatIssue).join("\n") : String(error);
  side.append(pre);
  throw error;
}

const wantedOnly = params.get("only") ?? "";
controls.only.add(new Option("All beasts", ""));
for (const def of beasts.values()) controls.only.add(new Option(def.name, def.id));
controls.only.value = wantedOnly && beasts.has(wantedOnly) ? wantedOnly : "";
const PLAYS: [string, string][] = [
  ["gait", "Gait at the speed"],
  ["idle", "Idle"],
  ["attack", "Attack (swing)"],
  ["flinch", "Flinching"],
  ["die", "Dying"],
];
const wantedPlay = params.get("play") ?? "gait";
for (const [id, label] of PLAYS) controls.play.add(new Option(label, id));
for (const clip of new Set([...beasts.values()].flatMap((d) => [...d.clips.keys()]))) controls.play.add(new Option(`Clip: ${clip}`, `clip.${clip}`));
controls.play.value = [...controls.play.options].some((o) => o.value === wantedPlay) ? wantedPlay : "gait";

const engine = createEngine(canvas);
let scene: Scene | null = null;

async function rebuild(): Promise<void> {
  remember();
  $<HTMLOutputElement>("speedOut").textContent = `${Number(controls.speed.value).toFixed(1)} m/s`;
  scene?.dispose();
  const s = new Scene(engine);
  scene = s;
  s.clearColor = new Color4(0.55, 0.68, 0.8, 1);
  const camera = new ArcRotateCamera("camera", -Math.PI / 2 + 0.75, 1.15, 9, new Vector3(0, 0.5, 0), s);
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 40;
  camera.minZ = 0.05;
  const sky = new HemisphericLight("sky", new Vector3(0, 1, 0), s);
  sky.intensity = 0.55;
  sky.groundColor = new Color3(0.35, 0.32, 0.28);
  const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, 0.35), s);
  sun.position = new Vector3(20, 30, -12);
  sun.intensity = 1.1;
  const shadows = new ShadowGenerator(2048, sun);
  shadows.usePercentageCloserFiltering = true;
  const ground = MeshBuilder.CreateGround("ground", { width: 80, height: 80 }, s);
  const groundMaterial = new StandardMaterial("ground", s);
  groundMaterial.diffuseColor = new Color3(0.42, 0.48, 0.32);
  groundMaterial.specularColor = new Color3(0, 0, 0);
  ground.material = groundMaterial;
  ground.receiveShadows = true;
  // A line every metre, to read sizes and feet sliding by.
  const lines: Vector3[][] = [];
  for (let i = -20; i <= 20; i++) {
    lines.push([new Vector3(i, 0.005, -20), new Vector3(i, 0.005, 20)]);
    lines.push([new Vector3(-20, 0.005, i), new Vector3(20, 0.005, i)]);
  }
  const grid = MeshBuilder.CreateLineSystem("grid", { lines }, s);
  grid.color = new Color3(0.32, 0.38, 0.25);

  const chosen = [...beasts.values()].filter((d) => !controls.only.value || d.id === controls.only.value);
  const seeds = Math.max(1, Math.min(12, Number(controls.seeds.value) || 4));
  const firstSeed = Number(controls.seed.value) || 0;
  const atlas = Number(controls.atlas.value) || 256;
  const traits = controls.traits.value.split(/[\s,]+/).filter(Boolean);
  const play = controls.play.value;
  const speed = Number(controls.speed.value);
  const walkingPast = controls.path.value === "line";
  side.innerHTML = "";
  const table = document.createElement("table");
  status.textContent = "Building";
  let z = 0;
  const rows: { body: BeastGeometry; def: BeastDef }[] = [];
  let widest = 0;
  for (const def of chosen) {
    const started = performance.now();
    const bodies = Array.from({ length: seeds }, (_, i) => buildBeast(def, { seed: firstSeed + i, atlas: atlas === 128 ? 128 : atlas, traits }));
    const deepest = Math.max(...bodies.map((b) => Math.max(b.length, b.width) * b.size));
    const spacing = Math.max(...bodies.map((b) => b.width * b.size)) + 1.2;
    z -= deepest / 2 + 0.6;
    bodies.forEach((body, i) => {
      const seed = firstSeed + i;
      const painted = paintBeast(def, body, { seed });
      const mesh = createBeastMesh(s, `${def.id}${seed}`, body, painted, { nearest: atlas === 128 });
      mesh.mesh.scaling.setAll(body.size);
      // Facing +x, along the row, so a row is a herd walking past the camera.
      const x0 = (i - (seeds - 1) / 2) * spacing;
      mesh.mesh.position.set(x0, 0, z);
      for (const m of mesh.meshes) {
        shadows.addShadowCaster(m, false);
        m.receiveShadows = true;
      }
      if (controls.wire.checked) for (const m of mesh.meshes) if (m.material) m.material.wireframe = true;
      if (controls.bones.checked) {
        const viewer = new SkeletonViewer(mesh.skeleton, mesh.mesh, s, true, 1, { displayMode: SkeletonViewer.DISPLAY_SPHERE_AND_SPURS });
        viewer.isEnabled = true;
      }
      const baked = bakeGaits(def, body);
      const animator = createBeastAnimator(def, body, baked, seed);
      let time = 0;
      let next = 0.6;
      let travelled = 0;
      let blows = 0;
      const FROM: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      s.onBeforeRenderObservable.add(() => {
        const dt = Math.min(0.05, engine.getDeltaTime() / 1000);
        time += dt;
        const input: BeastInput = { speed: play === "gait" ? speed / body.size : 0 };
        if ((play === "attack" || play.startsWith("clip.")) && time > next) {
          input.play = play === "attack" ? "swing" : play.slice(5);
          const clip = def.clips.get(play === "attack" ? def.actions.swing ?? def.actions.attack ?? "" : play.slice(5));
          next = time + (clip?.length ?? 1) + (clip?.loop ? 2.5 : 0.8);
        }
        if (play === "flinch" && time > next) {
          const [forward, sideways] = FROM[blows++ % FROM.length];
          input.flinch = { forward, side: sideways, strength: 1 };
          next = time + 0.9;
        }
        if (play === "die") input.dead = time % 6 > 1.2;
        const pose = animator.update(input, dt);
        mesh.setPose(pose);
        if (walkingPast && play === "gait") {
          travelled = (travelled + speed * dt) % 16;
          mesh.mesh.position.x = x0 - 8 + travelled;
        }
        mesh.mesh.rotation.y = Math.PI / 2;
      });
    });
    const took = performance.now() - started;
    rows.push({ body: bodies[0], def });
    widest = Math.max(widest, spacing * seeds);
    z -= deepest / 2 + 0.6;
    const row = table.insertRow();
    row.insertCell().textContent = def.name;
    const b = bodies[0];
    row.insertCell().innerHTML = `${(b.height * b.size).toFixed(2)} m tall, ${(b.length * b.size).toFixed(2)} m long<br>${b.triangles} tris (${b.cards.count} cards), ${b.bones.length} bones<br>parts: ${b.parts.join(" ") || "-"}<br>${(took / seeds).toFixed(0)} ms each`;
  }
  const title = document.createElement("h2");
  title.textContent = "Beasts";
  side.append(title, table);
  // The first row's atlas and card texture.
  if (rows[0]) {
    const { body, def } = rows[0];
    const painted = paintBeast(def, body, { seed: firstSeed });
    side.append(heading(`${def.name} atlas`), toCanvas(painted.atlas, painted.size, painted.size));
    if (painted.cards) side.append(heading("Cards"), toCanvas(painted.cards.pixels, painted.cards.width, painted.cards.height));
  }
  camera.radius = Math.max(6, Math.max(widest, -z) * 0.9);
  camera.target = new Vector3(0, 0.4, z / 2);
  status.textContent = "";
  s.onDisposeObservable.add(() => camera.detachControl());
  (window as unknown as { __beasts: unknown }).__beasts = { beasts, rebuild, scene: s, camera };
}

function heading(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = text;
  return h;
}

function toCanvas(pixels: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const image = new ImageData(new Uint8ClampedArray(pixels), width, height);
  c.getContext("2d")!.putImageData(image, 0, 0);
  if (height > width * 2) c.style.width = "40%";
  return c;
}

for (const input of Object.values(controls)) input.addEventListener("change", () => void rebuild());
controls.speed.addEventListener("input", () => void rebuild());
engine.runRenderLoop(() => scene?.render());
window.addEventListener("resize", () => engine.resize());
await rebuild();
