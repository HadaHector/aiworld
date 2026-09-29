import {
  BoundingInfo,
  Buffer,
  Effect,
  Mesh,
  RawTexture2DArray,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  VertexData,
  type Scene,
} from "@babylonjs/core";
import { LIT_SHADING_GLSL, LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS, type LitShading } from "../materials/litShading";
import { GRASS_KIND_STRIDE, type GrassKindDef } from "./grassConfig";
import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";
import { GRASS_INSTANCE_STRIDE, type ChunkGrass } from "./grassScatter";
import { GRASS_TEXTURE_SIZE, bakeGrassTextures } from "./grassTextures";

/** Wind blows this way (x, z), normalised. Weather will want to drive it. */
const WIND_DIRECTION = new Vector2(0.8, 0.6).normalize();

/** How far up a blade (as a fraction of its height) it fades from the ground's colour to its own. */
const GRASS_ROOT_BLEND = 0.3;

/** Vertices per tuft: three crossed quads. */
const TUFT_QUADS = 3;

function vertexShader(kindCount: number, petalColorCount: number): string {
  return `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec2 uv;
// Per tuft: chunk-local root (xyz) and kind * GRASS_KIND_STRIDE + scale (w)...
in vec4 grassA;
// ...then colour (rgb) and turn about the vertical (w)...
in vec4 grassB;
// ...and the ground's colour at the root, 8 bits a channel packed into one float (-1: unknown).
in float grassC;

uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
uniform vec3 cameraPosition;
uniform float time;
uniform vec2 windDirection;
// Per kind: width, height, sway.
uniform vec3 kindShape[${kindCount}];
// Per kind: fade start, fade end.
uniform vec2 kindFade[${kindCount}];
// Per kind: where its petal colours start in petalColors, and how many it has.
uniform vec2 kindPetals[${kindCount}];
uniform vec3 petalColors[${petalColorCount}];
// Per kind: its flowers' eye colour.
uniform vec3 kindEyes[${kindCount}];

out vec2 vUV;
out vec3 vFaceNormal;
out vec3 vColor;
flat out vec3 vPetalColor;
flat out vec3 vEyeColor;
flat out vec4 vGroundColor;
out vec3 vWorldPosition;
out vec3 vPositionFromCamera;
flat out float vKind;

void main() {
  float kind = floor(grassA.w / ${GRASS_KIND_STRIDE.toFixed(1)});
  float scale = grassA.w - kind * ${GRASS_KIND_STRIDE.toFixed(1)};
  vec3 shape = kindShape[int(kind)];
  float fadeStart = kindFade[int(kind)].x;
  float fadeEnd = kindFade[int(kind)].y;
  vec3 root = (world * vec4(grassA.xyz, 1.0)).xyz;

  // Shrinks into the ground towards the edge of the grass range rather than stopping on a line, and
  // thins out on the way there - the turn angle doubles as a per-tuft random number for that.
  float distanceToCamera = distance(root, cameraPosition);
  float fade = 1.0 - smoothstep(fadeStart, fadeEnd, distanceToCamera);
  float keepFraction = mix(1.0, 0.5, smoothstep(fadeStart * 0.5, fadeEnd, distanceToCamera));
  float keep = step(fract(grassB.w * 7.31), keepFraction);
  float size = scale * fade * keep;

  vec3 local = vec3(position.x * shape.x, position.y * shape.y, position.z * shape.x) * size;
  float c = cos(grassB.w);
  float s = sin(grassB.w);
  vec3 turned = vec3(c * local.x - s * local.z, local.y, s * local.x + c * local.z);
  vFaceNormal = vec3(c * normal.x - s * normal.z, 0.0, s * normal.x + c * normal.z);

  // Only the upper part moves, the root stays put; two out-of-step waves keep it from looking like
  // a metronome, phased by position so gusts roll across a meadow instead of hitting it all at once.
  float phase = dot(grassA.xz, vec2(0.21, 0.17)) + dot(world[3].xz, vec2(0.21, 0.17));
  float gust = sin(time * 1.3 + phase) * 0.6 + sin(time * 2.9 + phase * 1.7) * 0.25 + 0.3;
  float bend = position.y * position.y;
  vec3 wind = vec3(windDirection.x, 0.0, windDirection.y) * gust * shape.z * shape.y * size * bend;

  vec4 worldPosition = vec4(root + turned + wind, 1.0);
  gl_Position = projection * view * worldPosition;
  vWorldPosition = worldPosition.xyz;
  vPositionFromCamera = (view * worldPosition).xyz;
  vUV = uv;
  vColor = grassB.rgb;
  vGroundColor = grassC < 0.0
    ? vec4(0.0)
    : vec4(floor(grassC / 65536.0), mod(floor(grassC / 256.0), 256.0), mod(grassC, 256.0), 255.0) / 255.0;
  // The turn angle is uniform random per tuft, so it picks the petal colour too.
  vec2 petals = kindPetals[int(kind)];
  vPetalColor = petalColors[int(petals.x + floor(fract(grassB.w * 13.37) * petals.y))];
  vEyeColor = kindEyes[int(kind)];
  vKind = kind;
}
`;
}

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;
${LIT_SHADING_GLSL}

