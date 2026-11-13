// Looks for checking a model (SHOTS.md): each mesh's material swapped for one debug shader, and swapped
// back. By hand from the workbench's Mode menu, or `mode=` in a shot.
//   backface   front faces grey, back faces red - flipped winding, holes seen through
//   id         a flat colour per material / mesh (per layer on a building) - which part is which
//   uv         a checker in the texture's space - stretching, seams, flipped islands
//   normals    the world normal as colour - flipped or smoothed-wrong normals
//   overdraw   every layer added up, depth ignored - coincident faces (z-fighting) glow brighter
//   silhouette flat white on a bare stage - does the shape read, at game distance and icon size
//   unlit      the colour without the light - is it near black, or blown out (standard materials only)

import { Color3, Constants, ShaderMaterial, StandardMaterial, type AbstractMesh, type Mesh, type Material, type Scene } from "@babylonjs/core";
import "@babylonjs/core/Shaders/ShadersInclude/bonesDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/bonesVertex";

export const DEBUG_MODES = ["lit", "backface", "id", "uv", "normals", "overdraw", "silhouette", "unlit"] as const;
export type DebugMode = (typeof DEBUG_MODES)[number];

const SHADER_CODE: Record<DebugMode, number> = { lit: -1, backface: 0, id: 1, uv: 2, normals: 3, overdraw: 4, silhouette: 5, unlit: -1 };

const VERTEX = `precision highp float;
attribute vec3 position;
attribute vec3 normal;
#ifdef HAS_UV
attribute vec2 uv;
#endif
#ifdef HAS_LAYER
attribute float layer;
#endif
#include<bonesDeclaration>
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vNormal;
varying vec2 vUV;
varying float vLayer;
void main(void) {
  mat4 finalWorld = world;
#include<bonesVertex>
  gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
  vNormal = normalize(mat3(finalWorld) * normal);
#ifdef HAS_UV
  vUV = uv;
#else
  vUV = vec2(-1.0);
#endif
#ifdef HAS_LAYER
  vLayer = layer;
#else
  vLayer = -1.0;
#endif
}`;

const FRAGMENT = `precision highp float;
uniform int mode;
uniform vec3 idColor;
varying vec3 vNormal;
varying vec2 vUV;
varying float vLayer;
vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
void main(void) {
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float shade = 0.55 + 0.45 * max(0.0, dot(n, normalize(vec3(0.4, 0.8, 0.3))));
  if (mode == 0) {
    gl_FragColor = vec4(gl_FrontFacing ? vec3(0.62, 0.68, 0.76) * shade : vec3(0.9, 0.08, 0.08), 1.0);
  } else if (mode == 1) {
    vec3 c = vLayer >= 0.0 ? hue(fract(vLayer * 0.618034)) * 0.8 + 0.15 : idColor;
    gl_FragColor = vec4(c * shade, 1.0);
  } else if (mode == 2) {
    if (vUV.x < -0.5) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
    vec2 cell = floor(vUV * 8.0);
    float check = mod(cell.x + cell.y, 2.0);
    vec3 tint = vec3(fract(vUV.x), fract(vUV.y), 0.5);
    gl_FragColor = vec4(mix(tint * 0.45, vec3(0.95), check * 0.6) * shade, 1.0);
  } else if (mode == 3) {
    gl_FragColor = vec4(normalize(vNormal) * 0.5 + 0.5, 1.0);
  } else if (mode == 4) {
    gl_FragColor = vec4(1.0, 0.45, 0.1, 0.22);
  } else {
    gl_FragColor = vec4(0.95, 0.95, 0.95, 1.0);
  }
}`;

/** The stage's own furniture, hidden in every mode but lit and unlit; the grid stays for scale. */
const FURNITURE = /^(groundPatch|sky|grass|yard_|line_)/;

interface Swapped {
  restore: () => void;
}

let active: Swapped | null = null;

/** Puts a scene into a mode (or back to lit). One mode at a time: switching restores the last first. */
export function setDebugMode(scene: Scene, mode: string, subject: (mesh: AbstractMesh) => boolean): void {
  active?.restore();
  active = null;
  if (mode === "lit" || !(DEBUG_MODES as readonly string[]).includes(mode)) return;
  const undo: (() => void)[] = [];
  const meshes = scene.meshes.filter((mesh) => mesh.getTotalVertices() > 0 && mesh.getClassName() !== "LinesMesh");
  const made: Material[] = [];
  const byMaterial = new Map<Material | null, Color3>();
  for (const mesh of meshes) {
    if (FURNITURE.test(mesh.name)) {
      if (mode !== "unlit" && mesh.isVisible) {
        mesh.isVisible = false;
        undo.push(() => (mesh.isVisible = true));
      }
      continue;
    }
    if (!subject(mesh)) continue;
    const original = mesh.material;
    if (mode === "unlit") {
      if (original instanceof StandardMaterial) {
        const { disableLighting, emissiveColor, emissiveTexture } = original;
        original.disableLighting = true;
        original.emissiveColor = original.diffuseTexture ? Color3.White() : original.diffuseColor.clone();
        original.emissiveTexture = original.diffuseTexture;
        undo.push(() => {
          original.disableLighting = disableLighting;
          original.emissiveColor = emissiveColor;
          original.emissiveTexture = emissiveTexture;
        });
      }
      continue;
    }
    if (!byMaterial.has(original)) byMaterial.set(original, Color3.FromHSV((byMaterial.size * 137.508) % 360, 0.65, 0.9));
    const kinds = (mesh as Mesh).getVerticesDataKinds?.() ?? [];
    const defines = [kinds.includes("uv") ? "#define HAS_UV" : "", kinds.includes("layer") ? "#define HAS_LAYER" : ""].filter(Boolean);
    const attributes = ["position", "normal", ...(kinds.includes("uv") ? ["uv"] : []), ...(kinds.includes("layer") ? ["layer"] : [])];
    const material = new ShaderMaterial(
      `debug_${mode}_${mesh.name}`,
      scene,
      { vertexSource: VERTEX, fragmentSource: FRAGMENT },
      { attributes, uniforms: ["world", "viewProjection", "mode", "idColor", "mBones", "boneTextureWidth"], samplers: ["boneSampler"], defines, needAlphaBlending: mode === "overdraw" },
    );
    material.setInt("mode", SHADER_CODE[mode as DebugMode]);
    material.setColor3("idColor", byMaterial.get(original)!);
    material.backFaceCulling = false;
    // Which winding is the front is the original's call (characters and buildings say clockwise).
    if (original) material.sideOrientation = original.sideOrientation;
    if (mode === "overdraw") {
      material.alphaMode = Constants.ALPHA_ADD;
      material.disableDepthWrite = true;
      material.depthFunction = Constants.ALWAYS;
    }
    made.push(material);
    mesh.material = material;
    undo.push(() => (mesh.material = original));
  }
  active = {
    restore: () => {
      for (const step of undo.reverse()) step();
      for (const material of made) material.dispose();
    },
  };
}
