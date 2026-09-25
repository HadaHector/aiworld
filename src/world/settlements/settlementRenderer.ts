import { Effect, Mesh, RawTexture, ShaderMaterial, Texture, VertexData, type CascadedShadowGenerator, type Scene } from "@babylonjs/core";
import { LIT_SHADING_GLSL, LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS, type LitShading } from "../materials/litShading";
import { mulberry32 } from "../rng";
import type { House, SettlementLayout } from "./settlementLayout";
import type { SettlementStyle } from "./settlementConfig";
import { WALL_TEXTURE_SIZE, WALL_TEXTURE_WORLD_SIZE, bakeWallTexture } from "./wallTexture";

/** How far below its floor a house's walls reach, so the edge of its plot never shows a gap. */
const FOUNDATION_DEPTH = 1.2;

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec2 uv;
in vec4 color;

uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;

out vec3 vNormal;
out vec2 vUV;
out vec3 vColor;
out vec3 vWorldPosition;
out vec3 vPositionFromCamera;

void main() {
  vec4 worldPosition = world * vec4(position, 1.0);
  gl_Position = projection * view * worldPosition;
  vNormal = normalize((world * vec4(normal, 0.0)).xyz);
  vUV = uv;
  vColor = color.rgb;
  vWorldPosition = worldPosition.xyz;
  vPositionFromCamera = (view * worldPosition).xyz;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
${LIT_SHADING_GLSL}

in vec3 vNormal;
in vec2 vUV;
in vec3 vColor;
in vec3 vWorldPosition;
in vec3 vPositionFromCamera;

uniform sampler2D woodTexture;

out vec4 outColor;

void main() {
  // Roofs are single sheets seen from both sides (the eaves from below), so the normal faces the
  // viewer.
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 albedo = texture(woodTexture, vUV).rgb * vColor;
  vec3 lightDir = normalize(lightDirection);
  // Firmer than the terrain's half-Lambert, so a building's sunny and shaded walls read as a solid.
  float diffuse = clamp(dot(n, lightDir) * 0.6 + 0.4, 0.0, 1.0) * lightIntensity;
  float shadow = computeShadow(vWorldPosition, n, vPositionFromCamera.z);
  vec3 lit = albedo * diffuse * lightColor * shadow + albedo * ambientColor * ambientIntensity;
  outColor = vec4(applyFog(lit, length(vPositionFromCamera)), 1.0);
}
`;

export interface SettlementRenderer {
  setDrawDistance: (distance: number) => void;
}

interface Builder {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

function pushQuad(
  b: Builder,
  corners: [number, number, number][],
  normal: [number, number, number],
  uvs: [number, number][],
  color: [number, number, number],
): void {
  const base = b.positions.length / 3;
  for (let i = 0; i < 4; i++) {
    b.positions.push(...corners[i]);
    b.normals.push(...normal);
    b.uvs.push(...uvs[i]);
    b.colors.push(color[0], color[1], color[2], 1);
  }
  b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function pushTriangle(
  b: Builder,
  corners: [number, number, number][],
  normal: [number, number, number],
  uvs: [number, number][],
  color: [number, number, number],
): void {
  const base = b.positions.length / 3;
  for (let i = 0; i < 3; i++) {
    b.positions.push(...corners[i]);
    b.normals.push(...normal);
    b.uvs.push(...uvs[i]);
    b.colors.push(color[0], color[1], color[2], 1);
  }
  b.indices.push(base, base + 1, base + 2);
}

/**
 * One house: four walls reaching a little below the floor, a gable roof along the width with an
 * overhang, and a door (plus windows on wider houses) on the street side. Positions are relative to
 * the settlement's origin (ox, oz), so each settlement's mesh keeps its numbers small.
 */
function addHouse(b: Builder, house: House, ox: number, oz: number, style: SettlementStyle): void {
  const { wallTints, roofTints, door, window } = style.look;
  const overhang = style.houses.roofOverhang;
  const rng = mulberry32(Math.floor(house.tint * 1e9));
  const fx = house.frontX;
  const fz = house.frontZ;
  const ux = -fz;
  const uz = fx;
  const hw = house.width / 2;
  const hd = house.depth / 2;
  const cx = house.x - ox;
  const cz = house.z - oz;
  // Local (a along the width, b toward the front, y up) to settlement-relative world.
  const at = (a: number, bb: number, y: number): [number, number, number] => [cx + ux * a + fx * bb, y, cz + uz * a + fz * bb];

  const y0 = house.y - FOUNDATION_DEPTH;
  const y1 = house.y + house.wallHeight;
  const wallTint = wallTints[Math.floor(house.tint * wallTints.length) % wallTints.length];
  const roofTint = roofTints[Math.floor(rng() * roofTints.length)];
  const v = (y: number): number => (y - y0) / WALL_TEXTURE_WORLD_SIZE;
  const u = (d: number): number => d / WALL_TEXTURE_WORLD_SIZE;

  // Walls: front (+b), back (-b), and the two ends (+a, -a), each wound to face outward.
  const walls: { from: [number, number]; to: [number, number]; normal: [number, number] }[] = [
    { from: [-hw, hd], to: [hw, hd], normal: [0, 1] },
    { from: [hw, -hd], to: [-hw, -hd], normal: [0, -1] },
    { from: [hw, hd], to: [hw, -hd], normal: [1, 0] },
    { from: [-hw, -hd], to: [-hw, hd], normal: [-1, 0] },
  ];
  for (const wall of walls) {
    const length = Math.hypot(wall.to[0] - wall.from[0], wall.to[1] - wall.from[1]);
    const n: [number, number, number] = [ux * wall.normal[0] + fx * wall.normal[1], 0, uz * wall.normal[0] + fz * wall.normal[1]];
    pushQuad(
      b,
      [at(wall.from[0], wall.from[1], y0), at(wall.to[0], wall.to[1], y0), at(wall.to[0], wall.to[1], y1), at(wall.from[0], wall.from[1], y1)],
      n,
      [[0, v(y0)], [u(length), v(y0)], [u(length), v(y1)], [0, v(y1)]],
      wallTint,
    );
  }

  // Gable roof: ridge along the width, over the middle of the depth.
  const rise = Math.tan(house.roofPitch);
  const ridge = y1 + hd * rise;
  const eaveB = hd + overhang;
  const eaveY = y1 - overhang * rise;
  const endA = hw + overhang;
  const slopeLength = Math.hypot(eaveB, ridge - eaveY);
  const cos = Math.cos(house.roofPitch);
  const sin = Math.sin(house.roofPitch);
  for (const side of [1, -1]) {
    const n: [number, number, number] = [fx * side * sin, cos, fz * side * sin];
    const corners: [number, number, number][] =
      side > 0
        ? [at(-endA, eaveB, eaveY), at(endA, eaveB, eaveY), at(endA, 0, ridge), at(-endA, 0, ridge)]
        : [at(endA, -eaveB, eaveY), at(-endA, -eaveB, eaveY), at(-endA, 0, ridge), at(endA, 0, ridge)];
    pushQuad(b, corners, n, [[0, 0], [u(endA * 2), 0], [u(endA * 2), u(slopeLength)], [0, u(slopeLength)]], roofTint);
  }
  // Gable ends: the wall triangle up to the ridge.
  for (const side of [1, -1]) {
    const n: [number, number, number] = [ux * side, 0, uz * side];
    const corners: [number, number, number][] =
      side > 0 ? [at(hw, hd, y1), at(hw, -hd, y1), at(hw, 0, ridge)] : [at(-hw, -hd, y1), at(-hw, hd, y1), at(-hw, 0, ridge)];
    pushTriangle(b, corners, n, [[0, v(y1)], [u(house.depth), v(y1)], [u(hd), v(ridge)]], wallTint);
  }

  // Door on the front wall, just proud of it; windows either side on wider houses.
  const front: [number, number, number] = [fx, 0, fz];
  const proud = hd + 0.03;
  const doorAt = (rng() - 0.5) * Math.max(0, house.width - 3);
  const doorTop = house.y + Math.min(2.1, house.wallHeight - 0.4);
  pushQuad(
    b,
    [at(doorAt - 0.5, proud, house.y), at(doorAt + 0.5, proud, house.y), at(doorAt + 0.5, proud, doorTop), at(doorAt - 0.5, proud, doorTop)],
    front,
    [[0, 0], [0.5, 0], [0.5, 1], [0, 1]],
    door,
  );
  if (house.width > 6) {
    const sill = house.y + 1.1;
    const head = Math.min(sill + 0.8, y1 - 0.3);
    for (const offset of [-1, 1]) {
      const centre = doorAt + offset * 2;
      if (Math.abs(centre) > hw - 0.8) continue;
      pushQuad(
        b,
        [at(centre - 0.4, proud, sill), at(centre + 0.4, proud, sill), at(centre + 0.4, proud, head), at(centre - 0.4, proud, head)],
        front,
        [[0, 0], [0.4, 0], [0.4, 0.4], [0, 0.4]],
        window,
      );
    }
  }
}

/**
 * Draws every settlement's buildings: one mesh per settlement with all its houses merged, shown
 * while the settlement is within the draw distance. Houses cast shadows (they are few and large -
 * nothing like grass) and are lit through the shared lighting, like the ground they stand on.
 */
export function createSettlementRenderer(
  scene: Scene,
  layouts: SettlementLayout[],
  styles: SettlementStyle[],
  seed: number,
  litShading: LitShading,
  shadowGenerator: CascadedShadowGenerator,
  initialDrawDistance: number,
): SettlementRenderer {
  Effect.ShadersStore["buildingVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["buildingFragmentShader"] = FRAGMENT_SHADER;

  // One material per style, each with its own wall texture; made only for styles that built
  // something, since a style whose biome never came up would bake a texture for nothing.
  const styleById = new Map(styles.map((style) => [style.id, style]));
  const materials = new Map<string, ShaderMaterial>();
  function materialFor(style: SettlementStyle): ShaderMaterial {
    let material = materials.get(style.id);
    if (material) return material;
    const texture = RawTexture.CreateRGBATexture(bakeWallTexture(seed, style.look.wallTexture), WALL_TEXTURE_SIZE, WALL_TEXTURE_SIZE, scene, true, false);
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    material = new ShaderMaterial(`building_${style.id}`, scene, "building", {
      attributes: ["position", "normal", "uv", "color"],
      uniforms: ["world", "view", "projection", ...LIT_SHADING_UNIFORMS],
      samplers: ["woodTexture", ...LIT_SHADING_SAMPLERS],
    });
    material.setTexture("woodTexture", texture);
    material.backFaceCulling = false;
    litShading.register(material);
    materials.set(style.id, material);
    return material;
  }

  const meshes: { mesh: Mesh; x: number; z: number; radius: number }[] = [];
  for (const layout of layouts) {
    if (layout.houses.length === 0) continue;
    const style = styleById.get(layout.styleId)!;
    const builder: Builder = { positions: [], normals: [], uvs: [], colors: [], indices: [] };
    for (const house of layout.houses) addHouse(builder, house, layout.x, layout.z, style);
    const mesh = new Mesh(`settlement_${layout.siteId}`, scene);
    const data = new VertexData();
    data.positions = builder.positions;
    data.normals = builder.normals;
    data.uvs = builder.uvs;
    data.colors = builder.colors;
    data.indices = builder.indices;
    data.applyToMesh(mesh);
    mesh.position.set(layout.x, 0, layout.z);
    mesh.material = materialFor(style);
    mesh.isPickable = false;
    shadowGenerator.addShadowCaster(mesh, false);
    meshes.push({ mesh, x: layout.x, z: layout.z, radius: layout.radius });
  }

  let drawDistance = initialDrawDistance;
  scene.onBeforeRenderObservable.add(() => {
    const camera = scene.activeCamera;
    if (!camera) return;
    const { x, z } = camera.position;
    for (const entry of meshes) {
      const reach = drawDistance + entry.radius;
      entry.mesh.setEnabled((entry.x - x) ** 2 + (entry.z - z) ** 2 <= reach * reach);
    }
  });

  return {
    setDrawDistance(distance) {
      drawDistance = distance;
    },
  };
}
