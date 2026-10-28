// Drawing particles (see FEEDBACK.md, *Particles*): every sprite of one blend mode is one mesh of
// camera-facing quads, and every mesh particle of one blend mode one mesh of small flat-shaded
// shapes, rebuilt from the particle pools each frame into buffers allocated once. So the whole
// system costs four draw calls however many effects play.

import { Constants, Effect, Mesh, RawTexture, ShaderMaterial, SubMesh, Texture, Vector3, VertexBuffer, type Scene } from "@babylonjs/core";
import type { FeedbackRules } from "../feedback/rules";
import { MESH_SHAPES } from "../feedback/rules";
import type { ParticlePool, ParticleSystem } from "./system";
import { buildParticleAtlas, type ParticleAtlas } from "./textures";

export interface ParticleRenderer {
  /** Rebuilds the meshes from the pools: once a frame, after the system's update. */
  update: () => void;
  /** Draw calls and vertices used this frame, for the meters. */
  stats: () => { sprites: number; meshes: number };
  readonly atlas: ParticleAtlas;
  dispose: () => void;
}

const SPRITE_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 viewProjection;
varying vec2 vUV;
varying vec4 vColor;
void main(void) {
  vUV = uv;
  vColor = color;
  gl_Position = viewProjection * vec4(position, 1.0);
}`;
const SPRITE_FRAGMENT = `
precision highp float;
uniform sampler2D atlas;
uniform float light;
varying vec2 vUV;
varying vec4 vColor;
void main(void) {
  vec4 t = texture2D(atlas, vUV);
  float a = vColor.a * t.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * t.r * light, a);
}`;
const SHAPE_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec4 color;
uniform mat4 viewProjection;
varying vec3 vNormal;
varying vec4 vColor;
void main(void) {
  vNormal = normal;
  vColor = color;
  gl_Position = viewProjection * vec4(position, 1.0);
}`;
// Shapes that glow (additive) are unlit; the rest take a simple sun from above.
const SHAPE_FRAGMENT = `
precision highp float;
uniform float lit;
uniform float light;
varying vec3 vNormal;
varying vec4 vColor;
void main(void) {
  float shade = mix(1.0, 0.55 + 0.45 * abs(dot(normalize(vNormal), normalize(vec3(0.35, 0.85, 0.4)))), lit);
  if (vColor.a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * shade * light, vColor.a);
}`;

/** The low-poly shapes, as triangles of unit size centred on 0: [x, y, z] corners, three a triangle. */
function shapeTriangles(shape: (typeof MESH_SHAPES)[number]): number[][] {
  switch (shape) {
    case "shard": {
      // A long splinter: a thin tetrahedron along y.
      const v = [[0, 0.5, 0], [0.18, -0.5, 0.1], [-0.18, -0.5, 0.1], [0, -0.5, -0.2]];
      return [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]].flatMap((t) => t.map((i) => v[i]));
    }
    case "chip":
      return [[0, 0.5, 0], [0.45, -0.3, 0], [-0.45, -0.3, 0]];
    case "ember": {
      // An octahedron.
      const v = [[0.5, 0, 0], [-0.5, 0, 0], [0, 0.5, 0], [0, -0.5, 0], [0, 0, 0.5], [0, 0, -0.5]];
      const faces = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
      return faces.flatMap((t) => t.map((i) => v[i]));
    }
    case "cube": {
      const c = (x: number, y: number, z: number): number[] => [x * 0.5, y * 0.5, z * 0.5];
      const quads = [
        [c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1)],
        [c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1), c(-1, -1, -1)],
        [c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)],
        [c(-1, -1, 1), c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1)],
        [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)],
        [c(1, -1, -1), c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1)],
      ];
      return quads.flatMap(([a, b, cc, d]) => [a, b, cc, a, cc, d]);
    }
    case "leaf":
      return [[0, 0.5, 0], [0.25, 0, 0], [0, -0.5, 0], [0, 0.5, 0], [0, -0.5, 0], [-0.25, 0, 0]];
    case "ring": {
      const out: number[][] = [];
      const n = 8;
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2;
        const a1 = ((k + 1) / n) * Math.PI * 2;
        const p = (r: number, a: number): number[] => [Math.cos(a) * r, 0, Math.sin(a) * r];
        out.push(p(0.5, a0), p(0.5, a1), p(0.36, a1), p(0.5, a0), p(0.36, a1), p(0.36, a0));
      }
      return out;
    }
  }
}

interface Shape {
  positions: Float32Array;
  normals: Float32Array;
  count: number;
}

