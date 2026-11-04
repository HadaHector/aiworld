// Image helpers for the icon builds: RGBA images are { width, height, data } (see png.mjs).

/** Scales by a whole number, each pixel a square of pixels: pixel art stays crisp. */
export function nearest(img, scale) {
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
export function area(img, width, height) {
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
export function bounds(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] <= 8) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? { x: 0, y: 0, width: img.width, height: img.height } : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function crop(img, { x, y, width, height }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) data.set(img.data.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + width) * 4), j * width * 4);
  return { width, height, data };
}

/** Crops an image to its content, scales it down to fit inside a size x size cell less `pad` on every
 *  side, and centres it: the fill rule every painted icon gets, so icons of any source fill alike. */
export function fitInto(img, size, pad) {
  const part = crop(img, bounds(img));
  const fit = (size - 2 * pad) / Math.max(part.width, part.height);
  const small = area(part, Math.max(1, Math.round(part.width * fit)), Math.max(1, Math.round(part.height * fit)));
  const out = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
  const ox = Math.floor((size - small.width) / 2), oy = Math.floor((size - small.height) / 2);
  for (let y = 0; y < small.height; y++) out.data.set(small.data.subarray(y * small.width * 4, (y + 1) * small.width * 4), ((oy + y) * size + ox) * 4);
  return out;
}
