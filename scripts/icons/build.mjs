// Builds the icons-craftpix pack from the four free Craftpix icon zips: one atlas, one index.
//
//   node scripts/icons/build.mjs [--src assets_work] [--out public/packs/icons-craftpix] [--size 64] [--sheet contact.png]
//
// The zips are read in memory (scripts/icons/zip.mjs), never unpacked to disk. See the pack's
// README.md for what comes out and the licence note.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodePng, encodePng } from "./png.mjs";
import { readZip } from "./zip.mjs";
import { SETS } from "./catalogue.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const src = resolve(option("src", "assets_work"));
const out = resolve(option("out", "public/packs/icons-craftpix"));
const SIZE = Number(option("size", "64"));
const COLUMNS = 16;
/** Painted icons are fitted inside the cell less this much on every side. */
const PAD = Math.round(SIZE / 16);

/** Scales by a whole number, each pixel a square of pixels: pixel art stays crisp. */
function nearest(img, scale) {
  const data = new Uint8ClampedArray(img.width * scale * img.height * scale * 4);
  const w = img.width * scale;
  for (let y = 0; y < img.height * scale; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 4;
      data.set(img.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: img.height * scale, data };
}

/** Scales to a size by area averaging in premultiplied colour (a box filter, exact for the 8-9x
 *  reductions here, and free of the halos a plain average leaves at a transparent edge). */
function area(img, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0, weight = 0;
      const x0 = x * sx, x1 = (x + 1) * sx, y0 = y * sy, y1 = (y + 1) * sy;
      for (let j = Math.floor(y0); j < Math.min(img.height, Math.ceil(y1)); j++) {
        const wy = Math.min(j + 1, y1) - Math.max(j, y0);
        for (let i = Math.floor(x0); i < Math.min(img.width, Math.ceil(x1)); i++) {
          const w = wy * (Math.min(i + 1, x1) - Math.max(i, x0));
          const p = (j * img.width + i) * 4;
          const alpha = img.data[p + 3] / 255;
          r += img.data[p] * alpha * w;
          g += img.data[p + 1] * alpha * w;
          b += img.data[p + 2] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        data[o] = r / a;
        data[o + 1] = g / a;
        data[o + 2] = b / a;
      }
      data[o + 3] = (a / weight) * 255;
    }
  }
  return { width, height, data };
}

/** The part of an image that is not (nearly) transparent. */
function bounds(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] <= 8) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? { x: 0, y: 0, width: img.width, height: img.height } : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function crop(img, { x, y, width, height }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) data.set(img.data.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + width) * 4), j * width * 4);
  return { width, height, data };
}

/** One source picture as a SIZE x SIZE cell. */
function cell(img, mode) {
  if (mode === "pixel") {
    if (SIZE % img.width !== 0) throw new Error(`a ${img.width}px icon does not scale to ${SIZE} by a whole number`);
    return nearest(img, SIZE / img.width);
  }
  if (mode === "tile") return area(img, SIZE, SIZE);
  const part = crop(img, bounds(img));
  const fit = (SIZE - 2 * PAD) / Math.max(part.width, part.height);
  const small = area(part, Math.max(1, Math.round(part.width * fit)), Math.max(1, Math.round(part.height * fit)));
  const out = { width: SIZE, height: SIZE, data: new Uint8ClampedArray(SIZE * SIZE * 4) };
  const ox = Math.floor((SIZE - small.width) / 2), oy = Math.floor((SIZE - small.height) / 2);
  for (let y = 0; y < small.height; y++) out.data.set(small.data.subarray(y * small.width * 4, (y + 1) * small.width * 4), ((oy + y) * SIZE + ox) * 4);
  return out;
}

// --- read the zips ---
const zips = readdirSync(src).filter((f) => f.toLowerCase().endsWith(".zip"));
const icons = [];
for (const set of SETS) {
  const zip = zips.find((f) => set.zip.test(f));
  if (!zip) throw new Error(`no zip for the ${set.id} icons in ${src} (looked for a file name matching ${set.zip})`);
  const entries = readZip(join(src, zip));
  const found = [];
  for (const [name, read] of entries) {
    if (name.startsWith("__MACOSX/")) continue;
    const m = set.find.exec(name);
    if (m) found.push({ index: set.order(m), name, read });
  }
  found.sort((a, b) => a.index - b.index);
  if (found.length !== set.names.length || found.some((f, i) => f.index !== i)) {
    throw new Error(`${zip}: found ${found.length} ${set.id} icons, the catalogue names ${set.names.length}: update scripts/icons/catalogue.mjs`);
  }
  found.forEach((f, i) => icons.push({ name: set.names[i], set: set.id, image: cell(decodePng(f.read()), set.mode) }));
  console.log(`${set.id}: ${found.length} icons from ${zip}`);
}
const seen = new Set();
for (const { name } of icons) {
  if (seen.has(name)) throw new Error(`the icon name ${name} is used twice`);
  seen.add(name);
}

// --- the atlas and its index ---
const rows = Math.ceil(icons.length / COLUMNS);
const atlas = { width: COLUMNS * SIZE, height: rows * SIZE, data: new Uint8ClampedArray(COLUMNS * SIZE * rows * SIZE * 4) };
icons.forEach(({ image }, n) => {
  const ox = (n % COLUMNS) * SIZE, oy = Math.floor(n / COLUMNS) * SIZE;
  for (let y = 0; y < SIZE; y++) atlas.data.set(image.data.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), ((oy + y) * atlas.width + ox) * 4);
});
mkdirSync(join(out, "icons"), { recursive: true });
writeFileSync(join(out, "icons", "craftpix.png"), encodePng(atlas));
const lines = [];
let last = "";
icons.forEach(({ name, set }, n) => {
  if (set !== last) lines.push(`    // ${set}`);
  last = set;
  lines.push(`    ${JSON.stringify(name)}: [${n % COLUMNS}, ${Math.floor(n / COLUMNS)}],`);
});
writeFileSync(
  join(out, "icons", "craftpix.json5"),
  `// Generated by scripts/icons/build.mjs - do not edit; change scripts/icons/catalogue.mjs and rebuild.\n` +
    `// An icon set (see the pack README): its atlas, the size of a cell, and each icon's [column, row].\n` +
    `{\n  atlas: "craftpix.png",\n  size: ${SIZE},\n  columns: ${COLUMNS},\n  rows: ${rows},\n  icons: {\n${lines.join("\n")}\n  },\n}\n`,
);
const sheet = option("sheet", "");
if (sheet) {
  // The atlas over a dark backdrop, for looking at.
  const view = { width: atlas.width, height: atlas.height, data: new Uint8ClampedArray(atlas.data.length) };
  for (let i = 0; i < atlas.width * atlas.height; i++) {
    const bg = ((i % atlas.width >> 3) + (Math.floor(i / atlas.width) >> 3)) & 1 ? 34 : 44;
    const a = atlas.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) view.data[i * 4 + c] = atlas.data[i * 4 + c] * a + bg * (1 - a);
    view.data[i * 4 + 3] = 255;
  }
  writeFileSync(resolve(sheet), encodePng(view));
}
console.log(`${icons.length} icons in a ${atlas.width}x${atlas.height} atlas -> ${out}`);
