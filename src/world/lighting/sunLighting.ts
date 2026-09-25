import { CascadedShadowGenerator, Color3, DirectionalLight, HemisphericLight, Vector3, type AbstractMesh, type Camera, type Scene } from "@babylonjs/core";
import type { AreaWeight } from "../cells/areaField";
import { lerp } from "../mathUtils";
import { computeDayNightFactors, SUNRISE_HOUR, SUNSET_HOUR } from "./dayNightMath";

/** How many slices the camera's view frustum is cut into, each rendered to its own shadow map
 *  layer at full resolution. More cascades buy sharper near shadows for the same total texel
 *  budget; four is the usual floor for a scene with any real draw distance. */
export const SHADOW_CASCADE_COUNT = 3;

/** Texels per cascade layer. Not measured yet - a first-pass number to look at and adjust once
 *  shadows are actually on screen, same as every other constant in this project. */
export const SHADOW_MAP_SIZE = 2048;

/** Blends between a uniform split (0, every cascade the same width) and a logarithmic one (1,
 *  width grows with distance, matching how perspective itself foreshortens distance). 0.5 is
 *  Babylon's own default for the generator and splits the near cascades tighter without starving
 *  the far ones the way a pure log split would - reproduced here (see computeCascadeSplits)
 *  because the terrain shader has to pick the same cascade the generator actually rendered into,
 *  and the two are only guaranteed to agree if both derive it from the same formula. */
const SHADOW_CASCADE_LAMBDA = 0.5;

// Shadows fade out at this distance rather than covering the whole possible draw distance
// (MAX_DRAW_DISTANCE is 2000): a cascade far enough out to reach that would be spending most of
// its texels on ground nobody is looking closely at, at the expense of the near cascades that
// matter. 900 comfortably clears DEFAULT_DRAW_DISTANCE (400) with room to grow into.
const SHADOW_NEAR_DISTANCE = 1;
const SHADOW_FAR_DISTANCE = 800;

/** Fraction of light a fully shadowed surface still receives. Zero would be a flat silhouette
 *  wherever the sun can't reach, which reads wrong next to a lit sky - the ambient light already
 *  in the scene is doing exactly this job for direct light, so shadows get the same floor. */
export const SHADOW_DARKNESS = 0.4;

/** How far into a cascade's own span (as a fraction, from its far edge inward) the blend toward
 *  the next cascade runs. Without this the cascade boundary is a visible seam - a jump in shadow
 *  map resolution - even though the actual shadow it draws is correct on both sides of it. */
export const SHADOW_CASCADE_BLEND = 0.2;

/** How many world units before the far cascade's own edge the shadow fades to fully lit, instead
 *  of switching off in one triangle. */
export const SHADOW_EDGE_FADE = 60;

/** How many shadow-map texels of normal-offset bias each cascade gets, scaled by that cascade's
 *  own span below - a cascade covering more ground has bigger texels, and a bias sized for the
 *  near cascade would be nowhere near enough to clear self-shadowing acne in the far one. */
const SHADOW_BIAS_TEXELS = 3;

// A full sunrise-to-sunrise cycle, in real minutes, by default - deliberately slow (the user's own
// call: "quite slow, like 4 hours") so a normal play session sees at most a slow drift rather than
// a strobing day. The settings-panel time-of-day slider (see main.ts) is what makes trying the rest
// of the cycle practical without actually waiting on this.
export const DEFAULT_DAY_NIGHT_CYCLE_MINUTES = 240;

const DEG2RAD = Math.PI / 180;

