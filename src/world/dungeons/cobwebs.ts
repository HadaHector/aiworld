// Cobwebs in a dungeon (DUNGEONS.md, *What fills it*): sheets of web strung across the corners
// where two walls meet under the vault, and across the upper corner of an open niche - each a
// triangle of the style's web texture (a particle texture, the same the spider's web skill draws),
// drawn alpha-blended on a mesh of their own (the building shader has no cut-outs), lit by the
// part's fixtures as they reach it, not baked.

import { Constants, Mesh, RawTexture, ShaderMaterial, Texture, VertexData, type Scene } from "@babylonjs/core";
import type { WallFace } from "../architecture/trims";
import type { Niche } from "../architecture/dents";
import type { ModelLight } from "../buildings/buildingTypes";
import { falloff } from "../lighting/lightBake";
import { drawParticleTexture, type ParticleTextureDef } from "../../particles/textures";

type V = [number, number, number];

/** A web: three corners, the first two along its top edge, the third its foot. */
export type WebTriangle = [V, V, V];

const WEB_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 worldViewProjection;
varying vec2 vUv;
varying vec3 vLight;
void main() {
  vUv = uv;
  vLight = color.rgb;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const WEB_FRAGMENT = `
precision highp float;
uniform sampler2D web;
varying vec2 vUv;
varying vec3 vLight;
void main() {
  vec4 t = texture2D(web, vUv);
  if (t.a < 0.02) discard;
  // Dusty grey silk, half seen through; the texture's faint haze between threads dropped.
  float a = smoothstep(0.15, 0.6, t.a) * 0.6;
  if (a < 0.01) discard;
  gl_FragColor = vec4(t.rgb * vec3(0.78, 0.76, 0.72) * vLight, a);
}`;

/** How far a web hangs off the stone, so it never lies in a face. */
const OFF = 0.03;

/** A number in [0, 1) for a point, the same every time. */
function hash(x: number, y: number, z: number, salt: number): number {
  const h = Math.sin(x * 12.9898 + y * 4.1414 + z * 78.233 + salt * 37.719) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * A web in each inside corner where two walls meet square, hung from just under their heads (`drop`
 * under them: the cornice's height) - from a point along each wall to a foot down the corner, each
 * a little different. `open` says whether a point is open space.
 */
export function cornerWebs(walls: readonly WallFace[], open: (p: V) => boolean, drop: number): WebTriangle[] {
  /** Each face's upright edges: where, from and to what height. */
  const edges = walls.map((f) => {
    const out: { x: number; z: number; y0: number; y1: number }[] = [];
    for (let i = 0; i < f.corners.length; i++) {
      const a = f.corners[i], b = f.corners[(i + 1) % f.corners.length];
      if (Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3 && Math.abs(a[1] - b[1]) > 1) out.push({ x: a[0], z: a[2], y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
    }
    return out;
  });
  const centre = (f: WallFace): V => f.corners.reduce((m, c): V => [m[0] + c[0] / f.corners.length, m[1] + c[1] / f.corners.length, m[2] + c[2] / f.corners.length], [0, 0, 0]);
  const webs: WebTriangle[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < walls.length; i++) {
    for (let j = 0; j < walls.length; j++) {
      const f = walls[i], g = walls[j];
      if (i === j || Math.abs(f.n[0] * g.n[0] + f.n[2] * g.n[2]) > 0.05) continue;
      for (const e of edges[i]) {
        const k = edges[j].find((q) => Math.abs(q.x - e.x) < 0.02 && Math.abs(q.z - e.z) < 0.02);
        if (!k) continue;
        // Inside: each wall runs off the corner the way the other faces.
        const cf = centre(f), cg = centre(g);
        if ((cf[0] - e.x) * g.n[0] + (cf[2] - e.z) * g.n[2] <= 0 || (cg[0] - e.x) * f.n[0] + (cg[2] - e.z) * f.n[2] <= 0) continue;
        const top = Math.min(e.y1, k.y1) - drop - 0.05;
        const bottom = Math.max(e.y0, k.y0);
        if (top - bottom < 3) continue;
        const key = `${e.x.toFixed(2)},${e.z.toFixed(2)},${top.toFixed(1)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const mid: V = [e.x + (f.n[0] + g.n[0]) * 0.3, (top + bottom) / 2, e.z + (f.n[2] + g.n[2]) * 0.3];
        if (!open(mid)) continue;
        // Along wall f (the way g faces), along wall g (the way f faces), and down the corner.
        const sa = 1.2 + 1.3 * hash(e.x, top, e.z, 1), sb = 1.2 + 1.3 * hash(e.x, top, e.z, 2), sd = 1.3 + 1.5 * hash(e.x, top, e.z, 3);
        const at = (along: number, across: number, down: number, offF: number, offG: number): V => [
          e.x + g.n[0] * along + f.n[0] * across + f.n[0] * offF + g.n[0] * offG,
          top - down,
          e.z + g.n[2] * along + f.n[2] * across + f.n[2] * offF + g.n[2] * offG,
        ];
        webs.push([at(sa, 0, 0, OFF, 0), at(0, sb, 0, 0, OFF), at(0, 0, sd, OFF, OFF)]);
      }
    }
  }
  return webs;
}

/** A web across an upper corner of each open niche (not sealed, nothing lying in it), a little in
 *  from its mouth, on one side or the other. */
export function nicheWebs(niches: readonly Niche[]): WebTriangle[] {
  const webs: WebTriangle[] = [];
  for (const niche of niches) {
    if (niche.slab || niche.contents?.length) continue;
    const n = niche.n, t: V = [-n[2], 0, n[0]];
    const s = niche.points.map((p) => p[0] * n[0] + p[2] * n[2]);
    const u = niche.points.map((p) => p[0] * t[0] + p[2] * t[2]);
    const y = niche.points.map((p) => p[1]);
    const mouth = Math.max(...s) - 0.12;
    const u0 = Math.min(...u), u1 = Math.max(...u), y0 = Math.min(...y), y1 = Math.max(...y);
    const at = (uu: number, yy: number): V => [t[0] * uu + n[0] * mouth, yy, t[2] * uu + n[2] * mouth];
    const left = hash(u0, y1, mouth, 4) < 0.5;
    const side = left ? u0 + OFF : u1 - OFF, inward = left ? 1 : -1;
    const w = (u1 - u0) * (0.3 + 0.2 * hash(u0, y1, mouth, 5)), h = (y1 - y0) * (0.7 + 0.25 * hash(u0, y1, mouth, 6));
    const top = y1 - OFF;
    webs.push([at(side + inward * w, top), at(side, top), at(side, top - h)]);
  }
  return webs;
}

/**
 * The webs as one mesh, `points` their corners in threes (in the frame `lights` are in): the web
 * texture on each, its corners lit by the lights in reach (no shadow) over a little of `ambient`.
 * The caller disposes it; its material and texture go with it.
 */
export function createCobwebMesh(scene: Scene, name: string, points: readonly number[], lights: readonly ModelLight[], ambient: [number, number, number], texture: ParticleTextureDef): Mesh {
  const positions = Float32Array.from(points);
  const count = positions.length / 3;
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 4);
  const corners = [[0, 0], [1, 0], [0.5, 1]];
  for (let v = 0; v < count; v++) {
    uvs.set(corners[v % 3], v * 2);
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let r = 0.1 + ambient[0] * 4, g = 0.1 + ambient[1] * 4, b = 0.1 + ambient[2] * 4;
    for (const light of lights) {
      const d = Math.hypot(light.position[0] - x, light.position[1] - y, light.position[2] - z);
      if (d >= light.radius) continue;
      const k = falloff(light, d) * 1.1;
      r += light.color[0] * k;
      g += light.color[1] * k;
      b += light.color[2] * k;
    }
    colors.set([Math.min(1, r), Math.min(1, g), Math.min(1, b), 1], v * 4);
  }
  const indices = Array.from({ length: count }, (_, i) => i);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = uvs;
  data.colors = colors;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh);
  const pixels = drawParticleTexture(texture, 0);
  const rgba = new Uint8Array(pixels.size * pixels.size * 4);
  for (let i = 0; i < pixels.size * pixels.size; i++) {
    const l = Math.round(Math.min(1, pixels.luminance[i]) * 255);
    rgba.set([l, l, l, Math.round(Math.min(1, pixels.alpha[i]) * 255)], i * 4);
  }
  const map = RawTexture.CreateRGBATexture(rgba, pixels.size, pixels.size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  map.hasAlpha = true;
  map.wrapU = map.wrapV = Texture.CLAMP_ADDRESSMODE;
  // Its own small shader: the texture's white threads in the light at each corner, its alpha.
  const material = new ShaderMaterial(`${name}:material`, scene, { vertexSource: WEB_VERTEX, fragmentSource: WEB_FRAGMENT }, {
    attributes: ["position", "uv", "color"],
    uniforms: ["worldViewProjection"],
    samplers: ["web"],
    needAlphaBlending: true,
  });
  material.setTexture("web", map);
  material.backFaceCulling = false;
  material.alphaMode = Constants.ALPHA_COMBINE;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.onDisposeObservable.add(() => {
    material.dispose();
    map.dispose();
  });
  return mesh;
}
