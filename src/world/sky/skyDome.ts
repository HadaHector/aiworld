import { Color3, Effect, Mesh, MeshBuilder, ShaderMaterial, Vector2, Vector3, type Scene } from "@babylonjs/core";
import type { AreaWeight } from "../cells/areaField";
import { lerp } from "../mathUtils";
import { computeDayNightFactors, deriveNightSkyColor } from "../lighting/dayNightMath";
import { FAIR_CLOUD_COVER, type WeatherBlend } from "../weather/weatherTypes";

// How strongly the sunrise/sunset glow (each in-range biome's own sunHorizonColor - the same warm
// colour the sun itself wears low in the sky, see BiomeDayNight) washes into the sky at full
// twilightFactor. Zenith gets a fixed, direction-independent wash (a clear sky overhead still reads
// mostly its own colour everywhere, so it isn't worth making directional) - horizon and cloud
// instead get a DIRECTIONAL one, shaped by sunFacing in the fragment shader below, since a real
// sunset colours one whole side of the horizon, not a uniform ring around the player.
const TWILIGHT_ZENITH_STRENGTH = 0.22;
const TWILIGHT_HORIZON_STRENGTH = 0.85;
const TWILIGHT_CLOUD_STRENGTH = 0.6;
// The horizon's own opposite-side wash - the real "Belt of Venus": the band of sky directly across
// from a low sun reads distinctly cooler/paler (toward the zenith's own colour, not merely darker),
// not simply "not sunset-coloured". Weaker than the sun-side wash - it is a secondary effect, not a
// second sunset.
const TWILIGHT_HORIZON_ANTI_STRENGTH = 0.5;

// Far past MAX_DRAW_DISTANCE (2000) and the shadow/fog reach - the dome is infiniteDistance, so its
// own radius only has to clear the camera's far clip plane, never the world itself.
const SKY_RADIUS = 4000;

// Where the imaginary cloud plane sits above the camera, in world units - see the fragment
// shader's own comment for what this actually buys over a literal cloud mesh.
const CLOUD_HEIGHT = 900;
// World units per noise cell - bigger clouds, not more of them.
const CLOUD_FREQUENCY = 0.00065;
// How wide the coverage threshold's own transition is - a soft cloud edge instead of a stencil cutout.
// (How much of the sky is cloud is the weather's - see WeatherBlend.cloudCover.)
const CLOUD_SOFTNESS = 0.22;
const CLOUD_OPACITY = 0.85;
// World units/second the noise field drifts, so a cloud layer reads as blowing rather than painted on.
const CLOUD_WIND = { x: 2.4, z: 0.9 };

const VERTEX_SHADER = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDirection;
void main(void) {
  // The dome is centred on the origin and only ever translated to follow the camera
  // (Mesh.infiniteDistance), never rotated or non-uniformly scaled - so a vertex's own object-space
  // position, normalized, is exactly the world-space direction from the camera to that point on the
  // sky. That is the one ray direction the whole fragment shader below is built around.
  vDirection = normalize(position);
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec3 vDirection;

uniform vec3 skyZenith;
uniform vec3 skyHorizon;
uniform vec3 cloudColor;
uniform vec2 cloudOffset;
uniform float cloudCover;
uniform vec3 twilightTint;
uniform float twilightFactor;
uniform vec3 sunDirection;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Bilinear value noise - cheap and, stacked into an fbm below, plenty for a cloud layer nobody is
// meant to look at closer than "the whole sky".
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

float cloudFbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amplitude * valueNoise(p);
    p *= 2.02;
    amplitude *= 0.5;
  }
  return value;
}