export interface SunLighting {
  /** Points TOWARD whichever body is currently lit - the sun by day, the moon by night. Same
   *  convention every material's diffuse term already used before shadows existed. Mutated in
   *  place by updateDayNight rather than reassigned, so anything holding this reference sees the
   *  current frame's value without having to re-fetch it. */
  direction: Vector3;
  /** Current light strength, 0 at the exact instant either body sits on the horizon. */
  intensity: number;
  /** Current light colour - warm near the horizon, its zenith colour once well clear of it by day;
   *  flat moonlight by night. Mutated in place, same as direction. */
  color: Color3;
  /** The sky-fill's current colour/strength, cross-faded between each in-range biome's day and
   *  night values by how far through the cycle it is - see updateDayNight. */
  ambientColor: Color3;
  ambientIntensity: number;
  shadowGenerator: CascadedShadowGenerator;
  /** The view-space Z distance at each cascade's far edge, in the same units and sense as
   *  DirectionalLight's shadow camera - the terrain shader picks a cascade the identical way,
   *  from the identical numbers, so the two can never disagree about which cascade covers a
   *  given fragment. */
  cascadeSplits: number[];
  /** Per-cascade normal-offset bias, in world units - see SHADOW_BIAS_TEXELS. */
  cascadeBias: number[];
  /** Camera near/far and the shadow generator's own frustum both depend on the real camera, which
   *  is created after the world is (see world.ts) - call this once it exists. */
  attachCamera: (camera: Camera) => void;
  setShadowsEnabled: (enabled: boolean) => void;
  /** Advances the clock by deltaSeconds (scaled by DEFAULT_DAY_NIGHT_CYCLE_MINUTES) and re-applies
   *  it - blending every in-range area's own day-night settings exactly the way atmosphere blends
   *  sky colours, so crossing a border fades lighting at the same rate it fades sky and fog. Meant
   *  to be called every frame, same as World.updateAtmosphere. */
  updateDayNight: (deltaSeconds: number, areaWeights: AreaWeight[]) => void;
  /** Jumps the clock straight to a given hour (0-24, wrapping) without waiting for it to get there
   *  - what the settings-panel time-of-day slider drives, so trying the far side of a 4-hour cycle
   *  doesn't mean actually waiting two hours. Re-applies immediately against the last area weights
   *  seen, so the scene updates the instant the slider moves rather than on the next frame's own
   *  areaWeights (which, mid-drag, may not come until the player next moves). */
  setTimeHours: (hours: number) => void;
  getTimeHours: () => number;
}

/**
 * The same closed-form split Babylon's own CascadedShadowGenerator computes internally (see
 * cascadedShadowGenerator's _splitFrustum) - reproduced here, against only its public
 * near/far/lambda inputs, so the terrain shader can select a cascade in agreement with the
 * generator without reaching into any of its private state to do it.
 */
function computeCascadeSplits(near: number, far: number, count: number, lambda: number): number[] {
  const splits: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = (i + 1) / count;
    const uniform = near + (far - near) * p;
    const log = near * (far / near) ** p;
    splits.push(lambda * (log - uniform) + uniform);
  }
  return splits;
}

const cornerScratch = new Vector3();

/**
 * Babylon draws every enabled caster into every cascade with no culling at all, so each of the
 * cascades redrew every loaded chunk - including all the ones behind the camera or far off to the
 * side. Measured at 800 draw distance, that was ~93% of all vertices drawn per frame.
 *
 * Each cascade's transform maps its own box to [-1, 1]: the slice of the camera's view it covers,
 * extended back along the light direction. A caster whose bounds fall entirely outside that box's
 * sides can't shadow anything in it, so it's skipped for that cascade. The near side (toward the
 * light) is deliberately not tested: the generator clamps depth there, so something between the
 * light and the box - a hill up-sun of the view - still casts into it and has to be drawn.
 *
 * Meshes that opt out of frustum culling (alwaysSelectAsActiveMesh - the tree masters, whose own
 * bounds cover one tree at the origin rather than their thousands of instances) are always kept.
 */
function cullCastersPerCascade(shadowGenerator: CascadedShadowGenerator): void {
  const shadowMap = shadowGenerator.getShadowMap();
  if (!shadowMap) return;
  const perCascade: AbstractMesh[][] = [];
  shadowMap.getCustomRenderList = (cascade, casters, casterCount) => {
    const transform = shadowGenerator.getCascadeTransformMatrix(cascade);
    if (!transform || !casters) return null;
    const kept = (perCascade[cascade] ??= []);
    kept.length = 0;
    for (let i = 0; i < casterCount; i++) {
      const mesh = casters[i] as AbstractMesh;
      if (mesh.alwaysSelectAsActiveMesh) {
        kept.push(mesh);
        continue;
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity;
      for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        Vector3.TransformCoordinatesToRef(corner, transform, cornerScratch);
        minX = Math.min(minX, cornerScratch.x);
        maxX = Math.max(maxX, cornerScratch.x);
        minY = Math.min(minY, cornerScratch.y);
        maxY = Math.max(maxY, cornerScratch.y);
        minZ = Math.min(minZ, cornerScratch.z);
      }
      if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1 || minZ > 1) continue;
      kept.push(mesh);
    }
    return kept;
  };
}

