import { Effect, MeshBuilder, ShaderMaterial, type Mesh, type Scene } from "@babylonjs/core";
import { SEA_LEVEL } from "../cells/areaField";
import type { SunLighting } from "../lighting/sunLighting";
import type { SkyDome } from "../sky/skyDome";

export interface OceanOptions {
  size: number;
}

// Nudged slightly below sea level so the ocean plane is never exactly coplanar with terrain that
// happens to sit right at sea level (e.g. a shallow lake edge) - avoids z-fighting flicker. Land
// at or above SEA_LEVEL still fully occludes the plane; only genuine dips below it show water.
const OCEAN_SURFACE_OFFSET = 0.1;

// How strongly the water's own colour covers the ground beneath it, once the water is at least
// WATER_TINT_FULL_DEPTH deep. The tint isn't drawn by the water plane at all - it can't know how deep
// the water under a pixel is - but by the terrain shader, which knows its own height against the
// waterline (see materialLibrary.ts). That is what lets it fade to nothing at the shoreline while
// the water plane's reflection and glint stay visible all the way to the edge.
export const WATER_ALPHA = 0.6;
export const WATER_TINT_FULL_DEPTH = 0.5;
export const WATER_DEEP_COLOR: [number, number, number] = [0.035, 0.11, 0.16];
export const WATER_SHALLOW_COLOR: [number, number, number] = [0.09, 0.34, 0.42];

// Keeps each triangle a few dozen units across at the default size.
const OCEAN_SUBDIVISIONS = 128;

// World units per noise cell for each wave octave (broad swell, mid chop, fine ripple) - the actual
// "how big do the waves look" knob, against the character's own scale rather than the world's:
// character.ts stands a couple of units tall, so a ripple has to read in single digits of world
// units to look like water and not like rolling dunes.
const WAVE_CELL_SIZES = [12, 4, 0.9];
// Each octave's own drift direction/speed (world units/second-ish, since it multiplies time before
// the cell-size scale is applied) and how strongly its gradient contributes to the final normal.
const WAVE_DRIFT: Array<[number, number]> = [
  [1.6, 0.9],
  [-2.6, 1.7],
  [4.1, -3.2],
];
const WAVE_STRENGTH = [1.0, 0.5, 0.22];

const VERTEX_SHADER = `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
varying vec3 vWorldPosition;
varying vec3 vPositionFromCamera;
void main(void) {
  vec4 worldPosition = world * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  // Same forward-depth-for-fog convention terrain's own shader uses - see its own comment on the
  // identical varying for why this isn't just distance computed straight from vWorldPosition.
  vPositionFromCamera = (view * worldPosition).xyz;
  gl_Position = projection * view * worldPosition;
}
`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec3 vWorldPosition;
varying vec3 vPositionFromCamera;

uniform vec3 cameraPosition;
uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform float lightIntensity;
uniform vec3 ambientColor;
uniform float ambientIntensity;
uniform vec3 skyHorizon;
uniform vec3 skyZenith;
uniform float time;

uniform int fogMode;
uniform vec3 fogColor;
uniform float fogStart;
uniform float fogEnd;
uniform float fogDensity;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * One octave's worth of "waves", as a slope rather than a height - the world's ocean is tens of
 * thousands of units across (worldExtent), several orders of magnitude too large to usefully
 * subdivide into real per-vertex wave geometry (even a modest-looking grid would need millions of
 * vertices to resolve a wavelength measured in single-digit world units). Every bit of wave motion
 * here is therefore a shading trick, not displaced geometry: a scrolling noise field's own finite-
 * difference gradient stands in for a real wave's slope, which is all a perturbed surface normal
 * ever needed from it anyway.
 */
vec2 waveGradient(vec2 p, float scale, vec2 drift, float strength) {
  vec2 uv = p * scale + drift;
  float e = 0.35;
  float hL = valueNoise(uv - vec2(e, 0.0));
  float hR = valueNoise(uv + vec2(e, 0.0));
  float hD = valueNoise(uv - vec2(0.0, e));
  float hU = valueNoise(uv + vec2(0.0, e));
  return vec2(hR - hL, hU - hD) * strength;
}

