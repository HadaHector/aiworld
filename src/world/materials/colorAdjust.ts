import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";

/**
 * A recolouring of a material's baked texture, applied in the terrain shader rather than baked - so
 * any number of materials can share one bake and still read as different ground: a paler meadow, a
 * redder sand, a greyer tundra.
 *
 * Applied in this order: `hue` turns every colour around the grey axis (degrees), `saturation`
 * scales how far it stands from grey (0 = grey, 1 = unchanged), `value` scales its brightness, and
 * `tint` multiplies it channel by channel. The steps are the CSS `hue-rotate` and `saturate`
 * filters, a scale and a multiply - all linear, so together they are one 3×3 matrix (adjustMatrix).
 * That linearity is also what keeps a material's average colour exact without looking at its
 * pixels again: the average of the adjusted texture is the adjusted average.
 */
export interface ColorAdjust {
  hue: number;
  saturation: number;
  value: number;
  tint: ColorTuple;
}

export const NO_ADJUST: ColorAdjust = { hue: 0, saturation: 1, value: 1, tint: [1, 1, 1] };

/** 3×3, row-major: output channel r is row 0 dotted with the input colour. */
export type ColorMatrix = [number, number, number, number, number, number, number, number, number];

function multiply(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  const out = new Array<number>(9) as ColorMatrix;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return out;
}

export function adjustMatrix(adjust: ColorAdjust): ColorMatrix {
  const angle = (adjust.hue * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // The W3C filter-effects matrices, around the luminance weights 0.213 / 0.715 / 0.072.
  const hue: ColorMatrix = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  const k = adjust.saturation;
  const saturation: ColorMatrix = [
    0.213 + 0.787 * k, 0.715 - 0.715 * k, 0.072 - 0.072 * k,
    0.213 - 0.213 * k, 0.715 + 0.285 * k, 0.072 - 0.072 * k,
    0.213 - 0.213 * k, 0.715 - 0.715 * k, 0.072 + 0.928 * k,
  ];
  const [r, g, b] = adjust.tint;
  const v = adjust.value;
  const scale: ColorMatrix = [r * v, 0, 0, 0, g * v, 0, 0, 0, b * v];
  return multiply(scale, multiply(saturation, hue));
}

/** A colour through the matrix, kept at or above 0 - an over-saturated colour can dip below, and
 *  the shader clamps it the same way. */
export function applyColorMatrix(m: ColorMatrix, [r, g, b]: ColorTuple): ColorTuple {
  return [
    Math.max(0, m[0] * r + m[1] * g + m[2] * b),
    Math.max(0, m[3] * r + m[4] * g + m[5] * b),
    Math.max(0, m[6] * r + m[7] * g + m[8] * b),
  ];
}

export function isNoAdjust(adjust: ColorAdjust): boolean {
  return adjust.hue === 0 && adjust.saturation === 1 && adjust.value === 1 && adjust.tint.every((channel) => channel === 1);
}

/** Several adjustments one after the other, as one matrix. */
export function chainMatrix(adjusts: readonly ColorAdjust[]): ColorMatrix {
  let matrix: ColorMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const adjust of adjusts) matrix = multiply(adjustMatrix(adjust), matrix);
  return matrix;
}

/** How a material is drawn: its own adjustment, then its area's (MaterialDef.areaAdjusts) on top. */
export function materialMatrix(def: { adjust: ColorAdjust; areaAdjusts?: readonly ColorAdjust[] }): ColorMatrix {
  return chainMatrix([def.adjust, ...(def.areaAdjusts ?? [])]);
}
