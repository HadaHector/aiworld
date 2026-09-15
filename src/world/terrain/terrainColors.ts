import { Color3, type FloatArray } from "@babylonjs/core";
import { smoothstep } from "../mathUtils";
import type { BiomeColorBands } from "../biomes/biomeTypes";
import type { TerrainSample } from "./terrainSampler";

const OCEAN_FLOOR_COLOR = new Color3(0.18, 0.22, 0.28);

function lerpColor(a: Color3, b: Color3, t: number): Color3 {
  return Color3.Lerp(a, b, t);
}

/** Bands a color by height within one biome's palette, then blends toward rock on steep slopes. */
function colorForBands(height: number, normalY: number, bands: BiomeColorBands): Color3 {
  let color: Color3;
  if (height < bands.height0) {
    color = bands.color0;
  } else if (height < bands.height1) {
    color = lerpColor(bands.color0, bands.color1, smoothstep(bands.height0, bands.height1, height));
  } else if (height < bands.height2) {
    color = lerpColor(bands.color1, bands.color2, smoothstep(bands.height1, bands.height2, height));
  } else if (height < bands.height3) {
    color = lerpColor(bands.color2, bands.color3, smoothstep(bands.height2, bands.height3, height));
  } else {
    color = bands.color3;
  }

  if (normalY < bands.slopeThreshold) {
    const slopeT = smoothstep(bands.slopeThreshold, 0.3, normalY);
    color = lerpColor(color, bands.slopeColor, slopeT);
  }

  return color;
}

/** Computes an RGBA vertex-color buffer (flat array) from position/normal buffers and resolved terrain samples. */
export function computeVertexColors(positions: FloatArray, normals: FloatArray, samples: TerrainSample[]): number[] {
  const colors: number[] = [];

  for (let i = 0; i < positions.length; i += 3) {
    const height = positions[i + 1];
    const normalY = normals[i + 1];
    const sample = samples[i / 3];

    let color = colorForBands(height, normalY, sample.primaryBiome.colors);
    if (sample.biomeBlend > 0) {
      const secondaryColor = colorForBands(height, normalY, sample.secondaryBiome.colors);
      color = lerpColor(color, secondaryColor, sample.biomeBlend);
    }

    const oceanTint = 1 - smoothstep(-0.3, 0.05, sample.landmass);
    if (oceanTint > 0) {
      color = lerpColor(color, OCEAN_FLOOR_COLOR, oceanTint);
    }

    colors.push(color.r, color.g, color.b, 1);
  }

  return colors;
}
