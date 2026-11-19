// A cave's rock drawn (DUNGEONS.md, *Materials*): no UVs and no edges to change material at, so
// each material is laid in world space from three sides and blended by the surface's normal
// (triplanar), at its own size in metres; floor, wall and ceiling by which way the surface faces,
// over a wide band ragged with noise and with the materials' own heights (gravel gathering in the
// wall's hollows before it gives way). Lit by the world's ambient light and the light baked into
// each vertex (caveLight.ts) - the sun never reaches it.
import { Color3, Effect, Material, RawTexture2DArray, ShaderMaterial, Texture, Vector3, type Scene } from "@babylonjs/core";
import type { MaterialDef } from "../materials/materialTypes";
import { TEXTURE_RESOLUTION } from "../materials/textureGen";
import { bakeTerrainTextures } from "../materials/materialLibrary";
import { LIT_SHADING_GLSL, LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS, type LitShading } from "../materials/litShading";
import type { CaveLook } from "./dungeonDefs";

/** The three a cave is drawn with, in this order in its texture arrays. */
const SLOTS = ["floor", "wall", "ceiling"] as const;

const VERTEX = `#version 300 es
precision highp float;
in vec3 position;
in vec3 normal;
in vec4 light;
uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
out vec3 vWorldPosition;
out vec3 vNormal;
out vec3 vLight;
out vec3 vPositionFromCamera;
void main() {
  vec4 p = world * vec4(position, 1.0);
  vWorldPosition = p.xyz;
  vNormal = normalize(mat3(world) * normal);
  vLight = light.rgb;
  vec4 v = view * p;
  vPositionFromCamera = v.xyz;
  gl_Position = projection * v;
}
`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2DArray;
${LIT_SHADING_GLSL}
uniform sampler2DArray colorArray;
uniform sampler2DArray normalArray;
// Per slot (floor, wall, ceiling): 1 / its size in metres, and its tint.
uniform vec3 tileScale;
uniform vec3 tint0;
uniform vec3 tint1;
uniform vec3 tint2;
in vec3 vWorldPosition;
in vec3 vNormal;
in vec3 vLight;
in vec3 vPositionFromCamera;
out vec4 fragColor;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

