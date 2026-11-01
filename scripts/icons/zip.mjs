import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/** The biggest entry `readZip` will inflate: icon art is far below this, and a zip is untrusted. */
const MAX_ENTRY = 32 * 1024 * 1024;

/**
 * Reads a .zip into memory: a Map from entry name to a function that inflates it on demand. Nothing
 * is written to disk and no entry's name is ever used as a path, so a hostile archive can do no more
 * than fail to parse. Stored and deflated entries only (what every zip tool writes), no zip64.
 */
export function readZip(path) {
  const buf = readFileSync(path);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`${path}: not a zip (no end-of-directory record)`);
  const count = buf.readUInt16LE(end + 10);
  let pos = buf.readUInt32LE(end + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error(`${path}: bad directory entry`);
    const method = buf.readUInt16LE(pos + 10);
    const packed = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    entries.set(name, () => {
      if (size > MAX_ENTRY) throw new Error(`${path}: ${name} is too large`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + packed);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
      throw new Error(`${path}: ${name} uses unsupported compression ${method}`);
    });
  }
  return entries;
}