/**
 * The world's one sun-and-moon: a single DirectionalLight re-coloured, re-aimed and re-strengthened
 * across the day/night cycle rather than two separate lights swapped in and out - which is what
 * lets the same CascadedShadowGenerator keep casting shadows for both with no extra wiring, and
 * what makes "the sun shines by day, the moon by night" true by construction rather than a case
 * this module has to detect and branch on for shadows specifically.
 *
 * Every shaded material - terrain's own shader, and every StandardMaterial elsewhere (ocean, trees,
 * the player) - reads its direction/intensity/colour from this one object rather than each picking
 * its own, so the light in the sky and the shadows and colour on the ground can never disagree.
 */
export function createSunLighting(scene: Scene): SunLighting {
  // Placeholder daytime values - overwritten by the first updateDayNight call a frame or two later
  // (see world.ts), before anything is actually drawn. Kept non-degenerate (a real direction, a
  // real intensity) only so nothing reads a zero/garbage light in the brief window between a
  // material being built against these fields and the first real update.
  const direction = new Vector3(0.3, 1, 0.2).normalize();
  const color = new Color3(1, 1, 1);
  const ambientColor = new Color3(0.69, 0.77, 0.84);
  let intensity = 0.95;
  let ambientIntensity = 0.5;

  // Fill only - the directional light below is what actually reads as "the sun" (or "the moon")
  // and is the only one that casts a shadow. Without this, ground facing away from it would go to
  // black rather than the soft glow a lit sky actually leaves it at.
  //
  // direction is fixed straight up, NOT re-aimed at the sun/moon each frame like the directional
  // light below - a sky's ambient fill doesn't rotate with where the sun happens to be in it, only
  // its colour and strength do. Re-aiming this at a low sun/moon used to leave the ground reading
  // dim ambient "ground colour" at exactly the moments (dawn/dusk) it should be brightest.
  const ambient = new HemisphericLight("skyAmbient", Vector3.Up(), scene);
  ambient.intensity = ambientIntensity;
  ambient.diffuse.copyFrom(ambientColor);
  // HemisphericLight blends between `diffuse` (its sky colour, for a face pointed toward
  // `direction`) and `groundColor` (for one pointed away) - which defaults to BLACK. Terrain never
  // noticed, since every terrain face points roughly up, toward the sky half; a tree is full of
  // faces that don't (a frond's underside, the far side of a canopy), and every one of those was
  // reading pure black from this light regardless of its intensity - raising intensity alone can
  // never fix a colour that's black at both ends of the multiply. This is the actual fix the
  // "foliage undersides" backlog entry called for, in place of treeModels.ts's flat emissive fill.
  // A fixed fraction of the current ambient colour rather than its own fixed colour, so a face
  // pointed away from the sky dims and tints with everything else across the day/night cycle
  // instead of staying one colour while diffuse changes around it.
  ambientColor.scaleToRef(0.55, ambient.groundColor);

  // DirectionalLight.direction is the direction light TRAVELS, the opposite sense from `direction`
  // above (which every material reads as "toward the sun") - negated once, here, rather than
  // asking every caller to remember which convention it's using.
  const sun = new DirectionalLight("sun", direction.scale(-1), scene);
  sun.intensity = intensity;
  sun.diffuse.copyFrom(color);
  sun.specular.copyFrom(color);
  // A shadow-casting light needs a position to build its own view matrix from; direction is what
  // actually matters for a directional light, so this only has to be somewhere on the sun's side
  // of the world, not any particular distance.
  sun.position = direction.scale(500);

  const shadowGenerator = new CascadedShadowGenerator(SHADOW_MAP_SIZE, sun);
  shadowGenerator.numCascades = SHADOW_CASCADE_COUNT;
  shadowGenerator.lambda = SHADOW_CASCADE_LAMBDA;
  shadowGenerator.shadowMaxZ = SHADOW_FAR_DISTANCE;
  // Trades a little resolution for cascades that don't visibly resize/shimmer as the camera turns
  // - worth it here, since the cascade edges are close enough at this draw distance to be on
  // screen constantly rather than an occasional far-off artifact.
  shadowGenerator.stabilizeCascades = true;
  shadowGenerator.usePercentageCloserFiltering = true;
  // The same floor the terrain shader's own SHADOW_DARKNESS applies by hand - without it,
  // Babylon's default (0, fully black) would leave a shadowed tree pitch dark next to ground that
  // only ever dims to 40%.
  shadowGenerator.darkness = SHADOW_DARKNESS;
  // Babylon's own default normal bias is 0 - fine for a large flat ground mesh, less so for a
  // trunk standing directly under its own crown. Trees are the only StandardMaterial shadow
  // receivers in the scene, so this is tuned for their geometry, not the ground's - terrain has
  // its own separate, per-cascade bias (see materialLibrary.ts).
  shadowGenerator.bias = 0.002;
  shadowGenerator.normalBias = 0.3;
  cullCastersPerCascade(shadowGenerator);

  const cascadeSplits = computeCascadeSplits(SHADOW_NEAR_DISTANCE, SHADOW_FAR_DISTANCE, SHADOW_CASCADE_COUNT, SHADOW_CASCADE_LAMBDA);
  const cascadeBias = cascadeSplits.map((split, i) => {
    const span = split - (i > 0 ? cascadeSplits[i - 1] : SHADOW_NEAR_DISTANCE);
    return (span / SHADOW_MAP_SIZE) * SHADOW_BIAS_TEXELS;
  });

  function attachCamera(camera: Camera): void {
    // Matches the near/far this module's own split math assumes - see computeCascadeSplits.
    // Camera.maxZ only has to clear SHADOW_FAR_DISTANCE (shadowMaxZ above already caps the
    // generator's own reach there regardless of how much farther the camera can actually see), so
    // a generous draw distance past it is left alone rather than forced down to match.
    camera.minZ = SHADOW_NEAR_DISTANCE;
    if (camera.maxZ < SHADOW_FAR_DISTANCE) camera.maxZ = SHADOW_FAR_DISTANCE;
    shadowGenerator.splitFrustum();
  }

  function setShadowsEnabled(enabled: boolean): void {
    sun.shadowEnabled = enabled;
  }

  // 0-24, wrapping. Starts at noon - the most legible default to spawn into rather than an
  // arbitrary point mid-transition.
  let timeHours = 12;
  let lastAreaWeights: AreaWeight[] = [];

  // Scratch accumulators for applyTimeOfDay's blend - module-lifetime, not per-call, since this
  // runs every frame and a fresh Color3 per field per frame is pure garbage-collector pressure for
  // no benefit (nothing outside this function ever sees these).
  const blendAmbientDay = new Color3();
  const blendAmbientNight = new Color3();
  const blendSunHorizon = new Color3();
  const blendSunZenith = new Color3();
  const blendMoon = new Color3();

  function applyTimeOfDay(areaWeights: AreaWeight[]): void {
    if (areaWeights.length === 0) return;
    lastAreaWeights = areaWeights;

    let sunPeak = 0;
    let moonPeak = 0;
    let ambientDayIntensity = 0;
    let ambientNightIntensity = 0;
    let sunIntensityBlend = 0;
    let moonIntensityBlend = 0;
    blendAmbientDay.set(0, 0, 0);
    blendAmbientNight.set(0, 0, 0);
    blendSunHorizon.set(0, 0, 0);
    blendSunZenith.set(0, 0, 0);
    blendMoon.set(0, 0, 0);

    for (const { biome, weight } of areaWeights) {
      const d = biome.dayNight;
      sunPeak += d.sunPeakElevation * weight;
      moonPeak += d.moonPeakElevation * weight;
      ambientDayIntensity += d.ambientDayIntensity * weight;
      ambientNightIntensity += d.ambientNightIntensity * weight;
      sunIntensityBlend += d.sunIntensity * weight;
      moonIntensityBlend += d.moonIntensity * weight;
      blendAmbientDay.r += d.ambientDay[0] * weight;
      blendAmbientDay.g += d.ambientDay[1] * weight;
      blendAmbientDay.b += d.ambientDay[2] * weight;
      blendAmbientNight.r += d.ambientNight[0] * weight;
      blendAmbientNight.g += d.ambientNight[1] * weight;
      blendAmbientNight.b += d.ambientNight[2] * weight;
      blendSunHorizon.r += d.sunHorizonColor[0] * weight;
      blendSunHorizon.g += d.sunHorizonColor[1] * weight;
      blendSunHorizon.b += d.sunHorizonColor[2] * weight;
      blendSunZenith.r += d.sunZenithColor[0] * weight;
      blendSunZenith.g += d.sunZenithColor[1] * weight;
      blendSunZenith.b += d.sunZenithColor[2] * weight;
      blendMoon.r += d.moonColor[0] * weight;
      blendMoon.g += d.moonColor[1] * weight;
      blendMoon.b += d.moonColor[2] * weight;
    }

    // One sine over the full 24h, zero at both SUNRISE_HOUR and SUNSET_HOUR, positive between them
    // (day) and negative outside (night) - both bodies' elevation and the ambient day/night
    // cross-fade all derive from this single shared signal (see dayNightMath.ts), which is what
    // guarantees they cross zero/0.5 at exactly the same instant as skyDome.ts's own sky/fog
    // cross-fade rather than three independent formulas that could drift out of step with it.
    const { isDay, elevationFactor, dayness } = computeDayNightFactors(timeHours);

    // Hours since ITS OWN rise (0 at rise, half the arc at its own peak, the full arc at its own
    // set) - day and night need their own version of this because they don't share a rise hour, so
    // a single continuous formula (the way `raw` above works for elevation) can't cover both.
    const bodyLocalHours = isDay ? timeHours - SUNRISE_HOUR : (((timeHours - SUNSET_HOUR) % 24) + 24) % 24;
    const peakElevation = isDay ? sunPeak : moonPeak;
    const elevationDeg = elevationFactor * peakElevation;
    // Sweeps -90 (rise, due one side) through 0 (its own peak moment, overhead-ish) to +90 (set,
    // due the other side) - the same shape for both bodies, just walked by each one's own
    // bodyLocalHours over its own 12-hour arc.
    const azimuthDeg = 15 * bodyLocalHours - 90;

    const elevationRad = elevationDeg * DEG2RAD;
    const azimuthRad = azimuthDeg * DEG2RAD;
    const horizontal = Math.cos(elevationRad);
    // Already unit length by construction (a spherical-to-Cartesian conversion), so no normalize
    // needed - direction is mutated in place, not reassigned, so SunLighting.direction stays the
    // same object every caller already holds a reference to.
    direction.set(horizontal * Math.cos(azimuthRad), Math.sin(elevationRad), horizontal * Math.sin(azimuthRad));

    if (isDay) {
      // The one place colour genuinely varies across the day rather than just fading in and out -
      // warm and low near the horizon, its full daylight colour once well clear of it.
      color.r = lerp(blendSunHorizon.r, blendSunZenith.r, elevationFactor);
      color.g = lerp(blendSunHorizon.g, blendSunZenith.g, elevationFactor);
      color.b = lerp(blendSunHorizon.b, blendSunZenith.b, elevationFactor);
    } else {
      color.copyFrom(blendMoon);
    }
    // Zero at the instant either body sits exactly on the horizon - not a separate fade the code
    // has to arrange, just what elevationFactor already is at that instant.
    intensity = elevationFactor * (isDay ? sunIntensityBlend : moonIntensityBlend);

    // Ambient doesn't switch bodies the way direct light does - it cross-fades smoothly through
    // both twilights using the same raw signal, so the sky stays lit (dimly) through the moment
    // direct light itself is at its own zero.
    ambientColor.r = lerp(blendAmbientNight.r, blendAmbientDay.r, dayness);
    ambientColor.g = lerp(blendAmbientNight.g, blendAmbientDay.g, dayness);
    ambientColor.b = lerp(blendAmbientNight.b, blendAmbientDay.b, dayness);
    ambientIntensity = lerp(ambientNightIntensity, ambientDayIntensity, dayness);

    ambient.diffuse.copyFrom(ambientColor);
    ambient.intensity = ambientIntensity;
    ambientColor.scaleToRef(0.55, ambient.groundColor);

    sun.diffuse.copyFrom(color);
    sun.specular.copyFrom(color);
    sun.intensity = intensity;
    sun.direction.set(-direction.x, -direction.y, -direction.z);
    sun.position.set(direction.x * 500, direction.y * 500, direction.z * 500);
  }

  function updateDayNight(deltaSeconds: number, areaWeights: AreaWeight[]): void {
    const cycleSeconds = DEFAULT_DAY_NIGHT_CYCLE_MINUTES * 60;
    timeHours = (timeHours + (deltaSeconds / cycleSeconds) * 24) % 24;
    applyTimeOfDay(areaWeights);
  }

  function setTimeHours(hours: number): void {
    timeHours = ((hours % 24) + 24) % 24;
    // Re-applies against whatever areas were last seen rather than waiting for the next real
    // update - the slider should show its effect the instant it moves, not on the player's next
    // frame of movement (areaWeights only otherwise arrives via updateDayNight's own caller).
    applyTimeOfDay(lastAreaWeights);
  }

  function getTimeHours(): number {
    return timeHours;
  }

  return {
    direction,
    get intensity() {
      return intensity;
    },
    color,
    ambientColor,
    get ambientIntensity() {
      return ambientIntensity;
    },
    shadowGenerator,
    cascadeSplits,
    cascadeBias,
    attachCamera,
    setShadowsEnabled,
    updateDayNight,
    setTimeHours,
    getTimeHours,
  };
}
