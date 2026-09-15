import { Color3, type FloatArray } from "@babylonjs/core";

const SAND = new Color3(0.76, 0.7, 0.5);
const GRASS = new Color3(0.33, 0.52, 0.25);
const ROCK = new Color3(0.45, 0.42, 0.4);
const SNOW = new Color3(0.95, 0.95, 0.97);

const SAND_HEIGHT = -1;
const GRASS_HEIGHT = 1.7;
const ROCK_HEIGHT = 4.5;
const SNOW_HEIGHT = 7;
const SLOPE_ROCK_THRESHOLD = 0.75; // normal.y below this is treated as a steep slope

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerpColor(a: Color3, b: Color3, t: number): Color3 {
  return Color3.Lerp(a, b, t);
}

/** Bands a color by height, then blends toward rock on steep slopes. */
function colorForVertex(height: number, normalY: number): Color3 {
  let color: Color3;
  if (height < SAND_HEIGHT) {
    color = SAND;
  } else if (height < GRASS_HEIGHT) {
    color = lerpColor(SAND, GRASS, smoothstep(SAND_HEIGHT, GRASS_HEIGHT, height));
  } else if (height < ROCK_HEIGHT) {
    color = lerpColor(GRASS, ROCK, smoothstep(GRASS_HEIGHT, ROCK_HEIGHT, height));
  } else if (height < SNOW_HEIGHT) {
    color = lerpColor(ROCK, SNOW, smoothstep(ROCK_HEIGHT, SNOW_HEIGHT, height));
  } else {
    color = SNOW;
  }

  if (normalY < SLOPE_ROCK_THRESHOLD) {
    const slopeT = smoothstep(SLOPE_ROCK_THRESHOLD, 0.3, normalY);
    color = lerpColor(color, ROCK, slopeT);
  }

  return color;
}

/** Computes an RGBA vertex-color buffer (flat array) from position/normal buffers. */
export function computeVertexColors(positions: FloatArray, normals: FloatArray): number[] {
  const colors: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const height = positions[i + 1];
    const normalY = normals[i + 1];
    const color = colorForVertex(height, normalY);
    colors.push(color.r, color.g, color.b, 1);
  }
  return colors;
}
