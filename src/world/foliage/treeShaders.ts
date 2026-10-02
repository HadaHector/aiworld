import { LIT_SHADING_GLSL } from "../materials/litShading";
import { FOLIAGE_TEXTURE_SIZE } from "./treeTextures";

/**
 * Shaders for branching trees (see treeGenerator.ts): the wood, bark-textured with a normal map,
 * and the leaf cards, cut out of the foliage atlas - and for boulders (boulderGenerator.ts). Both are drawn as thin instances - one matrix
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

/** Texels per row of the tree tint table: the leaves' colour matrix, then the bark's, then a
 *  boulder's stone's, a column each. */
export const TREE_TINT_WIDTH = 9;

/**
 * Each area's recolouring of its trees (a biome's `treeTints`), one row per area - row 0 changes
 * nothing - which a tree's instance names in its colour's alpha (see treeField.ts). A matrix, not a
 * multiplied colour, because the leaves' green is in their atlas: only turning the final colour can
 * make them orange or blue.
 */
const TREE_TINT_GLSL = `
uniform highp sampler2D treeTints;

mat3 treeTint(float row, int first) {
  int r = int(row + 0.5);
  return mat3(
    texelFetch(treeTints, ivec2(first, r), 0).rgb,
    texelFetch(treeTints, ivec2(first + 1, r), 0).rgb,
    texelFetch(treeTints, ivec2(first + 2, r), 0).rgb
  );
}

// How much snow lies on this row's plants and stones, 0-1 (a treeTints rule's \`snow\`).
float treeSnow(float row) {
  return texelFetch(treeTints, ivec2(0, int(row + 0.5)), 0).a;
}
`;

export const BARK_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec2 uv;
in vec3 axis;
in vec4 instanceColor;
${INSTANCED_WORLD}

out vec3 vWorldPosition;
out vec3 vNormal;
out vec3 vAxis;
out vec2 vUV;
out float vViewDepth;
out float vHeight;
flat out float vTintRow;