void main(void) {
  vec3 dir = normalize(vDirection);

  // How aligned this direction's COMPASS bearing is with the sun/moon's - 1.0 looking straight at
  // it, -1.0 looking at the exact opposite point of the sky, 0.0 perpendicular to it. Elevation is
  // deliberately left out (xz only): this is meant to glow a whole vertical strip of sky from
  // horizon to zenith, the way a real sunset colours one whole side of the world, not a single spot
  // in it. Both lengths are guarded rather than just added an epsilon before normalizing - dir can
  // be exactly (0,y,0) looking straight up, and the result would otherwise silently pick an
  // arbitrary bearing instead of correctly falling back to "no preferred direction".
  vec2 dirXZ = dir.xz;
  vec2 sunXZ = sunDirection.xz;
  float dirXZLen = length(dirXZ);
  float sunXZLen = length(sunXZ);
  float sunFacing = (dirXZLen > 0.0001 && sunXZLen > 0.0001) ? dot(dirXZ / dirXZLen, sunXZ / sunXZLen) : 0.0;
  // Split rather than signed, so the sun's own side and its exact opposite can wash in two
  // different colours (warm toward the sun, cool toward skyZenith opposite it - see
  // TWILIGHT_HORIZON_ANTI_STRENGTH) instead of one tint that would have to fade through white or
  // reverse sign in between.
  float sunSide = twilightFactor * max(sunFacing, 0.0);
  float antiSide = twilightFactor * max(-sunFacing, 0.0);

  vec3 horizonLit = mix(skyHorizon, twilightTint, sunSide * ${TWILIGHT_HORIZON_STRENGTH.toFixed(3)});
  horizonLit = mix(horizonLit, skyZenith, antiSide * ${TWILIGHT_HORIZON_ANTI_STRENGTH.toFixed(3)});

  // Straight up is fully skyZenith, the horizon (and everything below it, mostly hidden by
  // terrain) is horizonLit - smoothstep rather than a linear mix so the gradient sits mostly flat
  // overhead and does its real work in the band just above the horizon, which is the part of the
  // sky actually on screen most of the time.
  float elevation = clamp(dir.y, 0.0, 1.0);
  vec3 sky = mix(horizonLit, skyZenith, smoothstep(0.0, 0.6, elevation));

  // A cloud layer is one flat, infinite plane CLOUD_HEIGHT above the camera. A view ray hits it at
  // camera + dir * (CLOUD_HEIGHT / dir.y): shallow rays (near the horizon) travel a long way before
  // they get there, steep ones (overhead) barely move - which is exactly how a real cloud deck
  // foreshortens, without needing an actual mesh plane to render it. dir.y is floored well above
  // zero so a ray parallel to the plane doesn't send this to infinity.
  float upness = max(dir.y, 0.02);
  vec2 cloudPlane = dir.xz * (${CLOUD_HEIGHT.toFixed(1)} / upness) * ${CLOUD_FREQUENCY};
  float coverage = cloudFbm(cloudPlane + cloudOffset);
  // The threshold slides with the cover: at 0 nothing clears it, at 1 everything does - and the
  // softness widens towards full cover, so a closing deck is one soft grey rather than hard blobs.
  float threshold = 1.0 - cloudCover;
  float softness = ${CLOUD_SOFTNESS.toFixed(3)} * (1.0 + cloudCover);
  float cloudMask = smoothstep(threshold - softness * 0.5, threshold + softness * 0.5, coverage);
  // The projection above stretches every cloud toward a smear as dir.y approaches zero - faded out
  // rather than let that smear reach the horizon. A full deck is opaque: no blue through it.
  float opacity = mix(${CLOUD_OPACITY.toFixed(3)}, 1.0, smoothstep(0.75, 1.0, cloudCover));
  cloudMask *= smoothstep(0.02, 0.22, dir.y) * opacity;

  // Clouds facing the sun catch its glow the same way the horizon under them does; the far side of
  // the sky gets no equivalent treatment here - an unlit cloud simply reads as its own base colour,
  // which is already what "not sunset-facing" should look like.
  vec3 litCloud = mix(cloudColor, twilightTint, sunSide * ${TWILIGHT_CLOUD_STRENGTH.toFixed(3)});

  vec3 color = mix(sky, litCloud, cloudMask);
  gl_FragColor = vec4(color, 1.0);
}
`;

/** How dark the heaviest rain cloud gets. */
const RAIN_CLOUD_GREY = 0.36;

/** Moves a colour `amount` of the way to a grey of `grey`, in place. */
function greyTowards(out: Color3, grey: number, amount: number): void {
  out.r = lerp(out.r, grey, amount);
  out.g = lerp(out.g, grey, amount);
  out.b = lerp(out.b, grey, amount);
}

/** Plain night->day cross-fade, no tint - what horizon and cloud need now that their sunrise/sunset
 *  tint has moved into the fragment shader (see its own sunFacing comment for why: that tint has to
 *  vary by compass direction, which a value computed once per frame on the CPU cannot do). Written
 *  into `out` in place rather than returned, so update() below doesn't allocate a fresh Color3 per
 *  channel per frame for a value nothing outside it keeps. */
function crossfade(out: Color3, night: Color3, day: Color3, dayness: number): void {
  out.r = lerp(night.r, day.r, dayness);
  out.g = lerp(night.g, day.g, dayness);
  out.b = lerp(night.b, day.b, dayness);
}

/** crossfade, then a tint mixed in on top - what zenith still uses (it stays direction-independent,
 *  see TWILIGHT_ZENITH_STRENGTH's own comment) and what scene fog needs (a single scalar colour has
 *  no notion of compass direction to be directional about, so it keeps the old uniform wash rather
 *  than losing sunset colouring altogether now that the sky dome's own horizon is directional). */
function blendChannel(out: Color3, night: Color3, day: Color3, dayness: number, tint: Color3, tintStrength: number): void {
  crossfade(out, night, day, dayness);
  out.r = lerp(out.r, tint.r, tintStrength);
  out.g = lerp(out.g, tint.g, tintStrength);
  out.b = lerp(out.b, tint.b, tintStrength);
}

export interface SkyDome {
  /** Recomputes the blended sky/fog colour and fog distances from whichever areas are in
   *  range of one point (the player's own, in practice) and the current time of day, and pushes
   *  them to the dome shader and the scene's fog - see BiomeAtmosphere.horizon for why colour is
   *  never set from two different sources, and BiomeAtmosphere.fogStartFraction for why this needs
   *  the current draw distance to turn into an actual distance - and fog-end likewise, from
   *  BiomeAtmosphere.fogEndFraction. timeHours drives the same day/night/twilight cross-fade sunLighting.ts's own
   *  lighting uses (see lighting/dayNightMath.ts) - the two are never computed independently, so
   *  the sky can never read as day while the ground reads as night. sunDirection (the same
   *  SunLighting.direction the terrain and shadows use) is what lets the sunrise/sunset glow sit on
   *  the correct side of the sky instead of as a uniform ring around the horizon. */
  update: (areaWeights: AreaWeight[], drawDistance: number, timeHours: number, sunDirection: Vector3, weather: WeatherBlend) => void;
  /** This frame's blended horizon/zenith colour - the same values sent to scene fog and the sky
   *  shader's own zenith uniform, exposed for anything else that wants to read "what colour is the
   *  sky right now" without recomputing the same blend (the ocean's fake sky reflection - see
   *  terrain/ocean.ts). Live references mutated in place by update(), same pattern as
   *  SunLighting.direction - read them fresh each frame rather than caching the object contents. */
  horizon: Color3;
  zenith: Color3;
  dispose: () => void;
}

/**
 * The sky: a huge inverted sphere fixed to the camera (Mesh.infiniteDistance), shaded by a
 * horizon/zenith gradient with a drifting 2D-noise cloud layer projected onto it - see the
 * fragment shader for how a flat cloud plane is read from a single ray direction with no actual
 * cloud geometry. Its colours are not fixed: update() blends them from whichever biomes are
 * nearby, the same weights the terrain material blends its ground textures by, so the sky and the
 * ground come from the same zone at the same rate as the player crosses a border.
 */
export function createSkyDome(scene: Scene): SkyDome {
  Effect.ShadersStore["skyDomeVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["skyDomeFragmentShader"] = FRAGMENT_SHADER;

  // BACKSIDE: the camera sits inside this sphere, so its inward-facing faces are the ones that
  // have to be drawn - the outward ones (an ordinary sphere's default) would just get culled away.
  const mesh = MeshBuilder.CreateSphere("skyDome", { diameter: SKY_RADIUS * 2, segments: 12, sideOrientation: Mesh.BACKSIDE }, scene);
  mesh.infiniteDistance = true;
  mesh.applyFog = false;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  // Renders first, depth-less - every ordinary opaque mesh drawn afterward simply paints over it
  // regardless of distance, without the dome ever competing for a place in the depth buffer.
  mesh.renderingGroupId = 0;

  const material = new ShaderMaterial("skyDomeMaterial", scene, "skyDome", {
    attributes: ["position"],
    uniforms: ["worldViewProjection", "skyZenith", "skyHorizon", "cloudColor", "cloudOffset", "cloudCover", "twilightTint", "twilightFactor", "sunDirection"],
  });
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.setColor3("skyZenith", new Color3(0.4, 0.6, 0.9));
  material.setColor3("skyHorizon", new Color3(0.7, 0.8, 0.85));
  material.setColor3("cloudColor", new Color3(1, 1, 1));
  material.setVector2("cloudOffset", Vector2.Zero());
  material.setFloat("cloudCover", FAIR_CLOUD_COVER);
  material.setColor3("twilightTint", new Color3(1, 0.6, 0.35));
  material.setFloat("twilightFactor", 0);
  material.setVector3("sunDirection", new Vector3(0, 1, 0));
  mesh.material = material;

  let windX = 0;
  let windZ = 0;
  // The weather's wind, as of the last update - a gale drives the clouds as it does the grass.
  let windStrength = 1;
  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    windX += CLOUD_WIND.x * CLOUD_FREQUENCY * dt * windStrength;
    windZ += CLOUD_WIND.z * CLOUD_FREQUENCY * dt * windStrength;
    material.setVector2("cloudOffset", new Vector2(windX, windZ));
  });

  // dayHorizon/dayZenith/dayCloud hold the ordinary zone blend. twilightTint is each in-range
  // biome's own sunHorizonColor (BiomeDayNight), blended the same way - reusing the sun's own low
  // colour as the sky's sunset wash rather than authoring a second warm palette that would have to
  // be kept in sync with it by hand.
  //
  // horizonBase/cloudBase hold only the night->day cross-fade, sent to the shader untinted - the
  // shader mixes in twilightTint itself, shaped by sunFacing (see its own comment), which a value
  // computed once per frame here on the CPU has no way to do. zenith keeps the old CPU-side tint
  // (it stays direction-independent - see TWILIGHT_ZENITH_STRENGTH), and fogColor gets its own
  // separately-tinted value for the same reason: scene fog is one scalar colour with no notion of
  // compass direction to vary by, so it keeps the uniform wash that used to be `horizon`'s job.
  const dayHorizon = new Color3();
  const dayZenith = new Color3();
  const dayCloud = new Color3();
  const twilightTint = new Color3();
  const horizonBase = new Color3();
  const zenith = new Color3();
  const cloudBase = new Color3();
  const fogColor = new Color3();

  function update(areaWeights: AreaWeight[], drawDistance: number, timeHours: number, sunDirection: Vector3, weather: WeatherBlend): void {
    dayHorizon.set(0, 0, 0);
    dayZenith.set(0, 0, 0);
    dayCloud.set(0, 0, 0);
    twilightTint.set(0, 0, 0);
    let fogStartFraction = 0;
    let fogEndFraction = 0;
    for (const { biome, weight } of areaWeights) {
      const a = biome.atmosphere;
      dayHorizon.r += a.horizon[0] * weight;
      dayHorizon.g += a.horizon[1] * weight;
      dayHorizon.b += a.horizon[2] * weight;
      dayZenith.r += a.zenith[0] * weight;
      dayZenith.g += a.zenith[1] * weight;
      dayZenith.b += a.zenith[2] * weight;
      dayCloud.r += a.cloud[0] * weight;
      dayCloud.g += a.cloud[1] * weight;
      dayCloud.b += a.cloud[2] * weight;
      fogStartFraction += a.fogStartFraction * weight;
      fogEndFraction += a.fogEndFraction * weight;
      const sunHorizon = biome.dayNight.sunHorizonColor;
      twilightTint.r += sunHorizon[0] * weight;
      twilightTint.g += sunHorizon[1] * weight;
      twilightTint.b += sunHorizon[2] * weight;
    }

    // The weather on the day colours, before night is derived from them - so an overcast night is
    // the overcast day's, dimmed: the sky washed out towards a grey as light as its horizon, darker
    // as the clouds are; the clouds themselves darkened towards rain-cloud grey; the fog pulled in.
    const grey = (0.299 * dayHorizon.r + 0.587 * dayHorizon.g + 0.114 * dayHorizon.b) * (1 - 0.3 * weather.cloudDarkness);
    greyTowards(dayHorizon, grey, weather.skyGrey);
    greyTowards(dayZenith, grey * 0.95, weather.skyGrey);
    greyTowards(dayCloud, lerp(grey, RAIN_CLOUD_GREY, weather.cloudDarkness), Math.max(weather.cloudDarkness, weather.skyGrey * 0.5));
    fogStartFraction *= weather.fog;
    fogEndFraction = Math.min(1, fogEndFraction * weather.fog);
    windStrength = weather.wind;
    material.setFloat("cloudCover", weather.cloudCover);

    const { dayness, twilightFactor } = computeDayNightFactors(timeHours);
    const nightHorizon = deriveNightSkyColor(dayHorizon);
    const nightZenith = deriveNightSkyColor(dayZenith);
    const nightCloud = deriveNightSkyColor(dayCloud);

    crossfade(horizonBase, nightHorizon, dayHorizon, dayness);
    crossfade(cloudBase, nightCloud, dayCloud, dayness);
    blendChannel(zenith, nightZenith, dayZenith, dayness, twilightTint, twilightFactor * TWILIGHT_ZENITH_STRENGTH);
    blendChannel(fogColor, nightHorizon, dayHorizon, dayness, twilightTint, twilightFactor * TWILIGHT_HORIZON_STRENGTH);

    material.setColor3("skyHorizon", horizonBase);
    material.setColor3("skyZenith", zenith);
    material.setColor3("cloudColor", cloudBase);
    material.setColor3("twilightTint", twilightTint);
    material.setFloat("twilightFactor", twilightFactor);
    material.setVector3("sunDirection", sunDirection);
    // A separately-tinted value, not skyHorizon - see this function's own opening comment for why
    // scene fog can't share the sky dome's now-directional horizon colour.
    scene.fogColor.copyFrom(fogColor);
    // Both ends off the draw distance, so fog always finishes inside what is loaded. The start never
    // past the end: a fogStart past fogEnd would read as "no fog at all" rather than the dense one
    // a low fraction is meant to buy.
    scene.fogEnd = drawDistance * fogEndFraction;
    scene.fogStart = Math.min(drawDistance * fogStartFraction, scene.fogEnd * 0.98);
  }

  function dispose(): void {
    mesh.dispose();
    material.dispose();
  }

  return { update, horizon: fogColor, zenith, dispose };
}
