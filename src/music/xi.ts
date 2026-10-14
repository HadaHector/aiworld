// FastTracker 2 extended instruments (.xi): samples with a keymap, a volume envelope, fadeout and
// auto-vibrato, read into an Instrument. Ping-pong loops are baked forward (the sample is followed
// by its loop reversed); envelope loops are not played - the envelope holds at its sustain point.

import type { Instrument, SampleZone, VolumeEnvelope } from "./instruments";

/** Envelope and fadeout ticks: FT2's 50 a second at its default 125 bpm. */
const TICK = 1 / 50;
/** XM plays a sample with relative note 0 and finetune 0 at 8363 Hz on C-4, which is MIDI 60. */
const C4_RATE = 8363;

export interface XiInfo {
  name: string;
  samples: number;
}

export function parseXi(buffer: ArrayBuffer, id: string, look: { name?: string; short: string; color: string; gain: number }): Instrument & { xi: XiInfo } {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const text = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length)).replace(/\0.*$/, "").trim();
  if (text(0, 21) !== "Extended Instrument:") throw new Error("not an .xi file");
  const name = text(21, 22);
  const keymap = bytes.subarray(66, 66 + 96);

  const envPoints = bytes[258];
  const envSustain = bytes[260];
  const envType = bytes[266];
  const points: [number, number][] = [];
  for (let i = 0; i < Math.min(12, envPoints); i++) points.push([view.getUint16(162 + i * 4, true) * TICK, view.getUint16(164 + i * 4, true) / 64]);
  const envelopeOn = (envType & 1) !== 0 && points.length > 0;
  const volumeEnvelope: VolumeEnvelope | undefined = envelopeOn ? { points, sustain: envType & 2 ? envSustain : undefined } : undefined;
  const fadeout = view.getUint16(272, true);
  // After key-off XM takes fadeout/65536 of the volume away every tick; with no envelope it cuts.
  const release = !envelopeOn ? 0.03 : fadeout > 0 ? Math.min(8, (65536 / fadeout) * TICK) : 0.3;
  const [vibSweep, vibDepth, vibRate] = [bytes[269], bytes[270], bytes[271]];

  const count = view.getUint16(296, true);
  let offset = 298;
  const headers = [];
  for (let i = 0; i < count; i++, offset += 40) {
    headers.push({
      length: view.getUint32(offset, true),
      loopStart: view.getUint32(offset + 4, true),
      loopLength: view.getUint32(offset + 8, true),
      volume: bytes[offset + 12] / 64,
      finetune: view.getInt8(offset + 13),
      type: bytes[offset + 14],
      relative: view.getInt8(offset + 16),
    });
  }

  const samples = headers.map((h) => {
    const wide = (h.type & 16) !== 0;
    const step = wide ? 2 : 1;
    const frames = Math.floor(h.length / step);
    let data = new Float32Array(frames);
    let value = 0;
    for (let i = 0; i < frames; i++) {
      if (wide) {
        value = (value + view.getInt16(offset + i * 2, true)) << 16 >> 16;
        data[i] = value / 32768;
      } else {
        value = (value + view.getInt8(offset + i)) << 24 >> 24;
        data[i] = value / 128;
      }
    }
    offset += h.length;
    const loopType = h.type & 3;
    let loop: { start: number; end: number } | undefined;
    const start = Math.floor(h.loopStart / step);
    const end = Math.min(frames, start + Math.floor(h.loopLength / step));
    if (loopType !== 0 && end - start > 2) {
      if (loopType === 2) {
        const back = data.subarray(start + 1, end - 1).slice().reverse();
        const baked = new Float32Array(end + back.length);
        baked.set(data.subarray(0, end));
        baked.set(back, end);
        data = baked;
      } else {
        data = data.slice(0, end);
      }
      loop = { start, end: data.length };
    }
    // The sample's own rate: what makes it sound at C-4 (MIDI 60), kept inside what WebAudio takes.
    let root = 60;
    let rate = C4_RATE * 2 ** ((h.relative + h.finetune / 128) / 12);
    while (rate > 384000) (rate /= 2), (root += 12);
    while (rate < 3000) (rate *= 2), (root -= 12);
    return { data, rate, root, loop, gain: h.volume };
  });

  // One zone per run of keys mapped to the same sample.
  const zones: SampleZone[] = [];
  for (let key = 0; key < 96; ) {
    const index = keymap[key];
    let last = key;
    while (last + 1 < 96 && keymap[last + 1] === index) last++;
    const s = samples[index];
    if (s && s.data.length > 0) {
      zones.push({
        data: s.data,
        sampleRate: s.rate,
        root: s.root,
        low: 12 + key,
        high: 12 + last,
        loop: s.loop && { start: s.loop.start / s.rate, end: s.loop.end / s.rate },
        gain: s.gain,
      });
    }
    key = last + 1;
  }
  if (zones.length === 0) throw new Error("no samples");

  // Level the instrument so swapping one for another keeps the mix.
  let peak = 0;
  for (const z of zones) for (const v of z.data) peak = Math.max(peak, Math.abs(v) * (z.gain ?? 1));
  const scale = peak > 0 ? 0.85 / peak : 1;
  for (const z of zones) z.gain = (z.gain ?? 1) * scale;

  return {
    id,
    name: look.name ?? name,
    short: look.short,
    zones,
    envelope: { attack: 0, decay: 0, sustain: 1, release },
    volumeEnvelope,
    autoVibrato: vibDepth > 0 && vibRate > 0 ? { depth: vibDepth * 3, rate: (vibRate * 50) / 256, delay: 0, sweep: vibSweep * TICK } : undefined,
    gain: look.gain,
    range: [Math.max(24, zones[0].low), Math.min(108, zones[zones.length - 1].high)],
    color: look.color,
    xi: { name, samples: count },
  };
}