void main() {
  mat4 finalWorld = world * mat4(world0, world1, world2, world3);
  vec4 worldPosition = finalWorld * vec4(position, 1.0);
  // Trees are only ever scaled uniformly, so the upper 3x3 turns normals correctly.
  mat3 turn = mat3(finalWorld);
  vNormal = normalize(turn * normal);
  vAxis = normalize(turn * axis);
  vUV = uv;
  vHeight = position.y;
  vTintRow = instanceColor.a;
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
flat in float vTintRow;
${TREE_TINT_GLSL}

uniform sampler2D barkColor;
uniform sampler2D barkNormal;

out vec4 outColor;

void main() {
  vec3 albedo = max(treeTint(vTintRow, 3) * texture(barkColor, vUV).rgb, 0.0);
  // The normal map's x runs around the limb and y along it.
  vec3 tangentNormal = texture(barkNormal, vUV).xyz * 2.0 - 1.0;
  vec3 surface = normalize(vNormal);
  vec3 along = normalize(vAxis - surface * dot(vAxis, surface));
  vec3 around = cross(along, surface);
  vec3 n = normalize(around * tangentNormal.x + along * tangentNormal.y + surface * tangentNormal.z);

  // Darker low down, where roots and the ground close in - a cheap stand-in for occlusion.
  float occlusion = mix(0.55, 1.0, smoothstep(-0.5, 5.0, vHeight));
  // Snow along the tops of the limbs and in the crooks - on whatever faces up enough, the bark's
  // own relief breaking its edge. A trunk stands too steep to hold any.
  float snow = treeSnow(vTintRow);
  if (snow > 0.0) {
    float relief = dot(texture(barkColor, vUV).rgb, vec3(0.33));
    float lying = 1.0 - snow * 0.8;
    float cover = smoothstep(lying, lying + 0.15, n.y + (relief - 0.3) * 0.3);
    albedo = mix(albedo, vec3(0.86, 0.9, 0.96), cover);
    occlusion = mix(occlusion, 1.0, cover * 0.5);
  }
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
in float lie;
in float flex;
in vec4 instanceColor;
${INSTANCED_WORLD}

uniform float time;
uniform vec2 windDirection;
uniform float treeHeight;

out vec3 vWorldPosition;
out vec3 vNormal;
out float vLie;
// 1 on a frond, whose normal is its surface's own (not the crown's), so it has an underside.
out float vFrond;
out vec2 vUV;
out vec3 vTint;
out float vViewDepth;
flat out float vTintRow;

void main() {
  mat4 finalWorld = world * mat4(world0, world1, world2, world3);
  vec4 worldPosition = finalWorld * vec4(position, 1.0);

  // The whole crown sways with the wind, more the higher up, each tree on its own phase; on top of
  // that each card flutters a little on its own. A frond bends from its root instead: still where
  // it grows, however high up that is, swaying most at its tip.
  vec3 origin = finalWorld[3].xyz;
  float reach = flex < 0.0 ? clamp(position.y / treeHeight, 0.0, 1.0) : flex;
  float sway = sin(time * 0.9 + origin.x * 0.05 + origin.z * 0.07) * 0.6 * reach * reach;
  float flutter = sin(time * 3.1 + dot(position, vec3(1.7, 2.3, 1.1))) * 0.12 * reach;
  worldPosition.xz += windDirection * (sway + flutter);
  worldPosition.y += flutter * 0.5;

  vNormal = normalize(mat3(finalWorld) * normal);
  vUV = uv;
  vTint = instanceColor.rgb;
  vTintRow = instanceColor.a;
  vWorldPosition = worldPosition.xyz;
  vLie = lie;
  vFrond = flex < 0.0 ? 0.0 : 1.0;
  vViewDepth = (view * worldPosition).z;
  gl_Position = viewProjection * worldPosition;
}
`;

export const LEAF_FRAGMENT_SHADER = `#version 300 es
precision highp float;
${LIT_SHADING_GLSL}

in vec3 vWorldPosition;
in vec3 vNormal;
in float vLie;
in float vFrond;
in vec2 vUV;
in vec3 vTint;
in float vViewDepth;
flat in float vTintRow;
${TREE_TINT_GLSL}

uniform sampler2D leafAtlas;

out vec4 outColor;

void main() {
  vec4 leaf = texture(leafAtlas, vUV);
  // Mipmapping averages the cut-out's coverage away with distance; raising alpha with the mip
  // level keeps a crown from thinning into sky before it is far enough not to matter.
  vec2 texel = vUV * ${FOLIAGE_TEXTURE_SIZE.toFixed(1)};
  float lod = max(0.0, 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))));
  if (leaf.a * (1.0 + 0.3 * lod) < 0.5) discard;

  vec3 albedo = max(treeTint(vTintRow, 0) * (leaf.rgb * vTint), 0.0);
  vec3 n = normalize(vNormal);
  // Snow lying on the branches: wherever the card itself lies flat enough to hold it (its \`lie\`, not
  // the crown's rounded normal, which turns down on the lower tiers and would leave them bare under
  // a white top) - thicker the more snow the area has, the spray's own light and dark needles
  // breaking it into clumps, the darkest showing through, so a branch reads as loaded with snow
  // rather than painted white.
  float snow = treeSnow(vTintRow);
  if (snow > 0.0) {
    float level = vLie;
    float needles = dot(leaf.rgb, vec3(0.3, 0.5, 0.2));
    float clump = smoothstep(0.04, 0.3, needles);
    float lying = 1.0 - snow * 0.85;
    // A light snow only catches on the brightest needles; a heavy one fills in over the dark ones
    // too, the branch's top one solid white.
    float cover = smoothstep(lying - 0.1, lying + 0.25, level + (clump - 0.5) * 0.6) * mix(0.1 + snow * 0.4, 1.0, clump);
    vec3 snowColor = vec3(0.9, 0.93, 0.98) * (0.9 + clump * 0.12);
    albedo = mix(albedo, snowColor, clamp(cover * 1.3, 0.0, 1.0));
  }
  vec3 lightDir = normalize(lightDirection);
  vec3 toCamera = normalize(cameraPosition - vWorldPosition);
  // A frond seen from below shows its underside, which is lit through the leaf: half the light its
  // top gets. Its normal stays the top's for that, turned to face the camera only for the shadow.
  float underside = vFrond > 0.5 && dot(n, toCamera) < 0.0 ? 1.0 : 0.0;
  // Wrapped lighting on the crown's own normal: the sunny side bright, the far side falling off
  // softly rather than to black, the crown shading as one rounded mass.
  float wrapped = clamp(dot(n, lightDir) * 0.5 + 0.5, 0.0, 1.0);
  float diffuse = wrapped * wrapped * 1.15 * lightIntensity * (1.0 - underside * 0.5);
  // Looking towards the sun through the crown, the leaves glow a little.
  float through = pow(max(dot(-toCamera, lightDir), 0.0), 4.0) * 0.35 * lightIntensity;
  // The underside of a crown is darker than its top.
  float occlusion = mix(0.6, 1.0, n.y * 0.5 + 0.5) * (1.0 - underside * 0.25);
  if (underside > 0.5) n = -n;
  float shadow = computeShadow(vWorldPosition, n, vViewDepth);
  vec3 lit = albedo * ((diffuse + through) * lightColor * shadow + ambientColor * ambientIntensity * occlusion);
  // A broad leaf's waxy top catches the sun.
  if (vFrond > 0.5 && underside < 0.5) {
    float gloss = pow(max(dot(n, normalize(lightDir + toCamera)), 0.0), 40.0) * 0.35 * lightIntensity;
    lit += lightColor * gloss * shadow;
  }
  outColor = vec4(applyFog(lit, length(vWorldPosition - cameraPosition)), 1.0);
}
`;

export const ROCK_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec4 instanceColor;
${INSTANCED_WORLD}

out vec3 vWorldPosition;
out vec3 vLocal;
out vec3 vLocalNormal;
out mat3 vTurn;
out vec3 vTint;
out float vViewDepth;
out float vHeight;
flat out float vTintRow;

void main() {
  mat4 finalWorld = world * mat4(world0, world1, world2, world3);
  vec4 worldPosition = finalWorld * vec4(position, 1.0);
  // Uniformly scaled: the stone's texture is laid on in its own space, so it stays put on the stone
  // however it is turned, at the same size on a small stone as a giant.
  float size = length(finalWorld[0].xyz);
  vLocal = position * size;
  vLocalNormal = normal;
  vTurn = mat3(finalWorld) / size;
  vHeight = position.y * size;
  vTint = instanceColor.rgb;
  vTintRow = instanceColor.a;
  vWorldPosition = worldPosition.xyz;
  vViewDepth = (view * worldPosition).z;
  gl_Position = viewProjection * worldPosition;
}
`;

