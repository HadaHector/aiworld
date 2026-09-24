import { Matrix, type Scene, type ShaderMaterial } from "@babylonjs/core";
import {
  SHADOW_CASCADE_COUNT,
  SHADOW_CASCADE_BLEND,
  SHADOW_DARKNESS,
  SHADOW_EDGE_FADE,
  SHADOW_MAP_SIZE,
  type SunLighting,
} from "../lighting/sunLighting";

/**
 * The lighting every custom world shader shares: the sun/moon and ambient light, the cascaded
 * shadow map, and fog - as a GLSL block to paste into a fragment shader, plus the per-frame uniform
 * plumbing to feed it. Terrain and grass both use it, which is what keeps a blade of grass lit,
 * shadowed and fogged exactly like the ground it stands on.
 *
 * The block declares its own uniforms and precision, so a shader includes it after its `#version`
 * line and before main(), and calls:
 *  - computeShadow(worldPos, worldNormal, viewDepth): 1 fully lit .. SHADOW_DARKNESS fully shadowed
 *  - applyFog(color, distanceFromCamera)
 */
export const LIT_SHADING_GLSL = `
precision highp sampler2DArrayShadow;

#define NUM_CASCADES ${SHADOW_CASCADE_COUNT}
#define CASCADE_BLEND ${SHADOW_CASCADE_BLEND.toFixed(4)}
#define SHADOW_DARKNESS ${SHADOW_DARKNESS.toFixed(4)}
#define SHADOW_EDGE_FADE ${SHADOW_EDGE_FADE.toFixed(4)}

uniform vec3 lightDirection;
uniform float lightIntensity;
uniform vec3 lightColor;
uniform vec3 ambientColor;
uniform float ambientIntensity;
uniform vec3 cameraPosition;

uniform bool shadowsEnabled;
uniform highp sampler2DArrayShadow shadowMap;
uniform mat4 lightMatrix[NUM_CASCADES];
uniform float cascadeSplits[NUM_CASCADES];
uniform float cascadeBias[NUM_CASCADES];
uniform float shadowTexelSize;

uniform int fogMode;
uniform vec3 fogColor;
uniform float fogStart;
uniform float fogEnd;
uniform float fogDensity;

/**
 * One cascade's worth of shadow, hardware-compared and box-filtered.
 *
 * texture() on a sampler2DArrayShadow returns the already-filtered fraction of the 2x2 texel
 * neighbourhood that is nearer the light than depth - one hardware comparison per tap, not a raw
 * depth read this code would have to compare by hand. The 3x3 loop around it is what turns that
 * single soft edge into a properly area-filtered one.
 */
float sampleCascade(int cascade, vec3 worldPos) {
  vec4 posFromLight = lightMatrix[cascade] * vec4(worldPos, 1.0);
  vec3 clipSpace = posFromLight.xyz / posFromLight.w;
  vec2 uv = clipSpace.xy * 0.5 + 0.5;
  float depth = clamp(clipSpace.z * 0.5 + 0.5, 0.0, 0.9999);

  float lit = 0.0;
  for (int dx = -1; dx <= 1; dx++) {
    for (int dy = -1; dy <= 1; dy++) {
      vec2 offset = vec2(float(dx), float(dy)) * shadowTexelSize;
      lit += texture(shadowMap, vec4(uv + offset, float(cascade), depth));
    }
  }
  return lit / 9.0;
}

/**
 * Which of the cascades - and, near a cascade boundary, how much of the next one too - a fragment
 * falls into, then the shadow those choices actually add up to.
 *
 * Cascade choice keys on view-space Z (forward depth from the camera, the same depth Babylon's own
 * shadow-receiving shaders key cascade selection on, not radial distance) against cascadeSplits,
 * which SunLighting computes with the exact same closed-form split the shadow generator itself uses
 * internally: the fragment shader has no access to the generator's own numbers, so agreement here
 * depends entirely on both sides doing the identical arithmetic from the identical inputs.
 *
 * Every seam a hard cascade choice would leave is instead a fade: CASCADE_BLEND blends this
 * cascade's sample toward the next one's over the last fraction of its own span, and
 * SHADOW_EDGE_FADE fades the whole effect back to fully lit over the last few units before the
 * far cascade's own edge, rather than the shadow switching off in one triangle.
 */
float computeShadow(vec3 worldPos, vec3 worldNormal, float viewDepth) {
  if (!shadowsEnabled) return 1.0;
  if (viewDepth > cascadeSplits[NUM_CASCADES - 1]) return 1.0;

  int cascade = NUM_CASCADES - 1;
  for (int i = 0; i < NUM_CASCADES; i++) {
    if (viewDepth <= cascadeSplits[i]) { cascade = i; break; }
  }

  // Normal-offset bias: pushes the sampled point off the surface along its own normal before
  // projecting into light space, rather than biasing the compared depth by a flat amount. A flat
  // bias sized for the near cascade's fine texels is nowhere near enough to clear self-shadowing
  // acne in the coarser far ones, and one sized for the far cascade would peel the near shadows
  // away from their casters - cascadeBias is scaled per cascade for exactly this reason.
  vec3 biasedPos = worldPos + worldNormal * cascadeBias[cascade];
  float lit = sampleCascade(cascade, biasedPos);

  if (cascade < NUM_CASCADES - 1) {
    float prevSplit = cascade == 0 ? 0.0 : cascadeSplits[cascade - 1];
    float span = cascadeSplits[cascade] - prevSplit;
    float t = clamp((viewDepth - prevSplit) / span - (1.0 - CASCADE_BLEND), 0.0, CASCADE_BLEND) / CASCADE_BLEND;
    float blend = t * t * (3.0 - 2.0 * t);
    if (blend > 0.0) {
      float nextLit = sampleCascade(cascade + 1, biasedPos);
      lit = mix(lit, nextLit, blend);
    }
  }

  float edgeT = clamp((cascadeSplits[NUM_CASCADES - 1] - viewDepth) / SHADOW_EDGE_FADE, 0.0, 1.0);
  float edgeFade = edgeT * edgeT * (3.0 - 2.0 * edgeT);
  float shadow = mix(SHADOW_DARKNESS, 1.0, lit);
  return mix(1.0, shadow, edgeFade);
}

vec3 applyFog(vec3 color, float fogDistance) {
  float fogFactor = 1.0;
  if (fogMode == 3) {
    fogFactor = clamp((fogEnd - fogDistance) / max(fogEnd - fogStart, 0.0001), 0.0, 1.0);
  } else if (fogMode == 1) {
    fogFactor = clamp(1.0 / exp(fogDistance * fogDensity), 0.0, 1.0);
  } else if (fogMode == 2) {
    fogFactor = clamp(1.0 / exp(fogDistance * fogDistance * fogDensity * fogDensity), 0.0, 1.0);
  }
  return mix(fogColor, color, fogFactor);
}
`;

