import { deflateSync, inflateSync } from "node:zlib";

/**
 * A small PNG reader and writer, enough for icon art: 8 or 16 bit, any colour type, not interlaced
 * on read (Adam7 is refused); always 8-bit RGBA out. Images are { width, height, data } with data a
 * Uint8ClampedArray of RGBA. No dependency, so the icon script runs on a plain checkout.
 */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, depth = 8, type = 6, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (kind === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") trns = body;
    else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
  }
  if (interlace) throw new Error("interlaced PNG");
  if (depth !== 8 && depth !== 16) throw new Error(`unsupported bit depth ${depth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + x] = v & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const step = depth / 8;
  const sample = (i, ch) => px[i + ch * step];
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp;
    const o = i * 4;
    if (type === 6) {
      data[o] = sample(s, 0); data[o + 1] = sample(s, 1); data[o + 2] = sample(s, 2); data[o + 3] = sample(s, 3);
    } else if (type === 2) {
      data[o] = sample(s, 0); data[o + 1] = sample(s, 1); data[o + 2] = sample(s, 2); data[o + 3] = 255;
    } else if (type === 0) {
      data[o] = data[o + 1] = data[o + 2] = sample(s, 0); data[o + 3] = 255;
    } else if (type === 4) {
      data[o] = data[o + 1] = data[o + 2] = sample(s, 0); data[o + 3] = sample(s, 1);
    } else {
      const idx = px[s];
      data[o] = palette[idx * 3]; data[o + 1] = palette[idx * 3 + 1]; data[o + 2] = palette[idx * 3 + 2];
      data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, data };
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(kind, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(kind, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