in vec2 vUV;
in vec3 vFaceNormal;
in vec3 vColor;
flat in vec3 vPetalColor;
flat in vec3 vEyeColor;
flat in vec4 vGroundColor;
in vec3 vWorldPosition;
in vec3 vPositionFromCamera;
flat in float vKind;

uniform sampler2DArray bladeAtlas;

out vec4 outColor;

void main() {
  vec4 blade = texture(bladeAtlas, vec3(vUV, vKind));
  // Mipmapping averages the thin blades' coverage away with distance; raising alpha with the mip
  // level keeps them from thinning into nothing before the fade does its job.
  vec2 texel = vUV * ${GRASS_TEXTURE_SIZE.toFixed(1)};
  float lod = max(0.0, 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))));
  if (blade.a * (1.0 + 0.35 * lod) < 0.45) discard;

  // Darker towards the root, where the blades shade one another. Petals (the texture's G mask)
  // take the tuft's petal colour instead of its stem colour, and flower eyes (B) the kind's eye colour.
  vec3 albedo = mix(mix(vColor * mix(0.8, 1.0, vUV.y), vPetalColor, blade.g), vEyeColor, blade.b) * blade.r;
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 lightDir = normalize(lightDirection);

  // Each blade quad faces two ways; the side being looked at is the one lit. Its normal is tilted
  // well up, so under a high sun both sides of a tuft stay near the ground's own brightness and a
  // meadow still reads as part of the hillside - the lower the sun, the more the side facing it
  // outshines the side facing away. That far side keeps a little light that comes through the
  // blades from behind, so looking into the sun gives a dim, glowing meadow rather than a flat one.
  // Turned toward the camera by where the camera is rather than by gl_FrontFacing, whose sense
  // depends on winding conventions this does not need to care about.
  vec3 face = normalize(vFaceNormal);
  if (dot(face, cameraPosition - vWorldPosition) < 0.0) face = -face;
  vec3 n = normalize(face + up * 0.6);
  float direct = clamp(dot(n, lightDir) * 0.6 + 0.55, 0.0, 1.0);
  float throughBlade = max(-dot(face, lightDir), 0.0) * 0.18;
  float diffuse = (direct + throughBlade) * lightIntensity;
  float shadow = computeShadow(vWorldPosition, up, vPositionFromCamera.z);
  vec3 lit = albedo * diffuse * lightColor * shadow + albedo * ambientColor * ambientIntensity;

  // The bottom of the blades fades into the ground they grow from, lit the way the terrain lights
  // it (half-Lambert, upward normal), so a tuft does not end in a hard line against bare earth or
  // sand. Skipped where the ground colour is not known (alpha 0).
  if (vGroundColor.a > 0.0) {
    vec3 groundLit = vGroundColor.rgb * ((dot(up, lightDir) * 0.5 + 0.5) * lightIntensity * lightColor * shadow + ambientColor * ambientIntensity);
    lit = mix(groundLit, lit, smoothstep(0.0, ${GRASS_ROOT_BLEND.toFixed(3)}, vUV.y));
  }

  outColor = vec4(applyFog(lit, length(vPositionFromCamera)), 1.0);
}
`;

export interface GrassField {
  /** Shows a chunk's grass (replacing any it had), or removes it for null. */
  setChunk: (key: string, grass: ChunkGrass | null, originX: number, originZ: number, chunkSize: number) => void;
  clearChunk: (key: string) => void;
  setVisible: (visible: boolean) => void;
}

/** One kind's grass on one chunk - drawn only while the chunk is within that kind's own reach. */
interface GrassPatch {
  mesh: Mesh;
  buffer: Buffer;
  originX: number;
  originZ: number;
  reach: number;
}

/** The three crossed quads every tuft is drawn from: unit width and height, root at the origin. */
function tuftVertexData(): VertexData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let q = 0; q < TUFT_QUADS; q++) {
    const angle = (q * Math.PI) / TUFT_QUADS;
    const dx = Math.cos(angle) * 0.5;
    const dz = Math.sin(angle) * 0.5;
    const base = positions.length / 3;
    positions.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz);
    // Horizontal, across the quad; the fragment shader flips it to whichever side is being seen.
    for (let v = 0; v < 4; v++) normals.push(-Math.sin(angle), 0, Math.cos(angle));
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  return data;
}

/**
 * Draws grass: one mesh per chunk, instanced once per tuft straight from the per-tuft data the
 * chunk build scattered (see grassScatter.ts), with no per-tuft matrices built on this thread.
 *
 * Each kind is its own mesh per chunk, drawn only while the chunk is within that kind's fadeEnd of
 * the camera, so short grass costs nothing out where only the tall kinds still show; within that
 * the vertex shader shrinks each tuft into the ground towards its kind's fadeEnd. Grass receives shadows but casts none - the cost
 * of adding every blade to the shadow map would dwarf the difference it makes.
 */
export function createGrassField(
  scene: Scene,
  seed: number,
  litShading: LitShading,
  grassKinds: GrassKindDef[],
): GrassField {
  const engine = scene.getEngine();

  const atlas = RawTexture2DArray.CreateRGBATexture(
    bakeGrassTextures(seed, grassKinds),
    GRASS_TEXTURE_SIZE,
    GRASS_TEXTURE_SIZE,
    grassKinds.length,
    scene,
    true,
    false,
  );
  atlas.wrapU = Texture.CLAMP_ADDRESSMODE;
  atlas.wrapV = Texture.CLAMP_ADDRESSMODE;

  // Every kind's petal colours in one array, each kind reading its own run of it. Padded to one
  // entry, since a GLSL array cannot be empty - a kind with no flowers never reads it anyway.
  const petalColors: ColorTuple[] = [];
  const kindPetals: number[] = [];
  for (const kind of grassKinds) {
    const colors = kind.blades.flowerHeads?.colors ?? [];
    kindPetals.push(petalColors.length, colors.length);
    petalColors.push(...colors);
  }
  if (petalColors.length === 0) petalColors.push([1, 1, 1]);

  Effect.ShadersStore["grassVertexShader"] = vertexShader(grassKinds.length, petalColors.length);
  Effect.ShadersStore["grassFragmentShader"] = FRAGMENT_SHADER;
  const material = new ShaderMaterial("grass", scene, "grass", {
    attributes: ["position", "normal", "uv", "grassA", "grassB", "grassC"],
    uniforms: ["world", "view", "projection", "time", "windDirection", "kindShape", "kindFade", "kindPetals", "petalColors", "kindEyes", ...LIT_SHADING_UNIFORMS],
    samplers: ["bladeAtlas", ...LIT_SHADING_SAMPLERS],
  });
  material.setTexture("bladeAtlas", atlas);
  material.setArray2(
    "kindFade",
    grassKinds.flatMap((kind) => [kind.fadeStart, kind.fadeEnd]),
  );
  material.setArray3(
    "kindShape",
    grassKinds.flatMap((kind) => [kind.width, kind.height, kind.sway]),
  );
  material.setArray2("kindPetals", kindPetals);
  material.setArray3("petalColors", petalColors.flat());
  // A kind with no eye colour never draws the eye mask, so what it reads here is never seen.
  material.setArray3("kindEyes", grassKinds.flatMap((kind) => kind.blades.flowerHeads?.eye ?? [1, 1, 1]));
  material.setVector2("windDirection", WIND_DIRECTION);
  material.backFaceCulling = false;
  litShading.register(material);

  const tuft = tuftVertexData();
  const indicesPerTuft = tuft.indices!.length;
  const chunks = new Map<string, GrassPatch[]>();
  let visible = true;
  const startTime = performance.now();

  scene.onBeforeRenderObservable.add(() => {
    material.setFloat("time", (performance.now() - startTime) / 1000);
    const camera = scene.activeCamera;
    if (!camera) return;
    const { x, z } = camera.position;
    for (const patches of chunks.values()) {
      for (const patch of patches) {
        const dx = patch.originX - x;
        const dz = patch.originZ - z;
        patch.mesh.setEnabled(visible && dx * dx + dz * dz <= patch.reach * patch.reach);
      }
    }
  });

  function clearChunk(key: string): void {
    const patches = chunks.get(key);
    if (!patches) return;
    for (const patch of patches) {
      patch.mesh.dispose();
      patch.buffer.dispose();
    }
    chunks.delete(key);
  }

  function setChunk(key: string, grass: ChunkGrass | null, originX: number, originZ: number, chunkSize: number): void {
    clearChunk(key);
    if (!grass || grass.count === 0) return;

    // The tuft geometry alone is a metre across at the origin; culling has to see the whole patch.
    const half = chunkSize / 2 + 1;
    const patches: GrassPatch[] = [];
    let first = 0;
    grassKinds.forEach((def, k) => {
      const count = grass.kindCounts[k];
      if (count === 0) return;
      const instances = grass.instances.subarray(first * GRASS_INSTANCE_STRIDE, (first + count) * GRASS_INSTANCE_STRIDE);
      first += count;

      const mesh = new Mesh(`grass_${def.id}_${key}`, scene);
      tuft.applyToMesh(mesh);
      const buffer = new Buffer(engine, instances, false, GRASS_INSTANCE_STRIDE, false, true);
      mesh.setVerticesBuffer(buffer.createVertexBuffer("grassA", 0, 4));
      mesh.setVerticesBuffer(buffer.createVertexBuffer("grassB", 4, 4));
      mesh.setVerticesBuffer(buffer.createVertexBuffer("grassC", 8, 1));
      mesh.forcedInstanceCount = count;
      mesh.material = material;
      mesh.position.set(originX, 0, originZ);
      mesh.isPickable = false;
      const tallest = def.height * 1.5;
      mesh.setBoundingInfo(new BoundingInfo(new Vector3(-half, grass.minY - 1, -half), new Vector3(half, grass.maxY + tallest, half)));
      // Babylon counts a forced-instance draw as zero instances; the stats panel should see the grass.
      const drawnIndices = indicesPerTuft * count;
      mesh.onBeforeRenderObservable.add(() => {
        (scene as unknown as { _activeIndices: { addCount: (n: number, flag: boolean) => void } })._activeIndices.addCount(drawnIndices, false);
      });

      patches.push({
        mesh,
        buffer,
        originX,
        originZ,
        // Any part of the chunk within this kind's range: its centre can be up to half a diagonal away.
        reach: def.fadeEnd + (chunkSize * Math.SQRT2) / 2,
      });
    });
    chunks.set(key, patches);
  }

  function setVisible(next: boolean): void {
    visible = next;
  }

  return { setChunk, clearChunk, setVisible };
}
