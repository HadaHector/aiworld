/** Small deterministic PRNG so a numeric seed reproduces the same output every time. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives an independent-looking but fully deterministic sub-seed from a root seed and a salt. */
export function deriveSeed(rootSeed: number, salt: number): number {
  return (Math.imul(rootSeed ^ salt, 0x9e3779b9) ^ (rootSeed + salt)) >>> 0;
}
