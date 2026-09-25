import { LIT_SHADING_GLSL } from "../materials/litShading";
import { FOLIAGE_TEXTURE_SIZE } from "./treeTextures";

/**
 * Shaders for branching trees (see treeGenerator.ts): the wood, bark-textured with a normal map,
 * and the leaf cards, cut out of the foliage atlas. Both are drawn as thin instances - one matrix
 * per tree - and lit, shadowed and fogged through the shared LIT_SHADING_GLSL, like the ground.
 */

const INSTANCED_WORLD = `
in vec4 world0;
in vec4 world1;
in vec4 world2;
in vec4 world3;
uniform mat4 world;
uniform mat4 view;
uniform mat4 viewProjection;
`;

export const BARK_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec2 uv;
in vec3 axis;
${INSTANCED_WORLD}

out vec3 vWorldPosition;
out vec3 vNormal;
out vec3 vAxis;
out vec2 vUV;
out float vViewDepth;
out float vHeight;

void main() {
  mat4 finalWorld = world * mat4(world0, world1, world2, world3);
  vec4 worldPosition = finalWorld * vec4(position, 1.0);
  // Trees are only ever scaled uniformly, so the upper 3x3 turns normals correctly.
  mat3 turn = mat3(finalWorld);
  vNormal = normalize(turn * normal);
  vAxis = normalize(turn * axis);
  vUV = uv;
  vHeight = position.y;
  vWorldPosition = worldPosition.xyz;
  vViewDepth = (view * worldPosition).z;
  gl_Position = viewProjection * worldPosition;
}
`;

export const BARK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
${LIT_SHADING_GLSL}

in vec3 vWorldPosition;
in vec3 vNormal;
in vec3 vAxis;
in vec2 vUV;
in float vViewDepth;
in float vHeight;

uniform sampler2D barkColor;
uniform sampler2D barkNormal;

out vec4 outColor;

void main() {
  vec3 albedo = texture(barkColor, vUV).rgb;
  // The normal map's x runs around the limb and y along it.
  vec3 tangentNormal = texture(barkNormal, vUV).xyz * 2.0 - 1.0;
  vec3 surface = normalize(vNormal);
  vec3 along = normalize(vAxis - surface * dot(vAxis, surface));
  vec3 around = cross(along, surface);
  vec3 n = normalize(around * tangentNormal.x + along * tangentNormal.y + surface * tangentNormal.z);

  // Darker low down, where roots and the ground close in - a cheap stand-in for occlusion.
  float occlusion = mix(0.55, 1.0, smoothstep(-0.5, 5.0, vHeight));
  vec3 lightDir = normalize(lightDirection);
  float diffuse = clamp(dot(n, lightDir) * 0.75 + 0.25, 0.0, 1.0) * lightIntensity;
  float shadow = computeShadow(vWorldPosition, surface, vViewDepth);
  vec3 lit = albedo * (diffuse * lightColor * shadow + ambientColor * ambientIntensity) * occlusion;
  outColor = vec4(applyFog(lit, length(vWorldPosition - cameraPosition)), 1.0);
}
`;

export const LEAF_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec2 uv;
in vec4 instanceColor;
${INSTANCED_WORLD}

uniform float time;
uniform vec2 windDirection;
uniform float treeHeight;

out vec3 vWorldPosition;
out vec3 vNormal;
out vec2 vUV;
out vec3 vTint;
out float vViewDepth;

void main() {
  mat4 finalWorld = world * mat4(world0, world1, world2, world3);
  vec4 worldPosition = finalWorld * vec4(position, 1.0);

  // The whole crown sways with the wind, more the higher up, each tree on its own phase; on top of
  // that each card flutters a little on its own.
  vec3 origin = finalWorld[3].xyz;
  float reach = clamp(position.y / treeHeight, 0.0, 1.0);
  float sway = sin(time * 0.9 + origin.x * 0.05 + origin.z * 0.07) * 0.6 * reach * reach;
  float flutter = sin(time * 3.1 + dot(position, vec3(1.7, 2.3, 1.1))) * 0.12 * reach;
  worldPosition.xz += windDirection * (sway + flutter);
  worldPosition.y += flutter * 0.5;

  vNormal = normalize(mat3(finalWorld) * normal);
  vUV = uv;
  vTint = instanceColor.rgb;
  vWorldPosition = worldPosition.xyz;
  vViewDepth = (view * worldPosition).z;
  gl_Position = viewProjection * worldPosition;
}
`;

export const LEAF_FRAGMENT_SHADER = `#version 300 es
precision highp float;
${LIT_SHADING_GLSL}

in vec3 vWorldPosition;
in vec3 vNormal;
in vec2 vUV;
in vec3 vTint;
in float vViewDepth;

uniform sampler2D leafAtlas;

out vec4 outColor;

void main() {
  vec4 leaf = texture(leafAtlas, vUV);
  // Mipmapping averages the cut-out's coverage away with distance; raising alpha with the mip
  // level keeps a crown from thinning into sky before it is far enough not to matter.
  vec2 texel = vUV * ${FOLIAGE_TEXTURE_SIZE.toFixed(1)};
  float lod = max(0.0, 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))));
  if (leaf.a * (1.0 + 0.3 * lod) < 0.5) discard;

  vec3 albedo = leaf.rgb * vTint;
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(lightDirection);
  // Wrapped lighting on the crown's own normal: the sunny side bright, the far side falling off
  // softly rather than to black, the crown shading as one rounded mass.
  float wrapped = clamp(dot(n, lightDir) * 0.5 + 0.5, 0.0, 1.0);
  float diffuse = wrapped * wrapped * 1.15 * lightIntensity;
  // Looking towards the sun through the crown, the leaves glow a little.
  vec3 toCamera = normalize(cameraPosition - vWorldPosition);
  float through = pow(max(dot(-toCamera, lightDir), 0.0), 4.0) * 0.35 * lightIntensity;
  // The underside of a crown is darker than its top.
  float occlusion = mix(0.6, 1.0, n.y * 0.5 + 0.5);
  float shadow = computeShadow(vWorldPosition, n, vViewDepth);
  vec3 lit = albedo * ((diffuse + through) * lightColor * shadow + ambientColor * ambientIntensity * occlusion);
  outColor = vec4(applyFog(lit, length(vWorldPosition - cameraPosition)), 1.0);
}
`;
