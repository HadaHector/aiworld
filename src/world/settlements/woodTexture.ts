import { mulberry32 } from "../rng";

export const WOOD_TEXTURE_SIZE = 256;
/** World units one texture repeat covers, both ways. */
export const WOOD_TEXTURE_WORLD_SIZE = 2;
/** Boards per texture repeat, so each board is WOOD_TEXTURE_WORLD_SIZE / this tall. */
const BOARDS = 8;

/**
 * Horizontal weatherboards: each board its own tone, a lengthwise grain, a dark seam between
 * boards and the odd butt joint along one. Kept close to neutral warm wood - a building's own
 * colour (bare, weathered, painted, roof) comes from its vertex colour multiplying this.
 */
export function bakeWoodTexture(seed: number): Uint8Array {
  const size = WOOD_TEXTURE_SIZE;
  const pixels = new Uint8Array(size * size * 4);
  const rng = mulberry32(seed);
  const boardHeight = size / BOARDS;

  const boards = Array.from({ length: BOARDS }, () => ({
    tone: 0.85 + rng() * 0.25,
    grainPhase: rng() * 100,
    grainScale: 0.02 + rng() * 0.03,
    joint: Math.floor(rng() * size),
  }));

  for (let y = 0; y < size; y++) {
    const board = boards[Math.floor(y / boardHeight)];
    const inBoard = (y % boardHeight) / boardHeight;
    for (let x = 0; x < size; x++) {
      const grain =
        0.5 +
        0.5 * Math.sin(x * board.grainScale + board.grainPhase + Math.sin(y * 0.9 + x * 0.013) * 1.4) * Math.sin(y * 0.35 + board.grainPhase);
      let shade = board.tone * (0.82 + 0.18 * grain);
      // Seam at the bottom of each board, and a slight darkening towards its lower edge where the
      // board above overlaps it.
      if (inBoard < 0.08) shade *= 0.45;
      else shade *= 0.92 + 0.08 * inBoard;
      if (Math.abs(x - board.joint) < 1.5) shade *= 0.55;
      const i = (y * size + x) * 4;
      pixels[i] = Math.min(255, Math.round(shade * 0.66 * 255));
      pixels[i + 1] = Math.min(255, Math.round(shade * 0.5 * 255));
      pixels[i + 2] = Math.min(255, Math.round(shade * 0.34 * 255));
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}
