import { SSAO2RenderingPipeline, type Camera, type Scene } from "@babylonjs/core";

/** The player's ambient-occlusion options (the options window, game/dimensionView.ts). */
export interface AmbientOcclusionSettings {
  enabled: boolean;
  /** How dark the creases get: 0 none, 1 the pipeline's own default look, up to 3 heavy. */
  strength: number;
  /** How far from a crease the darkening reaches, in metres. */
  radius: number;
}

export const DEFAULT_AMBIENT_OCCLUSION: AmbientOcclusionSettings = { enabled: true, strength: 1.5, radius: 2.5 };

export const AO_STRENGTH_RANGE = { min: 0, max: 3, step: 0.1 };
export const AO_RADIUS_RANGE = { min: 0.5, max: 8, step: 0.5 };

export interface AmbientOcclusion {
  /** Switches it on or off; off, the pipeline and its geometry pass are gone, costing nothing. */
  setEnabled: (on: boolean) => void;
  setStrength: (strength: number) => void;
  setRadius: (radius: number) => void;
  dispose: () => void;
}

/**
 * Screen-space ambient occlusion (Babylon's SSAO2): darkens creases and where things meet the ground,
 * which the sun alone leaves flat. It reads depth and normals from a geometry pass over the scene,
 * so it costs a pass and two post-processes per frame - hence the switch. Built for every camera the
 * view can look through (the player's and the spectator's).
 */
export function createAmbientOcclusion(scene: Scene, cameras: Camera[], initial: AmbientOcclusionSettings): AmbientOcclusion {
  let settings = { ...initial };
  let pipeline: SSAO2RenderingPipeline | null = null;

  function apply(): void {
    if (!pipeline) return;
    pipeline.totalStrength = settings.strength;
    pipeline.radius = settings.radius;
  }

  function build(): void {
    // Half-size occlusion, blurred at half size too: the blur hides the lost resolution.
    // forceGeometryBuffer: the older geometry pass draws every mesh with a generic depth-and-normal
    // shader. The default prepass only takes standard and PBR materials, leaving out the terrain,
    // trees and grass, whose materials are custom shaders.
    pipeline = new SSAO2RenderingPipeline("ambientOcclusion", scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, cameras, true);
    pipeline.samples = 16;
    pipeline.expensiveBlur = true;
    apply();
  }

  function destroy(): void {
    pipeline?.dispose();
    pipeline = null;
  }

  if (settings.enabled) build();

  return {
    setEnabled(on) {
      settings.enabled = on;
      if (on && !pipeline) build();
      else if (!on && pipeline) destroy();
    },
    setStrength(strength) {
      settings.strength = strength;
      apply();
    },
    setRadius(radius) {
      settings.radius = radius;
      apply();
    },
    dispose: destroy,
  };
}