function buildShape(kind: (typeof MESH_SHAPES)[number]): Shape {
  const corners = shapeTriangles(kind);
  const positions = new Float32Array(corners.flat());
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < corners.length; t += 3) {
    const [a, b, c] = [corners[t], corners[t + 1], corners[t + 2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (let k = 0; k < 3; k++) normals.set([nx, ny, nz], (t + k) * 3);
  }
  return { positions, normals, count: corners.length };
}

/** A mesh whose buffers hold `vertices` at most and are rewritten each frame. */
function dynamicMesh(scene: Scene, name: string, vertices: number, quads: boolean, withNormals: boolean): Mesh {
  const mesh = new Mesh(name, scene);
  mesh.setVerticesData(VertexBuffer.PositionKind, new Float32Array(vertices * 3), true);
  mesh.setVerticesData(VertexBuffer.ColorKind, new Float32Array(vertices * 4), true, 4);
  if (quads) mesh.setVerticesData(VertexBuffer.UVKind, new Float32Array(vertices * 2), true);
  if (withNormals) mesh.setVerticesData(VertexBuffer.NormalKind, new Float32Array(vertices * 3), true);
  const indices = new Uint32Array(quads ? (vertices / 4) * 6 : vertices);
  if (quads) {
    for (let q = 0; q < vertices / 4; q++) indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  } else for (let i = 0; i < vertices; i++) indices[i] = i;
  mesh.setIndices(indices, vertices, true);
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.doNotSyncBoundingInfo = true;
  return mesh;
}

/** Draws only the first `indices` indices this frame. */
function drawOnly(mesh: Mesh, vertices: number, indices: number): void {
  mesh.subMeshes = [];
  if (indices > 0) new SubMesh(0, 0, Math.max(1, vertices), 0, indices, mesh);
  mesh.isVisible = indices > 0;
}

export function createParticleRenderer(scene: Scene, system: ParticleSystem, rules: FeedbackRules, light: () => number = () => 1): ParticleRenderer {
  if (!Effect.ShadersStore.particleSpriteVertexShader) {
    Effect.ShadersStore.particleSpriteVertexShader = SPRITE_VERTEX;
    Effect.ShadersStore.particleSpriteFragmentShader = SPRITE_FRAGMENT;
    Effect.ShadersStore.particleShapeVertexShader = SHAPE_VERTEX;
    Effect.ShadersStore.particleShapeFragmentShader = SHAPE_FRAGMENT;
  }
  const atlas = buildParticleAtlas(rules.textures);
  const texture = new RawTexture(atlas.pixels, atlas.size, atlas.size, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  texture.name = "particleAtlas";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;

  const material = (name: string, shader: string, additive: boolean, shape: boolean): ShaderMaterial => {
    const m = new ShaderMaterial(name, scene, shader, {
      attributes: shape ? ["position", "normal", "color"] : ["position", "uv", "color"],
      uniforms: ["viewProjection", "light", "lit"],
      samplers: shape ? [] : ["atlas"],
      needAlphaBlending: true,
    });
    if (!shape) m.setTexture("atlas", texture);
    m.setFloat("lit", additive ? 0 : 1);
    m.alphaMode = additive ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE;
    m.disableDepthWrite = true;
    m.backFaceCulling = false;
    return m;
  };

  const spriteCap = system.sprites.capacity;
  const shapes = new Map(MESH_SHAPES.map((k) => [k, buildShape(k)]));
  const shapeMax = Math.max(...[...shapes.values()].map((s) => s.count));
  const meshCap = system.meshes.capacity;
  const layers = (["add", "alpha"] as const).map((blend) => {
    const sprite = dynamicMesh(scene, `particles_${blend}`, Math.max(4, spriteCap * 4), true, false);
    sprite.material = material(`particles_${blend}`, "particleSprite", blend === "add", false);
    const shape = dynamicMesh(scene, `particleShapes_${blend}`, Math.max(3, meshCap * shapeMax), false, true);
    shape.material = material(`particleShapes_${blend}`, "particleShape", blend === "add", true);
    // Glows over smoke, so the smoke does not hide them.
    sprite.renderingGroupId = shape.renderingGroupId = 0;
    sprite.alphaIndex = shape.alphaIndex = blend === "add" ? 1001 : 1000;
    return {
      blend,
      sprite,
      shape,
      positions: new Float32Array(spriteCap * 12),
      uvs: new Float32Array(spriteCap * 8),
      colors: new Float32Array(spriteCap * 16),
      shapePositions: new Float32Array(meshCap * shapeMax * 3),
      shapeNormals: new Float32Array(meshCap * shapeMax * 3),
      shapeColors: new Float32Array(meshCap * shapeMax * 4),
    };
  });

  const order = new Uint32Array(spriteCap);
  const depth = new Float32Array(spriteCap);
  const right = new Vector3();
  const up = new Vector3();
  const forward = new Vector3();
  let counts = { sprites: 0, meshes: 0 };

  const writeSprites = (pool: ParticlePool, layer: (typeof layers)[number], eye: Vector3): number => {
    const blend = layer.blend;
    // Which particles go in this layer, farthest first for the blended ones.
    let n = 0;
    for (let i = 0; i < pool.count; i++) {
      const e = system.emitters[pool.emitter[i]];
      if (e.blend !== blend) continue;
      order[n] = i;
      depth[i] = (pool.x[i] - eye.x) ** 2 + (pool.y[i] - eye.y) ** 2 + (pool.z[i] - eye.z) ** 2;
      n++;
    }
    if (blend === "alpha" && n > 1 && n < 4000) order.subarray(0, n).sort((a, b) => depth[b] - depth[a]);
    const { positions, uvs, colors } = layer;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const e = system.emitters[pool.emitter[i]];
      const half = pool.size[i] / 2;
      // Across and along: the camera's right and up, turned by the particle's rotation - or, for a
      // streak, along its velocity as the camera sees it, stretched by how fast it goes.
      let ax: number, ay: number, az: number, bx: number, by: number, bz: number;
      let along = half;
      if (e.stretch > 0) {
        const vx = pool.vx[i], vy = pool.vy[i], vz = pool.vz[i];
        const vf = vx * forward.x + vy * forward.y + vz * forward.z;
        let px = vx - forward.x * vf, py = vy - forward.y * vf, pz = vz - forward.z * vf;
        const speed = Math.hypot(px, py, pz);
        if (speed > 1e-4) {
          px /= speed;
          py /= speed;
          pz /= speed;
        } else [px, py, pz] = [up.x, up.y, up.z];
        bx = px;
        by = py;
        bz = pz;
        // across = forward x along
        ax = forward.y * pz - forward.z * py;
        ay = forward.z * px - forward.x * pz;
        az = forward.x * py - forward.y * px;
        along = half + (speed * e.stretch) / 2;
      } else {
        const c = Math.cos(pool.rot[i]);
        const s = Math.sin(pool.rot[i]);
        ax = right.x * c + up.x * s;
        ay = right.y * c + up.y * s;
        az = right.z * c + up.z * s;
        bx = up.x * c - right.x * s;
        by = up.y * c - right.y * s;
        bz = up.z * c - right.z * s;
      }
      const x = pool.x[i], y = pool.y[i], z = pool.z[i];
      const o = k * 12;
      // Corners: bottom left, top left, top right, bottom right.
      positions[o] = x - ax * half - bx * along;
      positions[o + 1] = y - ay * half - by * along;
      positions[o + 2] = z - az * half - bz * along;
      positions[o + 3] = x - ax * half + bx * along;
      positions[o + 4] = y - ay * half + by * along;
      positions[o + 5] = z - az * half + bz * along;
      positions[o + 6] = x + ax * half + bx * along;
      positions[o + 7] = y + ay * half + by * along;
      positions[o + 8] = z + az * half + bz * along;
      positions[o + 9] = x + ax * half - bx * along;
      positions[o + 10] = y + ay * half - by * along;
      positions[o + 11] = z + az * half - bz * along;
      const rect = atlas.rects[e.sprite]?.[pool.variant[i]] ?? atlas.rects[e.sprite]?.[0];
      const u = k * 8;
      if (rect) {
        // The atlas's first row is its top: v0 is the top of the cell.
        uvs[u] = rect.u0;
        uvs[u + 1] = rect.v1;
        uvs[u + 2] = rect.u0;
        uvs[u + 3] = rect.v0;
        uvs[u + 4] = rect.u1;
        uvs[u + 5] = rect.v0;
        uvs[u + 6] = rect.u1;
        uvs[u + 7] = rect.v1;
      }
      const c = k * 16;
      for (let v = 0; v < 4; v++) {
        colors[c + v * 4] = pool.r[i];
        colors[c + v * 4 + 1] = pool.g[i];
        colors[c + v * 4 + 2] = pool.b[i];
        colors[c + v * 4 + 3] = pool.a[i];
      }
    }
    if (n > 0) {
      layer.sprite.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
      layer.sprite.updateVerticesData(VertexBuffer.UVKind, uvs, false, false);
      layer.sprite.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
    }
    drawOnly(layer.sprite, n * 4, n * 6);
    return n;
  };

  const writeShapes = (pool: ParticlePool, layer: (typeof layers)[number]): number => {
    let v = 0;
    let drawn = 0;
    const { shapePositions: P, shapeNormals: N, shapeColors: C } = layer;
    for (let i = 0; i < pool.count; i++) {
      const e = system.emitters[pool.emitter[i]];
      if (e.blend !== layer.blend || !e.mesh) continue;
      const shape = shapes.get(e.mesh)!;
      const size = pool.size[i];
      // Turned about its own axis by its rotation (Rodrigues), or pointed along its velocity and
      // stretched when the emitter says.
      const kx = pool.ax[i], ky = pool.ay[i], kz = pool.az[i];
      const c = Math.cos(pool.rot[i]);
      const s = Math.sin(pool.rot[i]);
      let stretch = 1;
      let sx = 0, sy = 1, sz = 0;
      if (e.stretch > 0) {
        const speed = Math.hypot(pool.vx[i], pool.vy[i], pool.vz[i]);
        if (speed > 1e-4) {
          sx = pool.vx[i] / speed;
          sy = pool.vy[i] / speed;
          sz = pool.vz[i] / speed;
          stretch = 1 + (speed * e.stretch) / Math.max(0.01, size);
        }
      }
      for (let k = 0; k < shape.count; k++) {
        let x = shape.positions[k * 3] * size, y = shape.positions[k * 3 + 1] * size, z = shape.positions[k * 3 + 2] * size;
        let nx = shape.normals[k * 3], ny = shape.normals[k * 3 + 1], nz = shape.normals[k * 3 + 2];
        if (e.stretch > 0) {
          // Its y along the velocity, lengthened.
          const along = y * stretch;
          [x, y, z] = [x + sx * along, sy * along, z + sz * along];
        } else {
          const dot = kx * x + ky * y + kz * z;
          const rx = x * c + (ky * z - kz * y) * s + kx * dot * (1 - c);
          const ry = y * c + (kz * x - kx * z) * s + ky * dot * (1 - c);
          const rz = z * c + (kx * y - ky * x) * s + kz * dot * (1 - c);
          [x, y, z] = [rx, ry, rz];
          const nd = kx * nx + ky * ny + kz * nz;
          const mx = nx * c + (ky * nz - kz * ny) * s + kx * nd * (1 - c);
          const my = ny * c + (kz * nx - kx * nz) * s + ky * nd * (1 - c);
          const mz = nz * c + (kx * ny - ky * nx) * s + kz * nd * (1 - c);
          [nx, ny, nz] = [mx, my, mz];
        }
        P[v * 3] = pool.x[i] + x;
        P[v * 3 + 1] = pool.y[i] + y;
        P[v * 3 + 2] = pool.z[i] + z;
        N[v * 3] = nx;
        N[v * 3 + 1] = ny;
        N[v * 3 + 2] = nz;
        C[v * 4] = pool.r[i];
        C[v * 4 + 1] = pool.g[i];
        C[v * 4 + 2] = pool.b[i];
        C[v * 4 + 3] = pool.a[i];
        v++;
      }
      drawn++;
    }
    if (v > 0) {
      layer.shape.updateVerticesData(VertexBuffer.PositionKind, P, false, false);
      layer.shape.updateVerticesData(VertexBuffer.NormalKind, N, false, false);
      layer.shape.updateVerticesData(VertexBuffer.ColorKind, C, false, false);
    }
    drawOnly(layer.shape, v, v);
    return drawn;
  };

  return {
    atlas,
    update() {
      const camera = scene.activeCamera;
      if (!camera) return;
      const view = camera.getViewMatrix();
      // The view matrix's rows are the camera's axes in the world.
      const m = view.m;
      right.set(m[0], m[4], m[8]);
      up.set(m[1], m[5], m[9]);
      forward.set(m[2], m[6], m[10]);
      const eye = camera.globalPosition;
      const l = light();
      let sprites = 0;
      let meshes = 0;
      for (const layer of layers) {
        (layer.sprite.material as ShaderMaterial).setFloat("light", layer.blend === "add" ? 1 : l);
        (layer.shape.material as ShaderMaterial).setFloat("light", layer.blend === "add" ? 1 : l);
        sprites += writeSprites(system.sprites, layer, eye);
        meshes += writeShapes(system.meshes, layer);
      }
      counts = { sprites, meshes };
    },
    stats: () => counts,
    dispose() {
      for (const layer of layers) {
        layer.sprite.material?.dispose();
        layer.shape.material?.dispose();
        layer.sprite.dispose();
        layer.shape.dispose();
      }
      texture.dispose();
    },
  };
}
