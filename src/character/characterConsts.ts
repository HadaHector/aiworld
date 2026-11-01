// What the character code shares without reaching the content readers (raceDef.ts, gearDef.ts):
// small and pure, so a worker can import them.

export const SLIDERS = ["height", "build"] as const;
export type Slider = (typeof SLIDERS)[number];

export const SEXES = ["male", "female"] as const;
export type Sex = (typeof SEXES)[number];

/**
 * A painted hair style: how the plain cut's edges move. Heights are in the head's own measures
 * (`face`), 0 at the jaw's hinge and 1 at the crown.
 */
export interface HairStyle {
  id: string;
  name: string;
  /** Added to the race's hairline over the brow: up recedes, down is a fringe. */
  hairline: number;
  /** How far down the back of the head it reaches: 0.3 is the plain cut's, lower is longer. */
  nape: number;
  /** How much the hairline rises toward the temples. */
  temples: number;
  /** How much of the sides above the ears is shaved, 0 to 1. */
  shaved: number;
  /** How thick it is, 0 to 1: less is cropped close. */
  thickness: number;
}

/** The plain short cut: what a race with no styles paints. */
export const PLAIN_HAIR: HairStyle = { id: "short", name: "Short", hairline: 0, nape: 0.3, temples: 0.05, shaved: 0, thickness: 1 };

/** Expands a region or chain group ("arms") into the names it stands for. */
export function sided(name: string): string[] {
  const groups: Record<string, string[]> = { arms: ["armR", "armL"], hands: ["handR", "handL"], legs: ["legR", "legL"], feet: ["footR", "footL"] };
  return groups[name] ?? [name];
}
