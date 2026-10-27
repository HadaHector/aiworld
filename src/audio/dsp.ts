// Sample-making helpers shared by the music's synths (src/music/instruments.ts) and the generated
// sound effects (src/audio/synth.ts). All rendering is plain JS at SAMPLE_RATE and seeded, so it is
// the same on every load, in the page and in Node.

export const SAMPLE_RATE = 44100;

export function onePoleLowpass(data: Float32Array, cutoff: number): void {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
  let y = 0;
  for (let i = 0; i < data.length; i++) data[i] = y += a * (data[i] - y);
}

export function onePoleHighpass(data: Float32Array, cutoff: number): void {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
  let low = 0;
  for (let i = 0; i < data.length; i++) {
    low += a * (data[i] - low);
    data[i] -= low;
  }
}

export function normalize(data: Float32Array, peak: number): void {
  let max = 0;
  for (const v of data) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < data.length; i++) data[i] *= peak / max;
}

/**
 * Blends the end of the loop into what comes before its start, so the jump back is seamless: the
 * last samples of the loop become the samples just before loopStart.
 */
export function crossfadeLoop(data: Float32Array, start: number, end: number, fade: number): void {
  // It blends in what comes before the loop's start, so it can be no longer than that.
  fade = Math.min(fade, start, end - start);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const a = Math.sqrt(1 - t);
    const b = Math.sqrt(t);
    data[end - fade + i] = data[end - fade + i] * a + data[start - fade + i] * b;
  }
}

/** One cycle of a waveform from harmonic amplitudes, kept under the Nyquist limit for `hz`. */
export function wavetable(harmonics: (h: number) => number, hz: number, size = 2048): Float32Array {
  const table = new Float32Array(size);
  const count = Math.min(80, Math.floor((SAMPLE_RATE * 0.42) / hz));
  for (let h = 1; h <= count; h++) {
    const amp = harmonics(h);
    if (amp === 0) continue;
    for (let i = 0; i < size; i++) table[i] += amp * Math.sin((2 * Math.PI * h * i) / size);
  }
  return table;
}

export function readTable(table: Float32Array, phase: number): number {
  const x = phase * table.length;
  const i = Math.floor(x);
  const f = x - i;
  return table[i % table.length] * (1 - f) + table[(i + 1) % table.length] * f;
}

/** RBJ band-pass, constant peak gain, run in place. */
export function bandpass(data: Float32Array, hz: number, q: number): Float32Array {
  const w = (2 * Math.PI * hz) / SAMPLE_RATE;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const [b0, b2, a1, a2] = [alpha / a0, -alpha / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0];
  const out = new Float32Array(data.length);
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const yv = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = yv;
    [x2, x1, y2, y1] = [x1, x, y1, yv];
  }
  return out;
}

export function render(seconds: number, sample: (t: number, i: number) => number): Float32Array {
  const data = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  for (let i = 0; i < data.length; i++) data[i] = sample(i / SAMPLE_RATE, i);
  return data;
}

export function mix(...parts: [Float32Array, number][]): Float32Array {
  const length = Math.max(...parts.map(([d]) => d.length));
  const out = new Float32Array(length);
  for (const [data, gain] of parts) for (let i = 0; i < data.length; i++) out[i] += data[i] * gain;
  normalize(out, 0.9);
  return out;
}

/**
 * Karplus-Strong: a burst of noise `period` samples long, fed back through an averaging loss - a
 * plucked string. `pick` (a fraction of the string) combs out partials as where it is plucked does;
 * `bright` (0..1) is how much of the burst's top end survives; `loss` closer to 1 rings longer.
 */
export function pluckString(period: number, length: number, rng: () => number, pick: number, bright: number, loss: number): Float32Array {
  const data = new Float32Array(length);
  const burst = new Float32Array(period);
  for (let i = 0; i < period; i++) burst[i] = rng() * 2 - 1;
  // Where along the string it is plucked: that comb takes out some partials; the lowpass makes it
  // a finger rather than a pick.
  const comb = Math.max(1, Math.floor(period * pick));
  for (let i = period - 1; i >= comb; i--) burst[i] -= burst[i - comb];
  let y = 0;
  for (let i = 0; i < period; i++) burst[i] = y += bright * (burst[i] - y);
  for (let i = 0; i < length; i++) {
    if (i < period) data[i] = burst[i];
    else data[i] = loss * 0.5 * (data[i - period] + data[i - period - 1 >= 0 ? i - period - 1 : 0]);
  }
  return data;
}