void main(void) {
  vec2 p = vWorldPosition.xz;
  // Three octaves, each drifting its own direction/speed so the sum never repeats in an obviously
  // periodic way: a slow broad swell, a mid-size chop on top of it, and a fine sparkle-sized ripple
  // for the specular highlight below to catch.
  vec2 grad = vec2(0.0);
  grad += waveGradient(p, ${(1 / WAVE_CELL_SIZES[0]).toFixed(5)}, vec2(time * ${WAVE_DRIFT[0][0].toFixed(2)}, time * ${WAVE_DRIFT[0][1].toFixed(2)}), ${WAVE_STRENGTH[0].toFixed(3)});
  grad += waveGradient(p, ${(1 / WAVE_CELL_SIZES[1]).toFixed(5)}, vec2(time * ${WAVE_DRIFT[1][0].toFixed(2)}, time * ${WAVE_DRIFT[1][1].toFixed(2)}), ${WAVE_STRENGTH[1].toFixed(3)});
  grad += waveGradient(p, ${(1 / WAVE_CELL_SIZES[2]).toFixed(5)}, vec2(time * ${WAVE_DRIFT[2][0].toFixed(2)}, time * ${WAVE_DRIFT[2][1].toFixed(2)}), ${WAVE_STRENGTH[2].toFixed(3)});
  vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));

  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 lightDir = normalize(lightDirection);
  float ndl = max(dot(n, lightDir), 0.0);

  // Tight and bright - a sun/moon glint reads as a small sparkle on the water, not a broad terrain-
  // style highlight, which is what the very high shininess exponent buys over materialLibrary's own
  // specular term.
  vec3 halfVec = normalize(viewDir + lightDir);
  float ndh = max(dot(n, halfVec), 0.0);
  float specular = pow(ndh, 200.0) * lightIntensity * 1.5;

  // Fresnel: water reflects almost nothing looking straight down into it and almost everything at
  // a grazing angle - the actual reason any open water reads as a mirror near the horizon and a
  // window onto the seabed directly underfoot.
  float fresnel = pow(1.0 - clamp(dot(viewDir, n), 0.0, 1.0), 4.0);

  // Not a real reflection (no second render pass, no scene geometry in it) - just the same
  // horizon/zenith gradient the sky dome itself is shaded by, evaluated toward the reflected ray
  // instead of the view ray. Cheap, and correct in the one way that actually matters for a flat
  // surface: a reflection this shallow is almost always looking back at open sky, not at scenery.
  vec3 reflectDir = reflect(-viewDir, n);
  float skyT = smoothstep(0.0, 0.6, clamp(reflectDir.y, 0.0, 1.0));
  vec3 reflectedSky = mix(skyHorizon, skyZenith, skyT);

  // Only the reflection and glint are drawn here; the water's body colour is the terrain shader's
  // job (see WATER_ALPHA), so this pass's own opacity is just how much reflection there is.
  float reflectAlpha = ${WATER_ALPHA.toFixed(3)} * clamp(fresnel * 0.85 + 0.1, 0.0, 1.0);

  vec3 glint = lightColor * specular;
  vec3 color = reflectedSky + glint;
  // A glint is light the surface throws at the camera, not something seen through it - it raises
  // the pixel's opacity rather than being scaled down by a thin reflection.
  float alpha = clamp(reflectAlpha + max(glint.r, max(glint.g, glint.b)), 0.0, 1.0);

  float fogDistance = length(vPositionFromCamera);
  float fogFactor = 1.0;
  if (fogMode == 3) {
    fogFactor = clamp((fogEnd - fogDistance) / max(fogEnd - fogStart, 0.0001), 0.0, 1.0);
  } else if (fogMode == 1) {
    fogFactor = clamp(1.0 / exp(fogDistance * fogDensity), 0.0, 1.0);
  } else if (fogMode == 2) {
    fogFactor = clamp(1.0 / exp(fogDistance * fogDistance * fogDensity * fogDensity), 0.0, 1.0);
  }
  vec3 finalColor = mix(fogColor, color, fogFactor);

  gl_FragColor = vec4(finalColor, alpha);
}
`;

/**
 * A flat water plane at sea level - no wave geometry (see waveGradient's own comment for why one
 * mesh spanning the whole world can't have any), shaded instead: a scrolling-noise normal stands in
 * for real waves, fresnel blends between the water's own colour and a fake reflection of the sky's
 * current horizon/zenith gradient, and a tight specular term puts a sun/moon glint on it. Reads
 * lightDirection/lightColor/lightIntensity/ambientColor/ambientIntensity from SunLighting exactly
 * like the terrain shader does, so the water dims and cools at night right along with the ground.
 */
export function createOceanPlane(scene: Scene, sunLighting: SunLighting, sky: SkyDome, waterMaterials: ShaderMaterial[], options: OceanOptions): Mesh {
  // Camera-following and subdivided rather than one world-sized quad: two triangles tens of
  // thousands of units across lose enough float precision in depth interpolation that the
  // waterline jitters against the shore whenever the camera moves. The waves are computed from
  // world position, so sliding the mesh under them doesn't move the pattern.
  const ocean = MeshBuilder.CreateGround("ocean", { width: options.size, height: options.size, subdivisions: OCEAN_SUBDIVISIONS }, scene);
  ocean.position.y = SEA_LEVEL - OCEAN_SURFACE_OFFSET;
  ocean.isPickable = false;
  ocean.applyFog = false;

  Effect.ShadersStore["oceanVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["oceanFragmentShader"] = FRAGMENT_SHADER;

  const material = new ShaderMaterial("oceanMaterial", scene, "ocean", {
    attributes: ["position"],
    uniforms: [
      "world",
      "view",
      "projection",
      "cameraPosition",
      "lightDirection",
      "lightColor",
      "lightIntensity",
      "ambientColor",
      "ambientIntensity",
      "skyHorizon",
      "skyZenith",
      "time",
      "fogMode",
      "fogColor",
      "fogStart",
      "fogEnd",
      "fogDensity",
    ],
  });
  material.backFaceCulling = true;
  // Forces Babylon's engine-level alpha-blend mode on (Material.needAlphaBlending checks alpha < 1
  // for every material, ShaderMaterial included) - the actual blend amount is the shader's own
  // WATER_ALPHA output above, not this number, but it still has to be under 1 to turn blending on
  // at all.
  material.alpha = 0.999;
  ocean.material = material;

  // A still surface - no tide - so the shore and anything floating on the water (materialLibrary.ts's
  // floating sheet) stay where they are: the terrain shaders are told its height once.
  for (const waterMaterial of waterMaterials) waterMaterial.setFloat("waterLevel", ocean.position.y);

  let time = 0;
  scene.onBeforeRenderObservable.add(() => {
    time += scene.getEngine().getDeltaTime() / 2000;
    if (scene.activeCamera) {
      ocean.position.x = scene.activeCamera.position.x;
      ocean.position.z = scene.activeCamera.position.z;
    }
    material.setFloat("time", time);
    if (scene.activeCamera) {
      material.setVector3("cameraPosition", scene.activeCamera.position);
    }
    material.setVector3("lightDirection", sunLighting.direction);
    material.setColor3("lightColor", sunLighting.color);
    material.setFloat("lightIntensity", sunLighting.intensity);
    material.setColor3("ambientColor", sunLighting.ambientColor);
    material.setFloat("ambientIntensity", sunLighting.ambientIntensity);
    material.setColor3("skyHorizon", sky.horizon);
    material.setColor3("skyZenith", sky.zenith);
    material.setInt("fogMode", scene.fogMode);
    material.setColor3("fogColor", scene.fogColor);
    material.setFloat("fogStart", scene.fogStart);
    material.setFloat("fogEnd", scene.fogEnd);
    material.setFloat("fogDensity", scene.fogDensity);
  });

  return ocean;
}
