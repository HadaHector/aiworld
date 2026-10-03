import { Vector2 } from "@babylonjs/core";

/** Which way the wind blows (x, z), at strength 1. */
const WIND_HEADING = new Vector2(0.8, 0.6).normalize();

/**
 * The wind every swaying thing reads: the grass and the leaves are handed this one vector, and a
 * shader material keeps the vector it is given rather than a copy - so scaling it here (the weather's
 * wind, see setWindStrength) moves every meadow and every crown at once. Its length is the strength:
 * 1 is the breeze the sway was tuned for.
 */
export const WIND = WIND_HEADING.clone();

/** Sets how hard the wind blows, 1 being the plain breeze. */
export function setWindStrength(strength: number): void {
  WIND.copyFrom(WIND_HEADING).scaleInPlace(strength);
}
