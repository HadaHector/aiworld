import { CascadedShadowGenerator, Color3, DirectionalLight, HemisphericLight, Vector3, type Camera, type Scene } from "@babylonjs/core";

/** How many slices the camera's view frustum is cut into, each rendered to its own shadow map
 *  layer at full resolution. More cascades buy sharper near shadows for the same total texel
 *  budget; four is the usual floor for a scene with any real draw distance. */
export const SHADOW_CASCADE_COUNT = 4;

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
const SHADOW_FAR_DISTANCE = 900;

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

export interface SunLighting {
  /** Points TOWARD the sun - the convention every material's diffuse term already used before
   *  shadows existed, kept unchanged so this is a drop-in replacement rather than a re-tune. */
  direction: Vector3;
  intensity: number;
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

/**
 * The world's one sun: a directional light casting cascaded shadows, plus a dim sky ambient so a
 * face turned away from it isn't pure black. Every shaded material - terrain's own shader, and
 * every StandardMaterial elsewhere (ocean, trees, the player) - reads its direction and intensity
 * from `direction`/`intensity` here rather than each picking its own, so the sun in the sky and
 * the shadows on the ground can never disagree about where the light is coming from.
 */
export function createSunLighting(scene: Scene): SunLighting {
  const direction = new Vector3(0.3, 1, 0.2).normalize();
  const intensity = 0.95;

  // Fill only - the directional light below is what actually reads as "the sun" and is the only
  // one that casts a shadow. Without this, ground facing away from the sun would go to black
  // rather than the soft grey a lit sky actually leaves it at.
  const ambient = new HemisphericLight("skyAmbient", direction, scene);
  ambient.intensity = 0.5;
  // HemisphericLight blends between `diffuse` (its sky colour, for a face pointed toward
  // `direction`) and `groundColor` (for one pointed away) - which defaults to BLACK. Terrain never
  // noticed, since every terrain face points roughly up, toward the sky half; a tree is full of
  // faces that don't (a frond's underside, the far side of a canopy), and every one of those was
  // reading pure black from this light regardless of its intensity - raising intensity alone can
  // never fix a colour that's black at both ends of the multiply. This is the actual fix the
  // "foliage undersides" backlog entry called for, in place of treeModels.ts's flat emissive fill.
  ambient.groundColor = new Color3(0.3, 0.32, 0.28);

  // DirectionalLight.direction is the direction light TRAVELS, the opposite sense from `direction`
  // above (which every material reads as "toward the sun") - negated once, here, rather than
  // asking every caller to remember which convention it's using.
  const sun = new DirectionalLight("sun", direction.scale(-1), scene);
  sun.intensity = intensity;
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

  return { direction, intensity, shadowGenerator, cascadeSplits, cascadeBias, attachCamera, setShadowsEnabled };
}