/** One slot's colour (alpha: roughness), surface normal and height, from three sides. */
void triplanar(float layer, float scale, vec3 p, vec3 n, vec3 w, out vec4 color, out vec3 bumped, out float height) {
  // Each axis shifted so the three repeats never line up.
  vec2 ux = p.zy * scale + vec2(0.37, 0.11);
  vec2 uy = p.xz * scale + vec2(0.71, 0.53);
  vec2 uz = p.xy * scale + vec2(0.19, 0.83);
  vec4 cx = texture(colorArray, vec3(ux, layer));
  vec4 cy = texture(colorArray, vec3(uy, layer));
  vec4 cz = texture(colorArray, vec3(uz, layer));
  color = cx * w.x + cy * w.y + cz * w.z;
  vec4 nx = texture(normalArray, vec3(ux, layer));
  vec4 ny = texture(normalArray, vec3(uy, layer));
  vec4 nz = texture(normalArray, vec3(uz, layer));
  height = nx.a * w.x + ny.a * w.y + nz.a * w.z;
  // Whiteout blend: each projection's tangent normal swizzled onto its axis, added to the surface's.
  vec3 tx = nx.rgb * 2.0 - 1.0, ty = ny.rgb * 2.0 - 1.0, tz = nz.rgb * 2.0 - 1.0;
  vec3 s = sign(n);
  tx = vec3(tx.xy * vec2(s.x, 1.0) + n.zy, abs(tx.z) * n.x);
  ty = vec3(ty.xy * vec2(s.y, 1.0) + n.xz, abs(ty.z) * n.y);
  tz = vec3(tz.xy * vec2(-s.z, 1.0) + n.xy, abs(tz.z) * n.z);
  bumped = normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 p = vWorldPosition;
  // The projections' weights: sharp, so they do not smear into each other.
  vec3 w = pow(abs(n), vec3(4.0));
  w /= (w.x + w.y + w.z);
  // Floor, wall, ceiling by which way it faces, the bands between them wide and ragged.
  float ragged = (noise(p * 0.35) - 0.5) * 0.5 + (noise(p * 1.3) - 0.5) * 0.2;
  float up = n.y + ragged;
  float floorW = smoothstep(0.35, 0.8, up);
  float ceilW = smoothstep(0.25, 0.75, -up);
  float wallW = max(0.0, 1.0 - floorW - ceilW);
  vec4 c0 = vec4(0.0), c1 = vec4(0.0), c2 = vec4(0.0);
  vec3 b0 = n, b1 = n, b2 = n;
  float h0 = 0.0, h1 = 0.0, h2 = 0.0;
  if (floorW > 0.001) triplanar(0.0, tileScale.x, p, n, w, c0, b0, h0);
  if (wallW > 0.001) triplanar(1.0, tileScale.y, p, n, w, c1, b1, h1);
  if (ceilW > 0.001) triplanar(2.0, tileScale.z, p, n, w, c2, b2, h2);
  // Heights decide where two meet: the one standing proud wins first.
  float s0 = floorW + h0 * 0.5 * min(1.0, floorW * 6.0);
  float s1 = wallW + h1 * 0.5 * min(1.0, wallW * 6.0);
  float s2 = ceilW + h2 * 0.5 * min(1.0, ceilW * 6.0);
  float lowest = max(max(s0, s1), s2) - 0.25;
  float k0 = max(s0 - lowest, 0.0) * step(0.001, floorW);
  float k1 = max(s1 - lowest, 0.0) * step(0.001, wallW);
  float k2 = max(s2 - lowest, 0.0) * step(0.001, ceilW);
  float total = max(k0 + k1 + k2, 1e-4);
  vec3 albedo = (c0.rgb * tint0 * k0 + c1.rgb * tint1 * k1 + c2.rgb * tint2 * k2) / total;
  vec3 bumped = normalize(b0 * k0 + b1 * k1 + b2 * k2);

  // The light: the ambient's everywhere, the baked light at the vertex, and the sun's (none
  // underground, but drawn the same above if ever a cave opens to the sky).
  float shade = 0.75 + 0.25 * max(dot(bumped, n), 0.0);
  vec3 baked = vLight * (0.55 + 0.45 * max(dot(bumped, normalize(n + vec3(0.0, 0.35, 0.0))), 0.0));
  float sun = max(dot(bumped, normalize(lightDirection)), 0.0) * lightIntensity;
  vec3 lit = albedo * (ambientColor * ambientIntensity * shade + baked + lightColor * sun * computeShadow(p, n, vPositionFromCamera.z));
  fragColor = vec4(applyFog(lit, length(vPositionFromCamera)), 1.0);
}
`;

export interface CaveMaterial {
  material: ShaderMaterial;
  dispose: () => void;
}

/**
 * The material a style's caves are drawn with: its floor, wall and ceiling materials' textures baked
 * (the ground's texture graphs and cache), the shader over them. Null if a material it names is in
 * no pack (said once).
 */
export async function createCaveMaterial(scene: Scene, seed: number, look: CaveLook, materials: readonly MaterialDef[], lit: LitShading): Promise<CaveMaterial | null> {
  const defs = SLOTS.map((slot) => materials.find((m) => m.id === look[slot].material));
  if (defs.some((d) => !d)) {
    console.warn(`A cave names a material no pack has (${SLOTS.map((s) => look[s].material).join(", ")}): drawn plain.`);
    return null;
  }
  const textures = await bakeTerrainTextures(seed, defs as MaterialDef[]);
  const color = RawTexture2DArray.CreateRGBATexture(textures.colorBuffer, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, SLOTS.length, scene, true, false);
  const normal = RawTexture2DArray.CreateRGBATexture(textures.normalBuffer, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION, SLOTS.length, scene, true, false);
  for (const t of [color, normal]) {
    t.wrapU = Texture.WRAP_ADDRESSMODE;
    t.wrapV = Texture.WRAP_ADDRESSMODE;
  }
  Effect.ShadersStore["caveRockVertexShader"] = VERTEX;
  Effect.ShadersStore["caveRockFragmentShader"] = FRAGMENT;
  const material = new ShaderMaterial("caveRock", scene, "caveRock", {
    attributes: ["position", "normal", "light"],
    uniforms: ["world", "view", "projection", "tileScale", "tint0", "tint1", "tint2", ...LIT_SHADING_UNIFORMS],
    samplers: ["colorArray", "normalArray", ...LIT_SHADING_SAMPLERS],
  });
  material.setTexture("colorArray", color);
  material.setTexture("normalArray", normal);
  material.setVector3("tileScale", new Vector3(1 / look.floor.size, 1 / look.wall.size, 1 / look.ceiling.size));
  SLOTS.forEach((slot, i) => material.setColor3(`tint${i}`, new Color3(...look[slot].tint)));
  // Wound counter-clockwise from the open side in the right-handed sense: clockwise to Babylon.
  material.sideOrientation = Material.ClockWiseSideOrientation;
  material.backFaceCulling = true;
  lit.register(material);
  return {
    material,
    dispose() {
      material.dispose();
      color.dispose();
      normal.dispose();
    },
  };
}
