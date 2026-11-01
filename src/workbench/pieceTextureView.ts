import type { BodyGeometry } from "../character/bodyMesh";
import type { GearDef } from "../character/gearDef";
import type { TextureImage } from "./textureView";

/** What the Atlas view can show of a body's textures: its skin atlas or its gear pieces' own textures. */
export interface AtlasParts {
  body: BodyGeometry;
  /** The skin atlas: pixels, size, where each corner of each triangle is in it, and which region a texel is in. */
  skin: { pixels: Uint8Array; size: number; uvs: Float32Array; regionAt: (x: number, y: number) => string };
  /** The gear, in the order of the body's piece textures' owners. */
  gear: GearDef[];
}

/** The skin atlas as an image, with the body's UV layout over it if asked. */
export function skinImage(parts: AtlasParts, overlay: boolean): TextureImage {
  const { skin, body } = parts;
  const pixels = skin.pixels.slice();
  if (overlay) {
    for (let t = 0; t < body.triangles; t++) {
      if (body.triangleRegions[t] < 0) continue;
      outline(pixels, skin.size, skin.size, (k) => [skin.uvs[(t * 3 + k) * 2] * skin.size, skin.uvs[(t * 3 + k) * 2 + 1] * skin.size]);
    }
  }
  return { width: skin.size, height: skin.size, pixels, tiles: 1, describe: (x, y) => `${x}, ${y} · ${skin.regionAt(x, y) || "empty"}` };
}

/**
 * The gear pieces' own textures side by side, each with its islands named, and - if asked - the UV
 * layout of the triangles drawn in it. Null if no piece has a texture of its own.
 */
export function pieceImage(parts: AtlasParts, overlay: boolean): { image: TextureImage; summary: string[] } | null {
  const { body } = parts;
  const textures = body.pieceTextures.filter((t) => t.pixels);
  if (textures.length === 0) return null;
  const GAP = 8;
  const width = textures.reduce((sum, t) => sum + t.size + GAP, -GAP);
  // Only as tall as the islands reach: a texture is a square with the pattern pieces at its top.
  const height = Math.max(...textures.map((t) => Math.max(...t.islands.map((p) => p.y + p.height))));
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = 30;
    pixels[i * 4 + 1] = 34;
    pixels[i * 4 + 2] = 42;
    pixels[i * 4 + 3] = 255;
  }
  const origins: number[] = [];
  let x0 = 0;
  const owners = parts.gear.filter((g) => g.texture);
  textures.forEach((texture, i) => {
    origins.push(x0);
    for (let y = 0; y < Math.min(texture.size, height); y++) pixels.set(texture.pixels!.subarray(y * texture.size * 4, (y + 1) * texture.size * 4), (y * width + x0) * 4);
    x0 += texture.size + GAP;
    void i;
  });
  if (overlay) {
    for (let t = 0; t < body.triangles; t++) {
      const texture = body.layers[body.triangleLayers[t]]?.texture;
      if (texture === undefined || !body.pieceTextures[texture]?.pixels) continue;
      const size = body.pieceTextures[texture].size;
      const at = textures.indexOf(body.pieceTextures[texture]);
      outline(pixels, width, height, (k) => [origins[at] + body.gearUVs[(t * 3 + k) * 2] * size, body.gearUVs[(t * 3 + k) * 2 + 1] * size]);
    }
    // Each island's margin, as the layout has it.
    textures.forEach((texture, i) => {
      for (const place of texture.islands) {
        const left = origins[i] + place.x;
        const lines: [number, number, number, number][] = [
          [left, place.y, left + place.width, place.y],
          [left + place.width, place.y, left + place.width, place.y + place.height],
          [left + place.width, place.y + place.height, left, place.y + place.height],
          [left, place.y + place.height, left, place.y],
        ];
        for (const [a, b, c, d] of lines) line(pixels, width, height, a, b, c, d, [90, 200, 255]);
      }
    });
  }
  const summary = textures.map((t, i) => `${owners[i]?.name ?? `Piece ${i + 1}`}: ${t.size}², ${t.islands.map((p) => `${p.name} ${p.widthMeters.toFixed(2)}×${p.heightMeters.toFixed(2)} m`).join(", ")}`);
  const image: TextureImage = {
    width,
    height,
    pixels,
    tiles: 1,
    describe: (x, y) => {
      const at = origins.findIndex((o, i) => x >= o && x < o + textures[i].size);
      if (at < 0) return `${x}, ${y}`;
      const lx = x - origins[at];
      const island = textures[at].islands.find((p) => lx >= p.x && lx < p.x + p.width && y >= p.y && y < p.y + p.height);
      return `${owners[at]?.name ?? `piece ${at + 1}`} · ${lx}, ${y}${island ? ` · ${island.name}` : ""}`;
    },
  };
  return { image, summary };
}

/** A triangle's outline: its three corners, as `corner(k)` gives them in texels. */
function outline(pixels: Uint8Array, width: number, height: number, corner: (k: number) => [number, number]): void {
  for (let k = 0; k < 3; k++) {
    const [a, b] = corner(k);
    const [c, d] = corner((k + 1) % 3);
    line(pixels, width, height, a, b, c, d, [255, 70, 70]);
  }
}

function line(pixels: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, color: [number, number, number]): void {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const o = (y * width + x) * 4;
    pixels[o] = color[0];
    pixels[o + 1] = color[1];
    pixels[o + 2] = color[2];
    pixels[o + 3] = 255;
  }
}