/**
 * A boulder has no seams to lay a texture along, so its stone is projected on from three sides and
 * blended by which way the surface faces (triplanar), each side's normal map folded onto the surface
 * normal (the "whiteout" blend), all in the stone's own space.
 */
export const ROCK_FRAGMENT_SHADER = `#version 300 es
precision highp float;
${LIT_SHADING_GLSL}

in vec3 vWorldPosition;
in vec3 vLocal;
in vec3 vLocalNormal;
in mat3 vTurn;
in vec3 vTint;
in float vViewDepth;
in float vHeight;
flat in float vTintRow;
${TREE_TINT_GLSL}

uniform sampler2D stoneColor;
uniform sampler2D stoneNormal;
uniform float stoneTile;

out vec4 outColor;

void main() {
  vec3 surface = normalize(vLocalNormal);
  vec3 weights = pow(abs(surface), vec3(4.0));
  weights /= weights.x + weights.y + weights.z;
  vec2 uvX = vLocal.zy / stoneTile;
  vec2 uvY = vLocal.xz / stoneTile;
  vec2 uvZ = vLocal.xy / stoneTile;

  vec3 stone = texture(stoneColor, uvX).rgb * weights.x + texture(stoneColor, uvY).rgb * weights.y + texture(stoneColor, uvZ).rgb * weights.z;
  vec3 nX = texture(stoneNormal, uvX).xyz * 2.0 - 1.0;
  vec3 nY = texture(stoneNormal, uvY).xyz * 2.0 - 1.0;
  vec3 nZ = texture(stoneNormal, uvZ).xyz * 2.0 - 1.0;
  nX = vec3(nX.xy + surface.zy, abs(nX.z) * surface.x);
  nY = vec3(nY.xy + surface.xz, abs(nY.z) * surface.y);
  nZ = vec3(nZ.xy + surface.xy, abs(nZ.z) * surface.z);
  vec3 local = normalize(nX.zyx * weights.x + nY.xzy * weights.y + nZ.xyz * weights.z);
  vec3 n = normalize(vTurn * local);
  vec3 geometric = normalize(vTurn * surface);

  vec3 albedo = max(treeTint(vTintRow, 6) * (stone * vTint), 0.0);
  // Snow on its top: on whatever faces up enough, reaching further down the sides the more snow
  // there is - the bumped normal, so its edge follows the stone's own cracks and knobs rather
  // than a smooth contour, lying in the hollows first.
  float snow = treeSnow(vTintRow);
  if (snow > 0.0) {
    float stoneHeight = texture(stoneNormal, uvX).a * weights.x + texture(stoneNormal, uvY).a * weights.y + texture(stoneNormal, uvZ).a * weights.z;
    float upness = mix(geometric.y, n.y, 0.5) - (stoneHeight - 0.5) * 0.25;
    float lying = 1.0 - snow * 1.1;
    float cover = smoothstep(lying, lying + 0.12, upness);
    // Not a flat white: the stone's own relief shows through as soft drifts and crust.
    vec3 snowColor = vec3(0.86, 0.9, 0.96) * (0.9 + stoneHeight * 0.18);
    albedo = mix(albedo, snowColor, cover);
  }
  // A little darker where it meets the ground - a cheap stand-in for occlusion.
  float occlusion = mix(0.75, 1.0, smoothstep(-0.3, 1.0, vHeight));
  vec3 lightDir = normalize(lightDirection);
  // Lit the way the ground is (materialLibrary.ts's plain Lambert), so a boulder is the same stone
  // in the same light as the rock it lies on.
  float diffuse = max(dot(n, lightDir), 0.0) * lightIntensity;
  float shadow = computeShadow(vWorldPosition, geometric, vViewDepth);
  vec3 lit = albedo * (diffuse * lightColor * shadow + ambientColor * ambientIntensity) * occlusion;
  outColor = vec4(applyFog(lit, length(vWorldPosition - cameraPosition)), 1.0);
}
`;
