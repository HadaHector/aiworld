import { mulberry32 } from "../rng";
import type { WallTexture } from "./settlementConfig";

export const WALL_TEXTURE_SIZE = 256;
/** World units one texture repeat covers, both ways. */
export const WALL_TEXTURE_WORLD_SIZE = 2;

/** Bakes a settlement style's wall texture (see WallTexture). */
export function bakeWallTexture(seed: number, texture: WallTexture): Uint8Array {
  switch (texture.builder) {
    case "weatherboard":
      return bakeWeatherboard(seed, texture);
  }
}

/**
 * Horizontal weatherboards: each board its own tone, a lengthwise grain, a dark seam between
 * boards and the odd butt joint along one. Kept close to neutral - a building's own colour (bare,
 * weathered, painted, roof) comes from its vertex colour multiplying this.
 */
function bakeWeatherboard(seed: number, texture: WallTexture): Uint8Array {
  const size = WALL_TEXTURE_SIZE;
  const pixels = new Uint8Array(size * size * 4);
  const rng = mulberry32(seed);
  const boardCount = texture.boards;
  const boardHeight = size / boardCount;
  const [red, green, blue] = texture.color;

  const boards = Array.from({ length: boardCount }, () => ({
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
      pixels[i] = Math.min(255, Math.round(shade * red * 255));
      pixels[i + 1] = Math.min(255, Math.round(shade * green * 255));
      pixels[i + 2] = Math.min(255, Math.round(shade * blue * 255));
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}