/** The uniforms LIT_SHADING_GLSL declares - to list in a ShaderMaterial's options. */
export const LIT_SHADING_UNIFORMS = [
  "lightDirection",
  "lightIntensity",
  "lightColor",
  "ambientColor",
  "ambientIntensity",
  "cameraPosition",
  "shadowsEnabled",
  "lightMatrix",
  "cascadeSplits",
  "cascadeBias",
  "shadowTexelSize",
  "fogMode",
  "fogColor",
  "fogStart",
  "fogEnd",
  "fogDensity",
];

export const LIT_SHADING_SAMPLERS = ["shadowMap"];

export interface LitShading {
  /** Starts feeding a material's LIT_SHADING_GLSL uniforms every frame. */
  register: (material: ShaderMaterial) => void;
  /** Stops every registered shader from sampling the shadow map at all - the companion half of
   *  SunLighting.setShadowsEnabled, which stops the map being rendered into in the first place. */
  setShadowsEnabled: (enabled: boolean) => void;
}

export function createLitShading(scene: Scene, sunLighting: SunLighting): LitShading {
  const materials: ShaderMaterial[] = [];
  let shadowsEnabled = true;

  // cameraPosition isn't one of ShaderMaterial's automatically-bound uniform names (only the
  // world/view/projection matrix family is), so it needs a manual per-frame update - and
  // scene.activeCamera doesn't exist yet on the very first tick (main.ts creates the camera after
  // the world), hence the guard. Fog and light ride along: the day-night cycle changes the light
  // every frame, and direction and colours are mutated in place (see SunLighting's own fields), so
  // reading them fresh here every frame is what actually picks up each frame's value.
  scene.onBeforeRenderObservable.add(() => {
    for (const material of materials) {
      if (scene.activeCamera) material.setVector3("cameraPosition", scene.activeCamera.position);
      material.setInt("fogMode", scene.fogMode);
      material.setColor3("fogColor", scene.fogColor);
      material.setFloat("fogStart", scene.fogStart);
      material.setFloat("fogEnd", scene.fogEnd);
      material.setFloat("fogDensity", scene.fogDensity);
      material.setVector3("lightDirection", sunLighting.direction);
      material.setFloat("lightIntensity", sunLighting.intensity);
      material.setColor3("lightColor", sunLighting.color);
      material.setColor3("ambientColor", sunLighting.ambientColor);
      material.setFloat("ambientIntensity", sunLighting.ambientIntensity);
    }
  });

  /**
   * The shadow map's per-cascade matrices are NOT safe to read at the top of the frame. They
   * describe where the generator pointed its shadow camera to cover THIS frame, and the generator
   * only refits them to the camera during its own render pass, which Babylon runs after
   * onBeforeRenderObservable, as part of rendering the main camera's view. Reading them there read
   * last frame's fit instead of this one's: invisible while the camera sat still, and a visibly
   * wrong, lagging shadow the instant it moved.
   *
   * The shadow map's own onAfterRenderObservable is what actually pins this down: it fires once per
   * cascade layer, strictly after that layer's render, which is strictly before the main pass that
   * reads it. Every cascade's matrix is computed together before layer 0 even starts (see the
   * generator's own onBeforeBindObservable), so any one layer finishing is already enough to read
   * all of them; the gate below just keeps the actual update to once per frame.
   */
  const shadowMap = sunLighting.shadowGenerator.getShadowMap();
  let shadowMatricesStale = true;
  scene.onBeforeRenderObservable.add(() => {
    shadowMatricesStale = true;
  });
  shadowMap?.onAfterRenderObservable.add(() => {
    if (!shadowMatricesStale || !shadowsEnabled) return;
    shadowMatricesStale = false;

    // The RenderTargetTexture itself is a colour attachment; the depth-stencil texture the
    // generator creates alongside it is the one WebGL actually built as a comparison texture, which
    // is what a sampler2DArrayShadow uniform requires - binding the colour one there is a real
    // GL_INVALID_OPERATION, not a silently-wrong-looking result.
    const depthTexture = shadowMap.depthStencilTexture;
    if (!depthTexture) return;

    const matrices: Matrix[] = [];
    for (let i = 0; i < SHADOW_CASCADE_COUNT; i++) {
      matrices.push(sunLighting.shadowGenerator.getCascadeTransformMatrix(i) ?? Matrix.Identity());
    }
    for (const material of materials) {
      material.setInternalTexture("shadowMap", depthTexture);
      material.setMatrices("lightMatrix", matrices);
    }
  });

  function register(material: ShaderMaterial): void {
    materials.push(material);
    material.setInt("shadowsEnabled", shadowsEnabled ? 1 : 0);
    material.setFloats("cascadeSplits", sunLighting.cascadeSplits);
    material.setFloats("cascadeBias", sunLighting.cascadeBias);
    material.setFloat("shadowTexelSize", 1 / SHADOW_MAP_SIZE);
  }

  function setShadowsEnabled(enabled: boolean): void {
    shadowsEnabled = enabled;
    for (const material of materials) material.setInt("shadowsEnabled", enabled ? 1 : 0);
  }

  return { register, setShadowsEnabled };
}
