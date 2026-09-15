import type { Color3 } from "@babylonjs/core";

/** Reserved for future differentiated border generation; only "smooth" is generated today. */
export type BorderType = "smooth" | "mountain" | "river" | "cliff" | "wall";

export interface BiomeColorBands {
  color0: Color3;
  height0: number;
  color1: Color3;
  height1: number;
  color2: Color3;
  height2: number;
  color3: Color3;
  height3: number;
  slopeThreshold: number; // normalY below this blends toward slopeColor
  slopeColor: Color3;
}

export interface BiomeHeightParams {
  baseElevation: number;
  amplitudeScale: number;
  frequencyScale: number;
  persistence?: number;
  octaves?: number;
}

export interface BiomeDefinition {
  id: string;
  name: string;
  colors: BiomeColorBands;
  height: BiomeHeightParams;
  /** A per-biome declared preference, not yet branched on — all generation is smooth-blended this milestone. */
  borderType: BorderType;
  spawnWeight: number;
  /** Reserved extension point for future prop scattering; unused today. */
  propDensity?: number;
}
